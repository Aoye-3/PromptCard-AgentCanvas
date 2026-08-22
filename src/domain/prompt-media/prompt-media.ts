import type { IPreset } from '@/models/Card.model'
import { getPromptMediaReferenceCode } from '@/domain/reference-codes/reference-code'

export type PromptPresetMediaKind = 'image' | 'video'

export interface PromptPresetMediaItem {
  id: string
  referenceCode?: string
  kind: PromptPresetMediaKind
  source: 'asset'
  assetId: string
  filename?: string
  contentType?: string
  size?: number
  title?: string
}

export const PROMPT_MEDIA_META_KEY = 'media'

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const VIDEO_CONTENT_TYPES = new Set(['video/mp4', 'video/webm'])

export const isPromptMediaContentType = (contentType: string): boolean =>
  IMAGE_CONTENT_TYPES.has(contentType) || VIDEO_CONTENT_TYPES.has(contentType)

export const getMediaKindForContentType = (contentType: string): PromptPresetMediaKind | null => {
  if (IMAGE_CONTENT_TYPES.has(contentType)) return 'image'
  if (VIDEO_CONTENT_TYPES.has(contentType)) return 'video'
  return null
}

export const createPromptMediaItem = (asset: {
  id: string
  filename: string
  contentType: string
  size: number
}): PromptPresetMediaItem | null => {
  const kind = getMediaKindForContentType(asset.contentType)
  if (!kind) return null
  return {
    id: `media-${asset.id}`,
    kind,
    source: 'asset',
    assetId: asset.id,
    filename: asset.filename,
    contentType: asset.contentType,
    size: asset.size,
    title: asset.filename
  }
}

export const getPresetMedia = (presetOrMeta: Pick<IPreset, 'meta'> | Record<string, unknown> | null | undefined): PromptPresetMediaItem[] => {
  const meta = presetOrMeta && 'meta' in presetOrMeta
    ? presetOrMeta.meta
    : presetOrMeta
  const media = meta && typeof meta === 'object'
    ? (meta as Record<string, unknown>)[PROMPT_MEDIA_META_KEY]
    : null

  if (!Array.isArray(media)) return []

  return media.flatMap(normalizePromptPresetMediaItem)
}

export const withPresetMedia = (
  meta: Record<string, unknown> | null | undefined,
  media: PromptPresetMediaItem[]
): Record<string, unknown> => ({
  ...(meta || {}),
  [PROMPT_MEDIA_META_KEY]: media
})

export const getPresetMediaSearchText = (preset: IPreset): string =>
  getPresetMedia(preset)
    .map(item => [item.kind, item.filename, item.title, item.contentType].filter(Boolean).join(' '))
    .join(' ')

export const formatMediaSize = (size?: number): string => {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const isPromptPresetMediaItem = (value: unknown): value is PromptPresetMediaItem => {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PromptPresetMediaItem>
  return (
    (item.kind === 'image' || item.kind === 'video') &&
    item.source === 'asset' &&
    typeof item.assetId === 'string' &&
    item.assetId.length > 0
  )
}

const normalizePromptPresetMediaItem = (value: unknown): PromptPresetMediaItem[] => {
  if (!isPromptPresetMediaItem(value)) return []
  const item = { ...value }
  const referenceCode = getPromptMediaReferenceCode(item.referenceCode)
  if (referenceCode) item.referenceCode = referenceCode
  else delete item.referenceCode
  return [item]
}
