import { describe, expect, it } from 'vitest'
import type { IPreset } from '@/models/Card.model'
import {
  createPromptMediaItem,
  formatMediaSize,
  getPresetMedia,
  getPresetMediaSearchText,
  withPresetMedia
} from './prompt-media'

const preset = (meta: Record<string, unknown>): IPreset => ({
  id: 'preset-1',
  type: 'custom',
  category: 'custom',
  label: 'Reference board',
  content: 'Use the attached reference.',
  usageCount: 0,
  meta
})

describe('prompt media metadata', () => {
  it('creates image and video media items from uploaded assets', () => {
    expect(createPromptMediaItem({
      id: 'image.png',
      filename: 'image.png',
      contentType: 'image/png',
      size: 1200
    })).toMatchObject({
      kind: 'image',
      source: 'asset',
      assetId: 'image.png'
    })

    expect(createPromptMediaItem({
      id: 'clip.mp4',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      size: 2048
    })).toMatchObject({
      kind: 'video',
      source: 'asset',
      assetId: 'clip.mp4'
    })

    expect(createPromptMediaItem({
      id: 'notes.txt',
      filename: 'notes.txt',
      contentType: 'text/plain',
      size: 12
    })).toBeNull()
  })

  it('reads valid media and ignores malformed metadata', () => {
    const meta = withPresetMedia({ source: 'test' }, [
      {
        id: 'media-image',
        kind: 'image',
        source: 'asset',
        assetId: 'image.png',
        filename: 'image.png'
      },
      {
        id: 'bad',
        kind: 'image',
        source: 'asset',
        assetId: ''
      }
    ])

    expect(getPresetMedia(preset(meta))).toEqual([
      {
        id: 'media-image',
        kind: 'image',
        source: 'asset',
        assetId: 'image.png',
        filename: 'image.png'
      }
    ])
  })

  it('keeps string reference codes but removes malformed reference codes without dropping media', () => {
    const media = getPresetMedia(preset({
      media: [
        {
          id: 'media-image',
          kind: 'image',
          source: 'asset',
          assetId: 'image.png',
          referenceCode: 'PLM-0001'
        },
        {
          id: 'media-video',
          kind: 'video',
          source: 'asset',
          assetId: 'clip.mp4',
          referenceCode: 42
        }
      ]
    }))

    expect(media).toEqual([
      expect.objectContaining({ assetId: 'image.png', referenceCode: 'PLM-0001' }),
      expect.not.objectContaining({ referenceCode: expect.anything() })
    ])
  })

  it('formats sizes and exposes media search text', () => {
    const media = createPromptMediaItem({
      id: 'clip.webm',
      filename: 'Hero Clip.webm',
      contentType: 'video/webm',
      size: 2 * 1024 * 1024
    })

    expect(formatMediaSize(512)).toBe('512 B')
    expect(formatMediaSize(1536)).toBe('1.5 KB')
    expect(formatMediaSize(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(getPresetMediaSearchText(preset(withPresetMedia({}, media ? [media] : [])))).toContain('Hero Clip.webm')
  })
})
