export type PermissionScope =
  | 'workspace-chatbot-agent'
  | 'prompt-library-agent'
  | 'media-analysis-agent'

export type PromptLanguageMode = 'zh' | 'en' | 'mixed'

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
}

export function buildInvocation(input: InvocationInput) {
  const snapshot = input.workspaceContext?.snapshot
  const selectedNode = snapshot?.selectedNode
  const hasExplicitCanvasContext = input.canvasNodeContext !== undefined && input.canvasNodeContext !== null
  const canSearchPromptLibrary = input.permissionScope === 'prompt-library-agent'
    || input.canvasNodeContext?.mode === 'prompt-library'
  const selectedTextNodeId = hasExplicitCanvasContext
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
  if (input.permissionScope === 'prompt-library-agent') {
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
    workspaceContext: input.workspaceContext,
    promptLibrary: canSearchPromptLibrary ? input.promptLibrary.slice(0, 100) : [],
    history: (input.history || []).slice(-40),
    skillSnapshots: (input.skillSnapshots || []).slice(0, 8),
    canvasNodeContext: input.canvasNodeContext || null,
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
      canvasSegments
    } satisfies InvocationPolicy
  }
}
