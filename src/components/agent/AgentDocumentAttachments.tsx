import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { FileText, Loader2, Paperclip, X } from 'lucide-react'
import type { AgentDocumentAttachment, DocumentContentType } from '@/models/Agent.model'
import { storageServiceClient } from '@/storage/storage-service-client'

const MAX_ATTACHMENTS = 5
const MAX_TOTAL_BYTES = 100 * 1024 * 1024

const documentFormats: Record<string, { contentType: DocumentContentType; maxBytes: number }> = {
  '.txt': { contentType: 'text/plain', maxBytes: 5 * 1024 * 1024 },
  '.md': { contentType: 'text/markdown', maxBytes: 5 * 1024 * 1024 },
  '.pdf': { contentType: 'application/pdf', maxBytes: 50 * 1024 * 1024 },
  '.docx': {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    maxBytes: 20 * 1024 * 1024
  }
}

interface AgentDocumentAttachmentsProps {
  projectId: string
  attachments: AgentDocumentAttachment[]
  disabled?: boolean
  resetKey?: string | number
  onChange: (attachments: AgentDocumentAttachment[]) => void
  onUploadingChange?: (uploadingCount: number) => void
}

interface ActiveUploadBatch {
  identity: string
  controller: AbortController
}

export function AgentDocumentAttachments({
  projectId,
  attachments,
  disabled = false,
  resetKey,
  onChange,
  onUploadingChange
}: AgentDocumentAttachmentsProps) {
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number }>()
  const [error, setError] = useState<string>()
  const activeBatchRef = useRef<ActiveUploadBatch>()
  const identity = `${projectId}:${String(resetKey ?? '')}`
  const latestIdentityRef = useRef(identity)
  latestIdentityRef.current = identity

  useEffect(() => {
    setError(undefined)
    const activeBatch = activeBatchRef.current
    if (activeBatch && activeBatch.identity !== identity) {
      activeBatch.controller.abort('document-upload-identity-changed')
      activeBatchRef.current = undefined
      setUploadProgress(undefined)
      onUploadingChange?.(0)
    }
    return () => {
      const currentBatch = activeBatchRef.current
      if (currentBatch?.identity === identity) {
        currentBatch.controller.abort('document-upload-identity-changed')
        activeBatchRef.current = undefined
        setUploadProgress(undefined)
        onUploadingChange?.(0)
      }
    }
  }, [identity, onUploadingChange])

  const uploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    if (!files.length || disabled || activeBatchRef.current) return
    const validationError = validateFiles(attachments, files)
    if (validationError) {
      setError(validationError)
      return
    }

    setError(undefined)
    const batch: ActiveUploadBatch = { identity, controller: new AbortController() }
    activeBatchRef.current = batch
    setUploadProgress({ completed: 0, total: files.length })
    onUploadingChange?.(files.length)
    const uploaded: AgentDocumentAttachment[] = []
    const failures: string[] = []
    const isCurrentBatch = () => (
      activeBatchRef.current === batch
      && latestIdentityRef.current === batch.identity
      && !batch.controller.signal.aborted
    )
    try {
      for (const [index, file] of files.entries()) {
        if (!isCurrentBatch()) return
        try {
          const resource = await storageServiceClient.projectDocumentResources.upload(
            projectId,
            file,
            batch.controller.signal
          )
          if (!isCurrentBatch()) return
          uploaded.push({
            resourceId: resource.id,
            name: resource.originalFilename,
            contentType: resource.contentType,
            size: resource.size,
            sha256: resource.sha256
          })
          onChange(mergeDocumentAttachments(attachments, uploaded))
        } catch (uploadError) {
          if (!isCurrentBatch()) return
          failures.push(`${file.name}: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`)
        }
        if (isCurrentBatch()) setUploadProgress({ completed: index + 1, total: files.length })
      }
    } finally {
      if (activeBatchRef.current === batch) {
        activeBatchRef.current = undefined
        setUploadProgress(undefined)
        onUploadingChange?.(0)
        if (failures.length) setError(`部分文档上传失败：${failures.join('；')}`)
      }
    }
  }

  const handleInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files
    event.currentTarget.value = ''
    if (files) await uploadFiles(files)
  }

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    await uploadFiles(event.dataTransfer.files)
  }

  return (
    <div className="mb-2" aria-label="项目文档附件">
      <div
        data-agent-document-dropzone
        aria-busy={uploadProgress !== undefined}
        aria-disabled={disabled || uploadProgress !== undefined}
        className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] px-2 py-1.5"
        onDragOver={event => event.preventDefault()}
        onDrop={handleDrop}
      >
        <label className={`inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-bold ${disabled || uploadProgress ? 'cursor-not-allowed text-[#b1afa7]' : 'cursor-pointer text-[#4d4c48] hover:bg-white'}`}>
          <Paperclip className="h-3 w-3" aria-hidden="true" />
          添加文档
          <input
            type="file"
            className="sr-only"
            aria-label="添加项目文档"
            accept=".txt,.md,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            multiple
            disabled={disabled || uploadProgress !== undefined}
            onChange={handleInput}
          />
        </label>
        {attachments.map(attachment => (
          <span
            key={attachment.resourceId}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-[#e5e7eb] bg-white px-1.5 py-1 text-[10px] font-semibold text-[#4d4c48]"
          >
            <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="max-w-40 truncate" title={attachment.name}>{attachment.name}</span>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-[#f3f4f6]"
              aria-label={`移除文档 ${attachment.name}`}
              disabled={disabled || uploadProgress !== undefined}
              onClick={() => onChange(attachments.filter(item => item.resourceId !== attachment.resourceId))}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        {uploadProgress ? (
          <span role="status" className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#87867f]">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            正在保存 {uploadProgress.completed}/{uploadProgress.total} 个文档
          </span>
        ) : attachments.length === 0 ? (
          <span className="text-[10px] text-[#87867f]">拖入 TXT、MD、PDF 或 DOCX</span>
        ) : null}
      </div>
      {error ? <p role="alert" className="mt-1 text-[10px] font-semibold text-red-600">{error}</p> : null}
    </div>
  )
}

function validateFiles(attachments: AgentDocumentAttachment[], files: File[]): string | undefined {
  if (attachments.length + files.length > MAX_ATTACHMENTS) {
    return '每条消息最多添加 5 个文档。'
  }
  for (const file of files) {
    const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || ''
    const format = documentFormats[extension]
    if (!format || (file.type && file.type.toLowerCase() !== format.contentType)) {
      return '仅支持 TXT、Markdown、PDF 和 DOCX 文档。'
    }
    if (file.size > format.maxBytes) {
      return `${file.name} 超过该格式的大小限制。`
    }
  }
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
    + files.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > MAX_TOTAL_BYTES) return '每条消息的文档总大小不能超过 100 MiB。'
  return undefined
}

function mergeDocumentAttachments(
  current: AgentDocumentAttachment[],
  incoming: AgentDocumentAttachment[]
): AgentDocumentAttachment[] {
  const byResourceId = new Map(current.map(attachment => [attachment.resourceId, attachment]))
  incoming.forEach(attachment => byResourceId.set(attachment.resourceId, attachment))
  return [...byResourceId.values()].sort((left, right) => left.resourceId.localeCompare(right.resourceId))
}
