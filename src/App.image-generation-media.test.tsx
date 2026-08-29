import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFreeCanvasImageGeneratorNode, createFreeCanvasProject } from '@/domain/free-canvas/free-canvas-project'
import type { IFreeCanvasProject, IPromptProject } from '@/models/PromptHistory.model'
import type { RecentCaptureItem } from '@/storage/storage-service-client'

const mocks = vi.hoisted(() => ({
  project: null as IPromptProject | null,
  projectB: null as IPromptProject | null,
  capture: null as RecentCaptureItem | null,
  projectUpdate: vi.fn(),
  captureUpdate: vi.fn(),
  refreshCaptures: vi.fn(),
  persistResult: null as unknown,
  persistCalls: [] as IFreeCanvasProject[]
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
  }) => <>
    <button type="button" data-open-project onClick={() => onOpenProject(projects[0])}>Open project</button>
    {projects.find(project => project.id === 'project-2') && (
      <button
        type="button"
        data-open-project-b
        onClick={() => onOpenProject(projects.find(project => project.id === 'project-2')!)}
      >Open project B</button>
    )}
  </>
}))
vi.mock('./components/canvas/FreeCanvasBuilderScreen', () => ({
  default: ({ activeProject, onBack, onRenameProject, onChange, onPersistCanvas, freeCanvas }: {
    activeProject: IPromptProject
    onBack: () => void
    onRenameProject: () => void
    onChange: (freeCanvas: IFreeCanvasProject) => void
    onPersistCanvas: (canvas: IFreeCanvasProject) => Promise<unknown>
    freeCanvas: IFreeCanvasProject
  }) => (
    <div
      data-free-canvas-builder
      data-builder-title={activeProject.title}
      data-builder-handoff-approved={freeCanvas.meta.handoffApproved}
      data-builder-handoff-marker-count={
        Array.isArray(freeCanvas.meta.handoffMarkerIds) ? freeCanvas.meta.handoffMarkerIds.length : 0
      }
    >
      <button type="button" data-builder-back onClick={onBack}>Back</button>
      <button type="button" data-builder-rename onClick={onRenameProject}>Rename</button>
      <button type="button" data-builder-persist onClick={async () => {
        mocks.persistResult = await onPersistCanvas({ ...freeCanvas, meta: { ...freeCanvas.meta, handoffRequested: true } })
      }}>Persist</button>
      <button type="button" data-builder-persist-rebase onClick={async () => {
        const requested = { ...freeCanvas, meta: { ...freeCanvas.meta, handoffRequested: true } }
        mocks.persistCalls.push(requested)
        let receipt = await onPersistCanvas(requested)
        if (receipt && typeof receipt === 'object' && 'freeCanvas' in receipt) {
          const authoritative = receipt.freeCanvas as IFreeCanvasProject
          if (authoritative.meta.handoffRequested !== true) {
            const rebased = { ...authoritative, meta: { ...authoritative.meta, handoffRequested: true } }
            mocks.persistCalls.push(rebased)
            receipt = await onPersistCanvas(rebased)
          }
        }
        mocks.persistResult = receipt
      }}>Persist with rebase</button>
      <button type="button" data-builder-persist-authoritative onClick={async () => {
        const requested = {
          ...freeCanvas,
          meta: {
            ...freeCanvas.meta,
            handoffApproved: true,
            handoffMarkerIds: ['handoff-marker-1']
          }
        }
        const receipt = await onPersistCanvas(requested)
        if (receipt && typeof receipt === 'object' && 'freeCanvas' in receipt) {
          onChange(receipt.freeCanvas as IFreeCanvasProject)
        }
        mocks.persistResult = receipt
      }}>Persist authoritative handoff</button>
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
  RenameProjectModal: ({ onTitleChange, onConfirm }: {
    onTitleChange: (title: string) => void
    onConfirm: () => Promise<void>
  }) => <div data-rename-modal>
    <button type="button" data-change-rename onClick={() => onTitleChange('Renamed while saving')}>Change title</button>
    <button type="button" data-confirm-rename onClick={onConfirm}>Confirm rename</button>
  </div>
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
      getAll: vi.fn(async () => [mocks.project, mocks.projectB].filter(Boolean) as IPromptProject[]),
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

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
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
    mocks.projectB = null
    mocks.projectUpdate.mockImplementation(async (_id, updates) => ({ ...mocks.project!, ...updates, revision: 2 }))
    mocks.captureUpdate.mockResolvedValue(mocks.capture)
    mocks.refreshCaptures.mockResolvedValue(undefined)
    mocks.persistResult = null
    mocks.persistCalls = []
  })

  it('waits for a queued stale metadata save and rebases the handoff marker onto the final Storage winner', async () => {
    mocks.project = canvasProject()
    const firstSave = deferred<IPromptProject>()
    const secondSave = deferred<IPromptProject>()
    const secondStarted = deferred<void>()
    let storageWinner = mocks.project
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<App />); await settle() })
    await act(async () => {
      renderer.root.findByProps({ 'data-open-project': true }).props.onClick()
      await settle()
    })
    mocks.projectUpdate.mockClear()
    mocks.projectUpdate.mockImplementation(async (_id, updates) => {
      const requested = { ...storageWinner!, ...updates } as IPromptProject
      const call = mocks.projectUpdate.mock.calls.length
      if (call === 1) {
        const saved = await firstSave.promise
        storageWinner = saved
        return saved
      }
      if (call === 2) {
        secondStarted.resolve()
        const saved = await secondSave.promise
        storageWinner = saved
        return saved
      }
      storageWinner = { ...requested, revision: (storageWinner?.revision || 0) + 1 }
      return storageWinner
    })

    let handoff!: Promise<void>
    await act(async () => {
      handoff = renderer.root.findByProps({ 'data-builder-persist-rebase': true }).props.onClick()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(mocks.projectUpdate).toHaveBeenCalledTimes(1))
    act(() => { void renderer.root.findByProps({ 'data-builder-rename': true }).props.onClick() })
    act(() => renderer.root.findByProps({ 'data-change-rename': true }).props.onClick())
    let rename!: Promise<void>
    act(() => { rename = renderer.root.findByProps({ 'data-confirm-rename': true }).props.onClick() })

    const firstRequest = mocks.projectUpdate.mock.calls[0][1] as { freeCanvas: IFreeCanvasProject }
    firstSave.resolve({ ...mocks.project, ...firstRequest, revision: 2 })
    await secondStarted.promise
    expect(mocks.persistResult).toBeNull()

    const staleRenameRequest = mocks.projectUpdate.mock.calls[1][1] as Partial<IPromptProject>
    expect(staleRenameRequest.freeCanvas?.meta.handoffRequested).not.toBe(true)
    secondSave.resolve({ ...mocks.project, ...staleRenameRequest, revision: 3 })
    await act(async () => { await Promise.all([handoff, rename]) })

    expect(mocks.persistCalls).toHaveLength(2)
    expect(storageWinner?.freeCanvas?.meta.handoffRequested).toBe(true)
    expect(storageWinner?.title).toBe('Renamed while saving')
    expect(renderer.root.findByProps({ 'data-free-canvas-builder': true }).props['data-builder-title'])
      .toBe('Renamed while saving')
    expect(mocks.persistResult).toEqual(expect.objectContaining({
      saved: true,
      freeCanvas: expect.objectContaining({ meta: expect.objectContaining({ handoffRequested: true }) })
    }))
  })

  it('rebases a delayed Rename confirmation onto the handoff-complete active project', async () => {
    mocks.project = canvasProject()
    const handoffSave = deferred<IPromptProject>()
    let storageWinner = mocks.project
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<App />); await settle() })
    await act(async () => {
      renderer.root.findByProps({ 'data-open-project': true }).props.onClick()
      await settle()
    })
    mocks.projectUpdate.mockClear()
    mocks.projectUpdate.mockImplementation(async (_id, updates) => {
      if (mocks.projectUpdate.mock.calls.length === 1) {
        storageWinner = await handoffSave.promise
        return storageWinner
      }
      storageWinner = { ...storageWinner!, ...updates, revision: (storageWinner?.revision || 0) + 1 }
      return storageWinner
    })

    let handoff!: Promise<void>
    await act(async () => {
      handoff = renderer.root.findByProps({ 'data-builder-persist-authoritative': true }).props.onClick()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(mocks.projectUpdate).toHaveBeenCalledTimes(1))
    act(() => { void renderer.root.findByProps({ 'data-builder-rename': true }).props.onClick() })
    act(() => renderer.root.findByProps({ 'data-change-rename': true }).props.onClick())

    const handoffRequest = mocks.projectUpdate.mock.calls[0][1] as Partial<IPromptProject>
    handoffSave.resolve({ ...mocks.project, ...handoffRequest, revision: 2 })
    await act(async () => { await handoff })
    expect(renderer.root.findByProps({ 'data-free-canvas-builder': true }).props['data-builder-handoff-approved'])
      .toBe(true)
    expect(renderer.root.findByProps({ 'data-free-canvas-builder': true }).props['data-builder-handoff-marker-count'])
      .toBe(1)

    await act(async () => {
      await renderer.root.findByProps({ 'data-confirm-rename': true }).props.onClick()
      await settle()
    })

    expect(storageWinner?.title).toBe('Renamed while saving')
    expect(storageWinner?.freeCanvas?.meta.handoffApproved).toBe(true)
    expect(storageWinner?.freeCanvas?.meta.handoffMarkerIds).toEqual(['handoff-marker-1'])
    expect(renderer.root.findByProps({ 'data-free-canvas-builder': true }).props['data-builder-title'])
      .toBe('Renamed while saving')
    expect(renderer.root.findByProps({ 'data-free-canvas-builder': true }).props['data-builder-handoff-marker-count'])
      .toBe(1)
  })

  it('waits for a non-active project handoff before applying its delayed Rename confirmation', async () => {
    mocks.project = canvasProject()
    mocks.projectB = { ...canvasProject(), id: 'project-2', title: 'Canvas B' }
    const handoffSave = deferred<IPromptProject>()
    let storageA = mocks.project
    let storageB = mocks.projectB
    let aUpdateCount = 0
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<App />); await settle() })
    await act(async () => {
      renderer.root.findByProps({ 'data-open-project': true }).props.onClick()
      await settle()
    })
    mocks.projectUpdate.mockClear()
    mocks.projectUpdate.mockImplementation(async (id, updates) => {
      if (id === 'project-1') {
        aUpdateCount += 1
        if (aUpdateCount === 1) {
          storageA = await handoffSave.promise
          return storageA
        }
        storageA = { ...storageA!, ...updates, revision: (storageA?.revision || 0) + 1 }
        return storageA
      }
      storageB = { ...storageB!, ...updates, revision: (storageB?.revision || 0) + 1 }
      return storageB
    })

    let handoff!: Promise<void>
    await act(async () => {
      handoff = renderer.root.findByProps({ 'data-builder-persist-authoritative': true }).props.onClick()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(aUpdateCount).toBe(1))
    act(() => { void renderer.root.findByProps({ 'data-builder-rename': true }).props.onClick() })
    act(() => renderer.root.findByProps({ 'data-change-rename': true }).props.onClick())
    act(() => renderer.root.findByProps({ 'data-builder-back': true }).props.onClick())
    await act(async () => {
      renderer.root.findByProps({ 'data-open-project-b': true }).props.onClick()
      await settle()
    })

    let rename!: Promise<void>
    act(() => { rename = renderer.root.findByProps({ 'data-confirm-rename': true }).props.onClick() })
    await Promise.resolve()
    expect(aUpdateCount).toBe(1)

    const handoffRequest = mocks.projectUpdate.mock.calls.find(([id]) => id === 'project-1')![1] as Partial<IPromptProject>
    handoffSave.resolve({ ...mocks.project, ...handoffRequest, revision: 2 })
    await act(async () => { await Promise.all([handoff, rename]) })

    expect(storageA?.title).toBe('Renamed while saving')
    expect(storageA?.freeCanvas?.meta.handoffApproved).toBe(true)
    expect(storageA?.freeCanvas?.meta.handoffMarkerIds).toEqual(['handoff-marker-1'])
    expect(storageB?.title).toBe('Canvas B')
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
