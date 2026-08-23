import type { IFreeCanvasNode } from '@/models/PromptHistory.model'

const pendingKey = 'referenceCodePending'

export const isCanvasNodeReferencePending = (node: IFreeCanvasNode): boolean => (
  node.meta[pendingKey] === true
)

export const markCanvasNodeReferencePending = <T extends IFreeCanvasNode>(node: T): T => {
  const withoutCode = { ...node }
  delete withoutCode.referenceCode
  return {
    ...withoutCode,
    meta: { ...node.meta, [pendingKey]: true }
  } as unknown as T
}

export const clearCanvasNodeReferencePending = <T extends IFreeCanvasNode>(node: T): T => {
  if (!isCanvasNodeReferencePending(node)) return node
  const meta = { ...node.meta }
  delete meta[pendingKey]
  return { ...node, meta } as T
}
