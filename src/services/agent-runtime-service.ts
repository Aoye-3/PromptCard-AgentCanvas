import type {
  AgentInfo,
  AgentCanvasEdit,
  AgentFreeCanvasTextInsertion,
  AgentFreeCanvasTextProposalBasis,
  AgentRunProvenance,
  AgentModelInfo,
  AgentPermissionScope,
  AgentInteractionMode,
  AgentSkillInfo,
  AgentToolInfo,
  AgentWorkspaceProposal,
  CanvasAgentNodeContext,
  PromptLibraryWriteProposal
} from '@/models/Agent.model'

export type PromptLanguageMode = 'zh' | 'en' | 'mixed'

const AGENT_API_BASE = '/agent-api'
const PROMPTCARD_RUNTIME_BASE = `${AGENT_API_BASE}/promptcard/runtime`
const MAX_DOCUMENT_IDENTITIES = 5
const DOCUMENT_RESOURCE_ID_PATTERN = /^[0-9a-f]{32}$/
const CANVAS_NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const AGENT_RUNTIME_MESSAGE_KEYS = new Set([
  'threadId',
  'conversationId',
  'requestId',
  'content',
  'mode',
  'permissionScope',
  'sessionKey',
  'projectId',
  'workspaceContext',
  'promptLibrary',
  'selectedSkillIds',
  'interactionMode',
  'canvasNodeContext',
  'documentResourceIds',
  'explicitDocumentNodeIds'
])

export interface DeepSeekModelConfig {
  enabled: boolean
  apiBase: string
  apiKeyConfigured: boolean
  apiKeyPreview?: string | null
  modelName: string
  temperature: number
  maxTokens: number
  availableModels: string[]
}

export interface DeepSeekModelConfigUpdate {
  enabled?: boolean
  apiBase?: string
  apiKey?: string
  modelName?: string
  temperature?: number
  maxTokens?: number
}

export interface AgentConversationModelBinding {
  connectionId: string
  providerId: string
  modelId: string
}

export interface AgentRuntimeMessageRequest {
  threadId?: string
  conversationId?: string
  requestId?: string
  content: string
  mode?: string
  permissionScope?: AgentPermissionScope
  sessionKey?: string
  projectId?: string
  workspaceContext?: unknown
  promptLibrary?: Array<Record<string, unknown>>
  selectedSkillIds?: string[]
  interactionMode?: AgentInteractionMode
  canvasNodeContext?: CanvasAgentNodeContext
  documentResourceIds?: string[]
  explicitDocumentNodeIds?: string[]
}

export interface AgentDocumentEditAcknowledgement {
  requestId: string
  status: 'applied' | 'failed'
  errorCode?: 'failed_conflict' | 'failed_integrity' | 'failed_target_missing' | 'save_failed'
}

export interface AgentDocumentEditStatus {
  conversationId: string
  requestId: string
  editId: string
  status: 'pending_apply' | 'applied' | 'failed_conflict' | 'failed_integrity' | 'failed_target_missing'
  evidence?: Record<string, unknown> | null
}

export interface AgentDocumentEditReconciliation extends Omit<Partial<AgentDocumentEditStatus>, 'status'> {
  status: AgentDocumentEditStatus['status'] | 'idle'
  canvasEdits: AgentCanvasEdit[]
}

const jsonHeaders = () => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  const csrfToken = readCookie('csrf_token')
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken
  }
  return headers
}

const readCookie = (name: string) => {
  if (typeof document === 'undefined') return undefined
  const prefix = `${name}=`
  return document.cookie
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(prefix))
    ?.slice(prefix.length)
}

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    credentials: 'include',
    ...init
  })
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText)
    throw new Error(message || response.statusText)
  }
  return response.json() as Promise<T>
}

const normalizeItems = <T>(payload: unknown, keys: string[]): T[] => {
  if (Array.isArray(payload)) return payload as T[]
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key] as T[]
    }
  }
  return []
}

const messageText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>
          return typeof record.text === 'string' ? record.text : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key))

const isDocumentEditIdentity = (value: Record<string, unknown>) =>
  typeof value.id === 'string' &&
  value.id.length > 0 &&
  value.editId === value.id &&
  typeof value.conversationId === 'string' &&
  value.conversationId.length > 0 &&
  typeof value.requestId === 'string' &&
  value.requestId.length > 0 &&
  typeof value.nodeId === 'string' &&
  CANVAS_NODE_ID_PATTERN.test(value.nodeId) &&
  typeof value.expectedResultDigest === 'string' &&
  SHA256_PATTERN.test(value.expectedResultDigest) &&
  typeof value.rationale === 'string' &&
  (!('provenance' in value) || value.provenance === undefined || isRecord(value.provenance))

const isDocumentChangeOperation = (value: unknown) => {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.blockId !== 'string' ||
      !SHA256_PATTERN.test(String(value.expectedTextDigest ?? ''))) return false
  if (value.kind === 'insert') {
    return hasOnlyKeys(value, ['kind', 'blockId', 'utf8Offset', 'text', 'expectedTextDigest']) &&
      Number.isSafeInteger(value.utf8Offset) && Number(value.utf8Offset) >= 0 && typeof value.text === 'string'
  }
  if (value.kind === 'delete') {
    return hasOnlyKeys(value, ['kind', 'blockId', 'utf8Start', 'utf8End', 'expectedTextDigest']) &&
      Number.isSafeInteger(value.utf8Start) && Number.isSafeInteger(value.utf8End) &&
      Number(value.utf8Start) >= 0 && Number(value.utf8End) >= Number(value.utf8Start)
  }
  if (value.kind === 'replace') {
    return hasOnlyKeys(value, ['kind', 'blockId', 'utf8Start', 'utf8End', 'text', 'expectedTextDigest']) &&
      Number.isSafeInteger(value.utf8Start) && Number.isSafeInteger(value.utf8End) &&
      Number(value.utf8Start) >= 0 && Number(value.utf8End) >= Number(value.utf8Start) && typeof value.text === 'string'
  }
  return false
}

const isEnrichedDocumentEdit = (value: unknown): value is AgentCanvasEdit => {
  if (!isRecord(value) || !isDocumentEditIdentity(value) || !isRecord(value.base) || !isRecord(value.payload)) {
    return false
  }
  const identityKeys = [
    'kind', 'id', 'editId', 'conversationId', 'requestId', 'nodeId',
    'expectedResultDigest', 'base', 'payload', 'rationale', 'provenance'
  ]
  if (!hasOnlyKeys(value, identityKeys)) return false
  if (value.kind === 'document_create') {
    return hasOnlyKeys(value.base, ['projectRevision']) && Number.isSafeInteger(value.base.projectRevision) &&
      Number(value.base.projectRevision) >= 0 &&
      hasOnlyKeys(value.payload, ['title', 'blocks', 'linkedDocumentResourceIds']) &&
      typeof value.payload.title === 'string' && Array.isArray(value.payload.blocks) &&
      value.payload.blocks.every(isRecord) && Array.isArray(value.payload.linkedDocumentResourceIds) &&
      value.payload.linkedDocumentResourceIds.every(item => typeof item === 'string')
  }
  if (value.kind === 'document_changes') {
    return hasOnlyKeys(value.base, ['projectRevision', 'nodeRevision', 'nodeDigest']) &&
      Number.isSafeInteger(value.base.projectRevision) && Number(value.base.projectRevision) >= 0 &&
      Number.isSafeInteger(value.base.nodeRevision) && Number(value.base.nodeRevision) >= 0 &&
      typeof value.base.nodeDigest === 'string' && SHA256_PATTERN.test(value.base.nodeDigest) &&
      hasOnlyKeys(value.payload, ['operations']) && Array.isArray(value.payload.operations) &&
      value.payload.operations.length > 0 && value.payload.operations.every(isDocumentChangeOperation)
  }
  return false
}

const validateAgentCanvasEdits = (value: unknown): AgentCanvasEdit[] => {
  if (!Array.isArray(value)) throw new Error('Invalid agent canvas edits.')
  const documentEdits = value.filter(edit => isRecord(edit) &&
    (edit.kind === 'document_create' || edit.kind === 'document_changes'))
  if (documentEdits.length > 1 || documentEdits.some(edit => !isEnrichedDocumentEdit(edit))) {
    throw new Error('Invalid agent canvas edits.')
  }
  return value as AgentCanvasEdit[]
}

export const agentRuntimeService = {
  health: () => requestJson<Record<string, unknown>>(`${PROMPTCARD_RUNTIME_BASE}/status`),

  bootstrap: () =>
    requestJson<{ user?: unknown; expires_in?: number }>(
      `${PROMPTCARD_RUNTIME_BASE}/bootstrap`,
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({})
      }
    ),

  catalog: () =>
    requestJson<{
      models?: AgentModelInfo[]
      skills?: AgentSkillInfo[]
      tools?: AgentToolInfo[]
      builtins?: string[]
      subagentEnabled?: boolean
      agents?: AgentInfo[]
    }>(`${PROMPTCARD_RUNTIME_BASE}/catalog`),

  models: async () => normalizeItems<AgentModelInfo>(await agentRuntimeService.catalog(), ['models', 'items']),

  skills: async () => normalizeItems<AgentSkillInfo>(await agentRuntimeService.catalog(), ['skills', 'items']),

  tools: async () => {
    const payload = await agentRuntimeService.catalog()
    return {
      tools: normalizeItems<AgentToolInfo>(payload, ['tools', 'items']),
      builtins: Array.isArray(payload.builtins) ? (payload.builtins as string[]) : [],
      subagentEnabled: Boolean(payload.subagentEnabled)
    }
  },

  agents: async () => normalizeItems<AgentInfo>(await agentRuntimeService.catalog(), ['agents', 'items']),

  sendMessage: async (body: AgentRuntimeMessageRequest) => {
    const requestBody = agentRuntimeMessageBody(body)
    const response = await requestJson<{
      threadId: string
      conversationId?: string
      requestId?: string
      text: string
      proposals: AgentWorkspaceProposal[]
      canvasEdits: AgentCanvasEdit[]
      diagnostics?: Record<string, unknown>
    }>(`${PROMPTCARD_RUNTIME_BASE}/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(requestBody)
    })
    return {
      ...response,
      proposals: filterProposalsForPermissionScope(response.proposals, body.permissionScope),
      canvasEdits: validateAgentCanvasEdits(response.canvasEdits)
    }
  },

  updateConversationModel: (
    projectId: string,
    conversationId: string,
    modelBinding: AgentConversationModelBinding | null
  ) => requestJson<Record<string, unknown>>(
    `${PROMPTCARD_RUNTIME_BASE}/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/model`,
    {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ modelBinding })
    }
  ),

  acknowledgeDocumentEdit: (
    projectId: string,
    conversationId: string,
    editId: string,
    body: AgentDocumentEditAcknowledgement
  ) => requestJson<AgentDocumentEditStatus>(
    `${PROMPTCARD_RUNTIME_BASE}/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/edits/${encodeURIComponent(editId)}/ack`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body)
    }
  ),

  reconcileDocumentEdits: async (
    projectId: string,
    conversationId: string
  ) => {
    const response = await requestJson<Omit<AgentDocumentEditReconciliation, 'canvasEdits'> & { canvasEdits?: unknown }>(
      `${PROMPTCARD_RUNTIME_BASE}/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/edits/reconcile`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({})
      }
    )
    return {
      ...response,
      canvasEdits: validateAgentCanvasEdits(response.canvasEdits ?? [])
    }
  },

  analyzeMedia: (body: {
    threadId?: string
    assetId: string
    contentType: string
    analysisType: 'style' | 'freeform' | 'prompt'
    content: string
    history?: Array<{ role: 'user' | 'assistant'; text: string }>
    mediaAction?: 'chat' | 'preview' | 'selection-rewrite'
    promptLanguageMode?: PromptLanguageMode
    mediaPreview?: Record<string, unknown> | null
    selection?: { start: number; end: number; text: string } | null
  }) =>
    requestJson<{
      threadId: string
      text: string
      proposals: AgentWorkspaceProposal[]
      diagnostics?: Record<string, unknown>
    }>(`${PROMPTCARD_RUNTIME_BASE}/media-analysis`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body)
    }),

  getModelConfig: () =>
    requestJson<DeepSeekModelConfig>(`${PROMPTCARD_RUNTIME_BASE}/model-config`),

  saveModelConfig: (body: DeepSeekModelConfigUpdate) =>
    requestJson<DeepSeekModelConfig>(`${PROMPTCARD_RUNTIME_BASE}/model-config`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify(body)
    }),

  testModelConfig: (body: DeepSeekModelConfigUpdate = {}) =>
    requestJson<{ success: boolean; message: string }>(`${PROMPTCARD_RUNTIME_BASE}/model-config/test`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body)
    }),

  parsePromptLibraryProposals,
  parseAgentWorkspaceProposals
}

function agentRuntimeMessageBody(body: AgentRuntimeMessageRequest): AgentRuntimeMessageRequest {
  if (
    !body
    || typeof body !== 'object'
    || Array.isArray(body)
    || typeof body.content !== 'string'
    || Object.keys(body).some(key => !AGENT_RUNTIME_MESSAGE_KEYS.has(key))
  ) {
    throw new Error('Invalid agent runtime message request.')
  }
  const documentResourceIds = validateIdentityArray(
    body.documentResourceIds,
    DOCUMENT_RESOURCE_ID_PATTERN,
    'Invalid documentResourceIds.'
  )
  const explicitDocumentNodeIds = validateIdentityArray(
    body.explicitDocumentNodeIds,
    CANVAS_NODE_ID_PATTERN,
    'Invalid explicitDocumentNodeIds.'
  )
  return {
    content: body.content,
    ...(body.threadId !== undefined ? { threadId: body.threadId } : {}),
    ...(body.conversationId !== undefined ? { conversationId: body.conversationId } : {}),
    ...(body.requestId !== undefined ? { requestId: body.requestId } : {}),
    ...(body.mode !== undefined ? { mode: body.mode } : {}),
    ...(body.permissionScope !== undefined ? { permissionScope: body.permissionScope } : {}),
    ...(body.sessionKey !== undefined ? { sessionKey: body.sessionKey } : {}),
    ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
    ...(body.workspaceContext !== undefined ? { workspaceContext: body.workspaceContext } : {}),
    ...(body.promptLibrary !== undefined ? { promptLibrary: body.promptLibrary } : {}),
    ...(body.selectedSkillIds !== undefined ? { selectedSkillIds: body.selectedSkillIds } : {}),
    ...(body.interactionMode !== undefined ? { interactionMode: body.interactionMode } : {}),
    ...(body.canvasNodeContext !== undefined ? { canvasNodeContext: body.canvasNodeContext } : {}),
    ...(documentResourceIds !== undefined ? { documentResourceIds } : {}),
    ...(explicitDocumentNodeIds !== undefined ? { explicitDocumentNodeIds } : {})
  }
}

function validateIdentityArray(
  value: unknown,
  pattern: RegExp,
  errorMessage: string
): string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value)
    || value.length > MAX_DOCUMENT_IDENTITIES
    || value.some(item => typeof item !== 'string' || !pattern.test(item))
    || new Set(value).size !== value.length
  ) {
    throw new Error(errorMessage)
  }
  return [...value]
}

export function extractAssistantText(payload: Record<string, unknown>): string {
  const candidates = [
    payload.output,
    payload.result,
    payload.final,
    (payload.values as Record<string, unknown> | undefined)?.messages,
    payload.messages
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate
    if (Array.isArray(candidate)) {
      const assistant = [...candidate]
        .reverse()
        .find(item => item && typeof item === 'object' && ['assistant', 'ai'].includes(String((item as Record<string, unknown>).role || (item as Record<string, unknown>).type || '').toLowerCase()))
      if (assistant) {
        const text = messageText((assistant as Record<string, unknown>).content)
        if (text) return text
      }
    }
  }

  return JSON.stringify(payload, null, 2)
}

export function parsePromptLibraryProposals(text: string): PromptLibraryWriteProposal[] {
  return parseAgentWorkspaceProposals(text).filter(isPromptLibraryProposal)
}

export function parseAgentWorkspaceProposals(
  text: string,
  options: { permissionScope?: AgentPermissionScope } = {}
): AgentWorkspaceProposal[] {
  const proposals: AgentWorkspaceProposal[] = []
  const seenProposalIds = new Set<string>()
  const jsonCandidates = [
    ...text.matchAll(/```json\s*([\s\S]*?)```/gi),
    ...text.matchAll(/(\{[\s\S]*"(?:agent_workspace_proposals|prompt_library_write_proposal|workspace_card_update|workspace_card_create|storyboard_update|free_canvas_text_update|free_canvas_text_insertions|free_canvas_text_create|media_prompt_preview)"[\s\S]*\})/gi)
  ].map(match => match[1])

  for (const candidate of jsonCandidates) {
    try {
      const parsed = JSON.parse(candidate)
      const items = parsed.kind === 'agent_workspace_proposals' && Array.isArray(parsed.proposals)
        ? parsed.proposals
        : [parsed.kind === 'prompt_library_write_proposal' ? parsed.proposal : parsed]

      for (const item of items) {
        const normalized = normalizeProposal(item, proposals.length)
        if (
          normalized &&
          isProposalAllowedForPermissionScope(normalized, options.permissionScope) &&
          !seenProposalIds.has(normalized.id)
        ) {
          seenProposalIds.add(normalized.id)
          proposals.push(normalized)
        }
      }
    } catch {
      continue
    }
  }

  return proposals
}

function normalizeProposal(value: unknown, index: number): AgentWorkspaceProposal | null {
  if (!value || typeof value !== 'object') return null
  const proposal = value as Record<string, any>
  const kind = String(proposal.kind || '')
  const base = {
    id: String(proposal.id || `proposal-${Date.now()}-${index}`),
    contextId: typeof proposal.contextId === 'string' ? proposal.contextId : undefined,
    threadId: proposal.threadId ?? null,
    runId: proposal.runId ?? null,
    agentName: String(proposal.agentName || 'PromptCard Agent'),
    rationale: String(proposal.rationale || ''),
    status: proposal.status === 'approved' || proposal.status === 'rejected' ? proposal.status : 'pending',
    createdAt: Number(proposal.createdAt || Date.now())
  }

  if ((kind === 'prompt_library_write_proposal' || proposal.presetDraft) && proposal.presetDraft?.label && proposal.presetDraft?.content) {
    if ((proposal.operation || 'create') !== 'create') return null
    const label = String(proposal.presetDraft.label || '').trim()
    const content = String(proposal.presetDraft.content || '').trim()
    if (!label || !content) return null
    return {
      ...base,
      kind: 'prompt_library_write_proposal',
      operation: 'create',
      targetPresetId: null,
      presetDraft: {
        ...proposal.presetDraft,
        type: isKnownCardType(proposal.presetDraft.type) ? proposal.presetDraft.type : 'custom',
        category: String(proposal.presetDraft.category || 'agent').trim() || 'agent',
        label,
        content
      }
    }
  }

  if (kind === 'workspace_card_create' && proposal.cardDraft?.type && proposal.cardDraft?.content) {
    return {
      ...base,
      kind: 'workspace_card_create',
      pageIndex: Number.isFinite(Number(proposal.pageIndex)) ? Number(proposal.pageIndex) : undefined,
      cardDraft: {
        type: proposal.cardDraft.type,
        title: String(proposal.cardDraft.title || proposal.cardDraft.type),
        content: String(proposal.cardDraft.content || ''),
        meta: proposal.cardDraft.meta || {}
      }
    }
  }

  if (kind === 'workspace_card_update' && Array.isArray(proposal.updates) && proposal.updates.length > 0) {
    const updates = proposal.updates
      .filter((update: any) => update?.cardId && (typeof update.title === 'string' || typeof update.content === 'string'))
      .map((update: any) => ({
        cardId: String(update.cardId),
        title: typeof update.title === 'string' ? update.title : undefined,
        content: typeof update.content === 'string' ? update.content : undefined
      }))
    if (updates.length === 0) return null
    return {
      ...base,
      kind: 'workspace_card_update',
      updates
    }
  }

  if (kind === 'storyboard_update' && (proposal.sequenceUpdates || proposal.rowUpdates)) {
    return {
      ...base,
      kind: 'storyboard_update',
      sequenceId: proposal.sequenceId ?? null,
      rowId: proposal.rowId ?? null,
      sequenceUpdates: pickAllowed(proposal.sequenceUpdates, ['name', 'description', 'style', 'constraints']),
      rowUpdates: pickAllowed(proposal.rowUpdates, ['cutLabel', 'timeRange', 'subject', 'action', 'scene', 'camera', 'lighting', 'audio', 'duration'])
    }
  }

  if (kind === 'three_stage_field_update' && proposal.stageKey && proposal.fieldId && proposal.content) {
    return {
      ...base,
      kind: 'three_stage_field_update',
      stageKey: String(proposal.stageKey),
      fieldId: String(proposal.fieldId),
      mode: proposal.mode === 'append' ? 'append' : 'replace',
      content: String(proposal.content)
    }
  }

  if (kind === 'free_canvas_text_update' && proposal.nodeId && typeof proposal.userText === 'string') {
    const editMode = proposal.editMode === 'append' || proposal.editMode === 'rewrite_selection'
      ? proposal.editMode
      : 'rewrite_all'
    const selection = editMode === 'rewrite_selection'
      && Number.isFinite(Number(proposal.selection?.start))
      && Number.isFinite(Number(proposal.selection?.end))
      && typeof proposal.selection?.selectedText === 'string'
      ? {
          start: Number(proposal.selection.start),
          end: Number(proposal.selection.end),
          selectedText: proposal.selection.selectedText
        }
      : undefined
    return {
      ...base,
      kind: 'free_canvas_text_update',
      nodeId: String(proposal.nodeId),
      editMode,
      userText: String(proposal.userText),
      selection,
      baseNodeRevision: Number.isFinite(Number(proposal.baseNodeRevision)) ? Number(proposal.baseNodeRevision) : undefined,
      templateDigest: typeof proposal.templateDigest === 'string' ? proposal.templateDigest : undefined,
      baseContentDigest: typeof proposal.baseContentDigest === 'string' ? proposal.baseContentDigest : undefined
    }
  }

  if (kind === 'free_canvas_text_insertions' && proposal.nodeId) {
    const basis = normalizeFreeCanvasTextProposalBasis(proposal)
    const insertions = normalizeFreeCanvasTextInsertions(proposal.insertions)
    const provenance = normalizeAgentRunProvenance(proposal.provenance)
    if (!basis || !insertions) return null
    return {
      ...base,
      kind: 'free_canvas_text_insertions',
      nodeId: String(proposal.nodeId),
      insertions,
      ...basis,
      ...(provenance ? { provenance } : {})
    }
  }

  if (kind === 'media_prompt_preview' && proposal.previewDraft?.label && proposal.previewDraft?.content) {
    return {
      ...base,
      kind: 'media_prompt_preview',
      previewDraft: {
        ...proposal.previewDraft,
        type: isKnownCardType(proposal.previewDraft.type) ? proposal.previewDraft.type : 'custom',
        category: String(proposal.previewDraft.category || 'media').trim() || 'media',
        label: String(proposal.previewDraft.label).trim(),
        content: String(proposal.previewDraft.content).trim()
      }
    }
  }

  if (kind === 'free_canvas_text_create' && typeof proposal.userText === 'string' && proposal.userText.trim()) {
    const sourceNodeId = typeof proposal.sourceNodeId === 'string' && proposal.sourceNodeId.trim()
      ? proposal.sourceNodeId
      : undefined
    const basis = sourceNodeId ? normalizeFreeCanvasTextProposalBasis(proposal.basis) : undefined
    const provenance = normalizeAgentRunProvenance(proposal.provenance)
    if (sourceNodeId && !basis) return null
    if (sourceNodeId && basis) return {
      ...base,
      kind: 'free_canvas_text_create',
      title: typeof proposal.title === 'string' ? proposal.title : 'Agent Prompt',
      userText: proposal.userText,
      sourceNodeId,
      basis,
      ...(provenance ? { provenance } : {})
    }
    return {
      ...base,
      kind: 'free_canvas_text_create',
      title: typeof proposal.title === 'string' ? proposal.title : 'Agent Prompt',
      userText: proposal.userText
    }
  }

  return null
}

function normalizeFreeCanvasTextProposalBasis(value: unknown): AgentFreeCanvasTextProposalBasis | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const baseNodeRevision = Number(source.baseNodeRevision)
  const templateDigest = typeof source.templateDigest === 'string' ? source.templateDigest : ''
  const baseSegmentsDigest = typeof source.baseSegmentsDigest === 'string' ? source.baseSegmentsDigest : ''
  if (!Number.isFinite(baseNodeRevision) || baseNodeRevision < 0 || !templateDigest || !baseSegmentsDigest) return null
  return { baseNodeRevision, templateDigest, baseSegmentsDigest }
}

function normalizeAgentRunProvenance(value: unknown): AgentRunProvenance | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const model = source.model as Record<string, unknown> | undefined
  const skills = source.skills
  if (
    !model
    || typeof model.connectionId !== 'string'
    || typeof model.providerId !== 'string'
    || typeof model.modelId !== 'string'
    || !Array.isArray(skills)
  ) return null
  const normalizedSkills = skills.flatMap(skill => {
    if (!skill || typeof skill !== 'object') return []
    const item = skill as Record<string, unknown>
    if (
      typeof item.skillId !== 'string'
      || !Number.isInteger(item.revision)
      || typeof item.digest !== 'string'
    ) return []
    return [{ skillId: item.skillId, revision: Number(item.revision), digest: item.digest }]
  })
  if (normalizedSkills.length !== skills.length) return null
  return {
    model: {
      connectionId: model.connectionId,
      providerId: model.providerId,
      modelId: model.modelId,
      ...(typeof model.displayName === 'string' ? { displayName: model.displayName } : {}),
      ...(model.capabilities && typeof model.capabilities === 'object'
        ? { capabilities: model.capabilities as Record<string, unknown> }
        : {})
    },
    skills: normalizedSkills
  }
}

function normalizeFreeCanvasTextInsertions(value: unknown): AgentFreeCanvasTextInsertion[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null
  const insertions: AgentFreeCanvasTextInsertion[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const source = item as Record<string, unknown>
    const text = typeof source.text === 'string' ? source.text : ''
    const reason = typeof source.reason === 'string' ? source.reason.trim() : ''
    const anchor = source.anchor as Record<string, unknown> | undefined
    if (!text || !reason || !anchor || (anchor.position !== 'before' && anchor.position !== 'after')) return null
    if (anchor.type === 'segment' && typeof anchor.segmentId === 'string' && anchor.segmentId) {
      insertions.push({ text, reason, anchor: { type: 'segment', segmentId: anchor.segmentId, position: anchor.position } })
      continue
    }
    if (anchor.type === 'text' && typeof anchor.segmentId === 'string' && anchor.segmentId && typeof anchor.text === 'string' && anchor.text) {
      insertions.push({ text, reason, anchor: { type: 'text', segmentId: anchor.segmentId, text: anchor.text, position: anchor.position } })
      continue
    }
    return null
  }
  return insertions
}

function pickAllowed(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const result: Record<string, string> = {}
  for (const key of keys) {
    if (typeof source[key] === 'string') result[key] = source[key] as string
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function isPromptLibraryProposal(proposal: AgentWorkspaceProposal): proposal is PromptLibraryWriteProposal {
  return proposal.kind === 'prompt_library_write_proposal' || Boolean((proposal as PromptLibraryWriteProposal).presetDraft)
}

function isKnownCardType(value: unknown) {
  return ['subject', 'action', 'scene', 'style', 'camera', 'lighting', 'timing', 'audio', 'constraint', 'custom'].includes(String(value))
}

function filterProposalsForPermissionScope(
  proposals: AgentWorkspaceProposal[],
  permissionScope?: AgentPermissionScope
) {
  return proposals.filter(proposal => isProposalAllowedForPermissionScope(proposal, permissionScope))
}

function isProposalAllowedForPermissionScope(
  proposal: AgentWorkspaceProposal,
  permissionScope?: AgentPermissionScope
) {
  if (permissionScope === 'workspace-chatbot-agent') {
    return !isPromptLibraryProposal(proposal)
  }
  return true
}
