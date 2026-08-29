import { startTransition } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCanvasEdit, AgentDocumentAttachment, AgentMessage, AgentWorkspaceContext, AgentWorkspaceProposal } from '@/models/Agent.model'

const DOCUMENT_RESOURCE_A = 'a'.repeat(32)
const DOCUMENT_RESOURCE_B = 'b'.repeat(32)

const settleConversationSelection = async (renderer: ReactTestRenderer, ariaLabel = '加载实验会话') => {
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': ariaLabel }).props.onClick()
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

const mocks = vi.hoisted(() => ({
  checkRuntime: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue({ proposals: [], canvasEdits: [] }),
  markProposalStatus: vi.fn(),
  init: vi.fn(),
  sessionError: undefined as string | undefined,
  sessionConversationId: undefined as string | undefined,
  retryRequest: undefined as undefined | {
    requestId: string
    content: string
    conversationId: string
    documentResourceIds: string[]
    explicitDocumentNodeIds: string[]
    documentAttachments: AgentDocumentAttachment[]
  },
  messages: [] as AgentMessage[],
  proposals: [] as AgentWorkspaceProposal[],
  storedMessages: [] as Array<Record<string, unknown>>,
  storedTurns: [] as Array<Record<string, unknown>>,
  hydrateSession: vi.fn(),
  updateInteraction: vi.fn(),
  reconcileDocumentEdits: vi.fn(),
  updateConversationModel: vi.fn()
}))

vi.mock('@/stores/agent.store', () => ({
  useAgentStore: () => ({
    runtimeStatus: 'connected',
    authStatus: 'authenticated',
    runtimeError: null,
    getAgentSession: () => ({
      messages: mocks.messages,
      proposals: mocks.proposals,
      running: false,
      runtimeError: mocks.sessionError,
      conversationId: mocks.sessionConversationId,
      retryRequest: mocks.retryRequest
    }),
    skills: [{ id: 'SKL-tone', name: 'Tone Helper', source: 'external', trustState: 'trusted', toolDependencies: [] }],
    models: [{
      key: 'connection-chat:doubao-seed-2-0-lite-260215',
      connectionId: 'connection-chat',
      providerId: 'volcengine-ark',
      modelId: 'doubao-seed-2-0-lite-260215',
      displayName: 'Doubao Seed 2.0 Lite',
      available: true,
      isDefault: true
    }],
    tools: [],
    checkRuntime: mocks.checkRuntime,
    sendMessage: mocks.sendMessage,
    markProposalStatus: mocks.markProposalStatus,
    hydrateSession: mocks.hydrateSession
  })
}))

vi.mock('@/components/agent/AgentConversationMenu', () => ({
  AgentConversationMenu: ({
    activeConversationId,
    onConversationChange
  }: {
    activeConversationId?: string
    onConversationChange: (value: Record<string, unknown>) => void
  }) => (
    <div data-active-conversation-id={activeConversationId || ''}>
      {[
        ['conversation-experimental', '加载实验会话'],
        ['conversation-b', '加载会话 B']
      ].map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-label={label}
          onClick={() => onConversationChange({
            id, projectId: 'project-a',
            entrypoint: 'workspace-chatbot-agent', mode: 'free-canvas-workspace', title: id,
            status: 'active', createdAt: 1, updatedAt: 2,
            modelBinding: {
              connectionId: 'connection-chat', providerId: 'volcengine-ark', modelId: 'doubao-seed-2-0-lite-260215'
            },
            interactionMode: 'chat-experimental', boundSkillIds: ['SKL-tone'], revision: 4,
            messages: mocks.storedMessages, proposals: [], turns: mocks.storedTurns
          })}
        >{label}</button>
      ))}
    </div>
  )
}))

vi.mock('@/storage/storage-service-client', () => ({
  storageServiceClient: {
    agentConversations: {
      updateProposal: vi.fn(),
      updateInteraction: mocks.updateInteraction
    }
  }
}))

vi.mock('@/services/agent-runtime-service', () => ({
  agentRuntimeService: {
    reconcileDocumentEdits: mocks.reconcileDocumentEdits,
    updateConversationModel: mocks.updateConversationModel
  }
}))

vi.mock('@/stores/preset.store', () => ({
  usePresetStore: () => ({
    presets: [],
    initialized: true,
    init: mocks.init
  })
}))

import { AgentCollaborationPanel } from './AgentCollaborationPanel'
import { AgentDocumentAttachments } from './agent/AgentDocumentAttachments'
import { CanvasAgentComposer } from './agent/CanvasAgentComposer'

const workspaceContext: AgentWorkspaceContext = {
  contextId: 'canvas-context',
  mode: 'free-canvas-workspace',
  projectId: 'project-a',
  projectTitle: 'Project A',
  snapshot: {
    nodes: [
      { id: 'text-1', kind: 'text', title: 'TXT-ABC123', displayText: 'Secret full prompt', userText: 'Secret full prompt' },
      { id: 'text-2', kind: 'text', title: 'Reference node', displayText: 'Reference body', userText: 'Reference body' }
    ]
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('AgentCollaborationPanel dense embedded mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sessionError = undefined
    mocks.sessionConversationId = undefined
    mocks.retryRequest = undefined
    mocks.messages = []
    mocks.proposals = []
    mocks.storedMessages = []
    mocks.storedTurns = []
    mocks.reconcileDocumentEdits.mockResolvedValue({ status: 'idle', canvasEdits: [] })
    mocks.updateConversationModel.mockResolvedValue({})
    mocks.hydrateSession.mockImplementation((_sessionKey, session) => {
      if (session.messages) mocks.messages = session.messages
    })
  })

  it('uses a compact context strip and inline composer without the full-width send bar', () => {
    const markup = renderToStaticMarkup(
      <AgentCollaborationPanel
        title="Free Canvas Agent"
        mode="free-canvas-workspace"
        workspaceContext={workspaceContext}
        contextLabel="已读取画布 · 1 个节点"
        onApplyWorkspaceProposal={vi.fn()}
        compact
        embedded
      />
    )

    expect(markup).toContain('已读取画布 · 1 个节点')
    expect(markup).toContain('可以直接修改当前画布')
    expect(markup).toContain('contenteditable="true"')
    expect(markup).toContain('aria-label="发送给 Agent"')
    expect(markup).toContain('Canvas Prompt Editor')
    expect(markup).toContain('Skill')
    expect(markup).toContain('Prompt库调取')
    expect(markup).toContain('aria-label="对话模型"')
    expect(markup).toContain('Doubao Seed 2.0 Lite')
    expect(markup).not.toContain('>发送给 Agent</button>')
  })

  it('hydrates the experimental mode and persistent Skill binding copy', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })

    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': 'Skill 选择' }).props.onClick())

    expect(renderer.root.findByProps({ 'aria-label': 'Agent 交互模式' }).props.value)
      .toBe('chat-experimental')
    expect(JSON.stringify(renderer.toJSON())).toContain('对话模式【测试中】')
    expect(JSON.stringify(renderer.toJSON())).toContain('本对话持续启用')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('仅作用于下一条消息')
    expect(mocks.hydrateSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        interactionMode: 'chat-experimental', boundSkillIds: ['SKL-tone'], revision: 4
      })
    )
  })

  it('forwards the explicit Storyboard transform selector only with the submitted experimental turn', async () => {
    let renderer!: ReactTestRenderer
    const props = {
      title: 'Free Canvas Agent', mode: 'free-canvas-workspace' as const, workspaceContext,
      onApplyWorkspaceProposal: vi.fn(), embedded: true
    }
    act(() => { renderer = create(<AgentCollaborationPanel {...props} />) })
    await settleConversationSelection(renderer)
    act(() => renderer.update(<AgentCollaborationPanel {...props} draftRequest={{
      id: 'storyboard-create-document-1', content: 'Create a storyboard',
      documentWriteContext: { operationKind: 'storyboard_create', documentNodeId: 'document-1' }
    }} />))

    await act(async () => {
      await renderer.root.findByType(CanvasAgentComposer).props.onSubmit('Create a storyboard', [])
    })

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Create a storyboard', [],
      expect.objectContaining({
        interactionMode: 'chat-experimental',
        documentWriteContext: { operationKind: 'storyboard_create', documentNodeId: 'document-1' }
      })
    )
  })

  it('replaces a one-draft Storyboard authority with a newer external draft that has no write context', async () => {
    const baseProps = {
      title: 'Free Canvas Agent', mode: 'free-canvas-workspace' as const, workspaceContext,
      onApplyWorkspaceProposal: vi.fn(), embedded: true
    }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(<AgentCollaborationPanel {...baseProps} draftRequest={{
        id: 'draft-with-authority', content: 'Create storyboard',
        documentWriteContext: { operationKind: 'storyboard_create', documentNodeId: 'document-1' }
      }} />)
    })
    await settleConversationSelection(renderer)
    act(() => renderer.update(<AgentCollaborationPanel {...baseProps} draftRequest={{
      id: 'newer-plain-draft', content: 'Plain follow-up'
    }} />))

    await act(async () => {
      await renderer.root.findByType(CanvasAgentComposer).props.onSubmit('Plain follow-up', [])
    })

    expect(mocks.sendMessage.mock.calls[mocks.sendMessage.mock.calls.length - 1]?.[2])
      .not.toHaveProperty('documentWriteContext')
  })

  it('clears one-turn write authority on session identity changes and after a failed send', async () => {
    const props = {
      title: 'Free Canvas Agent', mode: 'free-canvas-workspace' as const, workspaceContext,
      onApplyWorkspaceProposal: vi.fn(), embedded: true,
      draftRequest: {
        id: 'draft-session-authority', content: 'Create storyboard',
        documentWriteContext: { operationKind: 'storyboard_create' as const, documentNodeId: 'document-1' }
      }
    }
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<AgentCollaborationPanel {...props} sessionKey="session-a" />) })
    await settleConversationSelection(renderer)
    act(() => renderer.update(<AgentCollaborationPanel {...props} sessionKey="session-b" />))
    await act(async () => {
      await renderer.root.findByType(CanvasAgentComposer).props.onSubmit('After session switch', [])
    })
    expect(mocks.sendMessage.mock.calls[mocks.sendMessage.mock.calls.length - 1]?.[2])
      .not.toHaveProperty('documentWriteContext')

    act(() => renderer.update(<AgentCollaborationPanel {...props} sessionKey="session-b" draftRequest={{
      ...props.draftRequest, id: 'draft-failing-authority'
    }} />))
    mocks.sendMessage.mockRejectedValueOnce(new Error('runtime failed'))
    await act(async () => {
      try {
        await renderer.root.findByType(CanvasAgentComposer).props.onSubmit('Fail once', [])
      } catch {
        // The one-turn authority must be consumed even when the runtime rejects.
      }
    })
    mocks.sendMessage.mockResolvedValueOnce({ proposals: [], canvasEdits: [] })
    await act(async () => {
      await renderer.root.findByType(CanvasAgentComposer).props.onSubmit('Retry without stale authority', [])
    })
    expect(mocks.sendMessage.mock.calls[mocks.sendMessage.mock.calls.length - 1]?.[2])
      .not.toHaveProperty('documentWriteContext')
  })

  it('reconciles one pending Document edit on conversation hydration and locks send until apply settles', async () => {
    const pendingApply = deferred<boolean>()
    const edit = {
      kind: 'document_create' as const,
      id: 'edit-reconcile', editId: 'edit-reconcile', conversationId: 'conversation-experimental',
      requestId: 'request-reconcile', nodeId: 'document-reconcile',
      expectedResultDigest: `sha256:${'a'.repeat(64)}`,
      base: { projectRevision: 1 },
      payload: { title: 'Recovered', blocks: [], linkedDocumentResourceIds: [] },
      rationale: 'Recover the saved turn.'
    }
    mocks.reconcileDocumentEdits.mockResolvedValue({ status: 'pending_apply', canvasEdits: [edit] })
    const onApplyCanvasEdit = vi.fn(() => pendingApply.promise)
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent" mode="free-canvas-workspace" workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()} onApplyCanvasEdit={onApplyCanvasEdit} embedded
        />
      )
    })

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick()
      await Promise.resolve()
    })

    expect(mocks.reconcileDocumentEdits).toHaveBeenCalledWith('project-a', 'conversation-experimental')
    expect(onApplyCanvasEdit).toHaveBeenCalledWith(edit)
    expect(renderer.root.findByType(CanvasAgentComposer).props.disabled).toBe(true)

    await act(async () => { pendingApply.resolve(true); await pendingApply.promise })
    expect(renderer.root.findByType(CanvasAgentComposer).props.disabled).toBe(false)
  })

  it('holds the target reconciliation barrier from the request through the recovered apply', async () => {
    const pendingReconcile = deferred<{
      status: 'pending_apply'
      canvasEdits: AgentCanvasEdit[]
    }>()
    const pendingApply = deferred<boolean>()
    const edit = {
      kind: 'document_changes' as const,
      id: 'edit-reconcile-barrier', editId: 'edit-reconcile-barrier',
      conversationId: 'conversation-experimental', requestId: 'request-reconcile-barrier',
      nodeId: 'document-reconcile', expectedResultDigest: `sha256:${'b'.repeat(64)}`,
      base: { projectRevision: 1, nodeRevision: 2, nodeDigest: `sha256:${'a'.repeat(64)}` },
      payload: { operations: [] }, rationale: 'Recover the saved edit before local changes.'
    }
    mocks.reconcileDocumentEdits.mockReturnValue(pendingReconcile.promise)
    const onApplyCanvasEdit = vi.fn(() => pendingApply.promise)
    const onDocumentReconcileStateChange = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent" mode="free-canvas-workspace" workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()} onApplyCanvasEdit={onApplyCanvasEdit}
          onDocumentReconcileStateChange={onDocumentReconcileStateChange} embedded
        />
      )
    })

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick()
      await Promise.resolve()
    })

    expect(onDocumentReconcileStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', conversationId: 'conversation-experimental',
      leaseId: expect.any(String), pending: true
    }))
    expect(renderer.root.findByType(CanvasAgentComposer).props.disabled).toBe(true)
    expect(onApplyCanvasEdit).not.toHaveBeenCalled()

    await act(async () => {
      pendingReconcile.resolve({ status: 'pending_apply', canvasEdits: [edit] })
      await pendingReconcile.promise
      await Promise.resolve()
    })
    expect(onDocumentReconcileStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', conversationId: 'conversation-experimental',
      leaseId: expect.any(String), pending: true, nodeId: 'document-reconcile'
    }))
    expect(onApplyCanvasEdit).toHaveBeenCalledWith(edit)

    await act(async () => { pendingApply.resolve(true); await pendingApply.promise })
    expect(onDocumentReconcileStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', conversationId: 'conversation-experimental',
      leaseId: expect.any(String), pending: false
    }))
  })

  it('awaits the unique pending Document ledger target barrier before reconciliation starts', async () => {
    const barrier = deferred<void>()
    mocks.storedTurns = [
      {
        requestId: 'request-applied',
        applyEdit: {
          status: 'applied', kind: 'document_changes', nodeId: 'document-history',
          conversationId: 'conversation-experimental', requestId: 'request-applied', editId: 'edit-applied',
          expectedResultDigest: `sha256:${'a'.repeat(64)}`
        }
      },
      {
        requestId: 'request-pending',
        applyEdit: {
          status: 'pending_apply', kind: 'document_changes', nodeId: 'document-ledger-target',
          conversationId: 'conversation-experimental', requestId: 'request-pending', editId: 'edit-pending',
          expectedResultDigest: `sha256:${'b'.repeat(64)}`
        }
      }
    ]
    const onDocumentReconcileStateChange = vi.fn((state: {
      projectId: string
      conversationId: string
      leaseId: string
      pending: boolean
      nodeId?: string
    }) => state.pending ? barrier.promise : Promise.resolve())
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent" mode="free-canvas-workspace" workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()} onApplyCanvasEdit={vi.fn()}
          onDocumentReconcileStateChange={onDocumentReconcileStateChange} embedded
        />
      )
    })

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick()
      await Promise.resolve()
    })

    expect(onDocumentReconcileStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', conversationId: 'conversation-experimental',
      leaseId: expect.any(String), pending: true, nodeId: 'document-ledger-target'
    }))
    expect(mocks.reconcileDocumentEdits).not.toHaveBeenCalled()

    await act(async () => {
      barrier.resolve()
      await barrier.promise
      await Promise.resolve()
    })
    expect(mocks.reconcileDocumentEdits).toHaveBeenCalledWith('project-a', 'conversation-experimental')
  })

  it('releases the old conversation barrier when hydration switches during reconciliation', async () => {
    const pendingOldReconcile = deferred<{ status: 'idle'; canvasEdits: [] }>()
    mocks.reconcileDocumentEdits
      .mockReturnValueOnce(pendingOldReconcile.promise)
      .mockResolvedValueOnce({ status: 'idle', canvasEdits: [] })
    const onDocumentReconcileStateChange = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent" mode="free-canvas-workspace" workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()} onApplyCanvasEdit={vi.fn()}
          onDocumentReconcileStateChange={onDocumentReconcileStateChange} embedded
        />
      )
    })

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick()
      await Promise.resolve()
    })
    expect(onDocumentReconcileStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', conversationId: 'conversation-experimental',
      leaseId: expect.any(String), pending: true
    }))

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '加载会话 B' }).props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onDocumentReconcileStateChange).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a', conversationId: 'conversation-experimental',
      leaseId: expect.any(String), pending: false
    }))
    expect(onDocumentReconcileStateChange).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a', conversationId: 'conversation-b',
      leaseId: expect.any(String), pending: true
    }))
    expect(onDocumentReconcileStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', conversationId: 'conversation-b',
      leaseId: expect.any(String), pending: false
    }))
  })

  it('keeps the old target locked when conversation switches after recovered apply starts', async () => {
    const pendingApply = deferred<boolean>()
    const edit = {
      kind: 'document_changes' as const,
      id: 'edit-switch-apply', editId: 'edit-switch-apply',
      conversationId: 'conversation-experimental', requestId: 'request-switch-apply',
      nodeId: 'document-reconcile', expectedResultDigest: `sha256:${'b'.repeat(64)}`,
      base: { projectRevision: 1, nodeRevision: 2, nodeDigest: `sha256:${'a'.repeat(64)}` },
      payload: { operations: [] }, rationale: 'Recover before switching.'
    }
    mocks.reconcileDocumentEdits
      .mockResolvedValueOnce({ status: 'pending_apply', canvasEdits: [edit] })
      .mockResolvedValueOnce({ status: 'idle', canvasEdits: [] })
    const onDocumentReconcileStateChange = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent" mode="free-canvas-workspace" workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()} onApplyCanvasEdit={() => pendingApply.promise}
          onDocumentReconcileStateChange={onDocumentReconcileStateChange} embedded
        />
      )
    })

    await settleConversationSelection(renderer)
    expect(onDocumentReconcileStateChange).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a', conversationId: 'conversation-experimental',
      leaseId: expect.any(String), pending: true, nodeId: 'document-reconcile'
    }))

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '加载会话 B' }).props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onDocumentReconcileStateChange).not.toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a', conversationId: 'conversation-experimental', pending: false
    }))

    await act(async () => {
      pendingApply.resolve(true)
      await pendingApply.promise
      await Promise.resolve()
    })
    expect(onDocumentReconcileStateChange).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a', conversationId: 'conversation-experimental',
      leaseId: expect.any(String), pending: false
    }))
  })

  it('keeps a reselected conversation generation leased until that generation finishes', async () => {
    const firstApply = deferred<boolean>()
    const secondApply = deferred<boolean>()
    const edit = {
      kind: 'document_changes' as const,
      id: 'edit-reselected', editId: 'edit-reselected',
      conversationId: 'conversation-experimental', requestId: 'request-reselected',
      nodeId: 'document-reconcile', expectedResultDigest: `sha256:${'b'.repeat(64)}`,
      base: { projectRevision: 1, nodeRevision: 2, nodeDigest: `sha256:${'a'.repeat(64)}` },
      payload: { operations: [] }, rationale: 'Recover each selected generation safely.'
    }
    mocks.reconcileDocumentEdits.mockResolvedValue({ status: 'pending_apply', canvasEdits: [edit] })
    const onApplyCanvasEdit = vi.fn()
      .mockReturnValueOnce(firstApply.promise)
      .mockReturnValueOnce(secondApply.promise)
    const activeLeases = new Set<string>()
    const states: Array<Record<string, unknown>> = []
    const onDocumentReconcileStateChange = vi.fn((state: Record<string, unknown>) => {
      states.push(state)
      if (state.pending) activeLeases.add(String(state.leaseId))
      else activeLeases.delete(String(state.leaseId))
    })
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent" mode="free-canvas-workspace" workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()} onApplyCanvasEdit={onApplyCanvasEdit}
          onDocumentReconcileStateChange={onDocumentReconcileStateChange} embedded
        />
      )
    })

    await settleConversationSelection(renderer)
    await settleConversationSelection(renderer)

    expect(mocks.reconcileDocumentEdits).toHaveBeenCalledTimes(2)
    const targetLeases = states.filter(state => state.pending && state.nodeId === 'document-reconcile')
    expect(targetLeases).toHaveLength(2)
    expect(targetLeases[0].leaseId).not.toBe(targetLeases[1].leaseId)
    expect(targetLeases).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'project-a', conversationId: 'conversation-experimental' })
    ]))

    await act(async () => { firstApply.resolve(true); await firstApply.promise; await Promise.resolve() })
    expect(activeLeases).toEqual(new Set([targetLeases[1].leaseId as string]))

    await act(async () => { secondApply.resolve(true); await secondApply.promise; await Promise.resolve() })
    expect(activeLeases).toEqual(new Set())
  })

  it('never reconciles an active conversation against a different project and resumes its project lease on return', async () => {
    const pendingProjectAApply = deferred<boolean>()
    mocks.storedTurns = [{
      requestId: 'request-project-a',
      applyEdit: {
        status: 'pending_apply', kind: 'document_changes', nodeId: 'document-reconcile',
        conversationId: 'conversation-experimental', requestId: 'request-project-a',
        editId: 'edit-project-a', expectedResultDigest: `sha256:${'b'.repeat(64)}`
      }
    }]
    const edit = {
      kind: 'document_changes' as const,
      id: 'edit-project-a', editId: 'edit-project-a',
      conversationId: 'conversation-experimental', requestId: 'request-project-a',
      nodeId: 'document-reconcile', expectedResultDigest: `sha256:${'b'.repeat(64)}`,
      base: { projectRevision: 1, nodeRevision: 2, nodeDigest: `sha256:${'a'.repeat(64)}` },
      payload: { operations: [] }, rationale: 'Keep this edit scoped to project A.'
    }
    mocks.reconcileDocumentEdits
      .mockResolvedValueOnce({ status: 'pending_apply', canvasEdits: [edit] })
      .mockResolvedValueOnce({ status: 'idle', canvasEdits: [] })
    const states: Array<Record<string, unknown>> = []
    const onDocumentReconcileStateChange = vi.fn((state: Record<string, unknown>) => { states.push(state) })
    const renderPanel = (context: AgentWorkspaceContext) => (
      <AgentCollaborationPanel
        title="Free Canvas Agent" mode="free-canvas-workspace" workspaceContext={context}
        onApplyWorkspaceProposal={vi.fn()} onApplyCanvasEdit={() => pendingProjectAApply.promise}
        onDocumentReconcileStateChange={onDocumentReconcileStateChange} embedded
      />
    )
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(renderPanel(workspaceContext)) })
    await settleConversationSelection(renderer)

    const projectBContext = { ...workspaceContext, projectId: 'project-b', projectTitle: 'Project B' }
    await act(async () => {
      renderer.update(renderPanel(projectBContext))
      for (let index = 0; index < 4; index += 1) await Promise.resolve()
    })
    expect(mocks.reconcileDocumentEdits).not.toHaveBeenCalledWith('project-b', 'conversation-experimental')

    await act(async () => {
      renderer.update(renderPanel(workspaceContext))
      for (let index = 0; index < 4; index += 1) await Promise.resolve()
    })
    expect(mocks.reconcileDocumentEdits.mock.calls).toEqual([
      ['project-a', 'conversation-experimental'],
      ['project-a', 'conversation-experimental']
    ])
    expect(states.filter(state => state.pending)).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: 'project-a', conversationId: 'conversation-experimental' })
    ]))
    const projectATargetLeases = states.filter(state => (
      state.pending && state.projectId === 'project-a' && state.nodeId === 'document-reconcile'
    ))
    expect(new Set(projectATargetLeases.map(state => state.leaseId)).size).toBe(2)

    await act(async () => {
      pendingProjectAApply.resolve(true)
      await pendingProjectAApply.promise
      await Promise.resolve()
    })
  })

  it('keeps reconcile lease tokens unique across Panel remounts', async () => {
    const firstApply = deferred<boolean>()
    const secondApply = deferred<boolean>()
    const edit = {
      kind: 'document_changes' as const,
      id: 'edit-remount', editId: 'edit-remount',
      conversationId: 'conversation-experimental', requestId: 'request-remount',
      nodeId: 'document-reconcile', expectedResultDigest: `sha256:${'b'.repeat(64)}`,
      base: { projectRevision: 1, nodeRevision: 2, nodeDigest: `sha256:${'a'.repeat(64)}` },
      payload: { operations: [] }, rationale: 'Keep remounted Panel generations independent.'
    }
    mocks.reconcileDocumentEdits.mockResolvedValue({ status: 'pending_apply', canvasEdits: [edit] })
    const onApplyCanvasEdit = vi.fn()
      .mockReturnValueOnce(firstApply.promise)
      .mockReturnValueOnce(secondApply.promise)
    const activeLeases = new Set<string>()
    const targetLeaseIds: string[] = []
    const onDocumentReconcileStateChange = vi.fn((state: Record<string, unknown>) => {
      const leaseId = String(state.leaseId)
      if (state.pending) activeLeases.add(leaseId)
      else activeLeases.delete(leaseId)
      if (state.pending && state.nodeId === 'document-reconcile' && !targetLeaseIds.includes(leaseId)) {
        targetLeaseIds.push(leaseId)
      }
    })
    const panel = (
      <AgentCollaborationPanel
        title="Free Canvas Agent" mode="free-canvas-workspace" workspaceContext={workspaceContext}
        onApplyWorkspaceProposal={vi.fn()} onApplyCanvasEdit={onApplyCanvasEdit}
        onDocumentReconcileStateChange={onDocumentReconcileStateChange} embedded
      />
    )
    let firstRenderer!: ReactTestRenderer
    act(() => { firstRenderer = create(panel) })
    await settleConversationSelection(firstRenderer)
    act(() => firstRenderer.unmount())

    let secondRenderer!: ReactTestRenderer
    act(() => { secondRenderer = create(panel) })
    await settleConversationSelection(secondRenderer)

    expect(targetLeaseIds).toHaveLength(2)
    expect(targetLeaseIds[0]).not.toBe(targetLeaseIds[1])
    await act(async () => { firstApply.resolve(true); await firstApply.promise; await Promise.resolve() })
    expect(activeLeases).toEqual(new Set([targetLeaseIds[1]]))

    await act(async () => { secondApply.resolve(true); await secondApply.promise; await Promise.resolve() })
    expect(activeLeases).toEqual(new Set())
    act(() => secondRenderer.unmount())
  })

  it('does not expose a failed conversation retry after switching conversations', () => {
    mocks.sessionError = 'response lost'
    mocks.retryRequest = {
      requestId: 'request-a', content: 'continue A', conversationId: 'conversation-a',
      documentResourceIds: [], explicitDocumentNodeIds: [], documentAttachments: []
    }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })

    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())

    expect(JSON.stringify(renderer.toJSON())).not.toContain('使用原请求重试')
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('reuses the failed turn request ID and explicit Document identities', async () => {
    mocks.retryRequest = {
      requestId: 'request-document',
      content: 'Discuss the document',
      conversationId: 'conversation-experimental',
      documentResourceIds: [DOCUMENT_RESOURCE_A],
      explicitDocumentNodeIds: ['document-node-1'],
      documentAttachments: [{
        resourceId: DOCUMENT_RESOURCE_A, name: 'plan.md', contentType: 'text/markdown',
        size: 7, sha256: 'a'.repeat(64)
      }]
    }
    const documentContext: AgentWorkspaceContext = {
      ...workspaceContext,
      snapshot: {
        nodes: [{
          id: 'document-node-1', kind: 'document', title: 'Creative brief', revision: 4, digest: 'digest-1'
        }]
      }
    }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={documentContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    await settleConversationSelection(renderer)

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '使用原请求重试' }).props.onClick()
    })

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Discuss the document',
      [],
      expect.objectContaining({
        requestId: 'request-document',
        documentResourceIds: [DOCUMENT_RESOURCE_A],
        explicitDocumentNodeIds: ['document-node-1']
      })
    )
  })

  it('renders assistant Markdown as semantic conversation content', () => {
    mocks.messages = [{
      id: 'assistant-markdown',
      role: 'assistant',
      content: '## 推荐方案\n\n- 第一镜头\n- 第二镜头\n\n```text\ncinematic lighting\n```\n\n**重点**',
      createdAt: 1
    }]

    const markup = renderToStaticMarkup(
      <AgentCollaborationPanel
        title="Free Canvas Agent"
        mode="free-canvas-workspace"
        workspaceContext={workspaceContext}
        onApplyWorkspaceProposal={vi.fn()}
        embedded
      />
    )

    expect(markup).toContain('<h2')
    expect(markup).toContain('<ul')
    expect(markup).toContain('<li>第一镜头</li>')
    expect(markup).toContain('<pre')
    expect(markup).toContain('<code')
    expect(markup).toContain('<strong>重点</strong>')
    expect(markup).not.toContain('## 推荐方案')
  })

  it('moves the third quick action behind the compact overflow control', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          contextLabel="已读取画布"
          onApplyWorkspaceProposal={vi.fn()}
          compact
          embedded
        />
      )
    })

    act(() => renderer.root.findByProps({ 'aria-label': '新增卡片' }).props.onClick())
    expect(renderer.root.findByProps({ contentEditable: true }).props['data-agent-composer']).toBe(true)
  })

  it('sends with Enter while preserving Shift+Enter for a new line', async () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })

    const composer = renderer.root.findByProps({ contentEditable: true })
    act(() => composer.props.onInput({ currentTarget: { textContent: '修改画布内容' } }))
    act(() => composer.props.onKeyDown({
      key: 'Enter',
      shiftKey: true,
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn()
    }))
    expect(mocks.sendMessage).not.toHaveBeenCalled()

    await act(async () => {
      composer.props.onKeyDown({
        key: 'Enter',
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn()
      })
    })
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '修改画布内容',
      [],
      expect.objectContaining({ mode: 'free-canvas-workspace' })
    )
  })

  it('attaches a completion target without injecting its full content into the composer', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          draftRequest={{
            id: 'complete-text-node-1',
            canvasNode: { nodeId: 'text-1', role: 'target', mode: 'complete' }
          }}
          embedded
        />
      )
    })

    const markup = JSON.stringify(renderer.toJSON())
    expect(markup).toContain('TXT-ABC123')
    expect(markup).not.toContain('Secret full prompt')
    expect(renderer.root.findByProps({ 'aria-label': 'Canvas Agent 编辑模式' }).props.value).toBe('complete')
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('attaches an image node as an Agent reference', () => {
    const imageContext: AgentWorkspaceContext = {
      ...workspaceContext,
      snapshot: {
        nodes: [{ id: 'image-1', kind: 'image', title: 'Yellow Crane Tower reference', assetId: 'asset-1' }]
      }
    }

    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={imageContext}
          onApplyWorkspaceProposal={vi.fn()}
          draftRequest={{ id: 'reference-image-1', canvasNode: { nodeId: 'image-1', role: 'reference' } }}
          embedded
        />
      )
    })

    expect(JSON.stringify(renderer.toJSON())).toContain('Yellow Crane Tower reference')
  })

  it('applies a returned Canvas edit immediately without rendering approval controls', async () => {
    const applyCanvasEdit = vi.fn().mockResolvedValue(true)
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [],
      canvasEdits: [{
        id: 'canvas-edit-1',
        kind: 'free_canvas_text_insertions',
        agentName: 'PromptCard Agent',
        nodeId: 'text-1',
        insertions: [{
          text: ' inserted',
          reason: 'Add detail',
          anchor: { type: 'segment', segmentId: 'segment-1', position: 'after' }
        }],
        baseNodeRevision: 2,
        templateDigest: 'sha256:template',
        baseSegmentsDigest: 'sha256:segments',
        rationale: 'Complete the prompt',
        createdAt: 1
      }]
    })
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          onApplyCanvasEdit={applyCanvasEdit}
          draftRequest={{ id: 'target-1', canvasNode: { nodeId: 'text-1', role: 'target', mode: 'complete' } }}
          embedded
        />
      )
    })
    const composer = renderer.root.findByProps({ contentEditable: true })
    act(() => composer.props.onInput({ currentTarget: { textContent: 'Complete it' } }))

    await act(async () => {
      composer.props.onKeyDown({
        key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn()
      })
    })

    expect(applyCanvasEdit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'free_canvas_text_insertions', nodeId: 'text-1'
    }))
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Apply')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Reject')
  })

  it('previews every interleaved canvas insertion with its anchor reason', () => {
    mocks.proposals = [{
      kind: 'free_canvas_text_insertions',
      id: 'insert-1',
      agentName: 'PromptCard Agent',
      nodeId: 'text-1',
      insertions: [{
        text: 'Inserted detail',
        reason: 'Clarifies the framing after the preset.',
        anchor: { type: 'segment', segmentId: 'preset-1', position: 'after' }
      }],
      baseNodeRevision: 2,
      templateDigest: 'sha256:template',
      baseSegmentsDigest: 'sha256:segments',
      rationale: 'Add a framing detail.',
      status: 'pending',
      createdAt: 1
    } as AgentWorkspaceProposal]
    const context: AgentWorkspaceContext = {
      ...workspaceContext,
      snapshot: {
        nodes: [{
          id: 'text-1', kind: 'text', title: 'TXT-ABC123', displayText: 'PresetUser', userText: 'User',
          segments: [
            { id: 'preset-1', source: 'preset', text: 'Preset', color: '#ef4423' },
            { id: 'user-1', source: 'user', text: 'User', color: '#111827' }
          ]
        }]
      }
    }

    const markup = renderToStaticMarkup(
      <AgentCollaborationPanel
        title="Free Canvas Agent"
        mode="free-canvas-workspace"
        workspaceContext={context}
        onApplyWorkspaceProposal={vi.fn()}
        embedded
      />
    )

    expect(markup).toContain('data-canvas-text-insertions-preview="true"')
    expect(markup).toContain('Preset')
    expect(markup).toContain('Inserted detail')
    expect(markup).toContain('User')
    expect(markup).toContain('Clarifies the framing after the preset.')
    expect(markup).toContain('#ef4423')
    expect(markup).toContain('#111827')
  })

  it('renders a scrollable chat history with user messages aligned right and Agent messages left', () => {
    mocks.messages = Array.from({ length: 12 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `content-${index}`,
      createdAt: index
    }))

    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })

    const history = renderer.root.findByProps({ 'aria-label': 'Agent 对话消息' })
    expect(history.props.className).toContain('overflow-y-auto')
    expect(renderer.root.findAllByProps({ 'data-agent-message-role': 'user' })[0].props.className).toContain('justify-end')
    expect(renderer.root.findAllByProps({ 'data-agent-message-role': 'assistant' })[0].props.className).toContain('justify-start')
    const markup = JSON.stringify(renderer.toJSON())
    expect(markup).toContain('content-0')
    expect(markup).toContain('content-11')
  })

  it('summarizes oversized Prompt Library validation errors instead of expanding raw request data', () => {
    mocks.sessionError = '{"detail":[{"type":"too_long","loc":["body","promptLibrary"],"msg":"List should have at most 200 items after validation, not 254","input":[{"content":"secret prompt body"}]}]}'

    const markup = renderToStaticMarkup(
      <AgentCollaborationPanel
        title="Free Canvas Agent"
        mode="free-canvas-workspace"
        workspaceContext={workspaceContext}
        onApplyWorkspaceProposal={vi.fn()}
        embedded
      />
    )

    expect(markup).toContain('Prompt Library 条目超过上限（254/200）')
    expect(markup).not.toContain('secret prompt body')
  })

  it('keeps a referenced node in the pool while the modification target starts empty', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          draftRequest={{ id: 'reference-1', canvasNode: { nodeId: 'text-2', role: 'reference' } }}
          embedded
        />
      )
    })

    expect(renderer.root.findByProps({ 'aria-label': '选择被修改对象' }).props['aria-expanded']).toBe(false)
    expect(JSON.stringify(renderer.toJSON())).toContain('尚未选择被修改对象')
    expect(JSON.stringify(renderer.toJSON())).toContain('Reference node')

    act(() => renderer.root.findByProps({ 'aria-label': '选择被修改对象' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '设为被修改对象 Reference node' }).props.onClick())

    expect(JSON.stringify(renderer.toJSON())).toContain('被修改对象')
    expect(renderer.root.findByProps({ 'aria-label': '清空被修改对象' })).toBeTruthy()

    act(() => renderer.root.findByProps({ 'aria-label': '清空被修改对象' }).props.onClick())
    expect(JSON.stringify(renderer.toJSON())).toContain('尚未选择被修改对象')
    expect(JSON.stringify(renderer.toJSON())).toContain('Reference node')
  })

  it('sends mounted references with a null modification target', async () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          draftRequest={{ id: 'reference-only', canvasNode: { nodeId: 'text-2', role: 'reference' } }}
          embedded
        />
      )
    })

    const composer = renderer.root.findByProps({ contentEditable: true })
    act(() => composer.props.onInput({ currentTarget: { textContent: '先讨论参考节点' } }))
    await act(async () => {
      composer.props.onKeyDown({
        key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn()
      })
    })

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '先讨论参考节点',
      [],
      expect.objectContaining({
        canvasNodeContext: expect.objectContaining({
          targetNodeId: null,
          referenceNodeIds: ['text-2']
        })
      })
    )
  })

  it('opens the mounted-node mention list when @ follows Chinese text without whitespace', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          draftRequest={{ id: 'mention-reference', canvasNode: { nodeId: 'text-2', role: 'reference' } }}
          embedded
        />
      )
    })

    const composer = renderer.root.findByProps({ contentEditable: true })
    act(() => composer.props.onInput({ currentTarget: { textContent: '请参考@' } }))

    expect(renderer.root.findByProps({ 'aria-label': '可引用的文字节点' })).toBeTruthy()
    expect(JSON.stringify(renderer.toJSON())).toContain('Reference node')
  })

  it('retains node labels when sending fails', async () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          draftRequest={{ id: 'target-1', canvasNode: { nodeId: 'text-1', role: 'target', mode: 'complete' } }}
          embedded
        />
      )
    })
    const composer = renderer.root.findByProps({ contentEditable: true })
    act(() => composer.props.onInput({ currentTarget: { textContent: '补全它' } }))
    mocks.sessionError = 'runtime failed'

    await act(async () => {
      composer.props.onKeyDown({
        key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn()
      })
    })

    expect(JSON.stringify(renderer.toJSON())).toContain('TXT-ABC123')
  })

  it('sends current document and explicit Document node IDs, clearing them only after success', async () => {
    const documentContext: AgentWorkspaceContext = {
      ...workspaceContext,
      snapshot: {
        nodes: [
          ...(workspaceContext.snapshot.nodes as Array<Record<string, unknown>>),
          { id: 'document-node-1', kind: 'document', title: 'Creative brief', revision: 4, digest: 'digest-1' }
        ]
      }
    }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={documentContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    await settleConversationSelection(renderer)
    const attachment = {
      resourceId: DOCUMENT_RESOURCE_A, name: 'plan.md', contentType: 'text/markdown' as const,
      size: 7, sha256: 'a'.repeat(64)
    }
    act(() => renderer.root.findByType(AgentDocumentAttachments).props.onChange([attachment]))

    await act(async () => {
      await renderer.root.findByType(CanvasAgentComposer).props.onSubmit(
        'Discuss @Creative brief',
        [{ nodeId: 'document-node-1', label: 'Creative brief' }]
      )
    })

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Discuss @Creative brief',
      [],
      expect.objectContaining({
        documentResourceIds: [DOCUMENT_RESOURCE_A],
        explicitDocumentNodeIds: ['document-node-1'],
        documentAttachments: [attachment]
      })
    )
    expect(renderer.root.findByType(AgentDocumentAttachments).props.attachments).toEqual([])
  })

  it('retains current document selection after a failed send', async () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    await settleConversationSelection(renderer)
    const attachment = {
      resourceId: DOCUMENT_RESOURCE_A, name: 'plan.md', contentType: 'text/markdown' as const,
      size: 7, sha256: 'a'.repeat(64)
    }
    act(() => renderer.root.findByType(AgentDocumentAttachments).props.onChange([attachment]))
    mocks.sessionError = 'runtime failed'

    await act(async () => {
      await renderer.root.findByType(CanvasAgentComposer).props.onSubmit('Discuss the plan', [])
    })

    expect(renderer.root.findByType(AgentDocumentAttachments).props.attachments).toEqual([attachment])
  })

  it('hydrates durable attachment audit as read-only history without preselecting it', () => {
    mocks.storedMessages = [{
      id: 'stored-user-message', role: 'user', text: 'Discuss the plan', createdAt: 1,
      documentAttachments: [{
        resourceId: DOCUMENT_RESOURCE_A, name: 'historic-plan.md', contentType: 'text/markdown', size: 7
      }]
    }]
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })

    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())

    expect(JSON.stringify(renderer.toJSON())).toContain('historic-plan.md')
    expect(renderer.root.findByType(AgentDocumentAttachments).props.attachments).toEqual([])
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('does not carry a current document selection into another project identity', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    act(() => renderer.root.findByType(AgentDocumentAttachments).props.onChange([{
      resourceId: DOCUMENT_RESOURCE_A, name: 'plan.md', contentType: 'text/markdown',
      size: 7, sha256: 'a'.repeat(64)
    }]))

    act(() => renderer.update(
      <AgentCollaborationPanel
        title="Free Canvas Agent"
        mode="free-canvas-workspace"
        workspaceContext={{ ...workspaceContext, projectId: 'project-b', projectTitle: 'Project B' }}
        onApplyWorkspaceProposal={vi.fn()}
        embedded
      />
    ))

    expect(renderer.root.findByType(AgentDocumentAttachments).props.attachments).toEqual([])
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    [1, 'single-file upload'],
    [3, 'batch upload']
  ] as const)('disables and guards send during a %i-file upload (%s)', async (uploadingCount, _label) => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    act(() => renderer.root.findByType(AgentDocumentAttachments).props.onUploadingChange(uploadingCount))

    expect(renderer.root.findByType(CanvasAgentComposer).props.disabled).toBe(true)
    await act(async () => {
      await renderer.root.findByType(CanvasAgentComposer).props.onSubmit('Do not send yet', [])
    })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('freezes an empty retry document snapshot instead of falling back to the current selection', async () => {
    mocks.sessionError = 'response lost'
    mocks.retryRequest = {
      requestId: 'request-empty-documents',
      content: 'Retry without documents',
      conversationId: 'conversation-experimental',
      documentResourceIds: [],
      explicitDocumentNodeIds: [],
      documentAttachments: []
    }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    act(() => renderer.root.findByType(AgentDocumentAttachments).props.onChange([{
      resourceId: DOCUMENT_RESOURCE_B, name: 'current.md', contentType: 'text/markdown',
      size: 8, sha256: 'b'.repeat(64)
    }]))

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '使用原请求重试' }).props.onClick()
    })

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Retry without documents',
      [],
      expect.objectContaining({
        requestId: 'request-empty-documents',
        documentResourceIds: [],
        explicitDocumentNodeIds: [],
        documentAttachments: []
      })
    )
  })

  it('deduplicates explicit Document mentions in first-use order and caps them at five', async () => {
    const documentNodes = Array.from({ length: 6 }, (_, index) => ({
      id: `document-node-${index + 1}`,
      kind: 'document',
      title: `Document ${index + 1}`,
      revision: 1,
      digest: `digest-${index + 1}`
    }))
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={{ ...workspaceContext, snapshot: { nodes: documentNodes } }}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    const mentions = [
      documentNodes[0], documentNodes[0], documentNodes[1], documentNodes[2],
      documentNodes[3], documentNodes[4], documentNodes[5]
    ].map(node => ({ nodeId: node.id, label: node.title }))

    await act(async () => {
      await renderer.root.findByType(CanvasAgentComposer).props.onSubmit('Discuss documents', mentions)
    })

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Discuss documents',
      [],
      expect.objectContaining({
        explicitDocumentNodeIds: documentNodes.slice(0, 5).map(node => node.id)
      })
    )
  })

  it('shows a fixed post-send error without restoring attachments or runtime retry when Canvas apply throws', async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [],
      canvasEdits: [{ id: 'edit-1', kind: 'free_canvas_text_create' }]
    })
    const applyCanvasEdit = vi.fn().mockRejectedValue(new Error('apply failed'))
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          onApplyCanvasEdit={applyCanvasEdit}
          embedded
        />
      )
    })
    await settleConversationSelection(renderer)
    act(() => renderer.root.findByType(AgentDocumentAttachments).props.onChange([{
      resourceId: DOCUMENT_RESOURCE_A, name: 'plan.md', contentType: 'text/markdown',
      size: 7, sha256: 'a'.repeat(64)
    }]))
    const composer = renderer.root.findByProps({ 'data-agent-composer': true })
    act(() => composer.props.onInput({ currentTarget: { textContent: 'Apply edit' } }))

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
    })

    expect(renderer.root.findByType(AgentDocumentAttachments).props.attachments).toEqual([])
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.retryRequest).toBeUndefined()
    expect(JSON.stringify(renderer.toJSON())).not.toContain('使用原请求重试')
    expect(JSON.stringify(renderer.toJSON())).toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })

  it('shows the same fixed post-send error when automatic workspace apply throws', async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [{
        id: 'proposal-1', kind: 'workspace_card_update', agentName: 'PromptCard Agent',
        updates: [{ cardId: 'card-1', content: 'Updated' }], rationale: 'Apply update',
        status: 'pending', createdAt: 1
      }],
      canvasEdits: []
    })
    const applyWorkspaceProposal = vi.fn().mockRejectedValue(new Error('workspace apply failed'))
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={applyWorkspaceProposal}
          autoApplyWorkspaceChanges
          embedded
        />
      )
    })
    const composer = renderer.root.findByProps({ 'data-agent-composer': true })
    act(() => composer.props.onInput({ currentTarget: { textContent: 'Apply workspace proposal' } }))

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
    })

    expect(applyWorkspaceProposal).toHaveBeenCalledOnce()
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.retryRequest).toBeUndefined()
    expect(JSON.stringify(renderer.toJSON())).not.toContain('使用原请求重试')
    expect(JSON.stringify(renderer.toJSON())).toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })

  it('contains a rejected post-send apply from the actual retry button without another runtime turn', async () => {
    mocks.retryRequest = {
      requestId: 'request-apply-retry', content: 'Retry and apply',
      conversationId: 'conversation-experimental', documentResourceIds: [],
      explicitDocumentNodeIds: [], documentAttachments: []
    }
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [],
      canvasEdits: [{ id: 'edit-retry', kind: 'free_canvas_text_create' }]
    })
    const applyCanvasEdit = vi.fn().mockRejectedValue(new Error('retry apply failed'))
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          onApplyCanvasEdit={applyCanvasEdit}
          embedded
        />
      )
    })
    await settleConversationSelection(renderer)

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '使用原请求重试' }).props.onClick()
    })

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(renderer.toJSON())).toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })

  it('does not show conversation A Canvas apply failure after switching to conversation B', async () => {
    const pendingApply = deferred<boolean | void>()
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [],
      canvasEdits: [{ id: 'edit-conversation-a', kind: 'free_canvas_text_create' }]
    })
    const applyCanvasEdit = vi.fn(() => pendingApply.promise)
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          onApplyCanvasEdit={applyCanvasEdit}
          embedded
        />
      )
    })
    await settleConversationSelection(renderer)
    const composer = renderer.root.findByProps({ 'data-agent-composer': true })
    act(() => composer.props.onInput({ currentTarget: { textContent: 'Apply in conversation A' } }))
    let submission!: Promise<void>
    await act(async () => {
      submission = renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
      await Promise.resolve()
    })
    expect(applyCanvasEdit).toHaveBeenCalledOnce()

    await settleConversationSelection(renderer, '加载会话 B')
    await act(async () => {
      pendingApply.reject(new Error('conversation A apply failed'))
      await submission
    })

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })

  it('does not show conversation A workspace apply failure after switching to conversation B', async () => {
    const pendingApply = deferred<boolean | void>()
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [{
        id: 'proposal-conversation-a', kind: 'workspace_card_update', agentName: 'PromptCard Agent',
        updates: [{ cardId: 'card-1', content: 'Updated' }], rationale: 'Apply update',
        status: 'pending', createdAt: 1
      }],
      canvasEdits: []
    })
    const applyWorkspaceProposal = vi.fn(() => pendingApply.promise)
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={applyWorkspaceProposal}
          autoApplyWorkspaceChanges
          embedded
        />
      )
    })
    await settleConversationSelection(renderer)
    const composer = renderer.root.findByProps({ 'data-agent-composer': true })
    act(() => composer.props.onInput({ currentTarget: { textContent: 'Apply workspace in conversation A' } }))
    let submission!: Promise<void>
    await act(async () => {
      submission = renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
      await Promise.resolve()
    })
    expect(applyWorkspaceProposal).toHaveBeenCalledOnce()

    await settleConversationSelection(renderer, '加载会话 B')
    await act(async () => {
      pendingApply.reject(new Error('conversation A workspace apply failed'))
      await submission
    })

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })

  it('does not let an older apply failure overwrite a newer successful attempt in the same conversation', async () => {
    const firstApply = deferred<boolean | void>()
    mocks.sendMessage
      .mockResolvedValueOnce({
        proposals: [],
        canvasEdits: [{ id: 'edit-old-attempt', kind: 'free_canvas_text_create' }]
      })
      .mockResolvedValueOnce({
        proposals: [],
        canvasEdits: [{ id: 'edit-new-attempt', kind: 'free_canvas_text_create' }]
      })
    const applyCanvasEdit = vi.fn()
      .mockImplementationOnce(() => firstApply.promise)
      .mockResolvedValueOnce(true)
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          onApplyCanvasEdit={applyCanvasEdit}
          embedded
        />
      )
    })
    await settleConversationSelection(renderer)
    act(() => renderer.root.findByProps({ 'data-agent-composer': true }).props.onInput({
      currentTarget: { textContent: 'Start old apply' }
    }))
    let firstSubmission!: Promise<void>
    await act(async () => {
      firstSubmission = renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
      await Promise.resolve()
    })
    expect(applyCanvasEdit).toHaveBeenCalledTimes(1)

    act(() => renderer.root.findByProps({ 'data-agent-composer': true }).props.onInput({
      currentTarget: { textContent: 'Start newer apply' }
    }))
    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
    })
    expect(applyCanvasEdit).toHaveBeenCalledTimes(2)

    await act(async () => {
      firstApply.reject(new Error('old apply failed'))
      await firstSubmission
    })

    expect(mocks.sendMessage).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })

  it('keeps the current Canvas apply attempt valid when the active conversation is reselected', async () => {
    const pendingApply = deferred<boolean | void>()
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [],
      canvasEdits: [{ id: 'edit-reselected-conversation', kind: 'free_canvas_text_create' }]
    })
    const applyCanvasEdit = vi.fn(() => pendingApply.promise)
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          onApplyCanvasEdit={applyCanvasEdit}
          embedded
        />
      )
    })
    await settleConversationSelection(renderer)
    act(() => renderer.root.findByProps({ 'data-agent-composer': true }).props.onInput({
      currentTarget: { textContent: 'Apply after reselecting this conversation' }
    }))
    let submission!: Promise<void>
    await act(async () => {
      submission = renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
      await Promise.resolve()
    })
    expect(applyCanvasEdit).toHaveBeenCalledOnce()

    await settleConversationSelection(renderer)
    await act(async () => {
      pendingApply.reject(new Error('current conversation Canvas apply failed'))
      await submission
    })

    expect(JSON.stringify(renderer.toJSON())).toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })

  it('keeps the current workspace apply attempt valid when the active conversation is reselected', async () => {
    const pendingApply = deferred<boolean | void>()
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [{
        id: 'proposal-reselected-conversation', kind: 'workspace_card_update', agentName: 'PromptCard Agent',
        updates: [{ cardId: 'card-1', content: 'Updated' }], rationale: 'Apply update',
        status: 'pending', createdAt: 1
      }],
      canvasEdits: []
    })
    const applyWorkspaceProposal = vi.fn(() => pendingApply.promise)
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={applyWorkspaceProposal}
          autoApplyWorkspaceChanges
          embedded
        />
      )
    })
    await settleConversationSelection(renderer)
    act(() => renderer.root.findByProps({ 'data-agent-composer': true }).props.onInput({
      currentTarget: { textContent: 'Apply workspace after reselecting this conversation' }
    }))
    let submission!: Promise<void>
    await act(async () => {
      submission = renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
      await Promise.resolve()
    })
    expect(applyWorkspaceProposal).toHaveBeenCalledOnce()

    await settleConversationSelection(renderer)
    await act(async () => {
      pendingApply.reject(new Error('current conversation workspace apply failed'))
      await submission
    })

    expect(JSON.stringify(renderer.toJSON())).toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })

  it('drops an old apply failure after a new project and session identity commits', async () => {
    const pendingApply = deferred<boolean | void>()
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [],
      canvasEdits: [{ id: 'edit-old-committed-identity', kind: 'free_canvas_text_create' }]
    })
    const applyCanvasEdit = vi.fn(() => pendingApply.promise)
    const changedWorkspaceContext: AgentWorkspaceContext = {
      ...workspaceContext,
      contextId: 'canvas-context-b',
      projectId: 'project-b',
      projectTitle: 'Project B'
    }
    const panel = (sessionKey: string, context: AgentWorkspaceContext) => (
      <AgentCollaborationPanel
        title="Free Canvas Agent"
        mode="free-canvas-workspace"
        sessionKey={sessionKey}
        workspaceContext={context}
        onApplyWorkspaceProposal={vi.fn()}
        onApplyCanvasEdit={applyCanvasEdit}
        embedded
      />
    )
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(panel('session-a', workspaceContext))
    })
    await settleConversationSelection(renderer)
    act(() => renderer.root.findByProps({ 'data-agent-composer': true }).props.onInput({
      currentTarget: { textContent: 'Apply before committed identity switch' }
    }))
    let submission!: Promise<void>
    await act(async () => {
      submission = renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
      await Promise.resolve()
    })

    act(() => renderer.update(panel('session-b', changedWorkspaceContext)))
    expect(renderer.root.findByType(AgentCollaborationPanel).props.sessionKey).toBe('session-b')
    await act(async () => {
      pendingApply.reject(new Error('old committed identity apply failed'))
      await submission
    })

    expect(JSON.stringify(renderer.toJSON())).not.toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })

  it('does not invalidate a committed apply attempt from an identity render that suspends before commit', async () => {
    const reactActEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean
    }
    const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    try {
      const pendingApply = deferred<boolean | void>()
      const neverCommits = new Promise<never>(() => undefined)
      mocks.sendMessage.mockResolvedValueOnce({
        proposals: [],
        canvasEdits: [{ id: 'edit-before-aborted-render', kind: 'free_canvas_text_create' }]
      })
      const applyCanvasEdit = vi.fn(() => pendingApply.promise)
      const changedWorkspaceContext: AgentWorkspaceContext = {
        ...workspaceContext,
        contextId: 'canvas-context-uncommitted',
        projectId: 'project-uncommitted',
        projectTitle: 'Uncommitted Project'
      }
      function SuspendBeforeCommit(): never {
        throw neverCommits
      }
      function ConcurrentIdentityHarness({
        sessionKey,
        context,
        suspend
      }: {
        sessionKey: string
        context: AgentWorkspaceContext
        suspend: boolean
      }) {
        return (
          <>
            <AgentCollaborationPanel
              title="Free Canvas Agent"
              mode="free-canvas-workspace"
              sessionKey={sessionKey}
              workspaceContext={context}
              onApplyWorkspaceProposal={vi.fn()}
              onApplyCanvasEdit={applyCanvasEdit}
              embedded
            />
            {suspend ? <SuspendBeforeCommit /> : null}
          </>
        )
      }
      let renderer!: ReactTestRenderer
      await act(async () => {
        renderer = create(
          <ConcurrentIdentityHarness sessionKey="session-committed" context={workspaceContext} suspend={false} />,
          { unstable_isConcurrent: true } as never
        )
      })
      await settleConversationSelection(renderer)
      act(() =>
        renderer.root.findByProps({ 'data-agent-composer': true }).props.onInput({
          currentTarget: {
            textContent: 'Apply while another identity render aborts'
          }
        })
      )
      let submission!: Promise<void>
      await act(async () => {
        submission = renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
        await Promise.resolve()
      })

      act(() => {
        startTransition(() => {
          renderer.update(
            <ConcurrentIdentityHarness sessionKey="session-uncommitted" context={changedWorkspaceContext} suspend />
          )
        })
      })
      expect(renderer.root.findByType(AgentCollaborationPanel).props.sessionKey).toBe('session-committed')

      await act(async () => {
        pendingApply.reject(new Error('committed apply failed'))
        await submission
      })

      expect(JSON.stringify(renderer.toJSON())).toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
    } finally {
      reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    }
  })

  it('migrates the current apply attempt to a durable new conversation identity', async () => {
    const pendingApply = deferred<boolean | void>()
    mocks.sendMessage.mockImplementationOnce(async () => {
      mocks.sessionConversationId = 'conversation-created'
      return {
        proposals: [],
        canvasEdits: [{ id: 'edit-created-conversation', kind: 'free_canvas_text_create' }]
      }
    })
    const applyCanvasEdit = vi.fn(() => pendingApply.promise)
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          onApplyCanvasEdit={applyCanvasEdit}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'data-agent-composer': true }).props.onInput({
      currentTarget: { textContent: 'Create durable conversation and apply' }
    }))
    let submission!: Promise<void>
    await act(async () => {
      submission = renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
      await Promise.resolve()
    })
    expect(renderer.root.findByProps({ 'data-active-conversation-id': 'conversation-created' })).toBeTruthy()

    await act(async () => {
      pendingApply.reject(new Error('current migrated apply failed'))
      await submission
    })

    expect(JSON.stringify(renderer.toJSON())).toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })

  it('does not migrate a stale response to its durable conversation identity', async () => {
    const pendingSend = deferred<{
      proposals: AgentWorkspaceProposal[]
      canvasEdits: Array<{ id: string; kind: 'free_canvas_text_create' }>
    }>()
    mocks.sendMessage.mockReturnValueOnce(pendingSend.promise)
    const applyCanvasEdit = vi.fn().mockRejectedValue(new Error('stale response apply failed'))
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          onApplyCanvasEdit={applyCanvasEdit}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'data-agent-composer': true }).props.onInput({
      currentTarget: { textContent: 'Send before selecting another conversation' }
    }))
    let submission!: Promise<void>
    act(() => {
      submission = renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载会话 B' }).props.onClick())

    mocks.sessionConversationId = 'conversation-created-from-stale-send'
    await act(async () => {
      pendingSend.resolve({
        proposals: [],
        canvasEdits: [{ id: 'edit-stale-created-conversation', kind: 'free_canvas_text_create' }]
      })
      await submission
    })

    expect(renderer.root.findByProps({ 'data-active-conversation-id': 'conversation-b' })).toBeTruthy()
    expect(JSON.stringify(renderer.toJSON())).not.toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })
})
