import {
  buildFreeCanvasFormOutput,
  buildFreeCanvasGraph,
  getFreeCanvasMeta,
  type FreeCanvasFlowNode,
  type FreeCanvasMediaNode
} from './free-canvas'
import { normalizeThreeStagePages } from '@/domain/three-stage/three-stage-pages'
import type {
  IFreeCanvasEdge,
  FreeCanvasImageAnnotationKind,
  IFreeCanvasImageAnnotation,
  IFreeCanvasImageGeneratorNode,
  IFreeCanvasImageNode,
  IFreeCanvasNode,
  IFreeCanvasPosition,
  IFreeCanvasProject,
  IFreeCanvasDocumentNode,
  IFreeCanvasStoryboardNode,
  IFreeCanvasUnsupportedNode,
  IFreeCanvasTextNode,
  IFreeCanvasTextSegment,
  IFreeCanvasViewport,
  AgentAppliedEditMarker,
  PromptDocument,
  PromptSegment,
  IPromptProject
} from '@/models/PromptHistory.model'
import type { ImageRegion } from '@/domain/image-generation/image-generation'
import type { AgentRunProvenance } from '@/domain/agent/agent-provenance'
import { createPlanningDocumentV1, parsePlanningDocumentV1 } from '@/domain/documents/planning-document'
import { storyboardDigest } from '@/domain/storyboard/canvas-storyboard'

const DEFAULT_USER_COLOR = '#111827'
const DEFAULT_PRESET_COLOR = '#ef4423'
export const MAX_FREE_CANVAS_TEXT_INSERTIONS = 16

export type FreeCanvasTextInsertionAnchor =
  | { type: 'segment'; segmentId: string; position: 'before' | 'after' }
  | { type: 'text'; segmentId: string; text: string; position: 'before' | 'after' }

export interface FreeCanvasTextInsertion {
  text: string
  anchor: FreeCanvasTextInsertionAnchor
}

export interface FreeCanvasTextProposalBasis {
  baseNodeRevision: number
  templateDigest: string
  baseSegmentsDigest: string
}

export type FreeCanvasTextInsertionRejectionReason =
  | 'target_not_found'
  | 'too_many_insertions'
  | 'insertion_text_invalid'
  | 'anchor_invalid'
  | 'segment_anchor_not_found'
  | 'segment_anchor_not_unique'
  | 'text_anchor_not_found'
  | 'text_anchor_not_unique'

export interface FreeCanvasTextInsertionsPreview {
  segments?: IFreeCanvasTextSegment[]
  rejectionReason: FreeCanvasTextInsertionRejectionReason | null
}

export type FreeCanvasImageGenerationState = 'running' | 'succeeded' | 'failed'

export interface FreeCanvasImageGenerationPlaceholderInput {
  runId: string
  conversationId: string
  prompt: string
  position: IFreeCanvasPosition
  width: number
  height: number
}

export const createFreeCanvasProject = (
  timestamp = Date.now(),
  overrides: Partial<IFreeCanvasProject> = {}
): IFreeCanvasProject => normalizeFreeCanvasProject({
  nodes: overrides.nodes || [],
  edges: overrides.edges || [],
  viewport: overrides.viewport ?? null,
  selectedNodeId: overrides.selectedNodeId ?? null,
  meta: overrides.meta || {}
}, timestamp)

export const createFreeCanvasTextNode = (
  text: string,
  position: IFreeCanvasPosition,
  timestamp = Date.now(),
  source: 'preset' | 'user' = 'user'
): IFreeCanvasTextNode => {
  const trimmed = String(text || '')
  const id = `free-text-${timestamp}-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    kind: 'text',
    title: defaultFreeCanvasTextNodeTitle(id),
    position,
    width: 420,
    height: 180,
    fontSize: 'large',
    segments: trimmed ? [createTextSegment(trimmed, source, timestamp)] : [],
    meta: {}
  }
}

export const createQuickTextNode = (
  text: string,
  position: IFreeCanvasPosition,
  timestamp = Date.now()
): IFreeCanvasTextNode => createFreeCanvasTextNode(text, position, timestamp, 'preset')

export const createFreeCanvasDocumentNode = (
  position: IFreeCanvasPosition,
  timestamp = Date.now()
): IFreeCanvasDocumentNode => {
  const id = `free-document-${timestamp}-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    kind: 'document',
    title: '未命名文档',
    position: normalizePosition(position),
    width: 560,
    height: 420,
    document: createPlanningDocumentV1([
      { id: `${id}-paragraph-1`, type: 'paragraph', content: [] }
    ]),
    linkedDocumentResourceIds: [],
    meta: {}
  }
}

export const createFreeCanvasImageGeneratorNode = (
  position: IFreeCanvasPosition,
  binding: { connectionId: string; modelId: string },
  timestamp = Date.now()
): IFreeCanvasImageGeneratorNode => ({
  id: `free-image-generator-${timestamp}`,
  kind: 'image-generator',
  title: 'Image generator',
  position: normalizePosition(position),
  width: 420,
  height: 560,
  mode: 'generate',
  binding: { connectionId: binding.connectionId, modelId: binding.modelId },
  settings: {
    resolution: '1K',
    aspectRatio: 'smart',
    outputFormat: 'png',
    watermark: false
  },
  promptDocument: { version: 1, segments: [] },
  regions: [],
  meta: { status: 'idle' }
})

export const createFreeCanvasImageNodeFromMedia = (
  media: FreeCanvasMediaNode,
  timestamp = Date.now()
): IFreeCanvasImageNode => ({
  id: `free-image-${media.id || timestamp}`,
  kind: 'image',
  title: media.title || 'Image',
  position: normalizePosition(media.position),
  width: Number(media.width || 300),
  height: Number(media.height || 220),
  assetId: media.assetId || null,
  imageUrl: media.imageUrl || '',
  imagePrompt: media.imagePrompt || '',
  sourceNodeId: media.sourceNodeId || null,
  crop: media.crop || null,
  annotations: [],
  meta: { ...media.meta, legacyMediaNodeId: media.id }
})

export const createFreeCanvasImageGenerationPlaceholder = (
  input: FreeCanvasImageGenerationPlaceholderInput
): IFreeCanvasImageNode => ({
  id: `free-image-generation-${input.runId}`,
  kind: 'image',
  title: '生成图片',
  position: normalizePosition(input.position),
  width: Math.max(1, Number(input.width)),
  height: Math.max(1, Number(input.height)),
  assetId: null,
  imageUrl: '',
  imagePrompt: input.prompt,
  sourceNodeId: null,
  crop: null,
  annotations: [],
  meta: {
    generationRunId: input.runId,
    conversationId: input.conversationId,
    generationState: 'running',
    source: 'image-generation-conversation'
  }
})

export const completeFreeCanvasImageGeneration = (
  project: IFreeCanvasProject,
  runId: string,
  assetId: string,
  imageUrl: string
): IFreeCanvasProject => ({
  ...project,
  nodes: project.nodes.map(node => {
    if (node.kind !== 'image' || node.meta?.generationRunId !== runId) return node
    const meta: Record<string, unknown> = {
      ...node.meta,
      generationState: 'succeeded' satisfies FreeCanvasImageGenerationState,
      generatedResult: true
    }
    delete meta.generationErrorCode
    return { ...node, assetId, imageUrl, meta }
  })
})

export const failFreeCanvasImageGeneration = (
  project: IFreeCanvasProject,
  runId: string,
  errorCode: string
): IFreeCanvasProject => ({
  ...project,
  nodes: project.nodes.map(node => (
    node.kind === 'image' && node.meta?.generationRunId === runId
      ? {
          ...node,
          meta: {
            ...node.meta,
            generationState: 'failed' satisfies FreeCanvasImageGenerationState,
            generationErrorCode: errorCode
          }
        }
      : node
  ))
})

export const isRunningFreeCanvasImageGeneration = (node: IFreeCanvasNode): boolean => (
  node.kind === 'image' && node.meta?.generationState === 'running'
)

export const createFreeCanvasImageAnnotation = (
  kind: FreeCanvasImageAnnotationKind,
  timestamp = Date.now()
): IFreeCanvasImageAnnotation => {
  const base = {
    id: `image-annotation-${timestamp}-${kind}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    x: 0.08,
    y: 0.08,
    width: 0.24,
    height: 0.12,
    color: '#111827',
    createdAt: timestamp,
    updatedAt: timestamp,
    meta: {}
  }

  if (kind === 'rect') {
    return { ...base, width: 0.28, height: 0.18, fill: '#ffffff' }
  }
  if (kind === 'arrow') {
    return { ...base, x: 0.18, y: 0.18, width: 0.36, height: 0.08, color: '#ef4423' }
  }
  if (kind === 'freehand') {
    return {
      ...base,
      width: 0.34,
      height: 0.18,
      color: '#ef4423',
      strokeWidth: 4,
      points: [
        { x: 0.08, y: 0.7 },
        { x: 0.28, y: 0.3 },
        { x: 0.52, y: 0.58 },
        { x: 0.78, y: 0.24 },
        { x: 0.94, y: 0.42 }
      ]
    }
  }
  if (kind === 'shotNumber') {
    return { ...base, width: 0.065, height: 0.065, text: '1', color: '#ffffff', fill: '#111827' }
  }
  return { ...base, text: 'Text', color: '#111827' }
}

export const appendFreeCanvasUserText = (
  project: IFreeCanvasProject,
  nodeId: string,
  text: string,
  timestamp = Date.now()
): IFreeCanvasProject => updateTextNodeSegments(project, nodeId, segments => [
  ...segments,
  createTextSegment(text, 'user', timestamp)
])

export const updateFreeCanvasTextNodeUserText = (
  project: IFreeCanvasProject,
  nodeId: string,
  text: string,
  mode: 'replace' | 'append' = 'replace',
  timestamp = Date.now()
): IFreeCanvasProject => updateTextNodeSegments(project, nodeId, segments => {
  const presetSegments = segments.filter(segment => segment.source === 'preset')
  const userSegments = segments.filter(segment => segment.source === 'user')
  if (mode === 'append' && userSegments.length > 0) {
    const lastUserId = userSegments[userSegments.length - 1].id
    return segments.map(segment => segment.id === lastUserId
      ? { ...segment, text: [segment.text, text].filter(Boolean).join('\n'), updatedAt: timestamp }
      : segment)
  }
  return [
    ...presetSegments,
    createTextSegment(text, 'user', timestamp)
  ]
})

export const replaceFreeCanvasUserTextRange = (
  project: IFreeCanvasProject,
  nodeId: string,
  range: { start: number; end: number },
  insertedText: string,
  timestamp = Date.now()
): IFreeCanvasProject => {
  const node = project.nodes.find((candidate): candidate is IFreeCanvasTextNode => (
    candidate.id === nodeId && candidate.kind === 'text'
  ))
  if (!node) return project
  const userText = freeCanvasUserText(node)
  const start = clampNumber(range.start, 0, userText.length)
  const end = clampNumber(Math.max(range.end, start), start, userText.length)
  return updateFreeCanvasTextNodeUserText(
    project,
    nodeId,
    `${userText.slice(0, start)}${insertedText}${userText.slice(end)}`,
    'replace',
    timestamp
  )
}

export const previewFreeCanvasTextInsertions = (
  node: IFreeCanvasTextNode,
  insertions: FreeCanvasTextInsertion[],
  timestamp = Date.now()
): FreeCanvasTextInsertionsPreview => {
  if (insertions.length > MAX_FREE_CANVAS_TEXT_INSERTIONS) {
    return { rejectionReason: 'too_many_insertions' }
  }

  const resolved = insertions.map(insertion => resolveFreeCanvasTextInsertionAnchor(node.segments, insertion))
  const rejected = resolved.find((result): result is { rejectionReason: Exclude<FreeCanvasTextInsertionRejectionReason, 'target_not_found' | 'too_many_insertions'> } => (
    'rejectionReason' in result
  ))
  if (rejected) return { rejectionReason: rejected.rejectionReason }

  const insertionsBySegment = new Map<string, Array<{ offset: number; index: number }>>()
  resolved.forEach((result, index) => {
    if ('rejectionReason' in result) return
    insertionsBySegment.set(result.segmentId, [
      ...(insertionsBySegment.get(result.segmentId) || []),
      { offset: result.offset, index }
    ])
  })

  return {
    rejectionReason: null,
    segments: node.segments.flatMap(segment => previewSegmentInsertions(
      segment,
      insertionsBySegment.get(segment.id) || [],
      insertions,
      timestamp
    ))
  }
}

export const applyFreeCanvasTextInsertions = (
  project: IFreeCanvasProject,
  nodeId: string,
  insertions: FreeCanvasTextInsertion[],
  timestamp = Date.now()
): { project: IFreeCanvasProject; rejectionReason: FreeCanvasTextInsertionRejectionReason | null } => {
  const node = project.nodes.find((candidate): candidate is IFreeCanvasTextNode => (
    candidate.id === nodeId && candidate.kind === 'text'
  ))
  if (!node) return { project, rejectionReason: 'target_not_found' }

  const preview = previewFreeCanvasTextInsertions(node, insertions, timestamp)
  if (!preview.segments) return { project, rejectionReason: preview.rejectionReason }

  return {
    project: {
      ...project,
      nodes: project.nodes.map(candidate => candidate.id === nodeId
        ? { ...candidate, segments: preview.segments as IFreeCanvasTextSegment[] }
        : candidate)
    },
    rejectionReason: null
  }
}

export const createFreeCanvasAgentRewriteNode = (
  project: IFreeCanvasProject,
  source: IFreeCanvasTextNode,
  text: string,
  basis: FreeCanvasTextProposalBasis,
  timestamp = Date.now(),
  runProvenance?: AgentRunProvenance
): IFreeCanvasTextNode => {
  const position = nextFreeCanvasRewritePosition(project.nodes, source)
  const node = createFreeCanvasTextNode(text, position, timestamp, 'user')
  return {
    ...node,
    title: uniqueFreeCanvasRewriteTitle(project.nodes, source.title),
    width: source.width,
    height: source.height,
    fontSize: source.fontSize,
    meta: {
      ...node.meta,
      provenance: {
        kind: 'agent-rewrite',
        sourceNodeId: source.id,
        basis: { ...basis },
        ...(runProvenance
          ? { model: { ...runProvenance.model }, skills: runProvenance.skills.map(skill => ({ ...skill })) }
          : {})
      }
    }
  }
}

export const freeCanvasTextNodeRevision = (node: IFreeCanvasTextNode): number => (
  Math.max(0, ...node.segments.map(segment => segment.updatedAt))
)

export const matchesFreeCanvasTextProposalBasis = (
  node: IFreeCanvasTextNode,
  basis: FreeCanvasTextProposalBasis,
  digests: Pick<FreeCanvasTextProposalBasis, 'templateDigest' | 'baseSegmentsDigest'>
): boolean => (
  freeCanvasTextNodeRevision(node) === basis.baseNodeRevision
  && digests.templateDigest === basis.templateDigest
  && digests.baseSegmentsDigest === basis.baseSegmentsDigest
)

export const renameFreeCanvasTextNode = (
  project: IFreeCanvasProject,
  nodeId: string,
  title: string
): IFreeCanvasProject => {
  const normalizedTitle = String(title || '').trim()
  if (!normalizedTitle || normalizedTitle.length > 32 || normalizedTitle.includes('@')) {
    throw new Error('text_node_title_invalid')
  }
  const duplicate = project.nodes.some(node => (
    node.kind === 'text'
    && node.id !== nodeId
    && node.title.trim().toLocaleLowerCase() === normalizedTitle.toLocaleLowerCase()
  ))
  if (duplicate) throw new Error('text_node_title_duplicate')
  return {
    ...project,
    nodes: project.nodes.map(node => (
      node.kind === 'text' && node.id === nodeId ? { ...node, title: normalizedTitle } : node
    ))
  }
}

export const defaultFreeCanvasTextNodeTitle = (nodeId: string): string => {
  let hash = 2166136261
  for (const character of String(nodeId || 'text')) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `TXT-${(hash >>> 0).toString(36).toUpperCase().padStart(6, '0').slice(-6)}`
}

export const replaceFreeCanvasTextRange = (
  project: IFreeCanvasProject,
  nodeId: string,
  range: { start: number; end: number },
  insertedText: string,
  color = DEFAULT_USER_COLOR,
  timestamp = Date.now()
): IFreeCanvasProject => updateTextNodeSegments(project, nodeId, segments => {
  const fullTextLength = segments.reduce((total, segment) => total + segment.text.length, 0)
  const start = clampNumber(range.start, 0, fullTextLength)
  const end = clampNumber(Math.max(range.end, start), start, fullTextLength)
  const nextSegments: IFreeCanvasTextSegment[] = []
  let cursor = 0
  let inserted = false

  segments.forEach(segment => {
    const segmentText = String(segment.text || '')
    const segmentStart = cursor
    const segmentEnd = cursor + segmentText.length
    const beforeLength = clampNumber(start - segmentStart, 0, segmentText.length)
    const afterOffset = clampNumber(end - segmentStart, 0, segmentText.length)

    if (beforeLength > 0) {
      nextSegments.push(createTextSegmentWithColor(segmentText.slice(0, beforeLength), segment.source, segment.color, timestamp))
    }

    if (!inserted && segmentEnd >= start) {
      if (insertedText) {
        nextSegments.push(createTextSegmentWithColor(insertedText, 'user', color, timestamp))
      }
      inserted = true
    }

    if (afterOffset < segmentText.length) {
      nextSegments.push(createTextSegmentWithColor(segmentText.slice(afterOffset), segment.source, segment.color, timestamp))
    }

    cursor = segmentEnd
  })

  if (!inserted && insertedText) {
    nextSegments.push(createTextSegmentWithColor(insertedText, 'user', color, timestamp))
  }

  return mergeAdjacentTextSegments(nextSegments)
})

export const updateFreeCanvasNodePosition = (
  project: IFreeCanvasProject,
  nodeId: string,
  position: IFreeCanvasPosition
): IFreeCanvasProject => ({
  ...project,
  nodes: project.nodes.map(node => node.id === nodeId ? { ...node, position: normalizePosition(position) } : node)
})

export const updateFreeCanvasImageNodeFrame = (
  project: IFreeCanvasProject,
  nodeId: string,
  frame: { position?: IFreeCanvasPosition; width: number; height: number }
): IFreeCanvasProject => ({
  ...project,
  nodes: project.nodes.map(node => {
    if (node.id !== nodeId || node.kind !== 'image') return node
    return {
      ...node,
      position: frame.position ? normalizePosition(frame.position) : node.position,
      width: Math.max(1, Number(frame.width || node.width)),
      height: Math.max(1, Number(frame.height || node.height))
    }
  })
})

export const fitFreeCanvasImageNodeFrameToContent = (
  node: Pick<IFreeCanvasImageNode, 'position' | 'width' | 'height' | 'crop'>,
  naturalWidth: number,
  naturalHeight: number
): { position: IFreeCanvasPosition; width: number; height: number } | null => {
  const cropWidth = node.crop?.width ?? 1
  const cropHeight = node.crop?.height ?? 1
  const contentWidth = naturalWidth * cropWidth
  const contentHeight = naturalHeight * cropHeight
  if (
    !Number.isFinite(contentWidth)
    || !Number.isFinite(contentHeight)
    || !Number.isFinite(node.width)
    || !Number.isFinite(node.height)
    || contentWidth <= 0
    || contentHeight <= 0
    || node.width <= 0
    || node.height <= 0
  ) return null

  const contentRatio = contentWidth / contentHeight
  const frameRatio = node.width / node.height
  if (contentRatio >= frameRatio) {
    const height = node.width / contentRatio
    return {
      position: { x: node.position.x, y: node.position.y + (node.height - height) / 2 },
      width: node.width,
      height
    }
  }

  const width = node.height * contentRatio
  return {
    position: { x: node.position.x + (node.width - width) / 2, y: node.position.y },
    width,
    height: node.height
  }
}

export const addFreeCanvasImageAnnotation = (
  project: IFreeCanvasProject,
  nodeId: string,
  kind: FreeCanvasImageAnnotationKind,
  timestamp = Date.now()
): IFreeCanvasProject => insertFreeCanvasImageAnnotation(
  project,
  nodeId,
  createFreeCanvasImageAnnotation(kind, timestamp),
  timestamp
)

export const insertFreeCanvasImageAnnotation = (
  project: IFreeCanvasProject,
  nodeId: string,
  annotation: IFreeCanvasImageAnnotation,
  timestamp = Date.now()
): IFreeCanvasProject => ({
  ...project,
  nodes: project.nodes.map(node => node.id === nodeId && node.kind === 'image'
    ? { ...node, annotations: [...(node.annotations || []), normalizeImageAnnotation(annotation, timestamp)] }
    : node)
})

export const updateFreeCanvasImageAnnotation = (
  project: IFreeCanvasProject,
  nodeId: string,
  annotationId: string,
  updates: Partial<Omit<IFreeCanvasImageAnnotation, 'id' | 'kind' | 'createdAt'>>
): IFreeCanvasProject => ({
  ...project,
  nodes: project.nodes.map(node => {
    if (node.id !== nodeId || node.kind !== 'image') return node
    return {
      ...node,
      annotations: (node.annotations || []).map(annotation => annotation.id === annotationId
        ? normalizeImageAnnotation({ ...annotation, ...updates, updatedAt: Date.now() }, Date.now())
        : annotation)
    }
  })
})

export const removeFreeCanvasImageAnnotation = (
  project: IFreeCanvasProject,
  nodeId: string,
  annotationId: string
): IFreeCanvasProject => ({
  ...project,
  nodes: project.nodes.map(node => node.id === nodeId && node.kind === 'image'
    ? { ...node, annotations: (node.annotations || []).filter(annotation => annotation.id !== annotationId) }
    : node)
})

export const replaceFreeCanvasImageAnnotations = (
  project: IFreeCanvasProject,
  nodeId: string,
  annotations: IFreeCanvasImageAnnotation[],
  timestamp = Date.now()
): IFreeCanvasProject => ({
  ...project,
  nodes: project.nodes.map(node => node.id === nodeId && node.kind === 'image'
    ? { ...node, annotations: annotations.map(annotation => normalizeImageAnnotation(annotation, timestamp)) }
    : node)
})

export const updateFreeCanvasTextNodeStyle = (
  project: IFreeCanvasProject,
  nodeId: string,
  updates: Partial<Pick<IFreeCanvasTextNode, 'fontSize'>> & { color?: string }
): IFreeCanvasProject => ({
  ...project,
  nodes: project.nodes.map(node => {
    if (node.id !== nodeId || node.kind !== 'text') return node
    return {
      ...node,
      fontSize: updates.fontSize || node.fontSize,
      meta: updates.color ? { ...node.meta, userTextColor: updates.color } : node.meta,
      segments: updates.color
        ? node.segments.map(segment => segment.source === 'user' ? { ...segment, color: updates.color || segment.color } : segment)
        : node.segments
    }
  })
})

export const updateFreeCanvasTextSegments = (
  project: IFreeCanvasProject,
  nodeId: string,
  segments: IFreeCanvasTextSegment[]
): IFreeCanvasProject => updateTextNodeSegments(project, nodeId, () => segments.map(normalizeTextSegment))

export const removeFreeCanvasProjectNodes = (
  project: IFreeCanvasProject,
  nodeIds: string[]
): IFreeCanvasProject => {
  const requested = new Set(nodeIds)
  const removed = new Set(project.nodes
    .filter(node => requested.has(node.id) && !isRunningFreeCanvasImageGeneration(node))
    .map(node => node.id))
  return {
    ...project,
    nodes: project.nodes.filter(node => !removed.has(node.id)),
    edges: project.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)),
    selectedNodeId: project.selectedNodeId && removed.has(project.selectedNodeId) ? null : project.selectedNodeId || null
  }
}

export const normalizeFreeCanvasProject = (
  value: Partial<IFreeCanvasProject> | undefined,
  timestamp = Date.now()
): IFreeCanvasProject => {
  const nodes = Array.isArray(value?.nodes) ? value.nodes.map(node => normalizeNode(node, timestamp)).filter((node): node is IFreeCanvasNode => Boolean(node)) : []
  const nodeIds = new Set(nodes.map(node => node.id))
  const connectableNodeIds = new Set(nodes
    .filter(node => node.kind !== 'document' && node.kind !== 'storyboard' && node.kind !== 'unsupported')
    .map(node => node.id))
  const edges = Array.isArray(value?.edges)
    ? value.edges.map(edge => normalizeEdge(edge, timestamp)).filter(edge => (
        connectableNodeIds.has(edge.source) && connectableNodeIds.has(edge.target)
      ))
    : []
  const selectedNodeId = value?.selectedNodeId && nodeIds.has(value.selectedNodeId) ? value.selectedNodeId : null
  return {
    nodes,
    edges,
    viewport: normalizeViewport(value?.viewport),
    selectedNodeId,
    meta: value?.meta && typeof value.meta === 'object' ? value.meta : {}
  }
}

export const freeCanvasTextDisplay = (node: IFreeCanvasTextNode): string =>
  node.segments.map(segment => segment.text).filter(Boolean).join('\n')

export const freeCanvasTextSegmentsToPlainText = (segments: IFreeCanvasTextSegment[]): string =>
  segments.map(segment => segment.text).join('')

export const freeCanvasPresetText = (node: IFreeCanvasTextNode): string =>
  node.segments.filter(segment => segment.source === 'preset').map(segment => segment.text).filter(Boolean).join('\n')

export const freeCanvasUserText = (node: IFreeCanvasTextNode): string =>
  node.segments.filter(segment => segment.source === 'user').map(segment => segment.text).filter(Boolean).join('\n')

export const migrateLegacyThreeStageFreeCanvasProject = (project: IPromptProject): IPromptProject => {
  if (project.type !== 'three-stage' || project.meta?.builderTemplateId !== 'free-canvas' || !project.threeStage) return project

  const graph = buildFreeCanvasGraph(project.threeStage)
  const formsById = new Map(normalizeThreeStagePages(project.threeStage).flatMap(page =>
    page.items.map(item => [item.form.id, item.form] as const)
  ))
  const idMap = new Map<string, string>()
  const nodes = graph.nodes.flatMap((node, index) => {
    const migrated = migrateLegacyNode(node, index, formsById)
    if (migrated) idMap.set(node.id, migrated.id)
    return migrated ? [migrated] : []
  })
  const edges = getFreeCanvasMeta(project.threeStage).edges.flatMap(edge => {
    const source = idMap.get(edge.source)
    const target = idMap.get(edge.target)
    if (!source || !target) return []
    return [{
      id: edge.id,
      source,
      target,
      label: edge.label,
      createdAt: edge.createdAt
    }]
  })

  return {
    ...project,
    type: 'free-canvas',
    threeStage: undefined,
    freeCanvas: createFreeCanvasProject(Date.now(), {
      nodes,
      edges,
      selectedNodeId: nodes[0]?.id || null,
      meta: {
        migratedFrom: 'three-stage-free-canvas',
        migratedAt: Date.now()
      }
    }),
    meta: {
      ...project.meta,
      legacyBuilderTemplateId: project.meta.builderTemplateId,
      builderTemplateId: undefined
    }
  }
}

const migrateLegacyNode = (
  node: FreeCanvasFlowNode,
  index: number,
  formsById: Map<string, ReturnType<typeof normalizeThreeStagePages>[number]['items'][number]['form']>
): IFreeCanvasNode | null => {
  const timestamp = Date.now() + index
  const form = node.data.formId ? formsById.get(node.data.formId) : undefined
  if (node.data.nodeKind === 'threeStageForm' && form) {
    return {
      ...createFreeCanvasTextNode(buildFreeCanvasFormOutput(form), node.position, timestamp, 'user'),
      id: `free-text-${node.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      title: node.data.title,
      meta: { legacyNodeId: node.id, legacyFormId: node.data.formId, legacyFormType: node.data.formType }
    }
  }
  const media = node.data.mediaNode
  if (!media) return null
  if (media.kind === 'imageAsset') {
    return {
      ...createFreeCanvasImageNodeFromMedia(media, timestamp),
      id: `free-image-${media.id}`
    }
  }
  if (media.kind === 'arrowAnnotation') {
    return {
      id: `free-arrow-${media.id}`,
      kind: 'arrow',
      title: media.title || 'Arrow',
      position: normalizePosition(media.position),
      width: Number(media.width || 260),
      height: Number(media.height || 120),
      text: media.text || '',
      color: media.color || DEFAULT_USER_COLOR,
      meta: { legacyMediaNodeId: media.id }
    }
  }
  return {
    ...createFreeCanvasTextNode(media.text || '', normalizePosition(media.position), timestamp, 'user'),
    id: `free-text-${media.id}`,
    title: media.title || 'Text',
    width: Number(media.width || 360),
    height: Number(media.height || 160),
    meta: { legacyMediaNodeId: media.id }
  }
}

const updateTextNodeSegments = (
  project: IFreeCanvasProject,
  nodeId: string,
  update: (segments: IFreeCanvasTextSegment[]) => IFreeCanvasTextSegment[]
): IFreeCanvasProject => ({
  ...project,
  nodes: project.nodes.map(node => node.id === nodeId && node.kind === 'text'
    ? { ...node, segments: update(node.segments).map(normalizeTextSegment) }
    : node)
})

const createTextSegment = (
  text: string,
  source: 'preset' | 'user',
  timestamp: number
): IFreeCanvasTextSegment => createTextSegmentWithColor(
  text,
  source,
  source === 'preset' ? DEFAULT_PRESET_COLOR : DEFAULT_USER_COLOR,
  timestamp
)

const createTextSegmentWithColor = (
  text: string,
  source: 'preset' | 'user',
  color: string,
  timestamp: number
): IFreeCanvasTextSegment => ({
  id: `segment-${timestamp}-${source}-${Math.random().toString(36).slice(2, 8)}`,
  source,
  text: String(text || ''),
  color,
  createdAt: timestamp,
  updatedAt: timestamp
})

const mergeAdjacentTextSegments = (segments: IFreeCanvasTextSegment[]): IFreeCanvasTextSegment[] =>
  segments.filter(segment => segment.text).reduce<IFreeCanvasTextSegment[]>((merged, segment) => {
    const previous = merged[merged.length - 1]
    if (previous && previous.source === segment.source && previous.color === segment.color) {
      merged[merged.length - 1] = {
        ...previous,
        text: `${previous.text}${segment.text}`,
        updatedAt: Math.max(previous.updatedAt, segment.updatedAt)
      }
      return merged
    }
    return [...merged, segment]
  }, [])

const resolveFreeCanvasTextInsertionAnchor = (
  segments: IFreeCanvasTextSegment[],
  insertion: FreeCanvasTextInsertion
): { segmentId: string; offset: number } | { rejectionReason: Exclude<FreeCanvasTextInsertionRejectionReason, 'target_not_found' | 'too_many_insertions'> } => {
  if (!insertion || typeof insertion.text !== 'string' || !insertion.text) {
    return { rejectionReason: 'insertion_text_invalid' }
  }
  const anchor = insertion.anchor
  if (!anchor || (anchor.position !== 'before' && anchor.position !== 'after')) {
    return { rejectionReason: 'anchor_invalid' }
  }
  if (anchor.type !== 'segment' && anchor.type !== 'text') return { rejectionReason: 'anchor_invalid' }
  const matchingSegments = segments.filter(segment => segment.id === anchor.segmentId)
  if (matchingSegments.length === 0) {
    return { rejectionReason: 'segment_anchor_not_found' }
  }
  if (matchingSegments.length > 1) {
    return { rejectionReason: 'segment_anchor_not_unique' }
  }
  const segment = matchingSegments[0]
  if (anchor.type === 'segment') {
    return { segmentId: segment.id, offset: anchor.position === 'before' ? 0 : segment.text.length }
  }
  if (typeof anchor.text !== 'string' || !anchor.text) return { rejectionReason: 'anchor_invalid' }
  const firstIndex = segment.text.indexOf(anchor.text)
  if (firstIndex < 0) return { rejectionReason: 'text_anchor_not_found' }
  if (segment.text.indexOf(anchor.text, firstIndex + 1) >= 0) {
    return { rejectionReason: 'text_anchor_not_unique' }
  }
  return {
    segmentId: segment.id,
    offset: anchor.position === 'before' ? firstIndex : firstIndex + anchor.text.length
  }
}

const previewSegmentInsertions = (
  segment: IFreeCanvasTextSegment,
  events: Array<{ offset: number; index: number }>,
  insertions: FreeCanvasTextInsertion[],
  timestamp: number
): IFreeCanvasTextSegment[] => {
  if (events.length === 0) return [segment]
  const sortedEvents = [...events].sort((left, right) => left.offset - right.offset || left.index - right.index)
  const parts: Array<{ text: string; isOriginal: boolean; insertionIndex?: number }> = []
  let cursor = 0
  for (const event of sortedEvents) {
    if (event.offset > cursor) parts.push({ text: segment.text.slice(cursor, event.offset), isOriginal: true })
    parts.push({ text: insertions[event.index].text, isOriginal: false, insertionIndex: event.index })
    cursor = event.offset
  }
  if (cursor < segment.text.length) parts.push({ text: segment.text.slice(cursor), isOriginal: true })

  let originalPartIndex = 0
  return parts.flatMap(part => {
    if (!part.text) return []
    if (!part.isOriginal) {
      return [createTextSegmentWithColor(part.text, 'user', DEFAULT_USER_COLOR, timestamp + (part.insertionIndex || 0))]
    }
    const result = originalPartIndex === 0
      ? segment
      : { ...segment, id: `${segment.id}:slice:${timestamp}:${originalPartIndex}` }
    originalPartIndex += 1
    return [{ ...result, text: part.text }]
  })
}

const nextFreeCanvasRewritePosition = (
  nodes: IFreeCanvasNode[],
  source: IFreeCanvasTextNode
): IFreeCanvasPosition => {
  const candidate = { x: source.position.x + source.width + 48, y: source.position.y }
  const verticalStep = source.height + 24
  while (nodes.some(node => freeCanvasFramesOverlap(candidate, source.width, source.height, node))) {
    candidate.y += verticalStep
  }
  return candidate
}

const freeCanvasFramesOverlap = (
  position: IFreeCanvasPosition,
  width: number,
  height: number,
  node: IFreeCanvasNode
): boolean => (
  position.x < node.position.x + node.width
  && position.x + width > node.position.x
  && position.y < node.position.y + node.height
  && position.y + height > node.position.y
)

const uniqueFreeCanvasRewriteTitle = (nodes: IFreeCanvasNode[], sourceTitle: string): string => {
  const maxLength = 32
  const marker = ' · 改写'
  const sourceBase = (sourceTitle || 'Text').trim()
  const titleWithSuffix = (suffix: string) => (
    `${sourceBase.slice(0, maxLength - marker.length - suffix.length)}${marker}${suffix}`
  )
  const base = titleWithSuffix('')
  const existingTitles = new Set(nodes
    .filter((node): node is IFreeCanvasTextNode => node.kind === 'text')
    .map(node => node.title.trim().toLocaleLowerCase()))
  if (!existingTitles.has(base.toLocaleLowerCase())) return base
  let suffix = 2
  while (true) {
    const numericSuffix = ` (${suffix})`
    const candidate = titleWithSuffix(numericSuffix)
    if (!existingTitles.has(candidate.toLocaleLowerCase())) return candidate
    suffix += 1
  }
}

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Number.isFinite(value) ? value : min, min), max)

const normalizeNode = (node: Partial<IFreeCanvasNode>, timestamp: number): IFreeCanvasNode | null => {
  if (node.kind === 'image-generator') {
    return normalizeImageGeneratorNode(node, timestamp)
  }
  if (node.kind === 'image') {
    return {
      id: node.id || `free-image-${timestamp}`,
      kind: 'image',
      title: node.title || 'Image',
      position: normalizePosition(node.position),
      width: Number(node.width || 300),
      height: Number(node.height || 220),
      ...(typeof node.transient === 'boolean' ? { transient: node.transient } : {}),
      assetId: node.assetId || null,
      imageUrl: node.imageUrl || '',
      imagePrompt: node.imagePrompt || '',
      sourceNodeId: node.sourceNodeId || null,
      crop: node.crop || null,
      annotations: normalizeImageAnnotations(node.annotations, timestamp),
      ...(typeof node.referenceCode === 'string' ? { referenceCode: node.referenceCode } : {}),
      meta: node.meta || {}
    }
  }
  if (node.kind === 'arrow') {
    return {
      id: node.id || `free-arrow-${timestamp}`,
      kind: 'arrow',
      title: node.title || 'Arrow',
      position: normalizePosition(node.position),
      width: Number(node.width || 260),
      height: Number(node.height || 120),
      text: String(node.text || ''),
      color: node.color || DEFAULT_USER_COLOR,
      meta: node.meta || {}
    }
  }
  if (node.kind === 'text') {
    return {
      id: node.id || `free-text-${timestamp}`,
      kind: 'text',
      title: !node.title || node.title === 'Text'
        ? defaultFreeCanvasTextNodeTitle(node.id || `free-text-${timestamp}`)
        : node.title,
      position: normalizePosition(node.position),
      width: Number(node.width || 420),
      height: Number(node.height || 180),
      fontSize: node.fontSize || 'large',
      segments: Array.isArray(node.segments) ? node.segments.map(normalizeTextSegment) : [],
      ...(typeof node.referenceCode === 'string' ? { referenceCode: node.referenceCode } : {}),
      meta: node.meta || {}
    }
  }
  if (node.kind === 'document') {
    return normalizeDocumentNode(node, timestamp)
  }
  if (node.kind === 'storyboard') {
    return normalizeStoryboardNode(node, timestamp)
  }
  if (node.kind === 'unsupported') {
    return normalizeUnsupportedNode(node, timestamp)
  }

  // ADR-020: the terminal dispatch is lossless and inert; never reinterpret a future node as Prompt text or image.
  return normalizeUnsupportedNode({
    ...node,
    kind: 'unsupported',
    originalKind: typeof node.kind === 'string' ? node.kind : 'unknown',
    originalNode: cloneFrozenRecord({ ...node })
  }, timestamp)
}

const normalizeDocumentNode = (
  node: Partial<IFreeCanvasDocumentNode>,
  timestamp: number
): IFreeCanvasDocumentNode | IFreeCanvasUnsupportedNode => {
  const parsed = parsePlanningDocumentV1(node.document)
  const agentAppliedEdit = normalizeAgentAppliedEditMarker(node.agentAppliedEdit)
  if (!parsed.ok || (node.agentAppliedEdit !== undefined && !agentAppliedEdit)) {
    return normalizeUnsupportedNode({
      id: node.id,
      kind: 'unsupported',
      title: node.title,
      position: node.position,
      width: node.width,
      height: node.height,
      originalKind: 'document',
      originalNode: cloneFrozenRecord({ ...(node as unknown as Record<string, unknown>) }),
      meta: node.meta
    }, timestamp)
  }
  return {
    id: node.id || `free-document-${timestamp}`,
    kind: 'document',
    title: (node.title || 'Document').normalize('NFC'),
    position: normalizePosition(node.position),
    width: Number(node.width || 560),
    height: Number(node.height || 420),
    document: parsed.document,
    linkedDocumentResourceIds: Array.isArray(node.linkedDocumentResourceIds)
      ? node.linkedDocumentResourceIds.filter((resourceId): resourceId is string => typeof resourceId === 'string')
      : [],
    ...(node.provenance ? { provenance: cloneStructuredValue(node.provenance) } : {}),
    ...(agentAppliedEdit ? { agentAppliedEdit } : {}),
    meta: node.meta || {}
  }
}

const normalizeAgentAppliedEditMarker = (value: unknown): AgentAppliedEditMarker | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = ['conversationId', 'requestId', 'editId', 'resultDigest']
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(record, key))) {
    return null
  }
  if (keys.some(key => typeof record[key] !== 'string' || !(record[key] as string).normalize('NFC'))) return null
  const resultDigest = (record.resultDigest as string).normalize('NFC')
  if (!/^sha256:[0-9a-f]{64}$/u.test(resultDigest)) return null
  return {
    conversationId: (record.conversationId as string).normalize('NFC'),
    requestId: (record.requestId as string).normalize('NFC'),
    editId: (record.editId as string).normalize('NFC'),
    resultDigest
  }
}

const normalizeStoryboardNode = (
  node: Partial<IFreeCanvasStoryboardNode>,
  timestamp: number
): IFreeCanvasStoryboardNode | IFreeCanvasUnsupportedNode => {
  const sequence = cloneStructuredValue(node.sequence || {
    id: `sequence-${timestamp}`, name: 'Storyboard', description: '', style: '', constraints: '', rows: [],
    createdAt: timestamp, updatedAt: timestamp, meta: {}
  })
  const pendingFieldChanges = Array.isArray(node.pendingFieldChanges) ? cloneStructuredValue(node.pendingFieldChanges) : []
  const agentAppliedEdit = normalizeAgentAppliedEditMarker(node.agentAppliedEdit)
  const digest = storyboardDigest(sequence, pendingFieldChanges)
  if ((node.digest !== undefined && node.digest !== digest) || (node.agentAppliedEdit !== undefined && !agentAppliedEdit)) {
    return normalizeUnsupportedNode({
      id: node.id, kind: 'unsupported', title: node.title, position: node.position, width: node.width, height: node.height,
      originalKind: 'storyboard', originalNode: cloneFrozenRecord({ ...(node as unknown as Record<string, unknown>) }), meta: node.meta
    }, timestamp)
  }
  return {
    id: node.id || `free-storyboard-${timestamp}`,
    kind: 'storyboard',
    title: node.title || 'Storyboard',
    position: normalizePosition(node.position),
    width: Number(node.width || 640),
    height: Number(node.height || 480),
    sequence,
    source: cloneStructuredValue(node.source || {
      documentNodeId: '', documentRevision: 0, documentDigest: '', documentResourceDigests: [],
      model: { connectionId: '', providerId: '', modelId: '' }, skills: []
    }),
    pendingFieldChanges,
    ...(node.revision !== undefined ? { revision: Number(node.revision) } : {}),
    ...(node.digest !== undefined ? { digest } : {}),
    ...(agentAppliedEdit ? { agentAppliedEdit } : {}),
    meta: node.meta || {}
  }
}

const normalizeUnsupportedNode = (
  node: Partial<IFreeCanvasUnsupportedNode>,
  timestamp: number
): IFreeCanvasUnsupportedNode => ({
  id: node.id || `free-unsupported-${timestamp}`,
  kind: 'unsupported',
  title: node.title || 'Unsupported node',
  position: normalizePosition(node.position),
  width: Number(node.width || 360),
  height: Number(node.height || 220),
  originalKind: typeof node.originalKind === 'string' ? node.originalKind : 'unknown',
  originalNode: cloneFrozenRecord(node.originalNode || {}),
  meta: node.meta || {}
})

const cloneStructuredValue = <T>(value: T): T => structuredClone(value)

const cloneFrozenRecord = (value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => (
  deepFreeze(cloneStructuredValue({ ...value }))
)

const deepFreeze = <T>(value: T): T => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Reflect.ownKeys(value).forEach(key => deepFreeze(Reflect.get(value, key)))
  return Object.freeze(value)
}

const normalizeImageGeneratorNode = (
  node: Partial<IFreeCanvasImageGeneratorNode>,
  timestamp: number
): IFreeCanvasImageGeneratorNode => {
  const binding = node.binding
  const hasValidBinding = Boolean(
    binding
    && typeof binding.connectionId === 'string'
    && binding.connectionId
    && typeof binding.modelId === 'string'
    && binding.modelId
  )
  const meta = node.meta && typeof node.meta === 'object' ? node.meta : {}
  const existingWarnings = Array.isArray(meta.validationWarnings)
    ? meta.validationWarnings.filter((warning): warning is string => typeof warning === 'string')
    : []
  const validationWarnings = hasValidBinding
    ? existingWarnings
    : [...new Set([...existingWarnings, 'invalid_image_model_binding'])]
  const normalizedRegions = normalizeImageRegionsAndBindings(node.regions, meta)

  return {
    id: node.id || `free-image-generator-${timestamp}`,
    kind: 'image-generator',
    title: node.title || 'Image Generator',
    position: normalizePosition(node.position),
    width: Number(node.width || 420),
    height: Number(node.height || 560),
    mode: node.mode === 'edit' || node.mode === 'region-edit' ? node.mode : 'generate',
    binding: hasValidBinding
      ? { connectionId: binding!.connectionId, modelId: binding!.modelId }
      : { connectionId: '', modelId: '' },
    settings: normalizeImageGeneratorSettings(node.settings),
    promptDocument: normalizePromptDocument(node.promptDocument),
    regions: normalizedRegions.regions,
    ...(typeof node.activeRunId === 'string' ? { activeRunId: node.activeRunId } : {}),
    ...(typeof node.primaryAssetId === 'string' ? { primaryAssetId: node.primaryAssetId } : {}),
    meta: validationWarnings.length > 0
      ? { ...normalizedRegions.meta, validationWarnings }
      : normalizedRegions.meta
  }
}

const normalizeImageGeneratorSettings = (
  settings: Partial<IFreeCanvasImageGeneratorNode['settings']> | undefined
): IFreeCanvasImageGeneratorNode['settings'] => ({
  resolution: settings?.resolution === '2K' ? '2K' : '1K',
  aspectRatio: normalizeImageAspectRatio(settings?.aspectRatio),
  ...(typeof settings?.width === 'number' ? { width: settings.width } : {}),
  ...(typeof settings?.height === 'number' ? { height: settings.height } : {}),
  outputFormat: settings?.outputFormat === 'jpeg' ? 'jpeg' : 'png',
  watermark: settings?.watermark === true
})

const normalizeImageAspectRatio = (
  aspectRatio: IFreeCanvasImageGeneratorNode['settings']['aspectRatio'] | undefined
): IFreeCanvasImageGeneratorNode['settings']['aspectRatio'] => {
  if (
    aspectRatio === '1:1'
    || aspectRatio === '4:3'
    || aspectRatio === '3:4'
    || aspectRatio === '16:9'
    || aspectRatio === '9:16'
    || aspectRatio === '3:2'
    || aspectRatio === '2:3'
    || aspectRatio === '21:9'
    || aspectRatio === 'custom'
  ) return aspectRatio
  return 'smart'
}

const normalizePromptDocument = (document: Partial<PromptDocument> | undefined): PromptDocument => ({
  version: 1,
  segments: Array.isArray(document?.segments)
    ? document.segments.flatMap(segment => normalizePromptSegment(segment))
    : []
})

const normalizePromptSegment = (segment: Partial<PromptSegment>): PromptSegment[] => {
  if (segment.type === 'reference') {
    return typeof segment.referenceId === 'string' && typeof segment.label === 'string'
      ? [{ type: 'reference', referenceId: segment.referenceId, label: segment.label }]
      : []
  }
  return segment.type === 'text' && typeof segment.text === 'string'
    ? [{ type: 'text', text: segment.text }]
    : []
}

const normalizeImageRegions = (regions: ImageRegion[] | undefined): ImageRegion[] => {
  if (!Array.isArray(regions)) return []
  const normalized: ImageRegion[] = []
  regions.forEach(region => {
    if (!region || typeof region !== 'object') return
    if (region.type === 'point') {
      const x = finiteNumber(region.x)
      const y = finiteNumber(region.y)
      if (x === null || y === null) return
      normalized.push({ type: 'point', x: gridInteger(x), y: gridInteger(y) })
    }
    if (region.type === 'bbox') {
      const x = finiteNumber(region.x)
      const y = finiteNumber(region.y)
      const width = finiteNumber(region.width)
      const height = finiteNumber(region.height)
      if (x === null || y === null || width === null || height === null) return
      const left = gridInteger(Math.min(x, x + width))
      const right = gridInteger(Math.max(x, x + width))
      const top = gridInteger(Math.min(y, y + height))
      const bottom = gridInteger(Math.max(y, y + height))
      if (right <= left || bottom <= top) return
      normalized.push({
        type: 'bbox',
        x: left,
        y: top,
        width: right - left,
        height: bottom - top
      })
    }
  })
  return normalized
}

const normalizeImageRegionsAndBindings = (
  regions: ImageRegion[] | undefined,
  meta: Record<string, unknown>
): { regions: ImageRegion[]; meta: Record<string, unknown> } => {
  const sourceBindings = meta.imageRegionBindings
  if (!Array.isArray(sourceBindings)) {
    return { regions: normalizeImageRegions(regions), meta }
  }

  const normalizedRegions: ImageRegion[] = []
  const normalizedBindings: Array<{ regionId: string; referenceId: string }> = []
  const sourceRegions = Array.isArray(regions) ? regions : []

  sourceRegions.forEach((region, sourceIndex) => {
    const normalizedRegion = normalizeImageRegions([region])[0]
    if (!normalizedRegion) return

    const binding = sourceBindings[sourceIndex]
    const normalizedIndex = normalizedRegions.length
    normalizedRegions.push(normalizedRegion)
    normalizedBindings.push(
      binding
      && typeof binding === 'object'
      && typeof binding.regionId === 'string'
      && typeof binding.referenceId === 'string'
        ? { regionId: binding.regionId, referenceId: binding.referenceId }
        : { regionId: `region-${normalizedIndex}`, referenceId: '' }
    )
  })

  return {
    regions: normalizedRegions,
    meta: { ...meta, imageRegionBindings: normalizedBindings }
  }
}

const finiteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
)

const gridInteger = (value: number): number => Math.min(Math.max(Math.round(value), 0), 999)

const normalizeTextSegment = (segment: Partial<IFreeCanvasTextSegment>): IFreeCanvasTextSegment => {
  const source = segment.source === 'preset' ? 'preset' : 'user'
  const now = Date.now()
  return {
    id: segment.id || `segment-${now}-${source}`,
    source,
    text: String(segment.text || ''),
    color: segment.color || (source === 'preset' ? DEFAULT_PRESET_COLOR : DEFAULT_USER_COLOR),
    createdAt: Number(segment.createdAt || now),
    updatedAt: Number(segment.updatedAt || segment.createdAt || now)
  }
}

const normalizePosition = (position: Partial<IFreeCanvasPosition> | undefined): IFreeCanvasPosition => ({
  x: Number(position?.x || 0),
  y: Number(position?.y || 0)
})

const normalizeImageAnnotations = (
  annotations: IFreeCanvasImageAnnotation[] | undefined,
  timestamp: number
): IFreeCanvasImageAnnotation[] =>
  Array.isArray(annotations)
    ? annotations.map(annotation => normalizeImageAnnotation(annotation, timestamp))
    : []

const normalizeImageAnnotation = (
  annotation: Partial<IFreeCanvasImageAnnotation>,
  timestamp: number
): IFreeCanvasImageAnnotation => {
  const kind = normalizeAnnotationKind(annotation.kind)
  return {
    id: annotation.id || `image-annotation-${timestamp}`,
    kind,
    x: clampNumber(annotation.x ?? 0.08, 0, 1),
    y: clampNumber(annotation.y ?? 0.08, 0, 1),
    width: clampNumber(annotation.width ?? defaultAnnotationSize(kind).width, 0.01, 1),
    height: clampNumber(annotation.height ?? defaultAnnotationSize(kind).height, 0.01, 1),
    text: typeof annotation.text === 'string' ? annotation.text : defaultAnnotationText(kind),
    color: annotation.color || (kind === 'arrow' || kind === 'freehand' ? '#ef4423' : kind === 'shotNumber' ? '#ffffff' : '#111827'),
    fill: annotation.fill || (kind === 'rect' ? '#ffffff' : kind === 'shotNumber' ? '#111827' : undefined),
    points: Array.isArray(annotation.points)
      ? annotation.points.map(point => ({
        x: clampNumber(point.x, 0, 1),
        y: clampNumber(point.y, 0, 1)
      }))
      : kind === 'freehand' ? createFreeCanvasImageAnnotation('freehand', timestamp).points : undefined,
    strokeWidth: annotation.strokeWidth ? clampNumber(annotation.strokeWidth, 1, 24) : kind === 'freehand' ? 4 : undefined,
    createdAt: Number(annotation.createdAt || timestamp),
    updatedAt: Number(annotation.updatedAt || annotation.createdAt || timestamp),
    meta: annotation.meta || {}
  }
}

const normalizeAnnotationKind = (kind: unknown): FreeCanvasImageAnnotationKind => {
  if (kind === 'rect' || kind === 'arrow' || kind === 'freehand' || kind === 'shotNumber') return kind
  return 'text'
}

const defaultAnnotationSize = (kind: FreeCanvasImageAnnotationKind): { width: number; height: number } => {
  if (kind === 'shotNumber') return { width: 0.065, height: 0.065 }
  if (kind === 'rect') return { width: 0.28, height: 0.18 }
  if (kind === 'arrow') return { width: 0.36, height: 0.08 }
  if (kind === 'freehand') return { width: 0.34, height: 0.18 }
  return { width: 0.24, height: 0.12 }
}

const defaultAnnotationText = (kind: FreeCanvasImageAnnotationKind): string | undefined => {
  if (kind === 'shotNumber') return '1'
  if (kind === 'text') return 'Text'
  return undefined
}

const normalizeViewport = (viewport: Partial<IFreeCanvasViewport> | null | undefined): IFreeCanvasViewport | null => {
  if (!viewport) return null
  return {
    x: Number(viewport.x || 0),
    y: Number(viewport.y || 0),
    zoom: Number(viewport.zoom || 1)
  }
}

const normalizeEdge = (edge: Partial<IFreeCanvasEdge>, timestamp: number): IFreeCanvasEdge => ({
  id: edge.id || `free-edge-${edge.source || 'source'}-${edge.target || 'target'}-${timestamp}`,
  source: String(edge.source || ''),
  target: String(edge.target || ''),
  ...(typeof edge.sourceHandle === 'string' ? { sourceHandle: edge.sourceHandle } : {}),
  ...(edge.targetHandle === 'prompt' || edge.targetHandle === 'source-image' || edge.targetHandle === 'reference-image'
    ? { targetHandle: edge.targetHandle }
    : {}),
  ...(typeof edge.inputOrder === 'number' ? { inputOrder: edge.inputOrder } : {}),
  ...(typeof edge.referenceId === 'string' ? { referenceId: edge.referenceId } : {}),
  label: edge.label ? String(edge.label) : undefined,
  createdAt: Number(edge.createdAt || timestamp)
})
