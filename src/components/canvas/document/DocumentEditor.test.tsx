import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlanningDocumentV1 } from '@/domain/documents/planning-document'

const mocks = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  run: vi.fn(),
  setContent: vi.fn()
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
    setLink: vi.fn(),
    unsetLink: vi.fn(),
    run: mocks.run
  }
  Object.keys(chain).forEach(key => {
    if (key !== 'run') (chain as Record<string, ReturnType<typeof vi.fn>>)[key].mockReturnValue(chain)
  })
  const editor = {
    chain: () => chain,
    commands: { setContent: mocks.setContent },
    getJSON: vi.fn(),
    isActive: vi.fn(() => false),
    isEditable: true,
    setEditable: vi.fn()
  }
  return {
    useEditor: (options: Record<string, unknown>) => {
      mocks.options = options
      return editor
    },
    EditorContent: ({ className }: { className?: string }) => (
      <div role="textbox" aria-label="规划文档正文" className={className} contentEditable />
    )
  }
})

import { DocumentEditor } from './DocumentEditor'

describe('DocumentEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.options = null
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

  it('routes toolbar actions through the restricted Tiptap command chain', () => {
    const renderer = create(
      <DocumentEditor document={createPlanningDocumentV1([])} mode="expanded" onChange={vi.fn()} />
    )

    act(() => renderer.root.findByProps({ 'aria-label': '粗体' }).props.onClick())

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
})
