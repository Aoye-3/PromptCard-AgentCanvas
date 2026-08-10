export type ImageGenerationWorkflow =
  | 'text-to-image'
  | 'reference-generate'
  | 'smart-edit'
  | 'region-edit'

export type ImageGenerationTurnState = 'queued' | 'running' | 'succeeded' | 'failed'
export type ImageGenerationTurnAction =
  | 'view'
  | 'again'
  | 'edit'
  | 'region-edit'
  | 'reference'
  | 'place'
  | 'history'
  | 'media'

export interface ImageGenerationTurnSettings {
  workflow: ImageGenerationWorkflow
  modelLabel: string
  resolution: string
  aspectRatio: string
  outputFormat: string
  watermark: boolean
}

export interface ImageGenerationTurn {
  id: string
  createdAt: number
  prompt: string
  state: ImageGenerationTurnState
  settings: ImageGenerationTurnSettings
  inputs?: Array<{ referenceId: string; assetId: string; imageUrl: string }>
  regionCount?: number
  result?: {
    assetId: string
    imageUrl: string
    width: number
    height: number
  }
  error?: { message: string; action?: string }
}

export interface ImageGenerationConversationSummary {
  id: string
  title: string
  updatedAt: number
  turns: ImageGenerationTurn[]
}

export interface SelectOption<T extends string = string> {
  value: T
  label: string
}

export interface ImageGenerationComposerProps {
  prompt: string
  onPromptChange: (value: string) => void
  promptDocument?: import('@/models/PromptHistory.model').PromptDocument
  onPromptDocumentChange?: (document: import('@/models/PromptHistory.model').PromptDocument) => void
  unresolvedReferenceIds?: string[]
  references?: Array<{
    referenceId: string
    assetId?: string
    sourceAssetId?: string
    label: string
    imageUrl: string
    mentioned: boolean
    role?: 'source-image' | 'reference-image'
    order?: number
  }>
  textReferences?: Array<{
    nodeId: string
    label: string
    order?: number
  }>
  onMentionReference?: (referenceId: string) => void
  onRemoveReference?: (referenceId: string) => void
  onRemoveTextReference?: (nodeId: string) => void
  onMoveReference?: (referenceId: string, direction: -1 | 1) => void
  onReferenceRoleChange?: (referenceId: string, role: 'source-image' | 'reference-image') => void
  maxImages?: number
  workflows: SelectOption<ImageGenerationWorkflow>[]
  workflow: ImageGenerationWorkflow
  onWorkflowChange: (value: ImageGenerationWorkflow) => void
  models: SelectOption[]
  modelId: string
  onModelChange: (value: string) => void
  resolutions: string[]
  resolution: string
  onResolutionChange: (value: string) => void
  aspectRatios: string[]
  aspectRatio: string
  onAspectRatioChange: (value: string) => void
  customWidth?: number
  customHeight?: number
  onCustomSizeChange?: (width: number, height: number) => void
  promptOptimizationModes?: Array<'standard' | 'fast'>
  promptOptimization?: 'standard' | 'fast'
  onPromptOptimizationChange?: (value: 'standard' | 'fast') => void
  outputFormats: string[]
  outputFormat: string
  onOutputFormatChange: (value: string) => void
  supportsWatermark: boolean
  watermark: boolean
  onWatermarkChange: (value: boolean) => void
  selectedNode?: { id: string; label: string }
  selectedNodeCount?: number
  onInjectSelectedNode?: (nodeId: string) => void
  onUpload: (file: File) => void
  regionCount?: number
  onEditRegions?: () => void
  onEditAnnotations?: (referenceId: string) => void
  onSubmit: () => void
  disabled?: boolean
  missingRequirements?: string[]
  blockingRequirements?: string[]
}

export interface ImageGenerationConversationPanelProps {
  projectLabel: string
  conversationLabel?: string
  statusLabel?: string
  statusReady?: boolean
  onConfigureModel?: () => void
  onOpenSubjectLibrary?: () => void
  turns: ImageGenerationTurn[]
  composer: ImageGenerationComposerProps
  conversations: ImageGenerationConversationSummary[]
  onNewConversation: () => void
  onContinueConversation: (conversationId: string) => void
  onOpenHistoryConversation?: (conversationId: string) => void
  onLoadMoreConversations?: () => void
  onLoadMoreConversationRuns?: (conversationId: string) => void
  hasMoreConversations?: boolean
  hasMoreConversationRuns?: (conversationId: string) => boolean
  onTurnAction?: (turn: ImageGenerationTurn, action: ImageGenerationTurnAction) => void
}

export interface ImageGenerationHistoryDialogProps {
  open: boolean
  conversations: ImageGenerationConversationSummary[]
  initialConversationId?: string
  onClose: () => void
  onContinue: (conversationId: string) => void
  onSelectConversation?: (conversationId: string) => void
  onLoadMoreConversations?: () => void
  onLoadMoreRuns?: (conversationId: string) => void
  hasMoreConversations?: boolean
  hasMoreRuns?: (conversationId: string) => boolean
}
