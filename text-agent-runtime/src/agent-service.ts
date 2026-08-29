import { randomUUID } from 'node:crypto'
import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { createTextProviderRuntime, type TextModelDescriptor } from './provider-runtime.ts'
import {
  buildInvocation,
  type DocumentWriteContext,
  type InvocationInput,
  type PlanningDocumentBlockV1,
  type PromptLibraryItem
} from './proposal-policy.ts'

const MAX_DOCUMENT_BLOCKS = 128
const MAX_DOCUMENT_OPERATIONS = 16
const MAX_DOCUMENT_TEXT_BYTES = 100_000
const MAX_DOCUMENT_CHANGE_TEXT_BYTES = 64 * 1024
const MAX_STORYBOARD_AGGREGATE_TEXT_BYTES = 256_000

type DocumentChangeOperation =
  | { kind: 'insert'; blockId: string; utf8Offset: number; text: string; expectedTextDigest: string }
  | { kind: 'delete'; blockId: string; utf8Start: number; utf8End: number; expectedTextDigest: string }
  | {
    kind: 'replace'
    blockId: string
    utf8Start: number
    utf8End: number
    text: string
    expectedTextDigest: string
  }

interface WriteOnceGuard {
  used: boolean
}

export interface AgentRequest extends InvocationInput {
  threadId?: string
  sessionKey?: string
  projectId?: string
  mode?: string
  modelDescriptor: TextModelDescriptor
  documentInvocationHandle?: string
}

export async function invokeAgent(request: AgentRequest) {
  const threadId = request.threadId || randomUUID()
  const invocation = buildInvocation(request)
  const proposals: Record<string, unknown>[] = []
  const canvasEdits: Record<string, unknown>[] = []
  const tools = buildAgentTools(invocation.policy, invocation.promptLibrary, proposals, canvasEdits)
  const providerRuntime = await createTextProviderRuntime(
    request.modelDescriptor,
    request.documentInvocationHandle
  )
  const agent = new Agent({
    initialState: {
      systemPrompt: buildAgentSystemPrompt(invocation),
      model: providerRuntime.model,
      tools,
      messages: invocation.history as unknown as AgentMessage[]
    },
    streamFn: providerRuntime.stream,
    toolExecution: 'sequential'
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
  const writeGuard: WriteOnceGuard = { used: false }

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
      writeGuard,
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
      canvasEdits,
      writeGuard
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
      proposals,
      writeGuard
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
      proposals,
      writeGuard
    ))
  }
  if (policy.allowedProposalKinds.includes('free_canvas_text_create') && policy.promptHandoffContext) {
    tools.push(proposalTool(
      'emit_prompt_handoff',
      'Propose one new Prompt Canvas node from the explicitly selected planning source',
      Type.Object({
        userText: Type.String({ minLength: 1, maxLength: 100_000 }),
        rationale: Type.String({ minLength: 1 })
      }, { additionalProperties: false }),
      params => ({
        kind: 'free_canvas_text_create',
        title: 'Agent Prompt',
        userText: params.userText,
        handoffBasis: policy.promptHandoffContext!.basis,
        rationale: params.rationale
      }),
      proposals,
      writeGuard,
      params => {
        const userText = normalizedBoundedText(params.userText, MAX_DOCUMENT_TEXT_BYTES, false)
        return userText !== null && userText === params.userText
          ? null
          : 'prompt_handoff_text_invalid'
      }
    ))
  }

  if (policy.allowedCanvasEditKinds.includes('document_create')
    && policy.documentWriteContext?.operationKind === 'document_create') {
    tools.push(documentCreateTool(policy.documentWriteContext, canvasEdits, writeGuard))
  }
  if (policy.allowedCanvasEditKinds.includes('document_changes')
    && policy.documentWriteContext?.operationKind === 'document_changes') {
    tools.push(documentChangesTool(policy.documentWriteContext, canvasEdits, writeGuard))
  }
  if (policy.allowedCanvasEditKinds.includes('storyboard_create')
    && policy.documentWriteContext?.operationKind === 'storyboard_create') {
    tools.push(storyboardCreateTool(canvasEdits, writeGuard))
  }
  if (policy.allowedCanvasEditKinds.includes('storyboard_changes')
    && policy.documentWriteContext?.operationKind === 'storyboard_changes') {
    tools.push(storyboardChangesTool(policy.documentWriteContext, canvasEdits, writeGuard))
  }
  return tools
}

const storyboardRowSchema = () => Type.Object({
  id: Type.String({ minLength: 1, maxLength: 192 }),
  cutLabel: Type.String({ maxLength: 10_000 }),
  timeRange: Type.String({ maxLength: 10_000 }),
  subject: Type.String({ maxLength: 10_000 }),
  action: Type.String({ maxLength: 10_000 }),
  scene: Type.String({ maxLength: 10_000 }),
  camera: Type.String({ maxLength: 10_000 }),
  lighting: Type.String({ maxLength: 10_000 }),
  audio: Type.String({ maxLength: 10_000 }),
  duration: Type.String({ maxLength: 10_000 })
}, { additionalProperties: false })

function storyboardCreateTool(
  canvasEdits: Record<string, unknown>[],
  writeGuard: WriteOnceGuard
): AgentTool {
  return {
    name: 'emit_storyboard_create',
    label: 'Create Storyboard from Document',
    description: 'Create one structured Storyboard from the effective Document text bound by Gateway policy.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200 }),
      sequence: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 192 }),
        name: Type.String({ maxLength: 10_000 }),
        description: Type.String({ maxLength: 10_000 }),
        style: Type.String({ maxLength: 10_000 }),
        constraints: Type.String({ maxLength: 10_000 }),
        rows: Type.Array(storyboardRowSchema(), { minItems: 1, maxItems: 200 })
      }, { additionalProperties: false }),
      rationale: Type.String({ minLength: 1, maxLength: 4000 })
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams) => {
      const parsed = parseStoryboardCreateParams(rawParams)
      if (!parsed.ok) return rejectedToolResult(parsed.error)
      if (writeGuard.used) return rejectedToolResult('write_tool_already_used')
      const edit = { kind: 'storyboard_create', payload: { title: parsed.title, sequence: parsed.sequence }, rationale: parsed.rationale }
      canvasEdits.push(edit)
      writeGuard.used = true
      return acceptedToolResult(edit)
    }
  }
}

function storyboardChangesTool(
  context: Extract<DocumentWriteContext, { operationKind: 'storyboard_changes' }>,
  canvasEdits: Record<string, unknown>[],
  writeGuard: WriteOnceGuard
): AgentTool {
  const sequenceField = Type.Union(['name', 'description', 'style', 'constraints'].map(value => Type.Literal(value)))
  const rowField = Type.Union(['cutLabel', 'timeRange', 'subject', 'action', 'scene', 'camera', 'lighting', 'audio', 'duration'].map(value => Type.Literal(value)))
  return {
    name: 'emit_storyboard_changes',
    label: 'Suggest Storyboard field changes',
    description: 'Emit reviewable field replacements against the single Storyboard bound by Gateway policy.',
    parameters: Type.Object({
      changes: Type.Array(Type.Union([
        Type.Object({ scope: Type.Literal('sequence'), field: sequenceField, value: Type.String({ maxLength: 10_000 }) }, { additionalProperties: false }),
        Type.Object({ scope: Type.Literal('row'), rowId: Type.String({ minLength: 1, maxLength: 192 }), field: rowField, value: Type.String({ maxLength: 10_000 }) }, { additionalProperties: false })
      ]), { minItems: 1, maxItems: 32 }),
      rationale: Type.String({ minLength: 1, maxLength: 4000 })
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams) => {
      const parsed = parseStoryboardChangesParams(rawParams, context)
      if (!parsed.ok) return rejectedToolResult(parsed.error)
      if (writeGuard.used) return rejectedToolResult('write_tool_already_used')
      const edit = {
        kind: 'storyboard_changes',
        payload: { nodeId: context.nodeId, baseRevision: context.baseRevision, baseDigest: context.baseDigest, changes: parsed.changes },
        rationale: parsed.rationale
      }
      canvasEdits.push(edit)
      writeGuard.used = true
      return acceptedToolResult(edit)
    }
  }
}

function parseStoryboardCreateParams(value: unknown):
  | { ok: true; title: string; sequence: Record<string, unknown>; rationale: string }
  | { ok: false; error: string } {
  if (!isRecord(value) || !hasExactKeys(value, ['title', 'sequence', 'rationale']) || !isRecord(value.sequence)) {
    return { ok: false, error: 'storyboard_create_arguments_invalid' }
  }
  const title = normalizedBoundedText(value.title, 200, true)
  const rationale = normalizedBoundedText(value.rationale, 4000, true)
  const sequence = value.sequence
  if (title === null || rationale === null || !hasExactKeys(sequence, ['id', 'name', 'description', 'style', 'constraints', 'rows']) || !Array.isArray(sequence.rows) || sequence.rows.length < 1 || sequence.rows.length > 200) {
    return { ok: false, error: 'storyboard_create_arguments_invalid' }
  }
  const id = normalizedBoundedText(sequence.id, 192, true)
  const fields = ['name', 'description', 'style', 'constraints'] as const
  const normalizedFields = Object.fromEntries(fields.map(field => [field, normalizedStoryboardText(sequence[field], 10_000)]))
  if (!id || Object.values(normalizedFields).some(item => item === null)) return { ok: false, error: 'storyboard_sequence_invalid' }
  const rowIds = new Set<string>()
  const rows: Record<string, string>[] = []
  for (const candidate of sequence.rows) {
    const keys = ['id', 'cutLabel', 'timeRange', 'subject', 'action', 'scene', 'camera', 'lighting', 'audio', 'duration']
    if (!isRecord(candidate) || !hasExactKeys(candidate, keys)) return { ok: false, error: 'storyboard_row_invalid' }
    const row = Object.fromEntries(keys.map(key => [key, key === 'id'
      ? normalizedBoundedText(candidate[key], 192, true)
      : normalizedStoryboardText(candidate[key], 10_000)]))
    if (Object.values(row).some(item => item === null) || rowIds.has(String(row.id))) return { ok: false, error: 'storyboard_row_invalid' }
    rowIds.add(String(row.id))
    rows.push(row as Record<string, string>)
  }
  const aggregateTextBytes = [
    ...Object.values(normalizedFields),
    ...rows.flatMap(row => ['cutLabel', 'timeRange', 'subject', 'action', 'scene', 'camera', 'lighting', 'audio', 'duration']
      .map(field => row[field]))
  ].reduce((total, item) => total + utf8Length(String(item)), 0)
  if (aggregateTextBytes > MAX_STORYBOARD_AGGREGATE_TEXT_BYTES) {
    return { ok: false, error: 'storyboard_sequence_budget_exceeded' }
  }
  return { ok: true, title, rationale, sequence: { id, ...normalizedFields, rows } }
}

function parseStoryboardChangesParams(
  value: unknown,
  context: Extract<DocumentWriteContext, { operationKind: 'storyboard_changes' }>
): { ok: true; changes: Record<string, string>[]; rationale: string } | { ok: false; error: string } {
  if (!isRecord(value) || !hasExactKeys(value, ['changes', 'rationale']) || !Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > 32) {
    return { ok: false, error: 'storyboard_changes_arguments_invalid' }
  }
  const rationale = normalizedBoundedText(value.rationale, 4000, true)
  if (rationale === null) return { ok: false, error: 'storyboard_changes_arguments_invalid' }
  const sequenceFields = new Set(['name', 'description', 'style', 'constraints'])
  const rowFields = new Set(['cutLabel', 'timeRange', 'subject', 'action', 'scene', 'camera', 'lighting', 'audio', 'duration'])
  const rows = Array.isArray(context.sequence.rows) ? context.sequence.rows : []
  const rowById = new Map(rows.flatMap(row => isRecord(row) && typeof row.id === 'string' ? [[row.id, row] as const] : []))
  const baseAggregateTextBytes = storyboardSequenceAggregateTextBytes(context.sequence)
  if (baseAggregateTextBytes === null) return { ok: false, error: 'storyboard_changes_arguments_invalid' }
  const identities = new Set<string>()
  const changes: Record<string, string>[] = []
  let prospectiveAggregateTextBytes = baseAggregateTextBytes
  for (const candidate of value.changes) {
    if (!isRecord(candidate) || typeof candidate.scope !== 'string' || typeof candidate.field !== 'string') return { ok: false, error: 'storyboard_field_invalid' }
    const text = normalizedStoryboardText(candidate.value, 10_000)
    if (text === null) return { ok: false, error: 'storyboard_field_invalid' }
    if (candidate.scope === 'sequence' && hasExactKeys(candidate, ['scope', 'field', 'value']) && sequenceFields.has(candidate.field)) {
      const identity = `sequence:${candidate.field}`
      if (identities.has(identity)) return { ok: false, error: 'storyboard_field_duplicate' }
      identities.add(identity)
      changes.push({ scope: 'sequence', field: candidate.field, value: text })
      prospectiveAggregateTextBytes += utf8Length(text) - utf8Length(String(context.sequence[candidate.field]))
      continue
    }
    if (candidate.scope === 'row' && hasExactKeys(candidate, ['scope', 'rowId', 'field', 'value']) && typeof candidate.rowId === 'string' && rowById.has(candidate.rowId) && rowFields.has(candidate.field)) {
      const identity = `row:${candidate.rowId}:${candidate.field}`
      if (identities.has(identity)) return { ok: false, error: 'storyboard_field_duplicate' }
      identities.add(identity)
      changes.push({ scope: 'row', rowId: candidate.rowId, field: candidate.field, value: text })
      prospectiveAggregateTextBytes += utf8Length(text) - utf8Length(String(rowById.get(candidate.rowId)?.[candidate.field]))
      continue
    }
    return { ok: false, error: 'storyboard_field_invalid' }
  }
  if (prospectiveAggregateTextBytes > MAX_STORYBOARD_AGGREGATE_TEXT_BYTES) {
    return { ok: false, error: 'storyboard_changes_budget_exceeded' }
  }
  return { ok: true, changes, rationale }
}

function storyboardSequenceAggregateTextBytes(sequence: Record<string, unknown>): number | null {
  const sequenceFields = ['name', 'description', 'style', 'constraints']
  const rowFields = ['cutLabel', 'timeRange', 'subject', 'action', 'scene', 'camera', 'lighting', 'audio', 'duration']
  const rows = sequence.rows
  if (!Array.isArray(rows)) return null
  const values: unknown[] = sequenceFields.map(field => sequence[field])
  for (const row of rows) {
    if (!isRecord(row)) return null
    values.push(...rowFields.map(field => row[field]))
  }
  if (values.some(value => typeof value !== 'string')) return null
  return values.reduce<number>((total, value) => total + utf8Length(String(value)), 0)
}

function normalizedStoryboardText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || !isWellFormed(value)) return null
  const normalized = value.normalize('NFC')
  return utf8Length(normalized) <= maxBytes ? normalized : null
}

function documentCreateTool(
  context: Extract<DocumentWriteContext, { operationKind: 'document_create' }>,
  canvasEdits: Record<string, unknown>[],
  writeGuard: WriteOnceGuard
): AgentTool {
  return {
    name: 'emit_document_create',
    label: 'Create planning Document',
    description: 'Create one editor-neutral planning Document using the resources bound by Gateway policy.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200 }),
      blocks: Type.Array(planningDocumentBlockSchema(), { minItems: 1, maxItems: MAX_DOCUMENT_BLOCKS }),
      rationale: Type.String({ minLength: 1, maxLength: 4000 })
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams) => {
      const parsed = parseDocumentCreateParams(rawParams)
      if (!parsed.ok) return rejectedToolResult(parsed.error)
      if (writeGuard.used) return rejectedToolResult('write_tool_already_used')
      const edit = {
        kind: 'document_create',
        payload: {
          title: parsed.title,
          blocks: parsed.blocks,
          linkedDocumentResourceIds: [...context.linkedDocumentResourceIds]
        },
        rationale: parsed.rationale
      }
      canvasEdits.push(edit)
      writeGuard.used = true
      return acceptedToolResult(edit)
    }
  }
}

function documentChangesTool(
  context: Extract<DocumentWriteContext, { operationKind: 'document_changes' }>,
  canvasEdits: Record<string, unknown>[],
  writeGuard: WriteOnceGuard
): AgentTool {
  return {
    name: 'emit_document_changes',
    label: 'Suggest planning Document changes',
    description: 'Emit bounded UTF-8 byte-anchored changes against the single Document bound by Gateway policy.',
    parameters: Type.Object({
      operations: Type.Array(Type.Union([
        Type.Object({
          kind: Type.Literal('insert'),
          blockId: Type.String({ minLength: 1, maxLength: 192 }),
          utf8Offset: Type.Integer({ minimum: 0 }),
          text: Type.String({ minLength: 1, maxLength: MAX_DOCUMENT_CHANGE_TEXT_BYTES })
        }, { additionalProperties: false }),
        Type.Object({
          kind: Type.Literal('delete'),
          blockId: Type.String({ minLength: 1, maxLength: 192 }),
          utf8Start: Type.Integer({ minimum: 0 }),
          utf8End: Type.Integer({ minimum: 1 })
        }, { additionalProperties: false }),
        Type.Object({
          kind: Type.Literal('replace'),
          blockId: Type.String({ minLength: 1, maxLength: 192 }),
          utf8Start: Type.Integer({ minimum: 0 }),
          utf8End: Type.Integer({ minimum: 1 }),
          text: Type.String({ minLength: 1, maxLength: MAX_DOCUMENT_CHANGE_TEXT_BYTES })
        }, { additionalProperties: false })
      ]), { minItems: 1, maxItems: MAX_DOCUMENT_OPERATIONS }),
      rationale: Type.String({ minLength: 1, maxLength: 4000 })
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams) => {
      const parsed = parseDocumentChangesParams(rawParams, context)
      if (!parsed.ok) return rejectedToolResult(parsed.error)
      if (writeGuard.used) return rejectedToolResult('write_tool_already_used')
      const edit = {
        kind: 'document_changes',
        payload: {
          nodeId: context.nodeId,
          baseRevision: context.baseRevision,
          baseDigest: context.baseDigest,
          operations: parsed.operations
        },
        rationale: parsed.rationale
      }
      canvasEdits.push(edit)
      writeGuard.used = true
      return acceptedToolResult(edit)
    }
  }
}

function planningDocumentBlockSchema() {
  const inline = Type.Object({
    text: Type.String({ minLength: 1 }),
    bold: Type.Optional(Type.Literal(true)),
    italic: Type.Optional(Type.Literal(true)),
    href: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 }))
  }, { additionalProperties: false })
  const content = Type.Array(inline)
  const item = Type.Object({
    id: Type.String({ minLength: 1, maxLength: 192 }),
    content
  }, { additionalProperties: false })
  return Type.Union([
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 192 }),
      type: Type.Literal('paragraph'),
      content
    }, { additionalProperties: false }),
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 192 }),
      type: Type.Literal('blockquote'),
      content
    }, { additionalProperties: false }),
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 192 }),
      type: Type.Literal('heading'),
      level: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
      content
    }, { additionalProperties: false }),
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 192 }),
      type: Type.Literal('bulletList'),
      items: Type.Array(item, { minItems: 1, maxItems: MAX_DOCUMENT_BLOCKS })
    }, { additionalProperties: false }),
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 192 }),
      type: Type.Literal('orderedList'),
      items: Type.Array(item, { minItems: 1, maxItems: MAX_DOCUMENT_BLOCKS })
    }, { additionalProperties: false }),
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 192 }),
      type: Type.Literal('checkList'),
      items: Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 192 }),
        checked: Type.Boolean(),
        content
      }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_DOCUMENT_BLOCKS })
    }, { additionalProperties: false }),
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 192 }),
      type: Type.Literal('table'),
      rows: Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 192 }),
        cells: Type.Array(Type.Object({
          id: Type.String({ minLength: 1, maxLength: 192 }),
          header: Type.Optional(Type.Literal(true)),
          content
        }, { additionalProperties: false }), { minItems: 1, maxItems: 32 })
      }, { additionalProperties: false }), { minItems: 1, maxItems: 64 })
    }, { additionalProperties: false })
  ])
}

function canvasEditTool(
  name: string,
  description: string,
  parameters: AgentTool['parameters'],
  build: (params: Record<string, unknown>) => Record<string, unknown>,
  canvasEdits: Record<string, unknown>[],
  writeGuard: WriteOnceGuard,
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
      if (writeGuard.used) return rejectedToolResult('write_tool_already_used')
      const edit = {
        id: `canvas-edit-${randomUUID()}`,
        agentName: 'PromptCard Agent',
        createdAt: Date.now(),
        ...build(params as Record<string, unknown>)
      }
      canvasEdits.push(edit)
      writeGuard.used = true
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
  writeGuard: WriteOnceGuard,
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
      if (writeGuard.used) return rejectedToolResult('write_tool_already_used')
      const proposal = {
        id: `proposal-${randomUUID()}`,
        agentName: 'PromptCard Agent',
        status: 'pending',
        createdAt: Date.now(),
        ...build(params as Record<string, unknown>)
      }
      proposals.push(proposal)
      writeGuard.used = true
      return {
        content: [{ type: 'text', text: 'Proposal recorded for explicit user approval.' }],
        details: proposal,
        terminate: true
      }
    }
  }
}

type ParsedDocumentCreate =
  | { ok: true; title: string; blocks: PlanningDocumentBlockV1[]; rationale: string }
  | { ok: false; error: string }

function parseDocumentCreateParams(value: unknown): ParsedDocumentCreate {
  if (!isRecord(value) || !hasExactKeys(value, ['title', 'blocks', 'rationale'])) {
    return { ok: false, error: 'document_create_arguments_invalid' }
  }
  const title = normalizedBoundedText(value.title, 200, true)
  const rationale = normalizedBoundedText(value.rationale, 4000, true)
  if (title === null || rationale === null) return { ok: false, error: 'document_create_arguments_invalid' }
  if (!Array.isArray(value.blocks)) return { ok: false, error: 'document_blocks_invalid' }
  if (value.blocks.length === 0) return { ok: false, error: 'document_blocks_invalid' }
  if (value.blocks.length > MAX_DOCUMENT_BLOCKS) {
    return { ok: false, error: 'document_block_budget_exceeded' }
  }
  try {
    const ids = new Set<string>()
    let textBytes = 0
    const blocks = value.blocks.map(block => normalizePlanningBlock(block, ids, bytes => { textBytes += bytes }))
    if (textBytes > MAX_DOCUMENT_TEXT_BYTES) {
      return { ok: false, error: 'document_text_budget_exceeded' }
    }
    return { ok: true, title, blocks, rationale }
  } catch (error) {
    return { ok: false, error: errorCode(error) }
  }
}

type ParsedDocumentChanges =
  | { ok: true; operations: DocumentChangeOperation[]; rationale: string }
  | { ok: false; error: string }

function parseDocumentChangesParams(
  value: unknown,
  context: Extract<DocumentWriteContext, { operationKind: 'document_changes' }>
): ParsedDocumentChanges {
  if (!isRecord(value) || !hasExactKeys(value, ['operations', 'rationale'])) {
    return { ok: false, error: 'document_changes_arguments_invalid' }
  }
  const rationale = normalizedBoundedText(value.rationale, 4000, true)
  if (rationale === null || !Array.isArray(value.operations) || value.operations.length === 0) {
    return { ok: false, error: 'document_changes_arguments_invalid' }
  }
  if (value.operations.length > MAX_DOCUMENT_OPERATIONS) {
    return { ok: false, error: 'document_operation_budget_exceeded' }
  }
  const blocks = new Map(context.blocks.map(block => [block.blockId, block]))
  let insertedTextBytes = 0
  const operations: DocumentChangeOperation[] = []
  for (const candidate of value.operations) {
    if (!isRecord(candidate) || typeof candidate.kind !== 'string') {
      return { ok: false, error: 'document_operation_invalid' }
    }
    const block = typeof candidate.blockId === 'string' ? blocks.get(candidate.blockId) : undefined
    if (!block) return { ok: false, error: 'document_operation_block_invalid' }
    const boundaries = utf8Boundaries(block.text)
    if (candidate.kind === 'insert') {
      if (!hasExactKeys(candidate, ['kind', 'blockId', 'utf8Offset', 'text'])
        || !isSafeOffset(candidate.utf8Offset, boundaries)) {
        return { ok: false, error: 'document_operation_anchor_invalid' }
      }
      if (isOversizedDocumentText(candidate.text)) {
        return { ok: false, error: 'document_text_budget_exceeded' }
      }
      const text = normalizedBoundedText(candidate.text, MAX_DOCUMENT_CHANGE_TEXT_BYTES, false)
      if (text === null || containsLineBreak(text)) {
        return { ok: false, error: 'document_operation_text_invalid' }
      }
      insertedTextBytes += utf8Length(text)
      operations.push({
        kind: 'insert',
        blockId: block.blockId,
        utf8Offset: Number(candidate.utf8Offset),
        text,
        expectedTextDigest: block.expectedTextDigest
      })
      continue
    }
    if (candidate.kind === 'delete') {
      if (!hasExactKeys(candidate, ['kind', 'blockId', 'utf8Start', 'utf8End'])
        || !isValidRange(candidate.utf8Start, candidate.utf8End, boundaries)) {
        return { ok: false, error: 'document_operation_anchor_invalid' }
      }
      operations.push({
        kind: 'delete',
        blockId: block.blockId,
        utf8Start: Number(candidate.utf8Start),
        utf8End: Number(candidate.utf8End),
        expectedTextDigest: block.expectedTextDigest
      })
      continue
    }
    if (candidate.kind === 'replace') {
      if (!hasExactKeys(candidate, ['kind', 'blockId', 'utf8Start', 'utf8End', 'text'])
        || !isValidRange(candidate.utf8Start, candidate.utf8End, boundaries)) {
        return { ok: false, error: 'document_operation_anchor_invalid' }
      }
      if (isOversizedDocumentText(candidate.text)) {
        return { ok: false, error: 'document_text_budget_exceeded' }
      }
      const text = normalizedBoundedText(candidate.text, MAX_DOCUMENT_CHANGE_TEXT_BYTES, false)
      if (text === null || containsLineBreak(text)) {
        return { ok: false, error: 'document_operation_text_invalid' }
      }
      insertedTextBytes += utf8Length(text)
      operations.push({
        kind: 'replace',
        blockId: block.blockId,
        utf8Start: Number(candidate.utf8Start),
        utf8End: Number(candidate.utf8End),
        text,
        expectedTextDigest: block.expectedTextDigest
      })
      continue
    }
    return { ok: false, error: 'document_operation_invalid' }
  }
  if (insertedTextBytes > MAX_DOCUMENT_CHANGE_TEXT_BYTES) {
    return { ok: false, error: 'document_text_budget_exceeded' }
  }
  if (documentChangeOperationsOverlap(operations)) {
    return { ok: false, error: 'document_change_ranges_overlap' }
  }
  return { ok: true, operations, rationale }
}

function documentChangeOperationsOverlap(operations: DocumentChangeOperation[]): boolean {
  const range = (operation: DocumentChangeOperation) => operation.kind === 'insert'
    ? { start: operation.utf8Offset, end: operation.utf8Offset }
    : { start: operation.utf8Start, end: operation.utf8End }
  for (let leftIndex = 0; leftIndex < operations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < operations.length; rightIndex += 1) {
      const left = operations[leftIndex]
      const right = operations[rightIndex]
      if (left.blockId !== right.blockId) continue
      const leftRange = range(left)
      const rightRange = range(right)
      const overlap = leftRange.start === rightRange.start
        || Math.max(leftRange.start, rightRange.start) < Math.min(leftRange.end, rightRange.end)
      const leftPointInsideRight = leftRange.start === leftRange.end
        && leftRange.start > rightRange.start
        && leftRange.start < rightRange.end
      const rightPointInsideLeft = rightRange.start === rightRange.end
        && rightRange.start > leftRange.start
        && rightRange.start < leftRange.end
      if (overlap || leftPointInsideRight || rightPointInsideLeft) return true
    }
  }
  return false
}

function normalizePlanningBlock(
  value: unknown,
  ids: Set<string>,
  addTextBytes: (bytes: number) => void
): PlanningDocumentBlockV1 {
  if (!isRecord(value) || typeof value.type !== 'string') fail('document_block_invalid')
  const id = normalizeUniqueId(value.id, ids)
  if (value.type === 'paragraph' || value.type === 'blockquote') {
    assertExactKeys(value, ['id', 'type', 'content'])
    return { id, type: value.type, content: normalizeInlineContent(value.content, addTextBytes) }
  }
  if (value.type === 'heading') {
    assertExactKeys(value, ['id', 'type', 'level', 'content'])
    if (value.level !== 1 && value.level !== 2 && value.level !== 3) fail('document_heading_level_invalid')
    return { id, type: 'heading', level: value.level, content: normalizeInlineContent(value.content, addTextBytes) }
  }
  if (value.type === 'bulletList' || value.type === 'orderedList') {
    assertExactKeys(value, ['id', 'type', 'items'])
    if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAX_DOCUMENT_BLOCKS) {
      fail('document_items_invalid')
    }
    return {
      id,
      type: value.type,
      items: value.items.map(item => normalizeListItem(item, ids, addTextBytes, false))
    }
  }
  if (value.type === 'checkList') {
    assertExactKeys(value, ['id', 'type', 'items'])
    if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAX_DOCUMENT_BLOCKS) {
      fail('document_items_invalid')
    }
    return {
      id,
      type: 'checkList',
      items: value.items.map(item => normalizeListItem(item, ids, addTextBytes, true))
    }
  }
  if (value.type === 'table') {
    assertExactKeys(value, ['id', 'type', 'rows'])
    if (!Array.isArray(value.rows) || value.rows.length === 0 || value.rows.length > 64) {
      fail('document_table_invalid')
    }
    const rows = value.rows.map(row => normalizeTableRow(row, ids, addTextBytes))
    const columns = rows[0].cells.length
    if (rows.some(row => row.cells.length !== columns)) fail('document_table_invalid')
    return { id, type: 'table', rows }
  }
  return fail('document_block_type_invalid')
}

function normalizeListItem(
  value: unknown,
  ids: Set<string>,
  addTextBytes: (bytes: number) => void,
  checkList: false
): { id: string; content: ReturnType<typeof normalizeInlineContent> }
function normalizeListItem(
  value: unknown,
  ids: Set<string>,
  addTextBytes: (bytes: number) => void,
  checkList: true
): { id: string; checked: boolean; content: ReturnType<typeof normalizeInlineContent> }
function normalizeListItem(
  value: unknown,
  ids: Set<string>,
  addTextBytes: (bytes: number) => void,
  checkList: boolean
): { id: string; checked: boolean; content: ReturnType<typeof normalizeInlineContent> }
  | { id: string; content: ReturnType<typeof normalizeInlineContent> } {
  if (!isRecord(value)) fail('document_item_invalid')
  assertExactKeys(value, checkList ? ['id', 'checked', 'content'] : ['id', 'content'])
  const item = {
    id: normalizeUniqueId(value.id, ids),
    content: normalizeInlineContent(value.content, addTextBytes)
  }
  if (!checkList) return item
  if (typeof value.checked !== 'boolean') fail('document_check_state_invalid')
  return { ...item, checked: value.checked }
}

function normalizeTableRow(
  value: unknown,
  ids: Set<string>,
  addTextBytes: (bytes: number) => void
): Extract<PlanningDocumentBlockV1, { type: 'table' }>['rows'][number] {
  if (!isRecord(value)) fail('document_table_invalid')
  assertExactKeys(value, ['id', 'cells'])
  if (!Array.isArray(value.cells) || value.cells.length === 0 || value.cells.length > 32) {
    fail('document_table_invalid')
  }
  return {
    id: normalizeUniqueId(value.id, ids),
    cells: value.cells.map(cell => {
      if (!isRecord(cell)) fail('document_table_invalid')
      assertExactKeys(cell, ['id', 'content'], ['header'])
      if (cell.header !== undefined && cell.header !== true) fail('document_table_header_invalid')
      return {
        id: normalizeUniqueId(cell.id, ids),
        ...(cell.header === true ? { header: true as const } : {}),
        content: normalizeInlineContent(cell.content, addTextBytes)
      }
    })
  }
}

function normalizeInlineContent(
  value: unknown,
  addTextBytes: (bytes: number) => void
): Array<{ text: string; bold?: true; italic?: true; href?: string }> {
  if (!Array.isArray(value)) fail('document_inline_content_invalid')
  let previousSignature: string | null = null
  return value.map(candidate => {
    if (!isRecord(candidate)) fail('document_inline_invalid')
    assertExactKeys(candidate, ['text'], ['bold', 'italic', 'href'])
    if (candidate.bold !== undefined && candidate.bold !== true) fail('document_mark_invalid')
    if (candidate.italic !== undefined && candidate.italic !== true) fail('document_mark_invalid')
    if (isOversizedDocumentText(candidate.text)) fail('document_text_budget_exceeded')
    const text = normalizedBoundedText(candidate.text, MAX_DOCUMENT_TEXT_BYTES, false)
    if (text === null) fail('document_inline_invalid')
    let href: string | undefined
    if (candidate.href !== undefined) {
      href = normalizedBoundedText(candidate.href, 2048, true) || undefined
      if (!href || !isSafeLink(href)) fail('document_link_invalid')
    }
    const signature = `${candidate.bold === true ? 'b' : ''}|${candidate.italic === true ? 'i' : ''}|${href || ''}`
    if (signature === previousSignature) fail('document_inline_noncanonical')
    previousSignature = signature
    addTextBytes(utf8Length(text))
    return {
      text,
      ...(candidate.bold === true ? { bold: true as const } : {}),
      ...(candidate.italic === true ? { italic: true as const } : {}),
      ...(href ? { href } : {})
    }
  })
}

function normalizeUniqueId(value: unknown, ids: Set<string>): string {
  const id = normalizedBoundedText(value, 192, true)
  if (!id || ids.has(id)) fail('document_id_invalid')
  ids.add(id)
  return id
}

function normalizedBoundedText(value: unknown, maxBytes: number, trim: boolean): string | null {
  if (typeof value !== 'string' || !isWellFormed(value)) return null
  const normalized = (trim ? value.trim() : value).normalize('NFC')
  if (normalized.length === 0 || utf8Length(normalized) > maxBytes) return null
  return normalized
}

function isOversizedDocumentText(value: unknown): boolean {
  return typeof value === 'string'
    && isWellFormed(value)
    && utf8Length(value.normalize('NFC')) > MAX_DOCUMENT_CHANGE_TEXT_BYTES
}

function containsLineBreak(value: string): boolean {
  return value.includes('\n') || value.includes('\r')
}

function utf8Boundaries(value: string): Set<number> {
  const boundaries = new Set<number>([0])
  let offset = 0
  for (const point of value) {
    offset += utf8Length(point)
    boundaries.add(offset)
  }
  return boundaries
}

function isSafeOffset(value: unknown, boundaries: Set<number>): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0 && boundaries.has(Number(value))
}

function isValidRange(start: unknown, end: unknown, boundaries: Set<number>): boolean {
  return isSafeOffset(start, boundaries)
    && isSafeOffset(end, boundaries)
    && Number(start) < Number(end)
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

function isSafeLink(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'mailto:') return url.pathname.length > 0
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every(key => allowed.has(key))
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  if (!hasExactKeys(value, required, optional)) fail('document_unknown_attribute')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(code: string): never {
  throw new Error(code)
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : 'document_invalid'
}

function rejectedToolResult(error: string) {
  return {
    content: [{ type: 'text' as const, text: error }],
    details: { error },
    terminate: false
  }
}

function acceptedToolResult(edit: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: 'Document edit recorded for Gateway validation.' }],
    details: edit,
    terminate: true
  }
}

export function buildAgentSystemPrompt(invocation: ReturnType<typeof buildInvocation>) {
  const isExperimentalChat = invocation.interactionMode === 'chat-experimental'
  const isPromptHandoff = invocation.documentWriteContext?.operationKind === 'prompt_handoff'
  const context = isPromptHandoff
    ? 'Omitted for Prompt handoff.'
    : invocation.workspaceContext
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
  const documentContext = invocation.documentWriteContext
  const documentInstruction = documentContext?.operationKind === 'prompt_handoff'
    ? [
        'Create at most one pending Prompt Canvas proposal. Use emit_prompt_handoff exactly once after analysis; never edit an existing Prompt or write to Prompt Library.',
        documentContext.basis.kind === 'document-selection'
          ? `Authoritative selected Document text: ${JSON.stringify(documentContext.basis.selectedText)}.`
          : `Authoritative Storyboard shot text: ${JSON.stringify(documentContext.basis.shotText)}.`
      ].join('\n')
    : documentContext?.operationKind === 'document_create'
    ? 'Create at most one planning Document. Use emit_document_create exactly once after analysis. Resource identity and all request/project identity are bound by Gateway policy and must not be supplied in tool arguments.'
    : documentContext?.operationKind === 'document_changes'
      ? [
          'Revise only the bound planning Document. Use emit_document_changes exactly once after analysis. Use NFC text and UTF-8 byte offsets within one listed leaf block; never target a list/table wrapper or Prompt node.',
          `Current effective Document blocks: ${JSON.stringify(documentContext.blocks.map(block => ({ blockId: block.blockId, text: block.text })))}.`
        ].join('\n')
      : documentContext?.operationKind === 'storyboard_create'
        ? [
            'Create exactly one Storyboard only because the user explicitly invoked the Document transform. Use emit_storyboard_create exactly once.',
            `Authoritative effective Document text: ${JSON.stringify(documentContext.effectiveText)}.`
          ].join('\n')
        : documentContext?.operationKind === 'storyboard_changes'
          ? 'Use emit_storyboard_changes exactly once. Change only allowed sequence/row text fields on the bound Storyboard; do not emit imageUrl, metadata, IDs, or timestamps.'
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
    documentInstruction,
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
