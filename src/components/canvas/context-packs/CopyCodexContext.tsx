import { Ban, Braces, Check, Copy, Loader2, RotateCcw, Search, ShieldCheck, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useClipboardCopyFeedback } from '@/components/prompt-media/useClipboardCopyFeedback'
import {
  buildContextPackCreateRequest,
  createContextPackSelectionPreview,
  normalizeContextPackCode,
  type ContextPackSelectionPreview
} from '@/domain/context-packs/context-pack'
import { validatePublicReferenceCode } from '@/domain/reference-codes/reference-code'
import type { IFreeCanvasNode, IPromptProject } from '@/models/PromptHistory.model'
import {
  StorageHttpError,
  StorageRevisionConflict,
  storageServiceClient,
  type ContextPackCreateRequest,
  type ContextPackInspection
} from '@/storage/storage-service-client'

type ContextPackClient = Pick<typeof storageServiceClient.contextPacks, 'create' | 'inspect' | 'revoke'>

interface CopyCodexContextProps {
  project: IPromptProject
  nodes: IFreeCanvasNode[]
  selectedNodeIds: string[]
  client?: ContextPackClient
  onActiveContextChange?: (context: ContextPackInspection | null) => void
  prepareProjectRevision?: () => Promise<number>
}

interface PreviewSnapshot {
  preview: ContextPackSelectionPreview
  request: ContextPackCreateRequest | null
  disabledReason: string | null
}

type ContextOperationKind = 'create' | 'inspect' | 'revoke'

interface ContextOperation {
  generation: number
  token: number
  kind: ContextOperationKind
  code: string | null
}

export const CopyCodexContext = ({
  project,
  nodes,
  selectedNodeIds,
  client = storageServiceClient.contextPacks,
  onActiveContextChange,
  prepareProjectRevision
}: CopyCodexContextProps) => {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const generationRef = useRef(0)
  const contextRequestSequenceRef = useRef(0)
  const contextRequestRef = useRef<ContextOperation | null>(null)
  const inspectionCodeRef = useRef('')
  const createPendingRef = useRef(false)
  const inspectPendingRef = useRef(false)
  const revokePendingRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [copyScope, setCopyScope] = useState(0)
  const [snapshot, setSnapshot] = useState<PreviewSnapshot | null>(null)
  const [created, setCreated] = useState<ContextPackInspection | null>(null)
  const [inspectionCode, setInspectionCode] = useState('')
  const [inspected, setInspected] = useState<ContextPackInspection | null>(null)
  const [creating, setCreating] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const copyTarget = `context-pack:${copyScope}`
  const { copyFailed, copyText, isCopied } = useClipboardCopyFeedback(`context-pack-dialog:${copyScope}`)

  const beginOperationGeneration = () => {
    generationRef.current += 1
    contextRequestSequenceRef.current += 1
    contextRequestRef.current = null
    clearPendingOperations()
    return generationRef.current
  }

  const clearPendingOperations = () => {
    createPendingRef.current = false
    inspectPendingRef.current = false
    revokePendingRef.current = false
    setCreating(false)
    setInspecting(false)
    setRevoking(false)
  }

  const beginContextRequest = (kind: ContextOperationKind, code: string | null) => {
    clearPendingOperations()
    const request: ContextOperation = {
      generation: generationRef.current,
      token: ++contextRequestSequenceRef.current,
      kind,
      code
    }
    contextRequestRef.current = request
    if (kind === 'create') {
      createPendingRef.current = true
      setCreating(true)
    } else if (kind === 'inspect') {
      inspectPendingRef.current = true
      setInspecting(true)
      setInspected(null)
    } else {
      revokePendingRef.current = true
      setRevoking(true)
      if (code) {
        inspectionCodeRef.current = code
        setInspectionCode(code)
      }
    }
    setError(null)
    return request
  }

  const isCurrentContextRequest = (request: ContextOperation, settlementCode?: string): boolean => {
    if (
      contextRequestRef.current !== request
      || generationRef.current !== request.generation
      || contextRequestRef.current.token !== request.token
      || contextRequestRef.current.kind !== request.kind
    ) return false
    const canonicalSettlement = settlementCode === undefined
      ? undefined
      : normalizeContextPackCode(settlementCode)
    if (settlementCode !== undefined && !canonicalSettlement) return false
    if (request.code && canonicalSettlement && request.code !== canonicalSettlement) return false
    if (request.kind !== 'create' && normalizeContextPackCode(inspectionCodeRef.current) !== request.code) return false
    if (request.kind === 'create' && canonicalSettlement && request.code === null) request.code = canonicalSettlement
    return canonicalSettlement === undefined || request.code === canonicalSettlement
  }

  const invalidateContextRequest = () => {
    contextRequestSequenceRef.current += 1
    contextRequestRef.current = null
    clearPendingOperations()
  }

  const changeInspectionCode = (value: string) => {
    inspectionCodeRef.current = value
    setInspectionCode(value)
    const activeRequest = contextRequestRef.current
    if (!activeRequest) return
    if (activeRequest.kind !== 'create' && normalizeContextPackCode(value) === activeRequest.code) return
    invalidateContextRequest()
    setInspected(null)
    setError(null)
  }

  const openDialog = () => {
    beginOperationGeneration()
    const preview = createContextPackSelectionPreview(nodes, selectedNodeIds)
    const request = buildContextPackCreateRequest(project, preview)
    setSnapshot({ preview, request, disabledReason: disabledReason(project, preview) })
    setCreated(null)
    setInspected(null)
    setCreating(false)
    setInspecting(false)
    setRevoking(false)
    setError(null)
    setCopyScope(value => value + 1)
    setOpen(true)
  }

  const closeDialog = () => {
    beginOperationGeneration()
    setOpen(false)
    setCreating(false)
    setInspecting(false)
    setRevoking(false)
    globalThis.setTimeout(() => triggerRef.current?.focus(), 0)
  }

  useEffect(() => {
    if (open) headingRef.current?.focus()
  }, [open])

  const createPack = async () => {
    if (!snapshot?.request || createPendingRef.current || created) return
    const request = beginContextRequest('create', null)
    try {
      const preparedRevision = prepareProjectRevision
        ? await prepareProjectRevision()
        : snapshot.request.projectRevision
      if (!Number.isSafeInteger(preparedRevision) || preparedRevision < 1) {
        throw new Error('Current project could not be persisted before context creation.')
      }
      const result = await client.create({
        ...snapshot.request,
        projectRevision: preparedRevision
      })
      if (!open || !isCurrentContextRequest(request, result.cvcCode)) return
      setCreated(result)
      setInspected(null)
      onActiveContextChange?.(result)
      inspectionCodeRef.current = result.cvcCode
      setInspectionCode(result.cvcCode)
      await copyText(result.cvcCode, copyTarget)
    } catch (cause) {
      if (open && isCurrentContextRequest(request)) setError(contextPackErrorMessage(cause, '创建上下文失败，请刷新预览后重试。'))
    } finally {
      if (isCurrentContextRequest(request)) {
        createPendingRef.current = false
        setCreating(false)
      }
    }
  }

  const inspectPack = async () => {
    const code = normalizeContextPackCode(inspectionCode)
    if (!code) {
      setError('请输入有效的 CVC 代码。')
      setInspected(null)
      return
    }
    if (inspectPendingRef.current) return
    const request = beginContextRequest('inspect', code)
    try {
      const result = await client.inspect(code)
      if (!open || !isCurrentContextRequest(request, result.cvcCode)) return
      inspectionCodeRef.current = code
      setInspectionCode(code)
      setInspected(result)
      if (created?.cvcCode === result.cvcCode) setCreated(result)
      onActiveContextChange?.(
        result.projectCode === project.referenceCode && result.revokedAt === null
          ? result
          : null
      )
    } catch (cause) {
      if (open && isCurrentContextRequest(request)) {
        setInspected(null)
        setError(contextPackErrorMessage(cause, '无法检查此 CVC。'))
      }
    } finally {
      if (isCurrentContextRequest(request)) {
        inspectPendingRef.current = false
        setInspecting(false)
      }
    }
  }

  const revokePack = async () => {
    if (!inspected || inspected.revokedAt !== null || revokePendingRef.current) return
    const request = beginContextRequest('revoke', inspected.cvcCode)
    try {
      const result = await client.revoke(inspected.cvcCode, {
        actor: 'promptcard-ui',
        reason: 'user-revoked'
      })
      if (!open || !isCurrentContextRequest(request, result.cvcCode)) return
      setInspected(result)
      if (created?.cvcCode === result.cvcCode) setCreated(result)
      onActiveContextChange?.(null)
    } catch (cause) {
      if (open && isCurrentContextRequest(request)) setError(contextPackErrorMessage(cause, '撤销失败，请重试。'))
    } finally {
      if (isCurrentContextRequest(request)) {
        revokePendingRef.current = false
        setRevoking(false)
      }
    }
  }

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeDialog()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
    ) || [])
    if (focusable.length === 0) return
    const current = focusable.indexOf(document.activeElement as HTMLElement)
    if (!event.shiftKey && current === focusable.length - 1) {
      event.preventDefault()
      focusable[0]?.focus()
    } else if (event.shiftKey && current <= 0) {
      event.preventDefault()
      focusable[focusable.length - 1]?.focus()
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-bold text-gray-600 transition hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
        aria-label="复制 Agent/MCP 上下文"
        title="预览并复制 Agent/MCP 上下文"
        onClick={openDialog}
      >
        <Braces className="h-3.5 w-3.5" />
        <span className="hidden whitespace-nowrap md:inline">Agent/MCP 上下文</span>
      </button>

      {open && snapshot && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-950/40 p-3"
          role="presentation"
          onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
            if (event.target === event.currentTarget) closeDialog()
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="copy-codex-context-title"
            className="flex max-h-[calc(100vh-1.5rem)] w-[min(44rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
            onKeyDown={handleDialogKeyDown}
          >
            <div className="flex items-start justify-between border-b border-gray-200 px-4 py-3 sm:px-5">
              <div>
                <h2 id="copy-codex-context-title" ref={headingRef} tabIndex={-1} className="text-base font-black text-gray-950">
                  复制 Agent/MCP 上下文
                </h2>
                <p className="mt-1 text-xs leading-5 text-gray-500">先确认显式选中的稳定引用，再创建不可变快照。</p>
              </div>
              <button type="button" aria-label="关闭 Agent/MCP 上下文" className="rounded-full p-2 text-gray-500 hover:bg-gray-100" onClick={closeDialog}>
                <X className="h-4 w-4" />
              </button>
            </div>

            <div data-context-pack-scroll className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-5">
              <PreviewSection snapshot={snapshot} />

              <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 pb-5">
                <button
                  type="button"
                  aria-label="创建并复制 CVC"
                  className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-gray-950 px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-gray-300"
                  disabled={!snapshot.request || creating || Boolean(created)}
                  onClick={() => void createPack()}
                >
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                  创建并复制 CVC
                </button>
                {snapshot.disabledReason && <span role="status" className="text-xs font-semibold text-amber-700">{snapshot.disabledReason}</span>}
              </div>

              {created && (
                <section aria-label="已创建的 CVC" className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <code data-testid="context-pack-code" className="min-w-0 flex-1 break-all text-xs font-bold text-gray-900">{created.cvcCode}</code>
                    {created.revokedAt === null && copyFailed(copyTarget) && (
                      <button type="button" aria-label="重试复制 CVC" className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-bold" onClick={() => void copyText(created.cvcCode, copyTarget)}>
                        <RotateCcw className="h-3.5 w-3.5" />重试复制 CVC
                      </button>
                    )}
                  </div>
                  {created.revokedAt !== null ? (
                    <p role="status" className="mt-2 text-xs font-semibold text-red-700">已撤销，不再是可用复制上下文。</p>
                  ) : copyFailed(copyTarget) ? (
                    <p role="alert" className="mt-2 text-xs font-semibold text-red-700">上下文已创建，但复制失败。代码已保留，可重试或手工复制。</p>
                  ) : isCopied(copyTarget) ? (
                    <p role="status" className="mt-2 text-xs font-semibold text-emerald-700">CVC 已创建并复制。</p>
                  ) : null}
                </section>
              )}

              <section aria-labelledby="context-pack-inspect-title" className="space-y-3">
                <div>
                  <h3 id="context-pack-inspect-title" className="text-sm font-black text-gray-950">检查已有 CVC</h3>
                  <p className="mt-1 text-xs leading-5 text-gray-500">按 CVC 本身读取 inspection；当前项目焦点不会参与解析。</p>
                </div>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                  <label className="sr-only" htmlFor="context-pack-inspection-code">检查 CVC</label>
                  <input
                    id="context-pack-inspection-code"
                    aria-label="检查 CVC"
                    value={inspectionCode}
                    onChange={event => changeInspectionCode(event.target.value)}
                    placeholder="CVC-…"
                    className="min-h-10 min-w-0 flex-1 rounded-xl border border-gray-300 px-3 font-mono text-sm uppercase outline-none focus:border-gray-900 focus:ring-2 focus:ring-gray-200"
                  />
                  <button type="button" aria-label="检查快照" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-gray-300 px-4 text-sm font-bold disabled:text-gray-400" disabled={inspecting} onClick={() => void inspectPack()}>
                    {inspecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}检查快照
                  </button>
                </div>
              </section>

              {error && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
              {inspected && (
                <InspectionView
                  inspection={inspected}
                  revoking={revoking}
                  onRevoke={() => void revokePack()}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const PreviewSection = ({ snapshot }: { snapshot: PreviewSnapshot }) => (
  <section aria-labelledby="context-pack-preview-title" className="space-y-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 id="context-pack-preview-title" className="text-sm font-black text-gray-950">将包含的节点</h3>
      <span className="text-xs font-semibold text-gray-500">{snapshot.preview.items.length} 个稳定引用</span>
    </div>
    {snapshot.request && (
      <p className="break-all text-[11px] font-semibold text-gray-500">
        {snapshot.request.projectCode} · 项目修订 {snapshot.request.projectRevision}
      </p>
    )}
    {snapshot.preview.items.length > 0 ? (
      <ul role="list" aria-label="将包含的节点" className="divide-y divide-gray-100 rounded-xl border border-gray-200">
        {snapshot.preview.items.map(item => (
          <li key={item.code} role="listitem" className="flex min-w-0 flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
            <span className="shrink-0 text-xs font-bold text-gray-500">{item.type}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">{item.title}</span>
            <code className="break-all text-[11px] font-semibold text-gray-500">{item.code}</code>
          </li>
        ))}
      </ul>
    ) : (
      <div className="rounded-xl border border-dashed border-gray-300 px-3 py-5 text-center text-sm text-gray-500">没有可预览的稳定引用。</div>
    )}
    {snapshot.preview.omittedCount > 0 && (
      <p role="status" className="text-xs font-semibold text-amber-700">{snapshot.preview.omittedCount} 个不支持的选择未包含；不会隐式添加其他画布内容。</p>
    )}
  </section>
)

const InspectionView = ({
  inspection,
  revoking,
  onRevoke
}: {
  inspection: ContextPackInspection
  revoking: boolean
  onRevoke: () => void
}) => {
  const revoked = inspection.revokedAt !== null
  return (
    <section aria-label="不可变快照检查" className="space-y-3 rounded-xl border border-gray-200 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-sm font-black text-gray-950">
            {revoked ? <Ban className="h-4 w-4 text-red-600" /> : <ShieldCheck className="h-4 w-4 text-emerald-600" />}
            不可变快照
          </div>
          <p className="mt-1 text-xs text-gray-500">{inspection.projectCode} · 项目修订 {inspection.projectRevision}</p>
        </div>
        <button
          type="button"
          aria-label="撤销此 CVC"
          disabled={revoked || revoking}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-red-200 px-3 text-xs font-bold text-red-700 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400"
          onClick={onRevoke}
        >
          {revoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : revoked ? <Check className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
          {revoked ? '已撤销' : '撤销此 CVC'}
        </button>
      </div>
      <p role="status" className={`text-xs font-semibold ${revoked ? 'text-red-700' : 'text-emerald-700'}`}>
        {revoked ? '已撤销，不再是可用复制上下文。' : '生命周期：有效。内容是创建时的不可变快照。'}
      </p>
      <ul role="list" aria-label="快照节点" className="divide-y divide-gray-100 rounded-lg bg-gray-50 px-3">
        {inspection.entries.map(entry => (
          <li key={entry.reference.code} role="listitem" className="flex min-w-0 flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-3">
            <span className="shrink-0 text-xs font-bold text-gray-500">{entry.reference.namespace === 'canvasTemplate' ? '文字' : '图片'}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">{entryTitle(entry.content)}</span>
            <code className="break-all text-[11px] text-gray-500">{entry.reference.code}</code>
          </li>
        ))}
      </ul>
      <div className="space-y-1 text-[11px] leading-5 text-gray-500">
        <p><span className="font-bold text-gray-700">CVC</span> <code className="break-all">{inspection.cvcCode}</code></p>
        <p><span className="font-bold text-gray-700">Snapshot digest</span> <code className="break-all">{inspection.snapshotDigest}</code></p>
        <p><span className="font-bold text-gray-700">来源引用</span> {inspection.sourceCodes.length > 0 ? inspection.sourceCodes.join(' · ') : '无'}</p>
      </div>
    </section>
  )
}

const disabledReason = (project: IPromptProject, preview: ContextPackSelectionPreview): string | null => {
  if (preview.selectedCount === 0) return '没有选择。请显式选择至少一个支持的文字或图片节点。'
  if (preview.items.length === 0) return '当前选择没有可用的 CVT/CVM。'
  if (!validatePublicReferenceCode(project.referenceCode, 'PRJ')) return '项目代码暂不可用，无法创建上下文。'
  if (!Number.isInteger(project.revision) || project.revision < 1) return '项目修订暂不可用，无法创建上下文。'
  return null
}

const entryTitle = (content: string): string => {
  try {
    const value = JSON.parse(content) as { title?: unknown }
    return typeof value.title === 'string' && value.title ? value.title : '未命名节点'
  } catch {
    return '未命名节点'
  }
}

const contextPackErrorMessage = (cause: unknown, fallback: string): string => {
  if (cause instanceof StorageRevisionConflict) return '项目修订已变化，请关闭后重新预览。'
  if (!(cause instanceof StorageHttpError)) return fallback
  if (cause.code === 'revision_conflict') return '项目修订已变化，请关闭后重新预览。'
  if (cause.code === 'context_revoked') return '此 CVC 已撤销。'
  if (cause.code === 'context_not_found') return '找不到此 CVC。'
  if (cause.code === 'invalid_storage_response') return 'Storage 返回了不受支持的上下文数据。'
  return fallback
}

export default CopyCodexContext
