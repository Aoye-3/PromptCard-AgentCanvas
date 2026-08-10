import { renderToStaticMarkup } from 'react-dom/server'
import { create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { CaptureBarScreen } from './CaptureBarScreen'

describe('CaptureBarScreen', () => {
  it('renders the toolbar preview, controls, settings, and planned modules', () => {
    const markup = renderToStaticMarkup(
      <CaptureBarScreen
        status="closed"
        onOpenToolbar={() => undefined}
        onCloseToolbar={() => undefined}
      />
    )

    expect(markup).toContain('data-capture-bar-screen')
    expect(markup).toContain('启动捕获栏')
    expect(markup).toContain('关闭捕获栏')
    expect(markup).toContain('启动时自动开启：关闭')
    expect(markup).toContain('截图捕获')
    expect(markup).toContain('视觉 Agent 分析')
    expect(markup).toContain('计划中')
  })

  it('wires primary open and close controls to handlers', () => {
    const onOpenToolbar = vi.fn()
    const onCloseToolbar = vi.fn()
    const renderer = create(
      <CaptureBarScreen
        status="running"
        onOpenToolbar={onOpenToolbar}
        onCloseToolbar={onCloseToolbar}
      />
    )
    const [openButton, closeButton] = renderer.root.findAllByType('button')

    openButton.props.onClick()
    closeButton.props.onClick()

    expect(onOpenToolbar).toHaveBeenCalledTimes(1)
    expect(onCloseToolbar).toHaveBeenCalledTimes(1)
  })

  it('renders a visible clipboard paste area and recent captures shortcut', () => {
    const markup = renderToStaticMarkup(
      <CaptureBarScreen
        status="closed"
        clipboardStatus="idle"
        onOpenToolbar={() => undefined}
        onCloseToolbar={() => undefined}
        onReadClipboard={() => undefined}
        onPasteClipboard={() => undefined}
        onOpenRecentCaptures={() => undefined}
      />
    )

    expect(markup).toContain('data-clipboard-capture')
    expect(markup).toContain('粘贴剪贴板截图')
    expect(markup).toContain('从浏览器拖入')
    expect(markup).toContain('Ctrl+V')
    expect(markup).toContain('查看近期捕获')
  })
})
