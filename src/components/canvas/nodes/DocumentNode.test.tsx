import { useState } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlanningDocumentV1, planningDocumentEffectiveText } from '@/domain/documents/planning-document'
import type { IFreeCanvasDocumentNode, PlanningDocumentV1 } from '@/models/PromptHistory.model'

vi.mock('@/components/canvas/document/DocumentEditor', () => ({
  DocumentEditor: ({ document, mode, onChange }: {
    document: PlanningDocumentV1
    mode: string
    onChange: (document: PlanningDocumentV1) => void
  }) => (
    <section data-mock-document-editor-shell={mode} onKeyDown={event => event.stopPropagation()}>
      <button
        type="button"
        data-mock-document-editor={mode}
        data-document-digest={document.digest}
        data-on-test-change={onChange}
        onClick={() => onChange(createPlanningDocumentV1([
          { id: 'paragraph-1', type: 'paragraph', content: [{ text: 'Edited canonical draft' }] }
        ], document.revision + 1))}
      >Edit</button>
      <div role="toolbar" data-mock-editor-toolbar={mode} />
      <div role="textbox" contentEditable data-mock-editor-content={mode} />
    </section>
  )
}))

import { DocumentNode } from './DocumentNode'

const node = (): IFreeCanvasDocumentNode => ({
  id: 'document-1',
  kind: 'document',
  title: 'Creative brief',
  position: { x: 20, y: 30 },
  width: 560,
  height: 420,
  document: createPlanningDocumentV1([
    { id: 'paragraph-1', type: 'paragraph', content: [{ text: 'Single canonical draft body' }] }
  ]),
  linkedDocumentResourceIds: [],
  meta: {}
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

describe('DocumentNode', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
  })

  it('switches inline, expanded, and collapsed views without mounting two editors', () => {
    const renderer = create(
      <DocumentNode node={node()} selected onDocumentChange={vi.fn().mockResolvedValue(true)} onDelete={vi.fn()} />
    )

    expect(renderer.root.findAllByProps({ 'data-mock-document-editor': 'inline' })).toHaveLength(1)
    act(() => renderer.root.findByProps({ 'aria-label': '展开编辑器' }).props.onClick())
    expect(renderer.root.findAllByProps({ 'data-mock-document-editor': 'inline' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ 'data-mock-document-editor': 'expanded' })).toHaveLength(1)
    act(() => renderer.root.findByProps({ 'aria-label': '关闭展开编辑器' }).props.onClick())
    expect(renderer.root.findAllByProps({ 'data-mock-document-editor': 'inline' })).toHaveLength(1)
    act(() => renderer.root.findByProps({ 'aria-label': '折叠文档' }).props.onClick())
    expect(renderer.root.findAllByProps({ 'data-mock-document-editor': 'inline' })).toHaveLength(0)
    expect(renderer.root.findByProps({ 'data-document-collapsed-summary': true }).children.join('')).toContain('Single canonical draft body')
  })

  it('moves focus into the aria-modal editor, traps Tab both ways, and returns focus after Escape', () => {
    let activeElement: unknown = null
    const editorElement = { focus: vi.fn(() => { activeElement = editorElement }) }
    const closeElement = { focus: vi.fn(() => { activeElement = closeElement }) }
    const expandElement = { focus: vi.fn(() => { activeElement = expandElement }) }
    const dialogElement = {
      querySelector: vi.fn(() => editorElement),
      querySelectorAll: vi.fn(() => [closeElement, editorElement]),
      contains: vi.fn((candidate: unknown) => candidate === editorElement || candidate === closeElement)
    }
    vi.stubGlobal('document', {
      get activeElement() { return activeElement }
    })
    const renderer = create(
      <DocumentNode node={node()} selected onDocumentChange={vi.fn().mockResolvedValue(true)} onDelete={vi.fn()} />,
      {
        createNodeMock: element => {
          if (element.props.role === 'dialog') return dialogElement
          if (element.props['aria-label'] === '展开编辑器') return expandElement
          return null
        }
      }
    )

    act(() => renderer.root.findByProps({ 'aria-label': '展开编辑器' }).props.onClick())
    const dialog = renderer.root.findByProps({ role: 'dialog' })
    expect(dialog.props['aria-modal']).toBe('true')
    expect(editorElement.focus).toHaveBeenCalled()

    activeElement = editorElement
    const forward = { key: 'Tab', shiftKey: false, currentTarget: dialogElement, nativeEvent: { isComposing: false }, preventDefault: vi.fn() }
    act(() => dialog.props.onKeyDownCapture(forward))
    expect(forward.preventDefault).toHaveBeenCalled()
    expect(closeElement.focus).toHaveBeenCalled()

    activeElement = closeElement
    const backward = { key: 'Tab', shiftKey: true, currentTarget: dialogElement, nativeEvent: { isComposing: false }, preventDefault: vi.fn() }
    act(() => dialog.props.onKeyDownCapture(backward))
    expect(backward.preventDefault).toHaveBeenCalled()
    expect(editorElement.focus).toHaveBeenCalledTimes(2)

    const escape = { key: 'Escape', shiftKey: false, currentTarget: dialogElement, nativeEvent: { isComposing: false }, preventDefault: vi.fn() }
    act(() => dialog.props.onKeyDownCapture(escape))
    expect(escape.preventDefault).toHaveBeenCalled()
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    expect(expandElement.focus).toHaveBeenCalled()
  })

  it('handles trapped Tab and Escape from editor descendants before their bubble guard stops Canvas shortcuts', () => {
    let activeElement: unknown = null
    const closeElement = { focus: vi.fn(() => { activeElement = closeElement }) }
    const toolbarElement = { focus: vi.fn(() => { activeElement = toolbarElement }) }
    const editorElement = { focus: vi.fn(() => { activeElement = editorElement }) }
    const expandElement = { focus: vi.fn(() => { activeElement = expandElement }) }
    const dialogElement = {
      querySelector: vi.fn(() => editorElement),
      querySelectorAll: vi.fn(() => [closeElement, toolbarElement, editorElement]),
      contains: vi.fn((candidate: unknown) => (
        candidate === closeElement || candidate === toolbarElement || candidate === editorElement
      ))
    }
    vi.stubGlobal('document', {
      get activeElement() { return activeElement }
    })
    const renderer = create(
      <DocumentNode node={node()} selected onDocumentChange={vi.fn().mockResolvedValue(true)} onDelete={vi.fn()} />,
      {
        createNodeMock: element => {
          if (element.props.role === 'dialog') return dialogElement
          if (element.props['aria-label'] === '展开编辑器') return expandElement
          return null
        }
      }
    )
    act(() => renderer.root.findByProps({ 'aria-label': '展开编辑器' }).props.onClick())
    const dialog = renderer.root.findByProps({ role: 'dialog' })
    const editorShell = renderer.root.findByProps({ 'data-mock-document-editor-shell': 'expanded' })

    const dispatchFromEditor = (key: string, shiftKey = false) => {
      let stopped = false
      const event = {
        key,
        shiftKey,
        currentTarget: dialogElement,
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(() => { stopped = true })
      }
      act(() => {
        dialog.props.onKeyDownCapture?.(event)
        editorShell.props.onKeyDown(event)
        if (!stopped) dialog.props.onKeyDown?.(event)
      })
      return event
    }

    activeElement = editorElement
    const forward = dispatchFromEditor('Tab')
    expect(forward.preventDefault).toHaveBeenCalled()
    expect(closeElement.focus).toHaveBeenCalled()

    activeElement = closeElement
    let stopped = false
    const backward = {
      key: 'Tab',
      shiftKey: true,
      currentTarget: dialogElement,
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(() => { stopped = true })
    }
    act(() => {
      dialog.props.onKeyDownCapture?.(backward)
      if (!stopped) dialog.props.onKeyDown?.(backward)
    })
    expect(backward.preventDefault).toHaveBeenCalled()
    expect(editorElement.focus).toHaveBeenCalledTimes(2)

    activeElement = toolbarElement
    const escape = dispatchFromEditor('Escape')
    expect(escape.preventDefault).toHaveBeenCalled()
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    expect(expandElement.focus).toHaveBeenCalled()
  })

  it('keeps one canonical state across inline and expanded editors', async () => {
    const Wrapper = () => {
      const [current, setCurrent] = useState(node())
      return (
        <DocumentNode
          node={current}
          selected
          onDocumentChange={async document => {
            setCurrent(value => ({ ...value, document }))
            return true
          }}
          onDelete={vi.fn()}
        />
      )
    }
    const renderer = create(<Wrapper />)

    await act(async () => renderer.root.findByProps({ 'data-mock-document-editor': 'inline' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '展开编辑器' }).props.onClick())

    const expanded = renderer.root.findByProps({ 'data-mock-document-editor': 'expanded' })
    expect(expanded.props['data-document-digest']).not.toBe(node().document.digest)
  })

  it('shows Retry after persistence failure and retries the same canonical document', async () => {
    const onDocumentChange = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const renderer = create(
      <DocumentNode node={node()} selected onDocumentChange={onDocumentChange} onDelete={vi.fn()} />
    )

    await act(async () => renderer.root.findByProps({ 'data-mock-document-editor': 'inline' }).props.onClick())
    expect(renderer.root.findByProps({ role: 'alert' }).findByType('span').children.join('')).toContain('保存失败')
    await act(async () => renderer.root.findByProps({ 'aria-label': '重试保存文档' }).props.onClick())

    expect(onDocumentChange).toHaveBeenCalledTimes(2)
    expect(onDocumentChange.mock.calls[1][0]).toEqual(onDocumentChange.mock.calls[0][0])
  })

  it('keeps the failure and exact-snapshot Retry reachable inside the expanded dialog', async () => {
    const onDocumentChange = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const renderer = create(
      <DocumentNode node={node()} selected onDocumentChange={onDocumentChange} onDelete={vi.fn()} />
    )

    act(() => renderer.root.findByProps({ 'aria-label': '展开编辑器' }).props.onClick())
    await act(async () => renderer.root.findByProps({ 'data-mock-document-editor': 'expanded' }).props.onClick())

    const dialog = renderer.root.findByProps({ role: 'dialog' })
    expect(dialog.findByProps({ role: 'alert' }).findByType('span').children.join('')).toContain('保存失败')
    await act(async () => dialog.findByProps({ 'aria-label': '重试保存文档' }).props.onClick())

    expect(onDocumentChange).toHaveBeenCalledTimes(2)
    expect(onDocumentChange.mock.calls[1][0]).toEqual(onDocumentChange.mock.calls[0][0])
  })

  it('keeps rapid A/B failures pinned to B so the retry cannot be overwritten by stale A', async () => {
    let resolveA!: (saved: boolean) => void
    let resolveB!: (saved: boolean) => void
    const pendingA = new Promise<boolean>(resolve => { resolveA = resolve })
    const pendingB = new Promise<boolean>(resolve => { resolveB = resolve })
    const onDocumentChange = vi.fn()
      .mockReturnValueOnce(pendingA)
      .mockReturnValueOnce(pendingB)
      .mockResolvedValueOnce(true)
    const renderer = create(
      <DocumentNode node={node()} selected onDocumentChange={onDocumentChange} onDelete={vi.fn()} />
    )
    const editor = renderer.root.findByProps({ 'data-mock-document-editor': 'inline' })
    const documentA = createPlanningDocumentV1([{ id: 'paragraph-1', type: 'paragraph', content: [{ text: 'A' }] }], 2)
    const documentB = createPlanningDocumentV1([{ id: 'paragraph-1', type: 'paragraph', content: [{ text: 'B' }] }], 3)

    act(() => {
      editor.props['data-on-test-change'](documentA)
      editor.props['data-on-test-change'](documentB)
    })
    await act(async () => { resolveA(false); await pendingA })
    expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
    await act(async () => { resolveB(false); await pendingB })
    await act(async () => renderer.root.findByProps({ 'aria-label': '重试保存文档' }).props.onClick())

    expect(onDocumentChange).toHaveBeenCalledTimes(3)
    expect(onDocumentChange.mock.calls[2][0]).toEqual(documentB)
  })

  it('makes a captured failed-A Retry a no-op as soon as a newer B commit starts', async () => {
    const pendingB = deferred<boolean>()
    const received: string[] = []
    const persisted: string[] = []
    const documentA = createPlanningDocumentV1([
      { id: 'paragraph-1', type: 'paragraph', content: [{ text: 'A' }] }
    ], 1)
    const documentB = createPlanningDocumentV1([
      { id: 'paragraph-1', type: 'paragraph', content: [{ text: 'B' }] }
    ], 2)
    const Wrapper = () => {
      const [current, setCurrent] = useState(node())
      return (
        <DocumentNode
          node={current}
          selected
          onDocumentChange={async document => {
            const text = planningDocumentEffectiveText(document)
            received.push(text)
            if (text === 'A') return false
            if (text === 'B') {
              setCurrent(value => ({ ...value, document }))
              const saved = await pendingB.promise
              if (saved) persisted.push(text)
              return saved
            }
            return false
          }}
          onDelete={vi.fn()}
        />
      )
    }
    const renderer = create(<Wrapper />)
    const editor = renderer.root.findByProps({ 'data-mock-document-editor': 'inline' })

    await act(async () => editor.props['data-on-test-change'](documentA))
    const capturedStaleRetry = renderer.root.findByProps({ 'aria-label': '重试保存文档' }).props.onClick
    act(() => editor.props['data-on-test-change'](documentB))
    expect(renderer.root.findAllByProps({ 'aria-label': '重试保存文档' })).toHaveLength(0)

    act(() => capturedStaleRetry())
    expect(received).toEqual(['A', 'B'])

    await act(async () => {
      pendingB.resolve(true)
      await pendingB.promise
      await Promise.resolve()
    })

    expect(received).toEqual(['A', 'B'])
    expect(persisted).toEqual(['B'])
    expect(renderer.root.findByProps({ 'data-mock-document-editor': 'inline' }).props['data-document-digest'])
      .toBe(documentB.digest)
  })

  it.each([
    { label: 'prior-history undo', text: 'Prior history', revision: 1 },
    { label: 'external authoritative reload', text: 'External reload', revision: 9 }
  ])('invalidates visible and captured failed-A Retry after a $label prop change', async ({ text, revision }) => {
    const onDocumentChange = vi.fn().mockResolvedValue(false)
    const currentNode: IFreeCanvasDocumentNode = {
      ...node(),
      document: createPlanningDocumentV1([
        { id: 'paragraph-1', type: 'paragraph', content: [{ text: 'Current history' }] }
      ], 4)
    }
    const renderer = create(
      <DocumentNode node={currentNode} selected onDocumentChange={onDocumentChange} onDelete={vi.fn()} />
    )
    const failedA = createPlanningDocumentV1([
      { id: 'paragraph-1', type: 'paragraph', content: [{ text: 'Failed A' }] }
    ], 5)

    await act(async () => {
      renderer.root.findByProps({ 'data-mock-document-editor': 'inline' }).props['data-on-test-change'](failedA)
      await Promise.resolve()
    })
    const capturedRetry = renderer.root.findByProps({ 'aria-label': '重试保存文档' }).props.onClick
    const authoritative = createPlanningDocumentV1([
      { id: 'paragraph-1', type: 'paragraph', content: [{ text }] }
    ], revision)

    act(() => renderer.update(
      <DocumentNode
        node={{ ...currentNode, document: authoritative }}
        selected
        onDocumentChange={onDocumentChange}
        onDelete={vi.fn()}
      />
    ))

    expect(renderer.root.findAllByProps({ 'aria-label': '重试保存文档' })).toHaveLength(0)
    act(() => capturedRetry())
    expect(onDocumentChange).toHaveBeenCalledTimes(1)
    expect(renderer.root.findByProps({ 'data-mock-document-editor': 'inline' }).props['data-document-digest'])
      .toBe(authoritative.digest)
  })

  it('persists collapsed state through node metadata and restores it on reload', async () => {
    const onCollapsedChange = vi.fn().mockResolvedValue(true)
    const Wrapper = () => {
      const [current, setCurrent] = useState(node())
      return (
        <DocumentNode
          node={current}
          selected
          onDocumentChange={vi.fn().mockResolvedValue(true)}
          onCollapsedChange={async collapsed => {
            const saved = await onCollapsedChange(collapsed)
            if (saved) setCurrent(value => ({ ...value, meta: { ...value.meta, collapsed } }))
            return saved
          }}
          onDelete={vi.fn()}
        />
      )
    }
    const renderer = create(<Wrapper />)

    await act(async () => renderer.root.findByProps({ 'aria-label': '折叠文档' }).props.onClick())

    expect(onCollapsedChange).toHaveBeenCalledWith(true)
    expect(renderer.root.findAllByProps({ 'data-mock-document-editor': 'inline' })).toHaveLength(0)
    expect(renderer.root.findByProps({ 'data-document-collapsed-summary': true })).toBeDefined()
  })
})
