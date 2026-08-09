import { Fragment, useState, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IFreeCanvasProject, IPromptProject } from '@/models/PromptHistory.model'
import {
  createFreeCanvasImageGenerationPlaceholder,
  createFreeCanvasImageNodeFromMedia,
  createFreeCanvasProject,
  createFreeCanvasTextNode
} from '@/domain/free-canvas/free-canvas-project'

const mocks = vi.hoisted(() => ({
  bootstrapRuntime: vi.fn(),
  getCatalog: vi.fn(),
  listConnections: vi.fn(),
  listAssignments: vi.fn(),
  getImageGenerationStatus: vi.fn(),
  getConversations: vi.fn(),
  getConversationRuns: vi.fn(),
  getRunById: vi.fn(),
  getPendingPlacements: vi.fn(),
  markPlacementPlaced: vi.fn(),
  prepareGeneration: vi.fn(),
  requestGeneration: vi.fn()
}))

vi.mock('@xyflow/react', () => {
  const PassThrough = ({ children }: { children?: ReactNode }) => <Fragment>{children}</Fragment>
  const reactFlow = {
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y })
  }
  return {
    Background: () => null,
    BackgroundVariant: { Lines: 'lines' },
    Controls: () => null,
    Handle: () => null,
    MiniMap: () => null,
    NodeResizer: () => null,
    NodeToolbar: PassThrough,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    ReactFlow: PassThrough,
    ReactFlowProvider: PassThrough,
    SelectionMode: { Partial: 'partial' },
    applyNodeChanges: (
      changes: Array<{ id: string; type: string; dimensions?: { width: number; height: number } }>,
      nodes: Array<{ id: string; measured?: { width: number; height: number } }>
    ) => nodes.map(node => {
      const dimensions = changes.find(change => change.id === node.id && change.type === 'dimensions')?.dimensions
      return dimensions ? { ...node, measured: dimensions } : node
    }),
    useReactFlow: () => reactFlow,
    useStore: (selector: (state: { nodes: unknown[]; transform: [number, number, number] }) => unknown) => selector({ nodes: [], transform: [0, 0, 1] })
  }
})

vi.mock('@/components/AgentCollaborationPanel', () => ({
  AIChatbotBox: ({ draftRequest, onApplyWorkspaceProposal, onApplyCanvasEdit }: {
    draftRequest?: {
      content?: string
      canvasNode?: { nodeId: string; role: string; mode?: string }
    }
    onApplyWorkspaceProposal?: (proposal: unknown) => void
    onApplyCanvasEdit?: (edit: unknown) => void
  }) => (
    <div
      data-agent-panel
      data-agent-draft={draftRequest?.content || ''}
      data-agent-node-id={draftRequest?.canvasNode?.nodeId || ''}
      data-agent-node-role={draftRequest?.canvasNode?.role || ''}
      data-agent-node-mode={draftRequest?.canvasNode?.mode || ''}
      data-agent-apply={onApplyWorkspaceProposal}
      data-agent-apply-canvas-edit={onApplyCanvasEdit}
    />
  )
}))
vi.mock('@/components/PromptLibraryPreviewMode', () => ({ PromptLibraryPreviewPanel: () => <div data-prompt-panel /> }))
vi.mock('@/components/prompt-media/PromptPresetPreviewDialog', () => ({ PromptPresetPreviewDialog: () => null }))
vi.mock('@/components/canvas/ImageCropEditor', () => ({ ImageCropEditor: () => null }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ cardTypeLabel: (value: string) => value }) }))
vi.mock('@/stores/preset.store', () => ({
  usePresetStore: () => ({
    presets: [], initialized: true, init: vi.fn(), addPreset: vi.fn(), updatePreset: vi.fn(), deletePreset: vi.fn()
  })
}))
vi.mock('@/services/model-management-client', () => ({
  modelManagementClient: {
    getCatalog: mocks.getCatalog,
    listConnections: mocks.listConnections,
    listAssignments: mocks.listAssignments,
    getImageGenerationStatus: mocks.getImageGenerationStatus
  }
}))
vi.mock('@/services/agent-runtime-service', () => ({
  agentRuntimeService: {
    bootstrap: mocks.bootstrapRuntime
  }
}))
vi.mock('@/services/image-generation-client', async importOriginal => {
  const original = await importOriginal<typeof import('@/services/image-generation-client')>()
  return {
    ...original,
    prepareImageGenerationBatch: mocks.prepareGeneration,
    requestImageGeneration: mocks.requestGeneration
  }
})
vi.mock('@/storage/storage-service-client', async importOriginal => {
  const original = await importOriginal<typeof import('@/storage/storage-service-client')>()
  return {
    ...original,
    storageServiceClient: {
      ...original.storageServiceClient,
      imageGenerationConversations: {
        ...original.storageServiceClient.imageGenerationConversations,
        getPage: mocks.getConversations,
        getRuns: mocks.getConversationRuns
      },
      imageGenerationRuns: {
        ...original.storageServiceClient.imageGenerationRuns,
        getById: mocks.getRunById
      },
      imageGenerationPlacements: {
        ...original.storageServiceClient.imageGenerationPlacements,
        getPending: mocks.getPendingPlacements,
        markPlaced: mocks.markPlacementPlaced
      }
    }
  }
})

import { CanvasBottomToolbar, FreeCanvasBuilderScreen } from './FreeCanvasBuilderScreen'
import { ImageGenerationConversationPanel } from './image-generation/ImageGenerationConversationPanel'
import { MultiViewGroupPanel } from './image-actions/MultiViewGroupPanel'
import { MultiViewWorkbenchDialog } from './image-actions/MultiViewWorkbenchDialog'
import { ProjectResourceLibrary } from './ProjectResourceLibrary'

const baseProps = {
  quickDrawerOpen: false,
  quickPresets: [],
  onCreateText: vi.fn(),
  onCreateImage: vi.fn(),
  onToggleQuickDrawer: vi.fn(),
  onOpenQuickPresetComposer: vi.fn(),
  onEditQuickPreset: vi.fn(),
  onUseQuickPreset: vi.fn()
}

const promptEditorWithText = (text: string) => ({
  childNodes: [{ nodeType: 3, textContent: text }],
  contains: () => false
})

const configureReadyImageModel = () => {
  mocks.getCatalog.mockResolvedValue({
    providers: [],
    models: [{
      id: 'seedream-model',
      providerId: 'volcengine-ark',
      modality: 'image',
      displayName: 'Seedream'
    }]
  })
  mocks.listConnections.mockResolvedValue([{
    id: 'ark-primary',
    providerId: 'volcengine-ark',
    displayName: 'Ark',
    apiBase: 'https://ark.example',
    enabled: true,
    credentialConfigured: true,
    createdAt: 1,
    updatedAt: 1,
    lastTest: { ok: true, checkedAt: 1, message: 'ok' }
  }])
  mocks.listAssignments.mockResolvedValue([{
    slot: 'image.primary',
    connectionId: 'ark-primary',
    modelId: 'seedream-model'
  }])
  mocks.getImageGenerationStatus.mockResolvedValue({
    serverEnabled: true,
    checkedAt: 1,
    credentialStore: { available: true },
    providers: [{ providerId: 'volcengine-ark', status: 'ready' }]
  })
}

const storedImageGenerationRun = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-latest',
  projectId: 'project-a',
  conversationId: 'conversation-latest',
  connectionId: 'ark-primary',
  providerId: 'volcengine-ark',
  modelId: 'seedream-model',
  state: 'succeeded' as const,
  requestSnapshot: {
    mode: 'generate',
    promptOptimization: 'standard' as const,
    promptDocument: { version: 1, segments: [{ type: 'text' as const, text: 'Remember this image request' }] },
    inputAssets: [],
    regions: [],
    resolution: '2K',
    aspectRatio: '1:1',
    outputFormat: 'png',
    watermark: false
  },
  outputAssetIds: ['asset-latest'],
  createdAt: 20,
  finishedAt: 30,
  ...overrides
})

const openImageGenerationPanel = (renderer: ReturnType<typeof create>) => {
  const switcher = renderer.root.findByProps({ 'data-free-canvas-panel-switcher': true })
  act(() => switcher.findAllByType('button')[1].props.onClick())
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(', ')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}: ${canonicalJson(child)}`)
      .join(', ')}}`
  }
  return JSON.stringify(value)
}

const sha256 = async (value: unknown): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)))
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

describe('project-level free canvas image generation entry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout, clearTimeout,
      innerWidth: 1200, innerHeight: 800
    })
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn(), activeElement: null })
    mocks.bootstrapRuntime.mockResolvedValue({ user: { id: 'local-user' } })
    mocks.getCatalog.mockResolvedValue({ providers: [], models: [] })
    mocks.listConnections.mockResolvedValue([])
    mocks.listAssignments.mockResolvedValue([])
    mocks.getImageGenerationStatus.mockResolvedValue({ serverEnabled: false, checkedAt: 1, credentialStore: { available: true }, providers: [] })
    mocks.getConversations.mockResolvedValue({ conversations: [], nextCursor: null })
    mocks.getConversationRuns.mockResolvedValue({ runs: [], nextCursor: null })
    mocks.getRunById.mockResolvedValue(null)
    mocks.getPendingPlacements.mockResolvedValue([])
    mocks.prepareGeneration.mockImplementation(async members => members.map((member: { runId: string }) => ({
      runId: member.runId,
      state: 'queued'
    })))
    mocks.requestGeneration.mockResolvedValue({
      runId: 'image-run-0123456789abcdef0123456789abcdef',
      state: 'succeeded',
      assetId: 'asset-output.png',
      captureId: 'capture-output',
      contentType: 'image/png',
      width: 1024,
      height: 1024
    })
  })

  it('uses the toolbar as a manual open action and never as a node drag source', () => {
    const onOpen = vi.fn()
    const markup = renderToStaticMarkup(<CanvasBottomToolbar {...baseProps} onCreateImageGenerator={onOpen} />)
    expect(markup).toContain('title="打开图片生成"')
    expect(markup).toContain('aria-label="打开图片生成"')
    expect(markup).not.toContain('draggable="true"')

    const renderer = create(<CanvasBottomToolbar {...baseProps} onCreateImageGenerator={onOpen} />)
    const button = renderer.root.findAllByType('button').find(candidate => candidate.props.title === '打开图片生成')!
    act(() => button.props.onClick())
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('keeps the entry hidden when no manual open callback is supplied', () => {
    expect(renderToStaticMarkup(<CanvasBottomToolbar {...baseProps} />)).not.toContain('打开图片生成')
  })

  it('renders Agent, 图片生成 and Prompt库 as mutually exclusive peer tabs without creating a node', async () => {
    const onChange = vi.fn()
    const activeProject = { id: 'project-a', title: 'Project A' } as IPromptProject
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={activeProject}
          freeCanvas={createFreeCanvasProject(1)}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
        />
      )
    })

    const tabLabels = renderer.root.findAll(node => node.type === 'span').flatMap(node => node.children)
    expect(tabLabels).toContain('Agent')
    expect(tabLabels).toContain('图片生成')
    expect(tabLabels).toContain('Prompt库')
    expect(renderer.root.findAllByType('aside').some(node => (
      String(node.props.className).includes('w-[456px]')
    ))).toBe(true)
    expect(renderer.root.findAll(node => (
      typeof node.props.className === 'string' && node.props.className.includes('pr-[456px]')
    ))).not.toHaveLength(0)

    const imageTab = renderer.root.findAllByType('button').find(button => (
      button.findAll(node => node.type === 'span' && node.children.includes('图片生成')).length > 0
    ))!
    act(() => imageTab.props.onClick())
    expect(renderer.root.findByProps({ 'data-free-canvas-image-generation-panel': true })).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('bootstraps Runtime before automatically restoring the configured default image model', async () => {
    configureReadyImageModel()
    const configured = {
      catalog: await mocks.getCatalog(),
      connections: await mocks.listConnections(),
      assignments: await mocks.listAssignments(),
      status: await mocks.getImageGenerationStatus()
    }
    mocks.getCatalog.mockClear()
    mocks.listConnections.mockClear()
    mocks.listAssignments.mockClear()
    mocks.getImageGenerationStatus.mockClear()
    let bootstrapped = false
    mocks.bootstrapRuntime.mockImplementation(async () => {
      bootstrapped = true
      return { user: { id: 'local-user' } }
    })
    const requireBootstrap = <T,>(value: T) => () => bootstrapped
      ? Promise.resolve(value)
      : Promise.reject(new Error('authentication_failed'))
    mocks.getCatalog.mockImplementation(requireBootstrap(configured.catalog))
    mocks.listConnections.mockImplementation(requireBootstrap(configured.connections))
    mocks.listAssignments.mockImplementation(requireBootstrap(configured.assignments))
    mocks.getImageGenerationStatus.mockImplementation(requireBootstrap(configured.status))

    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1)}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={vi.fn()}
        />
      )
    })
    openImageGenerationPanel(renderer)

    expect(mocks.bootstrapRuntime).toHaveBeenCalledTimes(1)
    expect(renderer.root.findByType(ImageGenerationConversationPanel).props.statusReady).toBe(true)
  })

  it('resumes the most recently updated image conversation in the main panel', async () => {
    mocks.getConversations.mockResolvedValue({
      conversations: [
        {
          id: 'conversation-latest', projectId: 'project-a', title: 'Latest image conversation',
          createdAt: 10, updatedAt: 30, turnCount: 1
        },
        {
          id: 'conversation-older', projectId: 'project-a', title: 'Older image conversation',
          createdAt: 1, updatedAt: 5, turnCount: 1
        }
      ],
      nextCursor: null
    })
    mocks.getConversationRuns.mockResolvedValue({ runs: [storedImageGenerationRun()], nextCursor: null })

    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1)}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={vi.fn()}
        />
      )
    })
    openImageGenerationPanel(renderer)

    const panel = renderer.root.findByType(ImageGenerationConversationPanel)
    expect(mocks.getConversationRuns).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a',
      conversationId: 'conversation-latest'
    }))
    expect(panel.props.conversationLabel).toBe('Latest image conversation')
    expect(panel.props.turns).toEqual([
      expect.objectContaining({ id: 'run-latest', prompt: 'Remember this image request' })
    ])
  })

  it('keeps an explicitly new conversation blank when history finishes loading later', async () => {
    let resolveConversations!: (value: {
      conversations: Array<Record<string, unknown>>
      nextCursor: null
    }) => void
    mocks.getConversations.mockReturnValue(new Promise(resolve => {
      resolveConversations = resolve
    }))

    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1)}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={vi.fn()}
        />
      )
    })
    openImageGenerationPanel(renderer)
    act(() => renderer.root.findByType(ImageGenerationConversationPanel).props.onNewConversation())

    await act(async () => {
      resolveConversations({
        conversations: [{
          id: 'conversation-latest', projectId: 'project-a', title: 'Latest image conversation',
          createdAt: 10, updatedAt: 30, turnCount: 1
        }],
        nextCursor: null
      })
      await Promise.resolve()
    })

    const panel = renderer.root.findByType(ImageGenerationConversationPanel)
    expect(panel.props.turns).toEqual([])
    expect(mocks.getConversationRuns).not.toHaveBeenCalled()
  })

  it('routes as-reference to Agent when the Agent tab is active', async () => {
    const imageNode = createFreeCanvasImageNodeFromMedia({
      id: 'agent-reference-source',
      kind: 'imageAsset',
      title: 'Agent reference image',
      position: { x: 120, y: 160 },
      width: 320,
      height: 240,
      assetId: 'asset-agent-reference.png',
      imageUrl: '/storage-api/assets/asset-agent-reference.png',
      meta: {}
    })
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1, {
            nodes: [imageNode],
            selectedNodeId: imageNode.id
          })}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={vi.fn()}
        />
      )
    })

    const imageNodeData = renderer.root.find(candidate => (
      Array.isArray(candidate.props.nodes) && candidate.props.nodes[0]?.data?.onImageCommand
    )).props.nodes[0].data

    act(() => imageNodeData.onImageCommand(imageNode.id, 'as-reference'))

    const agentPanel = renderer.root.findByProps({ 'data-agent-panel': true })
    expect(agentPanel.props['data-agent-node-id']).toBe(imageNode.id)
    expect(agentPanel.props['data-agent-node-role']).toBe('reference')
    expect(renderer.root.findAllByProps({ 'data-free-canvas-image-generation-panel': true })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
  })

  it('adds an image directly to the Composer when 作为参考 is clicked without opening a workbench', async () => {
    const imageNode = createFreeCanvasImageNodeFromMedia({
      id: 'reference-source',
      kind: 'imageAsset',
      title: '产品参考图',
      position: { x: 120, y: 160 },
      width: 320,
      height: 240,
      assetId: 'asset-reference.png',
      imageUrl: '/storage-api/assets/asset-reference.png',
      meta: {}
    })
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1, {
            nodes: [imageNode],
            selectedNodeId: imageNode.id
          })}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={vi.fn()}
        />
      )
    })

    openImageGenerationPanel(renderer)
    const getImageNodeData = () => renderer.root.find(candidate => (
      Array.isArray(candidate.props.nodes) && candidate.props.nodes[0]?.data?.onImageCommand
    )).props.nodes[0].data

    act(() => getImageNodeData().onImageCommand(imageNode.id, 'as-reference'))

    expect(renderer.root.findAllByProps({ 'aria-label': '查看图1 产品参考图' })).toHaveLength(1)
    expect(renderer.root.findByProps({ 'data-free-canvas-image-generation-panel': true })).toBeTruthy()
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    expect(mocks.requestGeneration).not.toHaveBeenCalled()

    act(() => getImageNodeData().onImageCommand(imageNode.id, 'as-reference'))
    expect(renderer.root.findAllByProps({ 'aria-label': '查看图1 产品参考图' })).toHaveLength(1)

    act(() => renderer.root.findByProps({
      'aria-label': '从参考图列表移除图1 产品参考图'
    }).props.onClick({ stopPropagation: vi.fn() }))

    expect(renderer.root.findAllByProps({ 'aria-label': '查看图1 产品参考图' })).toHaveLength(0)
    expect(getImageNodeData()).toBeTruthy()
    expect(mocks.requestGeneration).not.toHaveBeenCalled()
  })

  it('keeps an empty prompt quiet while leaving generation disabled', async () => {
    configureReadyImageModel()
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1)}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={vi.fn()}
        />
      )
    })

    openImageGenerationPanel(renderer)
    expect(renderer.root.findAllByType('details')).toHaveLength(0)
    expect(renderer.root.findByProps({ type: 'submit' }).props.disabled).toBe(true)
  })

  it('preserves measured node dimensions when canvas selection changes', async () => {
    const node = createFreeCanvasTextNode('Measured node', { x: 120, y: 160 }, 1)
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1, { nodes: [node] })}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={vi.fn()}
        />
      )
    })

    const getReactFlow = () => renderer.root.find(candidate => (
      typeof candidate.props.onNodesChange === 'function' && Array.isArray(candidate.props.nodes)
    ))
    const initialSelectionHandler = getReactFlow().props.onSelectionChange

    act(() => getReactFlow().props.onNodesChange([{
      id: node.id,
      type: 'dimensions',
      dimensions: { width: 420, height: 180 }
    }]))
    expect(getReactFlow().props.nodes[0].measured).toEqual({ width: 420, height: 180 })

    act(() => getReactFlow().props.onSelectionChange({
      nodes: [getReactFlow().props.nodes[0]],
      edges: []
    }))

    expect(getReactFlow().props.onSelectionChange).toBe(initialSelectionHandler)
    expect(getReactFlow().props.nodes[0].measured).toEqual({ width: 420, height: 180 })
  })

  it('selects only a toolbar-created text node and deletes that visual selection', async () => {
    const existing = createFreeCanvasTextNode('Existing selection', { x: 120, y: 160 }, 1)
    const activeProject = { id: 'project-a', title: 'Project A' } as IPromptProject
    const onChange = vi.fn()
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const props = {
      activeProject,
      imageGenerationNodeV1: true,
      onBack: vi.fn(),
      onRenameProject: vi.fn(),
      onSave: vi.fn(),
      onChange
    }
    let canvas = createFreeCanvasProject(1, { nodes: [existing], selectedNodeId: existing.id })
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<FreeCanvasBuilderScreen {...props} freeCanvas={canvas} />)
    })

    const getReactFlow = () => renderer.root.find(candidate => (
      typeof candidate.props.onNodesChange === 'function' && Array.isArray(candidate.props.nodes)
    ))
    const textButton = renderer.root.findAllByType('button').find(candidate => candidate.props.title === 'Text')!

    act(() => textButton.props.onClick())
    canvas = onChange.mock.calls[onChange.mock.calls.length - 1][0]
    const created = canvas.nodes.find(node => node.id !== existing.id)!
    await act(async () => {
      renderer.update(<FreeCanvasBuilderScreen {...props} freeCanvas={canvas} />)
    })

    expect(getReactFlow().props.nodes.filter((node: { selected?: boolean }) => node.selected).map((node: { id: string }) => node.id))
      .toEqual([created.id])

    const keydownHandlers = vi.mocked(window.addEventListener).mock.calls
      .filter(([eventName]) => eventName === 'keydown')
      .map(([, handler]) => handler as EventListener)
    const event = {
      key: 'Delete',
      target: null,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent

    act(() => keydownHandlers.forEach(handler => handler(event)))

    const deletedCanvas = onChange.mock.calls[onChange.mock.calls.length - 1][0]
    expect(event.preventDefault).toHaveBeenCalled()
    expect(deletedCanvas.nodes.map((node: { id: string }) => node.id)).toEqual([existing.id])
    expect(deletedCanvas.selectedNodeId).toBeNull()
  })

  it('promotes a React Flow selection to canonical selection after the pane clears it', async () => {
    const node = createFreeCanvasTextNode('React Flow selection', { x: 120, y: 160 }, 1)
    const activeProject = { id: 'project-a', title: 'Project A' } as IPromptProject
    const onChange = vi.fn()
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const props = {
      activeProject,
      imageGenerationNodeV1: true,
      onBack: vi.fn(),
      onRenameProject: vi.fn(),
      onSave: vi.fn(),
      onChange
    }
    let canvas = createFreeCanvasProject(1, { nodes: [node], selectedNodeId: node.id })
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<FreeCanvasBuilderScreen {...props} freeCanvas={canvas} />)
    })

    const getReactFlow = () => renderer.root.find(candidate => (
      typeof candidate.props.onNodesChange === 'function' && Array.isArray(candidate.props.nodes)
    ))

    act(() => getReactFlow().props.onPaneClick())
    canvas = onChange.mock.calls[onChange.mock.calls.length - 1][0]
    expect(canvas.selectedNodeId).toBeNull()
    await act(async () => {
      renderer.update(<FreeCanvasBuilderScreen {...props} freeCanvas={canvas} />)
    })

    act(() => getReactFlow().props.onSelectionChange({
      nodes: [getReactFlow().props.nodes[0]],
      edges: []
    }))
    const selectedCanvas = onChange.mock.calls[onChange.mock.calls.length - 1][0]
    expect(selectedCanvas.selectedNodeId).toBe(node.id)
    expect(getReactFlow().props.nodes.filter((candidate: { selected?: boolean }) => candidate.selected))
      .toHaveLength(1)

    const keydownHandlers = vi.mocked(window.addEventListener).mock.calls
      .filter(([eventName]) => eventName === 'keydown')
      .map(([, handler]) => handler as EventListener)
    const event = {
      key: 'Delete',
      target: null,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent

    act(() => keydownHandlers.forEach(handler => handler(event)))

    const deletedCanvas = onChange.mock.calls[onChange.mock.calls.length - 1][0]
    expect(event.preventDefault).toHaveBeenCalled()
    expect(deletedCanvas.nodes).toEqual([])
    expect(deletedCanvas.selectedNodeId).toBeNull()
  })

  it('deletes the selected text node with Backspace outside text editing', async () => {
    const node = createFreeCanvasTextNode('Delete me', { x: 120, y: 160 }, 1)
    const onChange = vi.fn()
    const canvas = {
      ...createFreeCanvasProject(1, { nodes: [node] }),
      selectedNodeId: node.id
    }
    vi.stubGlobal('HTMLElement', class HTMLElement {})

    await act(async () => {
      create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={canvas}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
        />
      )
    })
    onChange.mockClear()

    const keydownHandlers = vi.mocked(window.addEventListener).mock.calls
      .filter(([eventName]) => eventName === 'keydown')
      .map(([, handler]) => handler as EventListener)
    const event = {
      key: 'Backspace',
      target: null,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent

    act(() => keydownHandlers.forEach(handler => handler(event)))

    expect(event.preventDefault).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [],
      selectedNodeId: null
    }))
  })

  it('stages a target label without injecting text and can stage a reference label', async () => {
    const node = createFreeCanvasTextNode('待补全的文字节点', { x: 120, y: 160 }, 1)
    const canvas = {
      ...createFreeCanvasProject(1, { nodes: [node] }),
      selectedNodeId: node.id
    }
    const onChange = vi.fn()
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    let renderer!: ReturnType<typeof create>

    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={canvas}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
        />
      )
    })
    onChange.mockClear()

    const reactFlow = renderer.root.find(candidate => (
      typeof candidate.props.onNodeContextMenu === 'function' && Array.isArray(candidate.props.nodes)
    ))
    act(() => reactFlow.props.onNodeContextMenu({
      preventDefault: vi.fn(),
      clientX: 240,
      clientY: 180,
      currentTarget: null
    }, reactFlow.props.nodes[0]))

    const menu = renderer.root.findByProps({ 'aria-label': '文字节点菜单' })
    const labels = menu.findAllByType('button').map(button => button.findAllByType('span')[1]?.children[0])
    expect(labels).toEqual(expect.arrayContaining(['复制', '补全', '发送到 Agent', '发送到图片生成参考', '删除']))
    expect(onChange).not.toHaveBeenCalled()

    const complete = menu.findAllByType('button').find(button => (
      button.findAllByType('span').some(span => span.children.includes('补全'))
    ))!
    act(() => complete.props.onClick())

    const panel = renderer.root.findByProps({ 'data-agent-panel': true })
    expect(panel.props['data-agent-draft']).toBe('')
    expect(panel.props['data-agent-node-id']).toBe(node.id)
    expect(panel.props['data-agent-node-role']).toBe('target')
    expect(panel.props['data-agent-node-mode']).toBe('complete')

    act(() => reactFlow.props.onNodeContextMenu({
      preventDefault: vi.fn(),
      clientX: 240,
      clientY: 180,
      currentTarget: null
    }, reactFlow.props.nodes[0]))
    const referenceMenu = renderer.root.findByProps({ 'aria-label': '文字节点菜单' })
    const sendToAgent = referenceMenu.findAllByType('button').find(button => (
      button.findAllByType('span').some(span => span.children.includes('发送到 Agent'))
    ))!
    act(() => sendToAgent.props.onClick())

    const referencePanel = renderer.root.findByProps({ 'data-agent-panel': true })
    expect(referencePanel.props['data-agent-draft']).toBe('')
    expect(referencePanel.props['data-agent-node-id']).toBe(node.id)
    expect(referencePanel.props['data-agent-node-role']).toBe('reference')

    act(() => reactFlow.props.onNodeContextMenu({
      preventDefault: vi.fn(),
      clientX: 240,
      clientY: 180,
      currentTarget: null
    }, reactFlow.props.nodes[0]))
    const imageReferenceMenu = renderer.root.findByProps({ 'aria-label': '文字节点菜单' })
    const sendToImageGeneration = imageReferenceMenu.findAllByType('button').find(button => (
      button.findAllByType('span').some(span => span.children.includes('发送到图片生成参考'))
    ))!
    act(() => sendToImageGeneration.props.onClick())

    expect(renderer.root.findByProps({ 'data-free-canvas-image-generation-panel': true })).toBeTruthy()
  })

  it('keeps text styling controls collapsed and renders a readable rename input', async () => {
    const node = { ...createFreeCanvasTextNode('Body', { x: 120, y: 160 }, 1), title: '完整节点名称' }
    const canvas = { ...createFreeCanvasProject(1, { nodes: [node] }), selectedNodeId: node.id }
    const onChange = vi.fn()
    let renderer!: ReturnType<typeof create>

    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={canvas}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
        />
      )
    })

    const reactFlow = renderer.root.find(candidate => (
      typeof candidate.props.onNodeContextMenu === 'function' && Array.isArray(candidate.props.nodes)
    ))
    const TextNode = reactFlow.props.nodeTypes.freeCanvasNode
    let nodeRenderer!: ReturnType<typeof create>
    await act(async () => {
      nodeRenderer = create(<TextNode data={reactFlow.props.nodes[0].data} selected />)
    })
    expect(nodeRenderer.root.findByProps({ 'data-free-canvas-text-title': true }).children).toEqual(['完整节点名称'])
    expect(nodeRenderer.root.findAllByProps({ 'data-free-canvas-font-size-menu': true })).toHaveLength(0)
    expect(nodeRenderer.root.findAllByProps({ 'data-free-canvas-color-menu': true })).toHaveLength(0)

    act(() => nodeRenderer.root.findByProps({ 'aria-label': '文本大小' }).props.onClick())
    const fontSizeMenu = nodeRenderer.root.findByProps({ 'data-free-canvas-font-size-menu': true })
    expect(fontSizeMenu.findAllByProps({ 'data-free-canvas-font-size-option': true })).toHaveLength(5)
    act(() => fontSizeMenu.findByProps({ 'data-font-size': 'huge' }).props.onClick())
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({ id: node.id, fontSize: 'huge' })]
    }))

    act(() => nodeRenderer.root.findByProps({ 'aria-label': '文字颜色' }).props.onClick())
    const colorMenu = nodeRenderer.root.findByProps({ 'data-free-canvas-color-menu': true })
    expect(colorMenu.findAllByProps({ 'data-free-canvas-color-option': true })).toHaveLength(10)
    act(() => colorMenu.findByProps({ 'data-color': '#3b82f6' }).props.onClick())
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({
        id: node.id,
        segments: [expect.objectContaining({ color: '#3b82f6' })]
      })]
    }))

    act(() => nodeRenderer.root.findByProps({ 'aria-label': '重命名文字节点' }).props.onClick())
    const input = nodeRenderer.root.findByProps({ 'aria-label': '文字节点名称' })
    expect(input.props.className).toContain('bg-white')
    expect(input.props.className).toContain('text-gray-950')
    act(() => input.props.onChange({ target: { value: '新的节点名称' } }))
    act(() => input.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() }))

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({ id: node.id, title: '新的节点名称' })]
    }))
  })

  it('leaves editable text content unmanaged by React while editing', async () => {
    const node = createFreeCanvasTextNode('Editable body', { x: 120, y: 160 }, 1)
    const canvas = { ...createFreeCanvasProject(1, { nodes: [node] }), selectedNodeId: node.id }
    let renderer!: ReturnType<typeof create>

    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={canvas}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={vi.fn()}
        />
      )
    })

    const reactFlow = renderer.root.find(candidate => (
      typeof candidate.props.onNodeContextMenu === 'function' && Array.isArray(candidate.props.nodes)
    ))
    const TextNode = reactFlow.props.nodeTypes.freeCanvasNode
    let nodeRenderer!: ReturnType<typeof create>
    await act(async () => {
      nodeRenderer = create(
        <TextNode data={{ ...reactFlow.props.nodes[0].data, editing: true }} selected />
      )
    })

    const editor = nodeRenderer.root.findByProps({ 'data-free-canvas-text-content': true })
    expect(editor.props.contentEditable).toBe(true)
    expect(editor.children).toHaveLength(0)
  })

  it('applies append proposals as a new user segment and rejects stale selection rewrites', async () => {
    const node = createFreeCanvasTextNode('Original', { x: 120, y: 160 }, 10)
    const canvas = { ...createFreeCanvasProject(1, { nodes: [node] }), selectedNodeId: node.id }
    const onChange = vi.fn()
    const alert = vi.fn()
    ;(window as unknown as { alert: typeof alert }).alert = alert
    let renderer!: ReturnType<typeof create>

    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={canvas}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
        />
      )
    })
    const apply = renderer.root.findByProps({ 'data-agent-panel': true }).props['data-agent-apply']
    await act(async () => apply({
      kind: 'free_canvas_text_update',
      nodeId: node.id,
      editMode: 'append',
      userText: 'Added',
      baseNodeRevision: 10
    }))
    const appended = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0]
    expect(appended.nodes[0].segments.map((segment: { text: string }) => segment.text)).toEqual(['Original', 'Added'])

    onChange.mockClear()
    await act(async () => apply({
      kind: 'free_canvas_text_update',
      nodeId: node.id,
      editMode: 'rewrite_selection',
      userText: 'Changed',
      selection: { start: 0, end: 4, selectedText: 'Wrong' },
      baseNodeRevision: 10
    }))
    expect(onChange).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalled()
  })

  it('applies a direct source-bound rewrite as a collision-free derived node', async () => {
    const source = {
      ...createFreeCanvasTextNode('Original', { x: 120, y: 160 }, 10),
      id: 'source-text',
      title: 'Shot prompt',
      width: 560,
      height: 220,
      fontSize: 'huge' as const
    }
    const blocker = {
      ...createFreeCanvasTextNode('Blocking', { x: 728, y: 160 }, 11),
      id: 'blocking-text',
      title: 'Shot prompt · 改写'
    }
    const canvas = createFreeCanvasProject(1, { nodes: [source, blocker], selectedNodeId: source.id })
    const onChange = vi.fn()
    let renderer!: ReturnType<typeof create>

    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={canvas}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
        />
      )
    })

    const apply = renderer.root.findByProps({ 'data-agent-panel': true }).props['data-agent-apply-canvas-edit']
    const templateDigest = await sha256({ presetText: '', segments: [] })
    const baseSegmentsDigest = await sha256(source.segments.map(segment => ({
      id: segment.id,
      source: segment.source,
      text: segment.text,
      color: segment.color
    })))
    await act(async () => apply({
      kind: 'free_canvas_text_create',
      sourceNodeId: source.id,
      userText: 'Rewritten',
      basis: { baseNodeRevision: 10, templateDigest, baseSegmentsDigest }
    }))

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      selectedNodeId: expect.any(String),
      nodes: expect.arrayContaining([
        expect.objectContaining({
          kind: 'text',
          title: 'Shot prompt · 改写 (2)',
          position: { x: 728, y: 404 },
          width: 560,
          height: 220,
          fontSize: 'huge',
          segments: [expect.objectContaining({ source: 'user', text: 'Rewritten', color: '#111827' })],
          meta: expect.objectContaining({
            provenance: expect.objectContaining({ kind: 'agent-rewrite', sourceNodeId: source.id })
          })
        })
      ])
    }))
  })

  it('persists a generated result node before marking its placement as placed', async () => {
    const onChange = vi.fn()
    const onPersistCanvas = vi.fn().mockResolvedValue(true)
    mocks.getPendingPlacements.mockResolvedValue([{
      runId: 'run-1',
      projectId: 'project-a',
      conversationId: 'conversation-1',
      assetId: 'asset-1',
      state: 'pending',
      createdAt: 1,
      updatedAt: 1
    }])

    await act(async () => {
      create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1)}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
          onPersistCanvas={onPersistCanvas}
        />
      )
    })

    expect(onChange).toHaveBeenCalled()
    const persistedCanvas = onPersistCanvas.mock.calls[0][0]
    expect(persistedCanvas.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assetId: 'asset-1',
        meta: expect.objectContaining({
          generationRunId: 'run-1',
          conversationId: 'conversation-1'
        })
      })
    ]))
    expect(mocks.markPlacementPlaced).toHaveBeenCalledWith('run-1', 'free-image-generation-run-1')
    expect(onPersistCanvas.mock.invocationCallOrder[0]).toBeLessThan(mocks.markPlacementPlaced.mock.invocationCallOrder[0])
  })

  it('creates and saves a movable placeholder before starting the provider request', async () => {
    configureReadyImageModel()
    const onChange = vi.fn()
    let finishPlaceholderSave: ((saved: boolean) => void) | undefined
    const onPersistCanvas = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishPlaceholderSave = resolve }))
      .mockResolvedValue(true)
    let finishGeneration: ((result: Record<string, unknown>) => void) | undefined
    mocks.requestGeneration.mockImplementation(() => new Promise(resolve => { finishGeneration = resolve }))
    let renderer!: ReturnType<typeof create>

    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1)}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
          onPersistCanvas={onPersistCanvas}
        />
      )
    })
    openImageGenerationPanel(renderer)
    const prompt = renderer.root.findByProps({ 'aria-label': '图片描述' })
    await act(async () => {
      prompt.props.onInput({ currentTarget: promptEditorWithText('A red apple') })
      await Promise.resolve()
    })
    expect(renderer.root.findByProps({ type: 'submit' }).props.disabled).toBe(false)
    const form = renderer.root.findAllByType('form')[0]
    await act(async () => {
      form.props.onSubmit({ preventDefault: vi.fn() })
      await Promise.resolve()
    })

    const placeholderCanvas = onChange.mock.calls[0][0]
    const placeholder = placeholderCanvas.nodes[0]
    expect(placeholder).toMatchObject({
      id: expect.stringMatching(/^free-image-generation-image-run-[0-9a-f]{32}$/),
      width: 320,
      height: 320,
      meta: { generationState: 'running' }
    })
    expect(onPersistCanvas).toHaveBeenCalledWith(placeholderCanvas)
    expect(mocks.requestGeneration).not.toHaveBeenCalled()

    await act(async () => {
      finishPlaceholderSave?.(true)
      await Promise.resolve()
    })
    expect(mocks.requestGeneration).toHaveBeenCalledWith(expect.objectContaining({
      runId: placeholder.meta.generationRunId
    }))

    await act(async () => {
      finishGeneration?.({
        runId: placeholder.meta.generationRunId,
        state: 'succeeded',
        assetId: 'asset-output.png',
        captureId: 'capture-output',
        contentType: 'image/png',
        width: 1024,
        height: 1024
      })
      await Promise.resolve()
    })
  })

  it('does not start the provider request when placeholder persistence fails', async () => {
    configureReadyImageModel()
    const onChange = vi.fn()
    const onPersistCanvas = vi.fn().mockResolvedValue(false)
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1)}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
          onPersistCanvas={onPersistCanvas}
        />
      )
    })
    openImageGenerationPanel(renderer)
    const prompt = renderer.root.findByProps({ 'aria-label': '图片描述' })
    await act(async () => {
      prompt.props.onInput({ currentTarget: promptEditorWithText('A red apple') })
      await Promise.resolve()
    })
    expect(renderer.root.findByProps({ type: 'submit' }).props.disabled).toBe(false)
    await act(async () => {
      renderer.root.findAllByType('form')[0].props.onSubmit({ preventDefault: vi.fn() })
      await Promise.resolve()
    })

    expect(mocks.requestGeneration).not.toHaveBeenCalled()
    expect(onChange.mock.calls[onChange.mock.calls.length - 1][0].nodes[0]).toMatchObject({
      meta: { generationState: 'failed', generationErrorCode: 'storage_write_failed' }
    })
  })

  it('persists all multi-view placeholders and prepares all runs before any generation request', async () => {
    configureReadyImageModel()
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const source = createFreeCanvasImageNodeFromMedia({
      id: 'node-source',
      kind: 'imageAsset',
      title: 'Source',
      position: { x: 100, y: 120 },
      width: 320,
      height: 320,
      assetId: 'asset-source.png',
      imageUrl: '/storage-api/assets/asset-source.png',
      imagePrompt: '',
      sourceNodeId: null,
      generatedFromAgent: false,
      crop: null,
      text: '',
      color: '#111827',
      meta: {}
    })
    const canvas = {
      ...createFreeCanvasProject(1, { nodes: [source] }),
      selectedNodeId: source.id
    }
    const onChange = vi.fn()
    const onPersistCanvas = vi.fn().mockResolvedValue(true)
    mocks.prepareGeneration.mockRejectedValue(new Error('storage unavailable'))
    let renderer!: ReturnType<typeof create>

    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={canvas}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
          onPersistCanvas={onPersistCanvas}
        />
      )
    })
    const reactFlow = renderer.root.find(candidate => (
      typeof candidate.props.onNodeContextMenu === 'function' && Array.isArray(candidate.props.nodes)
    ))
    await act(async () => {
      reactFlow.props.nodes[0].data.onImageCommand(source.id, 'multi-view')
      await Promise.resolve()
    })
    const dialog = renderer.root.findByProps({ 'data-image-operation-workbench': 'multi-view' })
    await act(async () => {
      dialog.findByType('textarea').props.onChange({ target: { value: 'Keep the same product identity' } })
    })
    const generate = dialog.findByProps({ 'aria-label': 'Generate 3' })
    await act(async () => {
      generate.props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })

    const persistedGroup = onPersistCanvas.mock.calls[0][0]
    const placeholders = persistedGroup.nodes.filter((node: { meta: { generationRunId?: string } }) => (
      Boolean(node.meta.generationRunId)
    ))
    expect(placeholders).toHaveLength(3)
    expect(mocks.prepareGeneration).toHaveBeenCalledWith(expect.arrayContaining(
      placeholders.map((node: { meta: { generationRunId: string } }) => expect.objectContaining({
        runId: node.meta.generationRunId
      }))
    ))
    expect(onPersistCanvas.mock.invocationCallOrder[0]).toBeLessThan(mocks.prepareGeneration.mock.invocationCallOrder[0])
    expect(mocks.requestGeneration).not.toHaveBeenCalled()
    const failedGroup = onChange.mock.calls[onChange.mock.calls.length - 1][0]
    expect(failedGroup.nodes.filter((node: { meta: { generationState?: string } }) => (
      node.meta.generationState === 'failed'
    ))).toHaveLength(3)
  })

  it('hides the selected multi-view result panel while the project resource library is expanded', async () => {
    const placeholder = createFreeCanvasImageGenerationPlaceholder({
      runId: 'image-run-left',
      conversationId: 'image-operation-image-run-left',
      prompt: 'left view',
      position: { x: 468, y: 120 },
      width: 320,
      height: 320
    })
    const member = {
      ...placeholder,
      id: 'node-left',
      meta: {
        ...placeholder.meta,
        generationState: 'running' as const,
        operationGroupId: 'group-1',
        operationItemId: 'item-left',
        operationViewSpec: 'left'
      }
    }
    const canvas = {
      ...createFreeCanvasProject(1, { nodes: [member] }),
      selectedNodeId: member.id
    }
    let renderer!: ReturnType<typeof create>

    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={canvas}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={vi.fn()}
        />
      )
    })

    expect(renderer.root.findAllByType(MultiViewGroupPanel)).toHaveLength(1)
    act(() => renderer.root.findByType(ProjectResourceLibrary).props.onExpandedChange(true))
    expect(renderer.root.findAllByType(MultiViewGroupPanel)).toHaveLength(0)
  })

  it('rejects retry tampering and replaces only the selected failed node when lineage is duplicated', async () => {
    configureReadyImageModel()
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const source = createFreeCanvasImageNodeFromMedia({
      id: 'node-source',
      kind: 'imageAsset',
      title: 'Source',
      position: { x: 100, y: 120 },
      width: 320,
      height: 320,
      assetId: 'asset-source.png',
      imageUrl: '/storage-api/assets/asset-source.png',
      imagePrompt: '',
      sourceNodeId: null,
      generatedFromAgent: false,
      crop: null,
      text: '',
      color: '#111827',
      meta: {}
    })
    const failedMember = {
      ...createFreeCanvasImageGenerationPlaceholder({
        runId: 'image-run-failed',
        conversationId: 'image-operation-image-run-failed',
        prompt: 'left view',
        position: { x: 468, y: 120 },
        width: 320,
        height: 320
      }),
      id: 'node-left',
      meta: {
        generationRunId: 'image-run-failed',
        conversationId: 'image-operation-image-run-failed',
        generationState: 'failed' as const,
        generationErrorCode: 'test_provider_failure',
        source: 'image-generation-conversation',
        sourceCanvasNodeId: source.id,
        operationGroupId: 'group-1',
        operationItemId: 'item-left',
        operationViewSpec: 'left'
      }
    }
    const duplicateFailedMember = {
      ...failedMember,
      id: 'node-left-duplicate',
      position: { x: 836, y: 120 },
      meta: {
        ...failedMember.meta,
        generationRunId: 'image-run-failed-duplicate',
        conversationId: 'image-operation-image-run-failed-duplicate'
      }
    }
    const secondSource = createFreeCanvasImageNodeFromMedia({
      id: 'node-source-2',
      kind: 'imageAsset',
      title: 'Second source',
      position: { x: 100, y: 500 },
      width: 320,
      height: 320,
      assetId: 'asset-source-2.png',
      imageUrl: '/storage-api/assets/asset-source-2.png',
      imagePrompt: '',
      sourceNodeId: null,
      generatedFromAgent: false,
      crop: null,
      text: '',
      color: '#111827',
      meta: {}
    })
    const secondFailedMember = {
      ...createFreeCanvasImageGenerationPlaceholder({
        runId: 'image-run-failed-2',
        conversationId: 'image-operation-image-run-failed-2',
        prompt: 'top view',
        position: { x: 468, y: 500 },
        width: 320,
        height: 320
      }),
      id: 'node-top-2',
      meta: {
        generationRunId: 'image-run-failed-2',
        conversationId: 'image-operation-image-run-failed-2',
        generationState: 'failed' as const,
        generationErrorCode: 'test_provider_failure',
        source: 'image-generation-conversation',
        sourceCanvasNodeId: secondSource.id,
        operationGroupId: 'group-2',
        operationItemId: 'item-top-2',
        operationViewSpec: 'top'
      }
    }
    const canvas = {
      ...createFreeCanvasProject(1, { nodes: [source, failedMember, duplicateFailedMember, secondSource, secondFailedMember] }),
      selectedNodeId: duplicateFailedMember.id
    }
    const onPersistCanvas = vi.fn().mockResolvedValue(true)
    let renderer!: ReturnType<typeof create>

    await act(async () => {
      renderer = create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={canvas}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={vi.fn()}
          onPersistCanvas={onPersistCanvas}
        />
      )
    })
    const retryButtons = renderer.root.findAllByType('button')
      .filter(button => button.children.includes('重试此视角'))
    const retry = retryButtons[retryButtons.length - 1]
    await act(async () => {
      retry?.props.onClick()
      await Promise.resolve()
    })
    const workbench = renderer.root.findByType(MultiViewWorkbenchDialog)

    await expect(workbench.props.onGenerate({
      ...workbench.props.initialDraft,
      operationGroupId: 'group-2',
      operationItemId: 'item-top-2',
      viewSpec: 'top'
    }, ['top']))
      .rejects.toThrow('重试只能提交原失败视角。')
    await expect(workbench.props.onGenerate({
      ...workbench.props.initialDraft,
      source: {
        ...workbench.props.initialDraft.source,
        nodeId: secondSource.id,
        originalAssetId: 'asset-source-2.png',
        canvasAssetId: 'asset-source-2.png',
        providerAssetId: 'asset-source-2.png'
      }
    }, ['left']))
      .rejects.toThrow('重试只能提交原失败视角。')
    expect(onPersistCanvas).not.toHaveBeenCalled()
    expect(mocks.prepareGeneration).not.toHaveBeenCalled()
    expect(mocks.requestGeneration).not.toHaveBeenCalled()

    await act(async () => {
      await workbench.props.onGenerate(workbench.props.initialDraft, ['left'])
    })

    const persistedCanvas = onPersistCanvas.mock.calls[0][0] as IFreeCanvasProject
    expect(persistedCanvas.nodes.find(node => node.id === failedMember.id)).toMatchObject({
      id: failedMember.id,
      meta: {
        generationRunId: 'image-run-failed',
        generationState: 'failed'
      }
    })
    expect(persistedCanvas.nodes.find(node => node.id === duplicateFailedMember.id)).toMatchObject({
      id: duplicateFailedMember.id,
      meta: {
        generationState: 'running',
        operationGroupId: 'group-1',
        operationItemId: 'item-left',
        operationViewSpec: 'left'
      }
    })
    expect(persistedCanvas.nodes.find(node => node.id === duplicateFailedMember.id)?.meta.generationRunId)
      .not.toBe('image-run-failed-duplicate')
  })

  it('keeps persisted multi-view placeholders running while batch preparation is pending', async () => {
    configureReadyImageModel()
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const source = createFreeCanvasImageNodeFromMedia({
      id: 'node-source',
      kind: 'imageAsset',
      title: 'Source',
      position: { x: 100, y: 120 },
      width: 320,
      height: 320,
      assetId: 'asset-source.png',
      imageUrl: '/storage-api/assets/asset-source.png',
      imagePrompt: '',
      sourceNodeId: null,
      generatedFromAgent: false,
      crop: null,
      text: '',
      color: '#111827',
      meta: {}
    })
    const initialCanvas: IFreeCanvasProject = {
      ...createFreeCanvasProject(1, { nodes: [source] }),
      selectedNodeId: source.id
    }
    const persistedCanvases: IFreeCanvasProject[] = []
    const onPersistCanvas = vi.fn(async (nextCanvas: IFreeCanvasProject) => {
      persistedCanvases.push(nextCanvas)
      return true
    })
    mocks.prepareGeneration.mockImplementation(() => new Promise(() => undefined))

    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas)
      return (
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={canvas}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={setCanvas}
          onPersistCanvas={async nextCanvas => {
            const saved = await onPersistCanvas(nextCanvas)
            setCanvas(nextCanvas)
            return saved
          }}
        />
      )
    }

    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<Harness />)
    })
    const reactFlow = renderer.root.find(candidate => (
      typeof candidate.props.onNodeContextMenu === 'function' && Array.isArray(candidate.props.nodes)
    ))
    await act(async () => {
      reactFlow.props.nodes[0].data.onImageCommand(source.id, 'multi-view')
      await Promise.resolve()
    })
    const dialog = renderer.root.findByProps({ 'data-image-operation-workbench': 'multi-view' })
    await act(async () => {
      dialog.findByType('textarea').props.onChange({ target: { value: 'Keep the same product identity' } })
      await Promise.resolve()
    })
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Generate 3' }).props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.prepareGeneration).toHaveBeenCalledTimes(1)
    const latestCanvas = persistedCanvases[persistedCanvases.length - 1]
    const placeholders = latestCanvas.nodes.filter(node => Boolean(node.meta.generationRunId))
    expect(placeholders).toHaveLength(3)
    expect(mocks.getRunById.mock.calls).toEqual(expect.arrayContaining(
      placeholders.map(node => [node.meta.generationRunId, 'project-a'])
    ))
    expect(placeholders.every(node => node.meta.generationState === 'running')).toBe(true)
    expect(placeholders.every(node => node.meta.generationErrorCode !== 'generation_run_missing')).toBe(true)
    expect(onPersistCanvas.mock.invocationCallOrder[0]).toBeLessThan(mocks.prepareGeneration.mock.invocationCallOrder[0])
    expect(mocks.requestGeneration).not.toHaveBeenCalled()

    await act(async () => {
      renderer.unmount()
    })
  })

  it('hydrates an existing generation node in place before marking the placement', async () => {
    const runId = 'image-run-0123456789abcdef0123456789abcdef'
    const placeholder = createFreeCanvasImageGenerationPlaceholder({
      runId,
      conversationId: 'conversation-1',
      prompt: 'A red apple',
      position: { x: 450, y: 330 },
      width: 480,
      height: 270
    })
    const onChange = vi.fn()
    const onPersistCanvas = vi.fn().mockResolvedValue(true)
    mocks.getRunById.mockResolvedValue({ id: runId, state: 'running', outputAssetIds: [] })
    mocks.getPendingPlacements.mockResolvedValue([{
      runId,
      projectId: 'project-a',
      conversationId: 'conversation-1',
      assetId: 'asset-output.png',
      state: 'pending',
      createdAt: 1,
      updatedAt: 1
    }])

    await act(async () => {
      create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1, { nodes: [placeholder] })}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
          onPersistCanvas={onPersistCanvas}
        />
      )
    })

    const hydratedCanvas = onPersistCanvas.mock.calls.find(call => call[0].nodes[0]?.assetId === 'asset-output.png')?.[0]
    expect(hydratedCanvas.nodes).toHaveLength(1)
    expect(hydratedCanvas.nodes[0]).toMatchObject({
      id: placeholder.id,
      position: { x: 450, y: 330 },
      width: 480,
      height: 270,
      assetId: 'asset-output.png',
      meta: { generationState: 'succeeded', generatedResult: true }
    })
    expect(mocks.markPlacementPlaced).toHaveBeenCalledWith(runId, placeholder.id)
    expect(mocks.requestGeneration).not.toHaveBeenCalled()
  })

  it('restores a persisted running node as failed when the stored run failed', async () => {
    const runId = 'image-run-fedcba9876543210fedcba9876543210'
    const placeholder = createFreeCanvasImageGenerationPlaceholder({
      runId,
      conversationId: 'conversation-1',
      prompt: 'A red apple',
      position: { x: 100, y: 120 },
      width: 320,
      height: 320
    })
    mocks.getRunById.mockResolvedValue({
      id: runId,
      state: 'failed',
      outputAssetIds: [],
      error: { code: 'rate_limited', message: 'provider detail', retryable: true }
    })
    const onChange = vi.fn()
    const onPersistCanvas = vi.fn().mockResolvedValue(true)

    await act(async () => {
      create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1, { nodes: [placeholder] })}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
          onPersistCanvas={onPersistCanvas}
        />
      )
    })

    const reconciledNode = onChange.mock.calls[onChange.mock.calls.length - 1][0].nodes[0]
    expect(reconciledNode).toMatchObject({
      id: placeholder.id,
      position: placeholder.position,
      meta: { generationState: 'failed', generationErrorCode: 'rate_limited' }
    })
    expect(reconciledNode.meta).not.toHaveProperty('providerMessage')
    expect(onPersistCanvas).toHaveBeenCalled()
  })

  it('resumes an authorized queued multi-view member once from its immutable snapshot', async () => {
    const runId = 'image-run-0123456789abcdef0123456789abcdef'
    const placeholder = createFreeCanvasImageGenerationPlaceholder({
      runId,
      conversationId: `image-operation-${runId}`,
      prompt: 'front view',
      position: { x: 100, y: 120 },
      width: 320,
      height: 320
    })
    const queuedRun = storedImageGenerationRun({
      id: runId,
      nodeId: 'node-source',
      conversationId: undefined,
      state: 'queued',
      outputAssetIds: [],
      requestSnapshot: {
        mode: 'edit',
        promptOptimization: 'standard',
        promptDocument: { version: 1, segments: [{ type: 'text', text: 'front view' }] },
        inputAssets: [{
          referenceId: 'source', role: 'source-image', assetId: 'asset-provider',
          sourceAssetId: 'asset-original', order: 0
        }],
        regions: [],
        resolution: '2K',
        aspectRatio: '1:1',
        outputFormat: 'png',
        watermark: false,
        operation: {
          operation: 'multi-view',
          recipeId: 'multi-view/product-turntable',
          recipeVersion: '1',
          source: {
            nodeId: 'node-source', originalAssetId: 'asset-original',
            canvasAssetId: 'asset-canvas', providerAssetId: 'asset-provider'
          },
          preservationIntents: ['keep identity'],
          parameters: { view: 'front' },
          operationGroupId: 'group-1',
          operationItemId: 'item-1',
          viewSpec: 'front'
        }
      }
    })
    mocks.getRunById.mockResolvedValue(queuedRun)
    mocks.requestGeneration.mockResolvedValue({
      runId,
      state: 'succeeded',
      assetId: 'asset-resumed.png',
      captureId: 'capture-resumed',
      contentType: 'image/png',
      width: 1024,
      height: 1024
    })
    const onChange = vi.fn()
    const onPersistCanvas = vi.fn().mockResolvedValue(true)

    await act(async () => {
      create(
        <FreeCanvasBuilderScreen
          activeProject={{ id: 'project-a', title: 'Project A' } as IPromptProject}
          freeCanvas={createFreeCanvasProject(1, { nodes: [placeholder] })}
          imageGenerationNodeV1
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={onChange}
          onPersistCanvas={onPersistCanvas}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.requestGeneration).toHaveBeenCalledTimes(1)
    expect(mocks.requestGeneration).toHaveBeenCalledWith(expect.objectContaining({
      runId,
      nodeId: 'node-source',
      operation: expect.objectContaining({
        operation: 'multi-view',
        operationGroupId: 'group-1',
        viewSpec: 'front'
      })
    }))
    const completedCanvas = onChange.mock.calls[onChange.mock.calls.length - 1][0]
    expect(completedCanvas.nodes).toHaveLength(1)
    expect(completedCanvas.nodes[0].id).toBe(placeholder.id)
  })
})
