import { validatePublicReferenceCode } from '@/domain/reference-codes/reference-code'
import type { IFreeCanvasNode, IPromptProject } from '@/models/PromptHistory.model'
import type { ContextPackCreateRequest } from '@/storage/storage-service-client'

export interface ContextPackPreviewItem {
  nodeId: string
  code: string
  type: '文字' | '图片'
  title: string
}

export interface ContextPackSelectionPreview {
  items: ContextPackPreviewItem[]
  selectedCount: number
  omittedCount: number
}

export const createContextPackSelectionPreview = (
  nodes: IFreeCanvasNode[],
  selectedNodeIds: string[]
): ContextPackSelectionPreview => {
  const selected = new Set(selectedNodeIds)
  const selectedCount = nodes.filter(node => selected.has(node.id)).length
  const items = nodes.flatMap(node => {
    if (!selected.has(node.id)) return []
    const code = supportedNodeCode(node)
    if (!code) return []
    return [{
      nodeId: node.id,
      code,
      type: node.kind === 'text' ? '文字' as const : '图片' as const,
      title: node.title
    }]
  })
  return { items, selectedCount, omittedCount: selectedCount - items.length }
}

export const buildContextPackCreateRequest = (
  project: IPromptProject,
  preview: ContextPackSelectionPreview
): ContextPackCreateRequest | null => {
  const projectCode = validatePublicReferenceCode(project.referenceCode, 'PRJ')
  if (!projectCode || !Number.isInteger(project.revision) || project.revision < 1 || preview.items.length === 0) {
    return null
  }
  const nodeCodes = preview.items.map(item => item.code)
  return {
    projectCode,
    projectRevision: project.revision,
    nodeCodes,
    placementHint: { mode: 'after-selection', anchorNodeCodes: [...nodeCodes] },
    creator: 'promptcard-ui'
  }
}

export const normalizeContextPackCode = (value: string): string | null => (
  validatePublicReferenceCode(value.trim().toUpperCase(), 'CVC')
)

const supportedNodeCode = (node: IFreeCanvasNode): string | null => {
  if (node.kind === 'text') return validatePublicReferenceCode(node.referenceCode, 'CVT')
  if (node.kind !== 'image') return null
  if (
    node.transient === true
    || node.meta.generationState === 'running'
    || node.meta.generationState === 'failed'
  ) return null
  return validatePublicReferenceCode(node.referenceCode, 'CVM')
}
