import { Fragment, useState, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlanningDocumentV1, planningDocumentEffectiveText } from '@/domain/documents/planning-document'
import type { IFreeCanvasDocumentNode, IFreeCanvasProject, IPromptProject, PlanningDocumentV1 } from '@/models/PromptHistory.model'

const mocks = vi.hoisted(() => ({
  bootstrapRuntime: vi.fn(),
  getCatalog: vi.fn(),
  listConnections: vi.fn(),
  listAssignments: vi.fn(),
  getImageGenerationStatus: vi.fn(),
  getConversations: vi.fn(),
  getConversationRuns: vi.fn(),
  getPendingPlacements: vi.fn()
}))

vi.mock('@xyflow/react', () => {
  const PassThrough = ({ children }: { children?: ReactNode }) => <Fragment>{children}</Fragment>
  const reactFlow = { screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }) }
  const ReactFlow = ({ nodes, nodeTypes, children }: {
    nodes: Array<{ id: string; type: string; data: Record<string, unknown>; selected?: boolean; draggable?: boolean; connectable?: boolean; deletable?: boolean }>
    nodeTypes: Record<string, (props: Record<string, unknown>) => ReactNode>
    children?: ReactNode
  }) => (
    <div data-mock-react-flow>
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

vi.mock('@/components/canvas/nodes/DocumentNode', () => ({
  DocumentNode: ({ node, onDocumentChange, onDelete }: {
    node: IFreeCanvasDocumentNode
    onDocumentChange: (document: PlanningDocumentV1) => Promise<boolean>
    onDelete: () => void
  }) => (
    <div data-screen-document-node={node.id} data-document-text={planningDocumentEffectiveText(node.document)}>
      <button
        type="button"
        aria-label="测试编辑文档"
        onClick={() => onDocumentChange(createPlanningDocumentV1([
          { id: `${node.id}-paragraph`, type: 'paragraph', content: [{ text: 'After' }] }
        ], node.document.revision + 1))}
      >Edit</button>
      <button type="button" aria-label="测试删除文档" onClick={onDelete}>Delete</button>
    </div>
  )
}))

vi.mock('@/components/AgentCollaborationPanel', () => ({ AIChatbotBox: () => <div /> }))
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
vi.mock('@/services/agent-runtime-service', () => ({ agentRuntimeService: { bootstrap: mocks.bootstrapRuntime } }))
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

const documentNode = (): IFreeCanvasDocumentNode => ({
  id: 'document-1',
  kind: 'document',
  title: 'Creative brief',
  position: { x: 40, y: 50 },
  width: 560,
  height: 420,
  document: createPlanningDocumentV1([
    { id: 'document-1-paragraph', type: 'paragraph', content: [{ text: 'Before' }] }
  ]),
  linkedDocumentResourceIds: [],
  meta: {}
})

const project = (freeCanvas: IFreeCanvasProject): IPromptProject => ({
  id: 'project-1',
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

describe('FreeCanvasBuilderScreen Document integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout, clearTimeout,
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
    const renderer = create(<Harness />)

    await act(async () => renderer.root.findByProps({ 'aria-label': '测试编辑文档' }).props.onClick())

    expect(persistedTexts).toEqual(['After', 'Before'])
    expect(renderer.root.findByProps({ 'data-screen-document-node': 'document-1' }).props['data-document-text']).toBe('Before')
  })
})
