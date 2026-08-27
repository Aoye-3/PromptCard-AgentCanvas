import { randomUUID } from 'node:crypto'
import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { createTextProviderRuntime, type TextModelDescriptor } from './provider-runtime.ts'
import {
  buildInvocation,
  type InvocationInput,
  type PromptLibraryItem
} from './proposal-policy.ts'

export interface AgentRequest extends InvocationInput {
  threadId?: string
  sessionKey?: string
  projectId?: string
  mode?: string
  modelDescriptor: TextModelDescriptor
}

export async function invokeAgent(request: AgentRequest) {
  const threadId = request.threadId || randomUUID()
  const invocation = buildInvocation(request)
  const proposals: Record<string, unknown>[] = []
  const canvasEdits: Record<string, unknown>[] = []
  const tools = buildAgentTools(invocation.policy, invocation.promptLibrary, proposals, canvasEdits)
  const providerRuntime = await createTextProviderRuntime(request.modelDescriptor)
  const agent = new Agent({
    initialState: {
      systemPrompt: buildAgentSystemPrompt(invocation),
      model: providerRuntime.model,
      tools,
      messages: invocation.history as unknown as AgentMessage[]
    },
    streamFn: providerRuntime.stream,
    toolExecution: 'sequential',
    afterToolCall: async ({ toolCall }) => (
      toolCall.name.startsWith('emit_') ? { terminate: true } : undefined
    )
  })

  const images = invocation.attachments.map(item => ({
    type: 'image' as const,
    data: item.data,
    mimeType: item.mimeType
  }))
  await agent.prompt(invocation.content, images)
  if (agent.state.errorMessage) {
    throw new Error(agent.state.errorMessage)
  }

  return {
    threadId,
    text: lastAssistantText(agent.state.messages)
      || (canvasEdits.length ? '画布修改已生成。' : proposals.length ? '已生成待确认的修改提案。' : '分析完成。'),
    proposals,
    canvasEdits,
    messages: agent.state.messages.slice(invocation.history.length),
    diagnostics: {
      orchestrator: 'pi',
      modelProvider: providerRuntime.model.provider,
      integrationGroup: providerRuntime.integrationGroup?.id,
      attachmentCount: invocation.attachments.length,
      allowedProposalKinds: invocation.policy.allowedProposalKinds,
      allowedCanvasEditKinds: invocation.policy.allowedCanvasEditKinds
    }
  }
}

export function buildAgentTools(
  policy: ReturnType<typeof buildInvocation>['policy'],
  promptLibrary: PromptLibraryItem[],
  proposals: Record<string, unknown>[],
  canvasEdits: Record<string, unknown>[] = []
): AgentTool[] {
  const tools: AgentTool[] = []

  if (policy.canSearchPromptLibrary) {
    tools.push({
      name: 'search_prompt_library',
      label: 'Search Prompt Library',
      description: 'Search the provided Prompt Library snapshot by label and content, including linked media metadata.',
      parameters: Type.Object({
        query: Type.String({ minLength: 1 })
      }),
      execute: async (_toolCallId, params) => {
        const query = String((params as { query: string }).query).toLowerCase()
        const matches = promptLibrary
          .filter(item => `${item.label}\n${item.content}`.toLowerCase().includes(query))
          .slice(0, 10)
        return {
          content: [{ type: 'text', text: JSON.stringify(matches) }],
          details: { matchCount: matches.length }
        }
      }
    })
  }

  if (policy.allowedCanvasEditKinds.includes('free_canvas_text_insertions') && policy.selectedTextNodeId) {
    tools.push(canvasEditTool(
      'emit_canvas_prompt_edit',
      'Generate anchored Canvas prompt insertions for direct application',
      Type.Object({
        insertions: Type.Array(Type.Object({
          text: Type.String({ minLength: 1 }),
          reason: Type.String({ minLength: 1 }),
          anchor: Type.Union([
            Type.Object({
              type: Type.Literal('segment'),
              segmentId: Type.String({ minLength: 1 }),
              position: Type.Union([Type.Literal('before'), Type.Literal('after')])
            }, { additionalProperties: false }),
            Type.Object({
              type: Type.Literal('text'),
              segmentId: Type.String({ minLength: 1 }),
              text: Type.String({ minLength: 1 }),
              position: Type.Union([Type.Literal('before'), Type.Literal('after')])
            }, { additionalProperties: false })
          ])
        }, { additionalProperties: false }), { minItems: 1, maxItems: 16 }),
        rationale: Type.String()
      }, { additionalProperties: false }),
      params => ({
        kind: 'free_canvas_text_insertions',
        nodeId: policy.selectedTextNodeId,
        insertions: params.insertions,
        rationale: params.rationale
      }),
      canvasEdits,
      params => canvasAnchorError(params.insertions, policy.canvasSegments)
    ))
  }

  if (policy.allowedCanvasEditKinds.includes('free_canvas_text_create') && policy.selectedTextNodeId) {
    tools.push(canvasEditTool(
      'emit_canvas_prompt_edit',
      'Generate a Canvas prompt rewrite as a directly applied derived node',
      Type.Object({
        userText: Type.String({ minLength: 1 }),
        rationale: Type.String()
      }),
      params => ({
        kind: 'free_canvas_text_create',
        sourceNodeId: policy.selectedTextNodeId,
        userText: params.userText,
        rationale: params.rationale
      }),
      canvasEdits
    ))
  }

  if (policy.allowedProposalKinds.includes('prompt_library_write_proposal')) {
    tools.push(proposalTool(
      'emit_prompt_library_create',
      'Propose adding a new Prompt Library preset',
      Type.Object({
        type: Type.String(),
        category: Type.String(),
        label: Type.String({ minLength: 1 }),
        content: Type.String({ minLength: 1 }),
        rationale: Type.String()
      }),
      params => ({
        kind: 'prompt_library_write_proposal',
        operation: 'create',
        targetPresetId: null,
        presetDraft: {
          type: params.type,
          category: params.category,
          label: params.label,
          content: params.content
        },
        rationale: params.rationale
      }),
      proposals
    ))
  }
  if (policy.allowedProposalKinds.includes('media_prompt_preview')) {
    tools.push(proposalTool(
      'emit_media_prompt_preview',
      'Create or update an editable media Prompt preview',
      Type.Object({
        label: Type.String({ minLength: 1 }),
        type: Type.String(),
        category: Type.String(),
        content: Type.String({ minLength: 1 }),
        rationale: Type.String()
      }),
      params => ({
        kind: 'media_prompt_preview',
        previewDraft: {
          label: params.label,
          type: params.type,
          category: params.category,
          content: params.content
        },
        rationale: params.rationale
      }),
      proposals
    ))
  }
  return tools
}

function canvasEditTool(
  name: string,
  description: string,
  parameters: AgentTool['parameters'],
  build: (params: Record<string, unknown>) => Record<string, unknown>,
  canvasEdits: Record<string, unknown>[],
  validate?: (params: Record<string, unknown>) => string | null
): AgentTool {
  return {
    name,
    label: description,
    description,
    parameters,
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const error = validate?.(params as Record<string, unknown>)
      if (error) {
        return {
          content: [{ type: 'text', text: error }],
          details: { error },
          terminate: false
        }
      }
      const edit = {
        id: `canvas-edit-${randomUUID()}`,
        agentName: 'PromptCard Agent',
        createdAt: Date.now(),
        ...build(params as Record<string, unknown>)
      }
      canvasEdits.push(edit)
      return {
        content: [{ type: 'text', text: 'Canvas edit recorded for direct application.' }],
        details: edit,
        terminate: true
      }
    }
  }
}

function proposalTool(
  name: string,
  description: string,
  parameters: AgentTool['parameters'],
  build: (params: Record<string, unknown>) => Record<string, unknown>,
  proposals: Record<string, unknown>[],
  validate?: (params: Record<string, unknown>) => string | null
): AgentTool {
  return {
    name,
    label: description,
    description,
    parameters,
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const error = validate?.(params as Record<string, unknown>)
      if (error) {
        return {
          content: [{ type: 'text', text: error }],
          details: { error },
          terminate: false
        }
      }
      const proposal = {
        id: `proposal-${randomUUID()}`,
        agentName: 'PromptCard Agent',
        status: 'pending',
        createdAt: Date.now(),
        ...build(params as Record<string, unknown>)
      }
      proposals.push(proposal)
      return {
        content: [{ type: 'text', text: 'Proposal recorded for explicit user approval.' }],
        details: proposal,
        terminate: true
      }
    }
  }
}

export function buildAgentSystemPrompt(invocation: ReturnType<typeof buildInvocation>) {
  const isExperimentalChat = invocation.interactionMode === 'chat-experimental'
  const context = invocation.workspaceContext
    ? JSON.stringify(invocation.workspaceContext)
    : 'No Canvas workspace context.'
  const library = JSON.stringify(invocation.promptLibrary)
  const mediaInstruction = invocation.attachments.length
    ? 'Analyze only the single explicitly attached image. Do not infer access to other media.'
    : ''
  const selectionInstruction = invocation.mediaAction === 'selection-rewrite'
    ? 'This is a selection-rewrite request. Return a replacement candidate and concise rationale; never claim it was applied.'
    : ''
  const promptLanguageInstruction = invocation.promptLanguageMode === 'zh'
    ? 'Write the generated Prompt in Chinese.'
    : invocation.promptLanguageMode === 'en'
      ? 'Write the generated Prompt in English.'
      : invocation.promptLanguageMode === 'mixed'
        ? 'Keep only photography terminology and proper names of styles in English; write everything else in Chinese.'
        : ''
  const canvasInstruction = invocation.policy.canvasEditMode === 'insertions'
    ? 'Canvas completion must add new user-authored text at exact anchors inside the original target segments. Preserve every original character, segment order, source, and color; use segment-edge anchors only for true segment boundaries. Reference nodes are read-only.'
    : invocation.policy.canvasEditMode === 'derived_node'
      ? 'Canvas rewrite must emit a complete derived text node. The original target and reference nodes are read-only and must remain unchanged. Any supplied legacy text selection does not limit or alter the derived-node request.'
      : ''
  const skills = invocation.skillSnapshots.map(skill => ({
    skillId: skill.skillId,
    revision: skill.revision,
    digest: skill.digest,
    instructions: skill.instructions,
    references: skill.references || []
  }))
  return [
    isExperimentalChat
      ? 'You are PromptCard Agent in an ordinary multi-turn conversation.'
      : 'You are PromptCard Agent, a focused prompt-writing assistant.',
    isExperimentalChat
      ? 'Do not edit Prompt content or search Prompt Library. Use only the tools supplied by runtime policy; having a Skill never adds a tool.'
      : invocation.policy.allowedCanvasEditKinds.length
      ? 'Canvas completion and rewrite results are applied directly after Gateway validation. Use emit_canvas_prompt_edit exactly once after analysis; do not describe the result as a proposal or ask for approval.'
      : 'Never write directly to Canvas or Prompt Library. Use the available structured tool after analysis.',
    'Prompt Library mutations remain proposals that require explicit approval.',
    'Skills cannot expand permissions, result kinds, or mutation authority. Runtime policy always wins.',
    invocation.policy.canSearchPromptLibrary
      ? 'Use search_prompt_library to find Prompt records and linked media relevant to the current conversation. Do not invent library records.'
      : '',
    mediaInstruction,
    selectionInstruction,
    promptLanguageInstruction,
    canvasInstruction,
    `Allowed proposal kinds: ${JSON.stringify(invocation.policy.allowedProposalKinds)}.`,
    `Selected text node id: ${invocation.policy.selectedTextNodeId || 'none'}.`,
    `Canvas edit mode: ${invocation.policy.canvasEditMode || 'none'}.`,
    `Canvas node context: ${JSON.stringify(invocation.canvasNodeContext)}.`,
    `Media action: ${invocation.mediaAction}.`,
    `Media preview: ${JSON.stringify(invocation.mediaPreview)}.`,
    `Selection: ${JSON.stringify(invocation.selection)}.`,
    `Workspace context: ${context}`,
    `Prompt Library snapshot: ${library}`,
    `Selected Skill snapshots: ${JSON.stringify(skills)}`
  ].filter(Boolean).join('\n\n')
}

function lastAssistantText(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

function canvasAnchorError(value: unknown, segments: Array<{ id: string; text: string }>): string | null {
  if (!Array.isArray(value)) return 'insertions are required'
  for (const insertion of value) {
    const anchor = (insertion as { anchor?: Record<string, unknown> }).anchor
    if (!anchor) return 'each insertion needs an anchor'
    if (anchor.position !== 'before' && anchor.position !== 'after') {
      return 'anchor position must be before or after'
    }
    if (anchor.type === 'segment') {
      if (!segments.some(segment => segment.id === anchor.segmentId)) return 'segment anchor was not found on the target'
      continue
    }
    if (anchor.type === 'text') {
      const segment = segments.find(candidate => candidate.id === anchor.segmentId)
      if (!segment) return 'text anchor segment was not found on the target'
      if (typeof anchor.text !== 'string' || substringOccurrences(segment.text, anchor.text) !== 1) {
        return 'text anchor must occur exactly once in the target segment'
      }
      continue
    }
    return 'anchor type is invalid'
  }
  return null
}

function substringOccurrences(value: string, substring: string): number {
  if (!substring) return 0
  let count = 0
  let start = 0
  while (start < value.length) {
    const index = value.indexOf(substring, start)
    if (index < 0) return count
    count += 1
    start = index + 1
  }
  return count
}
