import { Bot, Copy, FileImage, Trash2, Wand2 } from 'lucide-react'
import type { IFreeCanvasTextNode } from '@/models/PromptHistory.model'
import type { ContextMenuPosition } from './image-action-ui'
import {
  CanvasContextMenu,
  CanvasContextMenuItem
} from './CanvasContextMenu'
import { CanvasNodeReferenceCodeAction } from './CanvasReferenceCodeAction'

export type TextNodeContextCommand = 'copy' | 'complete' | 'send-to-agent' | 'send-to-image-generation' | 'delete'

interface CanvasTextNodeContextMenuProps {
  position: ContextMenuPosition
  node: IFreeCanvasTextNode
  completeDisabled?: boolean
  imageGenerationDisabled?: boolean
  onExecute: (command: TextNodeContextCommand) => void
  onClose: () => void
}

export const CanvasTextNodeContextMenu = ({
  position,
  node,
  completeDisabled = false,
  imageGenerationDisabled = false,
  onExecute,
  onClose
}: CanvasTextNodeContextMenuProps) => {
  const execute = (command: TextNodeContextCommand) => {
    onExecute(command)
    onClose()
  }

  return (
    <CanvasContextMenu
      position={position}
      ariaLabel="文字节点菜单"
      estimatedHeight={232}
      onClose={onClose}
    >
      <CanvasNodeReferenceCodeAction node={node} />
      <CanvasContextMenuItem
        icon={<Copy className="h-3.5 w-3.5" />}
        label="复制"
        shortcut="Ctrl+C"
        onSelect={() => execute('copy')}
      />
      <CanvasContextMenuItem
        icon={<Wand2 className="h-3.5 w-3.5" />}
        label="补全"
        disabled={completeDisabled}
        title={completeDisabled ? '预览模式下无法使用 Agent 补全' : '补全'}
        onSelect={() => execute('complete')}
      />
      <CanvasContextMenuItem
        icon={<Bot className="h-3.5 w-3.5" />}
        label="发送到 Agent"
        disabled={completeDisabled}
        title={completeDisabled ? '预览模式下无法发送到 Agent' : '作为参考节点发送到 Agent'}
        onSelect={() => execute('send-to-agent')}
      />
      <CanvasContextMenuItem
        icon={<FileImage className="h-3.5 w-3.5" />}
        label="发送到图片生成参考"
        disabled={imageGenerationDisabled}
        title={imageGenerationDisabled ? '当前文字节点不能发送到图片生成' : '作为文字参考发送到图片生成'}
        onSelect={() => execute('send-to-image-generation')}
      />
      <div className="mt-1 border-t border-gray-100 pt-1">
        <CanvasContextMenuItem
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label="删除"
          shortcut="Backspace"
          onSelect={() => execute('delete')}
        />
      </div>
    </CanvasContextMenu>
  )
}
