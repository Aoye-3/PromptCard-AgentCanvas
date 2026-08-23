import { validatePublicReferenceCode } from '@/domain/reference-codes/reference-code'
import { isCanvasNodeReferencePending } from '@/domain/reference-codes/canvas-node-reference-lifecycle'
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
  const codeCounts = countSupportedCodes(nodes)
  const selectedCount = nodes.filter(node => selected.has(node.id)).length
  const items = nodes.flatMap(node => {
    if (!selected.has(node.id)) return []
    const code = supportedNodeCode(node, codeCounts)
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

const supportedNodeCode = (node: IFreeCanvasNode, codeCounts: Map<string, number>): string | null => {
  if (isCanvasNodeReferencePending(node)) return null
  if (node.kind === 'text') {
    const code = validatePublicReferenceCode(node.referenceCode, 'CVT')
    return code && codeCounts.get(code) === 1 ? code : null
  }
  if (node.kind !== 'image') return null
  if (
    node.transient === true
    || node.meta.generationState === 'running'
    || node.meta.generationState === 'failed'
  ) return null
  const code = validatePublicReferenceCode(node.referenceCode, 'CVM')
  return code && codeCounts.get(code) === 1 ? code : null
}

const countSupportedCodes = (nodes: IFreeCanvasNode[]): Map<string, number> => {
  const counts = new Map<string, number>()
  nodes.forEach(node => {
    const code = node.kind === 'text'
      ? validatePublicReferenceCode(node.referenceCode, 'CVT')
      : node.kind === 'image'
        ? validatePublicReferenceCode(node.referenceCode, 'CVM')
        : null
    if (code) counts.set(code, (counts.get(code) || 0) + 1)
  })
  return counts
}
