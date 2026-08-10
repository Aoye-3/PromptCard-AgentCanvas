import type { ImageGenerationRequest, ImageGenerationRegion } from '@/services/image-generation-client'
import type { ImageGenerationRun } from '@/storage/storage-service-client'
import type { IFreeCanvasNode, PromptDocument } from '@/models/PromptHistory.model'
import { freeCanvasTextSegmentsToPlainText } from '@/domain/free-canvas/free-canvas-project'
import type { ImageOperationRecipeSnapshot } from '@/domain/image-actions/image-operations'

export type ProjectImageGenerationWorkflow =
  | 'text-to-image'
  | 'reference-generate'
  | 'smart-edit'
  | 'region-edit'

export interface ProjectImageGenerationInput {
  referenceId: string
  assetId: string
  sourceAssetId?: string
  order: number
  role: 'source-image' | 'reference-image'
  label?: string
}

export interface ProjectImageGenerationTextReference {
  nodeId: string
  label: string
  text: string
  order: number
}

export interface ImageGenerationComposerDraft {
  promptDocument: PromptDocument
  workflow: ProjectImageGenerationWorkflow
  connectionId: string
  modelId: string
  resolution: string
  aspectRatio: string
  width?: number
  height?: number
  promptOptimization: 'standard' | 'fast'
  outputFormat: 'png' | 'jpeg'
  watermark: boolean
  inputs: ProjectImageGenerationInput[]
  textReferences?: ProjectImageGenerationTextReference[]
  regions: ImageGenerationRegion[]
  operation?: ImageOperationRecipeSnapshot
}

export interface CanvasInjectionResult {
  draft: ImageGenerationComposerDraft
  rejected: Array<{ nodeId: string; reason: string }>
}

export const createEmptyConversationDraft = (
  preferences: Partial<Pick<ImageGenerationComposerDraft,
    'connectionId' | 'modelId' | 'resolution' | 'aspectRatio' | 'width' | 'height'
    | 'promptOptimization' | 'outputFormat' | 'watermark'>> = {}
): ImageGenerationComposerDraft => ({
  promptDocument: { version: 1, segments: [{ type: 'text', text: '' }] },
  workflow: 'text-to-image',
  connectionId: preferences.connectionId || '',
  modelId: preferences.modelId || '',
  resolution: preferences.resolution || '2K',
  aspectRatio: preferences.aspectRatio || '1:1',
  ...(preferences.width ? { width: preferences.width } : {}),
  ...(preferences.height ? { height: preferences.height } : {}),
  promptOptimization: preferences.promptOptimization || 'standard',
  outputFormat: preferences.outputFormat || 'png',
  watermark: preferences.watermark === true,
  inputs: [],
  textReferences: [],
  regions: [],
  operation: undefined
})

export const buildConversationGenerationRequest = (
  projectId: string,
  conversationId: string,
  draft: ImageGenerationComposerDraft
): ImageGenerationRequest => ({
  projectId,
  conversationId,
  connectionId: draft.connectionId,
  modelId: draft.modelId,
  mode: workflowMode(draft.workflow),
  promptDocument: compileConversationPromptDocument(draft),
  inputs: [...draft.inputs]
    .sort((left, right) => left.order - right.order)
    .map(({ referenceId, role, assetId, sourceAssetId, order }) => ({
      referenceId,
      role,
      assetId,
      ...(sourceAssetId ? { sourceAssetId } : {}),
      order
    })),
  regions: draft.regions.map(region => ({ ...region })),
  resolution: draft.resolution,
  aspectRatio: draft.aspectRatio,
  ...(draft.aspectRatio === 'custom' && draft.width && draft.height
    ? { width: draft.width, height: draft.height }
    : {}),
  outputFormat: draft.outputFormat,
  watermark: draft.watermark,
  promptOptimization: draft.promptOptimization,
  ...(draft.operation ? { operation: cloneOperationSnapshot(draft.operation) } : {})
})

export const injectCanvasNodesIntoDraft = (
  current: ImageGenerationComposerDraft,
  nodes: readonly IFreeCanvasNode[]
): CanvasInjectionResult => {
  const inputs = [...current.inputs]
  const textReferences = [...(current.textReferences || [])]
  const rejected: CanvasInjectionResult['rejected'] = []

  for (const node of nodes) {
    if (node.kind === 'text') {
      const text = freeCanvasTextSegmentsToPlainText(node.segments).trim()
      if (!text) {
        rejected.push({ nodeId: node.id, reason: '文字节点没有可见文本。' })
      } else {
        const existingIndex = textReferences.findIndex(reference => reference.nodeId === node.id)
        const reference = {
          nodeId: node.id,
          label: node.title,
          text,
          order: existingIndex >= 0 ? textReferences[existingIndex].order : textReferences.length
        }
        if (existingIndex >= 0) textReferences[existingIndex] = reference
        else textReferences.push(reference)
      }
      continue
    }
    if (node.kind === 'image') {
      if (!node.assetId) {
        rejected.push({ nodeId: node.id, reason: '图片节点没有可用的本地资产。' })
      } else if (inputs.length >= 10) {
        rejected.push({ nodeId: node.id, reason: '图片输入已达到 10 张上限。' })
      } else {
        inputs.push({
          referenceId: `canvas-${node.id}-${inputs.length + 1}`,
          assetId: node.assetId,
          order: inputs.length,
          role: 'reference-image',
          label: node.title
        })
      }
      continue
    }
    rejected.push({ nodeId: node.id, reason: '该节点类型不能作为图片生成输入。' })
  }

  return {
    draft: {
      ...current,
      inputs,
      textReferences,
      workflow: current.workflow === 'text-to-image' && inputs.length > 0
        ? 'reference-generate'
        : current.workflow
    },
    rejected
  }
}

export const compileConversationPromptDocument = (
  draft: ImageGenerationComposerDraft
): PromptDocument => [...(draft.textReferences || [])]
  .sort((left, right) => left.order - right.order)
  .reduce(
    (document, reference) => appendPromptText(document, reference.text),
    clonePromptDocument(draft.promptDocument)
  )

export const removeConversationTextReference = (
  draft: ImageGenerationComposerDraft,
  nodeId: string
): ImageGenerationComposerDraft => ({
  ...draft,
  textReferences: [...(draft.textReferences || [])]
    .sort((left, right) => left.order - right.order)
    .filter(reference => reference.nodeId !== nodeId)
    .map((reference, order) => ({ ...reference, order }))
})

export const projectRunToTurn = (
  run: ImageGenerationRun,
  modelLabel: (modelId: string) => string = modelId => modelId
) => {
  const snapshot = run.requestSnapshot
  const prompt = snapshot.promptDocument.segments.map(segment => (
    segment.type === 'text' ? segment.text : `@${segment.label}`
  )).join('')
  const assetId = run.outputAssetIds[0]
  return {
    id: run.id,
    createdAt: run.createdAt,
    prompt,
    state: run.state,
    settings: {
      workflow: modeWorkflow(snapshot.mode, snapshot.inputAssets.length),
      modelLabel: modelLabel(run.modelId),
      resolution: snapshot.resolution,
      aspectRatio: snapshot.aspectRatio || '智能',
      outputFormat: snapshot.outputFormat,
      watermark: snapshot.watermark
    },
    inputs: snapshot.inputAssets.map(input => ({
      referenceId: input.referenceId,
      assetId: input.assetId,
      imageUrl: `/storage-api/assets/${encodeURIComponent(input.assetId)}`
    })),
    regionCount: snapshot.regions.length,
    ...(assetId ? {
      result: {
        assetId,
        imageUrl: `/storage-api/assets/${encodeURIComponent(assetId)}`,
        width: snapshot.width || 0,
        height: snapshot.height || 0
      }
    } : {}),
    ...(run.error ? { error: { message: run.error.message, action: run.error.retryable ? '再次生成' : undefined } } : {})
  }
}

export const rebuildPreparedImageGenerationRequest = (
  run: ImageGenerationRun
): ImageGenerationRequest | null => {
  const snapshot = run.requestSnapshot
  const operation = snapshot.operation
  if (
    run.state !== 'queued'
    || !run.nodeId
    || !operation
    || operation.operation !== 'multi-view'
    || !operation.operationGroupId
    || !operation.operationItemId
    || !operation.viewSpec
    || !['generate', 'edit', 'region-edit'].includes(snapshot.mode)
    || !['png', 'jpeg'].includes(snapshot.outputFormat)
  ) return null

  const regions: ImageGenerationRegion[] = []
  snapshot.regions.forEach(region => {
    if (
      region.type === 'point'
      && typeof region.referenceId === 'string'
      && typeof region.x === 'number'
      && typeof region.y === 'number'
    ) {
      regions.push({ type: 'point', referenceId: region.referenceId, x: region.x, y: region.y })
      return
    }
    if (
      region.type === 'bbox'
      && typeof region.referenceId === 'string'
      && typeof region.x1 === 'number'
      && typeof region.y1 === 'number'
      && typeof region.x2 === 'number'
      && typeof region.y2 === 'number'
    ) regions.push({
        type: 'bbox', referenceId: region.referenceId,
        x1: region.x1, y1: region.y1, x2: region.x2, y2: region.y2
      })
  })

  return {
    runId: run.id,
    projectId: run.projectId,
    nodeId: run.nodeId,
    connectionId: run.connectionId,
    modelId: run.modelId,
    mode: snapshot.mode as ImageGenerationRequest['mode'],
    promptDocument: clonePromptDocument(snapshot.promptDocument as PromptDocument),
    inputs: snapshot.inputAssets.map(input => ({ ...input })),
    regions,
    resolution: snapshot.resolution,
    aspectRatio: snapshot.aspectRatio || 'smart',
    ...(snapshot.aspectRatio === 'custom' && snapshot.width && snapshot.height
      ? { width: snapshot.width, height: snapshot.height }
      : {}),
    outputFormat: snapshot.outputFormat as ImageGenerationRequest['outputFormat'],
    watermark: snapshot.watermark,
    promptOptimization: snapshot.promptOptimization,
    operation: cloneOperationSnapshot(operation)
  }
}

export const promptDocumentPlainText = (document: PromptDocument): string => (
  document.segments.map(segment => segment.type === 'text' ? segment.text : `@${segment.label}`).join('')
)

const clonePromptDocument = (document: PromptDocument): PromptDocument => ({
  version: 1,
  segments: document.segments.map(segment => segment.type === 'text'
    ? { type: 'text', text: segment.text }
    : { type: 'reference', referenceId: segment.referenceId, label: segment.label })
})

const appendPromptText = (document: PromptDocument, text: string): PromptDocument => {
  const next = clonePromptDocument(document)
  const last = next.segments[next.segments.length - 1]
  if (last?.type === 'text') {
    last.text = [last.text.trim(), text].filter(Boolean).join('\n')
  } else {
    next.segments.push({ type: 'text', text })
  }
  return next
}

const workflowMode = (workflow: ProjectImageGenerationWorkflow): ImageGenerationRequest['mode'] => (
  workflow === 'smart-edit' ? 'edit' : workflow === 'region-edit' ? 'region-edit' : 'generate'
)

const modeWorkflow = (mode: string, inputCount: number): ProjectImageGenerationWorkflow => {
  if (mode === 'edit') return 'smart-edit'
  if (mode === 'region-edit') return 'region-edit'
  return inputCount > 0 ? 'reference-generate' : 'text-to-image'
}

const cloneOperationSnapshot = (
  operation: ImageOperationRecipeSnapshot
): ImageOperationRecipeSnapshot => ({
  ...operation,
  source: { ...operation.source },
  preservationIntents: [...operation.preservationIntents],
  parameters: Object.fromEntries(Object.entries(operation.parameters).map(([key, value]) => [
    key,
    Array.isArray(value) ? [...value] : value
  ]))
})
