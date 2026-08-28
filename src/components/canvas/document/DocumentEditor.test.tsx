import { Suspense, startTransition, useState } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPlanningDocumentV1,
  planningDocumentEffectiveText,
  sha256Utf8
} from '@/domain/documents/planning-document'
import { applyDocumentChangeOperations } from '@/domain/documents/document-suggestions'
import type { PlanningDocumentV1 } from '@/models/PromptHistory.model'

const mocks = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  run: vi.fn(),
  setContent: vi.fn(),
  setLink: vi.fn(),
  unsetLink: vi.fn(),
  setEditable: vi.fn(),
  currentJson: null as unknown
}))

vi.mock('@tiptap/react', () => {
  const chain = {
    focus: vi.fn(),
    toggleBold: vi.fn(),
    toggleItalic: vi.fn(),
    toggleHeading: vi.fn(),
    setParagraph: vi.fn(),
    toggleBlockquote: vi.fn(),
    toggleBulletList: vi.fn(),
    toggleOrderedList: vi.fn(),
    toggleTaskList: vi.fn(),
    insertTable: vi.fn(),
    extendMarkRange: vi.fn(),
    setLink: mocks.setLink,
    unsetLink: mocks.unsetLink,
    run: mocks.run
  }
  Object.keys(chain).forEach(key => {
    if (key !== 'run') (chain as Record<string, ReturnType<typeof vi.fn>>)[key].mockReturnValue(chain)
  })
  const editor = {
    chain: () => chain,
    commands: {
      setContent: (content: unknown, options: unknown) => {
        mocks.currentJson = content
        mocks.setContent(content, options)
      }
    },
    getJSON: vi.fn(() => mocks.currentJson),
    getAttributes: vi.fn(() => ({ href: 'https://example.test/original' })),
    isActive: vi.fn(() => false),
    isEditable: true,
    setEditable: mocks.setEditable
  }
  return {
    useEditor: (options: Record<string, unknown>) => {
      mocks.options = options
      if (mocks.currentJson === null) mocks.currentJson = options.content
      return editor
    },
    EditorContent: ({ className, ...props }: {
      className?: string
      'aria-readonly'?: boolean
      'data-document-editor-readonly'?: boolean
    }) => (
      <div
        role="textbox"
        aria-label="规划文档正文"
        className={className}
        contentEditable={props['data-document-editor-readonly'] !== true}
        aria-readonly={props['aria-readonly']}
        data-document-editor-readonly={props['data-document-editor-readonly']}
      />
    )
  }
})

import { DocumentEditor } from './DocumentEditor'

const blankDocument = () => createPlanningDocumentV1([
  { id: 'paragraph-empty', type: 'paragraph', content: [] }
])

const proposedDocument = () => {
  const source = createPlanningDocumentV1([
    { id: 'p1', type: 'paragraph', content: [{ text: 'Old draft' }] }
  ], 4)
  return applyDocumentChangeOperations(source, 'edit-replace', [{
    kind: 'replace', blockId: 'p1', utf8Start: 0, utf8End: 3, text: 'New',
    expectedTextDigest: `sha256:${sha256Utf8('Old draft')}`
  }])
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

const editorJson = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text }] }]
})

const editorText = (): string => {
  const json = mocks.currentJson as { content?: Array<{ content?: Array<{ text?: string }> }> }
  return json.content?.[0]?.content?.[0]?.text || ''
}

describe('DocumentEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    mocks.options = null
    mocks.currentJson = null
  })

  it('renders a nodrag/nowheel accessible editor with the complete restricted toolbar', () => {
    const renderer = create(
      <DocumentEditor
        document={createPlanningDocumentV1([{ id: 'p1', type: 'paragraph', content: [{ text: 'Draft' }] }])}
        mode="inline"
        onChange={vi.fn()}
      />
    )

    const root = renderer.root.findByProps({ 'data-document-editor-mode': 'inline' })
    expect(root.props.className).toContain('nodrag')
    expect(root.props.className).toContain('nowheel')
    expect(renderer.root.findByProps({ role: 'textbox' }).props['aria-label']).toBe('规划文档正文')
    const labels = renderer.root.findAllByType('button').map(button => button.props['aria-label'])
    expect(labels).toEqual(expect.arrayContaining([
      '正文', '一级标题', '二级标题', '三级标题', '粗体', '斜体', '引用',
      '无序列表', '有序列表', '任务列表', '插入链接', '插入表格'
    ]))
  })

  it('keeps lists and links visibly semantic under Tailwind preflight', () => {
    const renderer = create(
      <DocumentEditor document={blankDocument()} mode="expanded" onChange={vi.fn()} />
    )
    const editorContent = renderer.root.findByProps({ role: 'textbox' })

    expect(editorContent.props.className).toContain('[&_ul]:list-disc')
    expect(editorContent.props.className).toContain('[&_ol]:list-decimal')
    expect(editorContent.props.className).toContain('[&_ul[data-type=taskList]]:list-none')
    expect(editorContent.props.className).toContain('[&_a]:underline')
  })

  it('renders tracked revisions read-only with green inserts and red struck deletions', () => {
    const onChange = vi.fn()
    create(
      <DocumentEditor
        document={proposedDocument()}
        mode="expanded"
        view="revision"
        onChange={onChange}
      />
    )
    const editorContent = JSON.stringify(mocks.currentJson)
    const textbox = create(
      <DocumentEditor
        document={proposedDocument()}
        mode="inline"
        view="revision"
        onChange={onChange}
      />
    ).root.findByProps({ role: 'textbox' })

    expect(editorContent).toContain('documentSuggestionInsert')
    expect(editorContent).toContain('documentSuggestionDelete')
    expect(textbox.props['aria-readonly']).toBe(true)
    expect(textbox.props['data-document-editor-readonly']).toBe(true)
    expect(mocks.setEditable).toHaveBeenLastCalledWith(false)
    expect(textbox.props.className).toContain('[&_[data-document-suggestion-kind=insert]]:text-emerald-700')
    expect(textbox.props.className).toContain('[&_[data-document-suggestion-kind=delete]]:line-through')
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each(['source', 'effective', 'revision'] as const)('locks local editing in %s view while suggestions are unresolved', view => {
    const onChange = vi.fn()
    create(<DocumentEditor document={proposedDocument()} mode="inline" view={view} onChange={onChange} />)
    const onUpdate = mocks.options?.onUpdate as ((input: { editor: { getJSON: () => unknown } }) => void) | undefined
    if (!onUpdate) throw new Error('Expected Tiptap update callback')

    act(() => onUpdate({ editor: { getJSON: () => editorJson('Conflicting local edit') } }))

    expect(onChange).not.toHaveBeenCalled()
    expect(mocks.setEditable).toHaveBeenLastCalledWith(false)
  })

  it('routes toolbar actions through the restricted Tiptap command chain', () => {
    const renderer = create(
      <DocumentEditor document={blankDocument()} mode="expanded" onChange={vi.fn()} />
    )

    act(() => renderer.root.findByProps({ 'aria-label': '粗体' }).props.onClick())

    expect(mocks.run).toHaveBeenCalledTimes(1)
  })

  it('removes the active link when the link prompt is submitted empty', () => {
    vi.stubGlobal('window', { prompt: vi.fn(() => '   ') })
    const renderer = create(
      <DocumentEditor document={blankDocument()} mode="expanded" onChange={vi.fn()} />
    )

    act(() => renderer.root.findByProps({ 'aria-label': '插入链接' }).props.onClick())

    expect(mocks.unsetLink).toHaveBeenCalledTimes(1)
    expect(mocks.setLink).not.toHaveBeenCalled()
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })

  it('converts editor updates back to the neutral AST with one revision increment', () => {
    const onChange = vi.fn()
    const source = createPlanningDocumentV1([{ id: 'p1', type: 'paragraph', content: [{ text: 'Before' }] }], 4)
    create(<DocumentEditor document={source} mode="inline" onChange={onChange} />)
    const onUpdate = mocks.options?.onUpdate as ((input: { editor: { getJSON: () => unknown } }) => void) | undefined
    if (!onUpdate) throw new Error('Expected Tiptap update callback')

    act(() => onUpdate({
      editor: {
        getJSON: () => ({
          type: 'doc',
          content: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text: 'After' }] }]
        })
      }
    }))

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ revision: 5 }))
    expect(onChange.mock.calls[0][0].blocks[0]).toMatchObject({ id: 'p1', content: [{ text: 'After' }] })
  })

  it('does not publish document, callback, or revision refs from a suspended render that never commits', async () => {
    const committedDocument = createPlanningDocumentV1([
      { id: 'p1', type: 'paragraph', content: [{ text: 'A' }] }
    ], 4)
    const suspendedDocument = createPlanningDocumentV1([
      { id: 'p1', type: 'paragraph', content: [{ text: 'Z' }] }
    ], 9)
    const committedChange = vi.fn()
    const suspendedChange = vi.fn()
    const never = new Promise<void>(() => undefined)
    let suspend = false
    const Suspender = () => {
      if (suspend) throw never
      return null
    }
    const view = (document: PlanningDocumentV1, onChange: (next: PlanningDocumentV1) => void) => (
      <Suspense fallback={<span data-suspended-document-editor />}>
        <DocumentEditor document={document} mode="inline" onChange={onChange} />
        <Suspender />
      </Suspense>
    )
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(view(committedDocument, committedChange), {
        unstable_isConcurrent: true
      } as unknown as Parameters<typeof create>[1])
      await Promise.resolve()
    })
    const committedOnUpdate = mocks.options?.onUpdate as ((input: {
      editor: { getJSON: () => unknown }
    }) => void) | undefined
    if (!committedOnUpdate) throw new Error('Expected committed Tiptap update callback')

    act(() => {
      suspend = true
      startTransition(() => renderer.update(view(suspendedDocument, suspendedChange)))
    })
    const committedEdit = editorJson('Committed edit')
    act(() => committedOnUpdate({ editor: { getJSON: () => committedEdit } }))

    expect(committedChange).toHaveBeenCalledTimes(1)
    expect(committedChange).toHaveBeenCalledWith(expect.objectContaining({ revision: 5 }))
    expect(planningDocumentEffectiveText(committedChange.mock.calls[0][0])).toBe('Committed edit')
    expect(suspendedChange).not.toHaveBeenCalled()
  })

  it('preserves B/C/D typed while queued parent acknowledgements advance from authoritative A', async () => {
    const parentA = createPlanningDocumentV1([
      { id: 'p1', type: 'paragraph', content: [{ text: 'A' }] }
    ], 0)
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
    const emitted: PlanningDocumentV1[] = []
    const persisted: PlanningDocumentV1[] = []
    let persistenceTail = Promise.resolve()
    let setAuthoritative!: (document: PlanningDocumentV1) => void
    const queuePersistence = (document: PlanningDocumentV1) => {
      const gate = gates[emitted.length]
      emitted.push(document)
      persistenceTail = persistenceTail
        .then(() => gate.promise)
        .then(() => {
          persisted.push(document)
          setAuthoritative(document)
        })
    }
    const Harness = () => {
      const [authoritative, setDocument] = useState(parentA)
      setAuthoritative = setDocument
      return <DocumentEditor document={authoritative} mode="inline" onChange={queuePersistence} />
    }
    create(<Harness />)
    const type = (suffix: string) => {
      mocks.currentJson = editorJson(`${editorText()}${suffix}`)
      const onUpdate = mocks.options?.onUpdate as ((input: { editor: { getJSON: () => unknown } }) => void) | undefined
      if (!onUpdate) throw new Error('Expected Tiptap update callback')
      act(() => onUpdate({ editor: { getJSON: () => mocks.currentJson } }))
    }

    type('B')
    type('C')
    expect(emitted.map(document => document.revision)).toEqual([1, 2])

    await act(async () => {
      gates[0].resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(persisted.map(planningDocumentEffectiveText)).toEqual(['AB'])
    expect(mocks.setContent).not.toHaveBeenCalled()

    type('D')
    expect(emitted.map(document => document.revision)).toEqual([1, 2, 3])
    expect(planningDocumentEffectiveText(emitted[2])).toBe('ABCD')

    await act(async () => {
      gates[1].resolve()
      await Promise.resolve()
      gates[2].resolve()
      await persistenceTail
    })

    expect(persisted.map(planningDocumentEffectiveText)).toEqual(['AB', 'ABC', 'ABCD'])
    expect(mocks.setContent).not.toHaveBeenCalled()
  })

  it('applies a legitimate external authoritative document when no local draft is pending', () => {
    const onChange = vi.fn()
    const parentA = createPlanningDocumentV1([{ id: 'p1', type: 'paragraph', content: [{ text: 'A' }] }], 4)
    const external = createPlanningDocumentV1([{ id: 'p1', type: 'paragraph', content: [{ text: 'External' }] }], 2)
    let renderer!: ReturnType<typeof create>
    act(() => { renderer = create(<DocumentEditor document={parentA} mode="inline" onChange={onChange} />) })
    mocks.setContent.mockClear()

    act(() => renderer.update(<DocumentEditor document={external} mode="inline" onChange={onChange} />))

    expect(mocks.setContent).toHaveBeenCalledTimes(1)
    expect(editorText()).toBe('External')

    mocks.currentJson = editorJson('External edit')
    const onUpdate = mocks.options?.onUpdate as ((input: { editor: { getJSON: () => unknown } }) => void) | undefined
    if (!onUpdate) throw new Error('Expected Tiptap update callback')
    act(() => onUpdate({ editor: { getJSON: () => mocks.currentJson } }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ revision: 5 }))
  })
})
