import { Bot, Check, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  storageServiceClient,
  type BridgeDelivery,
  type BridgeDocumentDelivery,
  type BridgePromptDelivery,
  type BridgeStoryboardDelivery
} from '@/storage/storage-service-client'


type BridgeDeliveryClient = Pick<typeof storageServiceClient.bridgeDeliveries, 'list' | 'decide'>
const isPromptDelivery = (delivery: BridgeDelivery): delivery is BridgePromptDelivery => (
  delivery.request.kind === 'prompt.create'
)
const isDocumentDelivery = (delivery: BridgeDelivery): delivery is BridgeDocumentDelivery => (
  delivery.request.kind === 'document.create' || delivery.request.kind === 'document.change'
)
const isStoryboardDelivery = (delivery: BridgeDelivery): delivery is BridgeStoryboardDelivery => (
  delivery.request.kind === 'storyboard.create' || delivery.request.kind === 'storyboard.change'
)
const deliveryLabel = (delivery: BridgeDelivery): string => {
  if (isPromptDelivery(delivery)) return 'Prompt'
  if (isDocumentDelivery(delivery)) return '文档'
  if (isStoryboardDelivery(delivery)) return '分镜'
  return '图片'
}
const deliveryTitle = (delivery: BridgeDelivery): string => {
  if (delivery.visualProposal.kind === 'document_changes') return `修改文档 ${delivery.visualProposal.documentCode}`
  if (delivery.visualProposal.kind === 'document_create') return delivery.visualProposal.title
  if (delivery.visualProposal.kind === 'storyboard_changes') return `修改分镜 ${delivery.visualProposal.storyboardCode}`
  if (delivery.visualProposal.kind === 'storyboard_create') return delivery.visualProposal.title
  return delivery.visualProposal.title
}
const deliveryKindLabel = (delivery: BridgeDelivery): string => {
  if (delivery.request.kind === 'prompt.create') return 'Prompt 创建'
  if (delivery.request.kind === 'image.place') return '图片放置'
  if (delivery.request.kind === 'document.create') return 'Document 创建'
  if (delivery.request.kind === 'document.change') return 'Document 修改'
  return delivery.request.kind === 'storyboard.create' ? 'Storyboard 创建' : 'Storyboard 修改'
}

interface BridgeDeliveryInboxProps {
  cvcCode: string | null
  client?: BridgeDeliveryClient
  onAccept: (delivery: BridgeDelivery) => Promise<string[]>
}

export const BridgeDeliveryInbox = ({
  cvcCode,
  client = storageServiceClient.bridgeDeliveries,
  onAccept
}: BridgeDeliveryInboxProps) => {
  const [deliveries, setDeliveries] = useState<BridgeDelivery[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!cvcCode) {
      setDeliveries([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      setDeliveries(await client.list(cvcCode, 'pending_review'))
    } catch {
      setError('无法读取外部 Agent 提案，请检查 Storage 服务。')
    } finally {
      setLoading(false)
    }
  }, [client, cvcCode])

  useEffect(() => {
    void refresh()
    const interval = globalThis.setInterval(() => void refresh(), 4_000)
    return () => globalThis.clearInterval(interval)
  }, [refresh])

  const decide = async (delivery: BridgeDelivery, decision: 'accepted' | 'rejected') => {
    if (busyId) return
    setBusyId(delivery.proposalId)
    setError(null)
    try {
      const resultCodes = decision === 'accepted' ? await onAccept(delivery) : []
      if (decision === 'accepted' && resultCodes.length === 0) {
        setError('提案尚未可靠保存，仍保留在待审阅队列。')
        return
      }
      await client.decide(cvcCode!, delivery.proposalId, decision, resultCodes)
      setDeliveries(current => current.filter(item => item.proposalId !== delivery.proposalId))
    } catch {
      setError(decision === 'accepted'
        ? '提案保存或确认失败；可重试，系统不会重复创建。'
        : '拒绝提案失败，请重试。')
    } finally {
      setBusyId(null)
    }
  }

  if (!cvcCode) return null
  return (
    <section className="border-b border-gray-200 bg-sky-50/60 p-3" data-bridge-delivery-inbox>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="h-4 w-4 shrink-0 text-sky-700" />
          <div className="min-w-0">
            <h3 className="text-xs font-black text-gray-900">外部 Agent 待审阅</h3>
            <p className="truncate text-[10px] font-semibold text-gray-500" title={cvcCode}>{cvcCode}</p>
          </div>
        </div>
        <button
          type="button"
          aria-label="刷新外部 Agent 提案"
          className="rounded-md p-1.5 text-gray-500 hover:bg-white hover:text-gray-900 disabled:opacity-50"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-xs font-semibold text-rose-700">{error}</p>}
      {!loading && deliveries.length === 0 && !error && (
        <p className="mt-2 text-xs text-gray-500">当前没有待审阅提案。</p>
      )}
      <div className="mt-2 space-y-2">
        {deliveries.map(delivery => (
          <article key={delivery.proposalId} className="rounded-lg border border-sky-200 bg-white p-3 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <strong className="block truncate text-xs text-gray-950" data-bridge-delivery-title>
                  {deliveryTitle(delivery)}
                </strong>
                <span className="text-[10px] font-semibold text-sky-700">
                  {delivery.visualProposal.agentName} · {deliveryKindLabel(delivery)}
                </span>
              </div>
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">待确认</span>
            </div>
            {isPromptDelivery(delivery) ? (
              <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs leading-5 text-gray-700">
                {delivery.visualProposal.userText}
              </p>
            ) : isDocumentDelivery(delivery) ? (
              <div className="mt-2 rounded-md bg-gray-50 p-2 text-[10px] leading-4 text-gray-600">
                {delivery.request.kind === 'document.create'
                  ? <p>{delivery.request.payload.blocks.length} 个结构化内容块</p>
                  : <p>{delivery.request.payload.operations.length} 项红删绿增修改 · 基于 revision {delivery.request.target.baseRevision}</p>}
              </div>
            ) : isStoryboardDelivery(delivery) ? (
              <div className="mt-2 rounded-md bg-gray-50 p-2 text-[10px] leading-4 text-gray-600">
                {delivery.request.kind === 'storyboard.create'
                  ? <p>{delivery.request.payload.sequence.rows.length} 个镜头 · 来源 {delivery.request.payload.sourceDocumentCode}</p>
                  : <p>{delivery.request.payload.changes.length} 项分镜字段修改 · 基于 revision {delivery.request.target.baseRevision}</p>}
              </div>
            ) : (
              <div className="mt-2 grid grid-cols-[88px_1fr] gap-2">
                <img
                  src={storageServiceClient.assets.url(delivery.visualProposal.assetId)}
                  alt={delivery.visualProposal.altText}
                  className="h-16 w-[88px] rounded-md border border-gray-200 object-cover"
                />
                <div className="min-w-0 text-[10px] leading-4 text-gray-500">
                  <p>{delivery.visualProposal.width} × {delivery.visualProposal.height}</p>
                  {delivery.visualProposal.altText && <p className="line-clamp-2">{delivery.visualProposal.altText}</p>}
                  {delivery.request.target.storyboardCode && (
                    <p className="truncate" title={delivery.request.target.storyboardCode}>
                      镜头 {delivery.request.target.shotOrdinal! + 1} · {delivery.request.target.storyboardCode}
                    </p>
                  )}
                </div>
              </div>
            )}
            <p className="mt-2 text-[10px] leading-4 text-gray-500">{delivery.visualProposal.rationale}</p>
            <p
              className="mt-1 break-all text-[10px] leading-4 text-gray-400"
              data-bridge-delivery-provenance
            >
              来源 {delivery.request.sourceCodes.length > 0 ? delivery.request.sourceCodes.join(', ') : '无'}
              {' · '}Skill {delivery.request.skillPins.length > 0
                ? delivery.request.skillPins.map(pin => `${pin.skillCode}@${pin.revision}`).join(', ')
                : '无'}
              {' · '}{delivery.request.clientRequestId}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                aria-label={`拒绝外部 Agent ${deliveryLabel(delivery)} 提案`}
                disabled={busyId !== null}
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-bold text-gray-600 disabled:opacity-50"
                onClick={() => void decide(delivery, 'rejected')}
              >
                <X className="h-3 w-3" />拒绝
              </button>
              <button
                type="button"
                aria-label={`接受外部 Agent ${deliveryLabel(delivery)} 提案`}
                disabled={busyId !== null}
                className="inline-flex items-center gap-1 rounded-md bg-gray-950 px-2 py-1 text-xs font-bold text-white disabled:opacity-50"
                onClick={() => void decide(delivery, 'accepted')}
              >
                <Check className="h-3 w-3" />接受并保存
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
