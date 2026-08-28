import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Expand, FileText, RotateCcw, Trash2, X } from 'lucide-react'
import { DocumentEditor } from '@/components/canvas/document/DocumentEditor'
import { planningDocumentEffectiveText } from '@/domain/documents/planning-document'
import type { IFreeCanvasDocumentNode, PlanningDocumentV1 } from '@/models/PromptHistory.model'

interface DocumentNodeProps {
  node: IFreeCanvasDocumentNode
  selected: boolean
  onDocumentChange: (document: PlanningDocumentV1) => Promise<boolean> | boolean
  onCollapsedChange?: (collapsed: boolean) => Promise<boolean> | boolean
  onDelete: () => void
}

export const DocumentNode = ({ node, selected, onDocumentChange, onCollapsedChange, onDelete }: DocumentNodeProps) => {
  const expandButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const requestTokenRef = useRef(0)
  const [collapsed, setCollapsed] = useState(node.meta.collapsed === true)
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [retryDocument, setRetryDocument] = useState<PlanningDocumentV1 | null>(null)
  const summary = planningDocumentEffectiveText(node.document).replace(/\s+/g, ' ').trim().slice(0, 180)

  useEffect(() => {
    setCollapsed(node.meta.collapsed === true)
  }, [node.id, node.meta.collapsed])

  useEffect(() => {
    if (!expanded) return
    const frame = requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>('[role="textbox"], [contenteditable="true"]')
        ?.focus()
    })
    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    }
  }, [expanded])

  const commit = async (document: PlanningDocumentV1) => {
    const token = ++requestTokenRef.current
    setSaving(true)
    const saved = await onDocumentChange(document)
    if (token !== requestTokenRef.current) return
    setSaving(false)
    setRetryDocument(saved ? null : document)
  }

  const closeExpanded = () => {
    setExpanded(false)
    requestAnimationFrame(() => expandButtonRef.current?.focus())
  }

  const handleExpandedKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeExpanded()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
    ))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = typeof document === 'undefined' ? null : document.activeElement
    const activeInside = Boolean(active && event.currentTarget.contains(active))
    if (event.shiftKey ? active === first || !activeInside : active === last || !activeInside) {
      event.preventDefault()
      const target = event.shiftKey ? last : first
      target.focus()
    }
  }

  const toggleCollapsed = async () => {
    const next = !collapsed
    setCollapsed(next)
    if (!onCollapsedChange) return
    const saved = await onCollapsedChange(next)
    if (!saved) setCollapsed(!next)
  }

  const retryAlert = retryDocument ? (
    <div role="alert" className="nodrag flex items-center gap-2 border-b border-red-100 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
      <span className="flex-1">保存失败，文档已恢复到上次保存状态。</span>
      <button
        type="button"
        aria-label="重试保存文档"
        className="flex items-center gap-1 rounded-md bg-white px-2 py-1 text-red-700 shadow-sm hover:bg-red-100"
        onClick={() => { void commit(retryDocument) }}
      ><RotateCcw className="h-3 w-3" />重试</button>
    </div>
  ) : null

  const expandedEditor = expanded ? (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`document-editor-title-${node.id}`}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-950/45 p-4 sm:p-8"
      onKeyDownCapture={handleExpandedKeyDown}
    >
      <section className="flex h-full max-h-[920px] w-full max-w-5xl flex-col overflow-hidden rounded-[10px] border border-gray-200 bg-white shadow-[0_32px_100px_rgba(15,23,42,0.3)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-3">
          <FileText className="h-4 w-4 text-gray-500" />
          <h2 id={`document-editor-title-${node.id}`} className="min-w-0 flex-1 truncate text-sm font-black text-gray-950">{node.title}</h2>
          <span className="text-xs font-semibold text-gray-400">修订 {node.document.revision}</span>
          <button
            type="button"
            aria-label="关闭展开编辑器"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-950"
            onClick={closeExpanded}
          ><X className="h-4 w-4" /></button>
        </header>
        {retryAlert}
        <DocumentEditor document={node.document} mode="expanded" autoFocus onChange={document => { void commit(document) }} />
      </section>
    </div>
  ) : null

  return (
    <article
      data-document-node={node.id}
      className={`overflow-hidden rounded-[8px] border bg-white shadow-[0_12px_32px_rgba(15,23,42,0.12)] ${
        selected ? 'border-sky-500 ring-2 ring-sky-200' : 'border-gray-200'
      }`}
      style={{ width: node.width, minHeight: collapsed ? undefined : node.height }}
    >
      <header className="flex h-12 items-center gap-2 border-b border-gray-200 px-3">
        <FileText className="h-4 w-4 shrink-0 text-gray-500" />
        <strong className="min-w-0 flex-1 truncate text-sm text-gray-950">{node.title}</strong>
        {saving && <span role="status" className="text-[11px] font-semibold text-gray-400">保存中…</span>}
        <button
          ref={expandButtonRef}
          type="button"
          aria-label="展开编辑器"
          className="nodrag flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-950"
          onClick={() => setExpanded(true)}
        ><Expand className="h-3.5 w-3.5" /></button>
        <button
          type="button"
          aria-label={collapsed ? '展开文档' : '折叠文档'}
          className="nodrag flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-950"
          onClick={() => { void toggleCollapsed() }}
        ><ChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} /></button>
        <button
          type="button"
          aria-label="删除文档"
          className="nodrag flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600"
          onClick={onDelete}
        ><Trash2 className="h-3.5 w-3.5" /></button>
      </header>

      {!expanded && retryAlert}

      {collapsed ? (
        <p data-document-collapsed-summary className="px-4 py-3 text-xs leading-5 text-gray-500">
          {summary || '空白规划文档'}
        </p>
      ) : !expanded ? (
        <DocumentEditor document={node.document} mode="inline" onChange={document => { void commit(document) }} />
      ) : (
        <div className="flex h-[300px] items-center justify-center px-4 text-xs font-semibold text-gray-400">文档正在展开编辑器中打开</div>
      )}

      {expandedEditor && typeof document !== 'undefined' && document.body
        ? createPortal(expandedEditor, document.body)
        : expandedEditor}
    </article>
  )
}
