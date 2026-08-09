import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ImageGenerationComposer } from './ImageGenerationComposer'
import type { ImageGenerationComposerProps } from './types'
import type { PromptDocument } from '@/models/PromptHistory.model'

const createProps = (): ImageGenerationComposerProps => ({
  prompt: '生成一张产品图',
  onPromptChange: vi.fn(),
  promptDocument: { version: 1, segments: [{ type: 'text', text: '生成一张产品图' }] },
  onPromptDocumentChange: vi.fn(),
  workflows: [
    { value: 'text-to-image', label: '文生图' },
    { value: 'reference-generate', label: '参考图生成' },
    { value: 'smart-edit', label: '智能改图' },
    { value: 'region-edit', label: '局部修改' }
  ],
  workflow: 'text-to-image',
  onWorkflowChange: vi.fn(),
  models: [{ value: 'seedream', label: 'Seedream 5.0 Pro' }],
  modelId: 'seedream',
  onModelChange: vi.fn(),
  resolutions: ['1K', '2K'],
  resolution: '1K',
  onResolutionChange: vi.fn(),
  aspectRatios: ['1:1', '16:9', 'custom'],
  aspectRatio: '1:1',
  onAspectRatioChange: vi.fn(),
  promptOptimizationModes: ['standard', 'fast'],
  promptOptimization: 'standard',
  onPromptOptimizationChange: vi.fn(),
  outputFormats: ['png', 'jpeg'],
  outputFormat: 'png',
  onOutputFormatChange: vi.fn(),
  supportsWatermark: true,
  watermark: false,
  onWatermarkChange: vi.fn(),
  selectedNode: { id: '__selection__', label: '加入所选节点（2）' },
  selectedNodeCount: 2,
  onInjectSelectedNode: vi.fn(),
  onUpload: vi.fn(),
  onSubmit: vi.fn()
})

const open = (renderer: ReactTestRenderer, ariaLabel: string) => {
  act(() => renderer.root.findByProps({ 'aria-label': ariaLabel }).props.onClick())
}

describe('ImageGenerationComposer', () => {
  it('uses the dense attachment strip and compact inline send control', () => {
    const props = createProps()
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<ImageGenerationComposer {...props} />) })

    const attachmentStrip = renderer.root.findByProps({ 'aria-label': '本轮图片输入' })
    const addButton = renderer.root.findByProps({ 'aria-label': '添加图片输入' })
    const sendButton = renderer.root.findByProps({ 'aria-label': '生成图片' })

    expect(attachmentStrip.props.className).toContain('min-h-11')
    expect(addButton.props.className).toContain('h-10')
    expect(sendButton.props.className).toContain('h-8')
    expect(renderer.root.findByProps({ 'data-reference-prompt-editor': true }).props.className).toContain('flex-1')
    expect(renderer.root.findAllByType('span').some(node => node.children.join('') === '参考图 0/10')).toBe(true)
  })

  it('uses compact capability-driven popovers for workflow, model, size, and advanced settings', () => {
    const props = createProps()
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<ImageGenerationComposer {...props} />) })

    open(renderer, '选择生成方式')
    act(() => renderer.root.findByProps({ 'aria-label': '智能改图' }).props.onClick())
    open(renderer, '选择图片模型')
    act(() => renderer.root.findByProps({ 'aria-label': 'Seedream 5.0 Pro' }).props.onClick())
    open(renderer, '设置比例与分辨率')
    expect(renderer.root.findAll(node => (
      typeof node.props.className === 'string'
      && node.props.className.includes('absolute bottom-')
      && node.props.className.includes('w-72')
    ))).toHaveLength(1)
    act(() => renderer.root.findByProps({ 'aria-label': '2K' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '16:9' }).props.onClick())
    open(renderer, '更多图片设置')
    act(() => renderer.root.findByProps({ 'aria-label': 'JPEG' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '快速' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '添加水印' }).props.onChange({ target: { checked: true } }))

    expect(props.onWorkflowChange).toHaveBeenCalledWith('smart-edit')
    expect(props.onModelChange).toHaveBeenCalledWith('seedream')
    expect(props.onResolutionChange).toHaveBeenCalledWith('2K')
    expect(props.onAspectRatioChange).toHaveBeenCalledWith('16:9')
    expect(props.onOutputFormatChange).toHaveBeenCalledWith('jpeg')
    expect(props.onPromptOptimizationChange).toHaveBeenCalledWith('fast')
    expect(props.onWatermarkChange).toHaveBeenCalledWith(true)
  })

  it('combines selected-node injection and local upload under the plus menu', () => {
    const props = createProps()
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<ImageGenerationComposer {...props} />) })

    open(renderer, '添加图片输入')
    act(() => renderer.root.findByProps({ 'aria-label': '注入已选节点（2）' }).props.onClick())
    expect(props.onInjectSelectedNode).toHaveBeenCalledWith('__selection__')

    open(renderer, '添加图片输入')
    const file = new File(['image'], 'reference.png', { type: 'image/png' })
    act(() => renderer.root.findByProps({ 'aria-label': '上传本地参考图' }).props.onChange({
      target: { files: [file], value: 'reference.png' }
    }))
    expect(props.onUpload).toHaveBeenCalledWith(file)
  })

  it('manages a concrete image role, order, visual annotation, and removal from its thumbnail menu', () => {
    const props: ImageGenerationComposerProps = {
      ...createProps(),
      references: [{
        referenceId: 'reference-one',
        assetId: 'asset-one',
        label: '产品图',
        imageUrl: '/one.png',
        mentioned: true,
        role: 'reference-image',
        order: 0
      }, {
        referenceId: 'reference-two',
        assetId: 'asset-two',
        label: '风格图',
        imageUrl: '/two.png',
        mentioned: false,
        role: 'reference-image',
        order: 1
      }],
      onReferenceRoleChange: vi.fn(),
      onMoveReference: vi.fn(),
      onEditAnnotations: vi.fn(),
      onRemoveReference: vi.fn()
    }
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<ImageGenerationComposer {...props} />) })

    open(renderer, '管理图1 产品图')
    act(() => renderer.root.findByProps({ 'aria-label': '右移' }).props.onClick())
    open(renderer, '管理图1 产品图')
    act(() => renderer.root.findByProps({ 'aria-label': '设为主图' }).props.onClick())
    open(renderer, '管理图1 产品图')
    act(() => renderer.root.findByProps({ 'aria-label': '视觉标记' }).props.onClick())
    open(renderer, '管理图1 产品图')
    act(() => renderer.root.findByProps({ 'aria-label': '移除图片' }).props.onClick())

    expect(props.onMoveReference).toHaveBeenCalledWith('reference-one', 1)
    expect(props.onReferenceRoleChange).toHaveBeenCalledWith('reference-one', 'source-image')
    expect(props.onEditAnnotations).toHaveBeenCalledWith('reference-one')
    expect(props.onRemoveReference).toHaveBeenCalledWith('reference-one')
  })

  it('previews a reference from its thumbnail body and removes it only from the corner action', () => {
    const props: ImageGenerationComposerProps = {
      ...createProps(),
      references: [{
        referenceId: 'reference-one',
        assetId: 'asset-one',
        label: '产品图',
        imageUrl: '/one.png',
        mentioned: false,
        role: 'reference-image',
        order: 0
      }],
      onRemoveReference: vi.fn()
    }
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<ImageGenerationComposer {...props} />) })

    open(renderer, '查看图1 产品图')

    const dialog = renderer.root.findByProps({ role: 'dialog' })
    expect(dialog.props['aria-modal']).toBe(true)
    expect(renderer.root.findByProps({ alt: '产品图完整预览' }).props.src).toBe('/one.png')
    expect(props.onRemoveReference).not.toHaveBeenCalled()

    act(() => renderer.root.findByProps({ 'aria-label': '关闭产品图预览' }).props.onClick())
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)

    act(() => renderer.root.findByProps({ 'aria-label': '从参考图列表移除图1 产品图' }).props.onClick({
      stopPropagation: vi.fn()
    }))
    expect(props.onRemoveReference).toHaveBeenCalledWith('reference-one')
  })

  it('renders compact text reference labels and removes them independently', () => {
    const props: ImageGenerationComposerProps = {
      ...createProps(),
      textReferences: [{ nodeId: 'text-one', label: '角色设定版', order: 0 }],
      onRemoveTextReference: vi.fn()
    }
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<ImageGenerationComposer {...props} />) })

    const tag = renderer.root.findByProps({ 'data-image-generation-text-reference': 'text-one' })
    expect(tag.findAllByType('span').some(node => node.children.includes('角色设定版'))).toBe(true)

    act(() => renderer.root.findByProps({ 'aria-label': '移除文字参考 角色设定版' }).props.onClick())
    expect(props.onRemoveTextReference).toHaveBeenCalledWith('text-one')
  })

  it('keeps custom dimensions in the size popover and submits through Ctrl/Cmd+Enter', () => {
    const props: ImageGenerationComposerProps = {
      ...createProps(),
      aspectRatio: 'custom',
      customWidth: 2048,
      customHeight: 2048,
      onCustomSizeChange: vi.fn()
    }
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<ImageGenerationComposer {...props} />) })

    open(renderer, '设置比例与分辨率')
    act(() => renderer.root.findByProps({ 'aria-label': '自定义宽度' }).props.onChange({ target: { value: '2496' } }))
    act(() => renderer.root.findByProps({ 'aria-label': '自定义高度' }).props.onChange({ target: { value: '1664' } }))
    act(() => renderer.root.findByProps({ 'aria-label': '图片描述' }).props.onKeyDown({
      ctrlKey: true,
      metaKey: false,
      key: 'Enter',
      preventDefault: vi.fn()
    }))

    expect(props.onCustomSizeChange).toHaveBeenCalledWith(2496, 2048)
    expect(props.onCustomSizeChange).toHaveBeenCalledWith(2048, 1664)
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('keeps unresolved structured references visible and blocks submission with all requirements', () => {
    const document: PromptDocument = {
      version: 1,
      segments: [
        { type: 'text', text: '使用 ' },
        { type: 'reference', referenceId: 'missing-reference', label: '已删除图片' }
      ]
    }
    const props: ImageGenerationComposerProps = {
      ...createProps(),
      promptDocument: document,
      unresolvedReferenceIds: ['missing-reference'],
      missingRequirements: ['提示词包含已经失效的参考图引用。'],
      blockingRequirements: ['尚未配置默认图片模型。', '提示词包含已经失效的参考图引用。']
    }

    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<ImageGenerationComposer {...props} />) })

    expect(renderer.root.findByProps({ 'aria-label': '图片描述' }).props.contentEditable).toBe(true)
    expect(renderer.root.findAllByProps({ 'data-reference-token': 'true' })).toHaveLength(1)
    expect(renderer.root.findByProps({ 'aria-label': '生成图片' }).props.disabled).toBe(true)
    expect(renderer.root.findByProps({ role: 'alert' })).toBeTruthy()
  })

  it('accepts every official Seedream input format and blocks upload after ten images', () => {
    const props: ImageGenerationComposerProps = {
      ...createProps(),
      references: Array.from({ length: 10 }, (_, order) => ({
        referenceId: `reference-${order}`,
        assetId: `asset-${order}`,
        label: `${order}`,
        imageUrl: `/${order}.png`,
        mentioned: false,
        role: order === 0 ? 'source-image' : 'reference-image',
        order
      }))
    }
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<ImageGenerationComposer {...props} />) })

    const upload = renderer.root.findByProps({ 'aria-label': '上传本地参考图' })
    expect(upload.props.accept).toBe('image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif,image/heic,image/heif,.heic,.heif')
    open(renderer, '添加图片输入')
    expect(renderer.root.findByProps({ 'aria-label': '上传参考图' }).props.disabled).toBe(true)
  })

  it('shows region editing only as contextual state and never exposes unsupported output controls', () => {
    const props: ImageGenerationComposerProps = {
      ...createProps(),
      workflow: 'region-edit',
      regionCount: 2,
      onEditRegions: vi.fn(),
      resolutions: ['1K', '2K']
    }
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<ImageGenerationComposer {...props} />) })

    expect(renderer.root.findByProps({ 'aria-label': '编辑修改区域' })).toBeTruthy()
    const markup = JSON.stringify(renderer.toJSON())
    expect(markup).not.toContain('4K')
    expect(markup).not.toContain('组图')
    expect(markup).not.toContain('主体库')
    expect(markup).not.toContain('mask')
  })
})
