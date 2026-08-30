import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'

import {
  BridgeCliError,
  invokeBridge,
  stableJson,
  type BridgeCliCommand,
} from '../../promptcard-bridge-cli/src/client.ts'

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
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const

  server.registerTool(
    'promptcard_runtime_describe',
    {
      description: 'Discover the PromptCard Bridge contract, available Tools, safety limits, and the required next workspace-discovery step.',
      inputSchema: z.strictObject({}),
      annotations,
    },
    () => invokeTool({ kind: 'runtime' }, environment, fetcher),
  )
  server.registerTool(
    'promptcard_workspace_describe',
    {
      description: 'Describe one user-selected PromptCard project and canvas context, including exact creative objects and approved Skill pins.',
      inputSchema: z.strictObject({ projectCode: projectReference, cvcCode: contextReference }),
      annotations,
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
      annotations,
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
      annotations,
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
      annotations,
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
      annotations,
    },
    input => invokeTool(
      { kind: 'asset', cvcCode: input.cvcCode, code: input.code },
      environment,
      fetcher,
    ),
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
