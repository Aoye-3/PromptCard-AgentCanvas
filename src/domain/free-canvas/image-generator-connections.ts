import type {
  IFreeCanvasEdge,
  IFreeCanvasProject,
  ImageInputRole
} from '@/models/PromptHistory.model'

export type ImageGeneratorConnectionValidationErrorCode =
  | 'source_node_not_found'
  | 'target_not_image_generator'
  | 'prompt_input_limit'
  | 'source_image_input_limit'
  | 'reference_image_input_limit'
  | 'image_input_limit'
  | 'image_generator_output_unavailable'
  | 'image_input_requires_image_source'
  | 'prompt_input_requires_text_source'

export interface ImageGeneratorConnectionValidationError {
  code: ImageGeneratorConnectionValidationErrorCode
}

export interface ImageGeneratorConnectionCandidate {
  source: string
  target: string
  targetHandle: ImageInputRole
}

export const validateImageGeneratorConnection = (
  project: IFreeCanvasProject,
  candidate: ImageGeneratorConnectionCandidate
): ImageGeneratorConnectionValidationError[] => {
  const sourceNode = project.nodes.find(node => node.id === candidate.source)
  if (!sourceNode) return [{ code: 'source_node_not_found' }]

  const targetNode = project.nodes.find(node => node.id === candidate.target)
  if (targetNode?.kind !== 'image-generator') return [{ code: 'target_not_image_generator' }]

  if (candidate.targetHandle === 'prompt' && sourceNode.kind !== 'text') {
    return [{ code: 'prompt_input_requires_text_source' }]
  }

  if (
    (candidate.targetHandle === 'source-image' || candidate.targetHandle === 'reference-image')
    && sourceNode.kind === 'image-generator'
    && !sourceNode.primaryAssetId
  ) {
    return [{ code: 'image_generator_output_unavailable' }]
  }

  if (
    (candidate.targetHandle === 'source-image' || candidate.targetHandle === 'reference-image')
    && sourceNode.kind !== 'image'
    && sourceNode.kind !== 'image-generator'
  ) {
    return [{ code: 'image_input_requires_image_source' }]
  }

  const inputCount = project.edges.filter(edge =>
    edge.target === candidate.target && edge.targetHandle === candidate.targetHandle
  ).length

  if (candidate.targetHandle === 'prompt' && inputCount >= 1) {
    return [{ code: 'prompt_input_limit' }]
  }
  if (candidate.targetHandle === 'source-image' && inputCount >= 1) {
    return [{ code: 'source_image_input_limit' }]
  }
  if (candidate.targetHandle === 'reference-image' && inputCount >= 10) {
    return [{ code: 'reference_image_input_limit' }]
  }
  if (
    (candidate.targetHandle === 'source-image' || candidate.targetHandle === 'reference-image')
    && project.edges.filter(edge =>
      edge.target === candidate.target
      && (edge.targetHandle === 'source-image' || edge.targetHandle === 'reference-image')
    ).length >= 10
  ) {
    return [{ code: 'image_input_limit' }]
  }
  return []
}

export const removeImageGeneratorConnection = (
  project: IFreeCanvasProject,
  edgeId: string
): IFreeCanvasProject => {
  const removedEdge = project.edges.find(edge => edge.id === edgeId)
  const edges = project.edges.filter(edge => edge.id !== edgeId)
  if (!removedEdge || removedEdge.targetHandle !== 'reference-image') {
    return { ...project, edges }
  }

  const inputOrderByEdgeId = new Map(
    edges
      .filter(edge => edge.target === removedEdge.target && edge.targetHandle === 'reference-image')
      .sort(compareReferenceEdges)
      .map((edge, inputOrder) => [edge.id, inputOrder])
  )

  return {
    ...project,
    edges: edges.map(edge => inputOrderByEdgeId.has(edge.id)
      ? { ...edge, inputOrder: inputOrderByEdgeId.get(edge.id) }
      : edge)
  }
}

const compareReferenceEdges = (left: IFreeCanvasEdge, right: IFreeCanvasEdge): number => {
  const leftOrder = typeof left.inputOrder === 'number' ? left.inputOrder : Number.MAX_SAFE_INTEGER
  const rightOrder = typeof right.inputOrder === 'number' ? right.inputOrder : Number.MAX_SAFE_INTEGER
  return leftOrder - rightOrder || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}
