import { Fragment, useState, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDocumentChangeOperations } from '@/domain/documents/document-suggestions'
import { createPlanningDocumentV1, planningDocumentEffectiveText, sha256Utf8 } from '@/domain/documents/planning-document'
import { storyboardDigest } from '@/domain/storyboard/canvas-storyboard'
import type { AgentCanvasEdit } from '@/models/Agent.model'
import type { IFreeCanvasDocumentNode, IFreeCanvasImageNode, IFreeCanvasProject, IFreeCanvasStoryboardNode, IFreeCanvasTextNode, IPromptProject, IStoryboardSequence, PlanningDocumentV1, StoryboardSourceProvenance } from '@/models/PromptHistory.model'

const windowListeners = new Map<string, Set<(event: KeyboardEvent) => void>>()

const mocks = vi.hoisted(() => ({
  useRealDocumentNode: false,
  bootstrapRuntime: vi.fn(),
  getCatalog: vi.fn(),
  listConnections: vi.fn(),
  listAssignments: vi.fn(),
  getImageGenerationStatus: vi.fn(),
  getConversations: vi.fn(),
  getConversationRuns: vi.fn(),
  getPendingPlacements: vi.fn(),
  acknowledgeDocumentEdit: vi.fn(),
  reconcileDocumentEdits: vi.fn(),
  agentCanvasEdit: null as AgentCanvasEdit | null
}))

vi.mock('@/components/canvas/document/DocumentEditor', () => ({
  DocumentEditor: ({ document, mode, onChange }: {
    document: PlanningDocumentV1
    mode: string
    onChange: (document: PlanningDocumentV1) => void
  }) => (
    <button
      type="button"
      aria-label="真实节点编辑文档 B"
      data-real-document-editor={mode}
      data-document-text={planningDocumentEffectiveText(document)}
      onClick={() => onChange(createPlanningDocumentV1([{
        id: document.blocks[0]?.id || 'document-paragraph',
        type: 'paragraph',
        content: [{ text: 'B' }]
      }], document.revision + 1))}
    >Edit real node</button>
  )
}))

vi.mock('@xyflow/react', () => {
  const PassThrough = ({ children }: { children?: ReactNode }) => <Fragment>{children}</Fragment>
  const reactFlow = { screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }) }
  const ReactFlow = ({ nodes, nodeTypes, onSelectionChange, onNodesChange, children }: {
    nodes: Array<{ id: string; type: string; data: Record<string, unknown>; selected?: boolean; draggable?: boolean; connectable?: boolean; deletable?: boolean }>
    nodeTypes: Record<string, (props: Record<string, unknown>) => ReactNode>
    onSelectionChange?: (selection: { nodes: Array<{ id: string }> }) => void
    onNodesChange?: (changes: Array<{ type: 'remove'; id: string }>) => void
    children?: ReactNode
  }) => (
    <div data-mock-react-flow>
      <button
        type="button"
        aria-label="测试选择前两个画布节点"
        onClick={() => onSelectionChange?.({ nodes: nodes.slice(0, 2) })}
      >Select first two</button>
      <button
        type="button"
        aria-label="测试选择最后一个画布节点"
        onClick={() => onSelectionChange?.({ nodes: nodes.slice(-1) })}
      >Select last</button>
      <button
        type="button"
        aria-label="测试选择第二个画布节点"
        onClick={() => onSelectionChange?.({ nodes: nodes.slice(1, 2) })}
      >Select second</button>
      <button
        type="button"
        aria-label="测试清空画布选择"
        onClick={() => onSelectionChange?.({ nodes: [] })}
      >Clear selection</button>
      <button
        type="button"
        aria-label="测试 ReactFlow 删除首个节点"
        onClick={() => nodes[0] && onNodesChange?.([{ type: 'remove', id: nodes[0].id }])}
      >Remove first</button>
      {nodes.map(node => {
        const Component = nodeTypes[node.type]
        return (
          <div
            key={node.id}
            data-flow-node={node.id}
            data-draggable={node.draggable}
            data-connectable={node.connectable}
            data-deletable={node.deletable}
          >
            <Component data={node.data} selected={node.selected || false} />
          </div>
        )
      })}
      {children}
    </div>
  )
  return {
    Background: () => null,
    BackgroundVariant: { Lines: 'lines' },
    Controls: () => null,
    Handle: () => null,
    MiniMap: () => null,
    NodeResizer: () => null,
    NodeToolbar: PassThrough,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    ReactFlow,
    ReactFlowProvider: PassThrough,
    SelectionMode: { Partial: 'partial' },
    applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
    useReactFlow: () => reactFlow,
    useStore: (selector: (state: { nodes: unknown[]; transform: [number, number, number] }) => unknown) => selector({ nodes: [], transform: [0, 0, 1] })
  }
})

vi.mock('@/components/canvas/nodes/DocumentNode', async importOriginal => {
  const original = await importOriginal<typeof import('@/components/canvas/nodes/DocumentNode')>()
  const MockDocumentNode = ({ node, locked, onDocumentChange, onCollapsedChange, onDelete }: {
    node: IFreeCanvasDocumentNode
    locked?: boolean
    onDocumentChange: (document: PlanningDocumentV1) => Promise<boolean> | boolean
    onCollapsedChange?: (collapsed: boolean) => Promise<boolean> | boolean
    onDelete: () => void
  }) => (
    <div
      data-screen-document-node={node.id}
      data-document-text={planningDocumentEffectiveText(node.document)}
      data-document-collapsed={node.meta.collapsed === true}
      data-document-locked={locked === true}
    >
      <button
        type="button"
        aria-label="测试编辑文档"
        onClick={() => onDocumentChange(createPlanningDocumentV1([
          { id: `${node.id}-paragraph`, type: 'paragraph', content: [{ text: 'After' }] }
        ], node.document.revision + 1))}
      >Edit</button>
      {(['A', 'B'] as const).map(text => (
        <button
          key={text}
          type="button"
          aria-label={`测试编辑文档 ${text}`}
          onClick={() => onDocumentChange(createPlanningDocumentV1([
            { id: `${node.id}-paragraph`, type: 'paragraph', content: [{ text }] }
          ], node.document.revision + 1))}
        >Edit {text}</button>
      ))}
      <button type="button" aria-label="测试折叠文档" onClick={() => onCollapsedChange?.(true)}>Collapse</button>
      <button type="button" aria-label="测试删除文档" onClick={onDelete}>Delete</button>
    </div>
  )
  return {
    DocumentNode: (props: Parameters<typeof original.DocumentNode>[0]) => (
      mocks.useRealDocumentNode
        ? <original.DocumentNode {...props} />
        : <MockDocumentNode {...props} />
    )
  }
})

vi.mock('@/components/AgentCollaborationPanel', () => ({
  AIChatbotBox: ({ onApplyCanvasEdit, onDocumentReconcileStateChange, draftRequest }: {
    onApplyCanvasEdit?: (edit: AgentCanvasEdit) => Promise<boolean | void> | boolean | void
    onDocumentReconcileStateChange?: (state: {
      projectId: string
      conversationId: string
      leaseId: string
      pending: boolean
      nodeId?: string
    }) => Promise<void> | void
    draftRequest?: { documentWriteContext?: { operationKind: string; documentNodeId?: string; nodeId?: string } }
  }) => (
    <div
      data-agent-draft-operation={draftRequest?.documentWriteContext?.operationKind}
      data-agent-draft-document={draftRequest?.documentWriteContext?.documentNodeId}
      data-agent-draft-node={draftRequest?.documentWriteContext?.nodeId}
    >
      <button
        type="button"
        aria-label="测试开始 Document reconcile"
        onClick={() => onDocumentReconcileStateChange?.({
          projectId: 'project-1', conversationId: 'conversation-restart',
          leaseId: 'lease-a-1', pending: true, nodeId: 'document-1'
        })}
      >Start reconcile</button>
      <button
        type="button"
        aria-label="测试结束 Document reconcile"
        onClick={() => onDocumentReconcileStateChange?.({
          projectId: 'project-1', conversationId: 'conversation-restart',
          leaseId: 'lease-a-1', pending: false
        })}
      >Finish reconcile</button>
      <button
        type="button"
        aria-label="测试开始第二代 Document reconcile"
        onClick={() => onDocumentReconcileStateChange?.({
          projectId: 'project-1', conversationId: 'conversation-restart',
          leaseId: 'lease-a-2', pending: true, nodeId: 'document-1'
        })}
      >Start second reconcile</button>
      <button
        type="button"
        aria-label="测试结束第二代 Document reconcile"
        onClick={() => onDocumentReconcileStateChange?.({
          projectId: 'project-1', conversationId: 'conversation-restart',
          leaseId: 'lease-a-2', pending: false
        })}
      >Finish second reconcile</button>
      {mocks.agentCanvasEdit && (
        <button
          type="button"
          aria-label="测试应用 Agent Document 编辑"
          onClick={() => onApplyCanvasEdit?.(mocks.agentCanvasEdit as AgentCanvasEdit)}
        >Apply agent Document edit</button>
      )}
    </div>
  )
}))
vi.mock('@/components/PromptLibraryPreviewMode', () => ({ PromptLibraryPreviewPanel: () => <div /> }))
vi.mock('@/components/prompt-media/PromptPresetPreviewDialog', () => ({ PromptPresetPreviewDialog: () => null }))
vi.mock('@/components/canvas/ImageCropEditor', () => ({ ImageCropEditor: () => null }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ cardTypeLabel: (value: string) => value }) }))
vi.mock('@/stores/preset.store', () => ({
  usePresetStore: () => ({ presets: [], initialized: true, init: vi.fn(), addPreset: vi.fn(), updatePreset: vi.fn(), deletePreset: vi.fn() })
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
    bootstrap: mocks.bootstrapRuntime,
    acknowledgeDocumentEdit: mocks.acknowledgeDocumentEdit,
    reconcileDocumentEdits: mocks.reconcileDocumentEdits
  }
}))
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
      imageGenerationPlacements: {
        ...original.storageServiceClient.imageGenerationPlacements,
        getPending: mocks.getPendingPlacements
      }
    }
  }
})

import { FreeCanvasBuilderScreen } from './FreeCanvasBuilderScreen'

const documentNode = (id = 'document-1', text = 'Before'): IFreeCanvasDocumentNode => ({
  id,
  kind: 'document',
  title: `Creative brief ${id}`,
  position: { x: 40, y: 50 },
  width: 560,
  height: 420,
  document: createPlanningDocumentV1([
    { id: `${id}-paragraph`, type: 'paragraph', content: [{ text }] }
  ]),
  linkedDocumentResourceIds: [],
  meta: {}
})

const project = (freeCanvas: IFreeCanvasProject, id = 'project-1'): IPromptProject => ({
  id,
  title: 'Document project',
  type: 'free-canvas',
  revision: 1,
  pages: [],
  currentPage: 0,
  freeCanvas,
  createdAt: 1,
  updatedAt: 2,
  lastOpenedAt: 2,
  meta: {}
})

const initialCanvas = (): IFreeCanvasProject => ({
  nodes: [documentNode()],
  edges: [],
  viewport: null,
  selectedNodeId: 'document-1',
  meta: {}
})

const twoDocumentCanvas = (): IFreeCanvasProject => ({
  ...initialCanvas(),
  nodes: [documentNode('document-1', 'Before A'), documentNode('document-2', 'Before B')]
})

const renderedDocument = (renderer: ReturnType<typeof create>, id: string) =>
  renderer.root.findByProps({ 'data-screen-document-node': id })

const canvasDocumentTexts = (canvas: IFreeCanvasProject): Record<string, string> => Object.fromEntries(
  canvas.nodes.flatMap(node => node.kind === 'document'
    ? [[node.id, planningDocumentEffectiveText(node.document)] as const]
    : [])
)

const unrelatedTextNode = (): IFreeCanvasTextNode => ({
  id: 'async-text-1',
  kind: 'text',
  title: 'Async result',
  position: { x: 700, y: 80 },
  width: 320,
  height: 160,
  fontSize: 'medium',
  segments: [{
    id: 'async-segment-1', source: 'user', text: 'Unrelated async node', color: '#111827', createdAt: 1, updatedAt: 1
  }],
  meta: {}
})

const unrelatedImageNode = (): IFreeCanvasImageNode => ({
  id: 'async-image-1',
  kind: 'image',
  title: 'Async image',
  position: { x: 520, y: 80 },
  width: 320,
  height: 240,
  assetId: 'asset-before',
  annotations: [],
  meta: {}
})

const storyboardSequence = (): IStoryboardSequence => ({
  id: 'sequence-1', name: 'Opening', description: 'An opening', style: 'ink', constraints: '',
  rows: [{
    id: 'row-1', cutLabel: '1', timeRange: '0-3s', subject: 'Mara', action: 'enters',
    scene: 'hall', camera: 'wide', lighting: 'dawn', audio: '', duration: '3s', createdAt: 1, updatedAt: 1
  }],
  createdAt: 1, updatedAt: 1, meta: {}
})

const storyboardSource = (): StoryboardSourceProvenance => ({
  documentNodeId: 'document-1', documentRevision: 0,
  documentDigest: `sha256:${'a'.repeat(64)}`, documentResourceDigests: [],
  model: { connectionId: 'connection-1', providerId: 'provider-1', modelId: 'model-1' },
  skills: [{ skillId: 'skill-1', revision: 2, digest: `sha256:${'b'.repeat(64)}` }]
})

const storyboardCreateEdit = (): AgentCanvasEdit => {
  const sequence = storyboardSequence()
  return {
    kind: 'storyboard_create', id: 'edit-storyboard', editId: 'edit-storyboard',
    conversationId: 'conversation-1', requestId: 'request-storyboard', nodeId: 'storyboard-created',
    expectedResultDigest: storyboardDigest(sequence, []), base: { projectRevision: 1 },
    payload: { title: 'Opening shots', sequence, source: storyboardSource() },
    rationale: 'Create shots from the effective document.'
  }
}

const pendingStoryboardNode = (): IFreeCanvasStoryboardNode => {
  const sequence = storyboardSequence()
  const pendingFieldChanges = [{
    id: 'change-camera', editId: 'edit-change', scope: 'row' as const, rowId: 'row-1', field: 'camera' as const,
    previousValue: 'wide', newValue: 'close-up'
  }]
  return {
    id: 'storyboard-review', kind: 'storyboard', title: 'Review shots', position: { x: 40, y: 50 },
    width: 680, height: 440, sequence, source: storyboardSource(), pendingFieldChanges,
    revision: 1, digest: storyboardDigest(sequence, pendingFieldChanges), meta: {}
  }
}

const mixedDocumentImageCanvas = (): IFreeCanvasProject => ({
  ...initialCanvas(),
  nodes: [documentNode(), unrelatedImageNode(), unrelatedTextNode()],
  edges: [
    { id: 'edge-document-image', source: 'document-1', target: 'async-image-1', createdAt: 1 },
    { id: 'edge-image-text', source: 'async-image-1', target: 'async-text-1', createdAt: 2 }
  ]
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

const dispatchWindowKey = async (key: string, options: Partial<KeyboardEvent> = {}) => {
  const event = {
    key,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    preventDefault: vi.fn(),
    ...options
  } as unknown as KeyboardEvent
  await act(async () => {
    windowListeners.get('keydown')?.forEach(listener => listener(event))
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
  return event
}

describe('FreeCanvasBuilderScreen Document integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useRealDocumentNode = false
    mocks.agentCanvasEdit = null
    windowListeners.clear()
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event: KeyboardEvent) => void) => {
        const listeners = windowListeners.get(type) || new Set()
        listeners.add(listener)
        windowListeners.set(type, listeners)
      }),
      removeEventListener: vi.fn((type: string, listener: (event: KeyboardEvent) => void) => {
        windowListeners.get(type)?.delete(listener)
      }),
      setTimeout, clearTimeout,
      innerWidth: 1200, innerHeight: 800
    })
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn(), activeElement: null })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    mocks.bootstrapRuntime.mockResolvedValue({ user: { id: 'local-user' } })
    mocks.getCatalog.mockResolvedValue({ providers: [], models: [] })
    mocks.listConnections.mockResolvedValue([])
    mocks.listAssignments.mockResolvedValue([])
    mocks.getImageGenerationStatus.mockResolvedValue({ serverEnabled: false, checkedAt: 1, credentialStore: { available: true }, providers: [] })
    mocks.getConversations.mockResolvedValue({ conversations: [], nextCursor: null })
    mocks.getConversationRuns.mockResolvedValue({ runs: [], nextCursor: null })
    mocks.getPendingPlacements.mockResolvedValue([])
    mocks.acknowledgeDocumentEdit.mockResolvedValue({ status: 'applied', editId: 'edit-1' })
    mocks.reconcileDocumentEdits.mockResolvedValue({ status: 'idle', canvasEdits: [] })
  })

  it('atomically persists a tracked Document change and its applied marker before ACK', async () => {
    const canvas = initialCanvas()
    const source = canvas.nodes[0] as IFreeCanvasDocumentNode
    const operation = {
      kind: 'insert' as const,
      blockId: 'document-1-paragraph',
      utf8Offset: new TextEncoder().encode('Before').length,
      text: '!',
      expectedTextDigest: `sha256:${sha256Utf8('Before')}`
    }
    const expectedDocument = applyDocumentChangeOperations(source.document, 'edit-1', [operation])
    mocks.agentCanvasEdit = {
      kind: 'document_changes',
      id: 'edit-1',
      editId: 'edit-1',
      conversationId: 'conversation-1',
      requestId: 'request-1',
      nodeId: 'document-1',
      expectedResultDigest: expectedDocument.digest,
      base: { projectRevision: 1, nodeRevision: source.document.revision, nodeDigest: source.document.digest },
      payload: { operations: [operation] },
      rationale: 'Tighten the opening.'
    }
    const onPersistCanvas = vi.fn().mockResolvedValue(true)
    const Harness = () => {
      const [current, setCurrent] = useState(canvas)
      return <FreeCanvasBuilderScreen
        activeProject={project(current)} freeCanvas={current}
        onBack={vi.fn()} onRenameProject={vi.fn()} onSave={vi.fn()}
        onChange={setCurrent} onPersistCanvas={onPersistCanvas}
      />
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '测试应用 Agent Document 编辑' }).props.onClick()
    })

    const saved = onPersistCanvas.mock.calls[0][0] as IFreeCanvasProject
    const savedNode = saved.nodes[0] as IFreeCanvasDocumentNode
    expect(planningDocumentEffectiveText(savedNode.document)).toBe('Before!')
    expect(savedNode.agentAppliedEdit).toEqual({
      conversationId: 'conversation-1', requestId: 'request-1', editId: 'edit-1', resultDigest: expectedDocument.digest
    })
    expect(mocks.acknowledgeDocumentEdit.mock.invocationCallOrder[0])
      .toBeGreaterThan(onPersistCanvas.mock.invocationCallOrder[0])
  })

  it('requires the explicit Document action before binding a Storyboard create request', async () => {
    const canvas = initialCanvas()
    const renderer = create(
      <FreeCanvasBuilderScreen
        activeProject={project(canvas)} freeCanvas={canvas}
        onBack={vi.fn()} onRenameProject={vi.fn()} onSave={vi.fn()}
        onChange={vi.fn()} onPersistCanvas={vi.fn().mockResolvedValue(true)}
      />
    )

    expect(renderer.root.findByProps({ 'data-agent-draft-operation': undefined })).toBeTruthy()
    act(() => renderer.root.findByProps({ 'aria-label': '从文档 Creative brief document-1 创建分镜表' }).props.onClick())

    expect(renderer.root.findByProps({ 'data-agent-draft-operation': 'storyboard_create' }).props)
      .toMatchObject({ 'data-agent-draft-document': 'document-1' })
  })

  it('uses the production Storyboard revision action to request and directly apply storyboard_changes', async () => {
    const clean = pendingStoryboardNode()
    clean.pendingFieldChanges = []
    clean.digest = storyboardDigest(clean.sequence, [])
    const expectedChanges = [{
      id: 'sbf-edit-storyboard-change-0', editId: 'edit-storyboard-change', scope: 'row' as const,
      rowId: 'row-1', field: 'camera' as const, previousValue: 'wide', newValue: 'close-up'
    }]
    mocks.agentCanvasEdit = {
      kind: 'storyboard_changes', id: 'edit-storyboard-change', editId: 'edit-storyboard-change',
      conversationId: 'conversation-1', requestId: 'request-storyboard-change', nodeId: clean.id,
      expectedResultDigest: storyboardDigest(clean.sequence, expectedChanges),
      base: { projectRevision: 1, nodeRevision: clean.revision!, nodeDigest: clean.digest },
      payload: { changes: [{ scope: 'row', rowId: 'row-1', field: 'camera', value: 'close-up' }] },
      rationale: 'Revise camera'
    }
    const canvas = { ...initialCanvas(), nodes: [clean] }
    const onPersistCanvas = vi.fn().mockResolvedValue(true)
    const Harness = () => {
      const [current, setCurrent] = useState<IFreeCanvasProject>(canvas)
      return <FreeCanvasBuilderScreen
        activeProject={project(current)} freeCanvas={current}
        onBack={vi.fn()} onRenameProject={vi.fn()} onSave={vi.fn()}
        onChange={setCurrent} onPersistCanvas={onPersistCanvas}
      />
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    expect(renderer.root.findByProps({ 'data-agent-draft-operation': undefined })).toBeTruthy()
    act(() => renderer.root.findByProps({ 'aria-label': '让 Agent 修订分镜表 Review shots' }).props.onClick())

    expect(renderer.root.findByProps({ 'data-agent-draft-operation': 'storyboard_changes' }).props)
      .toMatchObject({ 'data-agent-draft-document': undefined, 'data-agent-draft-node': 'storyboard-review' })
    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '测试应用 Agent Document 编辑' }).props.onClick()
    })
    const saved = onPersistCanvas.mock.calls[0][0] as IFreeCanvasProject
    expect(saved.nodes[0]).toMatchObject({
      kind: 'storyboard', pendingFieldChanges: expectedChanges,
      agentAppliedEdit: expect.objectContaining({ editId: 'edit-storyboard-change' })
    })
  })

  it('persists an idempotent Storyboard create marker before ACK and reconciles a lost ACK', async () => {
    mocks.agentCanvasEdit = storyboardCreateEdit()
    mocks.acknowledgeDocumentEdit.mockRejectedValue(new Error('response lost'))
    const onPersistCanvas = vi.fn().mockResolvedValue(true)
    const Harness = () => {
      const [current, setCurrent] = useState<IFreeCanvasProject>({ ...initialCanvas(), nodes: [] })
      return <FreeCanvasBuilderScreen
        activeProject={project(current)} freeCanvas={current}
        onBack={vi.fn()} onRenameProject={vi.fn()} onSave={vi.fn()}
        onChange={setCurrent} onPersistCanvas={onPersistCanvas}
      />
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })
    const apply = () => renderer.root.findByProps({ 'aria-label': '测试应用 Agent Document 编辑' }).props.onClick()

    await act(async () => { await apply() })
    await act(async () => { await apply() })

    expect(onPersistCanvas).toHaveBeenCalledTimes(1)
    const saved = onPersistCanvas.mock.calls[0][0] as IFreeCanvasProject
    const storyboard = saved.nodes.find(node => node.id === 'storyboard-created') as IFreeCanvasStoryboardNode
    expect(storyboard.agentAppliedEdit).toEqual({
      conversationId: 'conversation-1', requestId: 'request-storyboard', editId: 'edit-storyboard',
      resultDigest: storyboard.digest
    })
    expect(mocks.acknowledgeDocumentEdit.mock.invocationCallOrder[0])
      .toBeGreaterThan(onPersistCanvas.mock.invocationCallOrder[0])
    expect(mocks.reconcileDocumentEdits).toHaveBeenCalledWith('project-1', 'conversation-1')
    expect(renderer.root.findAllByProps({ 'aria-label': '分镜表：Opening shots' })).toHaveLength(1)

    await dispatchWindowKey('z')
    expect(renderer.root.findAllByProps({ 'aria-label': '分镜表：Opening shots' })).toHaveLength(0)
  })

  it('rolls back an unsaved Storyboard direct apply and sends a bounded failed ACK', async () => {
    mocks.agentCanvasEdit = storyboardCreateEdit()
    const onPersistCanvas = vi.fn().mockResolvedValue(false)
    const Harness = () => {
      const [current, setCurrent] = useState<IFreeCanvasProject>({ ...initialCanvas(), nodes: [] })
      return <FreeCanvasBuilderScreen
        activeProject={project(current)} freeCanvas={current}
        onBack={vi.fn()} onRenameProject={vi.fn()} onSave={vi.fn()}
        onChange={setCurrent} onPersistCanvas={onPersistCanvas}
      />
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '测试应用 Agent Document 编辑' }).props.onClick()
    })

    expect(renderer.root.findAllByProps({ 'aria-label': '分镜表：Opening shots' })).toHaveLength(0)
    expect(mocks.acknowledgeDocumentEdit).toHaveBeenCalledWith(
      'project-1', 'conversation-1', 'edit-storyboard',
      { requestId: 'request-storyboard', status: 'failed', errorCode: 'save_failed' }
    )
    expect(mocks.acknowledgeDocumentEdit.mock.invocationCallOrder[0])
      .toBeGreaterThan(onPersistCanvas.mock.invocationCallOrder[0])
  })

  it('persists a single Storyboard field acceptance and makes the review resolution undoable', async () => {
    const onPersistCanvas = vi.fn().mockResolvedValue(true)
    const Harness = () => {
      const [current, setCurrent] = useState<IFreeCanvasProject>({
        ...initialCanvas(), nodes: [pendingStoryboardNode()], selectedNodeId: 'storyboard-review'
      })
      return <FreeCanvasBuilderScreen
        activeProject={project(current)} freeCanvas={current}
        onBack={vi.fn()} onRenameProject={vi.fn()} onSave={vi.fn()}
        onChange={setCurrent} onPersistCanvas={onPersistCanvas}
      />
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '接受 camera 修改' }).props.onClick()
      for (let index = 0; index < 5; index += 1) await Promise.resolve()
    })

    const saved = onPersistCanvas.mock.calls[0][0] as IFreeCanvasProject
    const accepted = saved.nodes[0] as IFreeCanvasStoryboardNode
    expect(accepted.sequence.rows[0].camera).toBe('close-up')
    expect(accepted.pendingFieldChanges).toEqual([])

    await dispatchWindowKey('z')
    expect(JSON.stringify(renderer.toJSON())).toContain('wide')
    expect(renderer.root.findByProps({ 'aria-label': '接受 camera 修改' })).toBeTruthy()
  })

  it('keeps the saved marker when the advisory ACK response is lost and does not apply a duplicate twice', async () => {
    const createdDocument = createPlanningDocumentV1([
      { id: 'created-paragraph', type: 'paragraph', content: [{ text: 'Created' }] }
    ])
    mocks.agentCanvasEdit = {
      kind: 'document_create', id: 'edit-create', editId: 'edit-create',
      conversationId: 'conversation-1', requestId: 'request-create', nodeId: 'document-created',
      expectedResultDigest: createdDocument.digest, base: { projectRevision: 1 },
      payload: { title: 'Created document', blocks: createdDocument.blocks, linkedDocumentResourceIds: [] },
      rationale: 'Create the draft.'
    }
    mocks.acknowledgeDocumentEdit.mockRejectedValue(new Error('response lost'))
    const onPersistCanvas = vi.fn().mockResolvedValue(true)
    const Harness = () => {
      const [current, setCurrent] = useState<IFreeCanvasProject>({ ...initialCanvas(), nodes: [] })
      return <FreeCanvasBuilderScreen
        activeProject={project(current)} freeCanvas={current}
        onBack={vi.fn()} onRenameProject={vi.fn()} onSave={vi.fn()}
        onChange={setCurrent} onPersistCanvas={onPersistCanvas}
      />
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })
    const apply = () => renderer.root.findByProps({ 'aria-label': '测试应用 Agent Document 编辑' }).props.onClick()

    await act(async () => { await apply() })
    await act(async () => { await apply() })

    expect(onPersistCanvas).toHaveBeenCalledTimes(1)
    expect(mocks.reconcileDocumentEdits).toHaveBeenCalledWith('project-1', 'conversation-1')
    const created = renderedDocument(renderer, 'document-created')
    expect(created.props['data-document-text']).toBe('Created')

    await dispatchWindowKey('z')

    expect(onPersistCanvas).toHaveBeenCalledTimes(2)
    expect(renderer.root.findAllByProps({ 'data-screen-document-node': 'document-created' })).toHaveLength(0)
  })

  it('rejects a stale Document base without persisting and reports a bounded conflict', async () => {
    const canvas = initialCanvas()
    const source = canvas.nodes[0] as IFreeCanvasDocumentNode
    mocks.agentCanvasEdit = {
      kind: 'document_changes', id: 'edit-stale', editId: 'edit-stale',
      conversationId: 'conversation-1', requestId: 'request-stale', nodeId: 'document-1',
      expectedResultDigest: `sha256:${'b'.repeat(64)}`,
      base: { projectRevision: 1, nodeRevision: source.document.revision, nodeDigest: `sha256:${'c'.repeat(64)}` },
      payload: { operations: [{
        kind: 'insert', blockId: 'document-1-paragraph', utf8Offset: 0, text: 'No',
        expectedTextDigest: `sha256:${sha256Utf8('Before')}`
      }] },
      rationale: 'Stale update.'
    }
    const onPersistCanvas = vi.fn().mockResolvedValue(true)
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<FreeCanvasBuilderScreen
        activeProject={project(canvas)} freeCanvas={canvas}
        onBack={vi.fn()} onRenameProject={vi.fn()} onSave={vi.fn()}
        onChange={vi.fn()} onPersistCanvas={onPersistCanvas}
      />)
    })

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '测试应用 Agent Document 编辑' }).props.onClick()
    })

    expect(onPersistCanvas).not.toHaveBeenCalled()
    expect(mocks.acknowledgeDocumentEdit).toHaveBeenCalledWith(
      'project-1', 'conversation-1', 'edit-stale',
      { requestId: 'request-stale', status: 'failed', errorCode: 'failed_conflict' }
    )
  })

  it('exposes a discoverable Document action and creates one canonical Document node', async () => {
    const onPersistCanvas = vi.fn().mockResolvedValue(true)
    const Harness = () => {
      const [canvas, setCanvas] = useState<IFreeCanvasProject>({ ...initialCanvas(), nodes: [] })
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)}
          freeCanvas={canvas}
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={setCanvas}
          onPersistCanvas={onPersistCanvas}
        />
      )
    }
    const renderer = create(<Harness />)

    await act(async () => renderer.root.findByProps({ title: 'Document' }).props.onClick())

    const created = renderer.root.findAll(node => node.props['data-screen-document-node'])[0]
    expect(created?.props['data-document-text']).toBe('')
    expect(onPersistCanvas).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({ kind: 'document' })]
    }))
  })

  it('makes Document movable and deletable but never connectable', () => {
    const canvas = initialCanvas()
    const renderer = create(
      <FreeCanvasBuilderScreen
        activeProject={project(canvas)}
        freeCanvas={canvas}
        onBack={vi.fn()}
        onRenameProject={vi.fn()}
        onSave={vi.fn()}
        onChange={vi.fn()}
        onPersistCanvas={vi.fn().mockResolvedValue(true)}
      />
    )

    expect(renderer.root.findByProps({ 'data-flow-node': 'document-1' }).props).toMatchObject({
      'data-draggable': true,
      'data-connectable': false,
      'data-deletable': true
    })
  })

  it('rolls back a failed update and replaces the retained request with the recovery snapshot', async () => {
    const persistedTexts: string[] = []
    const onPersistCanvas = vi.fn(async (canvas: IFreeCanvasProject) => {
      const node = canvas.nodes.find(candidate => candidate.kind === 'document') as IFreeCanvasDocumentNode
      persistedTexts.push(planningDocumentEffectiveText(node.document))
      return persistedTexts.length > 1
    })
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)}
          freeCanvas={canvas}
          onBack={vi.fn()}
          onRenameProject={vi.fn()}
          onSave={vi.fn()}
          onChange={setCanvas}
          onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => renderer.root.findByProps({ 'aria-label': '测试编辑文档' }).props.onClick())

    expect(persistedTexts).toEqual(['After', 'Before'])
    expect(renderer.root.findByProps({ 'data-screen-document-node': 'document-1' }).props['data-document-text']).toBe('Before')
  })

  it.each(['false', 'throw'] as const)('preserves external Z when its commit and B $outcome settlement share one task before passive effects', async outcome => {
    mocks.useRealDocumentNode = true
    const pendingB = deferred<boolean>()
    const persistedTexts: string[] = []
    let persistCall = 0
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      const current = canvas.nodes.find(candidate => candidate.id === 'document-1') as IFreeCanvasDocumentNode
      persistedTexts.push(planningDocumentEffectiveText(current.document))
      persistCall += 1
      return persistCall === 1 ? pendingB.promise : Promise.resolve(true)
    })
    let publishExternal!: (document: PlanningDocumentV1) => void
    let latestCanvas = initialCanvas()
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      latestCanvas = canvas
      publishExternal = document => setCanvas(current => ({
        ...current,
        nodes: current.nodes.map(node => node.id === 'document-1' && node.kind === 'document'
          ? { ...node, document }
          : node)
      }))
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })
    const authoritativeZ = createPlanningDocumentV1([{
      id: 'document-1-paragraph-z',
      type: 'paragraph',
      content: [{ text: 'Z' }]
    }], 8)

    act(() => renderer.root.findByProps({ 'aria-label': '真实节点编辑文档 B' }).props.onClick())
    expect(persistedTexts).toEqual(['B'])

    if (outcome === 'throw') pendingB.reject(new Error('storage unavailable'))
    else pendingB.resolve(false)
    ;(renderer as unknown as { unstable_flushSync: (callback: () => void) => void })
      .unstable_flushSync(() => publishExternal(authoritativeZ))
    expect(renderer.root.findByProps({ 'data-real-document-editor': 'inline' }).props['data-document-text']).toBe('B')
    try {
      await pendingB.promise
    } catch {
      // The production Screen converts persistence rejection into a failed boolean outcome.
    }
    await Promise.resolve()
    await Promise.resolve()
    await act(async () => { await Promise.resolve() })

    expect(canvasDocumentTexts(latestCanvas)).toEqual({ 'document-1': 'Z' })
    expect(renderer.root.findByProps({ 'data-real-document-editor': 'inline' }).props['data-document-text']).toBe('Z')
    expect(renderer.root.findAllByProps({ 'aria-label': '重试保存文档' })).toHaveLength(0)
    expect(persistedTexts).toEqual(['B'])

    await dispatchWindowKey('z')
    expect(canvasDocumentTexts(latestCanvas)).toEqual({ 'document-1': 'Z' })
    expect(persistedTexts).toEqual(['B'])
  })

  it.each([
    { direction: 'undo', outcome: 'false', authority: 'document' },
    { direction: 'undo', outcome: 'throw', authority: 'missing' },
    { direction: 'redo', outcome: 'false', authority: 'kind' },
    { direction: 'redo', outcome: 'throw', authority: 'document' }
  ] as const)('does not recover stale $direction after external $authority authority and $outcome persistence', async ({ direction, outcome, authority }) => {
    const pendingHistory = deferred<boolean>()
    const persisted: IFreeCanvasProject[] = []
    const failureCall = direction === 'undo' ? 2 : 3
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      persisted.push(canvas)
      return persisted.length === failureCall ? pendingHistory.promise : Promise.resolve(true)
    })
    let latestCanvas = initialCanvas()
    let publishExternal!: () => void
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      latestCanvas = canvas
      publishExternal = () => setCanvas(current => ({
        ...current,
        nodes: authority === 'missing'
          ? current.nodes.filter(node => node.id !== 'document-1')
          : current.nodes.map(node => {
            if (node.id !== 'document-1') return node
            if (authority === 'kind') return { ...unrelatedTextNode(), id: node.id }
            return {
              ...node,
              document: createPlanningDocumentV1([{
                id: 'document-1-external-z', type: 'paragraph', content: [{ text: 'Z' }]
              }], 9)
            }
          })
      }))
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => renderedDocument(renderer, 'document-1').findByProps({ 'aria-label': '测试编辑文档' }).props.onClick())
    if (direction === 'redo') await dispatchWindowKey('z')
    await dispatchWindowKey(direction === 'undo' ? 'z' : 'y')
    expect(persisted).toHaveLength(failureCall)

    act(() => publishExternal())
    await act(async () => {
      if (outcome === 'throw') pendingHistory.reject(new Error('storage unavailable'))
      else pendingHistory.resolve(false)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onPersistCanvas).toHaveBeenCalledTimes(failureCall)
    if (authority === 'document') {
      expect(canvasDocumentTexts(latestCanvas)).toEqual({ 'document-1': 'Z' })
    } else if (authority === 'missing') {
      expect(latestCanvas.nodes.find(node => node.id === 'document-1')).toBeUndefined()
    } else {
      expect(latestCanvas.nodes.find(node => node.id === 'document-1')?.kind).toBe('text')
    }

    await dispatchWindowKey(direction === 'undo' ? 'y' : 'z')
    expect(onPersistCanvas).toHaveBeenCalledTimes(failureCall)
  })

  it.each([
    { outcome: 'false', authority: 'deleted' },
    { outcome: 'throw', authority: 'replaced' }
  ] as const)('preserves an externally $authority created-node authority when create persistence settles with $outcome', async ({ outcome, authority }) => {
    const pendingCreate = deferred<boolean>()
    const onPersistCanvas = vi.fn()
      .mockImplementationOnce(() => pendingCreate.promise)
      .mockResolvedValue(true)
    let latestCanvas = initialCanvas()
    let publishExternal!: (nodeId: string) => void
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      latestCanvas = canvas
      publishExternal = nodeId => setCanvas(current => ({
        ...current,
        nodes: authority === 'deleted'
          ? current.nodes.filter(node => node.id !== nodeId)
          : current.nodes.map(node => node.id === nodeId ? { ...unrelatedTextNode(), id: nodeId } : node)
      }))
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    act(() => { renderer.root.findByProps({ title: 'Document' }).props.onClick() })
    const created = latestCanvas.nodes.find(node => node.id !== 'document-1')
    expect(created?.kind).toBe('document')
    act(() => publishExternal(created!.id))

    await act(async () => {
      if (outcome === 'throw') pendingCreate.reject(new Error('storage unavailable'))
      else pendingCreate.resolve(false)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onPersistCanvas).toHaveBeenCalledTimes(1)
    const current = latestCanvas.nodes.find(node => node.id === created!.id)
    if (authority === 'deleted') expect(current).toBeUndefined()
    else expect(current?.kind).toBe('text')
  })

  it.each([
    { outcome: 'false', authority: 'document' },
    { outcome: 'throw', authority: 'meta' }
  ] as const)('preserves external $authority authority when collapse persistence settles with $outcome', async ({ outcome, authority }) => {
    const pendingCollapse = deferred<boolean>()
    const onPersistCanvas = vi.fn()
      .mockImplementationOnce(() => pendingCollapse.promise)
      .mockResolvedValue(true)
    let latestCanvas = initialCanvas()
    let publishExternal!: () => void
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      latestCanvas = canvas
      publishExternal = () => setCanvas(current => ({
        ...current,
        nodes: current.nodes.map(node => node.id === 'document-1' && node.kind === 'document'
          ? authority === 'document'
            ? {
                ...node,
                document: createPlanningDocumentV1([{
                  id: 'document-1-external-z', type: 'paragraph', content: [{ text: 'Z' }]
                }], 9)
              }
            : { ...node, meta: { ...node.meta, collapsed: false, externalAuthority: 'Z' } }
          : node)
      }))
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    act(() => { renderer.root.findByProps({ 'aria-label': '测试折叠文档' }).props.onClick() })
    act(() => publishExternal())
    await act(async () => {
      if (outcome === 'throw') pendingCollapse.reject(new Error('storage unavailable'))
      else pendingCollapse.resolve(false)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onPersistCanvas).toHaveBeenCalledTimes(1)
    const current = latestCanvas.nodes.find(node => node.id === 'document-1') as IFreeCanvasDocumentNode
    if (authority === 'document') {
      expect(planningDocumentEffectiveText(current.document)).toBe('Z')
      expect(current.meta.collapsed).toBe(true)
    } else {
      expect(current.meta).toMatchObject({ collapsed: false, externalAuthority: 'Z' })
    }
  })

  it.each(['false', 'throw'] as const)('keeps P2 Document mutations independent when same-identity P1 persistence settles with $outcome', async outcome => {
    const pendingP1 = deferred<boolean>()
    const p1Persist = vi.fn()
      .mockImplementationOnce(() => pendingP1.promise)
      .mockResolvedValue(true)
    const p2Persist = vi.fn().mockResolvedValue(true)
    const latestByProject: Record<string, IFreeCanvasProject> = {
      'project-1': initialCanvas(),
      'project-2': initialCanvas()
    }
    const Harness = () => {
      const [activeProjectId, setActiveProjectId] = useState<'project-1' | 'project-2'>('project-1')
      const [canvases, setCanvases] = useState<Record<'project-1' | 'project-2', IFreeCanvasProject>>({
        'project-1': initialCanvas(),
        'project-2': initialCanvas()
      })
      const canvas = canvases[activeProjectId]
      latestByProject[activeProjectId] = canvas
      return (
        <>
          <button type="button" aria-label="切换到项目 P2" onClick={() => setActiveProjectId('project-2')}>P2</button>
          <FreeCanvasBuilderScreen
            activeProject={project(canvas, activeProjectId)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
            onSave={vi.fn()}
            onChange={next => setCanvases(current => ({ ...current, [activeProjectId]: next }))}
            onPersistCanvas={activeProjectId === 'project-1' ? p1Persist : p2Persist}
          />
        </>
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    let p1Edit!: Promise<boolean>
    act(() => { p1Edit = renderer.root.findByProps({ 'aria-label': '测试编辑文档 B' }).props.onClick() })
    expect(p1Persist).toHaveBeenCalledTimes(1)
    await act(async () => renderer.root.findByProps({ 'aria-label': '切换到项目 P2' }).props.onClick())

    let p2Edit!: Promise<boolean>
    act(() => { p2Edit = renderer.root.findByProps({ 'aria-label': '测试编辑文档 B' }).props.onClick() })
    expect(p2Persist).toHaveBeenCalledTimes(1)

    await act(async () => {
      if (outcome === 'throw') pendingP1.reject(new Error('storage unavailable'))
      else pendingP1.resolve(false)
      await Promise.all([p1Edit, p2Edit])
    })

    expect(p1Persist).toHaveBeenCalledTimes(1)
    expect(p2Persist).toHaveBeenCalledTimes(1)
    expect(canvasDocumentTexts(latestByProject['project-2'])).toEqual({ 'document-1': 'B' })
  })

  it('isolates a returning same-id project epoch from its old queued save and undo intent', async () => {
    const oldSave = deferred<boolean>()
    const oldP1Persist = vi.fn()
      .mockImplementationOnce(() => oldSave.promise)
      .mockResolvedValue(true)
    const newP1Persist = vi.fn().mockResolvedValue(true)
    const p2Persist = vi.fn().mockResolvedValue(true)
    const epochA = documentNode('document-1', 'A')
    epochA.document = createPlanningDocumentV1([
      { id: 'document-1-paragraph', type: 'paragraph', content: [{ text: 'A' }] }
    ], 1)
    const epochACanvas: IFreeCanvasProject = {
      ...initialCanvas(),
      nodes: [epochA]
    }
    let latestNewP1 = epochACanvas
    const Harness = () => {
      const [view, setView] = useState<'old-p1' | 'p2' | 'new-p1'>('old-p1')
      const [oldP1, setOldP1] = useState(initialCanvas())
      const [p2, setP2] = useState(initialCanvas())
      const [newP1, setNewP1] = useState(epochACanvas)
      latestNewP1 = newP1
      const activeProjectId = view === 'p2' ? 'project-2' : 'project-1'
      const canvas = view === 'old-p1' ? oldP1 : view === 'p2' ? p2 : newP1
      const setCanvas = view === 'old-p1' ? setOldP1 : view === 'p2' ? setP2 : setNewP1
      const persist = view === 'old-p1' ? oldP1Persist : view === 'p2' ? p2Persist : newP1Persist
      return (
        <>
          <button type="button" aria-label="切换 epoch P2" onClick={() => setView('p2')}>P2</button>
          <button type="button" aria-label="返回新 epoch P1" onClick={() => setView('new-p1')}>P1</button>
          <FreeCanvasBuilderScreen
            activeProject={project(canvas, activeProjectId)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
            onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={persist}
          />
        </>
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    let oldEdit!: Promise<boolean>
    act(() => { oldEdit = renderer.root.findByProps({ 'aria-label': '测试编辑文档 A' }).props.onClick() })
    await dispatchWindowKey('z')
    await act(async () => renderer.root.findByProps({ 'aria-label': '切换 epoch P2' }).props.onClick())
    await act(async () => renderer.root.findByProps({ 'aria-label': '返回新 epoch P1' }).props.onClick())

    let newEdit!: Promise<boolean>
    act(() => { newEdit = renderer.root.findByProps({ 'aria-label': '测试编辑文档 B' }).props.onClick() })
    await act(async () => { await Promise.resolve() })
    expect(newP1Persist).toHaveBeenCalledTimes(1)
    expect(canvasDocumentTexts(latestNewP1)).toEqual({ 'document-1': 'B' })

    await act(async () => {
      oldSave.resolve(false)
      await Promise.all([oldEdit, newEdit])
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })

    expect(oldP1Persist).toHaveBeenCalledTimes(1)
    expect(p2Persist).not.toHaveBeenCalled()
    expect(newP1Persist).toHaveBeenCalledTimes(1)
    expect(canvasDocumentTexts(latestNewP1)).toEqual({ 'document-1': 'B' })

    await dispatchWindowKey('z')
    expect(newP1Persist).toHaveBeenCalledTimes(2)
    expect(canvasDocumentTexts(latestNewP1)).toEqual({ 'document-1': 'A' })
  })

  it('keeps a queued undo bound to Document A when a different Document B edit becomes the current history top', async () => {
    const pendingA = deferred<boolean>()
    const persisted: Array<Record<string, string>> = []
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      persisted.push(canvasDocumentTexts(canvas))
      return persisted.length === 1 ? pendingA.promise : Promise.resolve(true)
    })
    let latestCanvas = twoDocumentCanvas()
    const Harness = () => {
      const [canvas, setCanvas] = useState(twoDocumentCanvas())
      latestCanvas = canvas
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    let editA!: Promise<boolean>
    act(() => {
      editA = renderedDocument(renderer, 'document-1')
        .findByProps({ 'aria-label': '测试编辑文档 A' }).props.onClick()
    })
    await dispatchWindowKey('z')
    let editB!: Promise<boolean>
    act(() => {
      editB = renderedDocument(renderer, 'document-2')
        .findByProps({ 'aria-label': '测试编辑文档 B' }).props.onClick()
    })

    await act(async () => {
      pendingA.resolve(true)
      await Promise.all([editA, editB])
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })

    expect(persisted.slice(0, 3)).toEqual([
      { 'document-1': 'A', 'document-2': 'Before B' },
      { 'document-1': 'Before A', 'document-2': 'Before B' },
      { 'document-1': 'Before A', 'document-2': 'B' }
    ])
    expect(canvasDocumentTexts(latestCanvas)).toEqual({
      'document-1': 'Before A',
      'document-2': 'B'
    })

    await dispatchWindowKey('z')
    expect(canvasDocumentTexts(latestCanvas)).toEqual({
      'document-1': 'Before A',
      'document-2': 'Before B'
    })
    await dispatchWindowKey('y')
    expect(canvasDocumentTexts(latestCanvas)).toEqual({
      'document-1': 'Before A',
      'document-2': 'B'
    })
  })

  it.each(['true', 'false', 'throw'] as const)('executes an immediate redo intent after a queued undo whose persistence settles with $outcome', async outcome => {
    const pendingA = deferred<boolean>()
    const persistedTexts: string[] = []
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      persistedTexts.push(canvasDocumentTexts(canvas)['document-1'] || '<missing>')
      if (persistedTexts.length === 1) return pendingA.promise
      if (persistedTexts.length === 2) {
        if (outcome === 'throw') return Promise.reject(new Error('storage unavailable'))
        return Promise.resolve(outcome === 'true')
      }
      return Promise.resolve(true)
    })
    let latestCanvas = initialCanvas()
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      latestCanvas = canvas
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    let editA!: Promise<boolean>
    act(() => {
      editA = renderer.root.findByProps({ 'aria-label': '测试编辑文档 A' }).props.onClick()
    })
    await dispatchWindowKey('z')
    await dispatchWindowKey('y')

    await act(async () => {
      pendingA.resolve(true)
      await editA
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })

    expect(persistedTexts.slice(0, 3)).toEqual(['A', 'Before', 'A'])
    expect(canvasDocumentTexts(latestCanvas)).toEqual({ 'document-1': 'A' })

    await dispatchWindowKey('z')
    expect(canvasDocumentTexts(latestCanvas)).toEqual({ 'document-1': 'Before' })
    await dispatchWindowKey('y')
    expect(canvasDocumentTexts(latestCanvas)).toEqual({ 'document-1': 'A' })
  })

  it.each([
    { historyStep: 'undo-create', outcome: 'false' },
    { historyStep: 'redo-delete', outcome: 'throw' }
  ] as const)('preserves a newer user selection when failed $historyStep persistence settles with $outcome', async ({ historyStep, outcome }) => {
    const pendingHistory = deferred<boolean>()
    const persisted: Array<{ selectedNodeId: string | null; texts: Record<string, string> }> = []
    let persistenceCall = 0
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      persisted.push({ selectedNodeId: canvas.selectedNodeId || null, texts: canvasDocumentTexts(canvas) })
      persistenceCall += 1
      return persistenceCall === 2 ? pendingHistory.promise : Promise.resolve(true)
    })
    const selectionCanvas: IFreeCanvasProject = {
      ...initialCanvas(),
      nodes: [documentNode(), unrelatedTextNode()]
    }
    let latestCanvas = selectionCanvas
    const Harness = () => {
      const [canvas, setCanvas] = useState(selectionCanvas)
      latestCanvas = canvas
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })
    let affectedNodeId = 'document-1'

    if (historyStep === 'undo-create') {
      await act(async () => {
        renderer.root.findByProps({ title: 'Document' }).props.onClick()
        for (let index = 0; index < 4; index += 1) await Promise.resolve()
      })
      affectedNodeId = latestCanvas.nodes.find(node => (
        node.kind === 'document' && node.id !== 'document-1'
      ))?.id || ''
      await dispatchWindowKey('z')
      act(() => renderer.root.findByProps({ 'aria-label': '测试选择最后一个画布节点' }).props.onClick())
      expect(latestCanvas.selectedNodeId).toBe('async-text-1')
    } else {
      act(() => renderedDocument(renderer, 'document-1')
        .findByProps({ 'aria-label': '测试删除文档' }).props.onClick())
      await dispatchWindowKey('z')
      act(() => renderer.root.findByProps({ 'aria-label': '测试选择最后一个画布节点' }).props.onClick())
      expect(latestCanvas.selectedNodeId).toBe('async-text-1')
      await dispatchWindowKey('y')
      act(() => renderer.root.findByProps({ 'aria-label': '测试清空画布选择' }).props.onClick())
      expect(latestCanvas.selectedNodeId).toBeNull()
    }

    await act(async () => {
      if (outcome === 'throw') pendingHistory.reject(new Error('storage unavailable'))
      else pendingHistory.resolve(false)
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })

    expect(onPersistCanvas).toHaveBeenCalledTimes(3)
    expect(latestCanvas.nodes.some(node => node.id === affectedNodeId)).toBe(true)
    expect(latestCanvas.selectedNodeId).toBe(historyStep === 'undo-create' ? 'async-text-1' : null)
    expect(persisted[2].selectedNodeId).toBe(historyStep === 'undo-create' ? 'async-text-1' : null)

    await dispatchWindowKey(historyStep === 'undo-create' ? 'z' : 'y')
    expect(latestCanvas.nodes.some(node => node.id === affectedNodeId)).toBe(false)
    expect(latestCanvas.selectedNodeId).toBe(historyStep === 'undo-create' ? 'async-text-1' : null)
  })

  it('falls back safely when a newer selected node is removed by failed history recovery', async () => {
    const pendingUndo = deferred<boolean>()
    const persistedSelections: Array<string | null> = []
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      persistedSelections.push(canvas.selectedNodeId || null)
      return persistedSelections.length === 1 ? pendingUndo.promise : Promise.resolve(true)
    })
    let latestCanvas = mixedDocumentImageCanvas()
    const Harness = () => {
      const [canvas, setCanvas] = useState(mixedDocumentImageCanvas())
      latestCanvas = canvas
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    act(() => renderer.root.findByProps({ 'aria-label': '测试选择前两个画布节点' }).props.onClick())
    act(() => renderedDocument(renderer, 'document-1')
      .findByProps({ 'aria-label': '测试删除文档' }).props.onClick())
    await dispatchWindowKey('z')
    act(() => renderer.root.findByProps({ 'aria-label': '测试选择第二个画布节点' }).props.onClick())
    expect(latestCanvas.selectedNodeId).toBe('async-image-1')

    await act(async () => {
      pendingUndo.resolve(false)
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })

    expect(latestCanvas.nodes.map(node => node.id)).toEqual(['async-text-1'])
    expect(latestCanvas.selectedNodeId).toBeNull()
    expect(persistedSelections).toEqual(['document-1', null])
  })

  it.each(['false', 'throw'] as const)('recovers saved B when its queued redo follows a pending undo that settles with $outcome', async outcome => {
    const pendingUndo = deferred<boolean>()
    const persistedTexts: string[] = []
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      persistedTexts.push(canvasDocumentTexts(canvas)['document-1'] || '<missing>')
      return persistedTexts.length === 2 ? pendingUndo.promise : Promise.resolve(true)
    })
    let latestCanvas = initialCanvas()
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      latestCanvas = canvas
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => renderer.root.findByProps({ 'aria-label': '测试编辑文档 B' }).props.onClick())
    await dispatchWindowKey('z')
    await dispatchWindowKey('y')

    await act(async () => {
      if (outcome === 'throw') pendingUndo.reject(new Error('storage unavailable'))
      else pendingUndo.resolve(false)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(persistedTexts.slice(0, 3)).toEqual(['B', 'Before', 'B'])
    expect(canvasDocumentTexts(latestCanvas)).toEqual({ 'document-1': 'B' })

    await dispatchWindowKey('z')
    expect(canvasDocumentTexts(latestCanvas)).toEqual({ 'document-1': 'Before' })
    await dispatchWindowKey('y')
    expect(canvasDocumentTexts(latestCanvas)).toEqual({ 'document-1': 'B' })
  })

  it.each([
    { outcome: 'false', external: 'image' },
    { outcome: 'throw', external: 'edge' }
  ] as const)('preserves an external $external update when mixed Document/image restore persistence settles with $outcome', async ({ outcome, external }) => {
    const pendingRestore = deferred<boolean>()
    const persisted: IFreeCanvasProject[] = []
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      persisted.push(canvas)
      return pendingRestore.promise
    })
    let latestCanvas = mixedDocumentImageCanvas()
    let publishExternal!: () => void
    const Harness = () => {
      const [canvas, setCanvas] = useState(mixedDocumentImageCanvas())
      latestCanvas = canvas
      publishExternal = () => setCanvas(current => external === 'image'
        ? {
            ...current,
            nodes: current.nodes.map(node => node.id === 'async-image-1' && node.kind === 'image'
              ? { ...node, assetId: 'asset-external-z', meta: { ...node.meta, externalAuthority: 'Z' } }
              : node)
          }
        : {
            ...current,
            edges: current.edges.map(edge => edge.id === 'edge-document-image'
              ? { ...edge, createdAt: 99 }
              : edge)
          })
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    act(() => renderer.root.findByProps({ 'aria-label': '测试选择前两个画布节点' }).props.onClick())
    act(() => renderedDocument(renderer, 'document-1')
      .findByProps({ 'aria-label': '测试删除文档' }).props.onClick())
    expect(latestCanvas.nodes.map(node => node.id)).toEqual(['async-text-1'])

    await dispatchWindowKey('z')
    expect(persisted).toHaveLength(1)
    act(() => publishExternal())

    await act(async () => {
      if (outcome === 'throw') pendingRestore.reject(new Error('storage unavailable'))
      else pendingRestore.resolve(false)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onPersistCanvas).toHaveBeenCalledTimes(1)
    expect(latestCanvas.nodes.map(node => node.id)).toEqual([
      'document-1', 'async-image-1', 'async-text-1'
    ])
    expect(latestCanvas.edges.map(edge => edge.id)).toEqual([
      'edge-document-image', 'edge-image-text'
    ])
    if (external === 'image') {
      expect(latestCanvas.nodes.find(node => node.id === 'async-image-1')).toMatchObject({
        assetId: 'asset-external-z',
        meta: { externalAuthority: 'Z' }
      })
    } else {
      expect(latestCanvas.edges.find(edge => edge.id === 'edge-document-image')?.createdAt).toBe(99)
    }

    await dispatchWindowKey('y')
    expect(onPersistCanvas).toHaveBeenCalledTimes(1)
  })

  it.each(['false', 'throw'] as const)('restores the failed redo-create entry while a queued same-id edit becomes a no-op after $outcome', async outcome => {
    const pendingRedoCreate = deferred<boolean>()
    const persisted: IFreeCanvasProject[] = []
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      persisted.push(canvas)
      return persisted.length === 3 ? pendingRedoCreate.promise : Promise.resolve(true)
    })
    let latestCanvas = initialCanvas()
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      latestCanvas = canvas
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => {
      renderer.root.findByProps({ title: 'Document' }).props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    const created = latestCanvas.nodes.find(node => node.id !== 'document-1') as IFreeCanvasDocumentNode
    await dispatchWindowKey('z')
    await dispatchWindowKey('y')

    let editCreated!: Promise<boolean>
    act(() => {
      editCreated = renderedDocument(renderer, created.id)
        .findByProps({ 'aria-label': '测试编辑文档' }).props.onClick()
    })
    await act(async () => {
      if (outcome === 'throw') pendingRedoCreate.reject(new Error('storage unavailable'))
      else pendingRedoCreate.resolve(false)
      await editCreated
      await Promise.resolve()
      await Promise.resolve()
    })

    const sameIdNodes = latestCanvas.nodes.filter(node => node.id === created.id)
    expect(sameIdNodes).toHaveLength(0)
    expect(onPersistCanvas).toHaveBeenCalledTimes(4)

    await dispatchWindowKey('y')
    expect(latestCanvas.nodes.filter(node => node.id === created.id)).toHaveLength(1)
    expect(canvasDocumentTexts(latestCanvas)[created.id]).toBe('')
  })

  it.each([
    { outcome: 'false', authority: 'document' },
    { outcome: 'throw', authority: 'kind' }
  ] as const)('does not restore over external same-id $authority authority after undo-create $outcome', async ({ outcome, authority }) => {
    const pendingUndoCreate = deferred<boolean>()
    const persisted: IFreeCanvasProject[] = []
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      persisted.push(canvas)
      return persisted.length === 2 ? pendingUndoCreate.promise : Promise.resolve(true)
    })
    let latestCanvas = initialCanvas()
    let publishExternal!: (node: IFreeCanvasDocumentNode) => void
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      latestCanvas = canvas
      publishExternal = node => setCanvas(current => ({
        ...current,
        nodes: [
          ...current.nodes,
          authority === 'kind'
            ? { ...unrelatedTextNode(), id: node.id }
            : {
                ...node,
                document: createPlanningDocumentV1([{
                  id: `${node.id}-external-z`, type: 'paragraph', content: [{ text: 'Z' }]
                }], 9)
              }
        ]
      }))
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => {
      renderer.root.findByProps({ title: 'Document' }).props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    const created = latestCanvas.nodes.find(node => node.id !== 'document-1') as IFreeCanvasDocumentNode
    await dispatchWindowKey('z')
    act(() => publishExternal(created))

    await act(async () => {
      if (outcome === 'throw') pendingUndoCreate.reject(new Error('storage unavailable'))
      else pendingUndoCreate.resolve(false)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const sameIdNodes = latestCanvas.nodes.filter(node => node.id === created.id)
    expect(sameIdNodes).toHaveLength(1)
    if (authority === 'kind') expect(sameIdNodes[0].kind).toBe('text')
    else expect(canvasDocumentTexts(latestCanvas)[created.id]).toBe('Z')
    expect(onPersistCanvas).toHaveBeenCalledTimes(2)

    await dispatchWindowKey('y')
    expect(onPersistCanvas).toHaveBeenCalledTimes(2)
  })

  it.each([
    { outcome: 'false', authority: 'document' },
    { outcome: 'throw', authority: 'missing' }
  ] as const)('does not delete external $authority authority after undo-delete restore $outcome', async ({ outcome, authority }) => {
    const pendingRestore = deferred<boolean>()
    const onPersistCanvas = vi.fn()
      .mockImplementationOnce(() => pendingRestore.promise)
      .mockResolvedValue(true)
    let latestCanvas = initialCanvas()
    let publishExternal!: () => void
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      latestCanvas = canvas
      publishExternal = () => setCanvas(current => ({
        ...current,
        nodes: authority === 'missing'
          ? current.nodes.filter(node => node.id !== 'document-1')
          : current.nodes.map(node => node.id === 'document-1' && node.kind === 'document'
            ? {
                ...node,
                document: createPlanningDocumentV1([{
                  id: 'document-1-external-z', type: 'paragraph', content: [{ text: 'Z' }]
                }], 9)
              }
            : node)
      }))
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    act(() => { renderer.root.findByProps({ 'aria-label': '测试删除文档' }).props.onClick() })
    await dispatchWindowKey('z')
    act(() => publishExternal())

    await act(async () => {
      if (outcome === 'throw') pendingRestore.reject(new Error('storage unavailable'))
      else pendingRestore.resolve(false)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    if (authority === 'missing') {
      expect(latestCanvas.nodes.find(node => node.id === 'document-1')).toBeUndefined()
    } else {
      expect(canvasDocumentTexts(latestCanvas)).toEqual({ 'document-1': 'Z' })
    }
    expect(onPersistCanvas).toHaveBeenCalledTimes(1)

    await dispatchWindowKey('y')
    expect(onPersistCanvas).toHaveBeenCalledTimes(1)
  })

  it('serializes rapid Document edits so double failures cannot stale-roll back the newer edit', async () => {
    const requests = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>(), deferred<boolean>()]
    const persistedTexts: string[] = []
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      const current = canvas.nodes.find(candidate => candidate.kind === 'document') as IFreeCanvasDocumentNode
      persistedTexts.push(planningDocumentEffectiveText(current.document))
      return requests[persistedTexts.length - 1].promise
    })
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    const renderer = create(<Harness />)

    let editA!: Promise<boolean>
    let editB!: Promise<boolean>
    act(() => {
      editA = renderer.root.findByProps({ 'aria-label': '测试编辑文档 A' }).props.onClick()
      editB = renderer.root.findByProps({ 'aria-label': '测试编辑文档 B' }).props.onClick()
    })
    expect(persistedTexts).toEqual(['A'])

    await act(async () => { requests[0].resolve(false); await Promise.resolve() })
    expect(persistedTexts).toEqual(['A', 'Before'])
    await act(async () => {
      requests[1].resolve(false)
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    expect(persistedTexts).toEqual(['A', 'Before', 'B'])
    await act(async () => { requests[2].resolve(false); await Promise.resolve() })
    expect(persistedTexts).toEqual(['A', 'Before', 'B', 'Before'])
    await act(async () => { requests[3].resolve(false); await Promise.all([editA, editB]) })

    expect(renderer.root.findByProps({ 'data-screen-document-node': 'document-1' }).props['data-document-text']).toBe('Before')
    expect(persistedTexts).toEqual(['A', 'Before', 'B', 'Before'])
  })

  it('persists keyboard undo and redo snapshots for Document commands', async () => {
    const persistedTexts: string[] = []
    const onPersistCanvas = vi.fn(async (canvas: IFreeCanvasProject) => {
      const current = canvas.nodes.find(candidate => candidate.kind === 'document') as IFreeCanvasDocumentNode
      persistedTexts.push(planningDocumentEffectiveText(current.document))
      return true
    })
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => renderer.root.findByProps({ 'aria-label': '测试编辑文档' }).props.onClick())
    const undoEvent = await dispatchWindowKey('z')
    const redoEvent = await dispatchWindowKey('y')

    expect(undoEvent.preventDefault).toHaveBeenCalled()
    expect(redoEvent.preventDefault).toHaveBeenCalled()
    expect(persistedTexts).toEqual(['After', 'Before', 'After'])
    expect(renderer.root.findByProps({ 'data-screen-document-node': 'document-1' }).props['data-document-text']).toBe('After')
  })

  it('recovers a failed Document undo without dropping unrelated async nodes or corrupting history', async () => {
    const outcomes = [true, false, false, true]
    const persistedTexts: string[] = []
    const onPersistCanvas = vi.fn(async (canvas: IFreeCanvasProject) => {
      const current = canvas.nodes.find(candidate => candidate.kind === 'document') as IFreeCanvasDocumentNode
      persistedTexts.push(planningDocumentEffectiveText(current.document))
      return outcomes.shift() ?? true
    })
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      return (
        <>
          <button
            type="button"
            aria-label="添加无关异步节点"
            onClick={() => setCanvas(current => ({ ...current, nodes: [...current.nodes, unrelatedTextNode()] }))}
          >Async</button>
          <FreeCanvasBuilderScreen
            activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
            onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
          />
        </>
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => renderer.root.findByProps({ 'aria-label': '测试编辑文档' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '添加无关异步节点' }).props.onClick())
    const failedUndoEvent = await dispatchWindowKey('z')

    expect(failedUndoEvent.preventDefault).toHaveBeenCalled()
    expect(persistedTexts).toEqual(['After', 'Before', 'After'])
    expect(renderer.root.findByProps({ 'data-screen-document-node': 'document-1' }).props['data-document-text']).toBe('After')
    expect(renderer.root.findByProps({ 'data-flow-node': 'async-text-1' })).toBeDefined()

    await dispatchWindowKey('z')
    expect(persistedTexts).toEqual(['After', 'Before', 'After', 'Before'])
    expect(renderer.root.findByProps({ 'data-screen-document-node': 'document-1' }).props['data-document-text']).toBe('Before')
    expect(renderer.root.findByProps({ 'data-flow-node': 'async-text-1' })).toBeDefined()
  })

  it.each([
    { direction: 'undo', outcome: 'false', external: 'node' },
    { direction: 'redo', outcome: 'throw', external: 'edge' }
  ] as const)('recovers a failed $direction while preserving a truly unrelated external $external update', async ({ direction, outcome, external }) => {
    const delayedHistory = deferred<boolean>()
    const failureCall = direction === 'undo' ? 2 : 3
    let persistenceCall = 0
    const persisted: IFreeCanvasProject[] = []
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      persisted.push(canvas)
      persistenceCall += 1
      return persistenceCall === failureCall ? delayedHistory.promise : Promise.resolve(true)
    })
    let latestCanvas = mixedDocumentImageCanvas()
    let publishExternal!: () => void
    const Harness = () => {
      const [canvas, setCanvas] = useState(mixedDocumentImageCanvas())
      latestCanvas = canvas
      publishExternal = () => setCanvas(current => external === 'node'
        ? {
            ...current,
            nodes: current.nodes.map(node => node.id === 'async-text-1'
              ? { ...node, meta: { ...node.meta, unrelatedAuthority: 'Z' } }
              : node)
          }
        : {
            ...current,
            edges: current.edges.map(edge => edge.id === 'edge-image-text'
              ? { ...edge, label: 'unrelated Z' }
              : edge)
          })
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => renderer.root.findByProps({ 'aria-label': '测试编辑文档 B' }).props.onClick())
    if (direction === 'redo') await dispatchWindowKey('z')
    await dispatchWindowKey(direction === 'undo' ? 'z' : 'y')
    act(() => publishExternal())

    await act(async () => {
      if (outcome === 'throw') delayedHistory.reject(new Error('storage unavailable'))
      else delayedHistory.resolve(false)
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })

    expect(onPersistCanvas).toHaveBeenCalledTimes(failureCall + 1)
    expect(canvasDocumentTexts(latestCanvas)).toEqual({
      'document-1': direction === 'undo' ? 'B' : 'Before'
    })
    if (external === 'node') {
      expect(latestCanvas.nodes.find(node => node.id === 'async-text-1')?.meta)
        .toMatchObject({ unrelatedAuthority: 'Z' })
    } else {
      expect(latestCanvas.edges.find(edge => edge.id === 'edge-image-text')?.label).toBe('unrelated Z')
    }
    const recovery = persisted[persisted.length - 1]
    expect(canvasDocumentTexts(recovery)).toEqual({
      'document-1': direction === 'undo' ? 'B' : 'Before'
    })

    await dispatchWindowKey(direction === 'undo' ? 'z' : 'y')
    expect(canvasDocumentTexts(latestCanvas)).toEqual({
      'document-1': direction === 'undo' ? 'Before' : 'B'
    })
  })

  it('removes only delayed failed Document A history while successful Document B remains undoable and redoable', async () => {
    const delayedA = deferred<boolean>()
    const snapshots: Array<Record<string, string>> = []
    let call = 0
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      snapshots.push(canvasDocumentTexts(canvas))
      call += 1
      return call === 1 ? delayedA.promise : Promise.resolve(true)
    })
    const Harness = () => {
      const [canvas, setCanvas] = useState(twoDocumentCanvas())
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    let editA!: Promise<boolean>
    act(() => { editA = renderedDocument(renderer, 'document-1').findByProps({ 'aria-label': '测试编辑文档' }).props.onClick() })
    let editB!: Promise<boolean>
    act(() => {
      editB = renderedDocument(renderer, 'document-2').findByProps({ 'aria-label': '测试编辑文档' }).props.onClick()
    })
    await act(async () => {
      delayedA.resolve(false)
      await Promise.all([editA, editB])
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })

    expect(snapshots.slice(0, 3)).toEqual([
      { 'document-1': 'After', 'document-2': 'Before B' },
      { 'document-1': 'Before A', 'document-2': 'Before B' },
      { 'document-1': 'Before A', 'document-2': 'After' }
    ])
    expect(renderedDocument(renderer, 'document-1').props['data-document-text']).toBe('Before A')
    expect(renderedDocument(renderer, 'document-2').props['data-document-text']).toBe('After')

    await dispatchWindowKey('z')
    expect(snapshots[3]).toEqual({ 'document-1': 'Before A', 'document-2': 'Before B' })
    await dispatchWindowKey('y')
    expect(snapshots[4]).toEqual({ 'document-1': 'Before A', 'document-2': 'After' })
  })

  it('removes only a failed Document creation while a concurrent existing-node edit remains undoable', async () => {
    const delayedCreate = deferred<boolean>()
    const snapshots: Array<Record<string, string>> = []
    let call = 0
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      snapshots.push(canvasDocumentTexts(canvas))
      call += 1
      return call === 1 ? delayedCreate.promise : Promise.resolve(true)
    })
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    act(() => { renderer.root.findByProps({ title: 'Document' }).props.onClick() })
    let editExisting!: Promise<boolean>
    act(() => {
      editExisting = renderedDocument(renderer, 'document-1').findByProps({ 'aria-label': '测试编辑文档' }).props.onClick()
    })
    await act(async () => {
      delayedCreate.resolve(false)
      await editExisting
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })

    expect(Object.keys(snapshots[0])).toHaveLength(2)
    expect(snapshots[1]).toEqual({ 'document-1': 'Before' })
    expect(snapshots[2]).toEqual({ 'document-1': 'After' })
    expect(renderer.root.findAll(node => node.props['data-screen-document-node'])).toHaveLength(1)

    await dispatchWindowKey('z')
    expect(snapshots[3]).toEqual({ 'document-1': 'Before' })
  })

  it.each(['undo', 'redo'] as const)('recovers a failed persisted %s without dropping a concurrent Document command', async direction => {
    const delayedHistory = deferred<boolean>()
    const snapshots: Array<Record<string, string>> = []
    const failureCall = direction === 'undo' ? 2 : 3
    let call = 0
    const onPersistCanvas = vi.fn((canvas: IFreeCanvasProject) => {
      snapshots.push(canvasDocumentTexts(canvas))
      call += 1
      return call === failureCall ? delayedHistory.promise : Promise.resolve(true)
    })
    const Harness = () => {
      const [canvas, setCanvas] = useState(twoDocumentCanvas())
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => renderedDocument(renderer, 'document-1').findByProps({ 'aria-label': '测试编辑文档' }).props.onClick())
    if (direction === 'redo') await dispatchWindowKey('z')
    await dispatchWindowKey(direction === 'undo' ? 'z' : 'y')
    let editB!: Promise<boolean>
    act(() => {
      editB = renderedDocument(renderer, 'document-2').findByProps({ 'aria-label': '测试编辑文档' }).props.onClick()
    })
    await act(async () => {
      delayedHistory.resolve(false)
      await editB
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })

    const recoveredA = direction === 'undo' ? 'After' : 'Before A'
    expect(renderedDocument(renderer, 'document-1').props['data-document-text']).toBe(recoveredA)
    expect(renderedDocument(renderer, 'document-2').props['data-document-text']).toBe('After')
    expect(snapshots[snapshots.length - 1]).toEqual({
      'document-1': recoveredA,
      'document-2': 'After'
    })

    await dispatchWindowKey('z')
    expect(renderedDocument(renderer, 'document-2').props['data-document-text']).toBe('Before B')
    await dispatchWindowKey('y')
    expect(renderedDocument(renderer, 'document-2').props['data-document-text']).toBe('After')
  })

  it('persists collapsed Document metadata through the canvas snapshot', async () => {
    const persisted: IFreeCanvasProject[] = []
    const Harness = () => {
      const [canvas, setCanvas] = useState(initialCanvas())
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(canvas)} freeCanvas={canvas} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCanvas}
          onPersistCanvas={async next => { persisted.push(next); return true }}
        />
      )
    }
    const renderer = create(<Harness />)

    await act(async () => renderer.root.findByProps({ 'aria-label': '测试折叠文档' }).props.onClick())

    const savedNode = persisted[persisted.length - 1]?.nodes.find(candidate => candidate.id === 'document-1') as IFreeCanvasDocumentNode
    expect(savedNode.meta.collapsed).toBe(true)
    expect(renderer.root.findByProps({ 'data-screen-document-node': 'document-1' }).props['data-document-collapsed']).toBe(true)
  })

  it('locks only the ledger target when one conversation has multiple historical markers', async () => {
    const canvas = twoDocumentCanvas()
    canvas.nodes = canvas.nodes.map(node => node.kind === 'document'
      ? {
          ...node,
          agentAppliedEdit: {
            conversationId: 'conversation-restart', requestId: 'request-restart',
            editId: 'edit-restart', resultDigest: node.document.digest
          }
        }
      : node)
    const persisted: IFreeCanvasProject[] = []
    const Harness = () => {
      const [current, setCurrent] = useState(canvas)
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(current)} freeCanvas={current} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCurrent}
          onPersistCanvas={async next => { persisted.push(next); return true }}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />); await Promise.resolve() })

    await act(async () => renderedDocument(renderer, 'document-1').findByProps({ 'aria-label': '测试编辑文档 A' }).props.onClick())
    expect(renderedDocument(renderer, 'document-1').props['data-document-text']).toBe('A')

    await act(async () => renderer.root.findByProps({ 'aria-label': '测试开始 Document reconcile' }).props.onClick())
    expect(renderedDocument(renderer, 'document-1').props['data-document-locked']).toBe(true)
    expect(renderedDocument(renderer, 'document-2').props['data-document-locked']).toBe(false)

    await act(async () => renderedDocument(renderer, 'document-1').findByProps({ 'aria-label': '测试编辑文档 B' }).props.onClick())
    act(() => renderedDocument(renderer, 'document-1').findByProps({ 'aria-label': '测试删除文档' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '测试 ReactFlow 删除首个节点' }).props.onClick())
    await dispatchWindowKey('z')
    expect(renderedDocument(renderer, 'document-1').props['data-document-text']).toBe('A')

    await act(async () => renderedDocument(renderer, 'document-2').findByProps({ 'aria-label': '测试编辑文档 B' }).props.onClick())
    expect(renderedDocument(renderer, 'document-2').props['data-document-text']).toBe('B')
    expect(persisted[persisted.length - 1]).toEqual(expect.objectContaining({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: 'document-1' }),
        expect.objectContaining({ id: 'document-2' })
      ])
    }))

    await act(async () => renderer.root.findByProps({ 'aria-label': '测试结束 Document reconcile' }).props.onClick())
    expect(renderedDocument(renderer, 'document-1').props['data-document-locked']).toBe(false)
  })

  it('locks synchronously and waits for the current Document mutation queue before reconciliation', async () => {
    const pendingSave = deferred<boolean>()
    const onPersistCanvas = vi.fn()
      .mockImplementationOnce(() => pendingSave.promise)
      .mockResolvedValue(true)
    const Harness = () => {
      const [current, setCurrent] = useState(initialCanvas())
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(current)} freeCanvas={current} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCurrent} onPersistCanvas={onPersistCanvas}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    let pendingEdit!: Promise<boolean>
    act(() => {
      pendingEdit = renderedDocument(renderer, 'document-1')
        .findByProps({ 'aria-label': '测试编辑文档 A' }).props.onClick()
    })
    let barrierSettled = false
    let barrier!: Promise<void>
    act(() => {
      barrier = renderer.root.findByProps({ 'aria-label': '测试开始 Document reconcile' }).props.onClick()
      void barrier.then(() => { barrierSettled = true })
    })

    expect(renderedDocument(renderer, 'document-1').props['data-document-locked']).toBe(true)
    expect(barrierSettled).toBe(false)
    await act(async () => renderedDocument(renderer, 'document-1')
      .findByProps({ 'aria-label': '测试编辑文档 B' }).props.onClick())
    expect(onPersistCanvas).toHaveBeenCalledTimes(1)

    await act(async () => {
      pendingSave.resolve(true)
      await Promise.all([pendingEdit, barrier])
    })
    expect(barrierSettled).toBe(true)
  })

  it('does not let an older reconcile generation release a newer target lease', async () => {
    const Harness = () => {
      const [current, setCurrent] = useState(twoDocumentCanvas())
      return (
        <FreeCanvasBuilderScreen
          activeProject={project(current)} freeCanvas={current} onBack={vi.fn()} onRenameProject={vi.fn()}
          onSave={vi.fn()} onChange={setCurrent} onPersistCanvas={vi.fn().mockResolvedValue(true)}
        />
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })

    await act(async () => renderer.root.findByProps({ 'aria-label': '测试开始 Document reconcile' }).props.onClick())
    await act(async () => renderer.root.findByProps({ 'aria-label': '测试开始 Document reconcile' }).props.onClick())
    await act(async () => renderer.root.findByProps({ 'aria-label': '测试开始第二代 Document reconcile' }).props.onClick())
    await act(async () => renderer.root.findByProps({ 'aria-label': '测试结束 Document reconcile' }).props.onClick())
    await act(async () => renderer.root.findByProps({ 'aria-label': '测试结束 Document reconcile' }).props.onClick())

    expect(renderedDocument(renderer, 'document-1').props['data-document-locked']).toBe(true)
    expect(renderedDocument(renderer, 'document-2').props['data-document-locked']).toBe(false)

    await act(async () => renderer.root.findByProps({ 'aria-label': '测试结束第二代 Document reconcile' }).props.onClick())
    await act(async () => renderer.root.findByProps({ 'aria-label': '测试结束第二代 Document reconcile' }).props.onClick())
    expect(renderedDocument(renderer, 'document-1').props['data-document-locked']).toBe(false)
  })

  it('restores a project target lease after switching away and back before its apply finishes', async () => {
    const canvases = {
      'project-1': twoDocumentCanvas(),
      'project-2': twoDocumentCanvas()
    }
    const Harness = () => {
      const [activeProjectId, setActiveProjectId] = useState<'project-1' | 'project-2'>('project-1')
      const [currentByProject, setCurrentByProject] = useState(canvases)
      const current = currentByProject[activeProjectId]
      return (
        <>
          <button type="button" aria-label="切换 reconcile 项目 P1" onClick={() => setActiveProjectId('project-1')}>P1</button>
          <button type="button" aria-label="切换 reconcile 项目 P2" onClick={() => setActiveProjectId('project-2')}>P2</button>
          <FreeCanvasBuilderScreen
            activeProject={project(current, activeProjectId)} freeCanvas={current}
            onBack={vi.fn()} onRenameProject={vi.fn()} onSave={vi.fn()}
            onChange={next => setCurrentByProject(value => ({ ...value, [activeProjectId]: next }))}
            onPersistCanvas={vi.fn().mockResolvedValue(true)}
          />
        </>
      )
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<Harness />) })
    await act(async () => renderer.root.findByProps({ 'aria-label': '测试开始 Document reconcile' }).props.onClick())
    expect(renderedDocument(renderer, 'document-1').props['data-document-locked']).toBe(true)

    act(() => renderer.root.findByProps({ 'aria-label': '切换 reconcile 项目 P2' }).props.onClick())
    expect(renderedDocument(renderer, 'document-1').props['data-document-locked']).toBe(false)

    act(() => renderer.root.findByProps({ 'aria-label': '切换 reconcile 项目 P1' }).props.onClick())
    expect(renderedDocument(renderer, 'document-1').props['data-document-locked']).toBe(true)

    await act(async () => renderer.root.findByProps({ 'aria-label': '测试结束 Document reconcile' }).props.onClick())
    expect(renderedDocument(renderer, 'document-1').props['data-document-locked']).toBe(false)
  })
})
