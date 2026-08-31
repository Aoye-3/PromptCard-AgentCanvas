import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'

import {
  BridgeCliError,
  invokeBridge,
  stableJson,
  type BridgeCliCommand,
} from '../../promptcard-bridge-cli/src/client.ts'
import {
  assetStageSchema,
  deliveryCommitSchema,
  deliveryPreviewSchema,
  deliveryStatusSchema,
} from './delivery-schema.ts'
import { resolveWorkspaceAsset, WorkspaceAssetError } from './workspace-asset.ts'

const MAX_MCP_TEXT_CHARS = 8_000_000
const reference = z.string().regex(/^(?:PRJ|PLP|PLM|CVT|CVM|CVC|SKL|CVD|CVS)-[0-7][0-9A-HJKMNP-TV-Z]{25}$/i)
const contextReference = z.string().regex(/^CVC-[0-7][0-9A-HJKMNP-TV-Z]{25}$/i)
const projectReference = z.string().regex(/^PRJ-[0-7][0-9A-HJKMNP-TV-Z]{25}$/i)
const mediaReference = z.string().regex(/^(?:PLM|CVM)-[0-7][0-9A-HJKMNP-TV-Z]{25}$/i)
const skillReference = z.string().regex(/^SKL-[0-7][0-9A-HJKMNP-TV-Z]{25}$/i)
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)

type BridgeFetcher = typeof fetch

export function createPromptCardMcpServer(
  environment: NodeJS.ProcessEnv,
  fetcher: BridgeFetcher = fetch,
): McpServer {
  const server = new McpServer({ name: 'promptcard-mcp', version: '1.0.0' })
  const readAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const
  const writeAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const

  server.registerTool(
    'promptcard_runtime_describe',
    {
      description: 'Discover the PromptCard Bridge contract, available Tools, safety limits, and the required next workspace-discovery step.',
      inputSchema: z.strictObject({}),
      annotations: readAnnotations,
    },
    () => invokeTool({ kind: 'runtime' }, environment, fetcher),
  )
  server.registerTool(
    'promptcard_workspace_describe',
    {
      description: 'Describe one user-selected PromptCard project and canvas context, including exact creative objects and approved Skill pins.',
      inputSchema: z.strictObject({ projectCode: projectReference, cvcCode: contextReference }),
      annotations: readAnnotations,
    },
    input => invokeTool(
      { kind: 'workspace', projectCode: input.projectCode, cvcCode: input.cvcCode },
      environment,
      fetcher,
    ),
  )
  server.registerTool(
    'promptcard_skill_read',
    {
      description: 'Read one trusted, enabled PromptCard Skill at the exact user-approved revision and digest.',
      inputSchema: z.strictObject({
        skillCode: skillReference,
        revision: z.number().int().min(1),
        digest,
      }),
      annotations: readAnnotations,
    },
    input => invokeTool(
      {
        kind: 'skill',
        skillCode: input.skillCode,
        revision: input.revision,
        digest: input.digest,
      },
      environment,
      fetcher,
    ),
  )
  server.registerTool(
    'promptcard_reference_resolve',
    {
      description: 'Resolve one exact typed public reference that is explicitly present in the selected canvas context.',
      inputSchema: z.strictObject({ cvcCode: contextReference, code: reference }),
      annotations: readAnnotations,
    },
    input => invokeTool(
      { kind: 'reference', cvcCode: input.cvcCode, code: input.code },
      environment,
      fetcher,
    ),
  )
  server.registerTool(
    'promptcard_prompt_search',
    {
      description: 'Search bounded Prompt Library evidence for one explicit canvas context; results are discovery-only and must be resolved before use.',
      inputSchema: z.strictObject({
        cvcCode: contextReference,
        query: z.string().min(1).max(256),
        types: z.array(z.string().min(1).max(120)).max(16).default([]),
        categories: z.array(z.string().min(1).max(120)).max(16).default([]),
        limit: z.number().int().min(1).max(20).default(8),
      }),
      annotations: readAnnotations,
    },
    input => invokeTool(
      {
        kind: 'search',
        cvcCode: input.cvcCode,
        query: input.query,
        types: input.types,
        categories: input.categories,
        limit: input.limit,
      },
      environment,
      fetcher,
    ),
  )
  server.registerTool(
    'promptcard_asset_read',
    {
      description: 'Read one bounded image or video through an exact PLM/CVM reference explicitly authorized by the selected canvas context.',
      inputSchema: z.strictObject({ cvcCode: contextReference, code: mediaReference }),
      annotations: readAnnotations,
    },
    input => invokeTool(
      { kind: 'asset', cvcCode: input.cvcCode, code: input.code },
      environment,
      fetcher,
    ),
  )
  server.registerTool(
    'promptcard_delivery_preview',
    {
      description: 'Create or replay one typed review-only proposal. First follow bootstrapSkill.instructions from promptcard_runtime_describe. Copy Workspace Skill pins exactly, use only the closed kind-specific target/payload schema, and add no project/context fields.',
      inputSchema: deliveryPreviewSchema,
      annotations: writeAnnotations,
    },
    input => invokeTool({ kind: 'delivery-preview', request: input }, environment, fetcher),
  )
  server.registerTool(
    'promptcard_delivery_commit',
    {
      description: 'Move one exact previewed delivery into the visual review queue; this never auto-applies creative content.',
      inputSchema: deliveryCommitSchema,
      annotations: writeAnnotations,
    },
    input => invokeTool({ kind: 'delivery-commit', request: input }, environment, fetcher),
  )
  server.registerTool(
    'promptcard_delivery_status',
    {
      description: 'Read the durable status of one profile-scoped delivery request without repeating its mutation.',
      inputSchema: deliveryStatusSchema,
      annotations: readAnnotations,
    },
    input => invokeTool({ kind: 'delivery-status', clientRequestId: input.clientRequestId }, environment, fetcher),
  )
  server.registerTool(
    'promptcard_asset_stage',
    {
      description: 'Stage one validated image from the configured workspace root and return an opaque handle for image.place.',
      inputSchema: assetStageSchema,
      annotations: writeAnnotations,
    },
    async input => {
      try {
        const asset = await resolveWorkspaceAsset(input, environment)
        return await invokeTool(
          { kind: 'asset-stage', request: input, filename: asset.filename, content: asset.content },
          environment,
          fetcher,
        )
      } catch (error) {
        if (error instanceof WorkspaceAssetError) return toolError(error.code)
        return toolError('promptcard_mcp_internal')
      }
    },
  )

  return server
}

async function invokeTool(
  command: BridgeCliCommand,
  environment: NodeJS.ProcessEnv,
  fetcher: BridgeFetcher,
): Promise<CallToolResult> {
  try {
    const payload = await invokeBridge(command, environment, fetcher)
    const serialized = stableJson(payload)
    if (serialized.length > MAX_MCP_TEXT_CHARS) {
      return toolError('bridge_response_too_large')
    }
    return { content: [{ type: 'text', text: serialized }] }
  } catch (error) {
    if (error instanceof BridgeCliError) {
      return {
        content: [{ type: 'text', text: stableJson(error.result) }],
        isError: true,
      }
    }
    return toolError('promptcard_mcp_internal')
  }
}

function toolError(code: string): CallToolResult {
  return {
    content: [{ type: 'text', text: stableJson({ ok: false, error: { code } }) }],
    isError: true,
  }
}
