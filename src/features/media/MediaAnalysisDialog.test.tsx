import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaAnalysisDialog } from './MediaAnalysisDialog'
import { recentCaptureFixtures } from './media-fixtures'

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  analyzeMedia: vi.fn(),
  registerToPromptLibrary: vi.fn()
}))

vi.mock('@/services/agent-runtime-service', () => ({
  agentRuntimeService: {
    bootstrap: mocks.bootstrap,
    analyzeMedia: mocks.analyzeMedia
  }
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    cardTypeLabel: (type: string) => type
  })
}))

vi.mock('@/storage/storage-service-client', () => ({
  storageServiceClient: {
    assets: {
      url: () => '/assets/asset-selected'
    },
    recentCaptures: {
      registerToPromptLibrary: mocks.registerToPromptLibrary
    }
  }
}))

const renderDialog = () => {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      <MediaAnalysisDialog capture={recentCaptureFixtures[0]} onClose={vi.fn()} />
    )
  })
  return renderer
}

const previewResponse = {
  threadId: 'media-thread-1',
  text: '已生成预览。',
  proposals: [{
    kind: 'media_prompt_preview',
    previewDraft: {
      label: '电影肖像',
      type: 'style',
      category: 'portrait',
      content: '电影感人物肖像，cinematic lighting',
      rationale: '根据当前图片生成。'
    },
    rationale: '根据当前图片生成。'
  }]
}

describe('MediaAnalysisDialog interactions', () => {
  beforeEach(() => {
    mocks.bootstrap.mockReset().mockResolvedValue(undefined)
    mocks.analyzeMedia.mockReset().mockResolvedValue(previewResponse)
    mocks.registerToPromptLibrary.mockReset().mockResolvedValue(undefined)
  })

  it('sends the selected Prompt language tendency with preview requests', async () => {
    const renderer = renderDialog()

    act(() => renderer.root.findByProps({ 'aria-label': 'Use English Prompt' }).props.onClick())
    const generate = renderer.root.findAllByType('button').find(button => button.children.includes('生成预览'))
    await act(async () => {
      await generate?.props.onClick()
    })

    expect(mocks.analyzeMedia).toHaveBeenCalledWith(expect.objectContaining({
      promptLanguageMode: 'en'
    }))
  })

  it('registers the Prompt under the large library category selected by the user', async () => {
    const renderer = renderDialog()
    const generate = renderer.root.findAllByType('button').find(button => button.children.includes('生成预览'))
    await act(async () => {
      await generate?.props.onClick()
    })

    const typeSelect = renderer.root.findByProps({ 'aria-label': 'Prompt 库大类' })
    expect(typeSelect.type).toBe('select')
    expect(typeSelect.findAllByType('option').map(option => option.props.value)).toEqual([
      'subject', 'action', 'scene', 'style', 'camera',
      'lighting', 'timing', 'audio', 'constraint', 'custom'
    ])
    act(() => typeSelect.props.onChange({ target: { value: 'camera' } }))
    const register = renderer.root.findAllByType('button').find(button => button.children.includes('写入 Prompt 库'))
    await act(async () => {
      await register?.props.onClick()
    })

    expect(mocks.registerToPromptLibrary).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'analysis-derived',
      captures: [expect.objectContaining({ type: 'camera', category: 'portrait' })]
    }))
  })
})
