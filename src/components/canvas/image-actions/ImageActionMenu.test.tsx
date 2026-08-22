import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedImageNodeCommand } from '@/domain/image-actions/image-node-commands'
import { CanvasNodeContextMenu } from './CanvasNodeContextMenu'
import { CanvasTextNodeContextMenu } from './CanvasTextNodeContextMenu'
import { ImageNodeActionBar } from './ImageNodeActionBar'
import { clampContextMenuPosition } from './image-action-ui'

const command = (
  overrides: Partial<ResolvedImageNodeCommand> & Pick<ResolvedImageNodeCommand, 'id' | 'label'>
): ResolvedImageNodeCommand => ({
  surfaces: ['toolbar', 'more', 'context'],
  enabled: true,
  disabledReason: null,
  qualityStatus: null,
  ...overrides
})

describe('image action menu surfaces', () => {
  it('clamps context menus inside all viewport edges', () => {
    expect(clampContextMenuPosition({ x: -20, y: -40 }, { width: 1000, height: 800 }, { width: 280, height: 500 }))
      .toEqual({ x: 12, y: 12 })
    expect(clampContextMenuPosition({ x: 980, y: 790 }, { width: 1000, height: 800 }, { width: 280, height: 500 }))
      .toEqual({ x: 708, y: 288 })
  })

  it('renders one named toolbar and truthful disabled reason', () => {
    const html = renderToStaticMarkup(
      <ImageNodeActionBar
        commands={[
          command({ id: 'effect-render', label: '效果图', enabled: false, disabledReason: 'not_evaluated', qualityStatus: 'untested' }),
          command({ id: 'export-visible', label: '下载所见图片', surfaces: ['toolbar', 'context'] })
        ]}
        onExecute={vi.fn()}
      />
    )

    expect(html).toContain('role="toolbar"')
    expect(html).toContain('aria-label="图片编辑操作"')
    expect(html).toContain('此操作尚未完成质量评估')
    expect(html).toContain('下载所见图片')
  })

  it('renders context commands from the shared definitions with shortcuts', () => {
    const html = renderToStaticMarkup(
      <CanvasNodeContextMenu
        position={{ x: 12, y: 12 }}
        node={{
          id: 'image-1', kind: 'image', title: 'Image', position: { x: 0, y: 0 }, width: 640, height: 480,
          assetId: 'asset-1', annotations: [], referenceCode: 'CVM-01M0N7FTG1PKB2AV2P8S62N6H8', meta: {}
        }}
        commands={[
          command({ id: 'copy', label: '复制', surfaces: ['context', 'shortcut'], shortcut: 'Ctrl+C' }),
          command({ id: 'delete', label: '删除', surfaces: ['context', 'shortcut'], shortcut: 'Backspace' })
        ]}
        onExecute={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('role="menu"')
    expect(html).toContain('Ctrl+C')
    expect(html).toContain('Backspace')
    expect(html).toContain('复制节点代码')
    expect(html).toContain('w-56')
    expect(html).toContain('text-[13px]')
    expect(html).toContain('py-1.5')
    expect(html).not.toContain('w-72')
    expect(html).not.toContain('py-2.5')
  })

  it('uses the same compact context menu for text-node actions', () => {
    const html = renderToStaticMarkup(
      <CanvasTextNodeContextMenu
        position={{ x: 12, y: 12 }}
        node={{
          id: 'text-1', kind: 'text', title: 'Text', position: { x: 0, y: 0 }, width: 420, height: 180,
          fontSize: 'large', segments: [], referenceCode: 'CVT-01M0N7FTG1PKB2AV2P8S62N6H8', meta: {}
        }}
        onExecute={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('role="menu"')
    expect(html).toContain('aria-label="文字节点菜单"')
    expect(html).toContain('复制')
    expect(html).toContain('补全')
    expect(html).toContain('发送到 Agent')
    expect(html).toContain('删除')
    expect(html).toContain('Ctrl+C')
    expect(html).toContain('Backspace')
    expect(html).toContain('复制节点代码')
    expect(html).toContain('w-56')
    expect(html).toContain('text-[13px]')
    expect(html).toContain('py-1.5')
  })
})
