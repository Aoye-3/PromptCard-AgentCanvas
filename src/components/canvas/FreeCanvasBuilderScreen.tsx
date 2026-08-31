import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent as ReactChangeEvent, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  NodeResizer,
  NodeToolbar,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type OnConnect,
  type OnNodeDrag,
  type OnSelectionChangeFunc,
  useStore,
  useReactFlow
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertTriangle, ArrowLeft, ArrowRight, Bot, BookOpen, Brush, ChevronRight, Copy, Hash, Image as ImageIcon, Loader2, MessageSquare, MousePointer2, Palette, Pencil, Plus, Redo2, Save, Square, Trash2, Type, Undo2, X } from 'lucide-react'
import { AIChatbotBox } from '@/components/AgentCollaborationPanel'
import { PromptLibraryPreviewPanel } from '@/components/PromptLibraryPreviewMode'
import { PromptPresetPreviewDialog } from '@/components/prompt-media/PromptPresetPreviewDialog'
import { ImageCropEditor } from '@/components/canvas/ImageCropEditor'
import {
  ImageGeneratorNode
} from '@/components/canvas/nodes/ImageGeneratorNode'
import { DocumentNode } from '@/components/canvas/nodes/DocumentNode'
import { StoryboardNode } from '@/components/canvas/nodes/StoryboardNode'
import { ImageGenerationConversationPanel } from '@/components/canvas/image-generation/ImageGenerationConversationPanel'
import { AnnotationEditorDialog } from '@/components/canvas/image-generation/AnnotationEditorDialog'
import { RegionEditorDialog } from '@/components/canvas/image-generation/RegionEditorDialog'
import { ProjectResourceLibrary } from '@/components/canvas/ProjectResourceLibrary'
import { ImageNodeActionBar } from '@/components/canvas/image-actions/ImageNodeActionBar'
import { CanvasNodeContextMenu } from '@/components/canvas/image-actions/CanvasNodeContextMenu'
import { CanvasProjectReferenceCodeAction } from '@/components/canvas/image-actions/CanvasReferenceCodeAction'
import { CopyCodexContext } from '@/components/canvas/context-packs/CopyCodexContext'
import { AgentWorkEnvironment } from '@/components/canvas/bridge/AgentWorkEnvironment'
import {
  createBridgeImageApplication,
  createBridgeImageNode,
  inspectBridgeImageApplication
} from '@/components/canvas/bridge/bridge-image-application'
import {
  applyBridgeDocumentChange,
  createBridgeDocumentApplication,
  createBridgeDocumentNode,
  inspectBridgeDocumentApplication
} from '@/components/canvas/bridge/bridge-document-application'
import {
  applyBridgeStoryboardChange,
  createBridgeStoryboardApplication,
  createBridgeStoryboardNode,
  inspectBridgeStoryboardApplication
} from '@/components/canvas/bridge/bridge-storyboard-application'
import { CanvasUnsupportedNodeContextMenu } from '@/components/canvas/image-actions/CanvasUnsupportedNodeContextMenu'
import {
  CanvasTextNodeContextMenu,
  type TextNodeContextCommand
} from '@/components/canvas/image-actions/CanvasTextNodeContextMenu'
import { ImageOperationWorkbenchDialog } from '@/components/canvas/image-actions/ImageOperationWorkbenchDialog'
import { MultiViewWorkbenchDialog } from '@/components/canvas/image-actions/MultiViewWorkbenchDialog'
import {
  MultiViewGroupPanel,
  type MultiViewGroupPanelMember
} from '@/components/canvas/image-actions/MultiViewGroupPanel'
import type { ImageGenerationConversationSummary as ImageGenerationConversationView, ImageGenerationTurn, ImageGenerationTurnAction } from '@/components/canvas/image-generation/types'
import { canvasImageAssetUrl, fitImageNode, getClipboardImageFiles, isFileDrag, isSupportedImageFile, uploadFreeCanvasImageFiles } from '@/components/canvas/canvas-image-assets'
import { createFreeCanvasCroppedNodes, createFreeCanvasMediaNode, type FreeCanvasCropLines, type FreeCanvasMediaNode } from '@/domain/free-canvas/free-canvas'
import {
  createFreeCanvasImageNodeFromMedia,
  createFreeCanvasImageGenerationPlaceholder,
  createFreeCanvasImageAnnotation,
  createFreeCanvasDocumentNode,
  createFreeCanvasTextNode,
  createFreeCanvasAgentRewriteNode,
  createQuickTextNode,
  applyFreeCanvasTextInsertions,
  appendFreeCanvasUserText,
  freeCanvasPresetText,
  freeCanvasTextSegmentsToPlainText,
  freeCanvasUserText,
  completeFreeCanvasImageGeneration,
  failFreeCanvasImageGeneration,
  isRunningFreeCanvasImageGeneration,
  matchesFreeCanvasTextProposalBasis,
  renameFreeCanvasTextNode,
  replaceFreeCanvasUserTextRange,
  replaceFreeCanvasTextRange,
  replaceFreeCanvasImageAnnotations,
  removeFreeCanvasProjectNodes,
  fitFreeCanvasImageNodeFrameToContent,
  updateFreeCanvasImageNodeFrame,
  updateFreeCanvasNodePosition,
  updateFreeCanvasTextNodeStyle,
  updateFreeCanvasTextNodeUserText
} from '@/domain/free-canvas/free-canvas-project'
import {
  applyCanvasLocalCommand,
  createCanvasCommandHistory,
  discardCanvasCommandHistoryEntry,
  duplicateCanvasImageNode,
  executeCanvasLocalCommand,
  recoverFailedCanvasHistoryStep,
  redoCanvasLocalCommand,
  undoCanvasLocalCommand,
  type CanvasCommandHistoryEntry,
  type CanvasLocalCommand
} from '@/domain/free-canvas/canvas-command-history'
import { markCanvasNodeReferencePending } from '@/domain/reference-codes/canvas-node-reference-lifecycle'
import { applyDocumentChangeOperations } from '@/domain/documents/document-suggestions'
import { createPlanningDocumentV1 } from '@/domain/documents/planning-document'
import { matchesDocumentPromptHandoffBasis } from '@/domain/documents/prompt-handoff-selection'
import { applyStoryboardChanges, createStoryboardNode, resolveStoryboardFieldChanges, storyboardDigest, storyboardShotDigest } from '@/domain/storyboard/canvas-storyboard'
import {
  resolveImageNodeCommands,
  type ImageNodeCommandId,
  type ResolvedImageNodeCommand
} from '@/domain/image-actions/image-node-commands'
import { resolveImageOperationAvailability } from '@/domain/image-actions/image-recipes'
import {
  compileImageOperationDraft,
  type ImageOperationDraft,
  type ImageOperationReference
} from '@/domain/image-actions/image-operation-draft'
import {
  createMultiViewRequestMembers,
  defaultMultiViewSpecs,
  scheduleMultiViewMembers
} from '@/domain/image-actions/multi-view-recipe'
import type { ImageProductOperation } from '@/domain/image-actions/image-operations'
import { renderVisibleImage } from '@/domain/image-actions/render-visible-image'
import {
  resolveCanvasImageInput
} from '@/domain/image-generation/canvas-image-input'
import { buildFreeCanvasWorkspaceContext } from '@/utils/agent-workspace'
import { useI18n } from '@/i18n'
import { usePresetStore } from '@/stores/preset.store'
import {
  createQuickMessagePresetInput,
  isQuickMessagePreset,
  quickMessagePresetToCanvasSource,
  quickMessagePresetToDraft,
  type QuickMessageDraft
} from '@/domain/prompt-library/quick-messages'
import {
  buildConversationGenerationRequest,
  compileConversationPromptDocument,
  createEmptyConversationDraft,
  injectCanvasNodesIntoDraft,
  promptDocumentPlainText,
  projectRunToTurn,
  removeConversationTextReference,
  rebuildPreparedImageGenerationRequest,
  type ImageGenerationComposerDraft,
  type ProjectImageGenerationInput,
  type ProjectImageGenerationWorkflow
} from '@/domain/image-generation/project-conversation'
import {
  moveComposerImageInput,
  unresolvedPromptReferenceIds,
  switchComposerImageInputRole,
  validateComposerCustomSize
} from '@/domain/image-generation/composer-draft'
import { appendSubjectReference } from '@/domain/project-resources/project-resource-library'
import {
  isProjectMaterialDrag,
  readProjectMaterialDrag
} from '@/domain/project-resources/project-resource-drag'
import {
  rasterizeAnnotationDocument,
  type ImageAnnotationDocument
} from '@/domain/image-generation/annotations'
import { compileImageGeneratorPrompt } from '@/domain/image-generation/prompt-compiler'
import { getRuntimeErrorPresentation, type ModelAssignment, type ModelCatalogEntry, type ModelConnection } from '@/domain/models/model-management'
import { modelManagementClient } from '@/services/model-management-client'
import { agentRuntimeService } from '@/services/agent-runtime-service'
import {
  createImageGenerationRunId,
  ImageGenerationClientError,
  prepareImageGenerationBatch,
  requestImageGeneration,
  type ImageGenerationRequest
} from '@/services/image-generation-client'
import {
  storageServiceClient,
  type BridgeDelivery,
  type BridgeDocumentChangeDelivery,
  type BridgeDocumentCreateDelivery,
  type BridgeDocumentDelivery,
  type BridgeImageDelivery,
  type BridgePromptDelivery,
  type BridgeStoryboardChangeDelivery,
  type BridgeStoryboardCreateDelivery,
  type BridgeStoryboardDelivery,
  type ImageGenerationConversationSummary,
  type ImageGenerationRun,
  type ProjectResource
} from '@/storage/storage-service-client'
import type { AgentCanvasEdit, AgentPromptHandoffBasis, AgentWorkspaceProposal, CanvasAgentSelection } from '@/models/Agent.model'
import type { IPreset } from '@/models/Card.model'
import type { FreeCanvasImageAnnotationKind, IFreeCanvasImageAnnotation, IFreeCanvasImageGeneratorNode, IFreeCanvasImageNode, IFreeCanvasNode, IFreeCanvasProject, IFreeCanvasTextNode, IPromptProject, PlanningDocumentV1 } from '@/models/PromptHistory.model'

interface FreeCanvasBuilderScreenProps {
  activeProject: IPromptProject
  freeCanvas: IFreeCanvasProject
  onBack: () => void
  onRenameProject: () => void
  onSave: () => void
  onChange: (freeCanvas: IFreeCanvasProject) => void
  onPersistCanvas?: (freeCanvas: IFreeCanvasProject) => Promise<boolean | FreeCanvasPersistReceipt>
  previewMode?: boolean
  imageGenerationNodeV1?: boolean
  onConfigureImageModel?: (context: { projectId: string; nodeId?: string; returnTarget: 'free-canvas' }) => void
  onOpenMedia?: () => void
}

type FreeCanvasFlowNodeData = {
  canvasNode: IFreeCanvasNode
  editing: boolean
  onEdit: (nodeId: string | null) => void
  onTextCopy: (nodeId: string) => void
  onTextRangeReplace: (nodeId: string, range: { start: number; end: number }, insertedText: string, color: string) => void
  onTextStyleChange: (nodeId: string, updates: Parameters<typeof updateFreeCanvasTextNodeStyle>[2]) => void
  onTextRename: (nodeId: string, title: string) => string | null
  onTextSelectionChange: (nodeId: string, selection?: Omit<CanvasAgentSelection, 'baseContentDigest'>) => void
  onDocumentChange: (nodeId: string, document: PlanningDocumentV1) => Promise<boolean>
  onDocumentCollapsedChange: (nodeId: string, collapsed: boolean) => Promise<boolean>
  onDocumentDelete: (nodeId: string) => void
  onDocumentToStoryboard: (nodeId: string) => void
  onDocumentPromptHandoff: (basis: Extract<AgentPromptHandoffBasis, { kind: 'document-selection' }>) => void
  onStoryboardResolve: (nodeId: string, ids: readonly string[] | 'all', action: 'accept' | 'reject') => void
  onStoryboardRevise: (nodeId: string) => void
  onStoryboardPromptHandoff: (nodeId: string, rowId: string) => void
  documentLocked: boolean
  storyboardLocked: boolean
  onImageResize: (nodeId: string, frame: { position?: { x: number; y: number }; width: number; height: number }) => void
  resultThumbnailUrl?: string
  onOpenImageHistory: (nodeId: string) => void
  onConfigureImageModel?: (nodeId: string) => void
  onContinueLegacyImageCreation: (nodeId: string) => void
  imageCommands?: readonly ResolvedImageNodeCommand[]
  onImageCommand: (nodeId: string, commandId: ImageNodeCommandId) => void
  imageGeneratorInputSummary?: { promptConnected: boolean; sourceConnected: boolean; referenceCount: number }
}

type FreeCanvasFlowNode = Node<FreeCanvasFlowNodeData>
type ProjectMaterialCanvasSource = Pick<
  ProjectResource,
  'id' | 'name' | 'sourceAssetId' | 'previewAssetId' | 'width' | 'height'
>

type MultiViewRetryTarget = {
  nodeId: string
  operationGroupId: string
  operationItemId: string
  viewSpec: string
  source: Pick<
    ImageOperationDraft['source'],
    'nodeId' | 'originalAssetId' | 'canvasAssetId' | 'providerAssetId'
  >
}

type ActiveImageOperationDraft = ImageOperationDraft & {
  retryNodeId?: string
}

const TEXT_COLORS = ['#111827', '#ef4423', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff']
const FONT_SIZES: IFreeCanvasTextNode['fontSize'][] = ['small', 'medium', 'large', 'extra-large', 'huge']
const emptyQuickTextPresetDraft: QuickMessageDraft = { name: '', body: '' }
const composerReferenceImageExtensions = /\.(?:jpe?g|png|webp|bmp|tiff?|gif|heic|heif)$/i

const isComposerReferenceImage = (file: File): boolean =>
  file.type.startsWith('image/') || composerReferenceImageExtensions.test(file.name)

const isCanvasImageDrag = (dataTransfer: DataTransfer): boolean =>
  isFileDrag(dataTransfer) || isProjectMaterialDrag(dataTransfer)

type DocumentAuthorityNode = Extract<IFreeCanvasNode, { kind: 'document' }>

const exactCanvasNode = (
  canvas: IFreeCanvasProject,
  nodeId: string
): IFreeCanvasNode | null => {
  const matching = canvas.nodes.filter(node => node.id === nodeId)
  return matching.length === 1 ? matching[0] : null
}

interface ProjectMutationScope {
  projectId: string
  epoch: number
}

export interface FreeCanvasPersistReceipt {
  saved: true
  freeCanvas: IFreeCanvasProject
  editSeq: number
  projectRevision: number
}

interface DocumentReconcileLease {
  projectId: string
  conversationId: string
  nodeIds: Set<string>
}

interface DocumentReconcileState {
  projectId: string
  conversationId: string
  leaseId: string
  pending: boolean
  nodeId?: string
}

interface StoryboardAckRecoveryTarget extends Omit<DocumentReconcileState, 'pending'> {
  requestId: string
  editId: string
}

interface StoryboardAckRecoveryState {
  token: symbol
  promise: Promise<boolean>
  resolve: (applied: boolean) => void
}

const documentMutationQueueKey = (scope: ProjectMutationScope): string => (
  `${scope.projectId}:${scope.epoch}`
)

const sameProjectMutationScope = (
  left: ProjectMutationScope,
  right: ProjectMutationScope
): boolean => left.projectId === right.projectId && left.epoch === right.epoch

const stableSemanticJson = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSemanticJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableSemanticJson(record[key])}`)
    .join(',')}}`
}

const hasExactDocumentAuthority = (
  canvas: IFreeCanvasProject,
  nodeId: string,
  attempted: DocumentAuthorityNode
): boolean => {
  const matching = exactCanvasNode(canvas, nodeId)
  return matching?.kind === 'document'
    && stableSemanticJson(matching) === stableSemanticJson(attempted)
}

const hasExactCanvasNodeAuthority = (
  canvas: IFreeCanvasProject,
  nodeId: string,
  attempted: IFreeCanvasNode
): boolean => {
  const matching = exactCanvasNode(canvas, nodeId)
  return matching !== null && stableSemanticJson(matching) === stableSemanticJson(attempted)
}

const canvasCommandAuthorityImpact = (command: CanvasLocalCommand) => {
  const nodeIds: string[] = []
  const edgeIds: string[] = []
  let nodeOrder = false
  let edgeOrder = false
  if (command.kind === 'update-document' || command.kind === 'update-storyboard' || command.kind === 'flip-image') nodeIds.push(command.nodeId)
  if (command.kind === 'reorder-node') {
    nodeIds.push(command.nodeId)
    nodeOrder = true
  }
  if (command.kind === 'insert-node') {
    nodeIds.push(command.node.id)
    nodeOrder = true
  }
  if (command.kind === 'delete-nodes') {
    nodeIds.push(...command.nodeIds)
    nodeOrder = true
    edgeOrder = true
  }
  if (command.kind === 'restore-nodes') {
    nodeIds.push(...command.nodes.map(item => item.node.id))
    edgeIds.push(...command.edges.map(item => item.edge.id))
    nodeOrder = true
    edgeOrder = true
  }
  return { nodeIds, edgeIds, nodeOrder, edgeOrder }
}

const canvasHistoryAuthorityIdentity = (
  canvas: IFreeCanvasProject,
  entry: CanvasCommandHistoryEntry
): string => {
  const impacts = [entry.undo, entry.redo].map(canvasCommandAuthorityImpact)
  const nodeIds = [...new Set(impacts.flatMap(impact => impact.nodeIds))].sort()
  const edgeIds = [...new Set(impacts.flatMap(impact => impact.edgeIds))].sort()
  return stableSemanticJson({
    nodes: nodeIds.map(id => ({ id, matches: canvas.nodes.filter(node => node.id === id) })),
    edges: edgeIds.map(id => ({ id, matches: canvas.edges.filter(edge => edge.id === id) })),
    nodeOrder: impacts.some(impact => impact.nodeOrder) ? canvas.nodes.map(node => node.id) : undefined,
    edgeOrder: impacts.some(impact => impact.edgeOrder) ? canvas.edges.map(edge => edge.id) : undefined
  })
}

const validCanvasSelection = (
  canvas: IFreeCanvasProject,
  nodeId: string | null | undefined
): string | null => nodeId && canvas.nodes.some(node => node.id === nodeId) ? nodeId : null

const canvasHistoryRecoverySelection = (
  attempted: IFreeCanvasProject,
  current: IFreeCanvasProject,
  recovered: IFreeCanvasProject
): string | null => {
  const normalSelection = validCanvasSelection(recovered, recovered.selectedNodeId)
  const attemptedSelection = attempted.selectedNodeId || null
  const currentSelection = current.selectedNodeId || null
  if (currentSelection === attemptedSelection) return normalSelection
  if (currentSelection === null) return null
  return validCanvasSelection(recovered, currentSelection) ?? normalSelection
}

const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element?.closest('input, textarea, [contenteditable="true"], [role="textbox"]'))
}

const imageNodeToMedia = (node: IFreeCanvasImageNode): FreeCanvasMediaNode => ({
  id: node.id,
  kind: 'imageAsset',
  title: node.title,
  position: node.position,
  width: node.width,
  height: node.height,
  assetId: node.assetId || null,
  imageUrl: node.imageUrl || '',
  imagePrompt: node.imagePrompt || '',
  sourceNodeId: node.sourceNodeId || null,
  generatedFromAgent: false,
  crop: node.crop || null,
  text: '',
  color: '#111827',
  meta: node.meta || {}
})

export const FreeCanvasBuilderScreen = (props: FreeCanvasBuilderScreenProps) => (
  <ReactFlowProvider>
    <FreeCanvasBuilderInner {...props} />
  </ReactFlowProvider>
)

const FreeCanvasBuilderInner = ({
  activeProject,
  freeCanvas,
  onBack,
  onRenameProject,
  onSave,
  onChange,
  onPersistCanvas,
  previewMode = false,
  imageGenerationNodeV1 = false,
  onConfigureImageModel,
  onOpenMedia
}: FreeCanvasBuilderScreenProps) => {
  const reactFlow = useReactFlow<FreeCanvasFlowNode>()
  const { cardTypeLabel } = useI18n()
  const {
    presets,
    initialized: presetsInitialized,
    init: initPresets,
    addPreset,
    updatePreset,
    deletePreset
  } = usePresetStore()
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false)
  const [resourceLibraryExpanded, setResourceLibraryExpanded] = useState(false)
  const [rightPanelMode, setRightPanelMode] = useState<'agent' | 'image-generation' | 'prompt-library'>('agent')
  const [activeBridgeCvcCode, setActiveBridgeCvcCode] = useState<string | null>(
    () => readActiveBridgeContext(activeProject.id)
  )
  const [previewPreset, setPreviewPreset] = useState<IPreset | null>(null)
  const [quickDrawerOpen, setQuickDrawerOpen] = useState(false)
  const [quickComposerOpen, setQuickComposerOpen] = useState(false)
  const [quickEditingPresetId, setQuickEditingPresetId] = useState<string | null>(null)
  const [quickPresetDraft, setQuickPresetDraft] = useState<QuickMessageDraft>(emptyQuickTextPresetDraft)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null)
  const [fileDragActive, setFileDragActive] = useState(false)
  const [composerFileDragActive, setComposerFileDragActive] = useState(false)
  const [cropNodeId, setCropNodeId] = useState<string | null>(null)
  const [annotationEditorNodeId, setAnnotationEditorNodeId] = useState<string | null>(null)
  const [imageCatalogModels, setImageCatalogModels] = useState<ModelCatalogEntry[]>([])
  const [imageConnections, setImageConnections] = useState<ModelConnection[]>([])
  const [imageAssignment, setImageAssignment] = useState<ModelAssignment | null>(null)
  const [imageRuntimeReady, setImageRuntimeReady] = useState(false)
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(
    () => freeCanvas.selectedNodeId ? [freeCanvas.selectedNodeId] : []
  )
  const [documentReconcileLockedNodeIds, setDocumentReconcileLockedNodeIds] = useState<string[]>([])
  const [agentDraftRequest, setAgentDraftRequest] = useState<{
    id: string
    content?: string
    documentWriteContext?: import('@/models/Agent.model').AgentPlanningWriteContext
    canvasNode?: {
      nodeId: string
      role: 'target' | 'reference'
      mode?: 'complete' | 'rewrite'
      selection?: CanvasAgentSelection
    }
  } | undefined>()
  const changeActiveBridgeContext = useCallback((code: string | null) => {
    setActiveBridgeCvcCode(code)
    writeActiveBridgeContext(activeProject.id, code)
  }, [activeProject.id])
  const prepareContextPackRevision = useCallback(async () => {
    if (!onPersistCanvas) return activeProject.revision
    const receipt = await onPersistCanvas(freeCanvasRef.current)
    if (
      typeof receipt !== 'object'
      || receipt.saved !== true
      || !Number.isSafeInteger(receipt.projectRevision)
      || receipt.projectRevision < 1
    ) throw new Error('Canvas save did not return an authoritative project revision.')
    return receipt.projectRevision
  }, [activeProject.revision, onPersistCanvas])
  const [textSelections, setTextSelections] = useState<Record<string, Omit<CanvasAgentSelection, 'baseContentDigest'>>>({})
  const [nodeContextMenu, setNodeContextMenu] = useState<{
    nodeId: string
    x: number
    y: number
    returnFocus: HTMLElement | null
  } | null>(null)
  const [activeImageOperationDraft, setActiveImageOperationDraft] = useState<ActiveImageOperationDraft | null>(null)
  const [imageOperationPreparing, setImageOperationPreparing] = useState(false)
  const [activeImageConversationId, setActiveImageConversationId] = useState<string | null>(null)
  const imageConversationIntentRef = useRef<'auto' | 'new' | 'active'>('auto')
  const [imageConversations, setImageConversations] = useState<ImageGenerationConversationSummary[]>([])
  const [imageConversationNextCursor, setImageConversationNextCursor] = useState<string | null>(null)
  const [imageConversationRuns, setImageConversationRuns] = useState<Record<string, ImageGenerationRun[]>>({})
  const [imageRunNextCursors, setImageRunNextCursors] = useState<Record<string, string | null>>({})
  const [imageComposerDraft, setImageComposerDraft] = useState<ImageGenerationComposerDraft>(() => createEmptyConversationDraft())
  const [imageGenerationBusy, setImageGenerationBusy] = useState(false)
  const [imageRegionEditorOpen, setImageRegionEditorOpen] = useState(false)
  const [imageAnnotationTarget, setImageAnnotationTarget] = useState<{
    referenceId: string
    width: number
    height: number
  } | null>(null)
  const [imageAnnotationDocuments, setImageAnnotationDocuments] = useState<Record<string, ImageAnnotationDocument>>({})
  const [optimisticImageTurn, setOptimisticImageTurn] = useState<ImageGenerationTurn | null>(null)

  useEffect(() => {
    setActiveBridgeCvcCode(readActiveBridgeContext(activeProject.id))
  }, [activeProject.id])
  const selectedNode = freeCanvas.nodes.find(node => node.id === freeCanvas.selectedNodeId) || null
  const selectedImageNode = selectedNode?.kind === 'image' ? selectedNode : null
  const quickPresets = useMemo(() => presets.filter(isQuickMessagePreset), [presets])
  const cropNode = cropNodeId
    ? freeCanvas.nodes.find((node): node is IFreeCanvasImageNode => node.id === cropNodeId && node.kind === 'image')
    : null
  const annotationEditorNode = annotationEditorNodeId
    ? freeCanvas.nodes.find((node): node is IFreeCanvasImageNode => node.id === annotationEditorNodeId && node.kind === 'image')
    : null
  const isCanvasKeyboardLocked = Boolean(annotationEditorNode || cropNode)
  const freeCanvasRef = useRef(freeCanvas)
  const onChangeRef = useRef(onChange)
  const selectedImageNodeRef = useRef<IFreeCanvasImageNode | null>(selectedImageNode)
  const copiedImageNodeRef = useRef<IFreeCanvasImageNode | null>(null)
  const canvasCommandHistoryRef = useRef(createCanvasCommandHistory())
  const documentMutationQueuesRef = useRef(new Map<string, Promise<void>>())
  const documentReconcileLocksRef = useRef(new Map<string, DocumentReconcileLease>())
  const documentReconcileLockedNodeIdsRef = useRef(new Set<string>())
  const storyboardAckRecoveriesRef = useRef(new Map<string, StoryboardAckRecoveryState>())
  const storyboardAckRecoveryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const fileDragDepthRef = useRef(0)
  const composerFileDragDepthRef = useRef(0)
  const activeProjectIdRef = useRef(activeProject.id)
  const projectEpochRef = useRef(0)
  const activeProjectScopeRef = useRef<ProjectMutationScope>({
    projectId: activeProject.id,
    epoch: projectEpochRef.current
  })
  const placementProcessingRef = useRef(false)
  const unpersistedPlacementRunIdsRef = useRef(new Set<string>())
  const activeGenerationRunIdsRef = useRef(new Set<string>())
  const scheduledGenerationRunIdsRef = useRef(new Set<string>())
  const emitGenerationCanvas = useCallback((next: IFreeCanvasProject) => {
    freeCanvasRef.current = next
    onChangeRef.current(next)
  }, [])

  useEffect(() => {
    if (!presetsInitialized) initPresets()
  }, [initPresets, presetsInitialized])

  useEffect(() => {
    let active = true
    void agentRuntimeService.bootstrap().then(() => Promise.all([
      modelManagementClient.getCatalog(),
      modelManagementClient.listConnections(),
      modelManagementClient.listAssignments(),
      modelManagementClient.getImageGenerationStatus()
    ])).then(([catalog, connections, assignments, status]) => {
      if (!active) return
      const imageModels = catalog.models.filter(model => model.modality === 'image')
      const assignment = assignments.find(item => item.slot === 'image.primary') || null
      setImageCatalogModels(imageModels)
      setImageConnections(connections)
      setImageAssignment(assignment)
      setImageRuntimeReady(status.serverEnabled && status.credentialStore.available && status.providers.some(provider => provider.status === 'ready'))
      if (assignment) {
        setImageComposerDraft(current => ({
          ...current,
          connectionId: current.connectionId || assignment.connectionId,
          modelId: current.modelId || assignment.modelId
        }))
      }
    }).catch(() => {
      if (!active) return
      setImageCatalogModels([])
      setImageConnections([])
      setImageAssignment(null)
      setImageRuntimeReady(false)
    })
    return () => { active = false }
  }, [])

  const loadImageConversations = useCallback(async (
    projectId: string,
    signal?: AbortSignal,
    cursor?: string | null
  ) => {
    const page = await storageServiceClient.imageGenerationConversations.getPage({
      projectId,
      cursor,
      limit: 20,
      signal
    })
    if (signal?.aborted || activeProjectIdRef.current !== projectId) return
    setImageConversations(current => cursor
      ? mergeById(current, page.conversations)
      : page.conversations)
    setImageConversationNextCursor(page.nextCursor)
    return page
  }, [])

  const loadImageConversationRuns = useCallback(async (
    projectId: string,
    conversationId: string,
    signal?: AbortSignal,
    cursor?: string | null
  ) => {
    const page = await storageServiceClient.imageGenerationConversations.getRuns({
      projectId,
      conversationId,
      cursor,
      limit: 25,
      signal
    })
    if (signal?.aborted || activeProjectIdRef.current !== projectId) return
    setImageConversationRuns(current => ({
      ...current,
      [conversationId]: cursor
        ? mergeById(current[conversationId] || [], page.runs)
        : page.runs
    }))
    setImageRunNextCursors(current => ({ ...current, [conversationId]: page.nextCursor }))
    return page
  }, [])

  useLayoutEffect(() => {
    if (activeProjectIdRef.current !== activeProject.id) {
      projectEpochRef.current += 1
      activeProjectScopeRef.current = {
        projectId: activeProject.id,
        epoch: projectEpochRef.current
      }
      canvasCommandHistoryRef.current = createCanvasCommandHistory()
      const activeProjectNodeIds = new Set(
        [...documentReconcileLocksRef.current.values()]
          .filter(lease => lease.projectId === activeProject.id)
          .flatMap(lease => [...lease.nodeIds])
      )
      documentReconcileLockedNodeIdsRef.current = activeProjectNodeIds
      setDocumentReconcileLockedNodeIds([...activeProjectNodeIds])
    }
    activeProjectIdRef.current = activeProject.id
    freeCanvasRef.current = freeCanvas
    onChangeRef.current = onChange
    selectedImageNodeRef.current = selectedImageNode
  }, [activeProject.id, freeCanvas, onChange, selectedImageNode])

  useEffect(() => {
    const controller = new AbortController()
    imageConversationIntentRef.current = 'auto'
    setActiveImageConversationId(null)
    setImageConversations([])
    setImageConversationNextCursor(null)
    setImageConversationRuns({})
    setImageRunNextCursors({})
    setSelectedNodeIds(
      freeCanvasRef.current.selectedNodeId ? [freeCanvasRef.current.selectedNodeId] : []
    )
    setNodeContextMenu(null)
    setActiveImageOperationDraft(null)
    setImageOperationPreparing(false)
    setOptimisticImageTurn(null)
    setImageGenerationBusy(false)
    setImageRegionEditorOpen(false)
    setImageAnnotationTarget(null)
    setImageAnnotationDocuments({})
    setImageComposerDraft(current => createEmptyConversationDraft({
      connectionId: current.connectionId,
      modelId: current.modelId,
      resolution: current.resolution,
      aspectRatio: current.aspectRatio,
      width: current.width,
      height: current.height,
      promptOptimization: current.promptOptimization,
      outputFormat: current.outputFormat,
      watermark: current.watermark
    }))
    void (async () => {
      try {
        const page = await loadImageConversations(activeProject.id, controller.signal)
        const latestConversation = page?.conversations[0]
        if (!latestConversation || controller.signal.aborted || imageConversationIntentRef.current !== 'auto') return
        await loadImageConversationRuns(activeProject.id, latestConversation.id, controller.signal)
        if (controller.signal.aborted || imageConversationIntentRef.current !== 'auto') return
        imageConversationIntentRef.current = 'active'
        setActiveImageConversationId(latestConversation.id)
      } catch {
        // Fall back to the existing empty state when history cannot be restored.
      }
    })()
    return () => controller.abort()
  }, [activeProject.id, loadImageConversationRuns, loadImageConversations])

  useEffect(() => {
    if (!imageAssignment) return
    setImageComposerDraft(current => ({
      ...current,
      connectionId: imageAssignment.connectionId,
      modelId: imageAssignment.modelId
    }))
  }, [imageAssignment])

  const cardTypes = useMemo(() => [
    { type: 'subject', label: cardTypeLabel('subject') },
    { type: 'action', label: cardTypeLabel('action') },
    { type: 'scene', label: cardTypeLabel('scene') },
    { type: 'style', label: cardTypeLabel('style') },
    { type: 'camera', label: cardTypeLabel('camera') },
    { type: 'lighting', label: cardTypeLabel('lighting') },
    { type: 'timing', label: cardTypeLabel('timing') },
    { type: 'audio', label: cardTypeLabel('audio') },
    { type: 'constraint', label: cardTypeLabel('constraint') },
    { type: 'custom', label: cardTypeLabel('custom') }
  ], [cardTypeLabel])

  const commitCanvasSelection = useCallback((
    canvas: IFreeCanvasProject,
    nodeId: string | null,
    visualNodeIds = nodeId ? [nodeId] : []
  ) => {
    const nextCanvas = { ...canvas, selectedNodeId: nodeId }
    setSelectedNodeIds(visualNodeIds)
    emitGenerationCanvas(nextCanvas)
    return nextCanvas
  }, [emitGenerationCanvas])

  const setSelectedNodeId = useCallback((nodeId: string | null) => {
    commitCanvasSelection(freeCanvasRef.current, nodeId)
  }, [commitCanvasSelection])

  const addNode = useCallback((node: IFreeCanvasNode) => {
    commitCanvasSelection({
      ...freeCanvas,
      nodes: [...freeCanvas.nodes, node]
    }, node.id)
  }, [commitCanvasSelection, freeCanvas])

  const createText = useCallback(() => {
    const node = createFreeCanvasTextNode('', nextNodePosition(reactFlow, freeCanvas.nodes.length))
    addNode(node)
    setEditingNodeId(node.id)
  }, [addNode, freeCanvas.nodes.length, reactFlow])

  const createQuickText = useCallback((preset: IPreset) => {
    const source = quickMessagePresetToCanvasSource(preset)
    const node = createQuickTextNode(source.text, nextNodePosition(reactFlow, freeCanvas.nodes.length))
    addNode({
      ...node,
      title: source.title,
      meta: { ...node.meta, quickMessagePresetId: source.presetId }
    })
    setQuickDrawerOpen(false)
  }, [addNode, freeCanvas.nodes.length, reactFlow])

  const addImageFiles = useCallback(async (files: File[], position: { x: number; y: number }) => {
    const imageFiles = files.filter(isSupportedImageFile)
    if (imageFiles.length === 0) {
      setUploadError('Only PNG, JPEG, and WebP images are supported.')
      return
    }
    try {
      setUploadError(null)
      const uploaded = await uploadFreeCanvasImageFiles(imageFiles, position)
      const imageNodes = uploaded.map(node => createFreeCanvasImageNodeFromMedia(node))
      commitCanvasSelection({
        ...freeCanvas,
        nodes: [...freeCanvas.nodes, ...imageNodes]
      }, imageNodes[0]?.id || freeCanvas.selectedNodeId || null)
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Image upload failed.')
    }
  }, [commitCanvasSelection, freeCanvas])

  const placeProjectMaterialAt = useCallback((
    resource: ProjectMaterialCanvasSource,
    position: { x: number; y: number }
  ) => {
    const size = fitImageNode(resource.width, resource.height)
    const media = {
      ...createFreeCanvasMediaNode('imageAsset', {
        x: position.x - size.width / 2,
        y: position.y - size.height / 2
      }),
      title: resource.name,
      width: size.width,
      height: size.height,
      assetId: resource.previewAssetId,
      imageUrl: canvasImageAssetUrl(resource.previewAssetId),
      meta: {
        originalWidth: resource.width,
        originalHeight: resource.height,
        projectResourceId: resource.id,
        sourceAssetId: resource.sourceAssetId
      }
    }
    const node = createFreeCanvasImageNodeFromMedia(media)
    commitCanvasSelection({
      ...freeCanvas,
      nodes: [...freeCanvas.nodes, node]
    }, node.id)
  }, [commitCanvasSelection, freeCanvas])

  const placeProjectMaterial = useCallback((resource: ProjectResource) => {
    const leftInset = resourceLibraryExpanded && window.innerWidth >= 1440 ? 280 : 44
    const rightInset = rightPanelCollapsed ? 56 : 456
    placeProjectMaterialAt(resource, reactFlow.screenToFlowPosition({
      x: leftInset + Math.max(0, window.innerWidth - leftInset - rightInset) / 2,
      y: 56 + Math.max(0, window.innerHeight - 56) / 2
    }))
  }, [placeProjectMaterialAt, reactFlow, resourceLibraryExpanded, rightPanelCollapsed])

  const addProjectSubjectToComposer = useCallback((resource: ProjectResource) => {
    const activeModel = imageCatalogModels.find(model => model.id === imageComposerDraft.modelId)
    const maxReferenceImages = activeModel?.capabilities?.maxReferenceImages ?? 10
    const result = appendSubjectReference(imageComposerDraft.inputs, resource, maxReferenceImages)
    if (!result.reason) {
      setImageComposerDraft(current => ({ ...current, inputs: result.inputs }))
      setRightPanelMode('image-generation')
      setRightPanelCollapsed(false)
    }
    return { reason: result.reason }
  }, [imageCatalogModels, imageComposerDraft.inputs, imageComposerDraft.modelId])

  const createImage = useCallback(() => {
    imageInputRef.current?.click()
  }, [])

  useEffect(() => {
    if (!clipboardNotice) return
    const timeoutId = window.setTimeout(() => setClipboardNotice(null), 1600)
    return () => window.clearTimeout(timeoutId)
  }, [clipboardNotice])

  useEffect(() => {
    const handleCopy = (event: KeyboardEvent) => {
      if (annotationEditorNodeId || cropNodeId) return
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c' || isTypingTarget(event.target)) return
      const imageNode = selectedImageNodeRef.current
      if (!imageNode || isRunningFreeCanvasImageGeneration(imageNode)) return
      event.preventDefault()
      copiedImageNodeRef.current = imageNode
      setClipboardNotice('已复制图片节点')
    }

    const handlePaste = (event: ClipboardEvent) => {
      if (annotationEditorNodeId || cropNodeId) return
      if (isTypingTarget(event.target)) return
      const files = getClipboardImageFiles(event.clipboardData)
      if (files.length > 0) {
        event.preventDefault()
        void addImageFiles(files, reactFlow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }))
        return
      }
      const copied = copiedImageNodeRef.current
      if (!copied) return
      event.preventDefault()
      const current = freeCanvasRef.current
      const duplicate = markCanvasNodeReferencePending<IFreeCanvasImageNode>({
        ...copied,
        id: `free-image-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: `${copied.title} 副本`,
        position: { x: copied.position.x + 28, y: copied.position.y + 28 },
        crop: copied.crop ? { ...copied.crop } : null,
        annotations: (copied.annotations || []).map(annotation => ({
          ...annotation,
          id: `image-annotation-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          points: annotation.points?.map(point => ({ ...point })) || undefined,
          meta: { ...annotation.meta, duplicatedFromAnnotationId: annotation.id }
        })),
        meta: { ...copied.meta, duplicatedFromNodeId: copied.id }
      })
      commitCanvasSelection({
        ...current,
        nodes: [...current.nodes, duplicate]
      }, duplicate.id)
      setClipboardNotice('已粘贴图片节点')
    }

    window.addEventListener('keydown', handleCopy)
    document.addEventListener('paste', handlePaste)
    return () => {
      window.removeEventListener('keydown', handleCopy)
      document.removeEventListener('paste', handlePaste)
    }
  }, [addImageFiles, annotationEditorNodeId, commitCanvasSelection, cropNodeId, reactFlow])

  const replaceTextRange = useCallback((nodeId: string, range: { start: number; end: number }, insertedText: string, color: string) => {
    onChange(replaceFreeCanvasTextRange(freeCanvas, nodeId, range, insertedText, color))
  }, [freeCanvas, onChange])

  const updateTextStyle = useCallback((nodeId: string, updates: Parameters<typeof updateFreeCanvasTextNodeStyle>[2]) => {
    onChange(updateFreeCanvasTextNodeStyle(freeCanvas, nodeId, updates))
  }, [freeCanvas, onChange])

  const renameTextNode = useCallback((nodeId: string, title: string): string | null => {
    try {
      onChange(renameFreeCanvasTextNode(freeCanvasRef.current, nodeId, title))
      return null
    } catch (error) {
      return error instanceof Error && error.message === 'text_node_title_duplicate'
        ? '节点名称不能重复'
        : '名称需为 1–32 个字符，且不能包含 @'
    }
  }, [onChange])

  const rememberTextSelection = useCallback((
    nodeId: string,
    selection?: Omit<CanvasAgentSelection, 'baseContentDigest'>
  ) => {
    setTextSelections(current => {
      if (!selection) {
        const next = { ...current }
        delete next[nodeId]
        return next
      }
      return { ...current, [nodeId]: selection }
    })
  }, [])

  const copyTextNode = useCallback((nodeId: string) => {
    const node = freeCanvasRef.current.nodes.find((candidate): candidate is IFreeCanvasTextNode =>
      candidate.id === nodeId && candidate.kind === 'text'
    )
    if (!node) return
    const text = freeCanvasTextSegmentsToPlainText(node.segments)
    if (!text) return
    if (!navigator.clipboard?.writeText) {
      setClipboardNotice('复制文本失败')
      return
    }
    void navigator.clipboard.writeText(text)
      .then(() => setClipboardNotice('已复制文本节点'))
      .catch(() => setClipboardNotice('复制文本失败'))
  }, [])

  const sendTextNodeToAgent = useCallback(async (
    nodeId: string,
    role: 'target' | 'reference'
  ) => {
    const node = freeCanvasRef.current.nodes.find((candidate): candidate is IFreeCanvasTextNode =>
      candidate.id === nodeId && candidate.kind === 'text'
    )
    if (!node || previewMode) return
    const storedSelection = role === 'target' ? textSelections[nodeId] : undefined
    const userText = freeCanvasUserText(node)
    const validSelection = storedSelection
      && storedSelection.start >= 0
      && storedSelection.end <= userText.length
      && userText.slice(storedSelection.start, storedSelection.end) === storedSelection.selectedText
      ? {
          ...storedSelection,
          baseContentDigest: await sha256Text(userText)
        }
      : undefined
    setRightPanelCollapsed(false)
    setRightPanelMode('agent')
    setAgentDraftRequest({
      id: `canvas-agent-node-${node.id}-${role}-${Date.now()}`,
      canvasNode: {
        nodeId: node.id,
        role,
        ...(role === 'target' ? { mode: 'complete' as const } : {}),
        ...(validSelection ? { selection: validSelection } : {})
      }
    })
  }, [previewMode, textSelections])

  const resizeImageNode = useCallback((nodeId: string, frame: { position?: { x: number; y: number }; width: number; height: number }) => {
    emitGenerationCanvas(updateFreeCanvasImageNodeFrame(freeCanvasRef.current, nodeId, frame))
  }, [emitGenerationCanvas])

  const saveImageAnnotations = useCallback((nodeId: string, annotations: IFreeCanvasImageAnnotation[]) => {
    onChange(replaceFreeCanvasImageAnnotations(freeCanvas, nodeId, annotations))
    setAnnotationEditorNodeId(null)
  }, [freeCanvas, onChange])

  const readyImageBindings = imageConnections.flatMap(connection => {
    if (!connection.enabled || !connection.credentialConfigured || !connection.lastTest?.ok) return []
    return imageCatalogModels
      .filter(model => model.providerId === connection.providerId)
      .map(model => ({ connection, model }))
  })
  const selectedImageConnection = imageConnections.find(
    connection => connection.id === imageComposerDraft.connectionId
  ) || null
  const selectedImageModel = imageCatalogModels.find(
    model => model.id === imageComposerDraft.modelId
      && model.providerId === selectedImageConnection?.providerId
  ) || null
  const maxComposerImages = selectedImageModel?.capabilities?.maxReferenceImages ?? 10
  const imageModelUsable = Boolean(
    selectedImageConnection?.enabled
    && selectedImageConnection.credentialConfigured
    && selectedImageConnection.lastTest?.ok
    && selectedImageModel
    && imageRuntimeReady
  )
  const imageConversationViews = useMemo<ImageGenerationConversationView[]>(() => imageConversations.map(conversation => ({
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    turns: (imageConversationRuns[conversation.id] || []).map(run => projectRunToTurn(
      run,
      modelId => imageCatalogModels.find(model => model.id === modelId)?.displayName || modelId
    ))
  })), [imageCatalogModels, imageConversationRuns, imageConversations])
  const currentImageTurns = useMemo(() => {
    const stored = activeImageConversationId
      ? (imageConversationRuns[activeImageConversationId] || []).map(run => projectRunToTurn(
          run,
          modelId => imageCatalogModels.find(model => model.id === modelId)?.displayName || modelId
        ))
      : []
    return optimisticImageTurn ? [...stored.filter(turn => turn.id !== optimisticImageTurn.id), optimisticImageTurn] : stored
  }, [activeImageConversationId, imageCatalogModels, imageConversationRuns, optimisticImageTurn])

  const resetImageConversation = useCallback(() => {
    imageConversationIntentRef.current = 'new'
    setActiveImageConversationId(null)
    setOptimisticImageTurn(null)
    setImageRegionEditorOpen(false)
    setImageAnnotationTarget(null)
    setImageAnnotationDocuments({})
    setImageComposerDraft(current => createEmptyConversationDraft({
      connectionId: imageAssignment?.connectionId || current.connectionId,
      modelId: imageAssignment?.modelId || current.modelId,
      resolution: current.resolution,
      aspectRatio: current.aspectRatio,
      width: current.width,
      height: current.height,
      promptOptimization: current.promptOptimization,
      outputFormat: current.outputFormat,
      watermark: current.watermark
    }))
  }, [imageAssignment?.connectionId, imageAssignment?.modelId])

  const openImageGeneration = useCallback(() => {
    setRightPanelMode('image-generation')
    setRightPanelCollapsed(false)
  }, [])

  const continueImageConversation = useCallback((conversationId: string) => {
    imageConversationIntentRef.current = 'active'
    setActiveImageConversationId(conversationId)
    setOptimisticImageTurn(null)
    setImageComposerDraft(current => createEmptyConversationDraft({
      connectionId: imageAssignment?.connectionId || current.connectionId,
      modelId: imageAssignment?.modelId || current.modelId,
      resolution: current.resolution,
      aspectRatio: current.aspectRatio,
      width: current.width,
      height: current.height,
      promptOptimization: current.promptOptimization,
      outputFormat: current.outputFormat,
      watermark: current.watermark
    }))
    if (!imageConversationRuns[conversationId]) {
      void loadImageConversationRuns(activeProject.id, conversationId).catch(() => undefined)
    }
  }, [activeProject.id, imageAssignment?.connectionId, imageAssignment?.modelId, imageConversationRuns, loadImageConversationRuns])

  const continueLegacyImageCreation = useCallback((nodeId: string) => {
    const current = freeCanvasRef.current
    const node = current.nodes.find((candidate): candidate is IFreeCanvasImageGeneratorNode => candidate.id === nodeId && candidate.kind === 'image-generator')
    if (!node) return
    const snapshot = compileImageGeneratorPrompt(current, node.id)
    resetImageConversation()
    setImageComposerDraft(draft => ({
      ...draft,
      promptDocument: {
        version: 1,
        segments: snapshot.promptDocument.segments.map(segment => segment.type === 'text'
          ? { type: 'text', text: segment.text }
          : { type: 'reference', referenceId: segment.referenceId, label: segment.label })
      },
      workflow: node.primaryAssetId ? 'smart-edit' : snapshot.inputAssets.length > 0 ? 'reference-generate' : 'text-to-image',
      inputs: node.primaryAssetId
        ? [{
            referenceId: `legacy-result-${node.id}`,
            assetId: node.primaryAssetId,
            order: 0,
            role: 'source-image',
            label: node.title
          }]
        : snapshot.inputAssets.map((input, index) => ({ ...input, order: index }))
    }))
    setRightPanelMode('image-generation')
    setRightPanelCollapsed(false)
  }, [resetImageConversation])

  const injectSelectedCanvasNodes = useCallback(() => {
    const ids = selectedNodeIds.length > 0
      ? selectedNodeIds
      : freeCanvasRef.current.selectedNodeId ? [freeCanvasRef.current.selectedNodeId] : []
    const nodesToInject = ids.flatMap(id => {
      const node = freeCanvasRef.current.nodes.find(candidate => candidate.id === id)
      return node ? [node] : []
    })
    const result = injectCanvasNodesIntoDraft(imageComposerDraft, nodesToInject)
    setImageComposerDraft(result.draft)
    setUploadError(result.rejected.length > 0 ? result.rejected.map(item => item.reason).join(' ') : null)
  }, [imageComposerDraft, selectedNodeIds])

  const uploadImageComposerReference = useCallback(async (file: File) => {
    if (imageComposerDraft.inputs.length >= maxComposerImages) {
      setUploadError(`已达到当前模型的 ${maxComposerImages} 张参考图上限。`)
      return
    }
    if (file.size > 30 * 1024 * 1024) {
      setUploadError('参考图不能超过 30 MB。')
      return
    }
    try {
      const imported = await storageServiceClient.imageAssets.import(file)
      setImageComposerDraft(current => {
        if (current.inputs.length >= maxComposerImages) return current
        const input: ProjectImageGenerationInput = {
          referenceId: `upload-${imported.originalAsset.id}`,
          assetId: imported.providerInputAsset.id,
          sourceAssetId: imported.originalAsset.id,
          order: current.inputs.length,
          role: 'reference-image',
          label: file.name
        }
        return {
          ...current,
          workflow: current.workflow === 'text-to-image' ? 'reference-generate' : current.workflow,
          inputs: [...current.inputs, input]
        }
      })
      setUploadError(null)
    } catch {
      setUploadError('参考图上传失败，请检查本地存储服务。')
    }
  }, [imageComposerDraft.inputs.length, maxComposerImages])

  const uploadImageComposerReferences = useCallback(async (files: File[]) => {
    const imageFiles = files.filter(isComposerReferenceImage)
    if (imageFiles.length === 0) {
      setUploadError('仅支持拖入图片作为本轮参考图。')
      return
    }
    const available = Math.max(0, maxComposerImages - imageComposerDraft.inputs.length)
    if (available === 0) {
      setUploadError(`已达到当前模型的 ${maxComposerImages} 张参考图上限。`)
      return
    }
    for (const file of imageFiles.slice(0, available)) {
      await uploadImageComposerReference(file)
    }
    if (imageFiles.length > available) {
      setUploadError(`已加入 ${available} 张图片，其余图片超过当前模型的参考图上限。`)
    }
  }, [imageComposerDraft.inputs.length, maxComposerImages, uploadImageComposerReference])

  const clearComposerFileDragState = () => {
    composerFileDragDepthRef.current = 0
    setComposerFileDragActive(false)
  }

  const handleComposerDragEnter = (event: ReactDragEvent<Element>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    composerFileDragDepthRef.current += 1
    setComposerFileDragActive(true)
  }

  const handleComposerDragOver = (event: ReactDragEvent<Element>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleComposerDragLeave = (event: ReactDragEvent<Element>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.stopPropagation()
    composerFileDragDepthRef.current = Math.max(0, composerFileDragDepthRef.current - 1)
    if (composerFileDragDepthRef.current === 0) setComposerFileDragActive(false)
  }

  const handleComposerDrop = (event: ReactDragEvent<Element>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    clearComposerFileDragState()
    setRightPanelMode('image-generation')
    void uploadImageComposerReferences(Array.from(event.dataTransfer.files))
  }

  const processPendingImagePlacements = useCallback(async (projectId: string) => {
    if (placementProcessingRef.current) return
    placementProcessingRef.current = true
    try {
      const placements = await storageServiceClient.imageGenerationPlacements.getPending(projectId)
      if (activeProjectIdRef.current !== projectId || placements.length === 0) return
      let current = freeCanvasRef.current
      const persisted: Array<{ runId: string; nodeId: string }> = []
      const awaitingPersistence: Array<{ runId: string; nodeId: string }> = []
      const leftInset = resourceLibraryExpanded && window.innerWidth >= 1440 ? 292 : 0
      const rightInset = rightPanelCollapsed ? 56 : 456
      const base = reactFlow.screenToFlowPosition({
        x: Math.max(180, leftInset + (window.innerWidth - leftInset - rightInset) / 2),
        y: window.innerHeight / 2
      })
      const additions: IFreeCanvasImageNode[] = []
      placements.forEach((placement, index) => {
        const existing = current.nodes.find((node): node is IFreeCanvasImageNode => (
          node.kind === 'image' && node.meta?.generationRunId === placement.runId
        ))
        if (existing) {
          const target = { runId: placement.runId, nodeId: existing.id }
          const alreadyHydrated = existing.assetId === placement.assetId
            && existing.meta?.generationState === 'succeeded'
          if (!alreadyHydrated) {
            current = completeFreeCanvasImageGeneration(
              current,
              placement.runId,
              placement.assetId,
              canvasImageAssetUrl(placement.assetId)
            )
            unpersistedPlacementRunIdsRef.current.add(placement.runId)
          }
          if (unpersistedPlacementRunIdsRef.current.has(placement.runId)) awaitingPersistence.push(target)
          else persisted.push(target)
          return
        }
        const node = createFreeCanvasImageNodeFromMedia({
          id: `generation-${placement.runId}`,
          kind: 'imageAsset',
          title: '生成图片',
          position: { x: base.x + index * 28, y: base.y + index * 28 },
          width: 320,
          height: 320,
          assetId: placement.assetId,
          imageUrl: canvasImageAssetUrl(placement.assetId),
          imagePrompt: '',
          sourceNodeId: null,
          generatedFromAgent: false,
          crop: null,
          text: '',
          color: '#111827',
          meta: {
            generatedResult: true,
            generationRunId: placement.runId,
            conversationId: placement.conversationId,
            generationState: 'succeeded',
            source: 'image-generation-conversation'
          }
        })
        additions.push(node)
        awaitingPersistence.push({ runId: placement.runId, nodeId: node.id })
        unpersistedPlacementRunIdsRef.current.add(placement.runId)
      })
      if (additions.length > 0) current = { ...current, nodes: [...current.nodes, ...additions] }
      if (additions.length > 0 || awaitingPersistence.length > 0) {
        emitGenerationCanvas(current)
      }
      if (awaitingPersistence.length > 0) {
        const saved = await onPersistCanvas?.(current)
        if (saved && activeProjectIdRef.current === projectId) {
          awaitingPersistence.forEach(item => unpersistedPlacementRunIdsRef.current.delete(item.runId))
          persisted.push(...awaitingPersistence)
        }
      }
      for (const item of persisted) {
        await storageServiceClient.imageGenerationPlacements.markPlaced(item.runId, item.nodeId)
      }
    } finally {
      placementProcessingRef.current = false
    }
  }, [emitGenerationCanvas, onPersistCanvas, reactFlow, resourceLibraryExpanded, rightPanelCollapsed])

  useEffect(() => {
    void processPendingImagePlacements(activeProject.id).catch(() => undefined)
  }, [activeProject.id, processPendingImagePlacements])

  useEffect(() => {
    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const reconcile = async () => {
      const projectId = activeProject.id
      const runningNodes = freeCanvasRef.current.nodes.filter(node => {
        if (!isRunningFreeCanvasImageGeneration(node)) return false
        const runId = String(node.meta?.generationRunId || '')
        return !scheduledGenerationRunIdsRef.current.has(runId)
          && !activeGenerationRunIdsRef.current.has(runId)
      })
      if (runningNodes.length === 0) return
      const runs = await Promise.all(runningNodes.map(async node => {
        const runId = String(node.meta?.generationRunId || '')
        try {
          const run = runId ? await storageServiceClient.imageGenerationRuns.getById(runId, projectId) : null
          return { runId, run, lookupFailed: false }
        } catch {
          return { runId, run: null, lookupFailed: true }
        }
      }))
      if (cancelled || activeProjectIdRef.current !== projectId) return

      let current = freeCanvasRef.current
      let changed = false
      runs.forEach(({ runId, run, lookupFailed }) => {
        if (lookupFailed) return
        if (!run) {
          current = failFreeCanvasImageGeneration(current, runId, 'generation_run_missing')
          changed = true
          return
        }
        if (run.state === 'failed') {
          current = failFreeCanvasImageGeneration(current, runId, safeGenerationErrorCode(run.error?.code))
          changed = true
          return
        }
        if (run.state === 'succeeded') {
          const assetId = run.outputAssetIds[0]
          if (!assetId) {
            current = failFreeCanvasImageGeneration(current, runId, 'generation_output_missing')
          } else {
            current = completeFreeCanvasImageGeneration(current, runId, assetId, canvasImageAssetUrl(assetId))
            unpersistedPlacementRunIdsRef.current.add(runId)
          }
          changed = true
        }
      })
      if (changed) {
        emitGenerationCanvas(current)
        await onPersistCanvas?.(current)
      }
      await processPendingImagePlacements(projectId).catch(() => undefined)
      if (cancelled || activeProjectIdRef.current !== projectId) return
      const stillRunning = freeCanvasRef.current.nodes.some(isRunningFreeCanvasImageGeneration)
      if (stillRunning) timeoutId = setTimeout(() => { void reconcile().catch(() => undefined) }, 1500)
    }
    void reconcile().catch(() => undefined)
    return () => {
      cancelled = true
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [activeProject.id, emitGenerationCanvas, onPersistCanvas, processPendingImagePlacements])

  const prepareAnnotatedComposerDraft = useCallback(async (
    draft: ImageGenerationComposerDraft
  ): Promise<ImageGenerationComposerDraft> => {
    const inputs: ProjectImageGenerationInput[] = []
    for (const input of draft.inputs) {
      const document = imageAnnotationDocuments[input.referenceId]
      if (!document || document.annotations.length === 0) {
        inputs.push({ ...input })
        continue
      }
      const image = await loadImageElement(canvasImageAssetUrl(input.assetId))
      const flattened = await rasterizeAnnotationDocument(image, document)
      const imported = await storageServiceClient.imageAssets.import(new File(
        [flattened],
        `annotation-${input.referenceId}.png`,
        { type: 'image/png' }
      ))
      const sourceAssetId = input.sourceAssetId || input.assetId
      await storageServiceClient.imageAssets.createDerivation({
        sourceAssetId,
        derivedAssetId: imported.providerInputAsset.id,
        kind: 'annotation-flattened',
        transform: { format: 'png', referenceId: input.referenceId },
        annotationDocument: document as unknown as Record<string, unknown>
      })
      inputs.push({
        ...input,
        sourceAssetId,
        assetId: imported.providerInputAsset.id
      })
    }
    return {
      ...draft,
      promptDocument: {
        version: 1,
        segments: draft.promptDocument.segments.map(segment => segment.type === 'text'
          ? { type: 'text', text: segment.text }
          : { type: 'reference', referenceId: segment.referenceId, label: segment.label })
      },
      inputs,
      regions: draft.regions.map(region => ({ ...region }))
    }
  }, [imageAnnotationDocuments])

  const executeImageDraft = useCallback(async (
    snapshot: ImageGenerationComposerDraft,
    identity: {
      conversationId?: string
      nodeId?: string
      activateConversation: boolean
      runId?: string
      placeholderPrepared?: boolean
      preparedRequest?: ImageGenerationRequest
      resumePrepared?: boolean
    }
  ): Promise<boolean> => {
    if (
      (identity.activateConversation && imageGenerationBusy)
      || !imageGenerationNodeV1
      || (!identity.resumePrepared && !imageModelUsable)
    ) return false
    const runId = identity.runId || createImageGenerationRunId()
    if (activeGenerationRunIdsRef.current.has(runId)) return false
    activeGenerationRunIdsRef.current.add(runId)
    const frame = imageGenerationPlaceholderFrame(snapshot)
    const current = freeCanvasRef.current
    const sourceNodeId = snapshot.operation?.source.nodeId
    const sourceNode = sourceNodeId
      ? current.nodes.find(node => node.id === sourceNodeId)
      : null
    const position = sourceNode
      ? { x: sourceNode.position.x + sourceNode.width + 48, y: sourceNode.position.y }
      : nextNodePosition(reactFlow, current.nodes.length)
    let canvasWithPlaceholder = current
    if (!identity.placeholderPrepared) {
      const placeholder = createOperationPlaceholder({
        snapshot,
        runId,
        conversationId: identity.conversationId || `image-operation-${runId}`,
        position,
        frame
      })
      canvasWithPlaceholder = {
        ...current,
        nodes: [...current.nodes, placeholder]
      }
      canvasWithPlaceholder = commitCanvasSelection(canvasWithPlaceholder, placeholder.id)
    }
    if (identity.activateConversation && identity.conversationId) {
      imageConversationIntentRef.current = 'active'
      setActiveImageConversationId(identity.conversationId)
    }
    if (identity.activateConversation) setImageGenerationBusy(true)
    if (identity.activateConversation) {
      setOptimisticImageTurn({
        id: runId,
        createdAt: Date.now(),
        prompt: promptDocumentPlainText(snapshot.promptDocument),
        state: 'running',
        settings: {
          workflow: snapshot.workflow,
          modelLabel: selectedImageModel?.displayName || snapshot.modelId,
          resolution: snapshot.resolution,
          aspectRatio: snapshot.aspectRatio,
          outputFormat: snapshot.outputFormat,
          watermark: snapshot.watermark
        }
      })
    }
    let placeholderSaved = identity.placeholderPrepared
    if (!identity.placeholderPrepared) {
      try {
        placeholderSaved = Boolean(await onPersistCanvas?.(canvasWithPlaceholder))
      } catch {
        placeholderSaved = false
      }
    }
    if (!placeholderSaved) {
      activeGenerationRunIdsRef.current.delete(runId)
      const failedCanvas = failFreeCanvasImageGeneration(freeCanvasRef.current, runId, 'storage_write_failed')
      emitGenerationCanvas(failedCanvas)
      const presentation = getRuntimeErrorPresentation('storage_write_failed')
      setOptimisticImageTurn(currentTurn => currentTurn?.id === runId ? {
        ...currentTurn,
        state: 'failed',
        error: { message: presentation.message, action: presentation.action }
      } : currentTurn)
      if (identity.activateConversation) setImageGenerationBusy(false)
      return false
    }
    if (identity.activateConversation) {
      setImageComposerDraft(createEmptyConversationDraft({
        connectionId: snapshot.connectionId,
        modelId: snapshot.modelId,
        resolution: snapshot.resolution,
        aspectRatio: snapshot.aspectRatio,
        width: snapshot.width,
        height: snapshot.height,
        promptOptimization: snapshot.promptOptimization,
        outputFormat: snapshot.outputFormat,
        watermark: snapshot.watermark
      }))
      setImageAnnotationDocuments({})
    }
    try {
      const request = identity.preparedRequest || buildConversationGenerationRequest(
        activeProject.id,
        identity.conversationId || 'image-operation',
        snapshot
      )
      if (!identity.preparedRequest && !identity.conversationId) {
        delete request.conversationId
        request.nodeId = identity.nodeId || snapshot.operation?.source.nodeId
      }
      const result = await requestImageGeneration({ ...request, runId })
      if (activeProjectIdRef.current === activeProject.id) {
        const completedCanvas = completeFreeCanvasImageGeneration(
          freeCanvasRef.current,
          runId,
          result.assetId,
          canvasImageAssetUrl(result.assetId)
        )
        unpersistedPlacementRunIdsRef.current.add(runId)
        emitGenerationCanvas(completedCanvas)
        const completedSaved = await onPersistCanvas?.(completedCanvas)
        if (completedSaved) unpersistedPlacementRunIdsRef.current.delete(runId)
        if (identity.activateConversation && identity.conversationId) {
          await loadImageConversations(activeProject.id)
          await loadImageConversationRuns(activeProject.id, identity.conversationId)
          setOptimisticImageTurn(null)
        }
        await processPendingImagePlacements(activeProject.id)
      }
      return true
    } catch (error) {
      if (activeProjectIdRef.current === activeProject.id) {
        const clientError = error instanceof ImageGenerationClientError ? error : null
        if (identity.resumePrepared && clientError?.code === 'run_already_started') return false
        const errorCode = safeGenerationErrorCode(clientError?.code)
        const failedCanvas = failFreeCanvasImageGeneration(freeCanvasRef.current, runId, errorCode)
        emitGenerationCanvas(failedCanvas)
        await onPersistCanvas?.(failedCanvas).catch(() => false)
        if (identity.activateConversation) {
          setOptimisticImageTurn(currentTurn => currentTurn?.id === runId ? {
            ...currentTurn,
            state: 'failed',
            error: { message: clientError?.message || '图片生成失败，请稍后重试。', action: clientError?.action }
          } : currentTurn)
          if (identity.conversationId) {
            await Promise.all([
              loadImageConversations(activeProject.id),
              loadImageConversationRuns(activeProject.id, identity.conversationId)
            ]).catch(() => undefined)
          }
        }
      }
      return false
    } finally {
      activeGenerationRunIdsRef.current.delete(runId)
      if (identity.activateConversation && activeProjectIdRef.current === activeProject.id) {
        setImageGenerationBusy(false)
      }
    }
  }, [activeProject.id, commitCanvasSelection, emitGenerationCanvas, imageGenerationBusy, imageGenerationNodeV1, imageModelUsable, loadImageConversationRuns, loadImageConversations, onPersistCanvas, processPendingImagePlacements, reactFlow, selectedImageModel?.displayName])

  useEffect(() => {
    const projectId = activeProject.id
    const recover = async () => {
      const placeholders = freeCanvasRef.current.nodes.filter(isRunningFreeCanvasImageGeneration)
      const runs = await Promise.all(placeholders.map(node => {
        const runId = String(node.meta?.generationRunId || '')
        return runId
          ? storageServiceClient.imageGenerationRuns.getById(runId, projectId).catch(() => null)
          : Promise.resolve(null)
      }))
      if (activeProjectIdRef.current !== projectId) return
      const recoverable = runs.flatMap(run => {
        if (!run || scheduledGenerationRunIdsRef.current.has(run.id) || activeGenerationRunIdsRef.current.has(run.id)) return []
        const request = rebuildPreparedImageGenerationRequest(run)
        return request ? [{ request, snapshot: imageGenerationRequestToDraft(request) }] : []
      })
      recoverable.forEach(member => scheduledGenerationRunIdsRef.current.add(member.request.runId!))
      void scheduleMultiViewMembers(
        recoverable,
        member => {
          const runId = member.request.runId!
          scheduledGenerationRunIdsRef.current.delete(runId)
          if (activeProjectIdRef.current !== projectId) return Promise.resolve(false)
          return executeImageDraft(member.snapshot, {
            nodeId: member.request.nodeId,
            activateConversation: false,
            runId,
            placeholderPrepared: true,
            preparedRequest: member.request,
            resumePrepared: true
          })
        },
        1
      ).finally(() => {
        recoverable.forEach(member => scheduledGenerationRunIdsRef.current.delete(member.request.runId!))
      })
    }
    void recover().catch(() => undefined)
  }, [activeProject.id, executeImageDraft])

  const submitImageConversationTurn = useCallback(async () => {
    if (imageGenerationBusy || !imageGenerationNodeV1 || !imageModelUsable) return
    const conversationId = activeImageConversationId || createLocalId('image-conversation')
    let snapshot: ImageGenerationComposerDraft
    try {
      snapshot = await prepareAnnotatedComposerDraft(imageComposerDraft)
    } catch {
      setUploadError('视觉标记栅格化或派生资产保存失败，请检查本地存储。')
      return
    }
    await executeImageDraft(snapshot, { conversationId, activateConversation: true })
  }, [activeImageConversationId, executeImageDraft, imageComposerDraft, imageGenerationBusy, imageGenerationNodeV1, imageModelUsable, prepareAnnotatedComposerDraft])

  const imageComposerMissingRequirements = useMemo(() => {
    const missing: string[] = []
    if (!imageGenerationNodeV1) missing.push('图片生成功能当前未开启。')
    if (previewMode) missing.push('预览模式不能发起图片生成。')
    if (!imageRuntimeReady) missing.push('图片生成 Runtime 或 Ark SDK 尚未就绪。')
    if (!imageAssignment) missing.push('尚未配置默认图片模型。')
    if (imageComposerDraft.connectionId && !selectedImageConnection?.enabled) missing.push('所选图片连接已停用。')
    if (selectedImageConnection && !selectedImageConnection.credentialConfigured) missing.push('所选图片连接尚未配置凭据。')
    if (selectedImageConnection && !selectedImageConnection.lastTest?.ok) missing.push('所选图片连接尚未测试成功。')
    if (!promptDocumentPlainText(compileConversationPromptDocument(imageComposerDraft)).trim()) {
      missing.push('请输入本轮图片描述。')
    }
    if (unresolvedPromptReferenceIds(imageComposerDraft.promptDocument, imageComposerDraft.inputs).length > 0) {
      missing.push('提示词包含已经失效的参考图引用。')
    }
    if (imageComposerDraft.inputs.length > 10) missing.push('图片输入不能超过 10 张。')
    if (imageComposerDraft.aspectRatio === 'custom') {
      validateComposerCustomSize(imageComposerDraft.width, imageComposerDraft.height).forEach(error => {
        if (error === 'custom_size_required') missing.push('自定义尺寸需要填写有效的宽度和高度。')
        if (error === 'custom_size_pixel_budget') missing.push('自定义尺寸总像素必须在 921600–4624220 之间。')
        if (error === 'custom_size_aspect_ratio') missing.push('自定义尺寸比例必须在 1:16–16:1 之间。')
      })
    }
    if (imageComposerDraft.workflow === 'reference-generate' && imageComposerDraft.inputs.length === 0) {
      missing.push('参考图生成至少需要一张参考图。')
    }
    if ((imageComposerDraft.workflow === 'smart-edit' || imageComposerDraft.workflow === 'region-edit')
      && !imageComposerDraft.inputs.some(input => input.role === 'source-image')) {
      missing.push('该工作流需要一张主图。')
    }
    if (imageComposerDraft.workflow === 'region-edit' && imageComposerDraft.regions.length === 0) {
      missing.push('局部修改需要先添加点选或框选区域。')
    }
    return missing
  }, [imageAssignment, imageComposerDraft, imageGenerationNodeV1, imageRuntimeReady, previewMode, selectedImageConnection])
  const imageComposerVisibleRequirements = useMemo(() => imageComposerMissingRequirements.filter(requirement => ![
    '图片生成 Runtime 或 Ark SDK 尚未就绪。',
    '尚未配置默认图片模型。',
    '所选图片连接已停用。',
    '所选图片连接尚未配置凭据。',
    '所选图片连接尚未测试成功。',
    '请输入本轮图片描述。'
  ].includes(requirement)), [imageComposerMissingRequirements])

  const selectedComposerNodes = selectedNodeIds.length > 0
    ? selectedNodeIds
    : freeCanvas.selectedNodeId ? [freeCanvas.selectedNodeId] : []
  const selectedComposerDescriptor = selectedComposerNodes.length > 0
    ? { id: '__current-selection__', label: `加入所选节点（${selectedComposerNodes.length}）` }
    : undefined
  const openImageAnnotationEditor = useCallback(async (referenceId?: string) => {
    const input = (referenceId
      ? imageComposerDraft.inputs.find(candidate => candidate.referenceId === referenceId)
      : undefined)
      || imageComposerDraft.inputs.find(candidate => candidate.role === 'source-image')
      || imageComposerDraft.inputs[0]
    if (!input) {
      setUploadError('请先添加一张需要视觉标记的图片。')
      return
    }
    try {
      const image = await loadImageElement(canvasImageAssetUrl(input.assetId))
      setImageAnnotationTarget({
        referenceId: input.referenceId,
        width: image.naturalWidth,
        height: image.naturalHeight
      })
    } catch {
      setUploadError('无法读取标记图片，请检查本地资产。')
    }
  }, [imageComposerDraft.inputs])
  const imageAnnotationInput = imageAnnotationTarget
    ? imageComposerDraft.inputs.find(input => input.referenceId === imageAnnotationTarget.referenceId) || null
    : null
  const activeConversationLabel = activeImageConversationId
    ? imageConversations.find(item => item.id === activeImageConversationId)?.title || '当前会话'
    : '新对话'
  const restoreImageTurnToComposer = useCallback((turn: ImageGenerationTurn) => {
    const run = Object.values(imageConversationRuns).flat().find(candidate => candidate.id === turn.id)
    if (!run) return
    const snapshot = run.requestSnapshot
    const restoredRegions: ImageGenerationComposerDraft['regions'] = []
    snapshot.regions.forEach(region => {
      if (region.type === 'point' && typeof region.referenceId === 'string' && typeof region.x === 'number' && typeof region.y === 'number') {
        restoredRegions.push({ type: 'point', referenceId: region.referenceId, x: region.x, y: region.y })
      } else if (region.type === 'bbox'
        && typeof region.referenceId === 'string'
        && typeof region.x1 === 'number' && typeof region.y1 === 'number'
        && typeof region.x2 === 'number' && typeof region.y2 === 'number') {
        restoredRegions.push({ type: 'bbox', referenceId: region.referenceId, x1: region.x1, y1: region.y1, x2: region.x2, y2: region.y2 })
      }
    })
    const workflow: ProjectImageGenerationWorkflow = snapshot.mode === 'edit'
      ? 'smart-edit'
      : snapshot.mode === 'region-edit'
        ? 'region-edit'
        : snapshot.inputAssets.length > 0 ? 'reference-generate' : 'text-to-image'
    setImageComposerDraft(current => ({
      ...current,
      promptDocument: {
        version: 1 as const,
        segments: snapshot.promptDocument.segments.map(segment => segment.type === 'text'
          ? { type: 'text' as const, text: segment.text }
          : {
              type: 'reference' as const,
              referenceId: segment.referenceId,
              label: segment.label
            })
      },
      workflow,
      connectionId: run.connectionId,
      modelId: run.modelId,
      resolution: snapshot.resolution,
      aspectRatio: snapshot.aspectRatio || current.aspectRatio,
      width: snapshot.width,
      height: snapshot.height,
      promptOptimization: snapshot.promptOptimization,
      outputFormat: snapshot.outputFormat === 'jpeg' ? 'jpeg' : 'png',
      watermark: snapshot.watermark,
      inputs: snapshot.inputAssets.map((input, index) => ({
        ...input,
        order: index,
        role: (workflow === 'smart-edit' || workflow === 'region-edit') && index === 0
          ? 'source-image'
          : input.role
      })),
      regions: restoredRegions
    }))
    setRightPanelMode('image-generation')
    setRightPanelCollapsed(false)
  }, [imageConversationRuns])

  const handleImageTurnAction = useCallback((turn: ImageGenerationTurn, action: ImageGenerationTurnAction) => {
    if (action === 'view' && turn.result) {
      window.open(turn.result.imageUrl, '_blank', 'noopener,noreferrer')
      return
    }
    if (action === 'media') {
      onOpenMedia?.()
      return
    }
    if (action === 'place' && turn.result) {
      const current = freeCanvasRef.current
      const existing = current.nodes.find(node => node.meta?.generationRunId === turn.id)
      if (existing) {
        commitCanvasSelection(current, existing.id)
        return
      }
      const sourceRun = Object.values(imageConversationRuns).flat().find(run => run.id === turn.id)
      const image = createFreeCanvasImageNodeFromMedia({
        id: `generation-${turn.id}`,
        kind: 'imageAsset',
        title: '生成图片',
        position: nextNodePosition(reactFlow, current.nodes.length),
        width: 320,
        height: 320,
        assetId: turn.result.assetId,
        imageUrl: turn.result.imageUrl,
        imagePrompt: turn.prompt,
        sourceNodeId: null,
        generatedFromAgent: false,
        crop: null,
        text: '',
        color: '#111827',
        meta: {
          generatedResult: true,
          generationRunId: turn.id,
          ...(sourceRun?.conversationId ? { conversationId: sourceRun.conversationId } : {}),
          source: 'image-generation-conversation'
        }
      })
      commitCanvasSelection({ ...current, nodes: [...current.nodes, image] }, image.id)
      return
    }
    restoreImageTurnToComposer(turn)
    if ((action === 'edit' || action === 'region-edit' || action === 'reference') && turn.result) {
      setImageComposerDraft(current => ({
        ...current,
        workflow: action === 'edit'
          ? 'smart-edit'
          : action === 'region-edit' ? 'region-edit' : 'reference-generate',
        inputs: [{
          referenceId: `result-${turn.id}`,
          assetId: turn.result!.assetId,
          order: 0,
          role: action === 'reference' ? 'reference-image' : 'source-image',
          label: '上次生成结果'
        }]
      }))
    }
  }, [commitCanvasSelection, imageConversationRuns, onOpenMedia, reactFlow, restoreImageTurnToComposer])

  const openImageOperationWorkbench = useCallback(async (
    node: IFreeCanvasImageNode,
    operation: ImageProductOperation,
    options?: {
      retryNodeId?: string
      operationGroupId?: string
      operationItemId?: string
      viewSpec?: string
    }
  ) => {
    if (!node.assetId || !selectedImageModel || !selectedImageConnection) return
    setImageOperationPreparing(true)
    setUploadError(null)
    try {
      const source = await resolveCanvasImageInput(node, {
        renderVisible: async target => {
          const image = await loadImageElement(canvasImageAssetUrl(target.assetId!))
          return renderVisibleImage(image, target)
        },
        persistProviderInput: async (blob, context) => {
          const imported = await storageServiceClient.imageAssets.import(new File(
            [blob],
            context.filename,
            { type: 'image/png' }
          ))
          await storageServiceClient.imageAssets.createDerivation({
            sourceAssetId: context.sourceAssetId,
            derivedAssetId: imported.providerInputAsset.id,
            kind: context.derivationKind,
            transform: context.transform
          })
          return {
            providerAssetId: imported.providerInputAsset.id,
            previewUrl: canvasImageAssetUrl(imported.providerInputAsset.id)
          }
        },
        assetUrl: canvasImageAssetUrl
      })
      const resolutions = selectedImageModel.capabilities?.resolutions || ['2K']
      const aspectRatios = selectedImageModel.capabilities?.aspectRatios || ['1:1']
      setActiveImageOperationDraft({
        operation,
        source,
        prompt: operation === 'upscale' ? '增强细节并尽量保持主体、构图与材质。' : '',
        presetId: defaultImageOperationPreset(operation),
        preservationIntents: defaultImageOperationPreservation(operation),
        references: [],
        resolution: resolutions.some(value => value === imageComposerDraft.resolution)
          ? imageComposerDraft.resolution
          : resolutions[0] || '2K',
        aspectRatio: aspectRatios.includes(imageComposerDraft.aspectRatio)
          ? imageComposerDraft.aspectRatio
          : aspectRatios.find(value => value !== 'custom') || '1:1',
        ...(options?.operationGroupId ? { operationGroupId: options.operationGroupId } : {}),
        ...(options?.operationItemId ? { operationItemId: options.operationItemId } : {}),
        ...(options?.viewSpec ? { viewSpec: options.viewSpec } : {}),
        ...(options?.retryNodeId ? { retryNodeId: options.retryNodeId } : {})
      })
    } catch {
      setUploadError('无法准备当前画布图片的模型输入，请检查本地资产和存储服务。')
    } finally {
      setImageOperationPreparing(false)
    }
  }, [imageComposerDraft.aspectRatio, imageComposerDraft.resolution, selectedImageConnection, selectedImageModel])

  const resolveCommandsForImageNode = useCallback((
    node: IFreeCanvasImageNode,
    selectionCount: number
  ): ResolvedImageNodeCommand[] => {
    const generationState = node.meta.generationState === 'running'
      ? 'running'
      : node.meta.generationState === 'failed' ? 'failed' : 'ready'
    const operationAvailability = resolveImageOperationAvailability({
      model: selectedImageModel,
      runtimeReady: imageGenerationNodeV1 && imageRuntimeReady && !previewMode,
      selection: {
        nodeKind: 'image',
        count: selectionCount,
        assetId: node.assetId || null,
        generationState
      },
      adapterImplementedOperations: contextualImageOperations,
      policyEnabledOperations: contextualImageOperations
    })
    return resolveImageNodeCommands({
      target: {
        nodeKind: 'image',
        count: selectionCount,
        assetId: node.assetId || null,
        generationState,
        source: node.meta.source === 'image-generation-conversation' ? 'generated' : 'upload'
      },
      operationAvailability
    }).map(command => command.id === 'crop' && node.crop
      ? { ...command, enabled: false }
      : command)
  }, [imageGenerationNodeV1, imageRuntimeReady, previewMode, selectedImageModel])

  const selectedImageCommands = useMemo(() => {
    if (!selectedImageNode) return []
    const count = selectedNodeIds.length || 1
    return resolveCommandsForImageNode(selectedImageNode, count)
  }, [resolveCommandsForImageNode, selectedImageNode, selectedNodeIds.length])

  const selectedMultiViewGroup = useMemo(() => {
    const groupId = typeof selectedImageNode?.meta.operationGroupId === 'string'
      ? selectedImageNode.meta.operationGroupId
      : null
    if (!groupId) return null
    const nodesInGroup = freeCanvas.nodes.filter((node): node is IFreeCanvasImageNode => (
      node.kind === 'image' && node.meta.operationGroupId === groupId
    ))
    const members: MultiViewGroupPanelMember[] = nodesInGroup.map(node => {
      const viewId = typeof node.meta.operationViewSpec === 'string'
        ? node.meta.operationViewSpec
        : 'unknown'
      const knownView = defaultMultiViewSpecs.find(view => view.id === viewId)
      const generationState = node.meta.generationState
      const state = generationState === 'failed'
        ? 'failed'
        : generationState === 'running'
          ? 'running'
          : generationState === 'succeeded' || node.assetId
            ? 'succeeded'
            : 'queued'
      return {
        nodeId: node.id,
        itemId: typeof node.meta.operationItemId === 'string' ? node.meta.operationItemId : node.id,
        viewId,
        viewLabel: knownView?.label || viewId,
        state,
        assetId: node.assetId || null
      }
    })
    const sourceNodeId = nodesInGroup.find(node => typeof node.meta.sourceCanvasNodeId === 'string')
      ?.meta.sourceCanvasNodeId
    const sourceAvailable = typeof sourceNodeId === 'string'
      && freeCanvas.nodes.some(node => node.kind === 'image' && node.id === sourceNodeId && Boolean(node.assetId))
    return { groupId, members, sourceNodeId: typeof sourceNodeId === 'string' ? sourceNodeId : null, sourceAvailable }
  }, [freeCanvas.nodes, selectedImageNode])

  const selectMultiViewMember = useCallback((nodeId: string) => {
    const current = freeCanvasRef.current
    if (!current.nodes.some(node => node.id === nodeId)) return
    commitCanvasSelection(current, nodeId)
  }, [commitCanvasSelection])

  const addCanvasImageAsComposerReference = useCallback((node: IFreeCanvasImageNode) => {
    setRightPanelMode('image-generation')
    setRightPanelCollapsed(false)
    if (!node.assetId) {
      setUploadError('图片节点没有可用的本地资产。')
      return
    }
    if (imageComposerDraft.inputs.some(input => (
      input.referenceId.startsWith(`canvas-${node.id}-`)
    ))) {
      setUploadError('该图片已在当前参考图中。')
      return
    }
    if (imageComposerDraft.inputs.length >= maxComposerImages) {
      setUploadError(`已达到当前模型的 ${maxComposerImages} 张参考图上限。`)
      return
    }
    const result = injectCanvasNodesIntoDraft(imageComposerDraft, [node])
    setImageComposerDraft(result.draft)
    setUploadError(result.rejected.length > 0
      ? result.rejected.map(item => item.reason).join(' ')
      : null)
  }, [imageComposerDraft, maxComposerImages])

  const addCanvasTextAsComposerReference = useCallback((nodeId: string) => {
    const node = freeCanvasRef.current.nodes.find(
      candidate => candidate.id === nodeId && candidate.kind === 'text'
    )
    if (!node) return
    setRightPanelMode('image-generation')
    setRightPanelCollapsed(false)
    const result = injectCanvasNodesIntoDraft(imageComposerDraft, [node])
    setImageComposerDraft(result.draft)
    setUploadError(result.rejected.length > 0
      ? result.rejected.map(item => item.reason).join(' ')
      : null)
  }, [imageComposerDraft])

  const addCanvasImageAsAgentReference = useCallback((node: IFreeCanvasImageNode) => {
    setRightPanelCollapsed(false)
    setAgentDraftRequest({
      id: `canvas-agent-node-${node.id}-reference-${Date.now()}`,
      canvasNode: { nodeId: node.id, role: 'reference' }
    })
  }, [])

  const retryMultiViewMember = useCallback((member: MultiViewGroupPanelMember) => {
    const current = freeCanvasRef.current
    const failedNode = current.nodes.find(node => node.id === member.nodeId && node.kind === 'image')
    const sourceNodeId = failedNode && typeof failedNode.meta.sourceCanvasNodeId === 'string'
      ? failedNode.meta.sourceCanvasNodeId
      : null
    const sourceNode = sourceNodeId
      ? current.nodes.find((node): node is IFreeCanvasImageNode => node.id === sourceNodeId && node.kind === 'image')
      : null
    const groupId = failedNode && typeof failedNode.meta.operationGroupId === 'string'
      ? failedNode.meta.operationGroupId
      : undefined
    if (!sourceNode?.assetId || !groupId) return
    void openImageOperationWorkbench(sourceNode, 'multi-view', {
      retryNodeId: member.nodeId,
      operationGroupId: groupId,
      operationItemId: member.itemId,
      viewSpec: member.viewId
    })
  }, [openImageOperationWorkbench])

  const useMultiViewMemberAsReference = useCallback((member: MultiViewGroupPanelMember) => {
    const node = freeCanvasRef.current.nodes.find(
      (candidate): candidate is IFreeCanvasImageNode => candidate.id === member.nodeId && candidate.kind === 'image'
    )
    if (!node?.assetId) return
    addCanvasImageAsComposerReference(node)
  }, [addCanvasImageAsComposerReference])

  const applyCanvasCommand = useCallback((command: CanvasLocalCommand) => {
    const applied = executeCanvasLocalCommand(
      canvasCommandHistoryRef.current,
      freeCanvasRef.current,
      command
    )
    canvasCommandHistoryRef.current = applied.history
    if (applied.project !== freeCanvasRef.current) {
      commitCanvasSelection(applied.project, applied.project.selectedNodeId || null)
    }
  }, [commitCanvasSelection])

  const updateDocumentReconcileLease = useCallback((state: DocumentReconcileState) => {
    if (!state.pending) {
      documentReconcileLocksRef.current.delete(state.leaseId)
    } else {
      const existing = documentReconcileLocksRef.current.get(state.leaseId)
      const locked = existing?.projectId === state.projectId
        && existing.conversationId === state.conversationId
        ? new Set(existing.nodeIds)
        : new Set<string>()
      if (state.nodeId) {
        const target = state.projectId === activeProjectIdRef.current
          ? exactCanvasNode(freeCanvasRef.current, state.nodeId)
          : undefined
        if (
          state.projectId !== activeProjectIdRef.current
          || target?.kind === 'document'
          || target?.kind === 'storyboard'
        ) {
          locked.add(state.nodeId)
        }
      }
      documentReconcileLocksRef.current.set(state.leaseId, {
        projectId: state.projectId,
        conversationId: state.conversationId,
        nodeIds: locked
      })
    }
    const next = new Set(
      [...documentReconcileLocksRef.current.values()]
        .filter(lease => lease.projectId === activeProjectIdRef.current)
        .flatMap(lease => [...lease.nodeIds])
    )
    documentReconcileLockedNodeIdsRef.current = next
    setDocumentReconcileLockedNodeIds([...next])
  }, [])

  const stopStoryboardAckRecovery = useCallback((leaseId: string, applied?: boolean) => {
    const recovery = storyboardAckRecoveriesRef.current.get(leaseId)
    storyboardAckRecoveriesRef.current.delete(leaseId)
    const timer = storyboardAckRecoveryTimersRef.current.get(leaseId)
    if (timer !== undefined) clearTimeout(timer)
    storyboardAckRecoveryTimersRef.current.delete(leaseId)
    if (recovery && applied !== undefined) recovery.resolve(applied)
  }, [])

  const startStoryboardAckRecovery = useCallback((target: StoryboardAckRecoveryTarget) => {
    const existing = storyboardAckRecoveriesRef.current.get(target.leaseId)
    if (existing) return existing.promise
    const token = Symbol(target.leaseId)
    let resolveRecovery!: (applied: boolean) => void
    const promise = new Promise<boolean>(resolve => { resolveRecovery = resolve })
    storyboardAckRecoveriesRef.current.set(target.leaseId, {
      token, promise, resolve: resolveRecovery
    })
    const isExactResponse = (response: {
      conversationId?: unknown
      requestId?: unknown
      editId?: unknown
    }) => (
      response.conversationId === target.conversationId
      && response.requestId === target.requestId
      && response.editId === target.editId
    )
    const attempt = (delayMs: number) => {
      const timer = setTimeout(() => {
        storyboardAckRecoveryTimersRef.current.delete(target.leaseId)
        if (target.projectId === activeProjectIdRef.current && target.nodeId) {
          const authority = exactCanvasNode(freeCanvasRef.current, target.nodeId)
          const marker = authority?.kind === 'document' || authority?.kind === 'storyboard'
            ? authority.agentAppliedEdit
            : undefined
          if (
            marker?.conversationId !== target.conversationId
            || marker.requestId !== target.requestId
            || marker.editId !== target.editId
          ) {
            void agentRuntimeService.acknowledgeDocumentEdit(
              target.projectId,
              target.conversationId,
              target.editId,
              { requestId: target.requestId, status: 'failed', errorCode: 'failed_integrity' }
            ).catch(() => undefined)
            updateDocumentReconcileLease({ ...target, pending: false })
            stopStoryboardAckRecovery(target.leaseId, false)
            return
          }
        }
        void agentRuntimeService.acknowledgeDocumentEdit(
          target.projectId,
          target.conversationId,
          target.editId,
          { requestId: target.requestId, status: 'applied' }
        ).then(response => {
          if (storyboardAckRecoveriesRef.current.get(target.leaseId)?.token !== token) return
          if (!isExactResponse(response) || response.status === 'pending_apply') {
            attempt(Math.min(delayMs * 2, 5_000))
            return
          }
          updateDocumentReconcileLease({ ...target, pending: false })
          stopStoryboardAckRecovery(target.leaseId, response.status === 'applied')
        }).catch(() => {
          if (storyboardAckRecoveriesRef.current.get(target.leaseId)?.token === token) {
            attempt(Math.min(delayMs * 2, 5_000))
          }
        })
      }, delayMs)
      storyboardAckRecoveryTimersRef.current.set(target.leaseId, timer)
    }
    attempt(100)
    return promise
  }, [stopStoryboardAckRecovery, updateDocumentReconcileLease])

  useEffect(() => () => {
    storyboardAckRecoveriesRef.current.forEach(recovery => recovery.resolve(false))
    storyboardAckRecoveriesRef.current.clear()
    storyboardAckRecoveryTimersRef.current.forEach(timer => clearTimeout(timer))
    storyboardAckRecoveryTimersRef.current.clear()
  }, [])

  const handleDocumentReconcileStateChange = useCallback(async (state: DocumentReconcileState) => {
    updateDocumentReconcileLease(state)
    if (state.pending) {
      const scope = activeProjectScopeRef.current
      const currentTail = scope.projectId === state.projectId
        ? documentMutationQueuesRef.current.get(documentMutationQueueKey(scope))
        : undefined
      if (currentTail) await currentTail
    }
  }, [updateDocumentReconcileLease])

  const enqueueDocumentMutation = useCallback(<T,>(
    scope: ProjectMutationScope,
    operation: () => Promise<T>
  ): Promise<T> => {
    const queueKey = documentMutationQueueKey(scope)
    const previous = documentMutationQueuesRef.current.get(queueKey)
    const result = previous ? previous.then(operation) : operation()
    const tail = result.then(() => undefined, () => undefined)
    documentMutationQueuesRef.current.set(queueKey, tail)
    void tail.finally(() => {
      if (documentMutationQueuesRef.current.get(queueKey) === tail) {
        documentMutationQueuesRef.current.delete(queueKey)
      }
    })
    return result
  }, [])

  const createDocument = useCallback(() => {
    const scope = activeProjectScopeRef.current
    return enqueueDocumentMutation(scope, async () => {
      if (!sameProjectMutationScope(activeProjectScopeRef.current, scope)) return
      const beforeCanvas = freeCanvasRef.current
      const beforeHistory = canvasCommandHistoryRef.current
      const node = createFreeCanvasDocumentNode(nextNodePosition(reactFlow, beforeCanvas.nodes.length))
      const executed = executeCanvasLocalCommand(beforeHistory, beforeCanvas, {
        kind: 'insert-node',
        node,
        index: beforeCanvas.nodes.length
      })
      if (executed.project === beforeCanvas) return
      const attemptedNode = executed.project.nodes.find(
        (candidate): candidate is DocumentAuthorityNode => candidate.id === node.id && candidate.kind === 'document'
      )
      if (!attemptedNode) return
      canvasCommandHistoryRef.current = executed.history
      commitCanvasSelection(executed.project, node.id)
      if (!onPersistCanvas) return

      let saved = false
      try {
        saved = Boolean(await onPersistCanvas(executed.project))
      } catch {
        saved = false
      }
      if (saved) return

      const failedEntry = executed.history.past[executed.history.past.length - 1]
      const currentCanvas = freeCanvasRef.current
      const projectIsCurrent = sameProjectMutationScope(activeProjectScopeRef.current, scope)
      if (projectIsCurrent) {
        canvasCommandHistoryRef.current = discardCanvasCommandHistoryEntry(
          canvasCommandHistoryRef.current,
          failedEntry
        )
      }
      if (!projectIsCurrent || !hasExactDocumentAuthority(currentCanvas, node.id, attemptedNode)) return

      const rolledBack = applyCanvasLocalCommand(currentCanvas, failedEntry.undo)
      const recovery = {
        ...rolledBack.project,
        selectedNodeId: currentCanvas.selectedNodeId === node.id
          ? beforeCanvas.selectedNodeId
          : rolledBack.project.selectedNodeId
      }
      commitCanvasSelection(recovery, recovery.selectedNodeId || null)
      try {
        await onPersistCanvas(recovery)
      } catch {
        // The recovery snapshot remains the newest retained request for an explicit retry.
      }
      setUploadError('文档创建保存失败，请重试。')
    })
  }, [commitCanvasSelection, enqueueDocumentMutation, onPersistCanvas, reactFlow])

  const updateDocumentNode = useCallback((
    nodeId: string,
    document: PlanningDocumentV1
  ): Promise<boolean> => {
    if (documentReconcileLockedNodeIdsRef.current.has(nodeId)) return Promise.resolve(false)
    const scope = activeProjectScopeRef.current
    return enqueueDocumentMutation(scope, async () => {
      if (!sameProjectMutationScope(activeProjectScopeRef.current, scope)) return true
      if (documentReconcileLockedNodeIdsRef.current.has(nodeId)) return false
      const beforeCanvas = freeCanvasRef.current
      const beforeHistory = canvasCommandHistoryRef.current
      const current = exactCanvasNode(beforeCanvas, nodeId)
      if (!current || current.kind !== 'document') return false
      if (current.document.digest === document.digest && current.document.revision === document.revision) return true

      const executed = executeCanvasLocalCommand(beforeHistory, beforeCanvas, {
        kind: 'update-document',
        nodeId,
        document
      })
      if (executed.project === beforeCanvas) return false
      const attemptedNode = exactCanvasNode(executed.project, nodeId)
      if (!attemptedNode || attemptedNode.kind !== 'document') return false
      canvasCommandHistoryRef.current = executed.history
      emitGenerationCanvas(executed.project)
      if (!onPersistCanvas) return true

      let saved = false
      try {
        saved = Boolean(await onPersistCanvas?.(executed.project))
      } catch {
        saved = false
      }
      if (saved) return true

      const failedEntry = executed.history.past[executed.history.past.length - 1]
      const currentCanvas = freeCanvasRef.current
      const projectIsCurrent = sameProjectMutationScope(activeProjectScopeRef.current, scope)
      if (projectIsCurrent) {
        canvasCommandHistoryRef.current = discardCanvasCommandHistoryEntry(
          canvasCommandHistoryRef.current,
          failedEntry
        )
      }
      if (!projectIsCurrent || !hasExactDocumentAuthority(currentCanvas, nodeId, attemptedNode)) return true

      const recovery = applyCanvasLocalCommand(currentCanvas, failedEntry.undo).project
      emitGenerationCanvas(recovery)
      try {
        await onPersistCanvas?.(recovery)
      } catch {
        // Replacing the retained request with recovery is best-effort while Storage is unavailable.
      }
      return false
    })
  }, [emitGenerationCanvas, enqueueDocumentMutation, onPersistCanvas])

  const requestDocumentStoryboard = useCallback((nodeId: string) => {
    const node = exactCanvasNode(freeCanvasRef.current, nodeId)
    if (!node || node.kind !== 'document' || documentReconcileLockedNodeIdsRef.current.has(nodeId)) return
    setRightPanelMode('agent')
    setAgentDraftRequest({
      id: `storyboard-create:${nodeId}:${Date.now()}`,
      content: `请从文档“${node.title}”的当前有效稿创建分镜表。`,
      documentWriteContext: { operationKind: 'storyboard_create', documentNodeId: nodeId }
    })
  }, [])

  const requestStoryboardRevision = useCallback((nodeId: string) => {
    const node = exactCanvasNode(freeCanvasRef.current, nodeId)
    if (
      !node
      || node.kind !== 'storyboard'
      || node.pendingFieldChanges.length > 0
      || documentReconcileLockedNodeIdsRef.current.has(nodeId)
    ) return
    setRightPanelMode('agent')
    setAgentDraftRequest({
      id: `storyboard-changes:${nodeId}:${Date.now()}`,
      content: `请修订分镜表“${node.title}”的字段，并以可逐项审阅的差异返回。`,
      documentWriteContext: { operationKind: 'storyboard_changes', nodeId }
    })
  }, [])

  const requestDocumentPromptHandoff = useCallback((basis: Extract<AgentPromptHandoffBasis, { kind: 'document-selection' }>) => {
    const node = exactCanvasNode(freeCanvasRef.current, basis.nodeId)
    if (!node || node.kind !== 'document' || !matchesDocumentPromptHandoffBasis(node.document, basis)) return
    setRightPanelMode('agent')
    setAgentDraftRequest({
      id: `prompt-handoff-document:${basis.nodeId}:${Date.now()}`,
      content: '请根据已绑定的权威文档选区创建一个新的 Prompt 提案。',
      documentWriteContext: { operationKind: 'prompt_handoff', basis }
    })
  }, [])

  const requestStoryboardPromptHandoff = useCallback((nodeId: string, rowId: string) => {
    const node = exactCanvasNode(freeCanvasRef.current, nodeId)
    if (!node || node.kind !== 'storyboard' || node.pendingFieldChanges.length > 0) return
    const row = node.sequence.rows.find(candidate => candidate.id === rowId)
    if (!row) return
    const basis: Extract<AgentPromptHandoffBasis, { kind: 'storyboard-shot' }> = {
      kind: 'storyboard-shot', nodeId, storyboardRevision: node.revision ?? 0,
      storyboardDigest: node.digest ?? storyboardDigest(node.sequence, node.pendingFieldChanges),
      rowId, shotDigest: storyboardShotDigest(row)
    }
    setRightPanelMode('agent')
    setAgentDraftRequest({
      id: `prompt-handoff-shot:${nodeId}:${rowId}:${Date.now()}`,
      content: '请根据已绑定的权威分镜镜头创建一个新的 Prompt 提案。',
      documentWriteContext: { operationKind: 'prompt_handoff', basis }
    })
  }, [])

  const resolveStoryboardReview = useCallback((
    nodeId: string,
    ids: readonly string[] | 'all',
    action: 'accept' | 'reject'
  ) => {
    if (documentReconcileLockedNodeIdsRef.current.has(nodeId)) return
    const scope = activeProjectScopeRef.current
    void enqueueDocumentMutation(scope, async () => {
      if (!sameProjectMutationScope(activeProjectScopeRef.current, scope)) return
      if (documentReconcileLockedNodeIdsRef.current.has(nodeId)) return
      const beforeCanvas = freeCanvasRef.current
      const current = exactCanvasNode(beforeCanvas, nodeId)
      if (!current || current.kind !== 'storyboard') return
      let updated: typeof current
      try {
        updated = resolveStoryboardFieldChanges(current, ids, action)
      } catch {
        return
      }
      const executed = executeCanvasLocalCommand(canvasCommandHistoryRef.current, beforeCanvas, {
        kind: 'update-storyboard',
        nodeId,
        storyboard: updated
      })
      if (executed.project === beforeCanvas) return
      const attempted = exactCanvasNode(executed.project, nodeId)
      if (!attempted || attempted.kind !== 'storyboard') return
      emitGenerationCanvas(executed.project)
      if (!onPersistCanvas) {
        emitGenerationCanvas(beforeCanvas)
        setUploadError('分镜审阅保存失败，请重试。')
        return
      }
      let saved = false
      try {
        saved = Boolean(await onPersistCanvas(executed.project))
      } catch {
        saved = false
      }
      if (saved) {
        if (sameProjectMutationScope(activeProjectScopeRef.current, scope)) {
          canvasCommandHistoryRef.current = executed.history
        }
        return
      }
      const currentCanvas = freeCanvasRef.current
      if (
        sameProjectMutationScope(activeProjectScopeRef.current, scope)
        && hasExactCanvasNodeAuthority(currentCanvas, nodeId, attempted)
      ) {
        emitGenerationCanvas(beforeCanvas)
        try {
          await onPersistCanvas(beforeCanvas)
        } catch {
          // Replacing the failed retained request with the authoritative pre-review state is best-effort.
        }
      }
      setUploadError('分镜审阅保存失败，请重试。')
    })
  }, [emitGenerationCanvas, enqueueDocumentMutation, onPersistCanvas])

  const updateDocumentCollapsed = useCallback((
    nodeId: string,
    collapsed: boolean
  ): Promise<boolean> => {
    if (documentReconcileLockedNodeIdsRef.current.has(nodeId)) return Promise.resolve(false)
    const scope = activeProjectScopeRef.current
    return enqueueDocumentMutation(scope, async () => {
      if (!sameProjectMutationScope(activeProjectScopeRef.current, scope)) return true
      if (documentReconcileLockedNodeIdsRef.current.has(nodeId)) return false
      const beforeCanvas = freeCanvasRef.current
      const current = exactCanvasNode(beforeCanvas, nodeId)
      if (!current || current.kind !== 'document') return false
      if ((current.meta.collapsed === true) === collapsed) return true
      const previousCollapsed = current.meta.collapsed
      const next = {
        ...beforeCanvas,
        nodes: beforeCanvas.nodes.map(node => node.id === nodeId
          ? { ...node, meta: { ...node.meta, collapsed } }
          : node)
      }
      const attemptedNode = exactCanvasNode(next, nodeId)
      if (!attemptedNode || attemptedNode.kind !== 'document') return false
      emitGenerationCanvas(next)
      if (!onPersistCanvas) return true

      let saved = false
      try {
        saved = Boolean(await onPersistCanvas(next))
      } catch {
        saved = false
      }
      if (saved) return true

      const currentCanvas = freeCanvasRef.current
      if (
        !sameProjectMutationScope(activeProjectScopeRef.current, scope) ||
        !hasExactDocumentAuthority(currentCanvas, nodeId, attemptedNode)
      ) return true

      const recovery = {
        ...currentCanvas,
        nodes: currentCanvas.nodes.map(node => {
          if (node.id !== nodeId || node.kind !== 'document') return node
          const meta = { ...node.meta }
          if (previousCollapsed === undefined) delete meta.collapsed
          else meta.collapsed = previousCollapsed
          return { ...node, meta }
        })
      }
      emitGenerationCanvas(recovery)
      try {
        await onPersistCanvas(recovery)
      } catch {
        // The recovery snapshot remains the newest retained request for an explicit retry.
      }
      return false
    })
  }, [emitGenerationCanvas, enqueueDocumentMutation, onPersistCanvas])

  const closeNodeContextMenu = useCallback(() => {
    setNodeContextMenu(current => {
      current?.returnFocus?.focus()
      return null
    })
  }, [])

  const deleteCanvasNodes = useCallback((nodeId: string) => {
    const current = freeCanvasRef.current
    if (!current.nodes.some(node => node.id === nodeId)) return
    const requestedNodeIds = selectedNodeIds.includes(nodeId) && selectedNodeIds.length > 0
      ? selectedNodeIds
      : [nodeId]
    const nodeIds = requestedNodeIds.filter(candidateId => {
      const candidate = current.nodes.find(node => node.id === candidateId)
      return candidate
        && !isIsolatedReadOnlyCanvasNode(candidate)
        && !((candidate.kind === 'document' || candidate.kind === 'storyboard')
          && documentReconcileLockedNodeIdsRef.current.has(candidate.id))
    })
    if (nodeIds.length === 0) return
    applyCanvasCommand({ kind: 'delete-nodes', nodeIds })
    setTextSelections(current => Object.fromEntries(
      Object.entries(current).filter(([candidateId]) => !nodeIds.includes(candidateId))
    ))
  }, [applyCanvasCommand, selectedNodeIds])

  const rasterVisibleImageNode = useCallback(async (node: IFreeCanvasImageNode): Promise<Blob> => {
    if (!node.assetId) throw new Error('图片资产不可用。')
    const image = await loadImageElement(canvasImageAssetUrl(node.assetId))
    return renderVisibleImage(image, node, { format: 'image/png' })
  }, [])

  const exportVisibleImageNode = useCallback(async (node: IFreeCanvasImageNode) => {
    try {
      const blob = await rasterVisibleImageNode(node)
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = `${node.title || 'image'}-visible.png`
      anchor.rel = 'noopener'
      anchor.click()
      URL.revokeObjectURL(objectUrl)
      setClipboardNotice('已导出包含裁切、翻转和标注的所见图片')
    } catch {
      setUploadError('无法导出当前所见图片。')
    }
  }, [rasterVisibleImageNode])

  const copyVisibleImageNode = useCallback(async (node: IFreeCanvasImageNode) => {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('Clipboard image write is unavailable')
      }
      const blob = await rasterVisibleImageNode(node)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setClipboardNotice('已复制包含裁切、翻转和标注的所见图片')
    } catch {
      setUploadError('当前环境不支持复制所见图片，请使用“下载所见图片”。')
    }
  }, [rasterVisibleImageNode])

  const executeImageCommand = useCallback((nodeId: string, commandId: ImageNodeCommandId) => {
    const current = freeCanvasRef.current
    const node = current.nodes.find((candidate): candidate is IFreeCanvasImageNode =>
      candidate.id === nodeId && candidate.kind === 'image'
    )
    if (!node) return

    if (commandId === 'copy') {
      copiedImageNodeRef.current = node
      setClipboardNotice('已复制图片节点')
      return
    }
    if (commandId === 'duplicate') {
      const duplicate = duplicateCanvasImageNode(node, createLocalId('free-image-copy'))
      applyCanvasCommand({ kind: 'insert-node', node: duplicate, index: current.nodes.length })
      return
    }
    if (commandId === 'delete') {
      deleteCanvasNodes(nodeId)
      return
    }
    if (commandId === 'zoom-selection') {
      const flowNode = reactFlow.getNode(nodeId)
      if (flowNode) void reactFlow.fitView({ nodes: [flowNode], padding: 0.22, duration: 280 })
      return
    }
    if (commandId === 'layer-up' || commandId === 'bring-front' || commandId === 'layer-down' || commandId === 'send-back') {
      const index = current.nodes.findIndex(candidate => candidate.id === nodeId)
      const toIndex = commandId === 'bring-front'
        ? current.nodes.length - 1
        : commandId === 'send-back'
          ? 0
          : commandId === 'layer-up' ? index + 1 : index - 1
      applyCanvasCommand({ kind: 'reorder-node', nodeId, toIndex })
      return
    }
    if (commandId === 'flip-horizontal' || commandId === 'flip-vertical') {
      applyCanvasCommand({
        kind: 'flip-image',
        nodeId,
        axis: commandId === 'flip-horizontal' ? 'horizontal' : 'vertical'
      })
      return
    }
    if (commandId === 'crop') {
      if (!node.crop) setCropNodeId(nodeId)
      return
    }
    if (commandId === 'annotate') {
      setAnnotationEditorNodeId(nodeId)
      return
    }
    if (commandId === 'copy-visible') {
      void copyVisibleImageNode(node)
      return
    }
    if (commandId === 'export-visible') {
      void exportVisibleImageNode(node)
      return
    }
    if (commandId === 'download-original' && node.assetId) {
      const anchor = document.createElement('a')
      anchor.href = canvasImageAssetUrl(node.assetId)
      anchor.download = `${node.title || 'image'}.png`
      anchor.rel = 'noopener'
      anchor.click()
      return
    }
    if (commandId === 'as-reference') {
      if (rightPanelMode === 'agent') {
        addCanvasImageAsAgentReference(node)
      } else if (rightPanelMode === 'image-generation') {
        addCanvasImageAsComposerReference(node)
      }
      return
    }
    const operation = imageOperationForCommand(commandId)
    if (operation) {
      void openImageOperationWorkbench(node, operation)
    }
  }, [addCanvasImageAsAgentReference, addCanvasImageAsComposerReference, applyCanvasCommand, copyVisibleImageNode, deleteCanvasNodes, exportVisibleImageNode, openImageOperationWorkbench, reactFlow, rightPanelMode])

  const executeTextCommand = useCallback((nodeId: string, command: TextNodeContextCommand) => {
    if (command === 'copy') {
      copyTextNode(nodeId)
      return
    }
    if (command === 'complete') {
      void sendTextNodeToAgent(nodeId, 'target')
      return
    }
    if (command === 'send-to-agent') {
      void sendTextNodeToAgent(nodeId, 'reference')
      return
    }
    if (command === 'send-to-image-generation') {
      addCanvasTextAsComposerReference(nodeId)
      return
    }
    deleteCanvasNodes(nodeId)
  }, [addCanvasTextAsComposerReference, copyTextNode, deleteCanvasNodes, sendTextNodeToAgent])

  const applyPersistedCanvasHistoryStep = useCallback((direction: 'undo' | 'redo') => {
    const scope = activeProjectScopeRef.current
    const run = async (): Promise<boolean> => {
      if (!sameProjectMutationScope(activeProjectScopeRef.current, scope)) return true
      const beforeCanvas = freeCanvasRef.current
      const beforeHistory = canvasCommandHistoryRef.current
      const entry = direction === 'redo'
        ? beforeHistory.future[0]
        : beforeHistory.past[beforeHistory.past.length - 1]
      if (!entry) return true
      const entryNodeIds = [entry.undo, entry.redo]
        .flatMap(command => canvasCommandAuthorityImpact(command).nodeIds)
      if (entryNodeIds.some(nodeId => documentReconcileLockedNodeIdsRef.current.has(nodeId))) return false
      const applied = direction === 'redo'
        ? redoCanvasLocalCommand(beforeHistory, beforeCanvas)
        : undoCanvasLocalCommand(beforeHistory, beforeCanvas)
      if (applied.project === beforeCanvas) return true
      const attemptedCanvasAuthority = canvasHistoryAuthorityIdentity(applied.project, entry)

      canvasCommandHistoryRef.current = applied.history
      commitCanvasSelection(applied.project, applied.project.selectedNodeId || null)
      if (!onPersistCanvas) return true

      let saved = false
      try {
        saved = Boolean(await onPersistCanvas(applied.project))
      } catch {
        saved = false
      }
      if (saved) return true

      const projectIsCurrent = sameProjectMutationScope(activeProjectScopeRef.current, scope)
      const attemptedAuthorityIsCurrent = canvasHistoryAuthorityIdentity(freeCanvasRef.current, entry)
        === attemptedCanvasAuthority
      if (!projectIsCurrent || !attemptedAuthorityIsCurrent) {
        if (projectIsCurrent) {
          canvasCommandHistoryRef.current = discardCanvasCommandHistoryEntry(
            canvasCommandHistoryRef.current,
            entry
          )
        }
        return true
      }

      const recoveryCommand = direction === 'redo' ? entry.undo : entry.redo
      const recoveredCommand = applyCanvasLocalCommand(freeCanvasRef.current, recoveryCommand).project
      const recoveredSelection = canvasHistoryRecoverySelection(
        applied.project,
        freeCanvasRef.current,
        recoveredCommand
      )
      const recovered = { ...recoveredCommand, selectedNodeId: recoveredSelection }
      canvasCommandHistoryRef.current = recoverFailedCanvasHistoryStep(
        canvasCommandHistoryRef.current,
        beforeHistory,
        entry,
        direction
      )
      commitCanvasSelection(recovered, recoveredSelection)
      try {
        await onPersistCanvas(recovered)
      } catch {
        // The recovery snapshot remains the newest retained request for an explicit retry.
      }
      setUploadError(`画布${direction === 'undo' ? '撤销' : '重做'}保存失败，请重试。`)
      return false
    }

    return enqueueDocumentMutation(scope, run)
  }, [commitCanvasSelection, enqueueDocumentMutation, onPersistCanvas])

  useEffect(() => {
    const handleLocalShortcut = (event: KeyboardEvent) => {
      if (isCanvasKeyboardLocked || isTypingTarget(event.target)) return
      const selectedNodeId = freeCanvasRef.current.selectedNodeId
      if ((event.key === 'Backspace' || event.key === 'Delete') && selectedNodeId) {
        event.preventDefault()
        deleteCanvasNodes(selectedNodeId)
        return
      }
      const modifier = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (modifier && key === 'z') {
        event.preventDefault()
        void applyPersistedCanvasHistoryStep(event.shiftKey ? 'redo' : 'undo')
        return
      }
      if (modifier && key === 'y') {
        event.preventDefault()
        void applyPersistedCanvasHistoryStep('redo')
        return
      }
      const node = selectedImageNodeRef.current
      if (!node) return
      if (modifier && key === 'd') {
        event.preventDefault()
        executeImageCommand(node.id, 'duplicate')
        return
      }
      if (event.shiftKey && event.key === '1') {
        event.preventDefault()
        executeImageCommand(node.id, 'zoom-selection')
        return
      }
      if (modifier && (event.key === ']' || event.key === '[')) {
        event.preventDefault()
        executeImageCommand(
          node.id,
          event.key === ']'
            ? event.altKey ? 'bring-front' : 'layer-up'
            : event.altKey ? 'send-back' : 'layer-down'
        )
      }
    }
    window.addEventListener('keydown', handleLocalShortcut)
    return () => window.removeEventListener('keydown', handleLocalShortcut)
  }, [applyPersistedCanvasHistoryStep, deleteCanvasNodes, executeImageCommand, isCanvasKeyboardLocked])

  const maximumOperationInputs = selectedImageModel?.capabilities?.references?.maxCount
    ?? selectedImageModel?.capabilities?.maxReferenceImages
    ?? 1
  const imageOperationExternalIssues = useMemo(() => {
    const issues: string[] = []
    if (!imageGenerationNodeV1) issues.push('图片生成功能当前未开启。')
    if (previewMode) issues.push('预览模式不能发起图片生成。')
    if (!imageRuntimeReady) issues.push('图片生成 Runtime 尚未就绪。')
    if (!selectedImageConnection?.enabled) issues.push('图片模型连接不可用。')
    if (!selectedImageConnection?.credentialConfigured) issues.push('图片模型连接尚未配置凭据。')
    if (!selectedImageConnection?.lastTest?.ok) issues.push('图片模型连接尚未测试成功。')
    if (!selectedImageModel) issues.push('尚未选择可用图片模型。')
    return issues
  }, [imageGenerationNodeV1, imageRuntimeReady, previewMode, selectedImageConnection, selectedImageModel])

  const importImageOperationReferences = useCallback(async (
    files: File[]
  ): Promise<ImageOperationReference[]> => {
    const remaining = Math.max(0, maximumOperationInputs - 1 - (activeImageOperationDraft?.references.length || 0))
    const accepted = files.slice(0, remaining)
    const imported = await Promise.all(accepted.map(async (file, index) => {
      const asset = await storageServiceClient.imageAssets.import(file)
      return {
        referenceId: createLocalId('operation-reference'),
        assetId: asset.providerInputAsset.id,
        sourceAssetId: asset.originalAsset.id,
        label: file.name,
        role: 'content' as const,
        order: (activeImageOperationDraft?.references.length || 0) + index
      }
    }))
    return imported
  }, [activeImageOperationDraft?.references.length, maximumOperationInputs])

  const submitImageOperation = useCallback(async (draft: ImageOperationDraft) => {
    if (!selectedImageConnection || !selectedImageModel) throw new Error('图片模型连接不可用。')
    const snapshot = compileImageOperationDraft(draft, {
      connectionId: selectedImageConnection.id,
      modelId: selectedImageModel.id,
      outputFormat: imageComposerDraft.outputFormat,
      watermark: imageComposerDraft.watermark,
      promptOptimization: imageComposerDraft.promptOptimization
    })
    const succeeded = await executeImageDraft(snapshot, {
      nodeId: draft.source.nodeId,
      activateConversation: false
    })
    if (!succeeded) throw new Error('图片操作未成功提交，请检查画布上的失败节点后重试。')
    setActiveImageOperationDraft(null)
  }, [executeImageDraft, imageComposerDraft.outputFormat, imageComposerDraft.promptOptimization, imageComposerDraft.watermark, selectedImageConnection, selectedImageModel])

  const submitMultiViewOperation = useCallback(async (
    draft: ImageOperationDraft,
    selectedViewIds: string[],
    retryTarget: MultiViewRetryTarget | null
  ) => {
    if (!selectedImageConnection || !selectedImageModel) throw new Error('图片模型连接不可用。')
    const current = freeCanvasRef.current
    let retryMember: IFreeCanvasImageNode | null = null
    if (retryTarget) {
      const sourceMatches = draft.source.nodeId === retryTarget.source.nodeId
        && draft.source.originalAssetId === retryTarget.source.originalAssetId
        && draft.source.canvasAssetId === retryTarget.source.canvasAssetId
        && draft.source.providerAssetId === retryTarget.source.providerAssetId
      const failedMember = current.nodes.find((node): node is IFreeCanvasImageNode => (
        node.id === retryTarget.nodeId
        && node.kind === 'image'
        && node.meta.operationGroupId === retryTarget.operationGroupId
        && node.meta.operationItemId === retryTarget.operationItemId
        && node.meta.operationViewSpec === retryTarget.viewSpec
        && node.meta.sourceCanvasNodeId === retryTarget.source.nodeId
        && node.meta.generationState === 'failed'
      ))
      const sourceNode = current.nodes.find(node => (
        node.id === retryTarget.source.nodeId
        && node.kind === 'image'
        && node.assetId === retryTarget.source.canvasAssetId
      ))
      if (
        draft.operationGroupId !== retryTarget.operationGroupId
        || draft.operationItemId !== retryTarget.operationItemId
        || draft.viewSpec !== retryTarget.viewSpec
        || selectedViewIds.length !== 1
        || selectedViewIds[0] !== retryTarget.viewSpec
        || !sourceMatches
        || !failedMember
        || !sourceNode
      ) throw new Error('重试只能提交原失败视角。')
      retryMember = failedMember
    } else if (draft.operationItemId) throw new Error('重试只能提交原失败视角。')
    const groupId = draft.operationGroupId || createLocalId('multi-view-group')
    const members = createMultiViewRequestMembers({
      sourceDraft: draft,
      selectedViewIds,
      groupId,
      createItemId: view => (
        draft.operationItemId && selectedViewIds.length === 1 && view.id === draft.viewSpec
          ? draft.operationItemId
          : createLocalId(`multi-view-${view.id}`)
      )
    }).map(member => {
      const runId = createImageGenerationRunId()
      const snapshot = compileImageOperationDraft(member.draft, {
        connectionId: selectedImageConnection.id,
        modelId: selectedImageModel.id,
        outputFormat: imageComposerDraft.outputFormat,
        watermark: imageComposerDraft.watermark,
        promptOptimization: imageComposerDraft.promptOptimization
      })
      return { ...member, runId, snapshot }
    })
    if (members.length === 0) throw new Error('请至少选择一个视角。')

    const sourceNode = current.nodes.find(node => node.id === draft.source.nodeId)
    if (!sourceNode || sourceNode.kind !== 'image') throw new Error('多角度源图片已不在当前画布中。')
    const frame = imageGenerationPlaceholderFrame(members[0].snapshot)
    const groupMemberOffset = current.nodes.filter(node => node.meta.operationGroupId === groupId).length
    const replacementNodeIds = new Set<string>()
    const placeholders = members.map((member, index) => {
      const existingMember = retryTarget
        ? member.itemId === retryTarget.operationItemId && member.view.id === retryTarget.viewSpec
          ? retryMember
          : null
        : current.nodes.find((node): node is IFreeCanvasImageNode => (
            node.kind === 'image'
            && node.meta.operationGroupId === groupId
            && node.meta.operationItemId === member.itemId
            && node.meta.generationState === 'failed'
          ))
      const placementIndex = groupMemberOffset + index
      const placeholder = createOperationPlaceholder({
        snapshot: member.snapshot,
        runId: member.runId,
        conversationId: `image-operation-${member.runId}`,
        position: existingMember?.position || {
          x: sourceNode.position.x + sourceNode.width + 48 + (placementIndex % 3) * (frame.width + 24),
          y: sourceNode.position.y + Math.floor(placementIndex / 3) * (frame.height + 48)
        },
        frame: existingMember
          ? { width: existingMember.width, height: existingMember.height }
          : frame
      })
      if (!existingMember) return placeholder
      replacementNodeIds.add(existingMember.id)
      return { ...placeholder, id: existingMember.id }
    })
    const placeholdersByNodeId = new Map(placeholders.map(node => [node.id, node]))
    const canvasWithGroup = commitCanvasSelection({
      ...current,
      nodes: [
        ...current.nodes.map(node => placeholdersByNodeId.get(node.id) || node),
        ...placeholders.filter(node => !replacementNodeIds.has(node.id))
      ]
    }, placeholders[0].id)

    members.forEach(member => scheduledGenerationRunIdsRef.current.add(member.runId))
    let saved = false
    try {
      saved = Boolean(await onPersistCanvas?.(canvasWithGroup))
    } catch {
      saved = false
    }
    if (!saved) {
      members.forEach(member => scheduledGenerationRunIdsRef.current.delete(member.runId))
      const failedCanvas = members.reduce(
        (canvas, member) => failFreeCanvasImageGeneration(canvas, member.runId, 'storage_write_failed'),
        freeCanvasRef.current
      )
      emitGenerationCanvas(failedCanvas)
      await onPersistCanvas?.(failedCanvas).catch(() => false)
      throw new Error('多角度占位节点保存失败，未发起任何模型请求。')
    }

    try {
      const requests = members.map(member => {
        const request = buildConversationGenerationRequest(
          activeProject.id,
          `image-operation-${member.runId}`,
          member.snapshot
        )
        delete request.conversationId
        request.nodeId = draft.source.nodeId
        return { ...request, runId: member.runId }
      })
      await prepareImageGenerationBatch(requests)
    } catch (error) {
      members.forEach(member => scheduledGenerationRunIdsRef.current.delete(member.runId))
      const errorCode = safeGenerationErrorCode(
        error instanceof ImageGenerationClientError ? error.code : 'storage_write_failed'
      )
      const failedCanvas = members.reduce(
        (canvas, member) => failFreeCanvasImageGeneration(canvas, member.runId, errorCode),
        freeCanvasRef.current
      )
      emitGenerationCanvas(failedCanvas)
      await onPersistCanvas?.(failedCanvas).catch(() => false)
      throw new Error('多角度批量准备失败，未发起任何模型请求。')
    }

    setActiveImageOperationDraft(null)
    void scheduleMultiViewMembers(
      members,
      member => {
        scheduledGenerationRunIdsRef.current.delete(member.runId)
        if (activeProjectIdRef.current !== activeProject.id) return Promise.resolve(false)
        return executeImageDraft(member.snapshot, {
          nodeId: draft.source.nodeId,
          activateConversation: false,
          runId: member.runId,
          placeholderPrepared: true
        })
      },
      1
    ).finally(() => {
      members.forEach(member => scheduledGenerationRunIdsRef.current.delete(member.runId))
    })
  }, [activeProject.id, commitCanvasSelection, emitGenerationCanvas, executeImageDraft, imageComposerDraft.outputFormat, imageComposerDraft.promptOptimization, imageComposerDraft.watermark, onPersistCanvas, selectedImageConnection, selectedImageModel])

  const nodes = useMemo<FreeCanvasFlowNode[]>(() => freeCanvas.nodes.map(node => ({
    id: node.id,
    type: node.kind === 'image-generator' ? 'imageGeneratorNode' : 'freeCanvasNode',
    position: node.position,
    selected: selectedNodeIds.includes(node.id),
    draggable: !isIsolatedReadOnlyCanvasNode(node)
      && !((node.kind === 'document' || node.kind === 'storyboard')
        && documentReconcileLockedNodeIds.includes(node.id)),
    connectable: !isNonConnectableCanvasNode(node),
    deletable: !isIsolatedReadOnlyCanvasNode(node)
      && !isRunningFreeCanvasImageGeneration(node)
      && !((node.kind === 'document' || node.kind === 'storyboard')
        && documentReconcileLockedNodeIds.includes(node.id)),
    initialWidth: node.kind === 'image' ? node.width : undefined,
    initialHeight: node.kind === 'image' ? node.height : undefined,
    style: node.kind === 'image' ? { width: node.width, height: node.height } : undefined,
    data: {
      canvasNode: node,
      editing: editingNodeId === node.id,
      onEdit: setEditingNodeId,
      onTextCopy: copyTextNode,
      onTextRangeReplace: replaceTextRange,
      onTextStyleChange: updateTextStyle,
      onTextRename: renameTextNode,
      onTextSelectionChange: rememberTextSelection,
      onDocumentChange: updateDocumentNode,
      onDocumentCollapsedChange: updateDocumentCollapsed,
      onDocumentDelete: deleteCanvasNodes,
      onDocumentToStoryboard: requestDocumentStoryboard,
      onDocumentPromptHandoff: requestDocumentPromptHandoff,
      onStoryboardResolve: resolveStoryboardReview,
      onStoryboardRevise: requestStoryboardRevision,
      onStoryboardPromptHandoff: requestStoryboardPromptHandoff,
      documentLocked: node.kind === 'document' && documentReconcileLockedNodeIds.includes(node.id),
      storyboardLocked: node.kind === 'storyboard' && documentReconcileLockedNodeIds.includes(node.id),
      onImageResize: resizeImageNode,
      resultThumbnailUrl: node.kind === 'image-generator' && node.primaryAssetId
        ? canvasImageAssetUrl(node.primaryAssetId)
        : undefined,
      onOpenImageHistory: () => undefined,
      onConfigureImageModel: onConfigureImageModel
        ? (nodeId: string) => onConfigureImageModel({ projectId: activeProject.id, nodeId, returnTarget: 'free-canvas' })
        : undefined,
      onContinueLegacyImageCreation: continueLegacyImageCreation,
      imageCommands: node.kind === 'image' && node.id === selectedImageNode?.id
        ? selectedImageCommands
        : undefined,
      onImageCommand: executeImageCommand,
      imageGeneratorInputSummary: node.kind === 'image-generator' ? {
        promptConnected: freeCanvas.edges.some(edge => edge.target === node.id && edge.targetHandle === 'prompt'),
        sourceConnected: freeCanvas.edges.some(edge => edge.target === node.id && edge.targetHandle === 'source-image'),
        referenceCount: freeCanvas.edges.filter(edge => edge.target === node.id && edge.targetHandle === 'reference-image').length
      } : undefined
    }
  })), [activeProject.id, continueLegacyImageCreation, copyTextNode, deleteCanvasNodes, documentReconcileLockedNodeIds, editingNodeId, executeImageCommand, freeCanvas.edges, freeCanvas.nodes, onConfigureImageModel, rememberTextSelection, renameTextNode, replaceTextRange, requestDocumentPromptHandoff, requestDocumentStoryboard, requestStoryboardPromptHandoff, requestStoryboardRevision, resizeImageNode, resolveStoryboardReview, selectedImageCommands, selectedImageNode?.id, selectedNodeIds, updateDocumentCollapsed, updateDocumentNode, updateTextStyle])

  const [flowNodes, setFlowNodes] = useState<FreeCanvasFlowNode[]>(nodes)
  useEffect(() => {
    setFlowNodes(current => {
      const measuredById = new Map(current.flatMap(node => (
        node.measured?.width !== undefined && node.measured.height !== undefined
          ? [[node.id, node.measured] as const]
          : []
      )))
      return nodes.map(node => {
        const measured = measuredById.get(node.id)
        return measured ? { ...node, measured } : node
      })
    })
  }, [nodes])

  const edges = useMemo<Edge[]>(() => freeCanvas.edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    label: edge.label,
    type: 'smoothstep',
    style: {
      stroke: edge.id === selectedEdgeId ? '#ef4423' : '#111827',
      strokeWidth: edge.id === selectedEdgeId ? 2.4 : 1.8
    }
  })), [freeCanvas.edges, selectedEdgeId])

  const workspaceContext = useMemo(() => buildFreeCanvasWorkspaceContext({
    activeProject,
    freeCanvas
  }), [activeProject, freeCanvas])

  const handleNodesChange = (changes: NodeChange<FreeCanvasFlowNode>[]) => {
    const nonRemovalChanges = changes.filter(change => change.type !== 'remove')
    if (nonRemovalChanges.length > 0) {
      setFlowNodes(current => applyNodeChanges(nonRemovalChanges, current) as FreeCanvasFlowNode[])
    }
    const removedNodeIds = changes
      .filter(change => change.type === 'remove')
      .map(change => change.id)
      .filter(nodeId => {
        const node = freeCanvasRef.current.nodes.find(candidate => candidate.id === nodeId)
        return node
          && !isIsolatedReadOnlyCanvasNode(node)
          && !((node.kind === 'document' || node.kind === 'storyboard')
            && documentReconcileLockedNodeIdsRef.current.has(node.id))
      })
    if (removedNodeIds.length > 0 && !isCanvasKeyboardLocked) {
      const nextCanvas = removeFreeCanvasProjectNodes(freeCanvasRef.current, removedNodeIds)
      commitCanvasSelection(nextCanvas, nextCanvas.selectedNodeId || null)
      setEditingNodeId(current => current && removedNodeIds.includes(current) ? null : current)
    }
  }

  const handleSelectionChange = useCallback<OnSelectionChangeFunc<FreeCanvasFlowNode>>(({ nodes: selection }) => {
    const nextNodeIds = selection.map(node => node.id)
    const currentCanvas = freeCanvasRef.current
    const currentNodeId = currentCanvas.selectedNodeId || null
    const nextNodeId = nextNodeIds.length === 0
      ? null
      : currentNodeId && nextNodeIds.includes(currentNodeId) ? currentNodeId : nextNodeIds[0]
    if (nextNodeId !== currentNodeId) commitCanvasSelection(currentCanvas, nextNodeId, nextNodeIds)
    else {
      setSelectedNodeIds(current => (
        current.length === nextNodeIds.length && current.every((nodeId, index) => nodeId === nextNodeIds[index])
          ? current
          : nextNodeIds
      ))
    }
  }, [commitCanvasSelection])

  const cancelImageCrop = () => setCropNodeId(null)

  const confirmImageCrop = (lines: FreeCanvasCropLines) => {
    if (!cropNode) return
    const croppedNodes = createFreeCanvasCroppedNodes(imageNodeToMedia(cropNode), lines)
      .map(media => createFreeCanvasImageNodeFromMedia(media))
    commitCanvasSelection({
      ...freeCanvas,
      nodes: [...freeCanvas.nodes, ...croppedNodes]
    }, croppedNodes[0]?.id || freeCanvas.selectedNodeId || null)
    setCropNodeId(null)
  }

  const handleNodeClick: NodeMouseHandler<FreeCanvasFlowNode> = (event, node) => {
    setNodeContextMenu(null)
    setSelectedEdgeId(null)
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    setSelectedNodeId(node.id)
  }

  const handleNodeContextMenu: NodeMouseHandler<FreeCanvasFlowNode> = (event, node) => {
    event.preventDefault()
    const preservesSelection = selectedNodeIds.includes(node.id) || freeCanvas.selectedNodeId === node.id
    if (!preservesSelection) {
      setSelectedNodeId(node.id)
    }
    setNodeContextMenu({
      nodeId: node.id,
      x: event.clientX,
      y: event.clientY,
      returnFocus: event.currentTarget instanceof HTMLElement ? event.currentTarget : null
    })
  }

  const handleNodeDoubleClick: NodeMouseHandler<FreeCanvasFlowNode> = (_event, node) => {
    if (node.data.canvasNode.kind === 'text') setEditingNodeId(node.id)
    if (node.data.canvasNode.kind === 'image' && node.data.canvasNode.assetId && !node.data.canvasNode.crop) {
      setCropNodeId(node.data.canvasNode.id)
    }
  }

  const handleNodeDragStop: OnNodeDrag<FreeCanvasFlowNode> = (_event, node) => {
    if (isIsolatedReadOnlyCanvasNode(node.data.canvasNode)) return
    emitGenerationCanvas(updateFreeCanvasNodePosition(freeCanvasRef.current, node.id, node.position))
  }

  const handleConnect: OnConnect = (connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return
    const sourceNode = freeCanvas.nodes.find(node => node.id === connection.source)
    const targetNode = freeCanvas.nodes.find(node => node.id === connection.target)
    if (!sourceNode || !targetNode) return
    if (isNonConnectableCanvasNode(sourceNode) || isNonConnectableCanvasNode(targetNode)) return
    if (targetNode?.kind === 'image-generator') {
      setUploadError('旧图片生成节点为只读预览，不能新增连线。请打开“图片生成”页签继续创作。')
      return
    }
    const duplicate = freeCanvas.edges.some(edge => edge.source === connection.source && edge.target === connection.target)
    if (duplicate) return
    onChange({
      ...freeCanvas,
      edges: [
        ...freeCanvas.edges,
        {
          id: `free-edge-${connection.source}-${connection.target}-${Date.now()}`,
          source: connection.source,
          target: connection.target,
          createdAt: Date.now()
        }
      ]
    })
  }

  const isValidConnection = useCallback((connection: Connection | Edge) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return false
    const sourceNode = freeCanvas.nodes.find(node => node.id === connection.source)
    const targetNode = freeCanvas.nodes.find(node => node.id === connection.target)
    if (!sourceNode || !targetNode) return false
    if (isNonConnectableCanvasNode(sourceNode) || isNonConnectableCanvasNode(targetNode)) return false
    return targetNode.kind !== 'image-generator'
  }, [freeCanvas])

  const handleEdgeClick: EdgeMouseHandler<Edge> = (_event, edge) => {
    setSelectedEdgeId(edge.id)
    setSelectedNodeId(null)
  }

  const clearFileDragState = () => {
    fileDragDepthRef.current = 0
    setFileDragActive(false)
  }

  const handleRootDropCapture = (event: ReactDragEvent<Element>) => {
    if (!isCanvasImageDrag(event.dataTransfer)) return
    clearFileDragState()
    clearComposerFileDragState()
  }

  const handleDrop = async (event: ReactDragEvent<Element>) => {
    if (!isCanvasImageDrag(event.dataTransfer)) return
    clearFileDragState()
    event.preventDefault()
    const material = readProjectMaterialDrag(event.dataTransfer)
    if (material) {
      if (material.projectId !== activeProject.id) {
        setUploadError('不能把其他项目的素材拖入当前画布。')
        return
      }
      placeProjectMaterialAt(
        material,
        reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      )
      setUploadError(null)
      return
    }
    await addImageFiles(
      Array.from(event.dataTransfer.files),
      reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    )
  }

  const handleDragEnter = (event: ReactDragEvent<Element>) => {
    if (!isCanvasImageDrag(event.dataTransfer)) return
    event.preventDefault()
    fileDragDepthRef.current += 1
    setFileDragActive(true)
  }

  const handleDragLeave = (event: ReactDragEvent<Element>) => {
    if (!isCanvasImageDrag(event.dataTransfer)) return
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1)
    if (fileDragDepthRef.current === 0) setFileDragActive(false)
  }

  const handleImageInputChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || [])
    event.currentTarget.value = ''
    void addImageFiles(files, nextNodePosition(reactFlow, freeCanvas.nodes.length))
  }

  const handleAcceptBridgePromptDelivery = async (
    delivery: BridgePromptDelivery
  ): Promise<string[]> => {
    const scope = activeProjectScopeRef.current
    if (!onPersistCanvas || !sameProjectMutationScope(activeProjectScopeRef.current, scope)) return []
    const application = await createBridgePromptApplication(delivery)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const baseCanvas = freeCanvasRef.current
      const existing = inspectPromptHandoffApplication(baseCanvas, application)
      if (existing.status === 'conflict') {
        window.alert('外部 Agent Prompt 标记完整性校验失败，无法应用。')
        return []
      }
      if (existing.status === 'exact') {
        const saved = baseCanvas.nodes.find(node => node.id === application.nodeId && node.kind === 'text')
        return saved?.referenceCode ? [saved.referenceCode] : []
      }
      const node = createBridgePromptNode(
        delivery,
        application,
        nextNodePosition(reactFlow, baseCanvas.nodes.length)
      )
      const requestedCanvas = {
        ...baseCanvas,
        selectedNodeId: node.id,
        nodes: [...baseCanvas.nodes, node]
      }
      let receipt: boolean | FreeCanvasPersistReceipt = false
      try {
        receipt = await onPersistCanvas(requestedCanvas)
      } catch {
        receipt = false
      }
      if (!sameProjectMutationScope(activeProjectScopeRef.current, scope)) return []
      const winningCanvas = authoritativePersistedCanvas(receipt)
      if (!winningCanvas) return []
      const winning = inspectPromptHandoffApplication(winningCanvas, application)
      const liveCanvas = freeCanvasRef.current
      const liveChanged = canvasSnapshotIdentity(liveCanvas) !== canvasSnapshotIdentity(baseCanvas)
        && canvasSnapshotIdentity(liveCanvas) !== canvasSnapshotIdentity(winningCanvas)
      if (winning.status === 'exact' && !liveChanged) {
        const saved = winningCanvas.nodes.find(candidate => (
          candidate.id === application.nodeId && candidate.kind === 'text'
        ))
        if (!saved?.referenceCode) return []
        commitCanvasSelection(winningCanvas, application.nodeId)
        return [saved.referenceCode]
      }
      if (winning.status === 'conflict') {
        window.alert('持久化返回的外部 Agent Prompt 标记完整性校验失败。')
        return []
      }
      freeCanvasRef.current = liveChanged ? liveCanvas : winningCanvas
    }
    window.alert('Canvas 在保存期间持续变化，请重试外部 Agent Prompt 提案。')
    return []
  }

  const handleAcceptBridgeImageDelivery = async (
    delivery: BridgeImageDelivery
  ): Promise<string[]> => {
    const scope = activeProjectScopeRef.current
    if (!onPersistCanvas || !sameProjectMutationScope(activeProjectScopeRef.current, scope)) return []
    const application = await createBridgeImageApplication(delivery)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const baseCanvas = freeCanvasRef.current
      const existing = inspectBridgeImageApplication(baseCanvas, application)
      if (existing.status === 'conflict') {
        window.alert('外部 Agent 图片标记完整性校验失败，无法应用。')
        return []
      }
      if (existing.status === 'exact') {
        const saved = baseCanvas.nodes.find(node => node.id === application.nodeId && node.kind === 'image')
        return saved?.referenceCode ? [saved.referenceCode] : []
      }
      const node = createBridgeImageNode(
        delivery,
        application,
        nextNodePosition(reactFlow, baseCanvas.nodes.length)
      )
      const requestedCanvas = {
        ...baseCanvas,
        selectedNodeId: node.id,
        nodes: [...baseCanvas.nodes, node]
      }
      let receipt: boolean | FreeCanvasPersistReceipt = false
      try {
        receipt = await onPersistCanvas(requestedCanvas)
      } catch {
        receipt = false
      }
      if (!sameProjectMutationScope(activeProjectScopeRef.current, scope)) return []
      const winningCanvas = authoritativePersistedCanvas(receipt)
      if (!winningCanvas) return []
      const winning = inspectBridgeImageApplication(winningCanvas, application)
      const liveCanvas = freeCanvasRef.current
      const liveChanged = canvasSnapshotIdentity(liveCanvas) !== canvasSnapshotIdentity(baseCanvas)
        && canvasSnapshotIdentity(liveCanvas) !== canvasSnapshotIdentity(winningCanvas)
      if (winning.status === 'exact' && !liveChanged) {
        const saved = winningCanvas.nodes.find(candidate => (
          candidate.id === application.nodeId && candidate.kind === 'image'
        ))
        if (!saved?.referenceCode) return []
        commitCanvasSelection(winningCanvas, application.nodeId)
        return [saved.referenceCode]
      }
      if (winning.status === 'conflict') {
        window.alert('持久化返回的外部 Agent 图片标记完整性校验失败。')
        return []
      }
      freeCanvasRef.current = liveChanged ? liveCanvas : winningCanvas
    }
    window.alert('Canvas 在保存期间持续变化，请重试外部 Agent 图片提案。')
    return []
  }

  const handleAcceptBridgeDocumentDelivery = async (
    delivery: BridgeDocumentDelivery
  ): Promise<string[]> => {
    const scope = activeProjectScopeRef.current
    if (!onPersistCanvas || !sameProjectMutationScope(activeProjectScopeRef.current, scope)) return []
    const application = createBridgeDocumentApplication(delivery)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const baseCanvas = freeCanvasRef.current
      const existing = inspectBridgeDocumentApplication(baseCanvas, application)
      if (existing.status === 'conflict') {
        window.alert('外部 Agent 文档目标已变化或标记冲突，无法应用。')
        return []
      }
      if (existing.status === 'exact') {
        return existing.node.referenceCode ? [existing.node.referenceCode] : []
      }
      let targetNodeId: string
      let requestedCanvas: IFreeCanvasProject
      try {
        if (delivery.request.kind === 'document.create') {
          const node = createBridgeDocumentNode(
            delivery as BridgeDocumentCreateDelivery,
            application,
            nextNodePosition(reactFlow, baseCanvas.nodes.length)
          )
          targetNodeId = node.id
          requestedCanvas = {
            ...baseCanvas,
            selectedNodeId: node.id,
            nodes: [...baseCanvas.nodes, node]
          }
        } else {
          const documentDelivery = delivery as BridgeDocumentChangeDelivery
          const target = baseCanvas.nodes.find(node => (
            node.kind === 'document' && node.referenceCode === documentDelivery.request.target.documentCode
          ))
          if (!target || target.kind !== 'document') return []
          const node = applyBridgeDocumentChange(
            target,
            documentDelivery,
            application
          )
          targetNodeId = node.id
          requestedCanvas = {
            ...baseCanvas,
            selectedNodeId: node.id,
            nodes: baseCanvas.nodes.map(candidate => candidate.id === node.id ? node : candidate)
          }
        }
      } catch {
        window.alert('外部 Agent 文档提案未通过本地完整性校验。')
        return []
      }
      let receipt: boolean | FreeCanvasPersistReceipt = false
      try {
        receipt = await onPersistCanvas(requestedCanvas)
      } catch {
        receipt = false
      }
      if (!sameProjectMutationScope(activeProjectScopeRef.current, scope)) return []
      const winningCanvas = authoritativePersistedCanvas(receipt)
      if (!winningCanvas) return []
      const winning = inspectBridgeDocumentApplication(winningCanvas, application)
      const liveCanvas = freeCanvasRef.current
      const liveChanged = canvasSnapshotIdentity(liveCanvas) !== canvasSnapshotIdentity(baseCanvas)
        && canvasSnapshotIdentity(liveCanvas) !== canvasSnapshotIdentity(winningCanvas)
      if (winning.status === 'exact' && !liveChanged) {
        if (!winning.node.referenceCode) return []
        commitCanvasSelection(winningCanvas, targetNodeId)
        return [winning.node.referenceCode]
      }
      if (winning.status === 'conflict') {
        window.alert('持久化返回的外部 Agent 文档目标或标记完整性校验失败。')
        return []
      }
      freeCanvasRef.current = liveChanged ? liveCanvas : winningCanvas
    }
    window.alert('Canvas 在保存期间持续变化，请重试外部 Agent 文档提案。')
    return []
  }

  const handleAcceptBridgeStoryboardDelivery = async (
    delivery: BridgeStoryboardDelivery
  ): Promise<string[]> => {
    const scope = activeProjectScopeRef.current
    if (!onPersistCanvas || !sameProjectMutationScope(activeProjectScopeRef.current, scope)) return []
    const application = createBridgeStoryboardApplication(delivery)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const baseCanvas = freeCanvasRef.current
      const existing = inspectBridgeStoryboardApplication(baseCanvas, application)
      if (existing.status === 'conflict') {
        window.alert('外部 Agent 分镜目标已变化或标记冲突，无法应用。')
        return []
      }
      if (existing.status === 'exact') {
        return existing.node.referenceCode ? [existing.node.referenceCode] : []
      }
      let targetNodeId: string
      let requestedCanvas: IFreeCanvasProject
      try {
        if (delivery.request.kind === 'storyboard.create') {
          const storyboardDelivery = delivery as BridgeStoryboardCreateDelivery
          const sources = baseCanvas.nodes.filter(node => (
            node.kind === 'document'
            && node.referenceCode === storyboardDelivery.request.payload.sourceDocumentCode
          ))
          if (sources.length !== 1 || sources[0].kind !== 'document') {
            window.alert('外部 Agent 分镜来源文档不在当前 Canvas 权威快照中，请刷新后重试。')
            return []
          }
          const node = createBridgeStoryboardNode(
            storyboardDelivery,
            application,
            sources[0],
            nextNodePosition(reactFlow, baseCanvas.nodes.length)
          )
          targetNodeId = node.id
          requestedCanvas = {
            ...baseCanvas,
            selectedNodeId: node.id,
            nodes: [...baseCanvas.nodes, node]
          }
        } else {
          const storyboardDelivery = delivery as BridgeStoryboardChangeDelivery
          const targets = baseCanvas.nodes.filter(node => (
            node.kind === 'storyboard'
            && node.referenceCode === storyboardDelivery.request.target.storyboardCode
          ))
          if (targets.length !== 1 || targets[0].kind !== 'storyboard') {
            window.alert('外部 Agent 分镜目标不在当前 Canvas 权威快照中，请刷新后重试。')
            return []
          }
          const node = applyBridgeStoryboardChange(targets[0], storyboardDelivery, application)
          targetNodeId = node.id
          requestedCanvas = {
            ...baseCanvas,
            selectedNodeId: node.id,
            nodes: baseCanvas.nodes.map(candidate => candidate.id === node.id ? node : candidate)
          }
        }
      } catch {
        window.alert('外部 Agent 分镜提案未通过本地完整性校验。')
        return []
      }
      let receipt: boolean | FreeCanvasPersistReceipt = false
      try {
        receipt = await onPersistCanvas(requestedCanvas)
      } catch {
        receipt = false
      }
      if (!sameProjectMutationScope(activeProjectScopeRef.current, scope)) return []
      const winningCanvas = authoritativePersistedCanvas(receipt)
      if (!winningCanvas) return []
      const winning = inspectBridgeStoryboardApplication(winningCanvas, application)
      const liveCanvas = freeCanvasRef.current
      const liveChanged = canvasSnapshotIdentity(liveCanvas) !== canvasSnapshotIdentity(baseCanvas)
        && canvasSnapshotIdentity(liveCanvas) !== canvasSnapshotIdentity(winningCanvas)
      if (winning.status === 'exact' && !liveChanged) {
        if (!winning.node.referenceCode) return []
        commitCanvasSelection(winningCanvas, targetNodeId)
        return [winning.node.referenceCode]
      }
      if (winning.status === 'conflict') {
        window.alert('持久化返回的外部 Agent 分镜目标或标记完整性校验失败。')
        return []
      }
      freeCanvasRef.current = liveChanged ? liveCanvas : winningCanvas
    }
    window.alert('Canvas 在保存期间持续变化，请重试外部 Agent 分镜提案。')
    return []
  }

  const handleAcceptBridgeDelivery = async (delivery: BridgeDelivery): Promise<string[]> => (
    isBridgePromptDelivery(delivery)
      ? handleAcceptBridgePromptDelivery(delivery)
      : isBridgeDocumentDelivery(delivery)
        ? handleAcceptBridgeDocumentDelivery(delivery)
        : isBridgeStoryboardDelivery(delivery)
          ? handleAcceptBridgeStoryboardDelivery(delivery)
          : handleAcceptBridgeImageDelivery(delivery as BridgeImageDelivery)
  )

  const handleApplyAgentProposal = async (proposal: AgentWorkspaceProposal | AgentCanvasEdit) => {
    if (
      proposal.kind === 'document_create'
      || proposal.kind === 'document_changes'
      || proposal.kind === 'storyboard_create'
      || proposal.kind === 'storyboard_changes'
    ) {
      const scope = activeProjectScopeRef.current
      return enqueueDocumentMutation(scope, async () => {
        const acknowledgeFailure = async (
          errorCode: 'failed_conflict' | 'failed_integrity' | 'failed_target_missing' | 'save_failed'
        ) => {
          try {
            await agentRuntimeService.acknowledgeDocumentEdit(
              activeProject.id,
              proposal.conversationId,
              proposal.editId,
              { requestId: proposal.requestId, status: 'failed', errorCode }
            )
          } catch {
            // Failure acknowledgement is advisory; Gateway owns the terminal state.
          }
          return false
        }
        const confirmAppliedAcknowledgement = async () => {
          const acknowledgementRequest = () => agentRuntimeService.acknowledgeDocumentEdit(
            activeProject.id,
            proposal.conversationId,
            proposal.editId,
            { requestId: proposal.requestId, status: 'applied' }
          )
          const reconciliationLease = {
            projectId: activeProject.id,
            conversationId: proposal.conversationId,
            leaseId: `saved-agent-edit:${activeProject.id}:${proposal.conversationId}:${proposal.editId}`,
            nodeId: proposal.nodeId
          }
          const recoveryTarget = {
            ...reconciliationLease,
            requestId: proposal.requestId,
            editId: proposal.editId
          }
          const retainAmbiguousRecoveryLock = (
            proposal.kind === 'storyboard_create' || proposal.kind === 'storyboard_changes'
          )
          const isExpectedStatus = (status: {
            conversationId?: unknown
            requestId?: unknown
            editId?: unknown
          }) => (
            status.conversationId === proposal.conversationId
            && status.requestId === proposal.requestId
            && status.editId === proposal.editId
          )
          const finishExactStatus = (response: Awaited<ReturnType<typeof acknowledgementRequest>>) => {
            if (!isExpectedStatus(response)) throw new Error('agent_edit_ack_identity_mismatch')
            if (response.status === 'pending_apply') {
              if (retainAmbiguousRecoveryLock) {
                updateDocumentReconcileLease({ ...reconciliationLease, pending: true })
                return startStoryboardAckRecovery(recoveryTarget)
              }
              return false
            }
            stopStoryboardAckRecovery(reconciliationLease.leaseId, response.status === 'applied')
            updateDocumentReconcileLease({ ...reconciliationLease, pending: false })
            return response.status === 'applied'
          }
          try {
            return finishExactStatus(await acknowledgementRequest())
          } catch {
            try {
              return finishExactStatus(await acknowledgementRequest())
            } catch {
              try {
                const reconciliation = await agentRuntimeService.reconcileDocumentEdits(
                  activeProject.id,
                  proposal.conversationId
                )
                if (reconciliation.status === 'idle' || reconciliation.status === 'pending_apply') {
                  if (retainAmbiguousRecoveryLock) {
                    updateDocumentReconcileLease({ ...reconciliationLease, pending: true })
                    return startStoryboardAckRecovery(recoveryTarget)
                  }
                  return false
                }
                if (!isExpectedStatus(reconciliation)) {
                  if (retainAmbiguousRecoveryLock) {
                    updateDocumentReconcileLease({ ...reconciliationLease, pending: true })
                    return startStoryboardAckRecovery(recoveryTarget)
                  }
                  return false
                }
                stopStoryboardAckRecovery(
                  reconciliationLease.leaseId,
                  reconciliation.status === 'applied'
                )
                updateDocumentReconcileLease({ ...reconciliationLease, pending: false })
                return reconciliation.status === 'applied'
              } catch {
                if (retainAmbiguousRecoveryLock) {
                  updateDocumentReconcileLease({ ...reconciliationLease, pending: true })
                  return startStoryboardAckRecovery(recoveryTarget)
                }
                return false
              }
            }
          }
        }
        if (!sameProjectMutationScope(activeProjectScopeRef.current, scope)) return false

        const beforeCanvas = freeCanvasRef.current
        const authorityMatches = beforeCanvas.nodes.filter(node => node.id === proposal.nodeId)
        if (authorityMatches.length > 1) return acknowledgeFailure('failed_integrity')
        const existing = authorityMatches[0]
        if (
          (existing?.kind === 'document' || existing?.kind === 'storyboard') &&
          existing.agentAppliedEdit?.conversationId === proposal.conversationId &&
          existing.agentAppliedEdit.requestId === proposal.requestId &&
          existing.agentAppliedEdit.editId === proposal.editId &&
          existing.agentAppliedEdit.resultDigest === proposal.expectedResultDigest &&
          (existing.kind === 'document'
            ? existing.document.digest
            : existing.digest ?? storyboardDigest(existing.sequence, existing.pendingFieldChanges)) === proposal.expectedResultDigest
        ) {
          return confirmAppliedAcknowledgement()
        }
        if (proposal.base.projectRevision !== activeProject.revision) {
          return acknowledgeFailure('failed_conflict')
        }

        const marker = {
          conversationId: proposal.conversationId,
          requestId: proposal.requestId,
          editId: proposal.editId,
          resultDigest: proposal.expectedResultDigest
        }
        const hasExpectedAppliedAuthority = (canvas: IFreeCanvasProject) => {
          const node = exactCanvasNode(canvas, proposal.nodeId)
          return (node?.kind === 'document' || node?.kind === 'storyboard')
            && node.agentAppliedEdit?.conversationId === marker.conversationId
            && node.agentAppliedEdit.requestId === marker.requestId
            && node.agentAppliedEdit.editId === marker.editId
            && node.agentAppliedEdit.resultDigest === marker.resultDigest
            && (node.kind === 'document'
              ? node.document.digest
              : node.digest ?? storyboardDigest(node.sequence, node.pendingFieldChanges)) === proposal.expectedResultDigest
        }
        let executed: ReturnType<typeof executeCanvasLocalCommand>
        try {
          if (proposal.kind === 'document_create') {
            if (existing) return acknowledgeFailure('failed_conflict')
            const document = createPlanningDocumentV1(proposal.payload.blocks)
            if (document.digest !== proposal.expectedResultDigest) {
              return acknowledgeFailure('failed_integrity')
            }
            executed = executeCanvasLocalCommand(canvasCommandHistoryRef.current, beforeCanvas, {
              kind: 'insert-node',
              index: beforeCanvas.nodes.length,
              node: {
                id: proposal.nodeId,
                kind: 'document',
                title: proposal.payload.title,
                position: nextNodePosition(reactFlow, beforeCanvas.nodes.length),
                width: 560,
                height: 420,
                document,
                linkedDocumentResourceIds: [...proposal.payload.linkedDocumentResourceIds],
                ...(proposal.provenance ? { provenance: proposal.provenance } : {}),
                agentAppliedEdit: marker,
                meta: {}
              }
            })
          } else if (proposal.kind === 'document_changes') {
            if (!existing || existing.kind !== 'document') {
              return acknowledgeFailure('failed_target_missing')
            }
            if (
              existing.document.revision !== proposal.base.nodeRevision ||
              existing.document.digest !== proposal.base.nodeDigest
            ) {
              return acknowledgeFailure('failed_conflict')
            }
            const document = applyDocumentChangeOperations(
              existing.document,
              proposal.editId,
              proposal.payload.operations
            )
            if (document.digest !== proposal.expectedResultDigest) {
              return acknowledgeFailure('failed_integrity')
            }
            executed = executeCanvasLocalCommand(canvasCommandHistoryRef.current, beforeCanvas, {
              kind: 'update-document',
              nodeId: proposal.nodeId,
              document
            })
          } else if (proposal.kind === 'storyboard_create') {
            if (existing) return acknowledgeFailure('failed_conflict')
            const storyboard = createStoryboardNode(
              proposal,
              nextNodePosition(reactFlow, beforeCanvas.nodes.length)
            )
            executed = executeCanvasLocalCommand(canvasCommandHistoryRef.current, beforeCanvas, {
              kind: 'insert-node',
              index: beforeCanvas.nodes.length,
              node: storyboard
            })
          } else {
            if (!existing || existing.kind !== 'storyboard') {
              return acknowledgeFailure('failed_target_missing')
            }
            const storyboard = applyStoryboardChanges(existing, proposal)
            executed = executeCanvasLocalCommand(canvasCommandHistoryRef.current, beforeCanvas, {
              kind: 'update-storyboard',
              nodeId: proposal.nodeId,
              storyboard
            })
          }
        } catch {
          return acknowledgeFailure('failed_integrity')
        }

        const persistedCanvas = {
          ...executed.project,
          nodes: executed.project.nodes.map(node => (
            node.id === proposal.nodeId && (node.kind === 'document' || node.kind === 'storyboard')
              ? { ...node, agentAppliedEdit: marker }
              : node
          ))
        }
        if (!hasExpectedAppliedAuthority(persistedCanvas)) {
          return acknowledgeFailure('failed_integrity')
        }
        emitGenerationCanvas(persistedCanvas)
        if (!onPersistCanvas) {
          emitGenerationCanvas(beforeCanvas)
          return acknowledgeFailure('save_failed')
        }
        let receipt: boolean | FreeCanvasPersistReceipt = false
        try {
          receipt = await onPersistCanvas(persistedCanvas)
        } catch {
          receipt = false
        }
        if (!receipt) {
          if (sameProjectMutationScope(activeProjectScopeRef.current, scope)) {
            emitGenerationCanvas(beforeCanvas)
          }
          return acknowledgeFailure('save_failed')
        }
        const authoritativeCanvas = authoritativePersistedCanvas(receipt)
        if (
          (authoritativeCanvas && !hasExpectedAppliedAuthority(authoritativeCanvas))
          || !hasExpectedAppliedAuthority(freeCanvasRef.current)
        ) {
          return acknowledgeFailure('failed_integrity')
        }
        if (sameProjectMutationScope(activeProjectScopeRef.current, scope)) {
          canvasCommandHistoryRef.current = executed.history
        }

        return confirmAppliedAcknowledgement()
      })
    }
    if (proposal.kind === 'free_canvas_text_insertions') {
      const currentCanvas = freeCanvasRef.current
      const target = currentCanvas.nodes.find((node): node is IFreeCanvasTextNode => (
        node.id === proposal.nodeId && node.kind === 'text'
      ))
      if (!target) {
        window.alert('目标文字节点已不存在，请让 Agent 重新生成提案。')
        return false
      }
      const basisMatches = matchesFreeCanvasTextProposalBasis(target, proposal, {
        templateDigest: await freeCanvasTemplateDigest(target),
        baseSegmentsDigest: await freeCanvasSegmentsDigest(target)
      })
      if (!basisMatches) {
        window.alert('提示词节点已发生变化，请让 Agent 重新生成提案。')
        return false
      }
      const applied = applyFreeCanvasTextInsertions(currentCanvas, target.id, proposal.insertions)
      if (applied.rejectionReason) {
        window.alert('插入锚点已失效，请让 Agent 重新生成提案。')
        return false
      }
      onChange(applied.project)
      return true
    }
    if (proposal.kind === 'free_canvas_text_update') {
      const target = freeCanvas.nodes.find(node => node.id === proposal.nodeId)
      if (!target || target.kind !== 'text') {
        window.alert('目标文字节点已不存在，请让 Agent 重新生成提案。')
        return false
      }
      const currentRevision = target?.kind === 'text'
        ? Math.max(0, ...target.segments.map(segment => segment.updatedAt))
        : undefined
      if (proposal.baseNodeRevision !== undefined && currentRevision !== proposal.baseNodeRevision) {
        window.alert('提示词节点或模板已发生变化，请让 Agent 重新生成提案。')
        return false
      }
      const currentUserText = freeCanvasUserText(target)
      if (proposal.baseContentDigest && await sha256Text(currentUserText) !== proposal.baseContentDigest) {
        window.alert('用户文字已发生变化，请让 Agent 重新生成提案。')
        return false
      }
      if (proposal.templateDigest && await freeCanvasTemplateDigest(target) !== proposal.templateDigest) {
        window.alert('模板已发生变化，请让 Agent 重新生成提案。')
        return false
      }
      if (proposal.editMode === 'append') {
        onChange(appendFreeCanvasUserText(freeCanvas, proposal.nodeId, proposal.userText))
        return true
      }
      if (proposal.editMode === 'rewrite_all') {
        onChange(updateFreeCanvasTextNodeUserText(freeCanvas, proposal.nodeId, proposal.userText, 'replace'))
        return true
      }
      const selection = proposal.selection
      if (!selection
        || selection.start < 0
        || selection.end <= selection.start
        || selection.end > currentUserText.length
        || currentUserText.slice(selection.start, selection.end) !== selection.selectedText
      ) {
        window.alert('文字选区已失效，请重新选择后让 Agent 生成提案。')
        return false
      }
      onChange(replaceFreeCanvasUserTextRange(
        freeCanvas,
        proposal.nodeId,
        { start: selection.start, end: selection.end },
        proposal.userText
      ))
      return true
    }
    if (proposal.kind === 'free_canvas_text_create') {
      const currentCanvas = freeCanvasRef.current
      if (proposal.handoffBasis) {
        const basis = proposal.handoffBasis
        if (!promptHandoffSourceIsCurrent(currentCanvas, basis)) {
          window.alert('规划来源已发生变化，请重新生成 Prompt 提案。')
          return false
        }
        const scope = activeProjectScopeRef.current
        if (!onPersistCanvas || !sameProjectMutationScope(activeProjectScopeRef.current, scope)) return false
        const application = await createPromptHandoffApplication(proposal)
        if (!application) {
          window.alert('Prompt 提案缺少可信的会话或运行来源，请重新生成。')
          return false
        }
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const baseCanvas = freeCanvasRef.current
          const existing = inspectPromptHandoffApplication(baseCanvas, application)
          if (existing.status === 'exact') return true
          if (existing.status === 'conflict') {
            window.alert('已保存的 Prompt handoff 标记完整性校验失败，无法重复应用。')
            return false
          }
          if (!promptHandoffSourceIsCurrent(baseCanvas, basis)) {
            window.alert('规划来源已发生变化，请重新生成 Prompt 提案。')
            return false
          }
          const node = createPromptHandoffNode(
            proposal,
            application,
            nextNodePosition(reactFlow, baseCanvas.nodes.length)
          )
          const requestedCanvas = {
            ...baseCanvas,
            selectedNodeId: node.id,
            nodes: [...baseCanvas.nodes, node]
          }
          let receipt: boolean | FreeCanvasPersistReceipt = false
          try {
            receipt = await onPersistCanvas(requestedCanvas)
          } catch {
            receipt = false
          }
          if (!sameProjectMutationScope(activeProjectScopeRef.current, scope)) return false
          const winningCanvas = authoritativePersistedCanvas(receipt)
          if (!winningCanvas) return false
          const winning = inspectPromptHandoffApplication(winningCanvas, application)
          const liveCanvas = freeCanvasRef.current
          const liveChanged = canvasSnapshotIdentity(liveCanvas) !== canvasSnapshotIdentity(baseCanvas)
            && canvasSnapshotIdentity(liveCanvas) !== canvasSnapshotIdentity(winningCanvas)
          if (winning.status === 'exact' && !promptHandoffSourceIsCurrent(winningCanvas, basis)) {
            window.alert('规划来源已发生变化，请重新生成 Prompt 提案。')
            return false
          }
          if (winning.status === 'exact' && !liveChanged) {
            commitCanvasSelection(winningCanvas, application.nodeId)
            return true
          }
          if (winning.status === 'conflict') {
            window.alert('持久化返回的 Prompt handoff 标记完整性校验失败。')
            return false
          }
          // A superseding same-project save won, or the Canvas changed while this
          // save was in flight. The next iteration rebases the same deterministic
          // application identity onto the latest authoritative Canvas.
          freeCanvasRef.current = liveChanged ? liveCanvas : winningCanvas
        }
        window.alert('Canvas 在保存期间持续变化，请重试 Prompt 提案。')
        return false
      }
      if (proposal.sourceNodeId) {
        const source = currentCanvas.nodes.find((node): node is IFreeCanvasTextNode => (
          node.id === proposal.sourceNodeId && node.kind === 'text'
        ))
        if (!source || !proposal.basis) {
          window.alert('改写来源节点已不存在，请让 Agent 重新生成提案。')
          return false
        }
        const basisMatches = matchesFreeCanvasTextProposalBasis(source, proposal.basis, {
          templateDigest: await freeCanvasTemplateDigest(source),
          baseSegmentsDigest: await freeCanvasSegmentsDigest(source)
        })
        if (!basisMatches) {
          window.alert('改写来源已发生变化，请让 Agent 重新生成提案。')
          return false
        }
        const rewrite = createFreeCanvasAgentRewriteNode(
          currentCanvas,
          source,
          proposal.userText,
          proposal.basis,
          Date.now(),
          proposal.provenance
        )
        commitCanvasSelection({
          ...currentCanvas,
          nodes: [...currentCanvas.nodes, rewrite]
        }, rewrite.id)
        return true
      }
      const node = createFreeCanvasTextNode(
        proposal.userText,
        nextNodePosition(reactFlow, freeCanvas.nodes.length)
      )
      commitCanvasSelection({
        ...freeCanvas,
        nodes: [
          ...freeCanvas.nodes,
          {
            ...node,
            title: proposal.title?.trim() || node.title
          }
        ]
      }, node.id)
      return true
    }
  }

  const createQuickPreset = async (draft: QuickMessageDraft) => {
    const name = draft.name.trim()
    const body = draft.body.trim()
    if (!name || !body) return
    await addPreset(createQuickMessagePresetInput({ name, body }, { createdAt: Date.now() }))
  }

  const openQuickPresetComposer = (preset?: IPreset) => {
    if (preset) {
      setQuickEditingPresetId(preset.id)
      setQuickPresetDraft(quickMessagePresetToDraft(preset))
    } else {
      setQuickEditingPresetId(null)
      setQuickPresetDraft(emptyQuickTextPresetDraft)
    }
    setQuickDrawerOpen(false)
    setQuickComposerOpen(true)
  }

  const closeQuickPresetComposer = () => {
    setQuickComposerOpen(false)
    setQuickEditingPresetId(null)
    setQuickPresetDraft(emptyQuickTextPresetDraft)
  }

  const saveQuickPresetDraft = async () => {
    const name = quickPresetDraft.name.trim()
    const body = quickPresetDraft.body.trim()
    if (!name || !body) return
    if (quickEditingPresetId) {
      await updatePreset(quickEditingPresetId, createQuickMessagePresetInput({ name, body }))
    } else {
      await createQuickPreset({ name, body })
    }
    closeQuickPresetComposer()
  }

  const deleteQuickPresetDraft = async () => {
    if (!quickEditingPresetId) return
    await deletePreset(quickEditingPresetId)
    closeQuickPresetComposer()
  }

  return (
    <section
      data-free-canvas-screen
      className="fixed inset-x-0 bottom-0 top-14 z-20 overflow-hidden bg-[#f7f8fb]"
      onDropCapture={handleRootDropCapture}
    >
      <header className="absolute left-4 top-4 z-40 flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-1 rounded-2xl border border-gray-200 bg-white/95 px-2 py-2 shadow-sm sm:gap-2 sm:rounded-full">
        <ToolbarButton title="Back" onClick={onBack}><ArrowLeft className="h-4 w-4" /></ToolbarButton>
        <button type="button" className="min-w-0 max-w-32 px-2 text-left sm:max-w-64 sm:px-3" onClick={onRenameProject}>
          <div className="truncate text-sm font-black text-gray-950">{activeProject.title}</div>
          <div className="text-[11px] font-semibold text-gray-400">Free Canvas</div>
        </button>
        <CanvasProjectReferenceCodeAction project={activeProject} />
        <CopyCodexContext
          project={activeProject}
          nodes={freeCanvas.nodes}
          selectedNodeIds={selectedNodeIds}
          onActiveContextChange={context => changeActiveBridgeContext(context?.cvcCode || null)}
          prepareProjectRevision={prepareContextPackRevision}
        />
        <ToolbarButton title="Save" onClick={onSave}><Save className="h-4 w-4" /></ToolbarButton>
      </header>

      <ProjectResourceLibrary
        projectId={activeProject.id}
        expanded={resourceLibraryExpanded}
        onExpandedChange={setResourceLibraryExpanded}
        onPlaceMaterial={placeProjectMaterial}
        onAddSubject={addProjectSubjectToComposer}
      />

      <div
        className={`relative h-full transition-[padding] ${
          rightPanelCollapsed ? 'pr-14' : 'pr-[456px]'
        } ${resourceLibraryExpanded ? 'xl:pl-[292px]' : ''}`}
      >
        <div
          data-free-canvas-dropzone
          className={`relative h-full ${resourceLibraryExpanded ? 'ml-[292px] xl:ml-0' : ''}`}
          onDragEnter={handleDragEnter}
          onDragOver={event => {
            if (!isCanvasImageDrag(event.dataTransfer)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <ReactFlow
            nodes={flowNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            deleteKeyCode={null}
            onNodesChange={handleNodesChange}
            onNodeClick={handleNodeClick}
            onNodeContextMenu={handleNodeContextMenu}
            onNodeDoubleClick={handleNodeDoubleClick}
            onNodeDragStop={handleNodeDragStop}
            onSelectionChange={handleSelectionChange}
            onMoveStart={() => setNodeContextMenu(null)}
            onConnect={handleConnect}
            isValidConnection={isValidConnection}
            onEdgeClick={handleEdgeClick}
            onPaneClick={() => {
              setNodeContextMenu(null)
              setSelectedNodeId(null)
              setSelectedEdgeId(null)
              setEditingNodeId(null)
              if (window.innerWidth < 1440) setResourceLibraryExpanded(false)
            }}
            panOnScroll
            panOnDrag={false}
            selectionOnDrag
            autoPanOnSelection={false}
            panActivationKeyCode="Space"
            selectionMode={SelectionMode.Partial}
            fitView
            minZoom={0.2}
            maxZoom={2}
          >
            <Background variant={BackgroundVariant.Lines} gap={28} size={1} color="#e2e8f0" />
            <MiniMap pannable zoomable className="!bottom-6 !left-auto !right-16" />
            <Controls className="!bottom-6 !left-auto !right-4" />
          </ReactFlow>
          {nodeContextMenu && (() => {
            const contextNode = freeCanvas.nodes.find(node => node.id === nodeContextMenu.nodeId)
            if (!contextNode) return null
            if (contextNode.kind === 'text') {
              return (
                <CanvasTextNodeContextMenu
                  position={{ x: nodeContextMenu.x, y: nodeContextMenu.y }}
                  node={contextNode}
                  completeDisabled={previewMode}
                  imageGenerationDisabled={
                    previewMode
                    || !imageGenerationNodeV1
                    || !freeCanvasTextSegmentsToPlainText(contextNode.segments).trim()
                  }
                  onExecute={command => executeTextCommand(contextNode.id, command)}
                  onClose={closeNodeContextMenu}
                />
              )
            }
            if (contextNode.kind === 'document') return null
            if (contextNode.kind !== 'image') {
              return (
                <CanvasUnsupportedNodeContextMenu
                  position={{ x: nodeContextMenu.x, y: nodeContextMenu.y }}
                  node={contextNode}
                  onClose={closeNodeContextMenu}
                />
              )
            }
            const selectionCount = selectedNodeIds.includes(contextNode.id)
              ? Math.max(1, selectedNodeIds.length)
              : 1
            return (
              <CanvasNodeContextMenu
                position={{ x: nodeContextMenu.x, y: nodeContextMenu.y }}
                node={contextNode}
                commands={resolveCommandsForImageNode(contextNode, selectionCount)}
                onExecute={commandId => executeImageCommand(contextNode.id, commandId)}
                onClose={closeNodeContextMenu}
              />
            )
          })()}
          {fileDragActive && (
            <div className="pointer-events-none absolute inset-4 z-40 flex items-center justify-center rounded-[18px] border-2 border-dashed border-sky-300 bg-sky-50/75 text-sm font-black text-sky-700">
              松开以添加图片
            </div>
          )}
        </div>

        <CanvasBottomToolbar
          positionClassName={
            resourceLibraryExpanded
              ? rightPanelCollapsed
                ? 'left-[calc(50%_-_28px)] xl:left-[calc(50%_+_118px)]'
                : 'left-[calc(50%_-_228px)] xl:left-[calc(50%_-_82px)]'
              : rightPanelCollapsed
                ? 'left-[calc(50%_-_28px)]'
                : 'left-[calc(50%_-_228px)]'
          }
          quickDrawerOpen={quickDrawerOpen}
          quickPresets={quickPresets}
          onCreateText={createText}
          onCreateDocument={createDocument}
          onCreateImage={createImage}
          onCreateImageGenerator={openImageGeneration}
          onToggleQuickDrawer={() => setQuickDrawerOpen(value => !value)}
          onOpenQuickPresetComposer={() => openQuickPresetComposer()}
          onEditQuickPreset={openQuickPresetComposer}
          onUseQuickPreset={createQuickText}
        />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          tabIndex={-1}
          onChange={handleImageInputChange}
        />

        {quickComposerOpen && (
          <QuickMessageDialog
            draft={quickPresetDraft}
            editing={Boolean(quickEditingPresetId)}
            rightOffset={rightPanelCollapsed ? 56 : 456}
            onDraftChange={setQuickPresetDraft}
            onClose={closeQuickPresetComposer}
            onDelete={quickEditingPresetId ? () => { void deleteQuickPresetDraft() } : undefined}
            onSave={() => { void saveQuickPresetDraft() }}
          />
        )}

        {uploadError && (
          <div className="absolute left-1/2 top-5 z-50 -translate-x-1/2 rounded-full border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 shadow-lg" role="alert">
            {uploadError}
          </div>
        )}
        {clipboardNotice && (
          <div className="absolute left-1/2 top-5 z-50 -translate-x-1/2 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-800 shadow-lg" role="status">
            {clipboardNotice}
          </div>
        )}
        {selectedMultiViewGroup && !resourceLibraryExpanded && (
          <MultiViewGroupPanel
            groupId={selectedMultiViewGroup.groupId}
            members={selectedMultiViewGroup.members}
            sourceAvailable={selectedMultiViewGroup.sourceAvailable}
            onSelect={selectMultiViewMember}
            onRetry={retryMultiViewMember}
            onUseAsReference={useMultiViewMemberAsReference}
          />
        )}
        {cropNode && (
          <ImageCropEditor
            media={imageNodeToMedia(cropNode)}
            imageUrl={cropNode.assetId ? canvasImageAssetUrl(cropNode.assetId) : cropNode.imageUrl || ''}
            onCancel={cancelImageCrop}
            onConfirm={confirmImageCrop}
          />
        )}
        {annotationEditorNode && (
          <ImageAnnotationEditor
            node={annotationEditorNode}
            imageUrl={annotationEditorNode.assetId ? canvasImageAssetUrl(annotationEditorNode.assetId) : annotationEditorNode.imageUrl || ''}
            onCancel={() => setAnnotationEditorNodeId(null)}
            onSave={annotations => saveImageAnnotations(annotationEditorNode.id, annotations)}
          />
        )}
        {imageOperationPreparing && (
          <div className="fixed inset-0 z-[89] flex items-center justify-center bg-gray-950/45 backdrop-blur-sm" role="status">
            <div className="flex items-center gap-3 rounded-full bg-white px-5 py-3 text-sm font-bold text-gray-700 shadow-xl">
              <Loader2 className="h-4 w-4 animate-spin text-[#c96442]" />
              正在准备所见画面的模型输入…
            </div>
          </div>
        )}
        {activeImageOperationDraft?.operation === 'multi-view' && selectedImageModel && (
          <MultiViewWorkbenchDialog
            key={`multi-view:${activeImageOperationDraft.source.nodeId}`}
            initialDraft={activeImageOperationDraft}
            initialSelectedViewIds={activeImageOperationDraft.viewSpec ? [activeImageOperationDraft.viewSpec] : undefined}
            modelLabel={selectedImageModel.displayName}
            externalBlockingIssues={imageOperationExternalIssues}
            onCancel={() => setActiveImageOperationDraft(null)}
            onGenerate={(draft, selectedViewIds) => submitMultiViewOperation(
              draft,
              selectedViewIds,
              activeImageOperationDraft.operationItemId
                && activeImageOperationDraft.operationGroupId
                && activeImageOperationDraft.viewSpec
                && activeImageOperationDraft.retryNodeId
                ? {
                    nodeId: activeImageOperationDraft.retryNodeId,
                    operationGroupId: activeImageOperationDraft.operationGroupId,
                    operationItemId: activeImageOperationDraft.operationItemId,
                    viewSpec: activeImageOperationDraft.viewSpec,
                    source: {
                      nodeId: activeImageOperationDraft.source.nodeId,
                      originalAssetId: activeImageOperationDraft.source.originalAssetId,
                      canvasAssetId: activeImageOperationDraft.source.canvasAssetId,
                      providerAssetId: activeImageOperationDraft.source.providerAssetId
                    }
                  }
                : null
            )}
          />
        )}
        {activeImageOperationDraft && activeImageOperationDraft.operation !== 'multi-view' && selectedImageModel && (
          <ImageOperationWorkbenchDialog
            key={`${activeImageOperationDraft.operation}:${activeImageOperationDraft.source.nodeId}`}
            initialDraft={activeImageOperationDraft}
            modelLabel={selectedImageModel.displayName}
            maximumInputs={maximumOperationInputs}
            externalBlockingIssues={imageOperationExternalIssues}
            onImportReferences={importImageOperationReferences}
            onCancel={() => setActiveImageOperationDraft(null)}
            onGenerate={submitImageOperation}
          />
        )}
      </div>

      {rightPanelCollapsed ? (
        <button
          type="button"
          className="absolute right-2 top-2 z-40 flex h-10 w-10 items-center justify-center rounded-[10px] border border-[#e5e7eb] bg-white/95 text-[#5e5d59] shadow-[0_4px_18px_rgba(20,20,19,0.08)] transition hover:bg-[#f9fafb] hover:text-[#141413]"
          onClick={() => setRightPanelCollapsed(false)}
          title="Open Agent panel"
        >
          <Bot className="h-4 w-4" />
        </button>
      ) : (
        <aside
          data-free-canvas-composer-dropzone
          className="absolute bottom-0 right-0 top-0 z-30 flex w-[456px] max-w-[calc(100%_-_56px)] flex-col overflow-hidden border-l border-[#e5e7eb] bg-white"
          onDragEnter={handleComposerDragEnter}
          onDragOver={handleComposerDragOver}
          onDragLeave={handleComposerDragLeave}
          onDrop={handleComposerDrop}
        >
          {composerFileDragActive && (
            <div className="pointer-events-none absolute inset-2 z-[70] grid place-items-center rounded-xl border-2 border-dashed border-violet-300 bg-violet-50/90 px-5 text-center backdrop-blur-sm">
              <div>
                <ImageIcon className="mx-auto h-6 w-6 text-violet-600" />
                <div className="mt-2 text-xs font-black text-gray-950">松开以加入本轮参考图</div>
                <div className="mt-1 text-[10px] text-gray-500">仅加入草稿，不会自动发送</div>
              </div>
            </div>
          )}
          <div className="shrink-0 border-b border-[#e5e7eb] bg-white">
            <div className="flex h-11 items-center justify-between gap-2 px-3">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-[13px] font-bold text-[#141413]">
                  {rightPanelMode === 'image-generation'
                    ? '图片生成'
                    : rightPanelMode === 'prompt-library'
                      ? 'Prompt 库'
                      : selectedNode?.title || 'Free Canvas'}
                </h2>
                {rightPanelMode === 'image-generation' && (
                  <span className={`inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold ${
                    imageModelUsable ? 'text-emerald-700' : 'text-amber-700'
                  }`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${imageModelUsable ? 'bg-emerald-600' : 'bg-amber-500'}`} />
                    {imageModelUsable ? '模型已就绪' : '待配置'}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#87867f] transition hover:bg-[#f3f4f6] hover:text-[#141413]"
                onClick={() => setRightPanelCollapsed(true)}
                title="Collapse Agent panel"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mx-2 mb-2 grid h-8 grid-cols-3 gap-0.5 rounded-[9px] bg-[#f3f4f6] p-0.5" data-free-canvas-panel-switcher>
              <PanelModeButton
                active={rightPanelMode === 'agent'}
                label="Agent"
                icon={<Bot className="h-3.5 w-3.5" />}
                onClick={() => setRightPanelMode('agent')}
              />
              <PanelModeButton
                active={rightPanelMode === 'image-generation'}
                label="图片生成"
                icon={<ImageIcon className="h-3.5 w-3.5" />}
                onClick={() => setRightPanelMode('image-generation')}
              />
              <PanelModeButton
                active={rightPanelMode === 'prompt-library'}
                label="Prompt库"
                icon={<BookOpen className="h-3.5 w-3.5" />}
                onClick={() => setRightPanelMode('prompt-library')}
              />
            </div>
          </div>
          {rightPanelMode === 'image-generation' ? (
            <div className="min-h-0 flex-1" data-free-canvas-image-generation-panel>
              <ImageGenerationConversationPanel
                projectLabel={activeProject.title}
                conversationLabel={activeConversationLabel}
                statusLabel={imageModelUsable ? '默认图片模型已就绪' : '图片模型待配置'}
                statusReady={imageModelUsable}
                onConfigureModel={onConfigureImageModel ? () => onConfigureImageModel({ projectId: activeProject.id, returnTarget: 'free-canvas' }) : undefined}
                onOpenSubjectLibrary={() => setResourceLibraryExpanded(true)}
                turns={currentImageTurns}
                conversations={imageConversationViews}
                onNewConversation={resetImageConversation}
                onContinueConversation={continueImageConversation}
                onOpenHistoryConversation={conversationId => {
                  if (!imageConversationRuns[conversationId]) {
                    void loadImageConversationRuns(activeProject.id, conversationId).catch(() => undefined)
                  }
                }}
                onLoadMoreConversations={imageConversationNextCursor
                  ? () => { void loadImageConversations(activeProject.id, undefined, imageConversationNextCursor) }
                  : undefined}
                onLoadMoreConversationRuns={conversationId => {
                  const cursor = imageRunNextCursors[conversationId]
                  if (cursor) {
                    void loadImageConversationRuns(activeProject.id, conversationId, undefined, cursor)
                  }
                }}
                hasMoreConversations={Boolean(imageConversationNextCursor)}
                hasMoreConversationRuns={conversationId => Boolean(imageRunNextCursors[conversationId])}
                onTurnAction={handleImageTurnAction}
                composer={{
                  prompt: promptDocumentPlainText(imageComposerDraft.promptDocument),
                  onPromptChange: prompt => setImageComposerDraft(current => ({
                    ...current,
                    promptDocument: { version: 1, segments: [{ type: 'text', text: prompt }] }
                  })),
                  promptDocument: imageComposerDraft.promptDocument,
                  onPromptDocumentChange: promptDocument => setImageComposerDraft(current => ({
                    ...current,
                    promptDocument
                  })),
                  unresolvedReferenceIds: unresolvedPromptReferenceIds(
                    imageComposerDraft.promptDocument,
                    imageComposerDraft.inputs
                  ),
                  references: imageComposerDraft.inputs.map(input => ({
                    referenceId: input.referenceId,
                    assetId: input.assetId,
                    sourceAssetId: input.sourceAssetId,
                    label: input.label || input.referenceId,
                    imageUrl: canvasImageAssetUrl(input.assetId),
                    mentioned: imageComposerDraft.promptDocument.segments.some(segment => (
                      segment.type === 'reference' && segment.referenceId === input.referenceId
                    )),
                    role: input.role,
                    order: input.order
                  })),
                  textReferences: imageComposerDraft.textReferences,
                  maxImages: maxComposerImages,
                  onMentionReference: referenceId => setImageComposerDraft(current => {
                    const input = current.inputs.find(candidate => candidate.referenceId === referenceId)
                    if (!input) return current
                    const mentioned = current.promptDocument.segments.some(segment => (
                      segment.type === 'reference' && segment.referenceId === referenceId
                    ))
                    return {
                      ...current,
                      promptDocument: {
                        version: 1,
                        segments: mentioned
                          ? current.promptDocument.segments.filter(segment => (
                              segment.type !== 'reference' || segment.referenceId !== referenceId
                            ))
                          : [
                              ...current.promptDocument.segments,
                              { type: 'reference', referenceId, label: input.label || referenceId }
                            ]
                      }
                    }
                  }),
                  onRemoveReference: referenceId => setImageComposerDraft(current => ({
                    ...current,
                    inputs: current.inputs.filter(input => input.referenceId !== referenceId).map((input, order) => ({ ...input, order })),
                    regions: current.regions.filter(region => region.referenceId !== referenceId)
                  })),
                  onRemoveTextReference: nodeId => setImageComposerDraft(current => (
                    removeConversationTextReference(current, nodeId)
                  )),
                  onMoveReference: (referenceId, direction) => setImageComposerDraft(current => ({
                    ...current,
                    inputs: moveComposerImageInput(current.inputs.map(input => ({
                      ...input,
                      label: input.label || input.referenceId,
                      imageUrl: canvasImageAssetUrl(input.assetId)
                    })), referenceId, direction).map(({ imageUrl: _imageUrl, ...input }) => input)
                  })),
                  onReferenceRoleChange: (referenceId, role) => setImageComposerDraft(current => ({
                    ...current,
                    inputs: switchComposerImageInputRole(current.inputs.map(input => ({
                      ...input,
                      label: input.label || input.referenceId,
                      imageUrl: canvasImageAssetUrl(input.assetId)
                    })), referenceId, role).map(({ imageUrl: _imageUrl, ...input }) => input)
                  })),
                  workflows: [
                    { value: 'text-to-image', label: '文生图' },
                    { value: 'reference-generate', label: '参考图生成' },
                    { value: 'smart-edit', label: '智能改图' },
                    { value: 'region-edit', label: '局部修改' }
                  ],
                  workflow: imageComposerDraft.workflow,
                  onWorkflowChange: workflow => setImageComposerDraft(current => ({ ...current, workflow })),
                  models: readyImageBindings.map(({ connection, model }) => ({
                    value: `${connection.id}::${model.id}`,
                    label: `${model.displayName} · ${connection.displayName}`
                  })),
                  modelId: imageComposerDraft.connectionId && imageComposerDraft.modelId
                    ? `${imageComposerDraft.connectionId}::${imageComposerDraft.modelId}`
                    : '',
                  onModelChange: value => {
                    const separator = value.indexOf('::')
                    if (separator < 1) return
                    setImageComposerDraft(current => ({
                      ...current,
                      connectionId: value.slice(0, separator),
                      modelId: value.slice(separator + 2)
                    }))
                  },
                  resolutions: selectedImageModel?.capabilities?.resolutions || ['1K', '2K'],
                  resolution: imageComposerDraft.resolution,
                  onResolutionChange: resolution => setImageComposerDraft(current => ({ ...current, resolution })),
                  aspectRatios: selectedImageModel?.capabilities?.aspectRatios || ['1:1', '16:9', '9:16'],
                  aspectRatio: imageComposerDraft.aspectRatio,
                  onAspectRatioChange: aspectRatio => setImageComposerDraft(current => ({ ...current, aspectRatio })),
                  customWidth: imageComposerDraft.width,
                  customHeight: imageComposerDraft.height,
                  onCustomSizeChange: (width, height) => setImageComposerDraft(current => ({
                    ...current,
                    width,
                    height
                  })),
                  promptOptimizationModes: selectedImageModel?.capabilities?.promptOptimization?.modes || ['standard', 'fast'],
                  promptOptimization: imageComposerDraft.promptOptimization,
                  onPromptOptimizationChange: promptOptimization => setImageComposerDraft(current => ({
                    ...current,
                    promptOptimization
                  })),
                  outputFormats: (selectedImageModel?.capabilities?.outputFormats || ['png', 'jpeg']).filter(format => format === 'png' || format === 'jpeg'),
                  outputFormat: imageComposerDraft.outputFormat,
                  onOutputFormatChange: outputFormat => setImageComposerDraft(current => ({ ...current, outputFormat: outputFormat === 'jpeg' ? 'jpeg' : 'png' })),
                  supportsWatermark: selectedImageModel?.capabilities?.watermark !== false,
                  watermark: imageComposerDraft.watermark,
                  onWatermarkChange: watermark => setImageComposerDraft(current => ({ ...current, watermark })),
                  selectedNode: selectedComposerDescriptor,
                  selectedNodeCount: selectedComposerNodes.length,
                  onInjectSelectedNode: injectSelectedCanvasNodes,
                  onUpload: file => { void uploadImageComposerReference(file) },
                  regionCount: imageComposerDraft.regions.length,
                  onEditRegions: () => setImageRegionEditorOpen(true),
                  onEditAnnotations: referenceId => { void openImageAnnotationEditor(referenceId) },
                  onSubmit: () => { void submitImageConversationTurn() },
                  disabled: imageGenerationBusy,
                  missingRequirements: imageComposerVisibleRequirements,
                  blockingRequirements: imageComposerMissingRequirements
                }}
              />
              {imageRegionEditorOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={event => event.target === event.currentTarget && setImageRegionEditorOpen(false)}>
                  <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white shadow-2xl">
                    <RegionEditorDialog
                      scopeKey={`${activeProject.id}:${activeImageConversationId || 'draft'}`}
                      mode="region-edit"
                      capabilities={{
                        modelId: imageComposerDraft.modelId,
                        regionInputs: (selectedImageModel?.capabilities?.regionInputs || ['point', 'bbox']).filter((input): input is 'point' | 'bbox' => input === 'point' || input === 'bbox')
                      }}
                      sources={imageComposerDraft.inputs.map(input => ({
                        referenceId: input.referenceId,
                        label: input.label || input.referenceId,
                        role: input.role,
                        assetId: input.assetId,
                        imageUrl: canvasImageAssetUrl(input.assetId)
                      }))}
                      initialRegions={imageComposerDraft.regions.map((region, index) => region.type === 'point'
                        ? { id: `draft-point-${index}`, referenceId: region.referenceId, type: 'point' as const, x: region.x, y: region.y }
                        : { id: `draft-bbox-${index}`, referenceId: region.referenceId, type: 'bbox' as const, x: region.x1, y: region.y1, width: region.x2 - region.x1, height: region.y2 - region.y1 })}
                      onSave={regions => {
                        setImageComposerDraft(current => ({
                          ...current,
                          regions: regions.map(region => region.type === 'point'
                            ? { type: 'point', referenceId: region.referenceId, x: region.x, y: region.y }
                            : { type: 'bbox', referenceId: region.referenceId, x1: region.x, y1: region.y, x2: region.x + region.width, y2: region.y + region.height })
                        }))
                        setImageRegionEditorOpen(false)
                      }}
                      onClose={() => setImageRegionEditorOpen(false)}
                    />
                  </div>
                </div>
              )}
              {imageAnnotationTarget && imageAnnotationInput && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
                  onMouseDown={event => event.target === event.currentTarget && setImageAnnotationTarget(null)}
                >
                  <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-xl bg-white shadow-2xl">
                    <AnnotationEditorDialog
                      source={{
                        assetId: imageAnnotationInput.sourceAssetId || imageAnnotationInput.assetId,
                        imageUrl: canvasImageAssetUrl(imageAnnotationInput.assetId),
                        label: imageAnnotationInput.label || imageAnnotationInput.referenceId,
                        width: imageAnnotationTarget.width,
                        height: imageAnnotationTarget.height
                      }}
                      initialDocument={imageAnnotationDocuments[imageAnnotationInput.referenceId] || {
                        version: 1,
                        sourceAssetId: imageAnnotationInput.sourceAssetId || imageAnnotationInput.assetId,
                        width: imageAnnotationTarget.width,
                        height: imageAnnotationTarget.height,
                        annotations: []
                      }}
                      onSave={document => {
                        setImageAnnotationDocuments(current => ({
                          ...current,
                          [imageAnnotationInput.referenceId]: document
                        }))
                        setImageAnnotationTarget(null)
                      }}
                      onClose={() => setImageAnnotationTarget(null)}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : rightPanelMode === 'prompt-library' ? (
            <div className="min-h-0 flex-1 p-3" data-free-canvas-prompt-library-panel>
              <PromptLibraryPreviewPanel
                presets={presets}
                cardTypes={cardTypes}
                compact
                onPreview={setPreviewPreset}
              />
            </div>
          ) : !previewMode ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <AgentWorkEnvironment
                projectCode={activeProject.referenceCode || ''}
                projectRevision={activeProject.revision}
                cvcCode={activeBridgeCvcCode}
                selectedObjectCodes={freeCanvas.nodes.flatMap(node => (
                  selectedNodeIds.includes(node.id) && node.referenceCode ? [node.referenceCode] : []
                ))}
                onCvcChange={changeActiveBridgeContext}
                onAccept={handleAcceptBridgeDelivery}
              />
              <div className="min-h-0 flex-1">
                <AIChatbotBox
                  title="Free Canvas Agent"
                  mode="free-canvas-workspace"
                  sessionKey={`workspace:free-canvas:${activeProject.id}`}
                  workspaceContext={workspaceContext}
                  onApplyWorkspaceProposal={handleApplyAgentProposal}
                  onApplyCanvasEdit={handleApplyAgentProposal}
                  onDocumentReconcileStateChange={handleDocumentReconcileStateChange}
                  draftRequest={agentDraftRequest}
                  compact
                  embedded
                  contextLabel={`已读取画布 · ${freeCanvas.nodes.length} 个节点`}
                />
              </div>
            </div>
          ) : (
            <div className="p-5 text-sm font-semibold text-gray-400">Preview mode disables Agent Runtime.</div>
          )}
          {previewPreset && (
            <PromptPresetPreviewDialog preset={previewPreset} onClose={() => setPreviewPreset(null)} />
          )}
        </aside>
      )}
    </section>
  )
}

const FreeCanvasNode = ({ data, selected }: NodeProps<FreeCanvasFlowNode>) => {
  const node = data.canvasNode
  if (node.kind === 'text') {
    return (
      <FreeCanvasTextNodeView
        node={node}
        selected={selected}
        editing={data.editing}
        onEdit={data.onEdit}
        onTextCopy={data.onTextCopy}
        onTextRangeReplace={data.onTextRangeReplace}
        onTextStyleChange={data.onTextStyleChange}
        onTextRename={data.onTextRename}
        onTextSelectionChange={data.onTextSelectionChange}
      />
    )
  }
  if (node.kind === 'image') {
    return (
      <FreeCanvasImageNodeView
        node={node}
        selected={selected}
        onResize={data.onImageResize}
        commands={data.imageCommands || []}
        onCommand={commandId => data.onImageCommand(node.id, commandId)}
      />
    )
  }
  if (node.kind === 'arrow') {
    return <FreeCanvasArrowNodeView node={node} selected={selected} />
  }
  if (node.kind === 'document') {
    return (
      <div className="relative">
        <DocumentNode
          node={node}
          selected={selected}
          locked={data.documentLocked}
          onDocumentChange={document => data.onDocumentChange(node.id, document)}
          onCollapsedChange={collapsed => data.onDocumentCollapsedChange(node.id, collapsed)}
          onDelete={() => data.onDocumentDelete(node.id)}
          onPromptHandoff={data.onDocumentPromptHandoff}
        />
        {!data.documentLocked && (
          <button
            type="button"
            aria-label={`从文档 ${node.title} 创建分镜表`}
            className="nodrag absolute right-36 top-2 rounded-md border border-sky-200 bg-white px-2.5 py-1 text-[11px] font-bold text-sky-700 shadow-sm hover:bg-sky-50"
            onClick={() => data.onDocumentToStoryboard(node.id)}
          >
            从文档创建分镜表
          </button>
        )}
      </div>
    )
  }
  if (node.kind === 'storyboard') {
    return (
      <StoryboardNode
        node={node}
        selected={selected}
        locked={data.storyboardLocked}
        onRequestRevision={() => data.onStoryboardRevise(node.id)}
        onPromptHandoff={rowId => data.onStoryboardPromptHandoff(node.id, rowId)}
        onResolve={(ids, action) => data.onStoryboardResolve(node.id, ids, action)}
      />
    )
  }
  if (node.kind === 'unsupported') {
    return <FreeCanvasReadOnlyNodeView node={node} selected={selected} label="不支持的节点" detail={`${node.originalKind} · 原始数据将无损保留`} />
  }
  return null
}

const FreeCanvasReadOnlyNodeView = ({
  node,
  selected,
  label,
  detail
}: {
  node: Extract<IFreeCanvasNode, { kind: 'storyboard' | 'unsupported' }>
  selected: boolean
  label: string
  detail: string
}) => (
  <article
    data-read-only-canvas-node={node.kind}
    role="status"
    aria-label={`${label}：${node.title}`}
    className={`rounded-[8px] border bg-white p-4 shadow-[0_12px_32px_rgba(15,23,42,0.12)] ${
      selected ? 'border-sky-500 ring-2 ring-sky-200' : 'border-gray-200'
    }`}
    style={{ width: node.width, minHeight: node.height }}
  >
    <span className="text-[11px] font-black uppercase tracking-[0.14em] text-gray-400">{label}</span>
    <strong className="mt-2 block text-sm text-gray-900">{node.title}</strong>
    <span className="mt-2 block text-xs text-gray-500">{detail}</span>
  </article>
)

const isIsolatedReadOnlyCanvasNode = (node: IFreeCanvasNode): boolean => (
  node.kind === 'unsupported'
)

const isNonConnectableCanvasNode = (node: IFreeCanvasNode): boolean => (
  node.kind === 'document' || node.kind === 'storyboard' || node.kind === 'unsupported'
)

const ImageGeneratorFlowNode = ({ data, selected }: NodeProps<FreeCanvasFlowNode>) => {
  if (data.canvasNode.kind !== 'image-generator') return null
  return (
    <ImageGeneratorNode
      data={{
        canvasNode: data.canvasNode,
        resultThumbnailUrl: data.resultThumbnailUrl,
        onOpenHistory: data.onOpenImageHistory,
        onConfigure: data.onConfigureImageModel,
        onContinueCreation: data.onContinueLegacyImageCreation,
        inputSummary: data.imageGeneratorInputSummary
      }}
      selected={selected}
    />
  )
}

const FreeCanvasTextNodeView = ({
  node,
  selected,
  editing,
  onEdit,
  onTextCopy,
  onTextRangeReplace,
  onTextStyleChange,
  onTextRename,
  onTextSelectionChange
}: {
  node: IFreeCanvasTextNode
  selected: boolean
  editing: boolean
  onEdit: (nodeId: string | null) => void
  onTextCopy: (nodeId: string) => void
  onTextRangeReplace: (nodeId: string, range: { start: number; end: number }, insertedText: string, color: string) => void
  onTextStyleChange: (nodeId: string, updates: Parameters<typeof updateFreeCanvasTextNodeStyle>[2]) => void
  onTextRename: (nodeId: string, title: string) => string | null
  onTextSelectionChange: (nodeId: string, selection?: Omit<CanvasAgentSelection, 'baseContentDigest'>) => void
}) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const draftTextRef = useRef<string | null>(null)
  const caretOffsetRef = useRef<number | null>(null)
  const displayText = freeCanvasTextSegmentsToPlainText(node.segments)
  const userColor = userTextColor(node)
  const selectedNodeCount = useStore(state => state.nodes.filter(candidate => candidate.selected).length)

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editing || !editor) return
    if (draftTextRef.current === null) {
      editor.textContent = displayText
      draftTextRef.current = displayText
    }
    const restore = (offset: number) => {
      editor.focus({ preventScroll: true })
      restoreEditableCaret(editor, offset)
    }
    if (document.activeElement !== editor) {
      const offset = caretOffsetRef.current ?? freeCanvasTextSegmentsToPlainText(node.segments).length
      restore(offset)
      window.requestAnimationFrame(() => {
        if (editorRef.current && document.activeElement !== editorRef.current) {
          restore(offset)
        }
      })
      caretOffsetRef.current = null
      return
    }
    if (caretOffsetRef.current === null) return
    const offset = caretOffsetRef.current
    restore(offset)
    window.requestAnimationFrame(() => {
      if (editorRef.current) restore(offset)
    })
    caretOffsetRef.current = null
  }, [displayText, editing, node.segments])

  useEffect(() => {
    if (!editing) draftTextRef.current = null
  }, [editing])

  const handleInput = () => {
    const editor = editorRef.current
    if (!editor) return
    draftTextRef.current = editablePlainText(editor)
  }

  const commitDraft = () => {
    const nextText = draftTextRef.current ?? (editorRef.current ? editablePlainText(editorRef.current) : displayText)
    const diff = diffTextRange(displayText, nextText)
    if (!diff) return
    onTextRangeReplace(node.id, { start: diff.start, end: diff.end }, diff.insertedText, userColor)
  }

  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (!editing) return
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!editing) return
    event.stopPropagation()
    if (event.key !== 'Enter') return
    event.preventDefault()
    document.execCommand('insertText', false, '\n')
  }

  const captureSelection = () => {
    if (!editing || !editorRef.current) return
    onTextSelectionChange(node.id, readUserTextSelection(editorRef.current, node))
  }

  return (
    <div
      data-free-canvas-text-node
      className={`group relative rounded-[6px] border bg-white/70 p-3 shadow-[0_10px_28px_rgba(15,23,42,0.08)] ${selected ? 'border-sky-500 ring-1 ring-sky-400' : 'border-transparent'}`}
      style={{ width: node.width, minHeight: node.height }}
      onDoubleClick={() => onEdit(node.id)}
    >
      <NodeToolbar isVisible={selected && selectedNodeCount === 1} position={Position.Top} offset={10}>
        <TextNodeToolbar
          node={node}
          onEdit={() => onEdit(node.id)}
          onCopy={() => onTextCopy(node.id)}
          onRename={title => onTextRename(node.id, title)}
          onStyleChange={updates => onTextStyleChange(node.id, updates)}
        />
      </NodeToolbar>
      <Handle type="target" position={Position.Left} className="!bg-gray-950 !opacity-0 group-hover:!opacity-100" />
      <div
        data-free-canvas-text-title
        className="mb-2 break-all text-[11px] font-semibold leading-4 text-gray-400"
        title={node.title}
      >
        {node.title}
      </div>
      <div
        ref={editorRef}
        data-free-canvas-text-content
        className={`${editing ? 'nodrag nowheel' : 'pointer-events-none select-none'} min-h-[72px] whitespace-pre-wrap break-words bg-transparent font-semibold leading-snug outline-none ${editing ? 'cursor-text' : 'cursor-default'} ${fontSizeClass(node.fontSize)}`}
        contentEditable={editing || undefined}
        tabIndex={editing ? 0 : -1}
        suppressContentEditableWarning
        onInput={handleInput}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        onBlur={() => {
          commitDraft()
          if (editorRef.current) editorRef.current.textContent = ''
          onEdit(null)
        }}
        onMouseDown={event => {
          if (editing) event.stopPropagation()
        }}
      >
        {editing ? null : displayText ? (
          node.segments.map((segment, index) => (
            <span
              key={segment.id}
              data-segment-index={index}
              data-segment-source={segment.source}
              style={{ color: segment.color }}
            >
              {segment.text}
            </span>
          ))
        ) : (
          <span className="text-gray-400">Double-click to type</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-gray-950 !opacity-0 group-hover:!opacity-100" />
    </div>
  )
}

const FreeCanvasImageNodeView = ({
  node,
  selected,
  onResize,
  commands,
  onCommand
}: {
  node: IFreeCanvasImageNode
  selected: boolean
  onResize: (nodeId: string, frame: { position?: { x: number; y: number }; width: number; height: number }) => void
  commands: readonly ResolvedImageNodeCommand[]
  onCommand: (commandId: ImageNodeCommandId) => void
}) => {
  const selectedNodeCount = useStore(state => state.nodes.filter(candidate => candidate.selected).length)
  const generationState = node.meta?.generationState
  const generationErrorCode = safeGenerationErrorCode(node.meta?.generationErrorCode)
  const failurePresentation = getRuntimeErrorPresentation(generationErrorCode)
  const imageUrl = node.assetId ? canvasImageAssetUrl(node.assetId) : node.imageUrl
  const crop = node.crop
  const presentation = node.meta.presentation && typeof node.meta.presentation === 'object'
    ? node.meta.presentation as Record<string, unknown>
    : {}
  const flipTransform = `scale(${presentation.flipX === true ? -1 : 1}, ${presentation.flipY === true ? -1 : 1})`
  const imageStyle = {
    ...(crop ? {
      width: `${100 / crop.width}%`,
      height: `${100 / crop.height}%`,
      left: `${-crop.x / crop.width * 100}%`,
      top: `${-crop.y / crop.height * 100}%`
    } : {}),
    transform: flipTransform
  }

  return (
    <div
      data-image-node
      data-image-generation-state={generationState || undefined}
      aria-busy={generationState === 'running' || undefined}
      className={`group relative h-full w-full overflow-visible ${selected ? 'ring-2 ring-[#c96442]' : ''}`}
    >
      <NodeResizer
        isVisible={selected && selectedNodeCount === 1}
        keepAspectRatio
        minWidth={80}
        minHeight={60}
        color="#0ea5e9"
        handleStyle={{ width: 10, height: 10, border: '2px solid #0ea5e9', background: '#ffffff' }}
        lineStyle={{ borderColor: '#0ea5e9', borderWidth: 1.5 }}
        onResizeEnd={(_event, params) => {
          onResize(node.id, {
            position: { x: params.x, y: params.y },
            width: params.width,
            height: params.height
          })
        }}
      />
      <NodeToolbar isVisible={selected && selectedNodeCount === 1 && generationState !== 'running' && Boolean(node.assetId)} position={Position.Top} offset={10}>
        <ImageNodeActionBar commands={commands} onExecute={onCommand} />
      </NodeToolbar>
      <Handle type="target" position={Position.Left} className="!bg-gray-950 !opacity-0 group-hover:!opacity-100" />
      <div className="relative h-full w-full overflow-hidden">
        {generationState === 'running' ? (
          <div role="status" className="flex h-full w-full flex-col items-center justify-center gap-3 border border-gray-200 bg-gradient-to-br from-gray-50 via-white to-gray-100 text-gray-600">
            <Loader2 className="h-7 w-7 animate-spin text-[#c96442]" aria-hidden="true" />
            <span className="text-xs font-bold">图片生成中</span>
          </div>
        ) : generationState === 'failed' ? (
          <div role="status" className="flex h-full w-full flex-col items-center justify-center gap-2 border border-red-200 bg-red-50 px-4 text-center text-red-700">
            <AlertTriangle className="h-6 w-6" aria-hidden="true" />
            <span className="text-xs font-black">图片生成失败</span>
            <span className="text-[11px] font-medium">{failurePresentation.message}</span>
          </div>
        ) : imageUrl ? (
          <img
            src={imageUrl}
            alt={node.title}
            className={`pointer-events-none select-none ${crop ? 'absolute max-w-none' : 'h-full w-full object-contain'}`}
            style={imageStyle}
            draggable={false}
            onLoad={event => {
              const frame = fitFreeCanvasImageNodeFrameToContent(
                node,
                event.currentTarget.naturalWidth,
                event.currentTarget.naturalHeight
              )
              if (
                !frame
                || (
                  Math.abs(frame.width - node.width) < 0.5
                  && Math.abs(frame.height - node.height) < 0.5
                )
              ) return
              onResize(node.id, frame)
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs font-semibold text-gray-400">
            <ImageIcon className="mr-2 h-4 w-4" />
            Drop image
          </div>
        )}
        {generationState !== 'running' && generationState !== 'failed' && (
          <ImageAnnotationsLayer
            annotations={node.annotations || []}
            mode="display"
          />
        )}
      </div>
      <Handle id="image-output" type="source" position={Position.Right} className="!bg-gray-950 !opacity-0 group-hover:!opacity-100" />
    </div>
  )
}

type ImageAnnotationHistory = {
  past: IFreeCanvasImageAnnotation[][]
  present: IFreeCanvasImageAnnotation[]
  future: IFreeCanvasImageAnnotation[][]
}

type ImageAnnotationResizeHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

const IMAGE_ANNOTATION_RESIZE_HANDLES: ImageAnnotationResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const SHOT_NUMBER_RESIZE_HANDLES: ImageAnnotationResizeHandle[] = ['nw', 'ne', 'se', 'sw']
const IMAGE_ANNOTATION_MODE_LABELS: Record<FreeCanvasImageAnnotationKind, string> = {
  text: 'Text',
  rect: 'Rectangle',
  arrow: 'Arrow',
  freehand: 'Brush',
  shotNumber: 'Shot number'
}

const ImageAnnotationsLayer = ({
  annotations,
  mode,
  activeAnnotationMode = null,
  selectedAnnotationId = null,
  editingTextAnnotationId = null,
  interactive = false,
  onSelect,
  onClearSelection,
  onBeginTextEdit,
  onEndTextEdit,
  onLiveChange,
  onCommitChange,
  onDelete
}: {
  annotations: IFreeCanvasImageAnnotation[]
  mode: 'display' | 'edit'
  activeAnnotationMode?: FreeCanvasImageAnnotationKind | null
  selectedAnnotationId?: string | null
  editingTextAnnotationId?: string | null
  interactive?: boolean
  onSelect?: (annotationId: string) => void
  onClearSelection?: () => void
  onBeginTextEdit?: (annotationId: string) => void
  onEndTextEdit?: () => void
  onLiveChange?: (annotations: IFreeCanvasImageAnnotation[]) => void
  onCommitChange?: (annotations: IFreeCanvasImageAnnotation[], selectedAnnotationId?: string | null, baseAnnotations?: IFreeCanvasImageAnnotation[]) => void
  onDelete?: (annotationId: string) => void
}) => (
  <div
    className={`absolute inset-0 ${mode === 'display' || !interactive ? 'pointer-events-none' : ''}`}
    onPointerDown={event => {
      if (event.target === event.currentTarget) onClearSelection?.()
    }}
  >
    {annotations.map(annotation => {
      const editable = mode === 'edit' && interactive && annotation.kind === activeAnnotationMode
      return (
        <ImageAnnotationItem
          key={annotation.id}
          annotation={annotation}
          annotations={annotations}
          editable={editable}
          selected={editable && annotation.id === selectedAnnotationId}
          editing={editable && annotation.id === editingTextAnnotationId}
          onSelect={onSelect}
          onBeginTextEdit={onBeginTextEdit}
          onEndTextEdit={onEndTextEdit}
          onLiveChange={onLiveChange}
          onCommitChange={onCommitChange}
          onDelete={onDelete}
        />
      )
    })}
  </div>
)

const ImageAnnotationItem = ({
  annotation,
  annotations,
  editable,
  selected,
  editing,
  onSelect,
  onBeginTextEdit,
  onEndTextEdit,
  onLiveChange,
  onCommitChange,
  onDelete
}: {
  annotation: IFreeCanvasImageAnnotation
  annotations: IFreeCanvasImageAnnotation[]
  editable: boolean
  selected: boolean
  editing: boolean
  onSelect?: (annotationId: string) => void
  onBeginTextEdit?: (annotationId: string) => void
  onEndTextEdit?: () => void
  onLiveChange?: (annotations: IFreeCanvasImageAnnotation[]) => void
  onCommitChange?: (annotations: IFreeCanvasImageAnnotation[], selectedAnnotationId?: string | null, baseAnnotations?: IFreeCanvasImageAnnotation[]) => void
  onDelete?: (annotationId: string) => void
}) => {
  if (annotation.kind === 'freehand') {
    return (
      <>
        <svg className={`absolute inset-0 h-full w-full ${editable ? 'pointer-events-auto' : 'pointer-events-none'}`} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <polyline
            points={(annotation.points || []).map(point => `${point.x},${point.y}`).join(' ')}
            fill="none"
            stroke={annotation.color}
            strokeWidth={(annotation.strokeWidth || 4) / 500}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={editable ? 'cursor-pointer' : ''}
            pointerEvents={editable ? 'stroke' : 'none'}
            onPointerDown={editable ? event => {
              if (onLiveChange && onCommitChange) {
                startFreehandMove(event, annotation, annotations, onLiveChange, onCommitChange, onSelect)
                return
              }
              event.preventDefault()
              event.stopPropagation()
              onSelect?.(annotation.id)
            } : undefined}
          />
        </svg>
        {editable && selected && (
          <AnnotationSelectionFrame
            annotation={annotation}
            onDelete={() => onDelete?.(annotation.id)}
            onMovePointerDown={event => {
              if (!onLiveChange || !onCommitChange) return
              startFreehandBoxMove(event, annotation, annotations, onLiveChange, onCommitChange, onSelect)
            }}
          />
        )}
      </>
    )
  }

  if (annotation.kind === 'arrow' && annotation.points && annotation.points.length >= 2) {
    return (
      <PointArrowAnnotation
        annotation={annotation}
        annotations={annotations}
        editable={editable}
        selected={selected}
        onSelect={onSelect}
        onLiveChange={onLiveChange}
        onCommitChange={onCommitChange}
        onDelete={onDelete}
      />
    )
  }

  const style: CSSProperties = {
    left: `${annotation.x * 100}%`,
    top: `${annotation.y * 100}%`,
    width: `${annotation.width * 100}%`,
    ...(annotation.kind === 'shotNumber'
      ? { aspectRatio: '1 / 1' }
      : { height: `${annotation.height * 100}%` })
  }

  return (
    <div
      className={`absolute ${editable ? 'nodrag nowheel' : 'pointer-events-none'} ${selected ? 'ring-2 ring-sky-500' : ''}`}
      style={style}
      onPointerDown={editable && onLiveChange && onCommitChange ? event => startBoxAnnotationDrag(event, annotation, annotations, onLiveChange, onCommitChange, onSelect) : undefined}
      onDoubleClick={editable && (annotation.kind === 'text' || annotation.kind === 'shotNumber') ? event => {
        event.preventDefault()
        event.stopPropagation()
        onSelect?.(annotation.id)
        onBeginTextEdit?.(annotation.id)
      } : undefined}
      data-image-annotation-kind={annotation.kind}
      data-selected={selected || undefined}
    >
      {annotation.kind === 'rect' ? (
        <div className="h-full w-full border border-gray-950/70" style={{ backgroundColor: annotation.fill || '#ffffff' }} />
      ) : annotation.kind === 'arrow' ? (
        <ArrowAnnotation color={annotation.color} id={annotation.id} />
      ) : annotation.kind === 'shotNumber' ? (
        editable && editing ? (
          <input
            className="h-full w-full border-0 text-center text-lg font-black leading-none outline-none"
            style={{ backgroundColor: annotation.fill || '#111827', color: annotation.color || '#ffffff' }}
            value={annotation.text || ''}
            maxLength={4}
            inputMode="numeric"
            onChange={event => onLiveChange?.(replaceImageAnnotation(annotations, annotation.id, { text: event.target.value, updatedAt: Date.now() }))}
            onBlur={event => {
              onCommitChange?.(replaceImageAnnotation(annotations, annotation.id, { text: event.currentTarget.value, updatedAt: Date.now() }), annotation.id)
              onEndTextEdit?.()
            }}
            onKeyDown={event => {
              if (event.key === 'Escape' || event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
            onPointerDown={event => event.stopPropagation()}
            aria-label="Shot number"
            autoFocus
          />
        ) : (
          <div
            className="flex h-full w-full cursor-move items-center justify-center text-lg font-black leading-none"
            style={{ backgroundColor: annotation.fill || '#111827', color: annotation.color || '#ffffff' }}
          >
            {annotation.text || ''}
          </div>
        )
      ) : (
        editable && editing ? (
          <textarea
            className="h-full w-full resize-none border border-white/70 bg-white/70 px-2 py-1 text-sm font-semibold leading-snug text-gray-950 outline-none shadow-sm"
            value={annotation.text || ''}
            onChange={event => onLiveChange?.(replaceImageAnnotation(annotations, annotation.id, { text: event.target.value, updatedAt: Date.now() }))}
            onBlur={event => {
              onCommitChange?.(replaceImageAnnotation(annotations, annotation.id, { text: event.currentTarget.value, updatedAt: Date.now() }), annotation.id)
              onEndTextEdit?.()
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') event.currentTarget.blur()
            }}
            onPointerDown={event => event.stopPropagation()}
            aria-label="Image annotation text"
            autoFocus
          />
        ) : (
          <div
            className="h-full w-full cursor-move whitespace-pre-wrap break-words border border-white/70 bg-white/70 px-2 py-1 text-sm font-semibold leading-snug text-gray-950 shadow-sm"
          >
            {annotation.text || ''}
          </div>
        )
      )}
      {editable && selected && (
        <>
          <button
            type="button"
            className="absolute -right-3 -top-3 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-gray-950 text-white shadow-md hover:bg-red-600"
            title="Delete annotation"
            aria-label="Delete annotation"
            onPointerDown={event => event.stopPropagation()}
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              onDelete?.(annotation.id)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          {annotation.kind !== 'arrow' && (
            <AnnotationResizeHandles
              annotation={annotation}
              annotations={annotations}
              handles={annotation.kind === 'shotNumber' ? SHOT_NUMBER_RESIZE_HANDLES : IMAGE_ANNOTATION_RESIZE_HANDLES}
              onLiveChange={onLiveChange}
              onCommitChange={onCommitChange}
            />
          )}
        </>
      )}
    </div>
  )
}

const ArrowAnnotation = ({ color, id }: { color: string; id: string }) => {
  const markerId = `image-arrow-${id}`
  return (
    <svg className="h-full w-full overflow-visible" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <marker id={markerId} markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto" markerUnits="strokeWidth">
          <path d="M 0 0 L 10 4 L 0 8 z" fill={color} />
        </marker>
      </defs>
      <line x1="4" y1="12" x2="92" y2="12" stroke={color} strokeWidth="5" strokeLinecap="round" markerEnd={`url(#${markerId})`} />
    </svg>
  )
}

const PointArrowAnnotation = ({
  annotation,
  annotations,
  editable,
  selected,
  onSelect,
  onLiveChange,
  onCommitChange,
  onDelete
}: {
  annotation: IFreeCanvasImageAnnotation
  annotations: IFreeCanvasImageAnnotation[]
  editable: boolean
  selected: boolean
  onSelect?: (annotationId: string) => void
  onLiveChange?: (annotations: IFreeCanvasImageAnnotation[]) => void
  onCommitChange?: (annotations: IFreeCanvasImageAnnotation[], selectedAnnotationId?: string | null, baseAnnotations?: IFreeCanvasImageAnnotation[]) => void
  onDelete?: (annotationId: string) => void
}) => {
  const [start, end] = annotation.points || []
  if (!start || !end) return null
  const markerId = `image-arrow-point-${annotation.id}`
  const lineWidth = Math.max((annotation.strokeWidth || 5) / 450, 0.008)
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }

  return (
    <>
      <svg className={`absolute inset-0 h-full w-full ${editable ? 'pointer-events-auto' : 'pointer-events-none'}`} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <marker id={markerId} markerWidth="0.08" markerHeight="0.08" refX="0.07" refY="0.04" orient="auto" markerUnits="strokeWidth">
            <path d="M 0 0 L 0.08 0.04 L 0 0.08 z" fill={annotation.color || '#ef4423'} />
          </marker>
        </defs>
        <line
          x1={start.x}
          y1={start.y}
          x2={end.x}
          y2={end.y}
          stroke={annotation.color || '#ef4423'}
          strokeWidth={lineWidth}
          strokeLinecap="round"
          markerEnd={`url(#${markerId})`}
          className={editable ? 'cursor-move' : ''}
          pointerEvents={editable ? 'stroke' : 'none'}
          onPointerDown={editable && onLiveChange && onCommitChange ? event => startArrowMove(event, annotation, annotations, onLiveChange, onCommitChange, onSelect) : undefined}
        />
      </svg>
      {editable && selected && (
        <>
          <button
            type="button"
            className="absolute z-10 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-gray-950 text-white shadow-md hover:bg-red-600"
            style={{ left: `${mid.x * 100}%`, top: `${mid.y * 100 - 4}%` }}
            title="Delete annotation"
            aria-label="Delete annotation"
            onPointerDown={event => event.stopPropagation()}
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              onDelete?.(annotation.id)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          {(['start', 'end'] as const).map((endpoint, index) => {
            const point = endpoint === 'start' ? start : end
            return (
              <button
                key={endpoint}
                type="button"
                className="absolute z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-sky-500 shadow"
                style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                title={`${endpoint} arrow point`}
                aria-label={`${endpoint} arrow point`}
                onPointerDown={event => {
                  if (!onLiveChange || !onCommitChange) return
                  startArrowPointDrag(event, annotation, annotations, index, onLiveChange, onCommitChange, onSelect)
                }}
              />
            )
          })}
        </>
      )}
    </>
  )
}

const AnnotationSelectionFrame = ({
  annotation,
  onDelete,
  onMovePointerDown
}: {
  annotation: IFreeCanvasImageAnnotation
  onDelete: () => void
  onMovePointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void
}) => {
  const points = annotation.points || []
  if (points.length === 0) return null
  const box = annotationBoxFromPoints(points)
  return (
    <div
      className={`absolute border border-sky-500 ${onMovePointerDown ? 'pointer-events-auto cursor-move' : 'pointer-events-none'}`}
      style={{
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.width * 100}%`,
        height: `${box.height * 100}%`
      }}
      onPointerDown={onMovePointerDown}
    >
      <button
        type="button"
        className="pointer-events-auto absolute -right-3 -top-3 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-gray-950 text-white shadow-md hover:bg-red-600"
        title="Delete annotation"
        aria-label="Delete annotation"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          onDelete()
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

const AnnotationResizeHandles = ({
  annotation,
  annotations,
  handles,
  onLiveChange,
  onCommitChange
}: {
  annotation: IFreeCanvasImageAnnotation
  annotations: IFreeCanvasImageAnnotation[]
  handles: ImageAnnotationResizeHandle[]
  onLiveChange?: (annotations: IFreeCanvasImageAnnotation[]) => void
  onCommitChange?: (annotations: IFreeCanvasImageAnnotation[], selectedAnnotationId?: string | null, baseAnnotations?: IFreeCanvasImageAnnotation[]) => void
}) => (
  <>
    {handles.map(handle => (
      <button
        key={handle}
        type="button"
        className="absolute z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-sky-500 shadow"
        style={resizeHandleStyle(handle)}
        title={`Resize ${handle}`}
        aria-label={`Resize ${handle}`}
        onPointerDown={event => {
          if (!onLiveChange || !onCommitChange) return
          startAnnotationResize(event, annotation, annotations, handle, onLiveChange, onCommitChange)
        }}
      />
    ))}
  </>
)

const resizeHandleStyle = (handle: ImageAnnotationResizeHandle): CSSProperties => {
  const style: CSSProperties = {}
  if (handle.includes('n')) style.top = 0
  if (handle.includes('s')) style.top = '100%'
  if (!handle.includes('n') && !handle.includes('s')) style.top = '50%'
  if (handle.includes('w')) style.left = 0
  if (handle.includes('e')) style.left = '100%'
  if (!handle.includes('w') && !handle.includes('e')) style.left = '50%'
  return style
}

const startBoxAnnotationDrag = (
  event: ReactPointerEvent<HTMLDivElement>,
  annotation: IFreeCanvasImageAnnotation,
  annotations: IFreeCanvasImageAnnotation[],
  onLiveChange: (annotations: IFreeCanvasImageAnnotation[]) => void,
  onCommitChange: (annotations: IFreeCanvasImageAnnotation[], selectedAnnotationId?: string | null, baseAnnotations?: IFreeCanvasImageAnnotation[]) => void,
  onSelect?: (annotationId: string) => void
) => {
  const target = event.target instanceof HTMLElement ? event.target : null
  if (target?.closest('input, textarea, button')) return
  const parentRect = event.currentTarget.parentElement?.getBoundingClientRect()
  if (!parentRect || parentRect.width <= 0 || parentRect.height <= 0) return
  event.preventDefault()
  event.stopPropagation()
  onSelect?.(annotation.id)
  const startX = event.clientX
  const startY = event.clientY
  const initialX = annotation.x
  const initialY = annotation.y
  const baseAnnotations = cloneImageAnnotations(annotations)
  let latestAnnotations = annotations

  const move = (moveEvent: PointerEvent) => {
    moveEvent.preventDefault()
    const nextX = clampUnit(initialX + (moveEvent.clientX - startX) / parentRect.width, 1 - annotation.width)
    const nextY = clampUnit(initialY + (moveEvent.clientY - startY) / parentRect.height, 1 - annotation.height)
    latestAnnotations = replaceImageAnnotation(baseAnnotations, annotation.id, { x: nextX, y: nextY, updatedAt: Date.now() })
    onLiveChange(latestAnnotations)
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    onCommitChange(latestAnnotations, annotation.id, baseAnnotations)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop, { once: true })
}

const startAnnotationResize = (
  event: ReactPointerEvent<HTMLButtonElement>,
  annotation: IFreeCanvasImageAnnotation,
  annotations: IFreeCanvasImageAnnotation[],
  handle: ImageAnnotationResizeHandle,
  onLiveChange: (annotations: IFreeCanvasImageAnnotation[]) => void,
  onCommitChange: (annotations: IFreeCanvasImageAnnotation[], selectedAnnotationId?: string | null, baseAnnotations?: IFreeCanvasImageAnnotation[]) => void
) => {
  const parentRect = event.currentTarget.closest('[data-image-annotation-editor-frame]')?.getBoundingClientRect()
  if (!parentRect || parentRect.width <= 0 || parentRect.height <= 0) return
  event.preventDefault()
  event.stopPropagation()
  const startX = event.clientX
  const startY = event.clientY
  const baseAnnotations = cloneImageAnnotations(annotations)
  let latestAnnotations = annotations

  const move = (moveEvent: PointerEvent) => {
    moveEvent.preventDefault()
    const dx = (moveEvent.clientX - startX) / parentRect.width
    const dy = (moveEvent.clientY - startY) / parentRect.height
    const next = resizeImageAnnotation(annotation, handle, dx, dy)
    latestAnnotations = replaceImageAnnotation(baseAnnotations, annotation.id, { ...next, updatedAt: Date.now() })
    onLiveChange(latestAnnotations)
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    onCommitChange(latestAnnotations, annotation.id, baseAnnotations)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop, { once: true })
}

const startArrowMove = (
  event: ReactPointerEvent<SVGLineElement>,
  annotation: IFreeCanvasImageAnnotation,
  annotations: IFreeCanvasImageAnnotation[],
  onLiveChange: (annotations: IFreeCanvasImageAnnotation[]) => void,
  onCommitChange: (annotations: IFreeCanvasImageAnnotation[], selectedAnnotationId?: string | null, baseAnnotations?: IFreeCanvasImageAnnotation[]) => void,
  onSelect?: (annotationId: string) => void
) => {
  const frameRect = event.currentTarget.closest('[data-image-annotation-editor-frame]')?.getBoundingClientRect()
  if (!frameRect || frameRect.width <= 0 || frameRect.height <= 0 || !annotation.points || annotation.points.length < 2) return
  event.preventDefault()
  event.stopPropagation()
  onSelect?.(annotation.id)
  const startX = event.clientX
  const startY = event.clientY
  const startPoints = annotation.points.map(point => ({ ...point }))
  const baseAnnotations = cloneImageAnnotations(annotations)
  let latestAnnotations = annotations
  const pointerId = event.pointerId
  let stopped = false

  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return
    if (moveEvent.buttons === 0) {
      stop()
      return
    }
    moveEvent.preventDefault()
    const dx = (moveEvent.clientX - startX) / frameRect.width
    const dy = (moveEvent.clientY - startY) / frameRect.height
    const points = startPoints.map(point => ({
      x: clampUnit(point.x + dx),
      y: clampUnit(point.y + dy)
    }))
    latestAnnotations = replaceImageAnnotation(baseAnnotations, annotation.id, { ...annotationFrameFromPoints(points), points, updatedAt: Date.now() })
    onLiveChange(latestAnnotations)
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    window.removeEventListener('blur', stop)
    onCommitChange(latestAnnotations, annotation.id, baseAnnotations)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop, { once: true })
  window.addEventListener('pointercancel', stop, { once: true })
  window.addEventListener('blur', stop, { once: true })
}

const startArrowPointDrag = (
  event: ReactPointerEvent<HTMLButtonElement>,
  annotation: IFreeCanvasImageAnnotation,
  annotations: IFreeCanvasImageAnnotation[],
  pointIndex: number,
  onLiveChange: (annotations: IFreeCanvasImageAnnotation[]) => void,
  onCommitChange: (annotations: IFreeCanvasImageAnnotation[], selectedAnnotationId?: string | null, baseAnnotations?: IFreeCanvasImageAnnotation[]) => void,
  onSelect?: (annotationId: string) => void
) => {
  const frameRect = event.currentTarget.closest('[data-image-annotation-editor-frame]')?.getBoundingClientRect()
  if (!frameRect || frameRect.width <= 0 || frameRect.height <= 0 || !annotation.points || annotation.points.length < 2) return
  event.preventDefault()
  event.stopPropagation()
  onSelect?.(annotation.id)
  const baseAnnotations = cloneImageAnnotations(annotations)
  let latestAnnotations = annotations
  const pointerId = event.pointerId
  let stopped = false

  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return
    if (moveEvent.buttons === 0) {
      stop()
      return
    }
    moveEvent.preventDefault()
    const points = (annotation.points || []).map((point, index) => index === pointIndex
      ? {
        x: clampUnit((moveEvent.clientX - frameRect.left) / frameRect.width),
        y: clampUnit((moveEvent.clientY - frameRect.top) / frameRect.height)
      }
      : { ...point })
    latestAnnotations = replaceImageAnnotation(baseAnnotations, annotation.id, { ...annotationFrameFromPoints(points), points, updatedAt: Date.now() })
    onLiveChange(latestAnnotations)
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    window.removeEventListener('blur', stop)
    onCommitChange(latestAnnotations, annotation.id, baseAnnotations)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop, { once: true })
  window.addEventListener('pointercancel', stop, { once: true })
  window.addEventListener('blur', stop, { once: true })
}

const startFreehandMove = (
  event: ReactPointerEvent<SVGPolylineElement>,
  annotation: IFreeCanvasImageAnnotation,
  annotations: IFreeCanvasImageAnnotation[],
  onLiveChange: (annotations: IFreeCanvasImageAnnotation[]) => void,
  onCommitChange: (annotations: IFreeCanvasImageAnnotation[], selectedAnnotationId?: string | null, baseAnnotations?: IFreeCanvasImageAnnotation[]) => void,
  onSelect?: (annotationId: string) => void
) => {
  const frameRect = event.currentTarget.closest('[data-image-annotation-editor-frame]')?.getBoundingClientRect()
  if (!frameRect || frameRect.width <= 0 || frameRect.height <= 0 || !annotation.points || annotation.points.length === 0) return
  event.preventDefault()
  event.stopPropagation()
  onSelect?.(annotation.id)
  startFreehandPointMove(event.clientX, event.clientY, frameRect, annotation, annotations, onLiveChange, onCommitChange)
}

const startFreehandBoxMove = (
  event: ReactPointerEvent<HTMLDivElement>,
  annotation: IFreeCanvasImageAnnotation,
  annotations: IFreeCanvasImageAnnotation[],
  onLiveChange: (annotations: IFreeCanvasImageAnnotation[]) => void,
  onCommitChange: (annotations: IFreeCanvasImageAnnotation[], selectedAnnotationId?: string | null, baseAnnotations?: IFreeCanvasImageAnnotation[]) => void,
  onSelect?: (annotationId: string) => void
) => {
  const frameRect = event.currentTarget.closest('[data-image-annotation-editor-frame]')?.getBoundingClientRect()
  if (!frameRect || frameRect.width <= 0 || frameRect.height <= 0 || !annotation.points || annotation.points.length === 0) return
  const target = event.target instanceof HTMLElement ? event.target : null
  if (target?.closest('button')) return
  event.preventDefault()
  event.stopPropagation()
  onSelect?.(annotation.id)
  startFreehandPointMove(event.clientX, event.clientY, frameRect, annotation, annotations, onLiveChange, onCommitChange)
}

const startFreehandPointMove = (
  startClientX: number,
  startClientY: number,
  frameRect: DOMRect,
  annotation: IFreeCanvasImageAnnotation,
  annotations: IFreeCanvasImageAnnotation[],
  onLiveChange: (annotations: IFreeCanvasImageAnnotation[]) => void,
  onCommitChange: (annotations: IFreeCanvasImageAnnotation[], selectedAnnotationId?: string | null, baseAnnotations?: IFreeCanvasImageAnnotation[]) => void
) => {
  const startPoints = (annotation.points || []).map(point => ({ ...point }))
  if (startPoints.length === 0) return
  const baseAnnotations = cloneImageAnnotations(annotations)
  let latestAnnotations = annotations
  let stopped = false

  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.buttons === 0) {
      stop()
      return
    }
    moveEvent.preventDefault()
    const dx = (moveEvent.clientX - startClientX) / frameRect.width
    const dy = (moveEvent.clientY - startClientY) / frameRect.height
    const adjusted = clampPointMoveDelta(startPoints, dx, dy)
    const points = startPoints.map(point => ({
      x: point.x + adjusted.dx,
      y: point.y + adjusted.dy
    }))
    latestAnnotations = replaceImageAnnotation(baseAnnotations, annotation.id, { ...annotationFrameFromPoints(points), points, updatedAt: Date.now() })
    onLiveChange(latestAnnotations)
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    window.removeEventListener('blur', stop)
    onCommitChange(latestAnnotations, annotation.id, baseAnnotations)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop, { once: true })
  window.addEventListener('pointercancel', stop, { once: true })
  window.addEventListener('blur', stop, { once: true })
}

const ImageAnnotationEditor = ({
  node,
  imageUrl,
  onCancel,
  onSave
}: {
  node: IFreeCanvasImageNode
  imageUrl: string
  onCancel: () => void
  onSave: (annotations: IFreeCanvasImageAnnotation[]) => void
}) => {
  const editorRootRef = useRef<HTMLDivElement>(null)
  const imageFrameRef = useRef<HTMLDivElement>(null)
  const draftPointsRef = useRef<{ x: number; y: number }[]>([])
  const draftArrowRef = useRef<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null)
  const activeDrawPointerIdRef = useRef<number | null>(null)
  const textEditBaseRef = useRef<IFreeCanvasImageAnnotation[] | null>(null)
  const [history, setHistory] = useState<ImageAnnotationHistory>(() => ({
    past: [],
    present: cloneImageAnnotations(node.annotations || []),
    future: []
  }))
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [editingTextAnnotationId, setEditingTextAnnotationId] = useState<string | null>(null)
  const [activeAnnotationMode, setActiveAnnotationMode] = useState<FreeCanvasImageAnnotationKind | null>(null)
  const [draftPoints, setDraftPoints] = useState<{ x: number; y: number }[]>([])
  const [draftArrow, setDraftArrow] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null)
  const draftAnnotations = history.present
  const selectedAnnotation = selectedAnnotationId
    ? draftAnnotations.find(annotation => annotation.id === selectedAnnotationId && annotation.kind === activeAnnotationMode) || null
    : null
  const selectedAnnotationIdInMode = selectedAnnotation?.id || null
  const activeModeLabel = activeAnnotationMode ? IMAGE_ANNOTATION_MODE_LABELS[activeAnnotationMode] : 'Select a tool'
  const crop = node.crop
  const imageStyle = crop ? {
    width: `${100 / crop.width}%`,
    height: `${100 / crop.height}%`,
    left: `${-crop.x / crop.width * 100}%`,
    top: `${-crop.y / crop.height * 100}%`
  } : undefined

  useEffect(() => {
    setHistory({
      past: [],
      present: cloneImageAnnotations(node.annotations || []),
      future: []
    })
    setSelectedAnnotationId(null)
    setEditingTextAnnotationId(null)
    setActiveAnnotationMode(null)
    setDraftPoints([])
    setDraftArrow(null)
    draftPointsRef.current = []
    draftArrowRef.current = null
    activeDrawPointerIdRef.current = null
    textEditBaseRef.current = null
  }, [node.id, node.annotations])

  useEffect(() => {
    editorRootRef.current?.focus()
  }, [node.id])

  const setLiveAnnotations = (annotations: IFreeCanvasImageAnnotation[]) => {
    setHistory(current => ({
      ...current,
      present: cloneImageAnnotations(annotations)
    }))
  }

  const commitDraft = useCallback((
    annotations: IFreeCanvasImageAnnotation[],
    nextSelectedAnnotationId: string | null = selectedAnnotationId,
    baseAnnotations?: IFreeCanvasImageAnnotation[]
  ) => {
    const nextPresent = cloneImageAnnotations(annotations)
    setHistory(current => {
      const base = cloneImageAnnotations(baseAnnotations || current.present)
      if (sameImageAnnotations(base, nextPresent)) {
        return { ...current, present: nextPresent }
      }
      return {
        past: [...current.past, base].slice(-80),
        present: nextPresent,
        future: []
      }
    })
    setSelectedAnnotationId(nextSelectedAnnotationId)
  }, [selectedAnnotationId])

  const commitAnnotationChange = useCallback((
    annotations: IFreeCanvasImageAnnotation[],
    nextSelectedAnnotationId: string | null = selectedAnnotationId,
    baseAnnotations?: IFreeCanvasImageAnnotation[]
  ) => {
    commitDraft(annotations, nextSelectedAnnotationId, baseAnnotations || textEditBaseRef.current || undefined)
    textEditBaseRef.current = null
  }, [commitDraft, selectedAnnotationId])

  const undo = () => {
    setHistory(current => {
      const previous = current.past[current.past.length - 1]
      if (!previous) return current
      setSelectedAnnotationId(null)
      setEditingTextAnnotationId(null)
      textEditBaseRef.current = null
      return {
        past: current.past.slice(0, -1),
        present: cloneImageAnnotations(previous),
        future: [cloneImageAnnotations(current.present), ...current.future]
      }
    })
  }

  const redo = () => {
    setHistory(current => {
      const next = current.future[0]
      if (!next) return current
      setSelectedAnnotationId(null)
      setEditingTextAnnotationId(null)
      textEditBaseRef.current = null
      return {
        past: [...current.past, cloneImageAnnotations(current.present)],
        present: cloneImageAnnotations(next),
        future: current.future.slice(1)
      }
    })
  }

  const beginTextEdit = useCallback((annotationId: string) => {
    const annotation = draftAnnotations.find(item => item.id === annotationId)
    if (!annotation || annotation.kind !== activeAnnotationMode) return
    textEditBaseRef.current = cloneImageAnnotations(draftAnnotations)
    setSelectedAnnotationId(annotationId)
    setEditingTextAnnotationId(annotationId)
  }, [activeAnnotationMode, draftAnnotations])

  const deleteAnnotation = useCallback((annotationId: string) => {
    const annotation = draftAnnotations.find(item => item.id === annotationId)
    if (!annotation || annotation.kind !== activeAnnotationMode) return
    commitDraft(draftAnnotations.filter(annotation => annotation.id !== annotationId), null)
    setEditingTextAnnotationId(null)
  }, [activeAnnotationMode, commitDraft, draftAnnotations])

  const deleteSelectedAnnotation = useCallback(() => {
    if (!selectedAnnotationIdInMode) return
    deleteAnnotation(selectedAnnotationIdInMode)
  }, [deleteAnnotation, selectedAnnotationIdInMode])

  const selectAnnotationMode = (kind: FreeCanvasImageAnnotationKind) => {
    setActiveAnnotationMode(kind)
    setSelectedAnnotationId(null)
    setEditingTextAnnotationId(null)
    setDraftPoints([])
    setDraftArrow(null)
    draftPointsRef.current = []
    draftArrowRef.current = null
    textEditBaseRef.current = null
  }

  const imagePoint = (event: ReactPointerEvent): { x: number; y: number } | null => {
    const rect = imageFrameRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return null
    return {
      x: clampUnit((event.clientX - rect.left) / rect.width),
      y: clampUnit((event.clientY - rect.top) / rect.height)
    }
  }

  const pointHitsAnnotation = (point: { x: number; y: number }) => draftAnnotations.some(annotation => {
    const box = annotation.points && annotation.points.length > 0
      ? annotationBoxFromPoints(annotation.points)
      : annotation
    const padding = annotation.kind === 'arrow' || annotation.kind === 'freehand' ? 0.015 : 0
    return point.x >= box.x - padding &&
      point.x <= box.x + box.width + padding &&
      point.y >= box.y - padding &&
      point.y <= box.y + box.height + padding
  })

  const createAnnotationAtPoint = (kind: 'text' | 'rect' | 'shotNumber', point: { x: number; y: number }) => {
    const annotation = createFreeCanvasImageAnnotation(kind)
    const height = kind === 'shotNumber' ? annotation.width : annotation.height
    const placed = {
      ...annotation,
      x: clampNumber(point.x - annotation.width / 2, 0, 1 - annotation.width),
      y: clampNumber(point.y - height / 2, 0, 1 - height),
      height
    }
    commitDraft([...draftAnnotations, placed], placed.id)
    if (kind === 'text') setEditingTextAnnotationId(placed.id)
  }

  const handleFramePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeAnnotationMode) return
    if (event.button !== 0) return
    const point = imagePoint(event)
    if (!point) return
    if (pointHitsAnnotation(point)) return
    event.preventDefault()
    event.stopPropagation()
    if (activeAnnotationMode === 'text' || activeAnnotationMode === 'rect' || activeAnnotationMode === 'shotNumber') {
      createAnnotationAtPoint(activeAnnotationMode, point)
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    activeDrawPointerIdRef.current = event.pointerId
    if (activeAnnotationMode === 'arrow') {
      const arrow = { start: point, end: point }
      draftArrowRef.current = arrow
      setDraftArrow(arrow)
      return
    }
    if (activeAnnotationMode === 'freehand') {
      draftPointsRef.current = [point]
      setDraftPoints([point])
    }
  }

  const releaseActiveDrawPointer = (target: HTMLDivElement) => {
    const pointerId = activeDrawPointerIdRef.current
    if (pointerId !== null && target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId)
    }
    activeDrawPointerIdRef.current = null
  }

  const drawActiveTool = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activeDrawPointerIdRef.current !== null && event.pointerId !== activeDrawPointerIdRef.current) return
    if (activeDrawPointerIdRef.current !== null && event.buttons === 0) {
      endActiveTool(event)
      return
    }
    if (activeAnnotationMode === 'arrow' && draftArrowRef.current) {
      const point = imagePoint(event)
      if (!point) return
      event.preventDefault()
      event.stopPropagation()
      draftArrowRef.current = { ...draftArrowRef.current, end: point }
      setDraftArrow(draftArrowRef.current)
      return
    }
    if (activeAnnotationMode !== 'freehand' || draftPointsRef.current.length === 0) return
    const point = imagePoint(event)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    const previous = draftPointsRef.current[draftPointsRef.current.length - 1]
    if (previous && Math.abs(previous.x - point.x) + Math.abs(previous.y - point.y) < 0.004) return
    draftPointsRef.current = [...draftPointsRef.current, point]
    setDraftPoints(draftPointsRef.current)
  }

  const endActiveTool = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activeDrawPointerIdRef.current !== null && event.pointerId !== activeDrawPointerIdRef.current) return
    if (activeAnnotationMode !== 'freehand' && activeAnnotationMode !== 'arrow') return
    event.preventDefault()
    event.stopPropagation()
    if (activeAnnotationMode === 'arrow' && draftArrowRef.current) {
      const points = [draftArrowRef.current.start, draftArrowRef.current.end]
      const distance = Math.abs(points[0].x - points[1].x) + Math.abs(points[0].y - points[1].y)
      if (distance > 0.01) {
        const annotation = {
          ...createFreeCanvasImageAnnotation('arrow'),
          ...annotationFrameFromPoints(points),
          points,
          color: '#ef4423'
        }
        commitDraft([...draftAnnotations, annotation], annotation.id)
      }
      draftArrowRef.current = null
      setDraftArrow(null)
      releaseActiveDrawPointer(event.currentTarget)
      return
    }
    if (activeAnnotationMode === 'freehand' && draftPointsRef.current.length > 1) {
      const annotation = {
        ...createFreeCanvasImageAnnotation('freehand'),
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        points: draftPointsRef.current
      }
      commitDraft([...draftAnnotations, annotation], annotation.id)
    }
    draftPointsRef.current = []
    setDraftPoints([])
    releaseActiveDrawPointer(event.currentTarget)
  }

  const handleEditorKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    event.nativeEvent.stopImmediatePropagation()
    const target = event.target instanceof HTMLElement ? event.target : null
    const textInput = target?.closest('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null
    const key = event.key.toLowerCase()

    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
      return
    }
    if ((event.ctrlKey || event.metaKey) && key === 'y') {
      event.preventDefault()
      redo()
      return
    }
    if (textInput) {
      if (event.key === 'Escape') {
        event.preventDefault()
        textInput.blur()
      }
      if (event.key === 'Enter' && textInput instanceof HTMLInputElement) {
        event.preventDefault()
        textInput.blur()
      }
      return
    }
    if (event.key === 'Escape' && editingTextAnnotationId) {
      event.preventDefault()
      setEditingTextAnnotationId(null)
      textEditBaseRef.current = null
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedAnnotationIdInMode) {
      event.preventDefault()
      deleteSelectedAnnotation()
      return
    }
    if (event.key === 'Enter' && selectedAnnotationIdInMode) {
      const selected = draftAnnotations.find(annotation => annotation.id === selectedAnnotationIdInMode && annotation.kind === activeAnnotationMode)
      if (selected?.kind === 'text' || selected?.kind === 'shotNumber') {
        event.preventDefault()
        beginTextEdit(selected.id)
      }
    }
  }

  const stopEditorPointerPropagation = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    event.nativeEvent.stopImmediatePropagation()
  }

  const focusEditorPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target?.closest('input, textarea, button')) return
    editorRootRef.current?.focus()
  }

  const stopEditorMousePropagation = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
    event.nativeEvent.stopImmediatePropagation()
  }

  return (
    <div
      ref={editorRootRef}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-gray-950/55 p-8 backdrop-blur-sm"
      data-image-annotation-editor
      tabIndex={-1}
      onKeyDownCapture={handleEditorKeyDownCapture}
      onPointerDownCapture={focusEditorPointerCapture}
      onPointerDown={stopEditorPointerPropagation}
      onMouseDown={stopEditorMousePropagation}
      onClick={stopEditorMousePropagation}
    >
      <section className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-[8px] border border-white/15 bg-[#f7f7f5] shadow-[0_32px_100px_rgba(15,23,42,0.35)]">
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-black text-gray-950">Edit image annotations</h2>
            <p className="mt-0.5 text-xs font-semibold text-gray-500">{node.title}</p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded-full p-2 text-gray-500 hover:bg-gray-200 hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-35"
              onClick={undo}
              disabled={history.past.length === 0}
              title="Undo"
              aria-label="Undo"
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="rounded-full p-2 text-gray-500 hover:bg-gray-200 hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-35"
              onClick={redo}
              disabled={history.future.length === 0}
              title="Redo"
              aria-label="Redo"
            >
              <Redo2 className="h-4 w-4" />
            </button>
            <button type="button" className="rounded-full p-2 text-gray-500 hover:bg-gray-200 hover:text-gray-950" onClick={onCancel} title="Close annotation editor" aria-label="Close annotation editor">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[72px_1fr] overflow-hidden">
          <aside className="flex flex-col items-center gap-2 border-r border-gray-200 bg-white/70 px-3 py-4">
            <ImageEditorToolButton title="Text mode" active={activeAnnotationMode === 'text'} onClick={() => selectAnnotationMode('text')}><Type className="h-4 w-4" /></ImageEditorToolButton>
            <ImageEditorToolButton title="Rectangle mode" active={activeAnnotationMode === 'rect'} onClick={() => selectAnnotationMode('rect')}><Square className="h-4 w-4" /></ImageEditorToolButton>
            <ImageEditorToolButton title="Arrow mode" active={activeAnnotationMode === 'arrow'} onClick={() => selectAnnotationMode('arrow')}><ArrowRight className="h-4 w-4" /></ImageEditorToolButton>
            <ImageEditorToolButton title="Brush mode" active={activeAnnotationMode === 'freehand'} onClick={() => selectAnnotationMode('freehand')}><Brush className="h-4 w-4" /></ImageEditorToolButton>
            <ImageEditorToolButton title="Shot number mode" active={activeAnnotationMode === 'shotNumber'} onClick={() => selectAnnotationMode('shotNumber')}><Hash className="h-4 w-4" /></ImageEditorToolButton>
          </aside>

          <div className="min-h-0 overflow-auto p-8">
            <div
              ref={imageFrameRef}
              data-image-annotation-editor-frame
              className={`relative mx-auto flex max-h-[680px] max-w-[960px] items-center justify-center overflow-hidden bg-white shadow-[0_10px_35px_rgba(15,23,42,0.14)] ${activeAnnotationMode ? 'cursor-crosshair' : ''}`}
              style={{ aspectRatio: `${node.width} / ${node.height}`, width: 'min(74vw, 960px)' }}
              onPointerDown={handleFramePointerDown}
              onPointerMove={drawActiveTool}
              onPointerUp={endActiveTool}
              onPointerCancel={endActiveTool}
              onLostPointerCapture={endActiveTool}
            >
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt={node.title}
                  className={`pointer-events-none select-none ${crop ? 'absolute max-w-none' : 'h-full w-full object-contain'}`}
                  style={imageStyle}
                  draggable={false}
                />
              ) : (
                <div className="flex h-full w-full min-h-[360px] items-center justify-center text-xs font-semibold text-gray-400">
                  <ImageIcon className="mr-2 h-4 w-4" />
                  Drop image
                </div>
              )}
              <ImageAnnotationsLayer
                annotations={draftAnnotations}
                mode="edit"
                activeAnnotationMode={activeAnnotationMode}
                selectedAnnotationId={selectedAnnotationId}
                editingTextAnnotationId={editingTextAnnotationId}
                interactive={activeAnnotationMode !== null}
                onSelect={annotationId => {
                  const annotation = draftAnnotations.find(item => item.id === annotationId)
                  if (!annotation || annotation.kind !== activeAnnotationMode) return
                  setSelectedAnnotationId(annotationId)
                }}
                onClearSelection={() => {
                  setSelectedAnnotationId(null)
                  setEditingTextAnnotationId(null)
                }}
                onBeginTextEdit={beginTextEdit}
                onEndTextEdit={() => setEditingTextAnnotationId(null)}
                onLiveChange={setLiveAnnotations}
                onCommitChange={commitAnnotationChange}
                onDelete={deleteAnnotation}
              />
              {draftPoints.length > 1 && (
                <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                  <polyline
                    points={draftPoints.map(point => `${point.x},${point.y}`).join(' ')}
                    fill="none"
                    stroke="#ef4423"
                    strokeWidth={0.008}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              {draftArrow && (
                <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <marker id="draft-image-arrow" markerWidth="0.08" markerHeight="0.08" refX="0.07" refY="0.04" orient="auto" markerUnits="strokeWidth">
                      <path d="M 0 0 L 0.08 0.04 L 0 0.08 z" fill="#ef4423" />
                    </marker>
                  </defs>
                  <line
                    x1={draftArrow.start.x}
                    y1={draftArrow.start.y}
                    x2={draftArrow.end.x}
                    y2={draftArrow.end.y}
                    stroke="#ef4423"
                    strokeWidth={0.01}
                    strokeLinecap="round"
                    markerEnd="url(#draft-image-arrow)"
                  />
                </svg>
              )}
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-between border-t border-gray-200 px-5 py-3">
          <span className="text-xs font-semibold text-gray-500">{draftAnnotations.length} annotations 璺?Mode: {activeModeLabel}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-full p-2 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-35"
              onClick={deleteSelectedAnnotation}
              disabled={!selectedAnnotationIdInMode}
              title="Delete selected annotation"
              aria-label="Delete selected annotation"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button type="button" className="rounded-full px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200" onClick={onCancel}>Cancel</button>
            <button
              type="button"
              className="rounded-full bg-gray-950 px-5 py-2 text-sm font-bold text-white transition active:scale-[0.98]"
              onClick={() => onSave(history.present)}
            >
              Save annotations
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

const ImageEditorToolButton = ({
  title,
  active = false,
  onClick,
  children
}: {
  title: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) => (
  <button
    type="button"
    className={`flex h-11 w-11 items-center justify-center rounded-[8px] border text-gray-700 transition ${active ? 'border-gray-950 bg-gray-950 text-white' : 'border-gray-200 bg-white hover:bg-gray-100 hover:text-gray-950'}`}
    title={title}
    aria-label={title}
    onClick={onClick}
  >
    {children}
  </button>
)

const replaceImageAnnotation = (
  annotations: IFreeCanvasImageAnnotation[],
  annotationId: string,
  updates: Partial<Omit<IFreeCanvasImageAnnotation, 'id' | 'kind' | 'createdAt'>>
): IFreeCanvasImageAnnotation[] =>
  annotations.map(annotation => annotation.id === annotationId
    ? { ...annotation, ...updates, meta: updates.meta || annotation.meta }
    : annotation)

const resizeImageAnnotation = (
  annotation: IFreeCanvasImageAnnotation,
  handle: ImageAnnotationResizeHandle,
  dx: number,
  dy: number
): Pick<IFreeCanvasImageAnnotation, 'x' | 'y' | 'width' | 'height'> => {
  if (annotation.kind === 'shotNumber') {
    const signedDelta = handle.includes('w') ? -dx : dx
    const nextSize = clampNumber(annotation.width + signedDelta, 0.025, 1)
    const width = Math.min(nextSize, handle.includes('w') ? annotation.x + annotation.width : 1 - annotation.x)
    const x = handle.includes('w') ? clampUnit(annotation.x + annotation.width - width, 1 - width) : annotation.x
    return { x, y: annotation.y, width, height: width }
  }

  let x = annotation.x
  let y = annotation.y
  let width = annotation.width
  let height = annotation.height

  if (handle.includes('e')) width = clampNumber(annotation.width + dx, 0.02, 1 - annotation.x)
  if (handle.includes('s')) height = clampNumber(annotation.height + dy, 0.02, 1 - annotation.y)
  if (handle.includes('w')) {
    const right = annotation.x + annotation.width
    x = clampNumber(annotation.x + dx, 0, right - 0.02)
    width = right - x
  }
  if (handle.includes('n')) {
    const bottom = annotation.y + annotation.height
    y = clampNumber(annotation.y + dy, 0, bottom - 0.02)
    height = bottom - y
  }

  return { x, y, width, height }
}

const annotationBoxFromPoints = (points: { x: number; y: number }[]): Pick<IFreeCanvasImageAnnotation, 'x' | 'y' | 'width' | 'height'> => {
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  return {
    x: clampUnit(minX),
    y: clampUnit(minY),
    width: Math.max(0.01, maxX - minX),
    height: Math.max(0.01, maxY - minY)
  }
}

const annotationFrameFromPoints = (points: { x: number; y: number }[]): Pick<IFreeCanvasImageAnnotation, 'x' | 'y' | 'width' | 'height'> =>
  annotationBoxFromPoints(points)

const clampPointMoveDelta = (
  points: { x: number; y: number }[],
  dx: number,
  dy: number
): { dx: number; dy: number } => {
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    dx: clampNumber(dx, -minX, 1 - maxX),
    dy: clampNumber(dy, -minY, 1 - maxY)
  }
}

const sameImageAnnotations = (left: IFreeCanvasImageAnnotation[], right: IFreeCanvasImageAnnotation[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const cloneImageAnnotations = (annotations: IFreeCanvasImageAnnotation[]): IFreeCanvasImageAnnotation[] =>
  annotations.map(annotation => ({
    ...annotation,
    points: annotation.points?.map(point => ({ ...point })),
    meta: { ...annotation.meta }
  }))

const FreeCanvasArrowNodeView = ({ node, selected }: { node: Extract<IFreeCanvasNode, { kind: 'arrow' }>; selected: boolean }) => (
  <div className={`group relative flex items-center gap-3 rounded-md border bg-white px-4 py-3 text-sm font-semibold shadow-sm ${selected ? 'border-sky-500 ring-1 ring-sky-400' : 'border-gray-200'}`} style={{ width: node.width, minHeight: node.height }}>
    <Handle type="target" position={Position.Left} className="!bg-gray-950 !opacity-0 group-hover:!opacity-100" />
    <MousePointer2 className="h-4 w-4" />
    <span style={{ color: node.color }}>{node.text || 'Arrow annotation'}</span>
    <Handle type="source" position={Position.Right} className="!bg-gray-950 !opacity-0 group-hover:!opacity-100" />
  </div>
)

const TextNodeToolbar = ({
  node,
  onEdit,
  onCopy,
  onRename,
  onStyleChange
}: {
  node: IFreeCanvasTextNode
  onEdit: () => void
  onCopy: () => void
  onRename: (title: string) => string | null
  onStyleChange: (updates: Parameters<typeof updateFreeCanvasTextNodeStyle>[2]) => void
}) => {
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(node.title)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [styleMenu, setStyleMenu] = useState<'font-size' | 'color' | null>(null)
  const currentColor = userTextColor(node)

  useEffect(() => {
    if (!renaming) setTitle(node.title)
  }, [node.title, renaming])

  const commitRename = () => {
    const error = onRename(title)
    if (error) {
      setRenameError(error)
      return
    }
    setRenameError(null)
    setRenaming(false)
  }

  return (
    <div
      className="nodrag nowheel relative flex items-center gap-2 rounded-full border border-gray-200 bg-gray-950 px-3 py-2 text-white shadow-[0_18px_60px_rgba(15,23,42,0.22)]"
      onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
    >
    <button
      type="button"
      className="nodrag rounded-full px-3 py-1.5 text-xs font-black text-white hover:bg-white/10"
      onClick={onEdit}
    >
      Edit
    </button>
    <button
      type="button"
      className="nodrag flex h-8 w-8 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 hover:text-white"
      data-free-canvas-copy-text
      title="复制文本"
      aria-label="复制文本"
      onClick={onCopy}
    >
      <Copy className="h-4 w-4" />
    </button>
    {renaming ? (
      <div className="relative">
        <input
          autoFocus
          aria-label="文字节点名称"
          className="nodrag h-8 w-40 rounded-full border border-white bg-white px-3 text-xs font-bold text-gray-950 outline-none focus:border-amber-300 focus:ring-2 focus:ring-amber-300/30"
          value={title}
          maxLength={32}
          onChange={event => {
            setTitle(event.target.value)
            setRenameError(null)
          }}
          onBlur={commitRename}
          onKeyDown={event => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              commitRename()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setTitle(node.title)
              setRenameError(null)
              setRenaming(false)
            }
          }}
        />
        {renameError ? (
          <div role="alert" className="absolute left-0 top-10 w-56 rounded-md bg-red-600 px-2 py-1 text-[10px] font-semibold text-white shadow-lg">
            {renameError}
          </div>
        ) : null}
      </div>
    ) : (
      <button
        type="button"
        className="nodrag flex h-8 w-8 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 hover:text-white"
        aria-label="重命名文字节点"
        title="重命名"
        onClick={() => setRenaming(true)}
      >
        <Pencil className="h-4 w-4" />
      </button>
    )}
    <div className="h-6 w-px bg-white/20" />
    <div className="relative">
      <button
        type="button"
        className={`nodrag flex h-8 w-8 items-center justify-center rounded-full transition ${styleMenu === 'font-size' ? 'bg-white text-gray-950' : 'text-white/80 hover:bg-white/10 hover:text-white'}`}
        aria-label="文本大小"
        aria-haspopup="menu"
        aria-expanded={styleMenu === 'font-size'}
        title={`文本大小：${node.fontSize}`}
        onClick={() => setStyleMenu(current => current === 'font-size' ? null : 'font-size')}
      >
        <Type className="h-4 w-4" />
      </button>
      {styleMenu === 'font-size' ? (
        <div
          data-free-canvas-font-size-menu
          role="menu"
          aria-label="选择文本大小"
          className="absolute left-1/2 top-11 z-50 flex -translate-x-1/2 gap-1 rounded-lg border border-gray-700 bg-gray-950 p-1.5 shadow-xl"
        >
          {FONT_SIZES.map(size => (
            <button
              key={size}
              type="button"
              role="menuitemradio"
              aria-checked={node.fontSize === size}
              data-free-canvas-font-size-option
              data-font-size={size}
              className={`nodrag rounded-md px-2 py-1.5 text-[10px] font-bold transition ${node.fontSize === size ? 'bg-white text-gray-950' : 'text-white/75 hover:bg-white/10 hover:text-white'}`}
              onClick={() => {
                onStyleChange({ fontSize: size })
                setStyleMenu(null)
              }}
            >
              {size}
            </button>
          ))}
        </div>
      ) : null}
    </div>
    <div className="relative">
      <button
        type="button"
        className={`nodrag relative flex h-8 w-8 items-center justify-center rounded-full transition ${styleMenu === 'color' ? 'bg-white text-gray-950' : 'text-white/80 hover:bg-white/10 hover:text-white'}`}
        aria-label="文字颜色"
        aria-haspopup="menu"
        aria-expanded={styleMenu === 'color'}
        title="文字颜色"
        onClick={() => setStyleMenu(current => current === 'color' ? null : 'color')}
      >
        <Palette className="h-4 w-4" />
        <span
          aria-hidden="true"
          className="absolute bottom-0.5 right-0.5 h-2 w-2 rounded-full border border-white/60"
          style={{ backgroundColor: currentColor }}
        />
      </button>
      {styleMenu === 'color' ? (
        <div
          data-free-canvas-color-menu
          role="menu"
          aria-label="选择文字颜色"
          className="absolute right-0 top-11 z-50 grid grid-cols-5 gap-1.5 rounded-lg border border-gray-700 bg-gray-950 p-2 shadow-xl"
        >
          {TEXT_COLORS.map(color => (
            <button
              key={color}
              type="button"
              role="menuitemradio"
              aria-checked={currentColor === color}
              data-free-canvas-color-option
              data-color={color}
              className={`nodrag h-6 w-6 rounded-full border transition hover:scale-110 ${currentColor === color ? 'border-white ring-2 ring-white/40' : 'border-white/30'}`}
              style={{ backgroundColor: color }}
              title={color}
              onClick={() => {
                onStyleChange({ color })
                setStyleMenu(null)
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
    </div>
  )
}

export const CanvasBottomToolbar = ({
  positionClassName,
  quickDrawerOpen,
  quickPresets,
  onCreateText,
  onCreateDocument,
  onCreateImage,
  onCreateImageGenerator,
  onToggleQuickDrawer,
  onOpenQuickPresetComposer,
  onEditQuickPreset,
  onUseQuickPreset
}: {
  positionClassName?: string
  quickDrawerOpen: boolean
  quickPresets: IPreset[]
  onCreateText: () => void
  onCreateDocument?: () => void
  onCreateImage: () => void
  onCreateImageGenerator?: () => void
  imageGeneratorCreating?: boolean
  onToggleQuickDrawer: () => void
  onOpenQuickPresetComposer: () => void
  onEditQuickPreset: (preset: IPreset) => void
  onUseQuickPreset: (preset: IPreset) => void
}) => (
    <div className={`absolute bottom-6 z-30 flex -translate-x-1/2 flex-col items-center gap-3 ${positionClassName || 'left-1/2'}`}>
      {quickDrawerOpen && (
        <div className="w-[300px] rounded-[8px] border border-gray-200 bg-white p-2 shadow-[0_18px_60px_rgba(15,23,42,0.18)]">
          <div className="px-2 pb-2 pt-1 text-xs font-semibold text-gray-400">可能@的内容</div>
          <div className="max-h-[320px] space-y-1 overflow-y-auto">
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-md bg-gray-100 px-3 py-3 text-left text-sm font-semibold text-gray-950 hover:bg-gray-200"
              onClick={onOpenQuickPresetComposer}
              title="Add quick message"
            >
              <Plus className="h-4 w-4" />
              <span>创建快捷消息</span>
            </button>
            {quickPresets.length === 0 ? (
              <div className="rounded-md bg-gray-50 px-3 py-3 text-xs font-semibold text-gray-400">还没有快捷消息</div>
            ) : quickPresets.map(preset => (
              <div
                key={preset.id}
                className="flex items-center gap-1 rounded-md hover:bg-gray-50"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
                  onClick={() => onUseQuickPreset(preset)}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-red-50 text-red-600">
                    <MessageSquare className="h-4 w-4" />
                   </span>
                   <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-semibold text-gray-950">{preset.label}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-950"
                  onClick={() => onEditQuickPreset(preset)}
                  title={`编辑 ${preset.label}`}
                >
                  <Pencil className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1 rounded-full border border-gray-200 bg-white/95 px-3 py-2 shadow-[0_18px_60px_rgba(15,23,42,0.18)] backdrop-blur" data-free-canvas-toolbar>
        <ToolbarButton title="Text" onClick={onCreateText}><Type className="h-4 w-4" /></ToolbarButton>
        {onCreateDocument && (
          <ToolbarButton title="Document" ariaLabel="创建规划文档" onClick={onCreateDocument}><BookOpen className="h-4 w-4" /></ToolbarButton>
        )}
        <ToolbarButton title="Quick messages" onClick={onToggleQuickDrawer}><MessageSquare className="h-4 w-4" /></ToolbarButton>
        <ToolbarButton title="Image" onClick={onCreateImage}><ImageIcon className="h-4 w-4" /></ToolbarButton>
        {onCreateImageGenerator && (
          <ToolbarButton
            title="打开图片生成"
            ariaLabel="打开图片生成"
            onClick={onCreateImageGenerator}
          ><Brush className="h-4 w-4" /></ToolbarButton>
        )}
      </div>
    </div>
)

const QuickMessageDialog = ({
  draft,
  editing,
  rightOffset,
  onDraftChange,
  onClose,
  onDelete,
  onSave
}: {
  draft: QuickMessageDraft
  editing: boolean
  rightOffset: number
  onDraftChange: (draft: QuickMessageDraft) => void
  onClose: () => void
  onDelete?: () => void
  onSave: () => void
}) => (
  <div
    className="fixed bottom-[56px] left-0 top-14 z-[80] flex items-center justify-center bg-black/35 px-8 py-8"
    style={{ right: rightOffset }}
  >
    <section
      data-quick-message-dialog
      className="flex flex-col rounded-[8px] bg-white p-8 shadow-[0_24px_90px_rgba(15,23,42,0.28)]"
      style={{
        width: 'min(860px, calc(100% - 48px))',
        height: 'min(720px, calc(100% - 48px))'
      }}
    >
      <div className="mb-7 flex shrink-0 items-center justify-between">
        <h2 className="text-xl font-black text-gray-950">{editing ? '编辑快捷消息' : '新增快捷消息'}</h2>
        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-950"
          onClick={onClose}
          title="Close"
        >
          <X className="h-6 w-6" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden">
        <label className="block">
          <div className="mb-2 text-sm font-bold text-gray-950">提示词名称 <span className="text-red-500">*</span></div>
          <div className="rounded-[8px] bg-gray-100 px-4">
            <input
              className="w-full appearance-none border-0 bg-transparent py-4 text-base outline-none ring-0 placeholder:text-gray-400 focus:border-transparent focus:outline-none focus:ring-0"
              value={draft.name}
              maxLength={20}
              onChange={event => onDraftChange({ ...draft, name: event.target.value })}
              placeholder="请输入名称"
              autoFocus
            />
          </div>
        </label>


        <label className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 text-sm font-bold text-gray-950">模板正文 <span className="text-red-500">*</span></div>
          <textarea
            className="min-h-0 flex-1 resize-none overflow-y-auto rounded-[8px] border-0 bg-gray-100 px-4 py-4 text-base leading-7 outline-none ring-0 placeholder:text-gray-400 focus:border-transparent focus:outline-none focus:ring-0"
            value={draft.body}
            onChange={event => onDraftChange({ ...draft, body: event.target.value })}
            placeholder="请输入模板正文"
          />
        </label>
      </div>

      <div className="mt-7 flex shrink-0 items-center justify-between">
        {onDelete ? (
          <button
            type="button"
            className="flex items-center gap-2 rounded-[8px] px-4 py-3 text-sm font-bold text-red-600 hover:bg-red-50"
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4" />
            删除
          </button>
        ) : <span />}
        <button
          type="button"
          className="rounded-[8px] bg-gray-950 px-8 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-gray-300"
          disabled={!draft.name.trim() || !draft.body.trim()}
          onClick={onSave}
        >
          保存
        </button>
      </div>
    </section>
  </div>
)

const editablePlainText = (element: HTMLElement): string =>
  element.textContent || ''

const diffTextRange = (previous: string, next: string): { start: number; end: number; insertedText: string } | null => {
  if (previous === next) return null
  let start = 0
  while (start < previous.length && start < next.length && previous[start] === next[start]) {
    start += 1
  }
  let previousEnd = previous.length
  let nextEnd = next.length
  while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) {
    previousEnd -= 1
    nextEnd -= 1
  }
  return {
    start,
    end: previousEnd,
    insertedText: next.slice(start, nextEnd)
  }
}

const restoreEditableCaret = (root: HTMLElement, offset: number): void => {
  const selection = window.getSelection()
  if (!selection) return
  const targetOffset = Math.max(0, offset)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let currentOffset = 0
  let textNode = walker.nextNode()

  while (textNode) {
    const textLength = textNode.textContent?.length || 0
    if (currentOffset + textLength >= targetOffset) {
      const range = document.createRange()
      range.setStart(textNode, Math.min(targetOffset - currentOffset, textLength))
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    currentOffset += textLength
    textNode = walker.nextNode()
  }

  const range = document.createRange()
  range.selectNodeContents(root)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

const ToolbarButton = ({ title, ariaLabel = title, onClick, onDragStart, draggable = false, children, disabled = false }: {
  title: string
  ariaLabel?: string
  onClick: () => void
  onDragStart?: (event: ReactDragEvent<HTMLButtonElement>) => void
  draggable?: boolean
  children: ReactNode
  disabled?: boolean
}) => (
  <button type="button" className="flex h-10 w-10 items-center justify-center rounded-full text-gray-600 transition hover:bg-gray-950 hover:text-white disabled:cursor-not-allowed disabled:opacity-40" title={title} aria-label={ariaLabel} draggable={draggable} onDragStart={onDragStart} disabled={disabled} onClick={() => { if (!disabled) onClick() }}>
    {children}
  </button>
)

const PanelModeButton = ({
  active,
  label,
  icon,
  onClick
}: {
  active: boolean
  label: string
  icon: ReactNode
  onClick: () => void
}) => (
  <button
    type="button"
    className={`inline-flex min-w-0 items-center justify-center gap-1.5 rounded-[7px] px-2 py-1 text-[11px] font-semibold transition ${
      active
        ? 'bg-white text-[#141413] shadow-[0_0_0_1px_rgba(20,20,19,0.05)]'
        : 'text-[#87867f] hover:bg-white/60 hover:text-[#4d4c48]'
    }`}
    onClick={onClick}
  >
    {icon}
    <span className="truncate">{label}</span>
  </button>
)

const contextualImageOperations: readonly ImageProductOperation[] = [
  'reference-generate',
  'effect-render',
  'region-redraw',
  'erase',
  'outpaint',
  'text-edit',
  'multi-view',
  'upscale',
  'subject-extract'
]

const imageOperationForCommand = (
  commandId: ImageNodeCommandId
): ImageProductOperation | null => {
  if (commandId === 'as-reference') return 'reference-generate'
  if (commandId === 'effect-render') return 'effect-render'
  if (commandId === 'region-redraw') return 'region-redraw'
  if (commandId === 'erase') return 'erase'
  if (commandId === 'outpaint') return 'outpaint'
  if (commandId === 'multi-view') return 'multi-view'
  if (commandId === 'text-edit') return 'text-edit'
  if (commandId === 'enhance') return 'upscale'
  if (commandId === 'subject-extract') return 'subject-extract'
  return null
}

const defaultImageOperationPreset = (operation: ImageProductOperation): string => {
  if (operation === 'effect-render') return 'product-sketch'
  if (operation === 'outpaint') return 'balanced'
  if (operation === 'multi-view') return 'identity-preserving'
  if (operation === 'erase') return 'context-fill'
  if (operation === 'region-redraw') return 'point-guided'
  if (operation === 'text-edit') return 'layout-preserving'
  if (operation === 'upscale') return 'generative-redraw'
  if (operation === 'subject-extract') return 'white-background'
  return 'reference-variation'
}

const defaultImageOperationPreservation = (
  operation: ImageProductOperation
): string[] => {
  if (operation === 'effect-render') return ['主体轮廓', '材质颜色']
  if (operation === 'outpaint') return ['主体身份', '光照方向']
  if (operation === 'multi-view') return ['主体身份', '比例结构', '材质与颜色']
  if (operation === 'erase') return ['区域外内容', '背景纹理']
  if (operation === 'region-redraw') return ['区域外内容', '透视关系']
  if (operation === 'text-edit') return ['字体风格', '周围图形']
  if (operation === 'upscale') return ['主体造型', '构图布局']
  if (operation === 'subject-extract') return ['主体身份', '轮廓边缘']
  return ['主体身份', '画面风格']
}

const readUserTextSelection = (
  editor: HTMLElement,
  node: IFreeCanvasTextNode
): Omit<CanvasAgentSelection, 'baseContentDigest'> | undefined => {
  const selection = window.getSelection?.()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return undefined

  const segmentElement = (boundary: Range['startContainer']): HTMLElement | null => {
    const element = boundary instanceof HTMLElement ? boundary : boundary.parentElement
    return element?.closest<HTMLElement>('[data-segment-index]') || null
  }
  const startElement = segmentElement(range.startContainer)
  const endElement = segmentElement(range.endContainer)
  if (!startElement || !endElement
    || startElement.dataset.segmentSource !== 'user'
    || endElement.dataset.segmentSource !== 'user') return undefined

  const presetElements = editor.querySelectorAll<HTMLElement>('[data-segment-source="preset"]')
  for (const presetElement of presetElements) {
    if (range.intersectsNode(presetElement)) return undefined
  }

  const logicalOffset = (element: HTMLElement, boundary: Range['startContainer'], offset: number) => {
    const segmentIndex = Number(element.dataset.segmentIndex)
    if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= node.segments.length) return null
    const userSegmentsBefore = node.segments.slice(0, segmentIndex).filter(segment => segment.source === 'user')
    const prefixLength = userSegmentsBefore.reduce((total, segment) => total + segment.text.length, 0)
      + userSegmentsBefore.length
    const inside = document.createRange()
    inside.selectNodeContents(element)
    inside.setEnd(boundary, offset)
    return prefixLength + inside.toString().length
  }

  const start = logicalOffset(startElement, range.startContainer, range.startOffset)
  const end = logicalOffset(endElement, range.endContainer, range.endOffset)
  if (start === null || end === null || end <= start) return undefined
  const userText = freeCanvasUserText(node)
  const selectedText = userText.slice(start, end)
  if (!selectedText) return undefined
  return { start, end, selectedText }
}

const sha256Text = async (value: string): Promise<string> => {
  if (!globalThis.crypto?.subtle) throw new Error('sha256_unavailable')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

const pythonCanonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(pythonCanonicalJson).join(', ')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}: ${pythonCanonicalJson(child)}`)
    return `{${entries.join(', ')}}`
  }
  return JSON.stringify(value)
}

type PromptHandoffProposal = Extract<AgentWorkspaceProposal | AgentCanvasEdit, { kind: 'free_canvas_text_create' }>
type PromptHandoffApplication = {
  nodeId: string
  marker: NonNullable<IFreeCanvasTextNode['agentPromptHandoff']>
  title: string
  userText: string
  provenance: NonNullable<PromptHandoffProposal['provenance']>
}

const createPromptHandoffApplication = async (
  proposal: PromptHandoffProposal
): Promise<PromptHandoffApplication | null> => {
  if (!proposal.handoffBasis || !proposal.threadId || !proposal.provenance) return null
  const title = proposal.title?.trim() || 'Agent Prompt'
  const basisDigest = await sha256Text(pythonCanonicalJson(proposal.handoffBasis))
  const resultDigest = await sha256Text(pythonCanonicalJson({
    provenance: proposal.provenance,
    title,
    userText: proposal.userText
  }))
  const applicationDigest = await sha256Text(pythonCanonicalJson({
    basisDigest,
    conversationId: proposal.threadId,
    proposalId: proposal.id,
    resultDigest
  }))
  return {
    nodeId: `prompt-handoff-${applicationDigest.slice(7, 39)}`,
    marker: {
      version: 1,
      conversationId: proposal.threadId,
      proposalId: proposal.id,
      basisDigest,
      resultDigest
    },
    title,
    userText: proposal.userText,
    provenance: proposal.provenance
  }
}

const createBridgePromptApplication = async (
  delivery: BridgePromptDelivery
): Promise<PromptHandoffApplication> => {
  const title = delivery.visualProposal.title.trim() || 'External Agent Prompt'
  const basisDigest = await sha256Text(pythonCanonicalJson({
    cvcCode: delivery.request.target.cvcCode,
    normalizedRequestDigest: delivery.request.normalizedRequestDigest,
    sourceCodes: delivery.request.sourceCodes,
    skillPins: delivery.request.skillPins
  }))
  const provenance: PromptHandoffApplication['provenance'] = {
    model: {
      connectionId: `bridge:${delivery.operationContext.profileId}`,
      providerId: 'external-agent',
      modelId: delivery.operationContext.clientInfo?.name || delivery.operationContext.profileId,
      displayName: delivery.visualProposal.agentName,
      capabilities: {}
    },
    skills: delivery.request.skillPins.map(pin => ({
      skillId: pin.skillCode,
      revision: pin.revision,
      digest: pin.digest
    }))
  }
  const resultDigest = await sha256Text(pythonCanonicalJson({
    provenance,
    title,
    userText: delivery.visualProposal.userText
  }))
  const conversationId = `bridge:${delivery.operationContext.profileId}:${delivery.request.target.cvcCode}`
  const applicationDigest = await sha256Text(pythonCanonicalJson({
    basisDigest,
    conversationId,
    proposalId: delivery.proposalId,
    resultDigest
  }))
  return {
    nodeId: `bridge-prompt-${applicationDigest.slice(7, 39)}`,
    marker: {
      version: 1,
      conversationId,
      proposalId: delivery.proposalId,
      basisDigest,
      resultDigest
    },
    title,
    userText: delivery.visualProposal.userText,
    provenance
  }
}

const isBridgePromptDelivery = (
  delivery: BridgeDelivery
): delivery is BridgePromptDelivery => delivery.request.kind === 'prompt.create'

const isBridgeDocumentDelivery = (
  delivery: BridgeDelivery
): delivery is BridgeDocumentDelivery => (
  delivery.request.kind === 'document.create' || delivery.request.kind === 'document.change'
)

const isBridgeStoryboardDelivery = (
  delivery: BridgeDelivery
): delivery is BridgeStoryboardDelivery => (
  delivery.request.kind === 'storyboard.create' || delivery.request.kind === 'storyboard.change'
)

const promptHandoffSourceIsCurrent = (
  canvas: IFreeCanvasProject,
  basis: AgentPromptHandoffBasis
): boolean => {
  const source = exactCanvasNode(canvas, basis.nodeId)
  return basis.kind === 'document-selection'
    ? source?.kind === 'document' && matchesDocumentPromptHandoffBasis(source.document, basis)
    : source?.kind === 'storyboard'
      && (source.revision ?? 0) === basis.storyboardRevision
      && (source.digest ?? storyboardDigest(source.sequence, source.pendingFieldChanges)) === basis.storyboardDigest
      && source.pendingFieldChanges.length === 0
      && source.sequence.rows.some(row => row.id === basis.rowId && storyboardShotDigest(row) === basis.shotDigest)
}

const createPromptHandoffNode = (
  proposal: PromptHandoffProposal,
  application: PromptHandoffApplication,
  position: { x: number; y: number }
): IFreeCanvasTextNode => {
  const created = createFreeCanvasTextNode(proposal.userText, position)
  return {
    ...created,
    id: application.nodeId,
    title: application.title,
    segments: created.segments.map((segment, index) => ({
      ...segment,
      id: `${application.nodeId}-user-${index + 1}`,
      source: 'user'
    })),
    provenance: application.provenance,
    agentPromptHandoff: application.marker
  }
}

const createBridgePromptNode = (
  delivery: BridgePromptDelivery,
  application: PromptHandoffApplication,
  position: { x: number; y: number }
): IFreeCanvasTextNode => {
  const created = createFreeCanvasTextNode(delivery.visualProposal.userText, position)
  return {
    ...created,
    id: application.nodeId,
    title: application.title,
    segments: created.segments.map((segment, index) => ({
      ...segment,
      id: `${application.nodeId}-user-${index + 1}`,
      source: 'user'
    })),
    provenance: application.provenance,
    agentPromptHandoff: application.marker
  }
}

const inspectPromptHandoffApplication = (
  canvas: IFreeCanvasProject,
  application: PromptHandoffApplication
): { status: 'missing' | 'exact' | 'conflict' } => {
  const identityMatches = canvas.nodes.filter((node): node is IFreeCanvasTextNode => (
    node.kind === 'text'
    && node.agentPromptHandoff?.conversationId === application.marker.conversationId
    && node.agentPromptHandoff?.proposalId === application.marker.proposalId
  ))
  const deterministicMatches = canvas.nodes.filter(node => node.id === application.nodeId)
  if (identityMatches.length === 0 && deterministicMatches.length === 0) return { status: 'missing' }
  if (identityMatches.length !== 1
    || deterministicMatches.length !== 1
    || deterministicMatches[0] !== identityMatches[0]
  ) return { status: 'conflict' }
  const node = identityMatches[0]
  const marker = node.agentPromptHandoff
  if (!marker || Object.keys(marker).sort().join(',') !== 'basisDigest,conversationId,proposalId,resultDigest,version') {
    return { status: 'conflict' }
  }
  const exact = marker.version === 1
    && marker.conversationId === application.marker.conversationId
    && marker.proposalId === application.marker.proposalId
    && marker.basisDigest === application.marker.basisDigest
    && marker.resultDigest === application.marker.resultDigest
    && node.title === application.title
    && pythonCanonicalJson(node.provenance) === pythonCanonicalJson(application.provenance)
    && node.segments.length > 0
    && node.segments.every(segment => segment.source === 'user')
    && freeCanvasUserText(node) === application.userText
  return { status: exact ? 'exact' : 'conflict' }
}

const authoritativePersistedCanvas = (
  receipt: boolean | FreeCanvasPersistReceipt
): IFreeCanvasProject | null => (
  typeof receipt === 'object' && receipt.saved === true && receipt.freeCanvas
    ? receipt.freeCanvas
    : null
)

const canvasSnapshotIdentity = (canvas: IFreeCanvasProject): string => JSON.stringify(canvas)

const freeCanvasTemplateDigest = (node: IFreeCanvasTextNode): Promise<string> => sha256Text(pythonCanonicalJson({
  presetText: freeCanvasPresetText(node),
  segments: node.segments.filter(segment => segment.source === 'preset').map(segment => ({
    id: segment.id,
    source: segment.source,
    text: segment.text,
    color: segment.color
  }))
}))

const freeCanvasSegmentsDigest = (node: IFreeCanvasTextNode): Promise<string> => sha256Text(pythonCanonicalJson(
  node.segments.map(segment => ({
    id: segment.id,
    source: segment.source,
    text: segment.text,
    color: segment.color
  }))
))

const nodeTypes = {
  freeCanvasNode: FreeCanvasNode,
  imageGeneratorNode: ImageGeneratorFlowNode
}

const activeBridgeContextKey = (projectId: string): string => (
  `promptcard:active-bridge-context:${projectId}`
)

const readActiveBridgeContext = (projectId: string): string | null => {
  try {
    const value = globalThis.localStorage?.getItem(activeBridgeContextKey(projectId))
    return value && /^CVC-[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value) ? value : null
  } catch {
    return null
  }
}

const writeActiveBridgeContext = (projectId: string, cvcCode: string | null): void => {
  try {
    if (cvcCode) globalThis.localStorage?.setItem(activeBridgeContextKey(projectId), cvcCode)
    else globalThis.localStorage?.removeItem(activeBridgeContextKey(projectId))
  } catch {
    // Local UI preference is optional; Storage remains authoritative.
  }
}

const createLocalId = (prefix: string): string => globalThis.crypto?.randomUUID?.()
  || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const loadImageElement = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = () => reject(new Error('Image asset could not be loaded'))
  image.src = src
})

const mergeById = <T extends { id: string }>(current: readonly T[], incoming: readonly T[]): T[] => {
  const merged = new Map(current.map(item => [item.id, item]))
  incoming.forEach(item => merged.set(item.id, item))
  return Array.from(merged.values())
}

const imageGenerationPlaceholderFrame = (
  draft: Pick<ImageGenerationComposerDraft, 'aspectRatio' | 'width' | 'height'>
): { width: number; height: number } => {
  let ratio = 1
  if (draft.aspectRatio === 'custom' && draft.width && draft.height) {
    ratio = draft.width / draft.height
  } else {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(draft.aspectRatio)
    if (match) ratio = Number(match[1]) / Number(match[2])
  }
  if (!Number.isFinite(ratio) || ratio <= 0) ratio = 1
  return ratio >= 1
    ? { width: 320, height: Math.max(1, Math.round(320 / ratio)) }
    : { width: Math.max(1, Math.round(320 * ratio)), height: 320 }
}

const createOperationPlaceholder = ({
  snapshot,
  runId,
  conversationId,
  position,
  frame
}: {
  snapshot: ImageGenerationComposerDraft
  runId: string
  conversationId: string
  position: { x: number; y: number }
  frame: { width: number; height: number }
}): IFreeCanvasImageNode => {
  const placeholder = createFreeCanvasImageGenerationPlaceholder({
    runId,
    conversationId,
    prompt: promptDocumentPlainText(snapshot.promptDocument),
    position,
    width: frame.width,
    height: frame.height
  })
  const operation = snapshot.operation
  if (!operation) return placeholder
  const operationPlaceholderMeta = { ...placeholder.meta }
  delete operationPlaceholderMeta.conversationId
  return {
    ...placeholder,
    meta: {
      ...operationPlaceholderMeta,
      source: 'contextual-image-operation',
      imageOperation: operation.operation,
      imageRecipeId: operation.recipeId,
      imageRecipeVersion: operation.recipeVersion,
      sourceAssetId: operation.source.originalAssetId,
      sourceCanvasNodeId: operation.source.nodeId,
      ...(operation.operationGroupId ? { operationGroupId: operation.operationGroupId } : {}),
      ...(operation.operationItemId ? { operationItemId: operation.operationItemId } : {}),
      ...(operation.viewSpec ? { operationViewSpec: operation.viewSpec } : {})
    }
  }
}

const safeGenerationErrorCode = (value: unknown): string => (
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'generation_failed'
)

const imageGenerationRequestToDraft = (
  request: ImageGenerationRequest
): ImageGenerationComposerDraft => ({
  promptDocument: {
    version: 1,
    segments: request.promptDocument.segments.map(segment => ({ ...segment }))
  },
  workflow: request.mode === 'region-edit'
    ? 'region-edit'
    : request.mode === 'edit' ? 'smart-edit' : request.inputs.length > 0 ? 'reference-generate' : 'text-to-image',
  connectionId: request.connectionId,
  modelId: request.modelId,
  resolution: request.resolution,
  aspectRatio: request.aspectRatio,
  ...(request.width ? { width: request.width } : {}),
  ...(request.height ? { height: request.height } : {}),
  promptOptimization: request.promptOptimization,
  outputFormat: request.outputFormat,
  watermark: request.watermark,
  inputs: request.inputs.map(input => ({
    ...input,
    role: input.role || 'reference-image'
  })),
  regions: request.regions.map(region => ({ ...region })),
  operation: request.operation
})

const nextNodePosition = (reactFlow: ReturnType<typeof useReactFlow<FreeCanvasFlowNode>>, count: number) => (
  reactFlow.screenToFlowPosition({ x: window.innerWidth / 2 + count * 20, y: window.innerHeight / 2 + count * 16 })
)

const clampUnit = (value: number, max = 1): number =>
  Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), Math.max(0, max))

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Number.isFinite(value) ? value : min, min), max)

const fontSizeClass = (size: IFreeCanvasTextNode['fontSize']) => {
  if (size === 'small') return 'text-sm'
  if (size === 'medium') return 'text-base'
  if (size === 'extra-large') return 'text-3xl'
  if (size === 'huge') return 'text-5xl'
  return 'text-xl'
}

const userTextColor = (node: IFreeCanvasTextNode): string =>
  typeof node.meta.userTextColor === 'string'
    ? node.meta.userTextColor
    : node.segments.find(segment => segment.source === 'user')?.color || '#111827'

export default FreeCanvasBuilderScreen
