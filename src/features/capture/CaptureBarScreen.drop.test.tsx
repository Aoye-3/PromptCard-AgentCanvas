import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { CaptureBarScreen } from './CaptureBarScreen'

describe('CaptureBarScreen browser drop', () => {
  it('accepts a browser image drop from anywhere on the capture page', () => {
    const onDropBrowserImage = vi.fn()
    const renderer = create(
      <CaptureBarScreen
        status="closed"
        onOpenToolbar={() => undefined}
        onCloseToolbar={() => undefined}
        onDropBrowserImage={onDropBrowserImage}
      />
    )
    const page = renderer.root.findByProps({ 'data-capture-bar-screen': true })
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: { dropEffect: 'none' }
    }

    act(() => page.props.onDragEnter(event))
    expect(renderer.root.findByProps({ 'data-browser-image-drop-overlay': true })).toBeTruthy()

    act(() => page.props.onDrop(event))
    expect(event.preventDefault).toHaveBeenCalled()
    expect(onDropBrowserImage).toHaveBeenCalledWith(event)
  })
})
