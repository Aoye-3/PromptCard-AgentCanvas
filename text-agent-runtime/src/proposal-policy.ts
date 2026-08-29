export type PermissionScope =
  | 'workspace-chatbot-agent'
  | 'prompt-library-agent'
  | 'media-analysis-agent'

export type PromptLanguageMode = 'zh' | 'en' | 'mixed'
export type AgentInteractionMode = 'prompt-edit' | 'chat-experimental'
const MAX_DOCUMENT_CONTEXT_BYTES = 100_000

export type PlanningInlineV1 = { text: string; bold?: true; italic?: true; href?: string }
export type PlanningDocumentBlockV1 =
  | { id: string; type: 'paragraph' | 'blockquote'; content: PlanningInlineV1[] }
  | { id: string; type: 'heading'; level: 1 | 2 | 3; content: PlanningInlineV1[] }
  | { id: string; type: 'bulletList' | 'orderedList'; items: Array<{ id: string; content: PlanningInlineV1[] }> }
  | { id: string; type: 'checkList'; items: Array<{ id: string; checked: boolean; content: PlanningInlineV1[] }> }
  | { id: string; type: 'table'; rows: Array<{
    id: string
    cells: Array<{ id: string; header?: true; content: PlanningInlineV1[] }>
  }> }

export type DocumentWriteContext =
  | {
    operationKind: 'document_create'
    linkedDocumentResourceIds: string[]
  }
  | {
    operationKind: 'document_changes'
    nodeId: string
    baseRevision: number
    baseDigest: string
    blocks: Array<{ blockId: string; text: string; expectedTextDigest: string }>
    wrapperBlockIds?: string[]
  }
  | {
    operationKind: 'storyboard_create'
    documentNodeId: string
    documentRevision: number
    documentDigest: string
    effectiveText: string
    documentResourceDigests: string[]
  }
  | {
    operationKind: 'storyboard_changes'
    nodeId: string
    baseRevision: number
    baseDigest: string
    sequence: Record<string, unknown>
  }

export interface PromptLibraryItem {
  id?: string
  type?: string
  category?: string
  label: string
  content: string
  meta?: Record<string, unknown>
}

export interface ConversationHistoryMessage extends Record<string, unknown> {
  role: string
  text?: string
  content: Array<Record<string, unknown> & { type?: string; text?: string }>
}

export interface InvocationInput {
  content: string
  permissionScope: PermissionScope
  interactionMode?: AgentInteractionMode
  workspaceContext: (Record<string, unknown> & {
    snapshot?: Record<string, unknown> & {
      selectedNode?: (Record<string, unknown> & { kind?: unknown; id?: unknown }) | null
      selectedNodeId?: unknown
    }
  }) | null
  promptLibrary: PromptLibraryItem[]
  history?: ConversationHistoryMessage[]
  skillSnapshots?: Array<{
    skillId: string
    revision: number
    digest: string
    instructions: string
    references?: Array<Record<string, unknown>>
  }>
  canvasNodeContext?: {
    mode: 'complete' | 'rewrite' | 'prompt-library'
    targetNodeId: string | null
    referenceNodeIds: string[]
    mentions: Array<{ nodeId: string; label: string }>
    selection?: {
      start: number
      end: number
      selectedText: string
      baseContentDigest: string
    }
    targetNode?: Record<string, unknown> | null
    referenceNodes?: Array<Record<string, unknown>>
  } | null
  documentWriteContext?: DocumentWriteContext | null
  mediaAction?: 'chat' | 'preview' | 'selection-rewrite'
  promptLanguageMode?: PromptLanguageMode
  mediaPreview?: Record<string, unknown> | null
  selection?: {
    start: number
    end: number
    text: string
  } | null
  attachment?: {
    assetId: string
    contentType: string
    data: string
  }
  attachments?: Array<{
    assetId: string
    contentType: string
    data: string
  }>
}

export interface InvocationPolicy {
  allowedProposalKinds: string[]
  allowedCanvasEditKinds: string[]
  selectedTextNodeId: string | null
  canvasEditMode: 'insertions' | 'derived_node' | null
  canvasSelection: { start: number; end: number; selectedText: string } | null
  canSearchPromptLibrary: boolean
  canvasSegments: Array<{ id: string; text: string }>
  documentWriteContext: DocumentWriteContext | null
}

export function buildInvocation(input: InvocationInput) {
  const interactionMode = input.interactionMode || 'prompt-edit'
  const isExperimentalChat = interactionMode === 'chat-experimental'
  const snapshot = input.workspaceContext?.snapshot
  const selectedNode = snapshot?.selectedNode
  const hasExplicitCanvasContext = !isExperimentalChat
    && input.canvasNodeContext !== undefined
    && input.canvasNodeContext !== null
  const canSearchPromptLibrary = !isExperimentalChat && (
    input.permissionScope === 'prompt-library-agent'
    || input.canvasNodeContext?.mode === 'prompt-library'
  )
  const documentWriteContext = isExperimentalChat
    && input.permissionScope === 'workspace-chatbot-agent'
    ? normalizeDocumentWriteContext(input.documentWriteContext)
    : null
  const selectedTextNodeId = isExperimentalChat
    ? null
    : hasExplicitCanvasContext
    ? input.canvasNodeContext?.mode === 'prompt-library' ? null : input.canvasNodeContext?.targetNodeId || null
    : selectedNode?.kind === 'text' && selectedNode?.id === snapshot?.selectedNodeId
      ? String(selectedNode.id)
      : null
  const canvasSelection = input.canvasNodeContext?.mode === 'rewrite' && input.canvasNodeContext.selection
    ? {
        start: input.canvasNodeContext.selection.start,
        end: input.canvasNodeContext.selection.end,
        selectedText: input.canvasNodeContext.selection.selectedText
      }
    : null
  const canvasEditMode = selectedTextNodeId && input.canvasNodeContext
    ? input.canvasNodeContext.mode === 'complete'
      ? 'insertions'
      : input.canvasNodeContext.mode === 'rewrite' ? 'derived_node' : null
    : null
  const target = input.canvasNodeContext?.targetNode
    || (snapshot?.nodes as Array<Record<string, unknown>> | undefined)?.find(node => node.id === selectedTextNodeId)
  const canvasSegments = Array.isArray((target as Record<string, unknown> | undefined)?.segments)
    ? ((target as Record<string, unknown>).segments as Array<Record<string, unknown>>)
      .filter(segment => typeof segment.id === 'string' && typeof segment.text === 'string')
      .map(segment => ({ id: String(segment.id), text: String(segment.text) }))
    : []

  let allowedProposalKinds: string[] = []
  let allowedCanvasEditKinds: string[] = []
  if (isExperimentalChat) {
    allowedProposalKinds = []
    allowedCanvasEditKinds = documentWriteContext ? [documentWriteContext.operationKind] : []
  } else if (input.permissionScope === 'prompt-library-agent') {
    allowedProposalKinds = ['prompt_library_write_proposal']
  } else if (input.permissionScope === 'workspace-chatbot-agent') {
    allowedCanvasEditKinds = hasExplicitCanvasContext
      ? selectedTextNodeId
        ? input.canvasNodeContext?.mode === 'complete'
          ? ['free_canvas_text_insertions']
          : input.canvasNodeContext?.mode === 'rewrite'
            ? ['free_canvas_text_create']
            : []
        : []
      : []
  } else if (
    input.permissionScope === 'media-analysis-agent' &&
    input.mediaAction === 'preview'
  ) {
    allowedProposalKinds = ['media_prompt_preview']
  }

  return {
    content: input.content.trim(),
    interactionMode,
    workspaceContext: input.workspaceContext,
    promptLibrary: canSearchPromptLibrary ? input.promptLibrary.slice(0, 100) : [],
    history: (input.history || []).slice(-40),
    skillSnapshots: (input.skillSnapshots || []).slice(0, 8),
    canvasNodeContext: isExperimentalChat ? null : input.canvasNodeContext || null,
    documentWriteContext,
    mediaAction: input.mediaAction || 'chat',
    promptLanguageMode: input.permissionScope === 'media-analysis-agent'
      ? input.promptLanguageMode || 'mixed'
      : null,
    mediaPreview: input.mediaPreview || null,
    selection: input.selection || null,
    attachments: (input.attachments?.length
      ? input.attachments
      : input.attachment ? [input.attachment] : []
    ).slice(0, 10).map(attachment => ({
      assetId: attachment.assetId,
      mimeType: attachment.contentType,
      data: attachment.data
    })),
    policy: {
      allowedProposalKinds,
      allowedCanvasEditKinds,
      selectedTextNodeId,
      canvasEditMode,
      canvasSelection,
      canSearchPromptLibrary,
      canvasSegments,
      documentWriteContext
    } satisfies InvocationPolicy
  }
}

function normalizeDocumentWriteContext(value: unknown): DocumentWriteContext | null {
  if (!isRecord(value)) return null
  if (value.operationKind === 'document_create') {
    if (!hasExactKeys(value, ['operationKind', 'linkedDocumentResourceIds'])) return null
    if (!Array.isArray(value.linkedDocumentResourceIds) || value.linkedDocumentResourceIds.length > 5) return null
    const resourceIds = value.linkedDocumentResourceIds
    if (!resourceIds.every(isBoundIdentity) || new Set(resourceIds).size !== resourceIds.length) return null
    return { operationKind: 'document_create', linkedDocumentResourceIds: [...resourceIds] }
  }
  if (value.operationKind === 'storyboard_create') {
    if (!hasExactKeys(value, [
      'operationKind', 'documentNodeId', 'documentRevision', 'documentDigest', 'effectiveText', 'documentResourceDigests'
    ])) return null
    if (!isBoundIdentity(value.documentNodeId)
      || !Number.isSafeInteger(value.documentRevision) || Number(value.documentRevision) < 0
      || !isBoundDigest(value.documentDigest)
      || typeof value.effectiveText !== 'string' || !isWellFormed(value.effectiveText)
      || value.effectiveText !== value.effectiveText.normalize('NFC')
      || new TextEncoder().encode(value.effectiveText).length > MAX_DOCUMENT_CONTEXT_BYTES
      || !Array.isArray(value.documentResourceDigests) || value.documentResourceDigests.length > 5
      || !value.documentResourceDigests.every(isBoundDigest)) return null
    return {
      operationKind: 'storyboard_create',
      documentNodeId: value.documentNodeId,
      documentRevision: Number(value.documentRevision),
      documentDigest: value.documentDigest,
      effectiveText: value.effectiveText,
      documentResourceDigests: [...value.documentResourceDigests]
    }
  }
  if (value.operationKind === 'storyboard_changes') {
    if (!hasExactKeys(value, ['operationKind', 'nodeId', 'baseRevision', 'baseDigest', 'sequence'])
      || !isBoundIdentity(value.nodeId)
      || !Number.isSafeInteger(value.baseRevision) || Number(value.baseRevision) < 0
      || !isBoundDigest(value.baseDigest) || !isRecord(value.sequence)) return null
    return { operationKind: 'storyboard_changes', nodeId: value.nodeId, baseRevision: Number(value.baseRevision), baseDigest: value.baseDigest, sequence: structuredClone(value.sequence) }
  }
  if (value.operationKind !== 'document_changes') return null
  if (!hasExactKeys(value, [
    'operationKind', 'nodeId', 'baseRevision', 'baseDigest', 'blocks'
  ], ['wrapperBlockIds'])) return null
  if (!isBoundIdentity(value.nodeId)
    || !Number.isSafeInteger(value.baseRevision)
    || Number(value.baseRevision) < 0
    || !isBoundDigest(value.baseDigest)
    || !Array.isArray(value.blocks)
    || value.blocks.length === 0
    || value.blocks.length > 128) return null
  const blocks: Array<{ blockId: string; text: string; expectedTextDigest: string }> = []
  const identities = new Set<string>()
  let textBytes = 0
  for (const candidate of value.blocks) {
    if (!isRecord(candidate)
      || !hasExactKeys(candidate, ['blockId', 'text', 'expectedTextDigest'])
      || !isBoundIdentity(candidate.blockId)
      || typeof candidate.text !== 'string'
      || !isWellFormed(candidate.text)
      || candidate.text !== candidate.text.normalize('NFC')
      || !isBoundDigest(candidate.expectedTextDigest)
      || identities.has(candidate.blockId)) return null
    textBytes += new TextEncoder().encode(candidate.text).length
    if (textBytes > MAX_DOCUMENT_CONTEXT_BYTES) return null
    identities.add(candidate.blockId)
    blocks.push({
      blockId: candidate.blockId,
      text: candidate.text,
      expectedTextDigest: candidate.expectedTextDigest
    })
  }
  const wrapperBlockIds = value.wrapperBlockIds === undefined ? [] : value.wrapperBlockIds
  if (!Array.isArray(wrapperBlockIds)
    || wrapperBlockIds.length > 128
    || !wrapperBlockIds.every(isBoundIdentity)
    || new Set(wrapperBlockIds).size !== wrapperBlockIds.length
    || wrapperBlockIds.some(identity => identities.has(identity))) return null
  return {
    operationKind: 'document_changes',
    nodeId: value.nodeId,
    baseRevision: Number(value.baseRevision),
    baseDigest: value.baseDigest,
    blocks,
    ...(wrapperBlockIds.length ? { wrapperBlockIds: [...wrapperBlockIds] } : {})
  }
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

function isBoundIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 192
    && isWellFormed(value)
    && value === value.normalize('NFC')
}

function isBoundDigest(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 192
    && isWellFormed(value)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
