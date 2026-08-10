import { describe, expect, it, vi } from 'vitest'
import { extractBrowserImageDrop, resolveBrowserImageDrop } from './browser-image-drop'

const transfer = ({
  files = [],
  html = '',
  uri = ''
}: {
  files?: File[]
  html?: string
  uri?: string
}) => ({
  files: files as unknown as FileList,
  getData: (type: string) => type === 'text/html' ? html : type === 'text/uri-list' ? uri : ''
})

describe('browser image drop', () => {
  it('uses an image file supplied by the browser before URL metadata', () => {
    const file = new File(['pixels'], 'visible.png', { type: 'image/png' })

    expect(extractBrowserImageDrop(transfer({
      files: [file],
      html: '<a href="https://example.com/original"><img src="https://example.com/thumb.jpg"></a>'
    }))).toEqual({ files: [file], imageUrl: null })
  })

  it('extracts the visible img source instead of the enclosing original-image link', () => {
    expect(extractBrowserImageDrop(transfer({
      html: '<a href="https://example.com/original.png"><img src="https://cdn.example.com/thumb.webp?x=1&amp;y=2"></a>'
    }))).toEqual({
      files: [],
      imageUrl: 'https://cdn.example.com/thumb.webp?x=1&y=2'
    })
  })

  it('downloads an HTTP image through the local image downloader', async () => {
    const download = vi.fn().mockResolvedValue(new File(['pixels'], 'thumb.jpg', { type: 'image/jpeg' }))

    const result = await resolveBrowserImageDrop({ files: [], imageUrl: 'https://cdn.example.com/thumb.jpg' }, download)

    expect(result.files.map(file => file.name)).toEqual(['thumb.jpg'])
    expect(result.sourceUrl).toBe('https://cdn.example.com/thumb.jpg')
  })

  it('rejects browser-local blob URLs that the desktop app cannot read', async () => {
    await expect(resolveBrowserImageDrop({ files: [], imageUrl: 'blob:https://example.com/image-id' }, vi.fn()))
      .rejects.toThrow('blob:')
  })
})
