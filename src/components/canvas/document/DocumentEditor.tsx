import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import type { PlanningDocumentV1 } from '@/models/PromptHistory.model'
import type { AgentPromptHandoffBasis } from '@/models/Agent.model'
import { createDocumentPromptHandoffBasis } from '@/domain/documents/prompt-handoff-selection'
import {
  createPlanningDocumentEditorProps,
  createPlanningDocumentTiptapExtensions,
  type PlanningDocumentDisplayView,
  planningDocumentFromTiptapJson,
  planningDocumentToDisplayTiptapJson
} from './planning-document-tiptap'

export interface DocumentEditorProps {
  document: PlanningDocumentV1
  mode: 'inline' | 'expanded'
  onChange: (document: PlanningDocumentV1) => void
  autoFocus?: boolean
  view?: PlanningDocumentDisplayView
  nodeId?: string
  onPromptHandoff?: (basis: Extract<AgentPromptHandoffBasis, { kind: 'document-selection' }>) => void
}

export const DocumentEditor = ({
  document,
  mode,
  onChange,
  autoFocus = false,
  view = 'effective',
  nodeId,
  onPromptHandoff
}: DocumentEditorProps) => {
  const readOnly = view !== 'effective' || document.suggestions.length > 0
  const documentRef = useRef(document)
  const onChangeRef = useRef(onChange)
  const readOnlyRef = useRef(readOnly)
  const viewRef = useRef(view)
  const lastEditorProjectionRef = useRef(`${document.digest}:${view}`)
  const revisionClockRef = useRef(document.revision)
  const authoritativeIdentityRef = useRef(planningDocumentIdentity(document, view))
  const pendingLocalIdentitiesRef = useRef<string[]>([])
  const [promptSelection, setPromptSelection] = useState<Extract<AgentPromptHandoffBasis, { kind: 'document-selection' }>>()

  useLayoutEffect(() => {
    documentRef.current = document
    onChangeRef.current = onChange
    readOnlyRef.current = readOnly
    viewRef.current = view
    revisionClockRef.current = Math.max(revisionClockRef.current, document.revision)
  }, [document, onChange, readOnly, view])

  const initialContent = useMemo(
    () => planningDocumentToDisplayTiptapJson(document, view),
    [document, view]
  )
  const editor = useEditor({
    extensions: createPlanningDocumentTiptapExtensions(),
    content: initialContent,
    editorProps: createPlanningDocumentEditorProps(),
    autofocus: autoFocus ? 'start' : false,
    editable: !readOnly,
    immediatelyRender: false,
    onUpdate: ({ editor: currentEditor }) => {
      if (readOnlyRef.current) return
      const nextRevision = Math.max(revisionClockRef.current, documentRef.current.revision) + 1
      const next = planningDocumentFromTiptapJson(
        currentEditor.getJSON(),
        nextRevision
      )
      revisionClockRef.current = nextRevision
      pendingLocalIdentitiesRef.current.push(planningDocumentIdentity(next, viewRef.current))
      lastEditorProjectionRef.current = `${next.digest}:${viewRef.current}`
      onChangeRef.current(next)
    },
    onSelectionUpdate: ({ editor: currentEditor }) => {
      if (!nodeId || !onPromptHandoff || viewRef.current !== 'effective') {
        setPromptSelection(undefined)
        return
      }
      const { $from, $to, empty } = currentEditor.state.selection
      if (empty || !$from.sameParent($to)) {
        setPromptSelection(undefined)
        return
      }
      const blockId = nearestPlanningLeafId($from)
      if (!blockId || blockId !== nearestPlanningLeafId($to)) {
        setPromptSelection(undefined)
        return
      }
      setPromptSelection(createDocumentPromptHandoffBasis(
        documentRef.current, nodeId, blockId, $from.parentOffset, $to.parentOffset
      ) || undefined)
    }
  })

  useEffect(() => {
    if (!editor) return
    editor.setEditable(!readOnly)
    const identity = planningDocumentIdentity(document, view)
    const pendingIndex = pendingLocalIdentitiesRef.current.indexOf(identity)
    if (pendingIndex >= 0) {
      pendingLocalIdentitiesRef.current.splice(0, pendingIndex + 1)
      authoritativeIdentityRef.current = identity
      return
    }
    if (identity === authoritativeIdentityRef.current) return
    pendingLocalIdentitiesRef.current = []
    authoritativeIdentityRef.current = identity
    const projection = `${document.digest}:${view}`
    if (projection === lastEditorProjectionRef.current) return
    editor.commands.setContent(planningDocumentToDisplayTiptapJson(document, view), { emitUpdate: false })
    lastEditorProjectionRef.current = projection
  }, [document, editor, readOnly, view])

  return (
    <section
      data-document-editor-mode={mode}
      data-document-editor-view={view}
      data-document-editor-readonly={readOnly}
      className={`nodrag nowheel flex min-h-0 flex-col bg-white ${mode === 'expanded' ? 'h-full' : 'h-[300px]'}`}
      onPointerDown={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <DocumentEditorToolbar editor={editor} disabled={readOnly} />
      {promptSelection && onPromptHandoff ? (
        <button
          type="button"
          className="nodrag border-b border-sky-100 bg-sky-50 px-3 py-2 text-left text-xs font-bold text-sky-700"
          onClick={() => onPromptHandoff(promptSelection)}
        >选中文本转为 Prompt 提案</button>
      ) : null}
      <EditorContent
        editor={editor}
        aria-readonly={readOnly}
        data-document-editor-readonly={readOnly}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm leading-6 text-gray-900 outline-none [&_.ProseMirror]:min-h-full [&_.ProseMirror]:outline-none [&_a]:text-sky-700 [&_a]:underline [&_a]:decoration-sky-400 [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-gray-300 [&_blockquote]:pl-3 [&_h1]:text-xl [&_h1]:font-black [&_h2]:text-lg [&_h2]:font-black [&_h3]:text-base [&_h3]:font-bold [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-gray-200 [&_td]:p-2 [&_th]:border [&_th]:border-gray-300 [&_th]:bg-gray-50 [&_th]:p-2 [&_[data-document-suggestion-kind=insert]]:bg-emerald-50 [&_[data-document-suggestion-kind=insert]]:text-emerald-700 [&_[data-document-suggestion-kind=delete]]:bg-red-50 [&_[data-document-suggestion-kind=delete]]:text-red-700 [&_[data-document-suggestion-kind=delete]]:line-through [&_[data-document-suggestion-kind=delete]]:decoration-red-600"
      />
    </section>
  )
}

const nearestPlanningLeafId = ($position: { depth: number; node: (depth: number) => { attrs?: Record<string, unknown> } }): string | null => {
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const blockId = $position.node(depth).attrs?.blockId
    if (typeof blockId === 'string' && blockId) return blockId
  }
  return null
}

const planningDocumentIdentity = (
  document: PlanningDocumentV1,
  view: PlanningDocumentDisplayView
): string => (
  `${document.revision}:${document.digest}:${view}`
)

const DocumentEditorToolbar = ({ editor, disabled }: { editor: Editor | null; disabled: boolean }) => {
  const run = (action: (editor: Editor) => void) => () => {
    if (editor && !disabled) action(editor)
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
      disabled={disabled}
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
        disabled={disabled}
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
