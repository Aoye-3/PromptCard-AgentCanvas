import {
  ArrowDownToLine,
  ArrowUpToLine,
  BringToFront,
  Copy,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  Layers2,
  Scissors,
  SendToBack,
  Trash2,
  ZoomIn
} from 'lucide-react'
import type { IFreeCanvasImageNode } from '@/models/PromptHistory.model'
import type {
  ImageNodeCommandId,
  ResolvedImageNodeCommand
} from '@/domain/image-actions/image-node-commands'
import {
  imageCommandDisabledReasonLabel,
  type ContextMenuPosition
} from './image-action-ui'
import {
  CanvasContextMenu,
  CanvasContextMenuItem
} from './CanvasContextMenu'
import { CanvasNodeReferenceCodeAction } from './CanvasReferenceCodeAction'

export interface CanvasNodeContextMenuProps {
  position: ContextMenuPosition
  node: IFreeCanvasImageNode
  commands: readonly ResolvedImageNodeCommand[]
  onExecute: (commandId: ImageNodeCommandId) => void
  onClose: () => void
}

export const CanvasNodeContextMenu = ({
  position,
  node,
  commands,
  onExecute,
  onClose
}: CanvasNodeContextMenuProps) => {
  const contextCommands = commands.filter(command => command.surfaces.includes('context'))
  const sections = commandSections(contextCommands)

  return (
    <CanvasContextMenu
      position={position}
      ariaLabel="图片节点菜单"
      estimatedHeight={872}
      onClose={onClose}
    >
      <CanvasNodeReferenceCodeAction node={node} />
      {sections.map((section, sectionIndex) => (
        <div key={section[0]?.id || sectionIndex} className={sectionIndex > 0 ? 'mt-1 border-t border-gray-100 pt-1' : ''}>
          {section.map(command => (
            <CanvasContextMenuItem
              key={command.id}
              icon={contextIcon(command.id)}
              label={command.label}
              shortcut={command.shortcut}
              disabled={!command.enabled}
              title={command.enabled ? command.label : imageCommandDisabledReasonLabel(command.disabledReason)}
              onSelect={() => {
                onExecute(command.id)
                onClose()
              }}
            />
          ))}
        </div>
      ))}
    </CanvasContextMenu>
  )
}

const commandSections = (
  commands: readonly ResolvedImageNodeCommand[]
): ResolvedImageNodeCommand[][] => {
  const groups: readonly ImageNodeCommandId[][] = [
    ['copy', 'duplicate', 'copy-visible', 'export-visible', 'download-original', 'delete'],
    ['as-reference', 'effect-render', 'region-redraw', 'outpaint', 'multi-view', 'erase', 'subject-extract', 'text-edit', 'enhance'],
    ['crop', 'annotate'],
    ['zoom-selection'],
    ['layer-up', 'bring-front', 'layer-down', 'send-back'],
    ['flip-horizontal', 'flip-vertical']
  ]
  return groups
    .map(ids => ids.flatMap(id => {
      const command = commands.find(candidate => candidate.id === id)
      return command ? [command] : []
    }))
    .filter(section => section.length > 0)
}

const contextIcon = (id: ImageNodeCommandId) => {
  if (id === 'copy' || id === 'duplicate' || id === 'copy-visible') return <Copy className="h-4 w-4" />
  if (id === 'download-original' || id === 'export-visible') return <Download className="h-4 w-4" />
  if (id === 'delete') return <Trash2 className="h-4 w-4" />
  if (id === 'crop') return <Scissors className="h-4 w-4" />
  if (id === 'zoom-selection') return <ZoomIn className="h-4 w-4" />
  if (id === 'layer-up') return <Layers2 className="h-4 w-4" />
  if (id === 'bring-front') return <BringToFront className="h-4 w-4" />
  if (id === 'layer-down') return <ArrowDownToLine className="h-4 w-4" />
  if (id === 'send-back') return <SendToBack className="h-4 w-4" />
  if (id === 'flip-horizontal') return <FlipHorizontal2 className="h-4 w-4" />
  if (id === 'flip-vertical') return <FlipVertical2 className="h-4 w-4" />
  return <ArrowUpToLine className="h-4 w-4" />
}
