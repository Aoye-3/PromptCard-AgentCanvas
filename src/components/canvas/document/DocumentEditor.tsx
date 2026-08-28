import { useEffect, useMemo, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import type { PlanningDocumentV1 } from '@/models/PromptHistory.model'
import {
  createPlanningDocumentEditorProps,
  createPlanningDocumentTiptapExtensions,
  planningDocumentFromTiptapJson,
  planningDocumentToTiptapJson
} from './planning-document-tiptap'

export interface DocumentEditorProps {
  document: PlanningDocumentV1
  mode: 'inline' | 'expanded'
  onChange: (document: PlanningDocumentV1) => void
  autoFocus?: boolean
}

export const DocumentEditor = ({
  document,
  mode,
  onChange,
  autoFocus = false
}: DocumentEditorProps) => {
  const documentRef = useRef(document)
  const onChangeRef = useRef(onChange)
  const lastEditorDigestRef = useRef(document.digest)
  documentRef.current = document
  onChangeRef.current = onChange

  const initialContent = useMemo(() => planningDocumentToTiptapJson(document), [document])
  const editor = useEditor({
    extensions: createPlanningDocumentTiptapExtensions(),
    content: initialContent,
    editorProps: createPlanningDocumentEditorProps(),
    autofocus: autoFocus ? 'start' : false,
    immediatelyRender: false,
    onUpdate: ({ editor: currentEditor }) => {
      const next = planningDocumentFromTiptapJson(
        currentEditor.getJSON(),
        documentRef.current.revision + 1
      )
      lastEditorDigestRef.current = next.digest
      onChangeRef.current(next)
    }
  })

  useEffect(() => {
    if (!editor || document.digest === lastEditorDigestRef.current) return
    editor.commands.setContent(planningDocumentToTiptapJson(document), { emitUpdate: false })
    lastEditorDigestRef.current = document.digest
  }, [document, editor])

  return (
    <section
      data-document-editor-mode={mode}
      className={`nodrag nowheel flex min-h-0 flex-col bg-white ${mode === 'expanded' ? 'h-full' : 'h-[300px]'}`}
      onPointerDown={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <DocumentEditorToolbar editor={editor} />
      <EditorContent
        editor={editor}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm leading-6 text-gray-900 outline-none [&_.ProseMirror]:min-h-full [&_.ProseMirror]:outline-none [&_a]:text-sky-700 [&_a]:underline [&_a]:decoration-sky-400 [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-gray-300 [&_blockquote]:pl-3 [&_h1]:text-xl [&_h1]:font-black [&_h2]:text-lg [&_h2]:font-black [&_h3]:text-base [&_h3]:font-bold [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-gray-200 [&_td]:p-2 [&_th]:border [&_th]:border-gray-300 [&_th]:bg-gray-50 [&_th]:p-2"
      />
    </section>
  )
}

const DocumentEditorToolbar = ({ editor }: { editor: Editor | null }) => {
  const run = (action: (editor: Editor) => void) => () => {
    if (editor) action(editor)
  }
  const setLink = () => {
    if (!editor || typeof window === 'undefined') return
    const current = editor.getAttributes('link').href as string | undefined
    const response = window.prompt('输入 http、https 或 mailto 链接；留空移除现有链接', current || '')
    if (response === null) return
    const href = response.trim()
    if (!href) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    if (!safeEditorLink(href)) return
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
  }
  const button = (
    label: string,
    text: string,
    action: (editor: Editor) => void,
    active?: boolean
  ) => (
    <button
      key={label}
      type="button"
      aria-label={label}
      aria-pressed={active}
      className={`h-8 rounded-md px-2 text-xs font-bold transition-colors ${
        active ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-950'
      }`}
      onClick={run(action)}
    >{text}</button>
  )

  return (
    <div role="toolbar" aria-label="规划文档格式" className="nodrag nowheel flex shrink-0 flex-wrap items-center gap-0.5 border-b border-gray-200 bg-gray-50 px-2 py-1.5">
      {button('正文', '正文', item => { item.chain().focus().setParagraph().run() }, editor?.isActive('paragraph'))}
      {([1, 2, 3] as const).map(level => button(
        `${['一', '二', '三'][level - 1]}级标题`,
        `H${level}`,
        item => { item.chain().focus().toggleHeading({ level }).run() },
        editor?.isActive('heading', { level })
      ))}
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-gray-200" />
      {button('粗体', 'B', item => { item.chain().focus().toggleBold().run() }, editor?.isActive('bold'))}
      {button('斜体', 'I', item => { item.chain().focus().toggleItalic().run() }, editor?.isActive('italic'))}
      {button('引用', '引用', item => { item.chain().focus().toggleBlockquote().run() }, editor?.isActive('blockquote'))}
      {button('无序列表', '• 列表', item => { item.chain().focus().toggleBulletList().run() }, editor?.isActive('bulletList'))}
      {button('有序列表', '1. 列表', item => { item.chain().focus().toggleOrderedList().run() }, editor?.isActive('orderedList'))}
      {button('任务列表', '☑ 任务', item => { item.chain().focus().toggleTaskList().run() }, editor?.isActive('taskList'))}
      <button
        type="button"
        aria-label="插入链接"
        aria-pressed={editor?.isActive('link')}
        className="h-8 rounded-md px-2 text-xs font-bold text-gray-600 hover:bg-gray-100 hover:text-gray-950"
        onClick={setLink}
      >链接</button>
      {button('插入表格', '表格', item => {
        item.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run()
      })}
    </div>
  )
}

const safeEditorLink = (href: string): boolean => {
  try {
    const url = new URL(href)
    return url.protocol === 'mailto:'
      ? url.pathname.length > 0
      : (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}
