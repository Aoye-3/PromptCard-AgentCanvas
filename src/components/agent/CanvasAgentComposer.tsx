import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { Bot, Check, ChevronDown, Loader2, Send, Target, X } from 'lucide-react'
import type { CanvasAgentEditMode, CanvasAgentSelection } from '@/models/Agent.model'
import {
  serializeCanvasAgentComposer,
  type CanvasAgentAttachment,
  type CanvasAgentComposerPart
} from './canvas-agent-composer-model'

export interface CanvasAgentNodeSummary {
  id: string
  title: string
  displayText: string
  userText: string
  kind?: 'text' | 'image' | 'document'
}

export interface CanvasAgentModelOption {
  key: string
  displayName: string
  available: boolean
  unavailableReason?: string | null
}

interface CanvasAgentComposerProps {
  nodes: CanvasAgentNodeSummary[]
  documentNodes?: CanvasAgentNodeSummary[]
  attachments: CanvasAgentAttachment[]
  editMode: CanvasAgentEditMode
  selection?: CanvasAgentSelection
  running: boolean
  disabled: boolean
  externalDraft?: { id: string; content: string }
  resetKey: number
  modelOptions?: CanvasAgentModelOption[]
  selectedModelKey?: string
  modelSaving?: boolean
  onEditModeChange: (mode: CanvasAgentEditMode) => void
  onModelChange?: (modelKey: string) => void
  onRemoveNode: (nodeId: string) => void
  onSetTarget: (nodeId: string) => void
  onClearTarget: () => void
  onSubmit: (content: string, mentions: Array<{ nodeId: string; label: string }>) => void
}

export function CanvasAgentComposer({
  nodes,
  documentNodes = [],
  attachments,
  editMode,
  running,
  disabled,
  externalDraft,
  resetKey,
  modelOptions = [],
  selectedModelKey = '',
  modelSaving = false,
  onEditModeChange,
  onModelChange,
  onRemoveNode,
  onSetTarget,
  onClearTarget,
  onSubmit
}: CanvasAgentComposerProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const targetMenuRef = useRef<HTMLDivElement>(null)
  const mentionRangeRef = useRef<Range | null>(null)
  const [serialized, setSerialized] = useState({ content: '', mentions: [] as Array<{ nodeId: string; label: string }> })
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const [targetMenuOpen, setTargetMenuOpen] = useState(false)
  const nodeById = useMemo(
    () => new Map([...nodes, ...documentNodes].map(node => [node.id, node])),
    [documentNodes, nodes]
  )
  const attachedNodes = attachments.flatMap(attachment => {
    const node = nodeById.get(attachment.nodeId)
    return node ? [{ attachment, node }] : []
  })
  const targetNode = attachedNodes.find(({ attachment }) => attachment.role === 'target')
  const referenceNodes = attachedNodes.filter(({ attachment }) => attachment.role === 'reference')
  const mentionCandidates = [
    ...attachedNodes.map(item => ({ ...item, document: false })),
    ...documentNodes.map(node => ({ node, attachment: undefined, document: true }))
  ].filter(({ node }) => (
    mentionQuery !== null && node.title.toLocaleLowerCase().includes(mentionQuery.toLocaleLowerCase())
  ))
  const selectedModelAvailable = modelOptions.length === 0 || modelOptions.some(model => (
    model.key === selectedModelKey && model.available
  ))

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.replaceChildren()
    setSerialized({ content: '', mentions: [] })
    setMentionQuery(null)
  }, [resetKey])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !externalDraft) return
    editor.textContent = externalDraft.content
    setSerialized({ content: externalDraft.content.trim(), mentions: [] })
    setMentionQuery(null)
  }, [externalDraft])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const validIds = new Set([
      ...attachments.map(attachment => attachment.nodeId),
      ...documentNodes.map(node => node.id)
    ])
    editor.querySelectorAll<HTMLElement>('[data-agent-mention-id]').forEach(element => {
      const nodeId = element.dataset.agentMentionId || ''
      const node = nodeById.get(nodeId)
      if (!validIds.has(nodeId) || !node) {
        element.remove()
        return
      }
      element.textContent = `@${node.title}`
      element.dataset.agentMentionLabel = node.title
    })
    updateSerialized(editor)
  }, [attachments, documentNodes, nodeById])

  useEffect(() => {
    if (!targetMenuOpen || typeof document === 'undefined') return
    const closeWhenOutside = (event: PointerEvent) => {
      if (!targetMenuRef.current?.contains(event.target as Node)) setTargetMenuOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setTargetMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeWhenOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeWhenOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [targetMenuOpen])

  const updateSerialized = (editor: HTMLElement) => {
    const next = serializeCanvasAgentComposer(readComposerParts(editor))
    setSerialized(next)
    return next
  }

  const handleInput = (event: FormEvent<HTMLDivElement>) => {
    const editor = event.currentTarget
    updateSerialized(editor)
    const match = composerTextBeforeCaret(editor).match(/@([^\s@]*)$/)
    if (!match) {
      mentionRangeRef.current = null
      setMentionQuery(null)
      return
    }
    mentionRangeRef.current = rangeForTrailingQuery(editor, match[1].length + 1)
    setMentionQuery(match[1])
    setActiveMentionIndex(0)
  }

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.ownerDocument.execCommand(
      'insertText',
      false,
      event.clipboardData.getData('text/plain')
    )
  }

  const insertMention = (node: CanvasAgentNodeSummary) => {
    const editor = editorRef.current
    const range = mentionRangeRef.current
    if (!editor || !range) return
    range.deleteContents()
    const mention = document.createElement('span')
    mention.contentEditable = 'false'
    mention.dataset.agentMentionId = node.id
    mention.dataset.agentMentionLabel = node.title
    mention.className = 'mx-0.5 inline-flex rounded-md bg-amber-50 px-1.5 py-0.5 text-[12px] font-bold text-amber-800'
    mention.textContent = `@${node.title}`
    const spacer = document.createTextNode('\u00a0')
    range.insertNode(spacer)
    range.insertNode(mention)
    const selectionApi = window.getSelection()
    const caret = document.createRange()
    caret.setStartAfter(spacer)
    caret.collapse(true)
    selectionApi?.removeAllRanges()
    selectionApi?.addRange(caret)
    mentionRangeRef.current = null
    setMentionQuery(null)
    updateSerialized(editor)
    editor.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setActiveMentionIndex(index => (index + direction + mentionCandidates.length) % mentionCandidates.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        insertMention(mentionCandidates[activeMentionIndex].node)
        return
      }
    }
    if (event.key === 'Escape' && mentionQuery !== null) {
      event.preventDefault()
      setMentionQuery(null)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (!disabled && serialized.content) onSubmit(serialized.content, serialized.mentions)
  }

  const handleReferenceContextMenu = (event: MouseEvent, nodeId: string) => {
    event.preventDefault()
    onSetTarget(nodeId)
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Canvas Agent 节点标签">
        <div ref={targetMenuRef} className="relative inline-flex max-w-full items-center">
          <button
            type="button"
            aria-label="选择被修改对象"
            aria-haspopup="listbox"
            aria-expanded={targetMenuOpen}
            className={`inline-flex h-7 max-w-full items-center gap-1 rounded-md border px-2 text-[10px] font-bold transition ${targetNode ? 'border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100' : 'border-dashed border-[#d1d5db] bg-white text-[#87867f] hover:border-[#a8a69e] hover:text-[#4d4c48]'}`}
            onClick={() => setTargetMenuOpen(open => !open)}
          >
            <Target className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="break-all">{targetNode ? targetNode.node.title : '尚未选择被修改对象'}</span>
            <ChevronDown className={`h-3 w-3 shrink-0 transition ${targetMenuOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          {targetNode ? (
            <button
              type="button"
              aria-label="清空被修改对象"
              title="清空被修改对象，节点仍保留为参考"
              className="ml-1 rounded-md border border-amber-200 bg-amber-50 p-1 text-amber-900 hover:bg-amber-100"
              onClick={onClearTarget}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ) : null}
          {targetMenuOpen ? (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-56 max-w-72 rounded-lg border border-[#e5e7eb] bg-white p-1 shadow-xl" role="listbox" aria-label="可选的被修改对象">
              {attachedNodes.length ? attachedNodes.map(({ attachment, node }) => (
                <button
                  key={node.id}
                  type="button"
                  role="option"
                  aria-selected={attachment.role === 'target'}
                  aria-label={`设为被修改对象 ${node.title}`}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-amber-50"
                  onClick={() => {
                    onSetTarget(node.id)
                    setTargetMenuOpen(false)
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-all text-[11px] font-bold text-[#141413]">{node.title}</span>
                    <span className="block truncate text-[10px] text-[#87867f]">{node.displayText}</span>
                  </span>
                  {attachment.role === 'target' ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden="true" /> : null}
                </button>
              )) : (
                <div className="px-2 py-2 text-[11px] text-[#87867f]">先通过画布菜单发送文本节点到 Agent</div>
              )}
            </div>
          ) : null}
        </div>
        {referenceNodes.length ? <span className="px-0.5 text-xs font-bold text-[#b1afa7]">/</span> : null}
        {referenceNodes.map(({ node }) => (
          <span
            key={node.id}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-[#e5e7eb] bg-[#f9fafb] px-2 py-1 text-[10px] font-bold text-[#5e5d59]"
            title="参考节点；右键可设为被修改对象"
            onContextMenu={event => handleReferenceContextMenu(event, node.id)}
          >
            <span className="break-all">{node.title}</span>
            <button type="button" className="ml-0.5 rounded p-0.5 hover:bg-black/5" aria-label={`移除 ${node.title}`} onClick={() => onRemoveNode(node.id)}>
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="relative rounded-[10px] border border-[#d1d5db] bg-white p-2 shadow-[0_0_0_1px_rgba(20,20,19,0.02)] focus-within:border-[#87867f]">
        <div
          ref={editorRef}
          data-agent-composer
          contentEditable
          role="textbox"
          aria-label="Agent 消息"
          aria-multiline="true"
          suppressContentEditableWarning
          className="min-h-[58px] max-h-32 w-full overflow-y-auto whitespace-pre-wrap break-words border-0 bg-transparent px-1 py-0.5 text-[13px] leading-5 text-[#141413] outline-none empty:before:pointer-events-none empty:before:text-[#87867f] empty:before:content-[attr(data-placeholder)]"
          data-placeholder="描述你想修改的内容，输入 @ 引用节点"
          onInput={handleInput}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
        />
        {mentionQuery !== null ? (
          <div className="absolute bottom-full left-2 right-2 z-40 mb-1 max-h-48 overflow-y-auto rounded-lg border border-[#e5e7eb] bg-white p-1 shadow-xl" role="listbox" aria-label="可引用的文字节点">
            {mentionCandidates.length ? mentionCandidates.map(({ attachment, document, node }, index) => (
              <button
                key={node.id}
                type="button"
                role="option"
                aria-selected={index === activeMentionIndex}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${index === activeMentionIndex ? 'bg-amber-50' : 'hover:bg-[#f9fafb]'}`}
                onMouseDown={event => event.preventDefault()}
                onClick={() => insertMention(node)}
              >
                <span className="mt-0.5 rounded bg-[#f3f4f6] px-1 text-[9px] font-bold text-[#5e5d59]">{document ? '文档' : attachment?.role === 'target' ? '目标' : '参考'}</span>
                <span className="min-w-0"><span className="block break-all text-[11px] font-bold text-[#141413]">{node.title}</span><span className="block truncate text-[10px] text-[#87867f]">{node.displayText}</span></span>
              </button>
            )) : <div className="px-2 py-2 text-[11px] text-[#87867f]">没有匹配的已挂载节点或文档</div>}
          </div>
        ) : null}
        <div className="mt-1 flex items-center gap-2">
          <label className="relative inline-flex h-7 items-center rounded-lg border border-[#e5e7eb] bg-[#f9fafb] text-[10px] font-bold text-[#4d4c48]">
            <Bot className="ml-2 h-3 w-3" aria-hidden="true" />
            <select
              aria-label="Canvas Agent 编辑模式"
              value={editMode}
              onChange={event => onEditModeChange(event.target.value as CanvasAgentEditMode)}
              className="h-full appearance-none bg-transparent pl-1.5 pr-7 outline-none"
            >
              <option value="complete">补全</option>
              <option value="rewrite">改写</option>
              <option value="prompt-library">Prompt库调取</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3" aria-hidden="true" />
          </label>
          {modelOptions.length ? (
            <label className="relative inline-flex h-7 min-w-0 max-w-[160px] items-center rounded-lg border border-[#e5e7eb] bg-[#f9fafb] text-[10px] font-bold text-[#4d4c48]">
              <select
                aria-label="对话模型"
                value={selectedModelKey}
                disabled={running || modelSaving}
                onChange={event => onModelChange?.(event.target.value)}
                className="h-full min-w-0 w-full appearance-none truncate bg-transparent pl-2 pr-7 outline-none disabled:opacity-50"
              >
                <option value="" disabled>选择对话模型</option>
                {modelOptions.map(model => (
                  <option key={model.key} value={model.key} disabled={!model.available}>
                    {model.displayName}{!model.available && model.unavailableReason ? ` · ${model.unavailableReason}` : ''}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3" aria-hidden="true" />
            </label>
          ) : null}
          <span className="min-w-0 truncate text-[10px] font-medium text-[#87867f]">
            {editMode === 'complete'
              ? '分析原文并穿插补充'
              : editMode === 'prompt-library'
                ? '只读搜索 Prompt 与关联媒体'
                : '生成新文本节点，原节点不变'}
          </span>
          <button
            type="button"
            aria-label="发送给 Agent"
            title="发送给 Agent"
            className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#141413] text-white transition hover:bg-[#30302e] disabled:bg-[#d1cfc5]"
            onClick={() => onSubmit(serialized.content, serialized.mentions)}
            disabled={disabled || modelSaving || !selectedModelAvailable || !serialized.content}
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  )
}

function readComposerParts(root: HTMLElement): CanvasAgentComposerPart[] {
  if (!root.childNodes) return [{ type: 'text', text: root.textContent || '' }]
  const parts: CanvasAgentComposerPart[] = []
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push({ type: 'text', text: node.textContent || '' })
      return
    }
    if (!(node instanceof HTMLElement)) return
    const nodeId = node.dataset.agentMentionId
    if (nodeId) {
      parts.push({ type: 'mention', nodeId, label: node.dataset.agentMentionLabel || node.textContent?.replace(/^@/, '') || nodeId })
      return
    }
    if (node.tagName === 'BR') {
      parts.push({ type: 'text', text: '\n' })
      return
    }
    node.childNodes.forEach(visit)
  }
  root.childNodes.forEach(visit)
  return parts
}

function composerTextBeforeCaret(root: HTMLElement): string {
  const selection = typeof window === 'undefined' ? null : window.getSelection()
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return root.textContent || ''
  const range = selection.getRangeAt(0).cloneRange()
  range.selectNodeContents(root)
  range.setEnd(selection.anchorNode!, selection.anchorOffset)
  return range.toString()
}

function rangeForTrailingQuery(root: HTMLElement, queryLength: number): Range | null {
  const selection = typeof window === 'undefined' ? null : window.getSelection()
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return null
  const endRange = selection.getRangeAt(0)
  const before = endRange.cloneRange()
  before.selectNodeContents(root)
  before.setEnd(endRange.endContainer, endRange.endOffset)
  const startOffset = Math.max(0, before.toString().length - queryLength)
  const startPoint = domPointAtTextOffset(root, startOffset)
  if (!startPoint) return null
  const range = document.createRange()
  range.setStart(startPoint.node, startPoint.offset)
  range.setEnd(endRange.endContainer, endRange.endOffset)
  return range
}

function domPointAtTextOffset(root: HTMLElement, target: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let offset = 0
  let current = walker.nextNode()
  while (current) {
    const length = current.textContent?.length || 0
    if (offset + length >= target) return { node: current, offset: target - offset }
    offset += length
    current = walker.nextNode()
  }
  return { node: root, offset: root.childNodes.length }
}
