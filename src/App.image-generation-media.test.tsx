import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFreeCanvasImageGeneratorNode, createFreeCanvasProject } from '@/domain/free-canvas/free-canvas-project'
import type { IFreeCanvasProject, IPromptProject } from '@/models/PromptHistory.model'
import type { RecentCaptureItem } from '@/storage/storage-service-client'

const mocks = vi.hoisted(() => ({
  project: null as IPromptProject | null,
  capture: null as RecentCaptureItem | null,
  projectUpdate: vi.fn(),
  captureUpdate: vi.fn(),
  refreshCaptures: vi.fn(),
  persistResult: null as unknown
}))

vi.mock('./components/app/AppShell', () => ({
  AppShell: ({ children, setActiveTab }: { children: ReactNode; setActiveTab: (tab: string) => void }) => (
    <div>
      <button type="button" data-open-media onClick={() => setActiveTab('media')}>Media</button>
      {children}
    </div>
  )
}))
vi.mock('./components/app/ProjectHome', () => ({
  ProjectHome: ({ projects, onOpenProject }: {
    projects: IPromptProject[]
    onOpenProject: (project: IPromptProject) => void
  }) => <button type="button" data-open-project onClick={() => onOpenProject(projects[0])}>Open project</button>
}))
vi.mock('./components/canvas/FreeCanvasBuilderScreen', () => ({
  default: ({ onBack, onPersistCanvas, freeCanvas }: {
    onBack: () => void
    onPersistCanvas: (canvas: IFreeCanvasProject) => Promise<unknown>
    freeCanvas: IFreeCanvasProject
  }) => (
    <div data-free-canvas-builder>
      <button type="button" data-builder-back onClick={onBack}>Back</button>
      <button type="button" data-builder-persist onClick={async () => {
        mocks.persistResult = await onPersistCanvas({ ...freeCanvas, meta: { ...freeCanvas.meta, handoffRequested: true } })
      }}>Persist</button>
    </div>
  )
}))
vi.mock('./components/PromptLibrary', () => ({ default: () => null }))
vi.mock('./components/ThreeStageBuilder', () => ({ default: () => null }))
vi.mock('./components/AgentDashboard', () => ({ AgentDashboard: () => null }))
vi.mock('./components/app/CardBuilderScreen', () => ({ CardBuilderScreen: () => null }))
vi.mock('./components/app/StoryboardBuilderScreen', () => ({ StoryboardBuilderScreen: () => null }))
vi.mock('./components/app/MeScreen', () => ({ MeScreen: () => null }))
vi.mock('./components/app/UpdateScreen', () => ({ UpdateScreen: () => null }))
vi.mock('./components/app/TemplateLibraryScreen', () => ({ TemplateLibraryScreen: () => null }))
vi.mock('./features/capture/CaptureBarScreen', () => ({ CaptureBarScreen: () => null }))
vi.mock('./components/app/ProjectModals', () => ({
  AddCardModal: () => null,
  CreateProjectModal: () => null,
  HistoryModal: () => null,
  RenameProjectModal: () => null
}))
vi.mock('./features/media/RecentCaptureInbox', () => ({ RecentCaptureInbox: () => null }))
vi.mock('./features/media/RecentCapturePreview', () => ({ RecentCapturePreview: () => null }))
vi.mock('./features/media/MediaAnalysisDialog', () => ({ MediaAnalysisDialog: () => null }))
vi.mock('./features/media/RecentCaptureRegistrationDialog', () => ({ RecentCaptureRegistrationDialog: () => null }))
vi.mock('./features/media/use-recent-captures', () => ({
  useRecentCaptures: () => ({
    captures: mocks.capture ? [mocks.capture] : [],
    refreshCaptures: mocks.refreshCaptures,
    selectedCapture: mocks.capture,
    selectedCaptureId: mocks.capture?.id || null,
    setSelectedCaptureId: vi.fn()
  })
}))
vi.mock('./i18n', () => ({
  useI18n: () => ({
    language: 'zh', setLanguage: vi.fn(), t: (key: string) => key, cardTypeLabel: (value: string) => value
  })
}))

const cardStore = {
  pages: [{ id: 'page-1', title: 'Page', cards: [] }],
  currentPage: 0,
  addCard: vi.fn(), updateCard: vi.fn(), updateCards: vi.fn(),
  activeCardId: null, activePresetCardId: null, setActivePresetCardId: vi.fn(),
  addPage: vi.fn(), switchPage: vi.fn(), removePage: vi.fn(), restoreWorkspace: vi.fn(),
  selectedCards: [], getCombinedPrompt: vi.fn(() => ''), clearSelection: vi.fn()
}
const presetStore = {
  init: vi.fn(), getByType: vi.fn(() => []), incrementUsage: vi.fn(), refresh: vi.fn()
}
vi.mock('./stores/card.store', () => ({ useCardStore: () => cardStore }))
vi.mock('./stores/preset.store', () => ({
  usePresetStore: (selector?: (state: typeof presetStore) => unknown) => selector ? selector(presetStore) : presetStore
}))
vi.mock('./utils/storage', () => ({
  storage: {
    health: vi.fn(async () => true),
    projects: {
      getAll: vi.fn(async () => mocks.project ? [mocks.project] : []),
      getTrash: vi.fn(async () => []),
      persistCreated: vi.fn(async (project: IPromptProject) => project),
      update: mocks.projectUpdate,
      create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), restoreMany: vi.fn(), deleteManyForever: vi.fn()
    },
    workspace: { get: vi.fn(async () => null), save: vi.fn() },
    history: { getAll: vi.fn(async () => []), addSnapshot: vi.fn() },
    settings: {
      get: vi.fn(async () => ({
        theme: 'light', defaultMode: 'learn', autoSave: false,
        autoSaveIdleSeconds: 10, presetSort: 'usage', meta: { featureFlags: { imageGenerationNodeV1: true } }
      })),
      save: vi.fn()
    },
    assets: { upload: vi.fn(), url: (assetId: string) => `/storage-api/assets/${assetId}/content` },
    recentCaptures: {
      create: vi.fn(),
      getById: vi.fn(async () => mocks.capture),
      update: mocks.captureUpdate,
      delete: vi.fn()
    },
    exportData: vi.fn(), importData: vi.fn()
  }
}))

import App from './App'

const generatedCapture = (): RecentCaptureItem => ({
  id: 'capture-generated',
  assetId: 'asset-generated',
  kind: 'screenshot',
  status: 'recent',
  purpose: 'generatedResult',
  role: 'other',
  title: 'Generated lighthouse',
  prompt: 'A glass lighthouse',
  userNote: '',
  sourcePlatform: 'Seedream',
  sourceUrl: '',
  contentType: 'image/png',
  revision: 1,
  registeredPromptId: null,
  registeredAt: null,
  linkedProjectId: null,
  linkedCanvasNodeId: null,
  size: 1024,
  width: 1200,
  height: 768,
  capturedAt: 1,
  origin: { type: 'imageGeneration' },
  createdAt: 1,
  updatedAt: 1
})

const canvasProject = (referenceCount = 0): IPromptProject => {
  const generator = createFreeCanvasImageGeneratorNode(
    { x: 100, y: 100 },
    { connectionId: 'ark-primary', modelId: 'doubao-seedream-5-0-pro-260628' },
    1
  )
  generator.id = 'generator-1'
  generator.title = 'Seedream node'
  const referenceNodes = Array.from({ length: referenceCount }, (_, index) => ({
    id: `reference-${index}`,
    kind: 'image' as const,
    title: `Reference ${index}`,
    position: { x: index * 10, y: 0 }, width: 300, height: 220,
    assetId: `asset-reference-${index}`, imageUrl: '', imagePrompt: '', sourceNodeId: null,
    crop: null, annotations: [], meta: {}
  }))
  const freeCanvas = createFreeCanvasProject(1, {
    nodes: [generator, ...referenceNodes],
    edges: referenceNodes.map((node, index) => ({
      id: `edge-${index}`, source: node.id, target: generator.id,
      sourceHandle: 'image-output', targetHandle: 'reference-image',
      inputOrder: index, referenceId: `stable-reference-${index}`, createdAt: index + 1
    })),
    selectedNodeId: generator.id
  })
  return {
    id: 'project-1', title: 'Canvas', type: 'free-canvas', freeCanvas,
    pages: [], currentPage: 0, createdAt: 1, updatedAt: 1, lastOpenedAt: 1, revision: 1, meta: {}
  } as IPromptProject
}

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

const mountAppInMedia = async (): Promise<ReactTestRenderer> => {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<App />)
    await settle()
  })
  await act(async () => {
    renderer.root.findByProps({ 'data-open-project': true }).props.onClick()
    await settle()
  })
  act(() => renderer.root.findByProps({ 'data-builder-back': true }).props.onClick())
  mocks.projectUpdate.mockClear()
  mocks.captureUpdate.mockClear()
  act(() => renderer.root.findByProps({ 'data-open-media': true }).props.onClick())
  return renderer
}

describe('App generated result media placement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: vi.fn(() => true)
    })
    mocks.capture = generatedCapture()
    mocks.projectUpdate.mockImplementation(async (_id, updates) => ({ ...mocks.project!, ...updates, revision: 2 }))
    mocks.captureUpdate.mockResolvedValue(mocks.capture)
    mocks.refreshCaptures.mockResolvedValue(undefined)
    mocks.persistResult = null
  })

  it('returns the authoritative Storage canvas rather than treating a superseding save as boolean success', async () => {
    mocks.project = canvasProject()
    const winningCanvas = { ...mocks.project.freeCanvas!, meta: { winningConcurrentEdit: true } }
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<App />)
      await settle()
    })
    await act(async () => {
      renderer.root.findByProps({ 'data-open-project': true }).props.onClick()
      await settle()
    })
    mocks.projectUpdate.mockClear()
    mocks.projectUpdate.mockResolvedValueOnce({ ...mocks.project, freeCanvas: winningCanvas, revision: 2 })
    await act(async () => {
      await renderer.root.findByProps({ 'data-builder-persist': true }).props.onClick()
    })

    expect(mocks.persistResult).toEqual({ saved: true, freeCanvas: winningCanvas, editSeq: 0 })
    expect((mocks.projectUpdate.mock.calls[0][1] as { freeCanvas: IFreeCanvasProject }).freeCanvas.meta)
      .toMatchObject({ handoffRequested: true })
  })

  it('writes an ordinary generated image through the mounted App and real MediaScreen action', async () => {
    mocks.project = canvasProject()
    const renderer = await mountAppInMedia()

    await act(async () => {
      renderer.root.findByProps({ 'data-place-capture-on-canvas': true }).props.onClick()
      await settle()
    })

    const calls = mocks.projectUpdate.mock.calls
    const update = calls[calls.length - 1]?.[1] as { freeCanvas: IFreeCanvasProject }
    expect(update.freeCanvas.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'image', assetId: 'asset-generated' })
    ]))
    expect(mocks.captureUpdate).toHaveBeenCalledTimes(1)
    expect(renderer.root.findByProps({ 'data-free-canvas-builder': true })).toBeDefined()
  })

  it('writes a stable generator reference through the mounted App and real MediaScreen action', async () => {
    mocks.project = canvasProject()
    const renderer = await mountAppInMedia()

    await act(async () => {
      renderer.root.findByProps({ 'data-place-capture-as-reference': true }).props.onClick()
      await settle()
    })

    const calls = mocks.projectUpdate.mock.calls
    const update = calls[calls.length - 1]?.[1] as { freeCanvas: IFreeCanvasProject }
    expect(update.freeCanvas.edges).toContainEqual(expect.objectContaining({
      target: 'generator-1', targetHandle: 'reference-image', sourceHandle: 'image-output',
      inputOrder: 0, referenceId: expect.any(String)
    }))
    expect(update.freeCanvas.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'image', assetId: 'asset-generated' })
    ]))
    expect(renderer.root.findByProps({ 'data-free-canvas-builder': true })).toBeDefined()
  })

  it('does not write when the mounted reference action would exceed the ten-reference limit', async () => {
    mocks.project = canvasProject(10)
    const renderer = await mountAppInMedia()

    await act(async () => {
      renderer.root.findByProps({ 'data-place-capture-as-reference': true }).props.onClick()
      await settle()
    })

    expect(mocks.projectUpdate).not.toHaveBeenCalled()
    expect(mocks.captureUpdate).not.toHaveBeenCalled()
  })
})
