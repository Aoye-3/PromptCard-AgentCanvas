import { Check, FileText, Loader2, Send, ShieldCheck, Sparkles, Wand2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useI18n } from '@/i18n'
import type { AgentMediaPromptPreviewProposal } from '@/models/Agent.model'
import { PROMPT_LIBRARY_CARD_TYPES, type CardType } from '@/models/Card.model'
import { agentRuntimeService, type PromptLanguageMode } from '@/services/agent-runtime-service'
import { storageServiceClient } from '@/storage/storage-service-client'
import type { RecentCaptureItemViewModel } from './media-types'
import { RecentCapturePreview } from './RecentCapturePreview'

type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string }
type PromptPreview = { version: number; label: string; type: CardType; category: string; content: string; rationale: string }
type SelectionDiff = { start: number; end: number; before: string; after: string }

const promptLanguageOptions: Array<{ value: PromptLanguageMode; label: string; ariaLabel: string }> = [
  { value: 'zh', label: '中文', ariaLabel: '使用中文 Prompt' },
  { value: 'en', label: 'English', ariaLabel: 'Use English Prompt' },
  { value: 'mixed', label: '混合', ariaLabel: '使用混合 Prompt' }
]

export const MediaAnalysisDialog = ({ capture, onClose }: { capture: RecentCaptureItemViewModel | null; onClose: () => void }) => {
  const { t, cardTypeLabel } = useI18n()
  const previewRef = useRef<HTMLTextAreaElement>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [promptLanguageMode, setPromptLanguageMode] = useState<PromptLanguageMode>('mixed')
  const [preview, setPreview] = useState<PromptPreview | null>(null)
  const [selectionDiff, setSelectionDiff] = useState<SelectionDiff | null>(null)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  if (!capture) return null
  const selectedCapture = capture

  async function sendChat(action: 'chat' | 'preview' | 'selection-rewrite' = 'chat') {
    if (running) return
    const selection = action === 'selection-rewrite' && preview && previewRef.current
      ? {
          start: previewRef.current.selectionStart,
          end: previewRef.current.selectionEnd,
          text: preview.content.slice(previewRef.current.selectionStart, previewRef.current.selectionEnd)
        }
      : null
    if (action === 'chat' && !draft.trim()) return
    if (action === 'selection-rewrite' && (!selection || !selection.text || !draft.trim())) return
    const content = action === 'preview'
      ? `${preview ? '更新' : '生成'}当前讨论形成的 Prompt 预览。`
      : draft.trim()
    const userMessage = { id: `media-user-${Date.now()}`, role: 'user' as const, text: content }
    setMessages(current => [...current, userMessage])
    setRunning(true)
    setError('')
    try {
      await agentRuntimeService.bootstrap()
      const result = await agentRuntimeService.analyzeMedia({
        assetId: selectedCapture.assetId,
        contentType: selectedCapture.contentType,
        analysisType: action === 'preview' ? 'prompt' : 'freeform',
        content,
        history: messages.map(message => ({ role: message.role, text: message.text })),
        mediaAction: action,
        promptLanguageMode,
        mediaPreview: preview,
        selection
      })
      setMessages(current => [...current, { id: `media-agent-${Date.now()}`, role: 'assistant', text: result.text }])
      if (action === 'preview') {
        const proposal = result.proposals.find(item => item.kind === 'media_prompt_preview') as AgentMediaPromptPreviewProposal | undefined
        if (proposal) setPreview({ version: (preview?.version || 0) + 1, ...proposal.previewDraft, rationale: proposal.rationale })
      } else if (action === 'selection-rewrite' && selection) {
        setSelectionDiff({ ...selection, before: selection.text, after: result.text.trim() })
      }
      setDraft('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRunning(false)
    }
  }

  function applySelectionDiff() {
    if (!preview || !selectionDiff) return
    setPreview({
      ...preview,
      version: preview.version + 1,
      content: preview.content.slice(0, selectionDiff.start) + selectionDiff.after + preview.content.slice(selectionDiff.end)
    })
    setSelectionDiff(null)
  }

  async function writePrompt() {
    if (!preview || saving) return
    setSaving(true)
    setError('')
    try {
      await storageServiceClient.recentCaptures.registerToPromptLibrary({
        intent: 'analysis-derived',
        mode: 'separate',
        captures: [{
          id: selectedCapture.id,
          revision: selectedCapture.revision,
          label: preview.label,
          content: preview.content,
          type: preview.type,
          category: preview.category
        }]
      })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const promptPreviewPanel = (
    <div className="min-h-0 overflow-y-auto rounded-lg border border-gray-200 bg-white p-3" data-media-prompt-preview>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-gray-500">
          <FileText className="h-4 w-4" />Prompt 预览
        </div>
        {preview ? <span className="text-[10px] font-bold text-gray-400">v{preview.version}</span> : null}
      </div>
      {!preview ? (
        <>
          <button type="button" disabled className="mb-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gray-300 px-4 py-2.5 text-sm font-bold text-white">
            <FileText className="h-4 w-4" />写入 Prompt 库
          </button>
          <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-gray-200 px-4 text-center text-sm text-gray-400">
            讨论完成后点击“生成预览”
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px]">
            <input
              value={preview.label}
              onChange={event => setPreview({ ...preview, label: event.target.value })}
              aria-label="Prompt 名称"
              className="min-w-0 rounded-lg border border-gray-200 px-3 py-2 text-sm font-bold"
            />
            <select
              value={preview.type}
              onChange={event => setPreview({ ...preview, type: event.target.value as CardType })}
              aria-label="Prompt 库大类"
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
            >
              {PROMPT_LIBRARY_CARD_TYPES.map(type => (
                <option key={type} value={type}>{cardTypeLabel(type)}</option>
              ))}
            </select>
          </div>
          <input
            value={preview.category}
            onChange={event => setPreview({ ...preview, category: event.target.value })}
            aria-label="Prompt 二级分类"
            placeholder="二级分类（可选）"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
          <textarea
            ref={previewRef}
            value={preview.content}
            onChange={event => setPreview({ ...preview, version: preview.version + 1, content: event.target.value })}
            aria-label="Prompt 预览内容"
            className="min-h-32 w-full resize-y rounded-lg border border-gray-200 p-3 text-sm leading-6"
          />
          <p className="text-xs leading-5 text-gray-500">{preview.rationale}</p>
          {selectionDiff ? (
            <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div><b>原文</b><p className="mt-1 line-through">{selectionDiff.before}</p></div>
                <div><b>候选</b><p className="mt-1">{selectionDiff.after}</p></div>
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => setSelectionDiff(null)} className="px-2 py-1 font-bold">取消</button>
                <button type="button" onClick={applySelectionDiff} className="inline-flex items-center gap-1 rounded bg-sky-700 px-2 py-1 font-bold text-white">
                  <Check className="h-3 w-3" />确认替换
                </button>
              </div>
            </div>
          ) : null}
          <button type="button" onClick={() => void writePrompt()} disabled={saving || !preview.content.trim() || !preview.label.trim()} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gray-950 px-4 py-2.5 text-sm font-bold text-white disabled:bg-gray-300">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}写入 Prompt 库
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t('mediaAnalysisDialogAria')} data-media-analysis-dialog>
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div data-media-analysis-title className="min-w-0"><div className="text-xs font-black uppercase tracking-wide text-amber-500">临时媒体对话</div><h2 className="mt-1 truncate text-xl font-black">{capture.title}</h2></div>
          <button data-media-analysis-close className="shrink-0 rounded-lg border border-gray-200 p-2 text-gray-500 hover:bg-gray-50" type="button" onClick={onClose} aria-label={t('mediaAnalysisDialogCloseAria')}><X className="h-5 w-5" /></button>
        </header>
        <div className="grid min-h-0 flex-1 overflow-y-auto bg-[#f7f7f5] lg:grid-cols-[minmax(300px,0.8fr)_minmax(420px,1.2fr)]">
          <section className="space-y-4 border-b border-gray-200 p-4 lg:border-b-0 lg:border-r" data-media-dossier>
            <div data-media-analysis-preview><div className="mb-2 text-xs font-black uppercase tracking-wide text-gray-500">媒体预览</div><RecentCapturePreview capture={capture} /><div className="mt-2 flex gap-2 text-xs font-bold text-gray-400"><span>{capture.contentType}</span><span>{capture.sizeLabel}</span>{capture.dimensionsLabel ? <span>{capture.dimensionsLabel}</span> : null}</div></div>
            {promptPreviewPanel}
            <label data-media-analysis-prompt><span className="mb-1 block text-xs font-bold text-gray-500">原始 Prompt</span><textarea readOnly value={capture.prompt} className="min-h-24 w-full resize-none rounded-lg border border-gray-200 bg-white p-3 text-xs leading-5 text-gray-700" /></label>
            <label data-media-analysis-note><span className="mb-1 block text-xs font-bold text-gray-500">备注</span><textarea readOnly value={capture.userNote} className="min-h-16 w-full resize-none rounded-lg border border-gray-200 bg-white p-3 text-xs leading-5 text-gray-700" /></label>
            <div className="flex items-start gap-2 rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-xs font-semibold leading-5 text-emerald-800"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />只使用当前素材；关闭窗口即清空对话。内置 Media Prompt Reverse Skill 已启用。</div>
          </section>

          <section className="grid min-h-[620px] grid-rows-[minmax(0,1fr)_auto] gap-3 p-4" data-media-agent-workspace>
            <div className="min-h-0 overflow-y-auto rounded-lg border border-gray-200 bg-white p-3" data-media-analysis-chat>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-gray-500"><Sparkles className="h-4 w-4 text-amber-500" />临时讨论</div>
                <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5" role="group" aria-label="Prompt 语言倾向" data-media-prompt-language>
                  {promptLanguageOptions.map(option => {
                    const active = promptLanguageMode === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setPromptLanguageMode(option.value)}
                        aria-label={option.ariaLabel}
                        aria-pressed={active}
                        className={`rounded-md px-2.5 py-1.5 text-xs font-bold transition-colors ${active ? 'bg-gray-950 text-white shadow-sm' : 'text-gray-500 hover:bg-white hover:text-gray-900'}`}
                      >
                        {option.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              {messages.length === 0 ? <p className="text-sm leading-6 text-gray-400">先与 Agent 讨论构图、风格和约束；确认方向后再显式生成 Prompt 预览。</p> : <div className="space-y-2">{messages.map(message => <div key={message.id} className={`rounded-lg px-3 py-2 text-sm leading-6 ${message.role === 'user' ? 'ml-8 bg-gray-950 text-white' : 'mr-8 bg-gray-100 text-gray-700'}`}>{message.text}</div>)}</div>}
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-2">
              <textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder={preview ? '输入讨论内容；也可在左侧预览中框选文字后要求局部改写' : '和 Agent 讨论这张素材…'} className="min-h-16 w-full resize-none border-0 p-2 text-sm outline-none" />
              <div className="flex flex-wrap items-center justify-between gap-2"><button type="button" onClick={() => void sendChat('preview')} disabled={running} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900"><Wand2 className="h-4 w-4" />{preview ? '更新预览' : '生成预览'}</button><div className="flex gap-2">{preview ? <button type="button" onClick={() => void sendChat('selection-rewrite')} disabled={running || !draft.trim()} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-bold">改写选区</button> : null}<button type="button" onClick={() => void sendChat('chat')} disabled={running || !draft.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-gray-950 px-3 py-2 text-xs font-bold text-white">{running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}发送</button></div></div>
              {error ? <p className="mt-2 text-xs font-semibold text-red-600" role="alert">{error}</p> : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
