import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IFreeCanvasNode, IPromptProject } from '@/models/PromptHistory.model'
import { StorageRevisionConflict, type ContextPackInspection } from '@/storage/storage-service-client'
import { CopyCodexContext } from './CopyCodexContext'

const codes = {
  project: 'PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectB: 'PRJ-01ARZ3NDEKTSV4RRFFQ69G5FB0',
  text: 'CVT-01ARZ3NDEKTSV4RRFFQ69G5FAW',
  image: 'CVM-01ARZ3NDEKTSV4RRFFQ69G5FAX',
  context: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ',
  contextB: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FB1'
} as const

const nodes: IFreeCanvasNode[] = [
  {
    id: 'text', kind: 'text', title: 'Opening line', referenceCode: codes.text,
    position: { x: 0, y: 0 }, width: 420, height: 180, fontSize: 'large', segments: [], meta: {}
  },
  {
    id: 'arrow', kind: 'arrow', title: 'Unsupported arrow', position: { x: 0, y: 0 },
    width: 100, height: 40, text: '', color: '#000', meta: {}
  },
  {
    id: 'image', kind: 'image', title: 'Reference frame', referenceCode: codes.image,
    position: { x: 0, y: 0 }, width: 320, height: 240, annotations: [], meta: {}
  }
]

const project = (projectCode: string | null = codes.project): IPromptProject => ({
  id: projectCode === codes.project ? 'project-a' : 'project-b',
  referenceCode: projectCode || undefined,
  title: projectCode === codes.project ? 'Project A' : 'Project B',
  type: 'free-canvas',
  revision: projectCode === codes.project ? 7 : 3,
  pages: [],
  currentPage: 0,
  freeCanvas: { nodes, edges: [], meta: {} },
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  meta: {}
})

const inspection = (overrides: Partial<ContextPackInspection> = {}): ContextPackInspection => ({
  cvcCode: codes.context,
  projectCode: codes.project,
  projectRevision: 7,
  createdAt: 9,
  creator: 'promptcard-ui',
  entries: [
    {
      reference: { namespace: 'canvasTemplate', code: codes.text },
      content: '{"kind":"text","text":"Frozen opening","title":"Opening line","truncated":false}',
      contentDigest: `sha256:${'a'.repeat(64)}`
    },
    {
      reference: { namespace: 'canvasMedia', code: codes.image },
      content: '{"height":240,"kind":"image","title":"Reference frame","width":320}',
      contentDigest: `sha256:${'b'.repeat(64)}`
    }
  ],
  sourceCodes: [],
  sourceBoundaries: [
    { nodeCode: codes.text, promptLibraryReferences: [], canvasMediaReferences: [] },
    { nodeCode: codes.image, promptLibraryReferences: [], canvasMediaReferences: [] }
  ],
  placementHint: { mode: 'after-selection', anchorNodeCodes: [codes.text, codes.image] },
  snapshotDigest: `sha256:${'c'.repeat(64)}`,
  revokedAt: null,
  revokedBy: null,
  revocationReason: null,
  ...overrides
})

const contextClient = (overrides: Record<string, unknown> = {}) => ({
  create: vi.fn().mockResolvedValue(inspection()),
  inspect: vi.fn().mockResolvedValue(inspection()),
  revoke: vi.fn().mockResolvedValue(inspection({
    revokedAt: 12,
    revokedBy: 'promptcard-ui',
    revocationReason: 'user-revoked'
  })),
  ...overrides
})

const renderComponent = async (
  selectedNodeIds: string[],
  client = contextClient(),
  activeProject = project()
) => {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(
      <CopyCodexContext
        project={activeProject}
        nodes={nodes}
        selectedNodeIds={selectedNodeIds}
        client={client}
      />
    )
  })
  return { client, renderer }
}

const button = (renderer: ReactTestRenderer, name: string) => renderer.root.findAllByType('button')
  .find(candidate => candidate.props['aria-label'] === name || candidate.children.join('') === name)

const input = (renderer: ReactTestRenderer, name: string) => renderer.root.findByProps({ 'aria-label': name })

const textContent = (node: ReactTestInstance): string => (
  node.children.map(child => typeof child === 'string' ? child : textContent(child)).join('')
)

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CopyCodexContext', () => {
  it('opens an explicit ordered preview and explains filtered unsupported selections', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const { renderer } = await renderComponent(['image', 'arrow', 'text'])

    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())

    const dialog = renderer.root.findByProps({ role: 'dialog' })
    expect(dialog.props['aria-modal']).toBe('true')
    expect(textContent(dialog)).toContain(`${codes.project} · 项目修订 7`)
    expect(dialog.findAllByProps({ role: 'listitem' }).map(textContent)).toEqual([
      expect.stringContaining(`文字Opening line${codes.text}`),
      expect.stringContaining(`图片Reference frame${codes.image}`)
    ])
    expect(textContent(dialog.findByProps({ role: 'status' }))).toContain('1 个不支持的选择未包含')
    expect(button(renderer, '创建并复制 CVC')?.props.disabled).toBe(false)
    expect(dialog.findByProps({ 'data-context-pack-scroll': true }).props.className).toContain('overflow-y-auto')
  })

  it.each([
    ['没有选择', project(), [] as string[]],
    ['项目代码暂不可用', project(null), ['text']],
    ['当前选择没有可用的 CVT/CVM', project(), ['arrow']]
  ])('disables creation and sends no request when %s', async (message, activeProject, selectedNodeIds) => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } })
    const { client, renderer } = await renderComponent(selectedNodeIds, contextClient(), activeProject)

    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())

    expect(renderer.root.findAllByProps({ role: 'status' }).map(textContent).join(' ')).toContain(message)
    expect(button(renderer, '创建并复制 CVC')?.props.disabled).toBe(true)
    expect(client.create).not.toHaveBeenCalled()
  })

  it('creates exactly the reviewed payload and copies the resulting CVC once', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { client, renderer } = await renderComponent(['image', 'text'])
    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())

    await act(async () => button(renderer, '创建并复制 CVC')?.props.onClick())

    expect(client.create).toHaveBeenCalledOnce()
    expect(client.create).toHaveBeenCalledWith({
      projectCode: codes.project,
      projectRevision: 7,
      nodeCodes: [codes.text, codes.image],
      placementHint: { mode: 'after-selection', anchorNodeCodes: [codes.text, codes.image] },
      creator: 'promptcard-ui'
    })
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith(codes.context)
    expect(renderer.root.findByProps({ 'data-testid': 'context-pack-code' }).children.join('')).toBe(codes.context)
    expect(renderer.root.findAllByProps({ role: 'status' }).map(textContent).join(' ')).toContain('CVC 已创建并复制')
  })

  it('retains a created CVC after clipboard rejection and retries copying without creating again', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { client, renderer } = await renderComponent(['text'])
    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())

    await act(async () => button(renderer, '创建并复制 CVC')?.props.onClick())

    expect(textContent(renderer.root.findByProps({ role: 'alert' }))).toContain('上下文已创建，但复制失败')
    expect(renderer.root.findByProps({ 'data-testid': 'context-pack-code' }).children.join('')).toBe(codes.context)
    await act(async () => button(renderer, '重试复制 CVC')?.props.onClick())
    expect(client.create).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('fails closed with a refresh-preview instruction when the selected project revision changed', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } })
    const client = contextClient({
      create: vi.fn().mockRejectedValue(new StorageRevisionConflict({
        projectCode: codes.project,
        projectRevision: 8
      }))
    })
    const { renderer } = await renderComponent(['text'], client)
    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())

    await act(async () => button(renderer, '创建并复制 CVC')?.props.onClick())

    expect(textContent(renderer.root.findByProps({ role: 'alert' }))).toContain('项目修订已变化，请关闭后重新预览')
    expect(renderer.root.findAllByProps({ 'data-testid': 'context-pack-code' })).toHaveLength(0)
  })

  it('ignores duplicate creation and stale settlement after the dialog is reopened', async () => {
    let resolveCreate!: (value: ContextPackInspection) => void
    const pending = new Promise<ContextPackInspection>(resolve => { resolveCreate = resolve })
    const client = contextClient({ create: vi.fn().mockReturnValue(pending) })
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } })
    const { renderer } = await renderComponent(['text'], client)
    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
    const createButton = button(renderer, '创建并复制 CVC')!

    await act(async () => {
      createButton.props.onClick()
      createButton.props.onClick()
    })
    expect(client.create).toHaveBeenCalledOnce()
    await act(async () => button(renderer, '关闭 Agent/MCP 上下文')?.props.onClick())
    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
    await act(async () => resolveCreate(inspection()))

    expect(renderer.root.findAllByProps({ 'data-testid': 'context-pack-code' })).toHaveLength(0)
  })

  it('inspects the original immutable snapshot after project focus changes and revokes it idempotently', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const client = contextClient()
    const { renderer } = await renderComponent([], client, project(codes.projectB))
    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
    await act(async () => input(renderer, '检查 CVC').props.onChange({ target: { value: codes.context.toLowerCase() } }))

    await act(async () => button(renderer, '检查快照')?.props.onClick())

    expect(client.inspect).toHaveBeenCalledWith(codes.context)
    const inspectionPanel = renderer.root.findByProps({ 'aria-label': '不可变快照检查' })
    const text = textContent(inspectionPanel)
    expect(text).toContain('不可变快照')
    expect(text).toContain(codes.project)
    expect(text).toContain('项目修订 7')
    expect(text).toContain(`文字Opening line${codes.text}`)

    const revokeButton = button(renderer, '撤销此 CVC')!
    await act(async () => {
      revokeButton.props.onClick()
      revokeButton.props.onClick()
    })
    expect(client.revoke).toHaveBeenCalledOnce()
    expect(client.revoke).toHaveBeenCalledWith(codes.context, {
      actor: 'promptcard-ui', reason: 'user-revoked'
    })
    expect(button(renderer, '撤销此 CVC')?.props.disabled).toBe(true)
    expect(renderer.root.findAllByProps({ role: 'status' }).map(textContent).join(' ')).toContain('已撤销，不再是可用复制上下文')
  })

  it('does not let an old inspection settlement reset input edited while the request is pending', async () => {
    const pending = deferred<ContextPackInspection>()
    const client = contextClient({ inspect: vi.fn().mockReturnValue(pending.promise) })
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } })
    const { renderer } = await renderComponent([], client)
    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
    await act(async () => input(renderer, '检查 CVC').props.onChange({ target: { value: codes.context } }))

    await act(async () => button(renderer, '检查快照')?.props.onClick())
    await act(async () => input(renderer, '检查 CVC').props.onChange({ target: { value: codes.contextB } }))
    await act(async () => pending.resolve(inspection()))

    expect(input(renderer, '检查 CVC').props.value).toBe(codes.contextB)
    expect(renderer.root.findAllByProps({ 'aria-label': '不可变快照检查' })).toHaveLength(0)
  })

  it('keeps inspection B when a revoke for inspection A settles later', async () => {
    const pendingRevoke = deferred<ContextPackInspection>()
    const inspectionB = inspection({ cvcCode: codes.contextB })
    const client = contextClient({
      inspect: vi.fn()
        .mockResolvedValueOnce(inspection())
        .mockResolvedValueOnce(inspectionB),
      revoke: vi.fn().mockReturnValue(pendingRevoke.promise)
    })
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } })
    const { renderer } = await renderComponent([], client)
    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
    await act(async () => input(renderer, '检查 CVC').props.onChange({ target: { value: codes.context } }))
    await act(async () => button(renderer, '检查快照')?.props.onClick())

    await act(async () => button(renderer, '撤销此 CVC')?.props.onClick())
    await act(async () => input(renderer, '检查 CVC').props.onChange({ target: { value: codes.contextB } }))
    await act(async () => button(renderer, '检查快照')?.props.onClick())
    expect(textContent(renderer.root.findByProps({ 'aria-label': '不可变快照检查' }))).toContain(codes.contextB)

    await act(async () => pendingRevoke.resolve(inspection({
      revokedAt: 12, revokedBy: 'promptcard-ui', revocationReason: 'user-revoked'
    })))

    expect(input(renderer, '检查 CVC').props.value).toBe(codes.contextB)
    expect(textContent(renderer.root.findByProps({ 'aria-label': '不可变快照检查' }))).toContain(codes.contextB)
    expect(textContent(renderer.root.findByProps({ 'aria-label': '不可变快照检查' }))).toContain('生命周期：有效')
  })

  it('ignores an inspection settlement after close and reopen and keeps inspect double-submit single-flight', async () => {
    const pending = deferred<ContextPackInspection>()
    const client = contextClient({ inspect: vi.fn().mockReturnValue(pending.promise) })
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } })
    const { renderer } = await renderComponent([], client)
    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
    await act(async () => input(renderer, '检查 CVC').props.onChange({ target: { value: codes.context } }))

    await act(async () => {
      button(renderer, '检查快照')?.props.onClick()
      button(renderer, '检查快照')?.props.onClick()
    })
    expect(client.inspect).toHaveBeenCalledOnce()
    await act(async () => button(renderer, '关闭 Agent/MCP 上下文')?.props.onClick())
    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
    await act(async () => pending.resolve(inspection()))

    expect(renderer.root.findAllByProps({ 'aria-label': '不可变快照检查' })).toHaveLength(0)
  })

  it.each([true, false])(
    'keeps inspect B authoritative when create starts first (first settlement: %s)',
    async firstSettlesFirst => {
      const pendingCreate = deferred<ContextPackInspection>()
      const pendingInspect = deferred<ContextPackInspection>()
      const inspectedB = inspection({ cvcCode: codes.contextB })
      const client = contextClient({
        create: vi.fn().mockReturnValue(pendingCreate.promise),
        inspect: vi.fn().mockReturnValue(pendingInspect.promise)
      })
      vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
      const { renderer } = await renderComponent(['text'], client)
      await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
      await act(async () => input(renderer, '检查 CVC').props.onChange({ target: { value: codes.contextB } }))
      await act(async () => button(renderer, '创建并复制 CVC')?.props.onClick())
      await act(async () => button(renderer, '检查快照')?.props.onClick())

      await settlePair(firstSettlesFirst, pendingCreate, inspection(), pendingInspect, inspectedB)

      expect(input(renderer, '检查 CVC').props.value).toBe(codes.contextB)
      expect(textContent(renderer.root.findByProps({ 'aria-label': '不可变快照检查' }))).toContain(codes.contextB)
      expect(renderer.root.findAllByProps({ 'data-testid': 'context-pack-code' })).toHaveLength(0)
      expect(button(renderer, '创建并复制 CVC')?.props.disabled).toBe(false)
      expect(button(renderer, '检查快照')?.props.disabled).toBe(false)
    }
  )

  it.each([true, false])(
    'keeps create authoritative when inspect starts first (first settlement: %s)',
    async firstSettlesFirst => {
      const pendingCreate = deferred<ContextPackInspection>()
      const pendingInspect = deferred<ContextPackInspection>()
      const client = contextClient({
        create: vi.fn().mockReturnValue(pendingCreate.promise),
        inspect: vi.fn().mockReturnValue(pendingInspect.promise)
      })
      vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
      const { renderer } = await renderComponent(['text'], client)
      await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
      await act(async () => input(renderer, '检查 CVC').props.onChange({ target: { value: codes.contextB } }))
      await act(async () => button(renderer, '检查快照')?.props.onClick())
      await act(async () => button(renderer, '创建并复制 CVC')?.props.onClick())

      await settlePair(firstSettlesFirst, pendingInspect, inspection({ cvcCode: codes.contextB }), pendingCreate, inspection())

      expect(input(renderer, '检查 CVC').props.value).toBe(codes.context)
      expect(renderer.root.findByProps({ 'data-testid': 'context-pack-code' }).children.join('')).toBe(codes.context)
      expect(renderer.root.findAllByProps({ 'aria-label': '不可变快照检查' })).toHaveLength(0)
      expect(button(renderer, '检查快照')?.props.disabled).toBe(false)
    }
  )

  it.each([true, false])(
    'keeps revoke A authoritative when create starts first (first settlement: %s)',
    async firstSettlesFirst => {
      const pendingCreate = deferred<ContextPackInspection>()
      const pendingRevoke = deferred<ContextPackInspection>()
      const revokedA = inspection({ revokedAt: 12, revokedBy: 'promptcard-ui', revocationReason: 'user-revoked' })
      const client = contextClient({
        create: vi.fn().mockReturnValue(pendingCreate.promise),
        inspect: vi.fn().mockResolvedValue(inspection()),
        revoke: vi.fn().mockReturnValue(pendingRevoke.promise)
      })
      vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
      const { renderer } = await renderComponent(['text'], client)
      await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
      await act(async () => input(renderer, '检查 CVC').props.onChange({ target: { value: codes.context } }))
      await act(async () => button(renderer, '检查快照')?.props.onClick())
      await act(async () => button(renderer, '创建并复制 CVC')?.props.onClick())
      await act(async () => button(renderer, '撤销此 CVC')?.props.onClick())

      await settlePair(firstSettlesFirst, pendingCreate, inspection(), pendingRevoke, revokedA)

      expect(input(renderer, '检查 CVC').props.value).toBe(codes.context)
      expect(textContent(renderer.root.findByProps({ 'aria-label': '不可变快照检查' }))).toContain('已撤销')
      expect(renderer.root.findAllByProps({ 'data-testid': 'context-pack-code' })).toHaveLength(0)
      expect(button(renderer, '创建并复制 CVC')?.props.disabled).toBe(false)
    }
  )

  it.each([true, false])(
    'keeps create authoritative when revoke starts first (first settlement: %s)',
    async firstSettlesFirst => {
      const pendingCreate = deferred<ContextPackInspection>()
      const pendingRevoke = deferred<ContextPackInspection>()
      const client = contextClient({
        create: vi.fn().mockReturnValue(pendingCreate.promise),
        inspect: vi.fn().mockResolvedValue(inspection()),
        revoke: vi.fn().mockReturnValue(pendingRevoke.promise)
      })
      vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
      const { renderer } = await renderComponent(['text'], client)
      await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
      await act(async () => input(renderer, '检查 CVC').props.onChange({ target: { value: codes.context } }))
      await act(async () => button(renderer, '检查快照')?.props.onClick())
      await act(async () => button(renderer, '撤销此 CVC')?.props.onClick())
      await act(async () => button(renderer, '创建并复制 CVC')?.props.onClick())

      await settlePair(
        firstSettlesFirst,
        pendingRevoke,
        inspection({ revokedAt: 12, revokedBy: 'promptcard-ui', revocationReason: 'user-revoked' }),
        pendingCreate,
        inspection()
      )

      expect(input(renderer, '检查 CVC').props.value).toBe(codes.context)
      expect(renderer.root.findByProps({ 'data-testid': 'context-pack-code' }).children.join('')).toBe(codes.context)
      expect(renderer.root.findAllByProps({ 'aria-label': '不可变快照检查' })).toHaveLength(0)
      expect(button(renderer, '检查快照')?.props.disabled).toBe(false)
    }
  )

  it('ignores a revoke settlement after close and reopen without leaving a pending control', async () => {
    const pendingRevoke = deferred<ContextPackInspection>()
    const client = contextClient({
      inspect: vi.fn().mockResolvedValue(inspection()),
      revoke: vi.fn().mockReturnValue(pendingRevoke.promise)
    })
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } })
    const { renderer } = await renderComponent([], client)
    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
    await act(async () => input(renderer, '检查 CVC').props.onChange({ target: { value: codes.context } }))
    await act(async () => button(renderer, '检查快照')?.props.onClick())
    await act(async () => button(renderer, '撤销此 CVC')?.props.onClick())
    await act(async () => button(renderer, '关闭 Agent/MCP 上下文')?.props.onClick())
    await act(async () => button(renderer, '复制 Agent/MCP 上下文')?.props.onClick())
    await act(async () => pendingRevoke.resolve(inspection({
      revokedAt: 12, revokedBy: 'promptcard-ui', revocationReason: 'user-revoked'
    })))

    expect(renderer.root.findAllByProps({ 'aria-label': '不可变快照检查' })).toHaveLength(0)
    expect(button(renderer, '检查快照')?.props.disabled).toBe(false)
  })
})

const settlePair = async <A, B>(
  firstSettlesFirst: boolean,
  first: ReturnType<typeof deferred<A>>,
  firstValue: A,
  second: ReturnType<typeof deferred<B>>,
  secondValue: B
) => {
  if (firstSettlesFirst) {
    await act(async () => first.resolve(firstValue))
    await act(async () => second.resolve(secondValue))
  } else {
    await act(async () => second.resolve(secondValue))
    await act(async () => first.resolve(firstValue))
  }
}
