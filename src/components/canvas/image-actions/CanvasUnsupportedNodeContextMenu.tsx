import type { IFreeCanvasNode } from '@/models/PromptHistory.model'
import { CanvasContextMenu } from './CanvasContextMenu'
import { CanvasNodeReferenceCodeAction } from './CanvasReferenceCodeAction'
import type { ContextMenuPosition } from './image-action-ui'

export const CanvasUnsupportedNodeContextMenu = ({
  position,
  node,
  onClose
}: {
  position: ContextMenuPosition
  node: IFreeCanvasNode
  onClose: () => void
}) => (
  <CanvasContextMenu
    position={position}
    ariaLabel={`${node.kind === 'arrow' ? '箭头' : '图片生成器'}节点菜单`}
    estimatedHeight={96}
    onClose={onClose}
  >
    <CanvasNodeReferenceCodeAction node={node} />
  </CanvasContextMenu>
)
