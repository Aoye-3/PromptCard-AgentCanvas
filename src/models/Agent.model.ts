import type { CardType, IPreset } from './Card.model'
import type { IStoryboardRow, IStoryboardSequence } from './PromptHistory.model'
import type { AgentRunProvenance } from '@/domain/agent/agent-provenance'

export type { AgentRunProvenance } from '@/domain/agent/agent-provenance'

export type AgentRuntimeStatus = 'unknown' | 'connected' | 'disconnected'

export type AgentAuthStatus =
  | 'unknown'
  | 'setup-required'
  | 'unauthenticated'
  | 'authenticated'

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

export type AgentSessionKey = string

export interface AgentConversationSession {
  threadId?: string
  conversationId?: string
  interactionMode?: AgentInteractionMode
  boundSkillIds?: string[]
  revision?: number
  retryRequest?: { requestId: string; content: string }
  messages: AgentMessage[]
  proposals: AgentWorkspaceProposal[]
  running: boolean
  runtimeError?: string
  updatedAt: number
}

export interface AgentUser {
  id?: string
  email?: string
  name?: string
}

export interface AgentModelInfo {
  name?: string
  display_name?: string
  supports_vision?: boolean
  supports_thinking?: boolean
  key?: string
  connectionId?: string
  providerId?: string
  modelId?: string
  displayName?: string
  capabilities?: {
    input?: Array<'text' | 'image'>
    toolCalling?: boolean
    contextWindow?: number
    [key: string]: unknown
  }
  available?: boolean
  unavailableReason?: string | null
  isDefault?: boolean
  [key: string]: unknown
}

export interface AgentSkillInfo {
  id?: string
  name: string
  slug?: string
  description?: string
  category?: string
  enabled?: boolean
  source?: string
  trustState?: string
  revision?: number
  digest?: string
  capabilityId?: string | null
  toolDependencies?: string[]
  [key: string]: unknown
}

export interface AgentToolInfo {
  name: string
  group: string
  use?: string
  enabled?: boolean
  [key: string]: unknown
}

export interface AgentInfo {
  id?: string
  name?: string
  description?: string
  [key: string]: unknown
}

export interface PromptLibraryPresetDraft {
  type: CardType
  category: string
  label: string
  content: string
  meta?: Record<string, unknown>
}

export interface PromptLibraryWriteProposal {
  kind?: 'prompt_library_write_proposal'
  contextId?: string
  id: string
  threadId?: string | null
  runId?: string | null
  agentName: string
  operation: 'create' | 'update' | 'archive'
  targetPresetId?: string | null
  presetDraft: PromptLibraryPresetDraft
  rationale: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
}

export type AgentWorkspaceMode = 'card-workspace' | 'storyboard-workspace' | 'three-stage-workspace' | 'free-canvas-workspace'

export type AgentPermissionScope = 'workspace-chatbot-agent' | 'prompt-library-agent'

export interface AgentWorkspaceContext {
  contextId: string
  mode: AgentWorkspaceMode
  projectId: string
  projectTitle: string
  snapshot: Record<string, unknown>
}

/** Prompt-text edit operations only; conversation interaction modes are a separate policy boundary. See ADR-020. */
export type CanvasAgentEditMode = 'complete' | 'rewrite' | 'prompt-library'

export type AgentInteractionMode = 'prompt-edit' | 'chat-experimental'

export interface CanvasAgentSelection {
  start: number
  end: number
  selectedText: string
  baseContentDigest: string
}

export interface CanvasAgentNodeContext {
  mode: CanvasAgentEditMode
  targetNodeId: string | null
  referenceNodeIds: string[]
  mentions: Array<{ nodeId: string; label: string }>
  selection?: CanvasAgentSelection
}

export interface AgentCardCreateProposal {
  kind: 'workspace_card_create'
  contextId?: string
  id: string
  threadId?: string | null
  runId?: string | null
  agentName: string
  pageIndex?: number
  cardDraft: {
    type: CardType
    title: string
    content: string
    meta?: Record<string, unknown>
  }
  rationale: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
}

export interface AgentCardUpdateProposal {
  kind: 'workspace_card_update'
  contextId?: string
  id: string
  threadId?: string | null
  runId?: string | null
  agentName: string
  updates: Array<{
    cardId: string
    title?: string
    content?: string
  }>
  rationale: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
}

export interface AgentStoryboardUpdateProposal {
  kind: 'storyboard_update'
  contextId?: string
  id: string
  threadId?: string | null
  runId?: string | null
  agentName: string
  sequenceId?: string | null
  rowId?: string | null
  sequenceUpdates?: Partial<Pick<IStoryboardSequence, 'name' | 'description' | 'style' | 'constraints'>>
  rowUpdates?: Partial<Pick<IStoryboardRow, 'cutLabel' | 'timeRange' | 'subject' | 'action' | 'scene' | 'camera' | 'lighting' | 'audio' | 'duration'>>
  rationale: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
}

export interface AgentThreeStageFieldUpdateProposal {
  kind: 'three_stage_field_update'
  contextId?: string
  id: string
  threadId?: string | null
  runId?: string | null
  agentName: string
  stageKey: string
  fieldId: string
  mode: 'replace' | 'append'
  content: string
  rationale: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
}

export interface AgentFreeCanvasTextUpdateProposal {
  kind: 'free_canvas_text_update'
  contextId?: string
  id: string
  threadId?: string | null
  runId?: string | null
  agentName: string
  nodeId: string
  editMode: 'append' | 'rewrite_all' | 'rewrite_selection'
  userText: string
  selection?: Pick<CanvasAgentSelection, 'start' | 'end' | 'selectedText'>
  baseNodeRevision?: number
  templateDigest?: string
  baseContentDigest?: string
  rationale: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
}

export interface AgentMediaPromptPreviewProposal {
  kind: 'media_prompt_preview'
  contextId?: string
  id: string
  threadId?: string | null
  runId?: string | null
  agentName: string
  previewDraft: PromptLibraryPresetDraft
  rationale: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
}

export interface AgentFreeCanvasTextInsertion {
  text: string
  reason: string
  anchor:
    | { type: 'segment'; segmentId: string; position: 'before' | 'after' }
    | { type: 'text'; segmentId: string; text: string; position: 'before' | 'after' }
}

export interface AgentFreeCanvasTextProposalBasis {
  baseNodeRevision: number
  templateDigest: string
  baseSegmentsDigest: string
}

export interface AgentFreeCanvasTextInsertionsEdit {
  kind: 'free_canvas_text_insertions'
  contextId?: string
  id: string
  threadId?: string | null
  runId?: string | null
  agentName: string
  nodeId: string
  insertions: AgentFreeCanvasTextInsertion[]
  baseNodeRevision: number
  templateDigest: string
  baseSegmentsDigest: string
  rationale: string
  provenance?: AgentRunProvenance
  createdAt: number
}

export interface AgentFreeCanvasTextCreateEdit {
  kind: 'free_canvas_text_create'
  contextId?: string
  id: string
  threadId?: string | null
  runId?: string | null
  agentName: string
  title?: string
  userText: string
  sourceNodeId?: string
  basis?: AgentFreeCanvasTextProposalBasis
  provenance?: AgentRunProvenance
  rationale: string
  createdAt: number
}

export type AgentCanvasEdit =
  | AgentFreeCanvasTextInsertionsEdit
  | AgentFreeCanvasTextCreateEdit

export interface AgentFreeCanvasTextInsertionsProposal extends AgentFreeCanvasTextInsertionsEdit {
  status: 'pending' | 'approved' | 'rejected'
}

export interface AgentFreeCanvasTextCreateProposal extends AgentFreeCanvasTextCreateEdit {
  status: 'pending' | 'approved' | 'rejected'
}

export type AgentWorkspaceProposal =
  | PromptLibraryWriteProposal
  | AgentCardCreateProposal
  | AgentCardUpdateProposal
  | AgentStoryboardUpdateProposal
  | AgentThreeStageFieldUpdateProposal
  | AgentFreeCanvasTextUpdateProposal
  | AgentFreeCanvasTextInsertionsProposal
  | AgentFreeCanvasTextCreateProposal
  | AgentMediaPromptPreviewProposal

export type PromptLibrarySnapshotPreset = Pick<
  IPreset,
  'id' | 'type' | 'category' | 'label' | 'content' | 'usageCount' | 'meta'
>
