import { act, create } from 'react-test-renderer'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IFreeCanvasNode, IPromptProject } from '@/models/PromptHistory.model'
import { normalizeFreeCanvasProject } from '@/domain/free-canvas/free-canvas-project'
import {
  CanvasNodeReferenceCodeAction,
  CanvasProjectReferenceCodeAction
} from './CanvasReferenceCodeAction'

const validUlid = '01M0N7FTG1PKB2AV2P8S62N6H8'

const project = (referenceCode?: string): IPromptProject => ({
  id: 'project-internal', title: 'Reference project', type: 'free-canvas', revision: 1,
  pages: [], currentPage: 0, freeCanvas: { nodes: [], edges: [], meta: {} },
  referenceCode, createdAt: 1, updatedAt: 1, lastOpenedAt: 1, meta: {}
})

const textNode = (referenceCode?: string): IFreeCanvasNode => ({
  id: 'text-internal', kind: 'text', title: 'Repeated title', position: { x: 0, y: 0 },
  width: 420, height: 180, fontSize: 'large', segments: [], referenceCode, meta: {}
})

const imageNode = (overrides: Record<string, unknown> = {}): IFreeCanvasNode => ({
  id: 'image-internal', kind: 'image', title: 'Repeated title', position: { x: 0, y: 0 },
  width: 640, height: 480, assetId: 'asset-internal', annotations: [], meta: {}, ...overrides
}) as IFreeCanvasNode

describe('Canvas reference-code copy actions', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('copies only canonical project, text and image response projections', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const renderer = create(<>
      <CanvasProjectReferenceCodeAction project={project(`PRJ-${validUlid}`)} />
      <CanvasNodeReferenceCodeAction node={textNode(`CVT-${validUlid}`)} />
      <CanvasNodeReferenceCodeAction node={imageNode({ referenceCode: `CVM-${validUlid}` })} />
    </>)
    const buttons = renderer.root.findAllByType('button')

    for (const button of buttons) {
      await act(async () => button.props.onClick({ stopPropagation: vi.fn() }))
    }

    expect(writeText.mock.calls.map(call => call[0])).toEqual([
      `PRJ-${validUlid}`,
      `CVT-${validUlid}`,
      `CVM-${validUlid}`
    ])
    expect(buttons[1].props['aria-label']).toContain(validUlid.slice(-6))
    expect(buttons[2].props['aria-label']).toContain(validUlid.slice(-6))
  })

  it.each(['Enter', ' '])('activates node-code copy directly with the %j key', async key => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const renderer = create(<CanvasNodeReferenceCodeAction node={textNode(`CVT-${validUlid}`)} />)
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    await act(async () => renderer.root.findByType('button').props.onKeyDown({
      key,
      preventDefault,
      stopPropagation
    }))

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith(`CVT-${validUlid}`)
  })

  it('explains unsupported, running, missing and invalid node codes without exposing or copying them', () => {
    const nodes: IFreeCanvasNode[] = [
      { id: 'arrow', kind: 'arrow', title: 'Arrow', position: { x: 0, y: 0 }, width: 100, height: 40, text: 'go', color: '#000', meta: {} },
      {
        id: 'generator', kind: 'image-generator', title: 'Generator', position: { x: 0, y: 0 }, width: 420, height: 560,
        mode: 'generate', binding: { connectionId: '', modelId: '' }, settings: {} as never,
        promptDocument: { version: 1, segments: [] }, regions: [], meta: {}
      },
      imageNode({ meta: { generationState: 'running' } }),
      textNode(),
      textNode(`CVT-${validUlid.toLowerCase()}`)
    ]
    const html = nodes.map(node => renderToStaticMarkup(<CanvasNodeReferenceCodeAction node={node} />)).join('\n')

    expect(html).toContain('箭头节点不支持节点代码')
    expect(html).toContain('图片生成器节点不支持节点代码')
    expect(html).toContain('仍在生成')
    expect(html).toContain('尚无可复制的节点代码')
    expect(html).toContain('节点代码格式无效')
    expect(html).not.toContain(validUlid.toLowerCase())
    expect(html.match(/disabled=""/g)).toHaveLength(5)
  })

  it.each([
    ['running', { meta: { generationState: 'running' } }, '仍在生成'],
    ['failed', { meta: { generationState: 'failed' } }, '生成失败'],
    ['transient', { transient: true }, '临时图片节点']
  ])('never copies a valid image code while the node is %s', async (_state, overrides, reason) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const renderer = create(
      <CanvasNodeReferenceCodeAction
        node={imageNode({ referenceCode: `CVM-${validUlid}`, ...overrides })}
      />
    )
    const button = renderer.root.findByType('button')

    await act(async () => button.props.onClick({ stopPropagation: vi.fn() }))

    expect(button.props.disabled).toBe(true)
    expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toContain(reason)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('treats a locally duplicated node as identity-pending even if it carries a stale valid code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const renderer = create(
      <CanvasNodeReferenceCodeAction node={imageNode({
        referenceCode: `CVM-${validUlid}`,
        meta: { referenceCodePending: true, duplicatedFromNodeId: 'source' }
      })} />
    )
    const button = renderer.root.findByType('button')

    await act(async () => button.props.onClick({ stopPropagation: vi.fn() }))

    expect(button.props.disabled).toBe(true)
    expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toContain('等待 Storage 分配')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('keeps normalized transient images disabled before code validation while stable images still copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const normalized = normalizeFreeCanvasProject({
      nodes: [
        imageNode({ id: 'transient-valid', transient: true, referenceCode: `CVM-${validUlid}` }),
        imageNode({ id: 'transient-malformed-code', transient: true, referenceCode: 'CVM-malformed' }),
        imageNode({ id: 'stable-valid', transient: false, referenceCode: `CVM-${validUlid}` })
      ],
      edges: [],
      meta: {}
    }, 1)
    const renderer = create(<>{normalized.nodes.map(node => (
      <CanvasNodeReferenceCodeAction key={node.id} node={node} />
    ))}</>)
    const buttons = renderer.root.findAllByType('button')

    for (const button of buttons) {
      await act(async () => button.props.onClick({ stopPropagation: vi.fn() }))
    }

    expect(buttons.map(button => button.props.disabled)).toEqual([true, true, false])
    expect(renderer.root.findAllByProps({ role: 'status' }).slice(0, 2).map(status => status.children.join('')))
      .toEqual(['临时图片节点没有节点代码', '临时图片节点没有节点代码'])
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(`CVM-${validUlid}`)
  })

  it('shows retryable errors, ignores stale settlement after scope change and stops copy activation bubbling', async () => {
    let resolveFirst!: () => void
    const first = new Promise<void>(resolve => { resolveFirst = resolve })
    const writeText = vi.fn().mockReturnValueOnce(first).mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<CanvasNodeReferenceCodeAction node={textNode(`CVT-${validUlid}`)} />)
    })
    const stopPropagation = vi.fn()
    const firstButton = renderer.root.findByType('button')
    await act(async () => firstButton.props.onClick({ stopPropagation }))
    await act(async () => {
      renderer.update(<CanvasNodeReferenceCodeAction node={{ ...textNode(`CVT-${validUlid.slice(0, -1)}9`), id: 'text-next' }} />)
      resolveFirst()
      await first
    })
    expect(renderer.root.findAllByProps({ role: 'status' })).toHaveLength(0)

    await act(async () => renderer.root.findByType('button').props.onClick({ stopPropagation }))
    expect(renderer.root.findByProps({ role: 'alert' }).findByType('span').children.join('')).toContain('复制节点代码失败')
    await act(async () => renderer.root.findAllByType('button')[1].props.onClick({ stopPropagation }))
    expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
    expect(stopPropagation).toHaveBeenCalledTimes(3)
  })
})
