import { Check, Copy, Image, PlaySquare, X } from 'lucide-react'
import type { IPreset } from '@/models/Card.model'
import { formatMediaSize, getPresetMedia } from '@/domain/prompt-media/prompt-media'
import { getPromptMediaReferenceCode, getPromptReferenceCode } from '@/domain/reference-codes/reference-code'
import { storage } from '@/utils/storage'
import { useClipboardCopyFeedback } from './useClipboardCopyFeedback'

export const PromptPresetPreviewDialog = ({
  preset,
  onClose
}: {
  preset: IPreset
  onClose: () => void
}) => {
  const media = getPresetMedia(preset)
  const promptReferenceCode = getPromptReferenceCode(preset.referenceCode)
  const mediaScope = media.map(item => `${item.id}:${getPromptMediaReferenceCode(item.referenceCode) || ''}`).join('|')
  const { copyText, copyFailed, isCopied } = useClipboardCopyFeedback(`prompt-dialog:${preset.id}:${promptReferenceCode || ''}:${mediaScope}`)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/45 px-4 py-6" onClick={onClose}>
      <div
        className="grid grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[8px] bg-white shadow-2xl"
        style={{
          width: 'min(1040px, calc(100vw - 32px))',
          height: 'min(720px, calc(100vh - 48px))'
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 border-b border-gray-100 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-bold uppercase tracking-wide text-gray-400">{preset.category || preset.type}</div>
              <h3 className="mt-1 break-words text-xl font-black text-gray-950">{preset.label}</h3>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-full bg-gray-100 p-2 text-gray-500 transition hover:bg-gray-200 hover:text-gray-950"
              onClick={onClose}
              aria-label="关闭预览"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid min-h-0 md:grid-cols-[minmax(0,1fr)_380px]">
          <section className="flex min-h-[260px] min-w-0 flex-col border-b border-gray-100 bg-gray-50 md:border-b-0 md:border-r">
            <div className="shrink-0 px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-black text-gray-950">
                <Image className="h-4 w-4 text-gray-500" />
                媒体预览
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
              {media.length === 0 ? (
                <div className="flex h-full min-h-[260px] items-center justify-center rounded-[8px] border border-dashed border-gray-200 bg-white text-sm font-semibold text-gray-400">
                  暂无媒体
                </div>
              ) : (
                <div className="space-y-4">
                  {media.map(item => {
                    const referenceCode = getPromptMediaReferenceCode(item.referenceCode)
                    const target = `media:${item.id}`
                    return (
                    <figure key={item.id} className="overflow-hidden rounded-[8px] border border-gray-200 bg-white shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 text-sm">
                        <div className="flex min-w-0 items-center gap-2 font-semibold text-gray-800">
                          {item.kind === 'image' ? <Image className="h-4 w-4 text-gray-500" /> : <PlaySquare className="h-4 w-4 text-gray-500" />}
                          <span className="truncate">{item.title || item.filename || item.assetId}</span>
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                          {referenceCode ? (
                            <>
                              <code className="max-w-full break-all rounded bg-gray-100 px-2 py-1 text-xs text-gray-600">{referenceCode}</code>
                              <button
                                type="button"
                                className="shrink-0 whitespace-nowrap rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700 transition hover:bg-gray-200"
                                aria-label={`复制媒体编码：${item.title || item.filename || item.assetId}`}
                                title="复制媒体编码"
                                onClick={() => void copyText(referenceCode, target)}
                              >
                                {isCopied(target) ? '媒体编码已复制' : '复制媒体编码'}
                              </button>
                            </>
                          ) : (
                            <span className="text-xs text-gray-400" title="该媒体没有可复制的媒体编码">媒体编码不可用</span>
                          )}
                          {formatMediaSize(item.size) && <span className="shrink-0 text-xs text-gray-400">{formatMediaSize(item.size)}</span>}
                        </div>
                      </div>
                      {copyFailed(target) && referenceCode && (
                        <div role="alert" className="flex items-center justify-between gap-3 border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
                          <span>复制媒体编码失败，请重试。</span>
                          <button
                            type="button"
                            className="rounded-full bg-white px-3 py-1 font-semibold text-red-700"
                            aria-label={`重试复制媒体编码：${item.title || item.filename || item.assetId}`}
                            onClick={() => void copyText(referenceCode, target)}
                          >
                            重试
                          </button>
                        </div>
                      )}
                      {item.kind === 'image' ? (
                        <img
                          src={storage.assets.url(item.assetId)}
                          alt={item.title || item.filename || preset.label}
                          className="max-h-[48vh] w-full bg-gray-950 object-contain"
                        />
                      ) : (
                        <video
                          src={storage.assets.url(item.assetId)}
                          controls
                          className="max-h-[48vh] w-full bg-gray-950"
                        />
                      )}
                    </figure>
                    )
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="flex min-h-0 min-w-0 flex-col bg-white">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
              <div>
                <h4 className="text-sm font-black text-gray-950">提示词</h4>
                <p className="mt-1 text-xs font-semibold text-gray-400">Prompt content</p>
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-full bg-gray-950 px-4 py-2 text-xs font-black text-white transition hover:bg-gray-800"
                aria-label="复制 Prompt content"
                onClick={() => void copyText(preset.content, 'content')}
              >
                {isCopied('content') ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {isCopied('content') ? '已复制' : '复制'}
              </button>
              {promptReferenceCode ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <code className="max-w-full break-all rounded bg-gray-100 px-2 py-1 text-xs text-gray-600">{promptReferenceCode}</code>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-gray-100 px-4 py-2 text-xs font-black text-gray-700 transition hover:bg-gray-200"
                    aria-label="复制 Prompt 编码"
                    title="复制 Prompt 编码"
                    onClick={() => void copyText(promptReferenceCode, 'prompt-code')}
                  >
                    {isCopied('prompt-code') ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {isCopied('prompt-code') ? 'Prompt 编码已复制' : '复制 Prompt 编码'}
                  </button>
                </div>
              ) : (
                <span className="text-xs text-gray-400" title="该 Prompt 没有可复制的 Prompt 编码">Prompt 编码不可用</span>
              )}
            </div>
            {copyFailed('prompt-code') && promptReferenceCode && (
              <div role="alert" className="flex items-center justify-between gap-3 border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-700">
                <span>复制 Prompt 编码失败，请重试。</span>
                <button
                  type="button"
                  className="rounded-full bg-white px-3 py-1 font-semibold text-red-700"
                  aria-label="重试复制 Prompt 编码"
                  onClick={() => void copyText(promptReferenceCode, 'prompt-code')}
                >
                  重试
                </button>
              </div>
            )}
            {copyFailed('content') && (
              <div role="alert" className="flex items-center justify-between gap-3 border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-700">
                <span>复制 Prompt content 失败，请重试。</span>
                <button
                  type="button"
                  className="rounded-full bg-white px-3 py-1 font-semibold text-red-700"
                  aria-label="重试复制 Prompt content"
                  onClick={() => void copyText(preset.content, 'content')}
                >
                  重试
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden p-5">
              <div className="h-full overflow-y-auto whitespace-pre-wrap rounded-[8px] bg-gray-50 p-4 text-sm leading-7 text-gray-800">
                {preset.content}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
