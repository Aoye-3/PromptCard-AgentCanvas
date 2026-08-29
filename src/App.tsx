import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent } from 'react'
import PromptLibrary from './components/PromptLibrary'
import ThreeStageBuilderScreen from './components/ThreeStageBuilder'
import { AgentDashboard } from './components/AgentDashboard'
import { SkillHubScreen } from './components/skills/SkillHubScreen'
import { AppShell } from './components/app/AppShell'
import { ProjectHome } from './components/app/ProjectHome'
import { FileStorageScreen } from './features/files/FileStorageScreen'
import { RecycleBinScreen } from './features/files/RecycleBinScreen'
import { CardBuilderScreen } from './components/app/CardBuilderScreen'
import { StoryboardBuilderScreen } from './components/app/StoryboardBuilderScreen'
import FreeCanvasBuilderScreen from './components/canvas/FreeCanvasBuilderScreen'
import { MeScreen } from './components/app/MeScreen'
import { UpdateScreen } from './components/app/UpdateScreen'
import { TemplateLibraryScreen } from './components/app/TemplateLibraryScreen'
import { MediaScreen } from './features/media/MediaScreen'
import { CaptureBarScreen } from './features/capture/CaptureBarScreen'
import type { ClipboardCaptureStatus } from './features/capture/CaptureBarScreen'
import { getClipboardImageFiles } from './components/canvas/canvas-image-assets'
import { importImageCapture, readClipboardImageFiles } from './features/capture/image-capture-import'
import { extractBrowserImageDrop, resolveBrowserImageDrop } from './features/capture/browser-image-drop'
import { closeCaptureToolbarWindow, openCaptureToolbarWindow, type CaptureToolbarStatus } from './features/capture/capture-toolbar-window'
import type { BuilderModePreviewSnapshot } from './components/app/builder-preview-contract'
import { AddCardModal, CreateProjectModal, HistoryModal, RenameProjectModal } from './components/app/ProjectModals'
import { useCardStore } from './stores/card.store'
import { usePresetStore } from './stores/preset.store'
import { createInitialPage } from './stores/card-initial-state'
import { assemblePrompt, getCardDefaultTitle } from './utils/promptParser'
import { findDuplicatePhrases, parsePromptToCardUpdates } from './utils/promptComposer'
import { useI18n } from './i18n'
import { storage } from './utils/storage'
import { desktopShellService } from './services/desktop-shell-service'
import { createBuilderTemplateProjectTitle, getBuilderTemplateById } from './domain/builder-templates/builder-templates'
import type { BuilderTemplateId } from './domain/builder-templates/builder-templates'
import { sortProjects } from './domain/projects/project-normalization'
import { mergeStoredCanvasResponseProjections, mergeStoredProjectMetadata } from './domain/projects/project-storage-merge'
import {
  createProjectSavePageLifecycle,
  createProjectSaveCoordinator,
  isExpectedProjectSaveNavigationCancellation,
  type ProjectSaveResult
} from './domain/projects/project-save-coordinator'
import { normalizeThreeStageTemplateSettings, type ThreeStageTemplateSettings } from './domain/three-stage/three-stage-definitions'
import { createFreeCanvasImageNodeFromMedia } from './domain/free-canvas/free-canvas-project'
import { applyGeneratedResultCanvasPlacement, createCaptureCanvasMediaNode, createCaptureCanvasUpdates } from './features/media/capture-canvas-placement'
import type { IPreset, CardType } from './models/Card.model'
import type { IFreeCanvasProject, IPromptHistory, IPromptProject, IStoryboardProject, IThreeStageProject } from './models/PromptHistory.model'
import type { AgentWorkspaceProposal } from './models/Agent.model'
import type { IUserSettings } from './models/UserSettings.model'
import type { MainTab, ProjectMode, SaveStatus } from './features/app/app-types'
import { imageGenerationNodeV1Enabled } from './features/app/feature-flags'
import type { RecentCaptureItem, TrashEntry } from './storage/storage-service-client'

const DEFAULT_USER_SETTINGS: IUserSettings = {
  theme: 'light',
  defaultMode: 'learn',
  autoSave: true,
  autoSaveIdleSeconds: 10,
  presetSort: 'usage',
  meta: {}
}

const STORAGE_HEALTH_RETRY_MS = 250
const STORAGE_HEALTH_MAX_ATTEMPTS = 32

const wait = (durationMs: number) => new Promise(resolve => window.setTimeout(resolve, durationMs))

const AppStartupScreen = ({ message }: { message: string }) => (
  <div className="app-startup-screen" role="status" aria-live="polite">
    <div className="app-startup-panel">
      <div className="app-startup-brand">
        <img className="app-startup-logo" src="/promptcard-manager-icon.png" alt="PMAgent logo" />
        <span>PMAgent</span>
      </div>
      <div className="app-startup-row">
        <div className="app-startup-spinner" aria-hidden="true"></div>
        <span>{message}</span>
      </div>
      <div className="app-startup-progress" aria-hidden="true"></div>
    </div>
  </div>
)

const createCardWorkspaceSnapshot = (project: Pick<IPromptProject, 'pages' | 'currentPage'>) =>
  JSON.stringify({ pages: project.pages, currentPage: project.currentPage })

function App() {
  const { language, setLanguage, t, cardTypeLabel } = useI18n()
  const {
    pages,
    currentPage,
    addCard,
    updateCard,
    updateCards,
    activeCardId,
    activePresetCardId,
    setActivePresetCardId,
    addPage,
    switchPage,
    removePage,
    restoreWorkspace,
    selectedCards,
    getCombinedPrompt,
    clearSelection
  } = useCardStore()
  const { init: initPresets, getByType: getPresetsByType, incrementUsage } = usePresetStore()

  const [activeTab, setActiveTab] = useState<MainTab>('projects')
  const [projectSearchTerm, setProjectSearchTerm] = useState('')
  const [projectMode, setProjectMode] = useState<ProjectMode>('home')
  const [projects, setProjects] = useState<IPromptProject[]>([])
  const [projectTrash, setProjectTrash] = useState<TrashEntry<IPromptProject>[]>([])
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([])
  const [selectedProjectTrashIds, setSelectedProjectTrashIds] = useState<string[]>([])
  const [showProjectTrash, setShowProjectTrash] = useState(false)
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [imageModelReturnContext, setImageModelReturnContext] = useState<{
    projectId: string
    nodeId?: string
    returnTarget: 'free-canvas'
  } | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [appSaveStatus, setAppSaveStatus] = useState<SaveStatus>('loading')
  const [projectSaveStates, setProjectSaveStates] = useState<Record<string, { status: SaveStatus; lastSavedAt: number | null }>>({})
  const [promptHistory, setPromptHistory] = useState<IPromptHistory[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [showAddCardModal, setShowAddCardModal] = useState(false)
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false)
  const [showTemplateLibrary, setShowTemplateLibrary] = useState(false)
  const [renameProject, setRenameProject] = useState<IPromptProject | null>(null)
  const [renameProjectTitle, setRenameProjectTitle] = useState('')
  const [duplicateMode, setDuplicateMode] = useState(false)
  const [activeEditMode, setActiveEditMode] = useState<'learn' | 'creative'>('creative')
  const [showSettings, setShowSettings] = useState(false)
  const [captureToolbarStatus, setCaptureToolbarStatus] = useState<CaptureToolbarStatus>('closed')
  const [captureToolbarError, setCaptureToolbarError] = useState('')
  const [clipboardCaptureStatus, setClipboardCaptureStatus] = useState<ClipboardCaptureStatus>('idle')
  const [clipboardCaptureMessage, setClipboardCaptureMessage] = useState('')
  const [startupMessage, setStartupMessage] = useState('正在连接本地数据服务...')
  const [userSettings, setUserSettings] = useState<IUserSettings>(DEFAULT_USER_SETTINGS)
  const threeStageTemplateSettings = useMemo(
    () => normalizeThreeStageTemplateSettings(userSettings.meta?.threeStageTemplates),
    [userSettings.meta]
  )
  const lastHistoryContentRef = useRef('')
  const projectEditSeqRef = useRef<Record<string, number>>({})
  const lastCardWorkspaceSnapshotRef = useRef('')
  const activeProjectRef = useRef<IPromptProject | null>(null)
  const placeCaptureOnCanvasRef = useRef<(capture: RecentCaptureItem) => Promise<void>>(async () => undefined)
  const projectSavePageLifecycleRef = useRef<ReturnType<typeof createProjectSavePageLifecycle> | null>(null)
  if (!projectSavePageLifecycleRef.current) {
    projectSavePageLifecycleRef.current = createProjectSavePageLifecycle()
  }
  const projectSavePageLifecycle = projectSavePageLifecycleRef.current
  const projectSaveCoordinatorRef = useRef<ReturnType<typeof createProjectSaveCoordinator> | null>(null)
  if (!projectSaveCoordinatorRef.current) {
    projectSaveCoordinatorRef.current = createProjectSaveCoordinator({
      create: project => storage.projects.persistCreated(project, {
        signal: projectSavePageLifecycle.signal
      }),
      update: async (id, revision, updates) => {
        const updatedProject = await storage.projects.update(id, updates, {
          revision,
          signal: projectSavePageLifecycle.signal
        })
        if (!updatedProject) throw new Error(`Project ${id} was not found while saving.`)
        return updatedProject
      }
    })
  }
  const projectSaveCoordinator = projectSaveCoordinatorRef.current

  useEffect(() => {
    const handlePageHide = (event: PageTransitionEvent) => {
      projectSavePageLifecycle.pageHide(event.persisted)
    }
    const handlePageShow = () => {
      projectSavePageLifecycle.pageShow()
    }
    window.addEventListener('pagehide', handlePageHide)
    window.addEventListener('pageshow', handlePageShow)
    return () => {
      window.removeEventListener('pagehide', handlePageHide)
      window.removeEventListener('pageshow', handlePageShow)
    }
  }, [projectSavePageLifecycle])

  const currentCards = pages[currentPage]?.cards || []
  const currentPrompt = assemblePrompt(pages)
  const allCards = useMemo(() => pages.flatMap(page => page.cards), [pages])
  const duplicateResult = useMemo(() => findDuplicatePhrases(allCards), [allCards])
  const activeProject = projects.find(project => project.id === activeProjectId) || null
  const activeProjectSaveState = activeProjectId ? projectSaveStates[activeProjectId] : undefined
  const saveStatus = activeProjectSaveState?.status || appSaveStatus
  const lastSavedAt = activeProjectSaveState?.lastSavedAt || null
  const storyboardSnapshot = useMemo(
    () => activeProject?.type === 'storyboard' ? JSON.stringify(activeProject.storyboard || null) : '',
    [activeProject]
  )
  const threeStageSnapshot = useMemo(
    () => activeProject?.type === 'three-stage' ? JSON.stringify(activeProject.threeStage || null) : '',
    [activeProject]
  )
  const freeCanvasSnapshot = useMemo(
    () => activeProject?.type === 'free-canvas' ? JSON.stringify(activeProject.freeCanvas || null) : '',
    [activeProject]
  )
  const activePresetCard = activePresetCardId ? currentCards.find(card => card.id === activePresetCardId) : null
  const presetsForActiveCard = activePresetCard ? getPresetsByType(activePresetCard.type) : []

  useEffect(() => {
    activeProjectRef.current = activeProject
  }, [activeProject])

  const upsertProject = useCallback((project: IPromptProject) => {
    setProjects(currentProjects => sortProjects([
      project,
      ...currentProjects.filter(currentProject => currentProject.id !== project.id)
    ]))
  }, [])

  const confirmStoredProjectMetadata = useCallback((project: IPromptProject, options: { includeTitle?: boolean; savedAt?: number } = {}) => {
    setProjects(currentProjects => {
      return mergeStoredProjectMetadata(currentProjects, project, options)
    })
  }, [])

  const markProjectEdited = useCallback((projectId: string) => {
    projectEditSeqRef.current[projectId] = (projectEditSeqRef.current[projectId] || 0) + 1
  }, [])

  const getProjectEditSeq = useCallback((projectId: string) => projectEditSeqRef.current[projectId] || 0, [])

  const setProjectSaveStatus = useCallback((projectId: string, status: SaveStatus, savedAt?: number) => {
    setProjectSaveStates(current => ({
      ...current,
      [projectId]: {
        status,
        lastSavedAt: savedAt ?? current[projectId]?.lastSavedAt ?? null
      }
    }))
  }, [])

  const canConfirmProjectSaved = useCallback((projectId: string, editSeq: number) => (
    getProjectEditSeq(projectId) === editSeq && !projectSaveCoordinator.hasPending(projectId)
  ), [getProjectEditSeq, projectSaveCoordinator])

  const confirmAutoSavedProject = useCallback((project: IPromptProject, savedAt: number, editSeq: number) => {
    setProjects(currentProjects => {
      const existingProject = currentProjects.find(currentProject => currentProject.id === project.id)
      if (!existingProject) return currentProjects
      const saveIsCurrent = (projectEditSeqRef.current[project.id] || 0) === editSeq

      return sortProjects(currentProjects.map(currentProject =>
        currentProject.id === project.id
          ? {
              ...mergeStoredCanvasResponseProjections(currentProject, project),
              revision: project.revision,
              updatedAt: saveIsCurrent
                ? Math.max(currentProject.updatedAt, project.updatedAt || savedAt)
                : currentProject.updatedAt,
              lastOpenedAt: Math.max(currentProject.lastOpenedAt || 0, project.lastOpenedAt || savedAt)
            }
          : currentProject
      ))
    })
  }, [])

  const isExpectedNavigationSaveCancellation = useCallback((error: unknown) => (
    isExpectedProjectSaveNavigationCancellation(error, projectSavePageLifecycle.unloading)
  ), [projectSavePageLifecycle])

  const handleProjectSaveError = useCallback((projectId: string, error: unknown, message: string) => {
    if (isExpectedNavigationSaveCancellation(error)) return
    console.error(message, error)
    setProjectSaveStatus(projectId, 'error')
  }, [isExpectedNavigationSaveCancellation, setProjectSaveStatus])

  const persistProjectChanges = useCallback(async (
    project: IPromptProject,
    updates: Partial<IPromptProject>,
    editSeq: number,
    savedAt: number,
    errorMessage: string
  ): Promise<ProjectSaveResult> => {
    const snapshot = { ...project, ...updates }
    const result = await projectSaveCoordinator.enqueue({ project: snapshot, editSeq })
    if (result.status === 'saved' && result.project) {
      confirmAutoSavedProject(result.project, savedAt, editSeq)
    } else if (result.status === 'failed') {
      handleProjectSaveError(project.id, result.error, errorMessage)
    }
    return result
  }, [confirmAutoSavedProject, handleProjectSaveError, projectSaveCoordinator])

  const removeProjectsFromState = useCallback((ids: string[]) => {
    const idSet = new Set(ids)
    setProjects(currentProjects => currentProjects.filter(project => !idSet.has(project.id)))
  }, [])

  const appendProjectTrashEntries = useCallback((trashedProjects: IPromptProject[], deletedAt = Date.now()) => {
    if (trashedProjects.length === 0) return

    setProjectTrash(currentTrash => {
      const trashedIds = new Set(trashedProjects.map(project => project.id))
      return [
        ...currentTrash.filter(entry => !trashedIds.has(entry.id)),
        ...trashedProjects.map(project => ({
          id: project.id,
          deletedAt,
          deletedBy: 'user' as const,
          deleteReason: null,
          payload: project
        }))
      ]
    })
  }, [])

  useEffect(() => {
    initPresets()
  }, [initPresets])

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let unlistenScreenshot: (() => void) | null = null
    let unlistenToolbarClosed: (() => void) | null = null
    let unlistenCaptureCompleted: (() => void) | null = null
    let unlistenPlaceOnCanvas: (() => void) | null = null
    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        unlistenScreenshot = await listen('capture:screenshot-requested', async () => {
          const project = activeProjectRef.current
          const allowCanvas = project?.type === 'free-canvas' && Boolean(project.freeCanvas)
          try {
            await desktopShellService.beginScreenshotSelection(allowCanvas)
          } catch (error) {
            setCaptureToolbarStatus('error')
            setCaptureToolbarError(error instanceof Error ? error.message : 'Screenshot selection could not start.')
            try {
              await openCaptureToolbarWindow()
            } catch {
              setCaptureToolbarStatus('error')
            }
          }
        })
        unlistenToolbarClosed = await listen('capture:toolbar-closed', () => {
          setCaptureToolbarStatus('closed')
          setCaptureToolbarError('')
        })
        unlistenCaptureCompleted = await listen('capture:completed', () => {
          setActiveTab('media')
          setShowTemplateLibrary(false)
          setProjectMode('home')
          setCaptureToolbarStatus('running')
          setCaptureToolbarError('')
        })
        unlistenPlaceOnCanvas = await listen<{ capture: RecentCaptureItem }>('capture:place-on-canvas', event => {
          void placeCaptureOnCanvasRef.current(event.payload.capture)
        })
      })
      .catch(error => {
        console.error('Failed to listen for capture toolbar events:', error)
      })
    return () => {
      unlistenScreenshot?.()
      unlistenToolbarClosed?.()
      unlistenCaptureCompleted?.()
      unlistenPlaceOnCanvas?.()
    }
  }, [])

  useEffect(() => {
    if (!isHydrated || !activeProjectId || projectMode !== 'builder' || activeProject?.type !== 'card') {
      lastCardWorkspaceSnapshotRef.current = createCardWorkspaceSnapshot({ pages, currentPage })
      return
    }

    const nextSnapshot = createCardWorkspaceSnapshot({ pages, currentPage })
    if (!lastCardWorkspaceSnapshotRef.current) {
      lastCardWorkspaceSnapshotRef.current = nextSnapshot
      return
    }

    if (lastCardWorkspaceSnapshotRef.current !== nextSnapshot) {
      markProjectEdited(activeProjectId)
      const updatedAt = Date.now()
      setProjects(currentProjects => currentProjects.map(project =>
        project.id === activeProjectId
          ? { ...project, pages, currentPage, updatedAt }
          : project
      ))
      lastCardWorkspaceSnapshotRef.current = nextSnapshot
    }
  }, [activeProject?.type, activeProjectId, currentPage, isHydrated, markProjectEdited, pages, projectMode])

  useEffect(() => {
    let cancelled = false

    const loadAppData = async () => {
      try {
        setStartupMessage('正在连接本地数据服务...')
        let storageReady = false
        for (let attempt = 0; attempt < STORAGE_HEALTH_MAX_ATTEMPTS && !cancelled; attempt++) {
          if (await storage.health()) {
            storageReady = true
            break
          }
          await wait(STORAGE_HEALTH_RETRY_MS)
        }
        if (cancelled) return

        setStartupMessage(storageReady ? '正在加载本地数据...' : '本地数据服务启动较慢，正在进入应用...')
        const [savedProjects, trash, workspace, history, settings] = await Promise.all([
          storage.projects.getAll(),
          storage.projects.getTrash(),
          storage.workspace.get(),
          storage.history.getAll(),
          storage.settings.get()
        ])

        if (cancelled) return

        let nextProjects = savedProjects
        if (savedProjects.length === 0 && workspace?.pages?.length) {
          const hasLegacyContent = assemblePrompt(workspace.pages).trim().length > 0
          if (hasLegacyContent) {
            const migratedProject = await storage.projects.create({
              title: '迁移项目',
              pages: workspace.pages,
              currentPage: workspace.currentPage,
              meta: { source: 'legacy-workspace' }
            })
            nextProjects = [migratedProject]
          }
        }

        setProjects(nextProjects)
        setProjectTrash(trash)
        setPromptHistory(history)
        setUserSettings(settings)
        lastHistoryContentRef.current = history[0]?.content || ''
        setAppSaveStatus('saved')
      } catch (error) {
        console.error('Failed to load app data:', error)
        setAppSaveStatus('error')
      } finally {
        if (!cancelled) {
          setIsHydrated(true)
        }
      }
    }

    loadAppData()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isHydrated || !userSettings.autoSave || !activeProjectId || projectMode !== 'builder' || activeProjectRef.current?.type !== 'card') return

    const timeoutId = window.setTimeout(async () => {
      try {
        const project = activeProjectRef.current
        if (!project || project.id !== activeProjectId || project.type !== 'card') return
        setProjectSaveStatus(activeProjectId, 'saving')
        const savedAt = Date.now()
        const editSeq = getProjectEditSeq(activeProjectId)
        const result = await persistProjectChanges(project, {
          pages,
          currentPage,
          updatedAt: savedAt,
          lastOpenedAt: savedAt
        }, editSeq, savedAt, 'Auto-save failed:')
        if (result.status === 'failed') return
        await storage.workspace.save({ pages, currentPage, savedAt })

        const saveIsCurrent = canConfirmProjectSaved(activeProjectId, editSeq)

        const trimmedPrompt = currentPrompt.trim()
        if (saveIsCurrent && trimmedPrompt && trimmedPrompt !== lastHistoryContentRef.current) {
          const snapshot = await storage.history.addSnapshot({
            content: trimmedPrompt,
            cards: allCards,
            pages,
            title: `${project.title || 'Project'}  Auto ${new Date(savedAt).toLocaleString()}`,
            meta: { source: 'auto-save', projectId: activeProjectId }
          })

          if (snapshot) {
            lastHistoryContentRef.current = snapshot.content
            setPromptHistory(await storage.history.getAll())
          }
        }

        if (result.status === 'saved' && saveIsCurrent) {
          setProjectSaveStatus(activeProjectId, 'saved', savedAt)
        }
      } catch (error) {
        handleProjectSaveError(activeProjectId, error, 'Auto-save failed:')
      }
    }, userSettings.autoSaveIdleSeconds * 1000)

    return () => window.clearTimeout(timeoutId)
  }, [activeProjectId, allCards, canConfirmProjectSaved, currentPage, currentPrompt, getProjectEditSeq, handleProjectSaveError, isHydrated, pages, persistProjectChanges, projectMode, setProjectSaveStatus, userSettings.autoSave, userSettings.autoSaveIdleSeconds])

  useEffect(() => {
    if (!isHydrated || !userSettings.autoSave || !activeProjectId || projectMode !== 'builder' || !storyboardSnapshot) return

    const timeoutId = window.setTimeout(async () => {
      try {
        const project = activeProjectRef.current
        if (!project || project.id !== activeProjectId || project.type !== 'storyboard' || !project.storyboard) return
        setProjectSaveStatus(activeProjectId, 'saving')
        const savedAt = Date.now()
        const editSeq = getProjectEditSeq(activeProjectId)
        const result = await persistProjectChanges(project, {
          storyboard: project.storyboard,
          updatedAt: savedAt,
          lastOpenedAt: savedAt
        }, editSeq, savedAt, 'Storyboard auto-save failed:')
        if (result.status === 'failed') return

        const saveIsCurrent = canConfirmProjectSaved(activeProjectId, editSeq)
        if (result.status === 'saved' && saveIsCurrent) {
          setProjectSaveStatus(activeProjectId, 'saved', savedAt)
        }
      } catch (error) {
        handleProjectSaveError(activeProjectId, error, 'Storyboard auto-save failed:')
      }
    }, userSettings.autoSaveIdleSeconds * 1000)

    return () => window.clearTimeout(timeoutId)
  }, [activeProjectId, canConfirmProjectSaved, getProjectEditSeq, handleProjectSaveError, isHydrated, persistProjectChanges, projectMode, setProjectSaveStatus, storyboardSnapshot, userSettings.autoSave, userSettings.autoSaveIdleSeconds])

  useEffect(() => {
    if (!isHydrated || !userSettings.autoSave || !activeProjectId || projectMode !== 'builder' || !threeStageSnapshot) return

    const timeoutId = window.setTimeout(async () => {
      try {
        const project = activeProjectRef.current
        if (!project || project.id !== activeProjectId || project.type !== 'three-stage' || !project.threeStage) return
        setProjectSaveStatus(activeProjectId, 'saving')
        const savedAt = Date.now()
        const editSeq = getProjectEditSeq(activeProjectId)
        const result = await persistProjectChanges(project, {
          threeStage: project.threeStage,
          updatedAt: savedAt,
          lastOpenedAt: savedAt
        }, editSeq, savedAt, 'Three-stage auto-save failed:')
        if (result.status === 'failed') return

        const saveIsCurrent = canConfirmProjectSaved(activeProjectId, editSeq)
        if (result.status === 'saved' && saveIsCurrent) {
          setProjectSaveStatus(activeProjectId, 'saved', savedAt)
        }
      } catch (error) {
        handleProjectSaveError(activeProjectId, error, 'Three-stage auto-save failed:')
      }
    }, userSettings.autoSaveIdleSeconds * 1000)

    return () => window.clearTimeout(timeoutId)
  }, [activeProjectId, canConfirmProjectSaved, getProjectEditSeq, handleProjectSaveError, isHydrated, persistProjectChanges, projectMode, setProjectSaveStatus, threeStageSnapshot, userSettings.autoSave, userSettings.autoSaveIdleSeconds])

  useEffect(() => {
    if (!isHydrated || !userSettings.autoSave || !activeProjectId || projectMode !== 'builder' || !freeCanvasSnapshot) return

    const timeoutId = window.setTimeout(async () => {
      try {
        const project = activeProjectRef.current
        if (!project || project.id !== activeProjectId || project.type !== 'free-canvas' || !project.freeCanvas) return
        setProjectSaveStatus(activeProjectId, 'saving')
        const savedAt = Date.now()
        const editSeq = getProjectEditSeq(activeProjectId)
        const result = await persistProjectChanges(project, {
          freeCanvas: project.freeCanvas,
          updatedAt: savedAt,
          lastOpenedAt: savedAt
        }, editSeq, savedAt, 'Free canvas auto-save failed:')
        if (result.status === 'failed') return

        const saveIsCurrent = canConfirmProjectSaved(activeProjectId, editSeq)
        if (result.status === 'saved' && saveIsCurrent) {
          setProjectSaveStatus(activeProjectId, 'saved', savedAt)
        }
      } catch (error) {
        handleProjectSaveError(activeProjectId, error, 'Free canvas auto-save failed:')
      }
    }, userSettings.autoSaveIdleSeconds * 1000)

    return () => window.clearTimeout(timeoutId)
  }, [activeProjectId, canConfirmProjectSaved, freeCanvasSnapshot, getProjectEditSeq, handleProjectSaveError, isHydrated, persistProjectChanges, projectMode, setProjectSaveStatus, userSettings.autoSave, userSettings.autoSaveIdleSeconds])

  const handleCreateProject = () => {
    setShowCreateProjectModal(true)
  }

  const handleCreateCardProject = async () => {
    const newProject = storage.projects.createDraft({
      title: `未命名项目 ${projects.length + 1}`,
      pages: [createInitialPage()],
      currentPage: 0
    })
    await createProjectOptimistically(newProject)
  }

  const handleCreateStoryboardProject = async () => {
    const newProject = storage.projects.createStoryboardDraft({
      title: `分镜项目 ${projects.filter(project => project.type === 'storyboard').length + 1}`
    })
    await createProjectOptimistically(newProject)
  }

  const handleCreateThreeStageProject = async () => {
    const newProject = storage.projects.createThreeStageDraft({
      templateSettings: threeStageTemplateSettings,
      title: `三段式项目 ${projects.filter(project => project.type === 'three-stage').length + 1}`
    })
    await createProjectOptimistically(newProject)
  }

  const handleCreateProjectFromTemplate = async (templateId: BuilderTemplateId, snapshot?: BuilderModePreviewSnapshot) => {
    const template = getBuilderTemplateById(templateId)
    const title = createBuilderTemplateProjectTitle(template, projects)
    const meta = { builderTemplateId: template.id }
    const newProject = template.projectType === 'storyboard'
      ? storage.projects.createStoryboardDraft({ title, storyboard: snapshot?.storyboard, meta })
      : template.projectType === 'three-stage'
        ? storage.projects.createThreeStageDraft({ title, threeStage: snapshot?.threeStage, templateSettings: threeStageTemplateSettings, meta })
        : template.projectType === 'free-canvas'
          ? storage.projects.createFreeCanvasDraft({ title, freeCanvas: snapshot?.freeCanvas, meta })
          : storage.projects.createDraft({
              title,
              pages: snapshot?.pages?.length ? snapshot.pages : [createInitialPage()],
              currentPage: snapshot?.currentPage || 0,
              meta
            })

    setShowTemplateLibrary(false)
    await createProjectOptimistically(newProject)
  }

  const openProject = async (project: IPromptProject, options: { touchLastOpened?: boolean } = {}) => {
    const touchLastOpened = options.touchLastOpened ?? true
    const openedAt = Math.max(Date.now(), ...projects.map(currentProject => currentProject.lastOpenedAt || 0)) + 1
    const optimisticProject = touchLastOpened
      ? { ...project, updatedAt: openedAt, lastOpenedAt: openedAt }
      : project

    if (project.type === 'card') {
      lastCardWorkspaceSnapshotRef.current = createCardWorkspaceSnapshot(project)
      restoreWorkspace({
        pages: project.pages,
        currentPage: project.currentPage
      })
    }
    setActiveProjectId(project.id)
    setActiveTab('projects')
    setProjectMode('builder')
    upsertProject(optimisticProject)

    if (!touchLastOpened) return

    const result = await projectSaveCoordinator.enqueue({
      project: optimisticProject,
      editSeq: getProjectEditSeq(project.id)
    })
    if (result.status === 'saved' && result.project) {
      confirmStoredProjectMetadata(result.project, { savedAt: openedAt })
    } else if (result.status === 'failed') {
      handleProjectSaveError(project.id, result.error, 'Failed to update project last opened time:')
    }
  }

  const handleDeleteProject = async (projectId: string) => {
    if (!confirm('确定要删除这个项目吗？历史快照会暂时保留。')) return
    const projectToDelete = projects.find(project => project.id === projectId)
    if (!projectToDelete) return

    const previousProjects = projects
    const previousProjectTrash = projectTrash
    const previousActiveProjectId = activeProjectId
    const previousProjectMode = projectMode
    const previousWorkspace = { pages, currentPage }
    const deletedAt = Date.now()

    removeProjectsFromState([projectId])
    appendProjectTrashEntries([projectToDelete], deletedAt)
    setSelectedProjectIds(ids => ids.filter(id => id !== projectId))

    if (activeProjectId === projectId) {
      setActiveProjectId(null)
      setProjectMode('home')
      restoreWorkspace({ pages: [createInitialPage()], currentPage: 0 })
    }

    try {
      const trashedProjects = await storage.projects.delete(projectId)
      appendProjectTrashEntries(trashedProjects, deletedAt)
    } catch (error) {
      console.error('Failed to delete project:', error)
      setProjects(previousProjects)
      setProjectTrash(previousProjectTrash)
      setActiveProjectId(previousActiveProjectId)
      setProjectMode(previousProjectMode)
      restoreWorkspace(previousWorkspace)
      setAppSaveStatus('error')
      alert('Failed to delete project.')
    }
  }

  const handleToggleProjectSelection = (projectId: string) => {
    setSelectedProjectIds(ids => ids.includes(projectId) ? ids.filter(id => id !== projectId) : [...ids, projectId])
  }

  const handleToggleProjectTrashSelection = (projectId: string) => {
    setSelectedProjectTrashIds(ids => ids.includes(projectId) ? ids.filter(id => id !== projectId) : [...ids, projectId])
  }

  const handleTrashSelectedProjects = async () => {
    if (selectedProjectIds.length === 0) return
    if (!confirm(`Move ${selectedProjectIds.length} project(s) to trash?`)) return
    const idsToTrash = selectedProjectIds
    const projectsToTrash = projects.filter(project => idsToTrash.includes(project.id))
    const previousProjects = projects
    const previousProjectTrash = projectTrash
    const previousActiveProjectId = activeProjectId
    const previousProjectMode = projectMode
    const previousWorkspace = { pages, currentPage }
    const deletedAt = Date.now()

    removeProjectsFromState(idsToTrash)
    appendProjectTrashEntries(projectsToTrash, deletedAt)
    if (activeProjectId && idsToTrash.includes(activeProjectId)) {
      setActiveProjectId(null)
      setProjectMode('home')
      restoreWorkspace({ pages: [createInitialPage()], currentPage: 0 })
    }
    setSelectedProjectIds([])

    try {
      const trashedProjects = await storage.projects.trash(idsToTrash)
      appendProjectTrashEntries(trashedProjects, deletedAt)
    } catch (error) {
      console.error('Failed to move projects to trash:', error)
      setProjects(previousProjects)
      setProjectTrash(previousProjectTrash)
      setActiveProjectId(previousActiveProjectId)
      setProjectMode(previousProjectMode)
      restoreWorkspace(previousWorkspace)
      setSelectedProjectIds(idsToTrash)
      setAppSaveStatus('error')
      alert('Failed to move projects to trash.')
    }
  }

  const handleRestoreSelectedProjects = async () => {
    if (selectedProjectTrashIds.length === 0) return
    const idsToRestore = selectedProjectTrashIds
    const entriesToRestore = projectTrash.filter(entry => idsToRestore.includes(entry.id))
    const previousProjects = projects
    const previousProjectTrash = projectTrash

    setProjectTrash(currentTrash => currentTrash.filter(entry => !idsToRestore.includes(entry.id)))
    setProjects(currentProjects => sortProjects([
      ...entriesToRestore.map(entry => entry.payload),
      ...currentProjects.filter(project => !idsToRestore.includes(project.id))
    ]))
    setSelectedProjectTrashIds([])

    try {
      const restoredProjects = await storage.projects.restore(idsToRestore)
      setProjects(currentProjects => sortProjects([
        ...restoredProjects,
        ...currentProjects.filter(project => !idsToRestore.includes(project.id))
      ]))
    } catch (error) {
      console.error('Failed to restore projects:', error)
      setProjects(previousProjects)
      setProjectTrash(previousProjectTrash)
      setSelectedProjectTrashIds(idsToRestore)
      setAppSaveStatus('error')
      alert('Failed to restore projects.')
    }
  }

  const handleDeleteSelectedProjectsForever = async () => {
    if (selectedProjectTrashIds.length === 0) return
    if (!confirm(`Permanently delete ${selectedProjectTrashIds.length} project(s)? This cannot be undone.`)) return
    const idsToDelete = selectedProjectTrashIds
    const previousProjectTrash = projectTrash

    setProjectTrash(currentTrash => currentTrash.filter(entry => !idsToDelete.includes(entry.id)))
    setSelectedProjectTrashIds([])

    try {
      await storage.projects.deleteForever(idsToDelete)
    } catch (error) {
      console.error('Failed to permanently delete projects:', error)
      setProjectTrash(previousProjectTrash)
      setSelectedProjectTrashIds(idsToDelete)
      setAppSaveStatus('error')
      alert('Failed to permanently delete projects.')
    }
  }
  const handleRenameProject = async (project: IPromptProject) => {
    setRenameProject(project)
    setRenameProjectTitle(project.title)
  }

  const handleConfirmRenameProject = async () => {
    if (!renameProject) return
    const nextTitle = renameProjectTitle.trim()
    if (!nextTitle || nextTitle === renameProject.title) {
      setRenameProject(null)
      setRenameProjectTitle('')
      return
    }

    const currentProject = activeProjectRef.current?.id === renameProject.id
      ? activeProjectRef.current
      : projects.find(project => project.id === renameProject.id) || renameProject
    const optimisticProject = { ...currentProject, title: nextTitle, updatedAt: Date.now() }
    markProjectEdited(renameProject.id)
    const editSeq = getProjectEditSeq(renameProject.id)
    upsertProject(optimisticProject)
    setProjectSaveStatus(renameProject.id, 'saving')
    const result = await projectSaveCoordinator.enqueue({
      project: optimisticProject,
      editSeq
    })
    if (result.status === 'saved' && result.project) {
      confirmStoredProjectMetadata(result.project, { includeTitle: true })
      if (canConfirmProjectSaved(renameProject.id, editSeq)) {
        setProjectSaveStatus(renameProject.id, 'saved', optimisticProject.updatedAt)
      }
    } else if (result.status === 'failed') {
      handleProjectSaveError(renameProject.id, result.error, 'Failed to rename project:')
    }
    setRenameProject(null)
    setRenameProjectTitle('')
  }

  const handleBackToProjects = () => {
    setProjectMode('home')
  }

  const handleBackFromTemplateLibrary = () => {
    setActiveTab('projects')
    setProjectMode('home')
    setActiveProjectId(null)
    setShowProjectTrash(false)
    setShowTemplateLibrary(false)
  }

  const handleUpdateStoryboard = (storyboard: IStoryboardProject) => {
    if (!activeProjectId) return
    markProjectEdited(activeProjectId)
    setProjects(currentProjects => currentProjects.map(project =>
      project.id === activeProjectId
        ? { ...project, storyboard, updatedAt: Date.now() }
        : project
    ))
  }

  const handleUpdateThreeStage = (threeStage: IThreeStageProject) => {
    if (!activeProjectId) return
    markProjectEdited(activeProjectId)
    setProjects(currentProjects => currentProjects.map(project =>
      project.id === activeProjectId
        ? { ...project, threeStage, updatedAt: Date.now() }
        : project
    ))
  }

  const handleUpdateFreeCanvas = (freeCanvas: IFreeCanvasProject) => {
    if (!activeProjectId) return
    markProjectEdited(activeProjectId)
    setProjects(currentProjects => currentProjects.map(project =>
      project.id === activeProjectId
        ? { ...project, freeCanvas, updatedAt: Date.now() }
        : project
    ))
  }

  const handlePlaceCaptureOnCanvas = async (
    capture: RecentCaptureItem,
    placement: { kind: 'image' } | { kind: 'reference'; targetNodeId: string } = { kind: 'image' }
  ) => {
    if (!activeProjectId || activeProject?.type !== 'free-canvas' || !activeProject.freeCanvas) return
    if (placement.kind === 'reference' && capture.purpose !== 'generatedResult') return
    const generatedPlacement = capture.purpose === 'generatedResult'
      ? applyGeneratedResultCanvasPlacement(activeProject.freeCanvas, capture, placement)
      : null
    if (generatedPlacement?.error) return
    const mediaNode = generatedPlacement ? null : createCaptureCanvasMediaNode(capture)
    const imageNode = mediaNode ? createFreeCanvasImageNodeFromMedia(mediaNode) : null
    const updatedFreeCanvas = generatedPlacement?.project || {
      ...activeProject.freeCanvas,
      nodes: [...activeProject.freeCanvas.nodes, imageNode!],
      selectedNodeId: imageNode!.id
    }
    const placedNodeId = generatedPlacement?.nodeId || imageNode!.id
    const savedAt = Date.now()
    markProjectEdited(activeProjectId)
    setProjects(currentProjects => currentProjects.map(project =>
      project.id === activeProjectId
        ? { ...project, freeCanvas: updatedFreeCanvas, updatedAt: savedAt }
        : project
    ))
    setProjectSaveStatus(activeProjectId, 'saving')
    const result = await persistProjectChanges(activeProject, {
      freeCanvas: updatedFreeCanvas,
      updatedAt: savedAt,
      lastOpenedAt: savedAt
    }, getProjectEditSeq(activeProjectId), savedAt, 'Place capture on canvas failed:')
    if (result.status === 'saved') {
      setProjectSaveStatus(activeProjectId, 'saved', savedAt)
      try {
        await storage.recentCaptures.update(
          capture.id,
          capture.revision,
          createCaptureCanvasUpdates(capture, activeProjectId, placedNodeId)
        )
      } catch (error) {
        console.error('Failed to update capture placement status:', error)
      }
      setActiveTab('projects')
      setProjectMode('builder')
    }
  }

  const handlePersistFreeCanvas = async (freeCanvas: IFreeCanvasProject) => {
    if (!activeProjectId) return false
    const projectId = activeProjectId
    const project = activeProjectRef.current
    if (!project || project.id !== projectId || project.type !== 'free-canvas') return false
    const savedAt = Date.now()
    setProjectSaveStatus(projectId, 'saving')
    await persistProjectChanges(project, {
      freeCanvas,
      updatedAt: savedAt,
      lastOpenedAt: savedAt
    }, getProjectEditSeq(projectId), savedAt, 'Place generated image on canvas failed:')
    const result = await projectSaveCoordinator.waitForIdle(projectId)
    const currentProject = activeProjectRef.current
    if (!currentProject || currentProject.id !== projectId || currentProject.type !== 'free-canvas') return false
    if (result.status !== 'saved' || result.project?.id !== projectId || result.project.type !== 'free-canvas' || !result.project.freeCanvas) return false
    setProjectSaveStatus(projectId, 'saved', savedAt)
    return { saved: true as const, freeCanvas: result.project.freeCanvas, editSeq: result.editSeq }
  }

  const handleConfigureImageModel = (context: { projectId: string; nodeId?: string; returnTarget: 'free-canvas' }) => {
    setImageModelReturnContext(context)
    setActiveTab('agents')
  }

  const handleImageAssignmentSaved = (assignment: { slot: string; connectionId: string; modelId: string }) => {
    if (assignment.slot !== 'image.primary' || !imageModelReturnContext) return
    const context = imageModelReturnContext
    const sourceProject = projects.find(project => project.id === context.projectId)
    const sourceNodeFound = !context.nodeId || sourceProject?.type === 'free-canvas' && Boolean(
      sourceProject.freeCanvas?.nodes.some(node => node.id === context.nodeId && node.kind === 'image-generator')
    )
    setProjects(currentProjects => currentProjects.map(project => {
      if (project.id !== context.projectId || project.type !== 'free-canvas' || !project.freeCanvas) return project
      if (!sourceNodeFound || !context.nodeId) return project
      return {
        ...project,
        updatedAt: Date.now(),
        freeCanvas: {
          ...project.freeCanvas,
          selectedNodeId: context.nodeId,
          nodes: project.freeCanvas.nodes.map(node => node.id === context.nodeId && node.kind === 'image-generator'
            ? { ...node, binding: { connectionId: assignment.connectionId, modelId: assignment.modelId } }
            : node)
        }
      }
    }))
    setImageModelReturnContext(null)
    setActiveProjectId(context.projectId)
    setActiveTab('projects')
    setProjectMode('builder')
    window.setTimeout(() => {
      if (context.nodeId && !sourceNodeFound) alert('来源图片生成节点已被删除，已返回原项目。')
    }, 0)
  }

  placeCaptureOnCanvasRef.current = handlePlaceCaptureOnCanvas

  const handleUpdateUserSettings = async (settings: Partial<IUserSettings>) => {
    const updated = await storage.settings.save(settings)
    setUserSettings(updated)
  }

  const handleUpdateThreeStageTemplateSettings = async (settings: ThreeStageTemplateSettings) => {
    await handleUpdateUserSettings({
      meta: {
        ...userSettings.meta,
        threeStageTemplates: settings
      }
    })
  }

  const handleOpenCaptureToolbar = async () => {
    setCaptureToolbarStatus('opening')
    setCaptureToolbarError('')
    try {
      await openCaptureToolbarWindow()
      setCaptureToolbarStatus('running')
    } catch (error) {
      console.error('Failed to open capture toolbar:', error)
      setCaptureToolbarStatus('error')
      setCaptureToolbarError(error instanceof Error ? error.message : '捕获栏启动失败。')
    }
  }

  const handleCloseCaptureToolbar = async () => {
    setCaptureToolbarStatus('closing')
    setCaptureToolbarError('')
    try {
      await closeCaptureToolbarWindow()
      setCaptureToolbarStatus('closed')
    } catch (error) {
      console.error('Failed to close capture toolbar:', error)
      setCaptureToolbarStatus('error')
      setCaptureToolbarError(error instanceof Error ? error.message : '捕获栏关闭失败。')
    }
  }

  const importClipboardFiles = async (files: File[]) => {
    if (files.length === 0) {
      setClipboardCaptureStatus('error')
      setClipboardCaptureMessage('剪贴板中没有可用图片。请先用微信或 QQ 截图，再按 Ctrl+V。')
      return
    }
    setClipboardCaptureStatus('saving')
    setClipboardCaptureMessage(`正在保存 ${files.length} 张图片...`)
    try {
      const startedAt = Date.now()
      for (const [index, file] of files.entries()) {
        await importImageCapture({
          file,
          kind: 'pastedMedia',
          sourcePlatform: 'Clipboard',
          capturedAt: startedAt + index,
          origin: { type: 'clipboard' }
        })
      }
      setClipboardCaptureStatus('saved')
      setClipboardCaptureMessage(`已保存 ${files.length} 张图片到近期捕获，可继续粘贴。`)
    } catch (error) {
      console.error('Failed to import clipboard capture:', error)
      setClipboardCaptureStatus('error')
      setClipboardCaptureMessage(error instanceof Error ? error.message : '剪贴板截图保存失败。')
    }
  }

  const handleReadClipboard = async () => {
    setClipboardCaptureStatus('reading')
    setClipboardCaptureMessage('正在读取剪贴板...')
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
        throw new Error('当前环境不能直接读取剪贴板，请聚焦此区域后按 Ctrl+V。')
      }
      await importClipboardFiles(await readClipboardImageFiles(navigator.clipboard))
    } catch (error) {
      setClipboardCaptureStatus('error')
      setClipboardCaptureMessage(error instanceof Error
        ? `${error.message} 请聚焦此区域后按 Ctrl+V。`
        : '剪贴板读取失败，请聚焦此区域后按 Ctrl+V。')
      document.querySelector<HTMLElement>('[data-clipboard-capture]')?.focus()
    }
  }

  const handlePasteClipboard = (event: ReactClipboardEvent<HTMLElement>) => {
    const files = getClipboardImageFiles(event.clipboardData)
    if (files.length > 0) event.preventDefault()
    void importClipboardFiles(files)
  }

  const handleDropBrowserImage = async (event: ReactDragEvent<HTMLElement>) => {
    setClipboardCaptureStatus('reading')
    setClipboardCaptureMessage('正在读取拖入图片...')
    try {
      const dropped = await resolveBrowserImageDrop(extractBrowserImageDrop(event.dataTransfer))
      setClipboardCaptureStatus('saving')
      setClipboardCaptureMessage(`正在保存 ${dropped.files.length} 张图片...`)
      const startedAt = Date.now()
      for (const [index, file] of dropped.files.entries()) {
        await importImageCapture({
          file,
          kind: 'pastedMedia',
          sourcePlatform: 'Browser drag',
          capturedAt: startedAt + index,
          origin: {
            type: 'browser-drag',
            ...(dropped.sourceUrl ? { sourceUrl: dropped.sourceUrl } : {})
          }
        })
      }
      setClipboardCaptureStatus('saved')
      setClipboardCaptureMessage(`已保存 ${dropped.files.length} 张图片到近期捕获，可继续拖入。`)
    } catch (error) {
      console.error('Failed to import browser image drop:', error)
      setClipboardCaptureStatus('error')
      setClipboardCaptureMessage(error instanceof Error ? error.message : '拖入图片保存失败。')
    }
  }

  const handleCopyPrompt = async () => {
    if (!currentPrompt.trim()) {
      alert(t('noPromptToCopy'))
      return
    }
    try {
      await navigator.clipboard.writeText(currentPrompt)
      alert(t('promptCopied'))
    } catch (error) {
      console.error('Copy failed:', error)
      alert(t('copyFailed'))
    }
  }

  const handleCopySelectedCards = async () => {
    const combined = getCombinedPrompt()
    await navigator.clipboard.writeText(combined)
    alert(t('selectedCardsCopied', { count: selectedCards.length }))
  }

  const handlePromptChange = (prompt: string) => {
    updateCards(parsePromptToCardUpdates(pages, prompt))
  }

  const handleSave = async () => {
    if (!activeProjectId || !activeProject) return
    try {
      setProjectSaveStatus(activeProjectId, 'saving')
      const savedAt = Date.now()
      const editSeq = getProjectEditSeq(activeProjectId)
      if (activeProject?.type === 'storyboard') {
        const result = await persistProjectChanges(activeProject, {
          storyboard: activeProject.storyboard,
          updatedAt: savedAt,
          lastOpenedAt: savedAt
        }, editSeq, savedAt, 'Save failed:')
        if (result.status === 'failed') {
          if (!isExpectedNavigationSaveCancellation(result.error)) alert(t('saveFailed'))
          return
        }
        const saveIsCurrent = canConfirmProjectSaved(activeProjectId, editSeq)
        if (result.status === 'saved' && saveIsCurrent) {
          setProjectSaveStatus(activeProjectId, 'saved', savedAt)
          alert(t('saveSuccess'))
        }
        return
      }

      if (activeProject?.type === 'three-stage') {
        const result = await persistProjectChanges(activeProject, {
          threeStage: activeProject.threeStage,
          updatedAt: savedAt,
          lastOpenedAt: savedAt
        }, editSeq, savedAt, 'Save failed:')
        if (result.status === 'failed') {
          if (!isExpectedNavigationSaveCancellation(result.error)) alert(t('saveFailed'))
          return
        }
        const saveIsCurrent = canConfirmProjectSaved(activeProjectId, editSeq)
        if (result.status === 'saved' && saveIsCurrent) {
          setProjectSaveStatus(activeProjectId, 'saved', savedAt)
          alert(t('saveSuccess'))
        }
        return
      }

      if (activeProject?.type === 'free-canvas') {
        const result = await persistProjectChanges(activeProject, {
          freeCanvas: activeProject.freeCanvas,
          updatedAt: savedAt,
          lastOpenedAt: savedAt
        }, editSeq, savedAt, 'Save failed:')
        if (result.status === 'failed') {
          if (!isExpectedNavigationSaveCancellation(result.error)) alert(t('saveFailed'))
          return
        }
        const saveIsCurrent = canConfirmProjectSaved(activeProjectId, editSeq)
        if (result.status === 'saved' && saveIsCurrent) {
          setProjectSaveStatus(activeProjectId, 'saved', savedAt)
          alert(t('saveSuccess'))
        }
        return
      }

      const result = await persistProjectChanges(activeProject, {
        pages,
        currentPage,
        updatedAt: savedAt,
        lastOpenedAt: savedAt
      }, editSeq, savedAt, 'Save failed:')
      if (result.status === 'failed') {
        if (!isExpectedNavigationSaveCancellation(result.error)) alert(t('saveFailed'))
        return
      }
      await storage.workspace.save({ pages, currentPage, savedAt })

      if (currentPrompt.trim()) {
        const snapshot = await storage.history.addSnapshot({
          content: currentPrompt,
          cards: allCards,
          pages,
          title: `${activeProject?.title || 'Project'}  Manual ${new Date(savedAt).toLocaleString()}`,
          meta: { source: 'manual-save', projectId: activeProjectId }
        })

        if (snapshot) {
          lastHistoryContentRef.current = snapshot.content
          setPromptHistory(await storage.history.getAll())
        }
      }

      if (result.status === 'saved' && canConfirmProjectSaved(activeProjectId, editSeq)) {
        setProjectSaveStatus(activeProjectId, 'saved', savedAt)
        alert(t('saveSuccess'))
      }
    } catch (error) {
      handleProjectSaveError(activeProjectId, error, 'Save failed:')
      alert(t('saveFailed'))
    }
  }

  const createProjectOptimistically = async (project: IPromptProject): Promise<void> => {
    setShowCreateProjectModal(false)
    projectSaveCoordinator.markPendingCreate(project)
    void openProject(project, { touchLastOpened: false })
    setProjectSaveStatus(project.id, 'saving')
    const result = await projectSaveCoordinator.enqueue({
      project,
      editSeq: getProjectEditSeq(project.id)
    })
    if (result.status === 'saved' && result.project) {
      confirmStoredProjectMetadata(result.project, { savedAt: Date.now() })
      setProjectSaveStatus(
        project.id,
        canConfirmProjectSaved(project.id, result.editSeq) ? 'saved' : 'saving',
        Date.now()
      )
    } else if (result.status === 'failed') {
      handleProjectSaveError(project.id, result.error, 'Failed to create project:')
    }
  }

  const handleRestoreHistory = (history: IPromptHistory) => {
    if (!history.pages?.length) return

    restoreWorkspace({
      pages: history.pages,
      currentPage: 0
    })
    setShowHistory(false)
    lastHistoryContentRef.current = history.content
  }

  const handleCreativePresetSelect = (preset: IPreset) => {
    addCard(preset.type as CardType, preset.label, preset.content)
    alert(t('cardAdded', { title: preset.label }))
  }

  const handleAddNewCard = (type: CardType) => {
    const title = getCardDefaultTitle(type)
    addCard(type, title, '')
    setShowAddCardModal(false)
    alert(t('cardAdded', { title }))
  }

  const handleApplyCardAgentProposal = (proposal: AgentWorkspaceProposal) => {
    if (proposal.kind === 'workspace_card_create') {
      addCard(proposal.cardDraft.type, proposal.cardDraft.title, proposal.cardDraft.content)
    }
    if (proposal.kind === 'workspace_card_update') {
      updateCards(Object.fromEntries(
        proposal.updates.map(update => [
          update.cardId,
          {
            ...(typeof update.title === 'string' ? { title: update.title } : {}),
            ...(typeof update.content === 'string' ? { content: update.content } : {})
          }
        ])
      ))
    }
  }

  const handleExportData = async () => {
    const data = await storage.exportData()
    await navigator.clipboard.writeText(data)
    alert('导出数据已复制到剪贴板。')
  }

  if (!isHydrated) {
    return <AppStartupScreen message={startupMessage} />
  }

  const saveStatusText = !userSettings.autoSave
    ? '自动保存已关闭'
    : saveStatus === 'loading'
    ? '加载存档...'
    : saveStatus === 'saving'
      ? '自动保存中...'
      : saveStatus === 'error'
        ? '保存失败'
        : lastSavedAt
          ? `已自动保存 ${new Date(lastSavedAt).toLocaleTimeString()}`
          : '已启用自动保存'

  const cardTypes = [
    { type: 'subject', label: cardTypeLabel('subject'), color: 'bg-blue-100 text-blue-700' },
    { type: 'action', label: cardTypeLabel('action'), color: 'bg-green-100 text-green-700' },
    { type: 'scene', label: cardTypeLabel('scene'), color: 'bg-purple-100 text-purple-700' },
    { type: 'style', label: cardTypeLabel('style'), color: 'bg-orange-100 text-orange-700' },
    { type: 'camera', label: cardTypeLabel('camera'), color: 'bg-red-100 text-red-700' },
    { type: 'lighting', label: cardTypeLabel('lighting'), color: 'bg-yellow-100 text-yellow-700' },
    { type: 'timing', label: cardTypeLabel('timing'), color: 'bg-amber-100 text-amber-700' },
    { type: 'audio', label: cardTypeLabel('audio'), color: 'bg-teal-100 text-teal-700' },
    { type: 'constraint', label: cardTypeLabel('constraint'), color: 'bg-purple-100 text-purple-700' },
    { type: 'custom', label: cardTypeLabel('custom'), color: 'bg-gray-100 text-gray-700' }
  ] as const

  const projectHomeContent = (trashMode = showProjectTrash) => (
    <ProjectHome
      projects={projects}
      projectTrash={projectTrash}
      selectedProjectIds={selectedProjectIds}
      selectedProjectTrashIds={selectedProjectTrashIds}
      showProjectTrash={trashMode}
      searchTerm={projectSearchTerm}
      promptHistory={promptHistory}
      onCreateProject={handleCreateProject}
      onOpenProject={openProject}
      onDeleteProject={handleDeleteProject}
      onRenameProject={handleRenameProject}
      onShowHistory={() => setShowHistory(true)}
      onToggleProjectSelection={handleToggleProjectSelection}
      onToggleProjectTrashSelection={handleToggleProjectTrashSelection}
      onSelectAllProjects={() => setSelectedProjectIds(projects.map(project => project.id))}
      onSelectAllProjectTrash={() => setSelectedProjectTrashIds(projectTrash.map(entry => entry.id))}
      onClearProjectSelection={() => setSelectedProjectIds([])}
      onClearProjectTrashSelection={() => setSelectedProjectTrashIds([])}
      onTrashSelectedProjects={handleTrashSelectedProjects}
      onRestoreSelectedProjects={handleRestoreSelectedProjects}
      onDeleteSelectedProjectsForever={handleDeleteSelectedProjectsForever}
      onShowProjectTrash={(show) => {
        if (trashMode && !show) setActiveTab('projects')
        setShowProjectTrash(show)
        setSelectedProjectIds([])
        setSelectedProjectTrashIds([])
      }}
    />
  )

  const content = activeTab === 'media' ? (
    <MediaScreen
      canPlaceOnCanvas={activeProject?.type === 'free-canvas' && Boolean(activeProject.freeCanvas)}
      referenceTarget={activeProject?.type === 'free-canvas'
        ? activeProject.freeCanvas?.nodes.find(node => (
            node.id === activeProject.freeCanvas?.selectedNodeId && node.kind === 'image-generator'
          )) || null
        : null}
      onPlaceOnCanvas={async capture => {
        const storedCapture = await storage.recentCaptures.getById(capture.id)
        if (storedCapture) await handlePlaceCaptureOnCanvas(storedCapture)
      }}
      onPlaceAsReference={async (capture, targetNodeId) => {
        const storedCapture = await storage.recentCaptures.getById(capture.id)
        if (storedCapture) await handlePlaceCaptureOnCanvas(storedCapture, { kind: 'reference', targetNodeId })
      }}
      onOpenPromptLibrary={() => setActiveTab('library')}
    />
  ) : activeTab === 'files' ? (
    <FileStorageScreen />
  ) : activeTab === 'trash' ? (
    <RecycleBinScreen projectTrash={projectHomeContent(true)} />
  ) : activeTab === 'capture' ? (
    <CaptureBarScreen
      status={captureToolbarStatus}
      errorMessage={captureToolbarError}
      onOpenToolbar={handleOpenCaptureToolbar}
      onCloseToolbar={handleCloseCaptureToolbar}
      clipboardStatus={clipboardCaptureStatus}
      clipboardMessage={clipboardCaptureMessage}
      onReadClipboard={() => void handleReadClipboard()}
      onPasteClipboard={handlePasteClipboard}
      onDropBrowserImage={event => void handleDropBrowserImage(event)}
      onOpenRecentCaptures={() => setActiveTab('media')}
    />
  ) : activeTab === 'library' ? (
    <PromptLibrary embedded />
  ) : activeTab === 'agents' ? (
    <AgentDashboard
      initialSection={imageModelReturnContext ? 'image-models' : 'text-models'}
      onAssignmentSaved={handleImageAssignmentSaved}
    />
  ) : activeTab === 'skillhub' ? (
    <SkillHubScreen />
  ) : activeTab === 'updates' ? (
    <UpdateScreen />
  ) : activeTab === 'me' ? (
    <MeScreen
      language={language}
      setLanguage={setLanguage}
      showSettings={showSettings}
      setShowSettings={setShowSettings}
      settings={userSettings}
      onSettingsChange={handleUpdateUserSettings}
      onExportData={handleExportData}
    />
  ) : showTemplateLibrary ? (
    <TemplateLibraryScreen onBack={handleBackFromTemplateLibrary} onCreateFromTemplate={handleCreateProjectFromTemplate} />
  ) : projectMode === 'builder' && activeProject?.type === 'storyboard' && activeProject.storyboard ? (
    <StoryboardBuilderScreen
      activeProject={activeProject}
      storyboard={activeProject.storyboard}
      onBack={handleBackToProjects}
      onRenameProject={() => handleRenameProject(activeProject)}
      onSave={handleSave}
      onChange={handleUpdateStoryboard}
    />
  ) : projectMode === 'builder' && activeProject?.type === 'free-canvas' && activeProject.freeCanvas ? (
    <FreeCanvasBuilderScreen
      activeProject={activeProject}
      freeCanvas={activeProject.freeCanvas}
      onBack={handleBackToProjects}
      onRenameProject={() => handleRenameProject(activeProject)}
      onSave={handleSave}
      onChange={handleUpdateFreeCanvas}
      onPersistCanvas={handlePersistFreeCanvas}
      imageGenerationNodeV1={imageGenerationNodeV1Enabled(userSettings)}
      onConfigureImageModel={handleConfigureImageModel}
      onOpenMedia={() => setActiveTab('media')}
    />
  ) : projectMode === 'builder' && activeProject?.type === 'three-stage' && activeProject.threeStage ? (
    <ThreeStageBuilderScreen
      activeProject={activeProject}
      threeStage={activeProject.threeStage}
      cameraPresets={getPresetsByType('camera')}
      onBack={handleBackToProjects}
      onRenameProject={() => handleRenameProject(activeProject)}
      onSave={handleSave}
      onChange={handleUpdateThreeStage}
      onIncrementPresetUsage={incrementUsage}
      threeStageTemplateSettings={threeStageTemplateSettings}
      onThreeStageTemplateSettingsChange={handleUpdateThreeStageTemplateSettings}
    />
  ) : projectMode === 'builder' && activeProject?.type === 'card' ? (
    <CardBuilderScreen
      activeProject={activeProject}
      pages={pages}
      currentPage={currentPage}
      currentCards={currentCards}
      currentPrompt={currentPrompt}
      selectedCardsCount={selectedCards.length}
      selectedCardIds={selectedCards}
      duplicateMode={duplicateMode}
      duplicateResult={duplicateResult}
      activeEditMode={activeEditMode}
      onBack={handleBackToProjects}
      onRenameProject={() => handleRenameProject(activeProject)}
      onSave={handleSave}
      onPromptChange={handlePromptChange}
      onCopyPrompt={handleCopyPrompt}
      onCopySelected={handleCopySelectedCards}
      onClearSelection={clearSelection}
      onToggleDuplicates={() => setDuplicateMode(value => !value)}
      onSwitchPage={switchPage}
      onAddPage={addPage}
      onRemovePage={removePage}
      onAddCard={() => setShowAddCardModal(true)}
      onEditModeChange={setActiveEditMode}
      onCreativePresetSelect={handleCreativePresetSelect}
      onApplyAgentProposal={handleApplyCardAgentProposal}
      activeCardId={activeCardId}
      t={t}
    />
  ) : projectHomeContent()

  return (
    <AppShell
      activeTab={activeTab}
      setActiveTab={(tab) => {
        setActiveTab(tab)
        setShowTemplateLibrary(false)
        if (tab !== 'projects') setProjectMode('home')
      }}
      projectMode={projectMode}
      saveStatus={saveStatus}
      saveStatusText={saveStatusText}
      activeProject={activeProject}
      projectSearchTerm={projectSearchTerm}
      onProjectSearchTermChange={setProjectSearchTerm}
      onCreateProject={handleCreateProject}
      onShowProjectTrash={() => {
        setActiveTab('trash')
        setProjectMode('home')
        setShowTemplateLibrary(false)
        setShowProjectTrash(true)
      }}
    >
      {content}

      {showHistory && (
        <HistoryModal histories={promptHistory} onClose={() => setShowHistory(false)} onRestore={handleRestoreHistory} />
      )}

      {showAddCardModal && (
        <AddCardModal cardTypes={cardTypes} onClose={() => setShowAddCardModal(false)} onAddCard={handleAddNewCard} />
      )}

      {showCreateProjectModal && (
        <CreateProjectModal
          onClose={() => setShowCreateProjectModal(false)}
          onCreateCard={handleCreateCardProject}
          onCreateStoryboard={handleCreateStoryboardProject}
          onCreateThreeStage={handleCreateThreeStageProject}
          onCreateFromTemplate={handleCreateProjectFromTemplate}
        />
      )}

      {renameProject && (
        <RenameProjectModal
          title={renameProjectTitle}
          onTitleChange={setRenameProjectTitle}
          onClose={() => {
            setRenameProject(null)
            setRenameProjectTitle('')
          }}
          onConfirm={handleConfirmRenameProject}
        />
      )}

      {activePresetCard && (
        <div className="fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-black/40" onClick={() => setActivePresetCardId(null)}>
          <div className="max-h-[70vh] w-[500px] cursor-default overflow-y-auto rounded-[24px] bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">{t('selectPresetPrompt')}</h3>
              <button className="rounded-full p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700" onClick={() => setActivePresetCardId(null)}>
                x
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {presetsForActiveCard.length > 0 ? (
                presetsForActiveCard.map(preset => (
                  <button
                    key={preset.id}
                    className="block rounded-2xl border border-gray-100 p-3 text-left transition hover:border-gray-300 hover:bg-gray-50"
                    onClick={async () => {
                      updateCard(activePresetCard.id, {
                        title: preset.label,
                        content: preset.content
                      })
                      await incrementUsage(preset.id)
                      setActivePresetCardId(null)
                    }}
                  >
                    <div className="mb-1 text-sm font-medium">{preset.label}</div>
                    <div className="line-clamp-2 text-xs text-gray-500">{preset.content}</div>
                  </button>
                ))
              ) : (
                <div className="py-8 text-center text-sm text-gray-500">{t('noPresetForType')}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  )
}

export default App
