import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import type { IPreset } from '@/models/Card.model'
import { PromptPreviewCard } from './PromptLibrary'

const preset: IPreset = {
  id: 'internal-preset-id',
  referenceCode: 'PLP-0001',
  type: 'custom',
  category: 'custom',
  label: 'Reference prompt',
  content: 'Prompt content only.',
  usageCount: 0,
  meta: {}
}

describe('PromptLibrary prompt preview card', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined } })
    vi.stubGlobal('document', { documentElement: {} })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('copies the Prompt code without opening preview or copying content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const onPreview = vi.fn()
    const stopPropagation = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const renderer = create(
      <I18nProvider>
        <PromptPreviewCard preset={preset} onPreview={onPreview} />
      </I18nProvider>
    )

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '复制 Prompt 编码' }).props.onClick({ stopPropagation })
    })

    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(onPreview).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('PLP-0001')
    expect(writeText).not.toHaveBeenCalledWith(preset.id)
    expect(writeText).not.toHaveBeenCalledWith(preset.content)
  })

  it('does not expose a code copy action when no external Prompt code exists', () => {
    const renderer = create(
      <I18nProvider>
        <PromptPreviewCard preset={{ ...preset, referenceCode: undefined }} onPreview={() => undefined} />
      </I18nProvider>
    )

    expect(renderer.root.findAllByProps({ 'aria-label': '复制 Prompt 编码' })).toHaveLength(0)
    expect(renderer.root.findByProps({ title: '该 Prompt 没有可复制的 Prompt 编码' })).toBeTruthy()
  })
})
