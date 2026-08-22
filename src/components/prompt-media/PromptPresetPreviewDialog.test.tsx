import { act, create } from 'react-test-renderer'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPreset } from '@/models/Card.model'
import { PromptPresetPreviewDialog } from './PromptPresetPreviewDialog'

const createPreset = (overrides: Partial<IPreset> = {}): IPreset => ({
  id: 'preset-preview-test',
  type: 'camera',
  category: 'camera',
  label: 'Preview preset',
  content: 'A prompt body with\nmultiple lines.',
  usageCount: 0,
  meta: {},
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('PromptPresetPreviewDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders an empty media state when the preset has no media', () => {
    const markup = renderToStaticMarkup(
      <PromptPresetPreviewDialog preset={createPreset()} onClose={() => undefined} />
    )

    expect(markup).toContain('媒体预览')
    expect(markup).toContain('暂无媒体')
    expect(markup).toContain('提示词')
    expect(markup).toContain('复制')
  })

  it('renders media previews when media items are present', () => {
    const markup = renderToStaticMarkup(
      <PromptPresetPreviewDialog
        preset={createPreset({
          meta: {
            media: [{
              id: 'media-asset-1',
              kind: 'image',
              source: 'asset',
              assetId: 'asset-1',
              title: 'Reference frame',
              size: 2048
            }]
          }
        })}
        onClose={() => undefined}
      />
    )

    expect(markup).toContain('Reference frame')
    expect(markup).toContain('2.0 KB')
    expect(markup).not.toContain('暂无媒体')
  })

  it('keeps the prompt content in the right-side prompt panel', () => {
    const markup = renderToStaticMarkup(
      <PromptPresetPreviewDialog preset={createPreset({ content: 'Copy me exactly.' })} onClose={() => undefined} />
    )

    expect(markup).toContain('Prompt content')
    expect(markup).toContain('Copy me exactly.')
  })

  it('copies the prompt code independently from prompt content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const renderer = create(
      <PromptPresetPreviewDialog
        preset={createPreset({ id: 'internal-preset-id', referenceCode: 'PLP-0001', content: 'Prompt content only.' })}
        onClose={() => undefined}
      />
    )
    const codeButton = renderer.root.findByProps({ 'aria-label': '复制 Prompt 编码' })

    await act(async () => {
      await codeButton.props.onClick()
    })

    expect(writeText).toHaveBeenCalledWith('PLP-0001')
    expect(writeText).not.toHaveBeenCalledWith('Prompt content only.')
    expect(writeText).not.toHaveBeenCalledWith('internal-preset-id')

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '复制 Prompt content' }).props.onClick()
    })
    expect(writeText).toHaveBeenLastCalledWith('Prompt content only.')
  })

  it('copies each media code and shows a retryable alert when clipboard access fails', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('clipboard denied'))
      .mockResolvedValueOnce(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const renderer = create(
      <PromptPresetPreviewDialog
        preset={createPreset({
          meta: {
            media: [{
              id: 'internal-media-id',
              kind: 'image',
              source: 'asset',
              assetId: 'internal-asset-id',
              referenceCode: 'PLM-0001',
              title: 'Reference frame'
            }]
          }
        })}
        onClose={() => undefined}
      />
    )
    const codeButton = renderer.root.findByProps({ 'aria-label': '复制媒体编码：Reference frame' })

    await act(async () => {
      await codeButton.props.onClick()
    })
    expect(writeText).toHaveBeenCalledWith('PLM-0001')
    expect(renderer.root.findByProps({ role: 'alert' }).findByType('span').children.join('')).toContain('复制媒体编码失败')

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '重试复制媒体编码：Reference frame' }).props.onClick()
    })
    expect(writeText).toHaveBeenLastCalledWith('PLM-0001')
    expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
  })
})
