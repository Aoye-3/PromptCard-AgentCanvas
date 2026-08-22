import type { ICard } from './Card.model'
import type { IPage } from '@/stores/card-initial-state'
import type { ImageGenerationMode, ImageRegion } from '@/domain/image-generation/image-generation'
import type { ImageModelBinding } from '@/domain/models/model-management'

export interface IPromptHistory {
  id: string
  content: string
  cards: ICard[]
  pages?: IPage[]
  title?: string
  score: number
  variants?: string[]
  createdAt: number
  meta: Record<string, any>
}

export interface IPromptProject {
  id: string
  /** Storage response projection. Never use as persisted project authority. */
  referenceCode?: string
  title: string
  type: 'card' | 'storyboard' | 'three-stage' | 'free-canvas'
  revision: number
  pages: IPage[]
  currentPage: number
  storyboard?: IStoryboardProject
  threeStage?: IThreeStageProject
  freeCanvas?: IFreeCanvasProject
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  meta: Record<string, any>
}

export type FreeCanvasProjectNodeKind = 'text' | 'image' | 'arrow' | 'image-generator'
export type FreeCanvasTextSegmentSource = 'preset' | 'user'
export type FreeCanvasTextSize = 'small' | 'medium' | 'large' | 'extra-large' | 'huge'
export type FreeCanvasImageAnnotationKind = 'text' | 'rect' | 'arrow' | 'freehand' | 'shotNumber'
export type ImageInputRole = 'prompt' | 'source-image' | 'reference-image'
export type FreeCanvasImageResolution = '1K' | '2K'
export type FreeCanvasImageAspectRatio = 'smart' | '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' | '21:9' | 'custom'
export type FreeCanvasImageOutputFormat = 'png' | 'jpeg'

export type PromptSegment =
  | { type: 'text'; text: string }
  | { type: 'reference'; referenceId: string; label: string }

export interface PromptDocument {
  version: 1
  segments: PromptSegment[]
}

export interface IFreeCanvasImageGeneratorSettings {
  resolution: FreeCanvasImageResolution
  aspectRatio: FreeCanvasImageAspectRatio
  width?: number
  height?: number
  outputFormat: FreeCanvasImageOutputFormat
  watermark: boolean
}

export interface IFreeCanvasPosition {
  x: number
  y: number
}

export interface IFreeCanvasCropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface IFreeCanvasTextSegment {
  id: string
  source: FreeCanvasTextSegmentSource
  text: string
  color: string
  createdAt: number
  updatedAt: number
}

export interface IFreeCanvasImageAnnotation {
  id: string
  kind: FreeCanvasImageAnnotationKind
  x: number
  y: number
  width: number
  height: number
  text?: string
  color: string
  fill?: string
  points?: IFreeCanvasPosition[]
  strokeWidth?: number
  createdAt: number
  updatedAt: number
  meta: Record<string, unknown>
}

export interface IFreeCanvasBaseNode {
  id: string
  /** Storage response projection for supported stable Canvas nodes. */
  referenceCode?: string
  kind: FreeCanvasProjectNodeKind
  title: string
  position: IFreeCanvasPosition
  width: number
  height: number
  meta: Record<string, unknown>
}

export interface IFreeCanvasTextNode extends IFreeCanvasBaseNode {
  kind: 'text'
  fontSize: FreeCanvasTextSize
  segments: IFreeCanvasTextSegment[]
}

export interface IFreeCanvasImageNode extends IFreeCanvasBaseNode {
  kind: 'image'
  transient?: boolean
  assetId?: string | null
  imageUrl?: string
  imagePrompt?: string
  sourceNodeId?: string | null
  crop?: IFreeCanvasCropRect | null
  annotations: IFreeCanvasImageAnnotation[]
}

export interface IFreeCanvasArrowNode extends IFreeCanvasBaseNode {
  kind: 'arrow'
  text: string
  color: string
}

export interface IFreeCanvasImageGeneratorNode extends IFreeCanvasBaseNode {
  kind: 'image-generator'
  mode: ImageGenerationMode
  binding: ImageModelBinding
  settings: IFreeCanvasImageGeneratorSettings
  promptDocument: PromptDocument
  regions: ImageRegion[]
  activeRunId?: string
  primaryAssetId?: string
}

export type IFreeCanvasNode = IFreeCanvasTextNode | IFreeCanvasImageNode | IFreeCanvasArrowNode | IFreeCanvasImageGeneratorNode

export interface IFreeCanvasEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: ImageInputRole
  inputOrder?: number
  referenceId?: string
  label?: string
  createdAt: number
}

export interface IFreeCanvasViewport {
  x: number
  y: number
  zoom: number
}

export interface IFreeCanvasProject {
  nodes: IFreeCanvasNode[]
  edges: IFreeCanvasEdge[]
  viewport?: IFreeCanvasViewport | null
  selectedNodeId?: string | null
  meta: Record<string, unknown>
}

export type ThreeStageKey = 'character' | 'object' | 'storyboard' | 'videoPrompt'

export interface IThreeStageProject {
  character: IThreeStageSection
  storyboard: IThreeStageSection
  videoPrompt: IThreeStageSection
  selectedStage: ThreeStageKey
  selectedFieldId: string
  pages?: IThreeStagePage[]
  selectedPageId?: string | null
  selectedFormId?: string | null
  selectedPairId?: string | null
  meta: Record<string, unknown>
}

export interface IThreeStageSection {
  fields: Record<string, string>
  focusedFieldId?: string | null
  updatedAt: number
  meta: Record<string, unknown>
}

export type ThreeStageItemKind = 'form' | 'character' | 'storyVideoPair'

export interface IThreeStageForm {
  id: string
  type: ThreeStageKey
  number: number
  title: string
  section: IThreeStageSection
  sourceFormId?: string | null
  createdAt: number
  updatedAt: number
  meta: Record<string, unknown>
}

export interface IThreeStageFormItem {
  id: string
  kind: 'form'
  form: IThreeStageForm
  createdAt: number
  updatedAt: number
  meta: Record<string, unknown>
}

/** @deprecated Legacy independent form item kept for old persisted projects. */
export interface IThreeStageCharacterItem {
  id: string
  kind: 'character'
  form: IThreeStageForm
  createdAt: number
  updatedAt: number
  meta: Record<string, unknown>
}

/** @deprecated Legacy bound pair item normalized into adjacent independent form items. */
export interface IThreeStageStoryVideoPairItem {
  id: string
  kind: 'storyVideoPair'
  pairId: string
  number: number
  storyboardForm: IThreeStageForm
  videoPromptForm: IThreeStageForm
  createdAt: number
  updatedAt: number
  meta: Record<string, unknown>
}

export type IThreeStageItem = IThreeStageFormItem | IThreeStageCharacterItem | IThreeStageStoryVideoPairItem

export interface IThreeStagePage {
  id: string
  title: string
  items: IThreeStageFormItem[]
  selectedItemId?: string | null
  createdAt: number
  updatedAt: number
  meta: Record<string, unknown>
}

export interface IStoryboardProject {
  aspectRatio: '16:9' | '9:16' | '1:1'
  sequences: IStoryboardSequence[]
  selectedSequenceId?: string | null
  selectedRowId?: string | null
  meta: Record<string, any>
  /** @deprecated Legacy flat storyboard data; normalized into sequences on load. */
  sequenceStyle?: string
  /** @deprecated Legacy flat storyboard data; normalized into sequences on load. */
  sequenceConstraints?: string
  /** @deprecated Legacy flat storyboard data; normalized into sequences on load. */
  rows?: IStoryboardRow[]
}

export interface IStoryboardSequence {
  id: string
  name: string
  description: string
  style: string
  constraints: string
  rows: IStoryboardRow[]
  createdAt: number
  updatedAt: number
  meta: Record<string, any>
}

export interface IStoryboardRow {
  id: string
  cutLabel: string
  timeRange: string
  imageUrl?: string
  subject: string
  action: string
  scene: string
  camera: string
  lighting?: string
  audio?: string
  duration: string
  createdAt: number
  updatedAt: number
}
