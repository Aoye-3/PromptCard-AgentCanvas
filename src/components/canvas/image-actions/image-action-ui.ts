import type { ResolvedImageNodeCommand } from '@/domain/image-actions/image-node-commands'

export interface ContextMenuPosition {
  x: number
  y: number
}

const edgePadding = 12
const appHeaderHeight = 56

export const clampContextMenuPosition = (
  position: ContextMenuPosition,
  viewport: { width: number; height: number },
  size: { width: number; height: number }
): ContextMenuPosition => ({
  x: Math.max(edgePadding, Math.min(position.x, viewport.width - size.width - edgePadding)),
  y: Math.max(edgePadding, Math.min(position.y, viewport.height - size.height - edgePadding))
})

export const getCanvasContextMenuLayout = (
  position: ContextMenuPosition,
  viewport: { width: number; height: number },
  size: { width: number; height: number }
): ContextMenuPosition & { maxHeight: number } => {
  const safeTop = Math.min(appHeaderHeight + edgePadding, Math.max(edgePadding, viewport.height - edgePadding))
  const maxHeight = Math.max(0, viewport.height - safeTop - edgePadding)
  const visibleHeight = Math.min(size.height, maxHeight)
  return {
    x: Math.max(edgePadding, Math.min(position.x, viewport.width - size.width - edgePadding)),
    y: Math.max(safeTop, Math.min(position.y, viewport.height - visibleHeight - edgePadding)),
    maxHeight
  }
}

export const imageCommandDisabledReasonLabel = (
  reason: ResolvedImageNodeCommand['disabledReason']
): string => {
  if (reason === 'model_unavailable') return '请先配置可用的图片模型'
  if (reason === 'runtime_unavailable') return '图片生成 Runtime 尚未就绪'
  if (reason === 'missing_model_capability') return '当前模型不支持此操作所需能力'
  if (reason === 'adapter_not_implemented') return '当前模型适配器尚未实现此操作'
  if (reason === 'not_evaluated') return '此操作尚未完成质量评估'
  if (reason === 'policy_disabled') return '此操作尚未在当前版本开放'
  if (reason === 'select_one_ready_image') return '请选择一个可用图片'
  if (reason === 'unsupported') return '当前模型不支持此操作'
  return '此操作尚未实现'
}
