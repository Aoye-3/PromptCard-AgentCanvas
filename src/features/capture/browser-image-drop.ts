import { isSupportedImageFile } from '@/components/canvas/canvas-image-assets'

interface BrowserImageDataTransfer {
  files: FileList
  getData: (type: string) => string
}

export interface BrowserImageDrop {
  files: File[]
  imageUrl: string | null
}

export interface ResolvedBrowserImageDrop {
  files: File[]
  sourceUrl: string | null
}

type RemoteImageDownloader = (url: string) => Promise<File>

export const extractBrowserImageDrop = (dataTransfer: BrowserImageDataTransfer): BrowserImageDrop => {
  const files = Array.from(dataTransfer.files || []).filter(isSupportedImageFile)
  if (files.length > 0) return { files, imageUrl: null }

  const htmlImageUrl = imageSourceFromHtml(dataTransfer.getData('text/html'))
  if (htmlImageUrl) return { files: [], imageUrl: htmlImageUrl }

  const uri = firstTransferUri(dataTransfer.getData('text/uri-list'))
    || firstTransferUri(dataTransfer.getData('text/plain'))
  return { files: [], imageUrl: uri }
}

export const resolveBrowserImageDrop = async (
  drop: BrowserImageDrop,
  download: RemoteImageDownloader = downloadRemoteImageFile
): Promise<ResolvedBrowserImageDrop> => {
  if (drop.files.length > 0) return { files: drop.files, sourceUrl: null }
  if (!drop.imageUrl) throw new Error('拖入内容中没有可用图片。')

  if (drop.imageUrl.startsWith('blob:')) {
    throw new Error('无法读取浏览器内部的 blob: 图片，请复制图片后粘贴，或先下载到本地。')
  }
  if (drop.imageUrl.startsWith('data:')) {
    return { files: [await dataUrlImageFile(drop.imageUrl)], sourceUrl: null }
  }
  if (!/^https?:\/\//i.test(drop.imageUrl)) {
    throw new Error('仅支持从浏览器拖入 HTTP、HTTPS 或图片文件。')
  }

  return { files: [await download(drop.imageUrl)], sourceUrl: drop.imageUrl }
}

export const downloadRemoteImageFile = async (url: string): Promise<File> => {
  let response: Response
  try {
    response = await fetch('/storage-api/remote-images/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'image/png,image/jpeg,image/webp' },
      body: JSON.stringify({ url })
    })
  } catch {
    throw new Error('Storage Service 不可用，无法下载拖入的浏览器图片。')
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: { message?: string } } | null
    throw new Error(payload?.detail?.message || `浏览器图片下载失败（${response.status}）。`)
  }

  const blob = await response.blob()
  if (!supportedContentType(blob.type)) throw new Error('拖入地址返回的不是 PNG、JPEG 或 WebP 图片。')
  const filename = response.headers.get('x-file-name') || `browser-image-${Date.now()}.${extensionFor(blob.type)}`
  return new File([blob], filename, { type: blob.type })
}

const imageSourceFromHtml = (html: string): string | null => {
  const match = /<img\b[^>]*?\s+src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html)
  const value = match?.[1] || match?.[2] || match?.[3]
  return value ? decodeHtmlAttribute(value.trim()) : null
}

const decodeHtmlAttribute = (value: string): string => value
  .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
  .replace(/&#([0-9]+);/g, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&amp;/gi, '&')

const firstTransferUri = (value: string): string | null => value
  .split(/\r?\n/)
  .map(line => line.trim())
  .find(line => line.length > 0 && !line.startsWith('#')) || null

const dataUrlImageFile = async (url: string): Promise<File> => {
  const response = await fetch(url)
  const blob = await response.blob()
  if (!supportedContentType(blob.type)) throw new Error('拖入的 data: 内容不是 PNG、JPEG 或 WebP 图片。')
  return new File([blob], `browser-image-${Date.now()}.${extensionFor(blob.type)}`, { type: blob.type })
}

const supportedContentType = (value: string): value is 'image/png' | 'image/jpeg' | 'image/webp' =>
  value === 'image/png' || value === 'image/jpeg' || value === 'image/webp'

const extensionFor = (contentType: string): string => contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1]
