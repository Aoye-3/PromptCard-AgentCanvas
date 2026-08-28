import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from './agent.store'
import type { AgentWorkspaceContext, AgentWorkspaceProposal } from '@/models/Agent.model'
import type { IPreset } from '@/models/Card.model'

const workspaceProposal: AgentWorkspaceProposal = {
  kind: 'workspace_card_update',
  id: 'proposal-card',
  contextId: 'card:project-1:0',
  threadId: null,
  runId: null,
  agentName: 'DeepSeek Agent',
  updates: [{ cardId: 'card-1', content: 'Updated subject content' }],
  rationale: 'Make the selected card more specific',
  status: 'pending',
  createdAt: 1
}

const serviceMock = vi.hoisted(() => ({
  health: vi.fn(),
  bootstrap: vi.fn(),
  me: vi.fn(),
  catalog: vi.fn(),
  sendMessage: vi.fn(),
  getModelConfig: vi.fn(),
  saveModelConfig: vi.fn(),
  testModelConfig: vi.fn()
}))

const DOCUMENT_RESOURCE_A = 'a'.repeat(32)
const DOCUMENT_RESOURCE_B = 'b'.repeat(32)

vi.mock('@/services/agent-runtime-service', () => ({
  agentRuntimeService: serviceMock
}))

describe('agent store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serviceMock.sendMessage.mockResolvedValue({
      threadId: 'thread-1',
      text: 'agent response',
      proposals: [workspaceProposal],
      canvasEdits: [],
      diagnostics: {}
    })
    serviceMock.getModelConfig.mockResolvedValue({
      enabled: true,
      apiBase: 'https://api.deepseek.com',
      apiKeyConfigured: false,
      apiKeyPreview: null,
      modelName: 'deepseek-chat',
      temperature: 0.3,
      maxTokens: 4096,
      availableModels: ['deepseek-chat']
    })
    serviceMock.saveModelConfig.mockResolvedValue({
      enabled: true,
      apiBase: 'https://api.deepseek.com',
      apiKeyConfigured: true,
      apiKeyPreview: 'sk-...1234',
      modelName: 'deepseek-chat',
      temperature: 0.2,
      maxTokens: 3000,
      availableModels: ['deepseek-chat']
    })
    serviceMock.testModelConfig.mockResolvedValue({ success: true, message: 'ok' })
    serviceMock.catalog.mockResolvedValue({
      models: [],
      skills: [],
      tools: [],
      builtins: [],
      subagentEnabled: false,
      agents: []
    })
    useAgentStore.setState({
      runtimeStatus: 'connected',
      authStatus: 'authenticated',
      runtimeError: undefined,
      user: undefined,
      models: [],
      skills: [],
      tools: [],
      builtinTools: [],
      subagentEnabled: false,
      agents: [],
      sessionsByKey: {},
      modelConfig: undefined,
      modelConfigSaving: false,
      modelConfigTesting: false,
      modelConfigTestResult: undefined
    })
  })

  it('returns workspace proposals from sendMessage for approval UI', async () => {
    const workspaceContext: AgentWorkspaceContext = {
      contextId: 'card:project-1:0',
      mode: 'card-workspace',
      projectId: 'project-1',
      projectTitle: 'Project',
      snapshot: {
        selectedCardIds: ['card-1'],
        cards: [{ id: 'card-1', type: 'subject', title: 'Subject', content: '' }]
      }
    }

    const returned = await useAgentStore.getState().sendMessage('Improve selected card', [], {
      sessionKey: 'workspace:card:project-1',
      workspaceContext,
      mode: 'card-workspace'
    })

    const expectedProposal = { ...workspaceProposal, threadId: 'thread-1' }
    const session = useAgentStore.getState().getAgentSession('workspace:card:project-1')
    expect(returned).toEqual({ proposals: [expectedProposal], canvasEdits: [] })
    expect(session.proposals).toEqual([expectedProposal])
    expect(serviceMock.sendMessage).toHaveBeenCalledWith({
      threadId: undefined,
      requestId: expect.any(String),
      content: 'Improve selected card',
      mode: 'card-workspace',
      permissionScope: 'workspace-chatbot-agent',
      sessionKey: 'workspace:card:project-1',
      projectId: 'project-1',
      promptLibrary: [],
      workspaceContext
    })
  })

  it('forwards explicit Canvas node roles and edit mode to the Gateway', async () => {
    const canvasNodeContext = {
      mode: 'complete' as const,
      targetNodeId: 'text-1',
      referenceNodeIds: ['text-2'],
      mentions: [{ nodeId: 'text-2', label: 'Reference' }]
    }

    await useAgentStore.getState().sendMessage('参考 @Reference 补全目标', [], {
      sessionKey: 'workspace:free-canvas:project-1',
      mode: 'free-canvas-workspace',
      workspaceContext: {
        contextId: 'free-canvas:project-1:canvas',
        mode: 'free-canvas-workspace',
        projectId: 'project-1',
        projectTitle: 'Project',
        snapshot: {}
      },
      canvasNodeContext
    })

    expect(serviceMock.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ canvasNodeContext }))
  })

  it('forwards document identities and records only metadata on the optimistic user message', async () => {
    const documentAttachments = [{
      resourceId: DOCUMENT_RESOURCE_A,
      name: 'plan.md',
      contentType: 'text/markdown' as const,
      size: 7,
      sha256: 'a'.repeat(64)
    }]

    await useAgentStore.getState().sendMessage('Discuss the plan', [], {
      sessionKey: 'workspace:free-canvas:project-1',
      mode: 'free-canvas-workspace',
      interactionMode: 'chat-experimental',
      documentResourceIds: [DOCUMENT_RESOURCE_A],
      explicitDocumentNodeIds: ['document-node-1'],
      documentAttachments
    })

    expect(serviceMock.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      documentResourceIds: [DOCUMENT_RESOURCE_A],
      explicitDocumentNodeIds: ['document-node-1']
    }))
    expect(useAgentStore.getState().getAgentSession('workspace:free-canvas:project-1').messages[0])
      .toMatchObject({ role: 'user', documentAttachments })
  })

  it('returns validated Canvas edits separately without storing them as pending proposals', async () => {
    const canvasEdit = {
      id: 'canvas-edit-1',
      kind: 'free_canvas_text_insertions' as const,
      agentName: 'PromptCard Agent',
      nodeId: 'text-1',
      insertions: [{
        text: ' inserted',
        reason: 'Add detail',
        anchor: { type: 'segment' as const, segmentId: 'segment-1', position: 'after' as const }
      }],
      baseNodeRevision: 7,
      templateDigest: 'sha256:template',
      baseSegmentsDigest: 'sha256:segments',
      rationale: 'Complete the prompt',
      createdAt: 1
    }
    serviceMock.sendMessage.mockResolvedValueOnce({
      threadId: 'thread-1',
      text: 'Canvas edit generated.',
      proposals: [],
      canvasEdits: [canvasEdit]
    })

    const returned = await useAgentStore.getState().sendMessage('Complete it', [], {
      sessionKey: 'workspace:free-canvas:project-1',
      mode: 'free-canvas-workspace',
      canvasNodeContext: {
        mode: 'complete', targetNodeId: 'text-1', referenceNodeIds: [], mentions: []
      }
    })

    expect(returned).toEqual({
      proposals: [],
      canvasEdits: [{ ...canvasEdit, threadId: 'thread-1', contextId: undefined }]
    })
    expect(useAgentStore.getState().getAgentSession('workspace:free-canvas:project-1').proposals).toEqual([])
  })

  it('preserves the closed Gateway identity of Document edits without legacy Canvas fields', async () => {
    const edit = {
      kind: 'document_create' as const,
      id: 'edit-document-1', editId: 'edit-document-1', conversationId: 'conversation-1',
      requestId: 'request-1', nodeId: 'document-1', expectedResultDigest: `sha256:${'a'.repeat(64)}`,
      base: { projectRevision: 1 },
      payload: { title: 'Draft', blocks: [], linkedDocumentResourceIds: [] },
      rationale: 'Create a draft.'
    }
    serviceMock.sendMessage.mockResolvedValueOnce({
      threadId: 'thread-1', conversationId: 'conversation-1', requestId: 'request-1',
      text: 'Document edit generated.', proposals: [], canvasEdits: [edit]
    })

    const returned = await useAgentStore.getState().sendMessage('Create it', [], {
      sessionKey: 'workspace:free-canvas:project-1', mode: 'free-canvas-workspace'
    })

    expect(returned.canvasEdits).toEqual([edit])
    expect(returned.canvasEdits[0]).not.toHaveProperty('threadId')
    expect(returned.canvasEdits[0]).not.toHaveProperty('contextId')
  })

  it('does not attach the Prompt Library to ordinary Canvas completion requests', async () => {
    await useAgentStore.getState().sendMessage('补全目标', promptLibraryPresets(254), {
      sessionKey: 'workspace:free-canvas:project-1',
      mode: 'free-canvas-workspace',
      permissionScope: 'workspace-chatbot-agent',
      canvasNodeContext: {
        mode: 'complete', targetNodeId: 'text-1', referenceNodeIds: [], mentions: []
      }
    })

    expect(serviceMock.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ promptLibrary: [] }))
  })

  it('sends a bounded Prompt Library snapshot only in retrieval mode', async () => {
    await useAgentStore.getState().sendMessage('查找建筑风格 Prompt', promptLibraryPresets(254), {
      sessionKey: 'workspace:free-canvas:project-1',
      mode: 'free-canvas-workspace',
      permissionScope: 'workspace-chatbot-agent',
      canvasNodeContext: {
        mode: 'prompt-library', targetNodeId: null, referenceNodeIds: [], mentions: []
      }
    })

    const request = serviceMock.sendMessage.mock.calls[serviceMock.sendMessage.mock.calls.length - 1]?.[0]
    expect(request.promptLibrary).toHaveLength(200)
    expect(request.promptLibrary[0].meta.media[0].id).toBe('media-0')
  })

  it('keeps Agent panel and project chat sessions isolated', async () => {
    serviceMock.sendMessage
      .mockResolvedValueOnce({
        threadId: 'thread-diagnostics',
        text: 'diagnostics response',
        proposals: [],
        diagnostics: {}
      })
      .mockResolvedValueOnce({
        threadId: 'thread-project',
        text: 'project response',
        proposals: [workspaceProposal],
        diagnostics: {}
      })

    await useAgentStore.getState().sendMessage('runtime?', [], {
      sessionKey: 'diagnostics:agent-panel',
      permissionScope: 'workspace-chatbot-agent'
    })
    await useAgentStore.getState().sendMessage('project request', [], {
      sessionKey: 'workspace:card:project-1',
      mode: 'card-workspace',
      workspaceContext: {
        contextId: 'card:project-1:0',
        mode: 'card-workspace',
        projectId: 'project-1',
        projectTitle: 'Project',
        snapshot: {}
      }
    })

    const diagnostics = useAgentStore.getState().getAgentSession('diagnostics:agent-panel')
    const project = useAgentStore.getState().getAgentSession('workspace:card:project-1')
    expect(diagnostics.threadId).toBe('thread-diagnostics')
    expect(project.threadId).toBe('thread-project')
    expect(diagnostics.messages.map(message => message.content)).toEqual(['runtime?', 'diagnostics response'])
    expect(project.messages.map(message => message.content)).toEqual(['project request', 'project response'])
    expect(project.proposals).toHaveLength(1)
  })

  it('reuses only the thread id for the matching session key', async () => {
    await useAgentStore.getState().sendMessage('first', [], {
      sessionKey: 'workspace:card:project-1',
      permissionScope: 'workspace-chatbot-agent'
    })
    serviceMock.sendMessage.mockResolvedValueOnce({
      threadId: 'thread-1',
      text: 'second response',
      proposals: [],
      diagnostics: {}
    })

    await useAgentStore.getState().sendMessage('second', [], {
      sessionKey: 'workspace:card:project-1',
      permissionScope: 'workspace-chatbot-agent'
    })

    expect(serviceMock.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      sessionKey: 'workspace:card:project-1'
    }))
  })

  it('reuses an explicit request id after a lost response', async () => {
    serviceMock.sendMessage
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({
        threadId: 'conversation-1', conversationId: 'conversation-1', requestId: 'request-stable',
        text: 'saved response', proposals: [], canvasEdits: [], diagnostics: { idempotent: true }
      })
    const options = {
      sessionKey: 'workspace:free-canvas:project-1',
      conversationId: 'conversation-1',
      requestId: 'request-stable'
    }

    await useAgentStore.getState().sendMessage('continue', [], options)
    await useAgentStore.getState().sendMessage('continue', [], options)

    expect(serviceMock.sendMessage.mock.calls.slice(-2).map(call => call[0].requestId))
      .toEqual(['request-stable', 'request-stable'])
    const session = useAgentStore.getState().getAgentSession(options.sessionKey)
    expect(session.retryRequest).toBeUndefined()
    expect(session.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'continue'],
      ['assistant', 'saved response']
    ])
  })

  it('freezes empty document identity arrays on a failed original request', async () => {
    serviceMock.sendMessage.mockRejectedValueOnce(new Error('response lost'))

    await useAgentStore.getState().sendMessage('continue without documents', [], {
      sessionKey: 'workspace:free-canvas:project-1',
      conversationId: 'conversation-1',
      requestId: 'request-empty-documents'
    })

    expect(useAgentStore.getState().getAgentSession('workspace:free-canvas:project-1').retryRequest)
      .toMatchObject({
        requestId: 'request-empty-documents',
        documentResourceIds: [],
        explicitDocumentNodeIds: [],
        documentAttachments: []
      })
  })

  it('uses the failed turn document snapshot authoritatively for the same request id', async () => {
    serviceMock.sendMessage
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({
        threadId: 'thread-1', conversationId: 'conversation-1', requestId: 'request-documents',
        text: 'saved response', proposals: [], canvasEdits: [], diagnostics: { idempotent: true }
      })
    const originalAttachment = {
      resourceId: DOCUMENT_RESOURCE_A,
      name: 'original.md',
      contentType: 'text/markdown' as const,
      size: 7,
      sha256: 'a'.repeat(64)
    }
    const replacementAttachment = {
      resourceId: DOCUMENT_RESOURCE_B,
      name: 'replacement.md',
      contentType: 'text/markdown' as const,
      size: 8,
      sha256: 'b'.repeat(64)
    }
    const baseOptions = {
      sessionKey: 'workspace:free-canvas:project-1',
      conversationId: 'conversation-1',
      requestId: 'request-documents'
    }

    await useAgentStore.getState().sendMessage('continue with documents', [], {
      ...baseOptions,
      documentResourceIds: [DOCUMENT_RESOURCE_A],
      explicitDocumentNodeIds: ['document-node-original'],
      documentAttachments: [originalAttachment]
    })
    await useAgentStore.getState().sendMessage('continue with documents', [], {
      ...baseOptions,
      documentResourceIds: [DOCUMENT_RESOURCE_B],
      explicitDocumentNodeIds: ['document-node-replacement'],
      documentAttachments: [replacementAttachment]
    })

    expect(serviceMock.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      documentResourceIds: [DOCUMENT_RESOURCE_A],
      explicitDocumentNodeIds: ['document-node-original']
    }))
    expect(useAgentStore.getState().getAgentSession(baseOptions.sessionKey).retryRequest).toBeUndefined()
  })

  it('clears a failed conversation retry when another conversation is hydrated', async () => {
    serviceMock.sendMessage.mockRejectedValueOnce(new Error('response lost'))
    const sessionKey = 'workspace:free-canvas:project-1'

    await useAgentStore.getState().sendMessage('continue A', [], {
      sessionKey,
      conversationId: 'conversation-a',
      requestId: 'request-a'
    })

    const failed = useAgentStore.getState().getAgentSession(sessionKey)
    expect(failed.retryRequest).toEqual(expect.objectContaining({
      requestId: 'request-a', content: 'continue A', conversationId: 'conversation-a'
    }))
    expect(failed.runtimeError).toBe('response lost')

    useAgentStore.getState().hydrateSession(sessionKey, {
      conversationId: 'conversation-b',
      threadId: 'conversation-b',
      messages: [],
      proposals: []
    })

    const switched = useAgentStore.getState().getAgentSession(sessionKey)
    expect(switched.conversationId).toBe('conversation-b')
    expect(switched.retryRequest).toBeUndefined()
    expect(switched.runtimeError).toBeUndefined()
    expect(useAgentStore.getState().runtimeError).toBeUndefined()
    expect(switched.messages).toEqual([])
    expect(serviceMock.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('clears and updates proposals only inside the target session', async () => {
    await useAgentStore.getState().sendMessage('project', [], {
      sessionKey: 'workspace:card:project-1',
      permissionScope: 'workspace-chatbot-agent'
    })
    await useAgentStore.getState().sendMessage('other', [], {
      sessionKey: 'workspace:card:project-2',
      permissionScope: 'workspace-chatbot-agent'
    })

    useAgentStore.getState().markProposalStatus('proposal-card', 'approved', 'workspace:card:project-1')
    expect(useAgentStore.getState().getAgentSession('workspace:card:project-1').proposals[0].status).toBe('approved')
    expect(useAgentStore.getState().getAgentSession('workspace:card:project-2').proposals[0].status).toBe('pending')

    useAgentStore.getState().clearMessages('workspace:card:project-1')
    expect(useAgentStore.getState().getAgentSession('workspace:card:project-1').messages).toEqual([])
    expect(useAgentStore.getState().getAgentSession('workspace:card:project-2').messages.length).toBeGreaterThan(0)
  })

  it('loads, saves, and tests DeepSeek model config', async () => {
    await useAgentStore.getState().loadModelConfig()
    expect(useAgentStore.getState().modelConfig?.modelName).toBe('deepseek-chat')

    await useAgentStore.getState().saveModelConfig({ temperature: 0.2, maxTokens: 3000 })
    expect(serviceMock.saveModelConfig).toHaveBeenCalledWith({ temperature: 0.2, maxTokens: 3000 })
    expect(useAgentStore.getState().modelConfig?.apiKeyConfigured).toBe(true)

    await useAgentStore.getState().testModelConfig()
    expect(useAgentStore.getState().modelConfigTestResult).toEqual({ success: true, message: 'ok' })
  })
})

function promptLibraryPresets(count: number): IPreset[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `preset-${index}`,
    type: 'style',
    category: 'style',
    label: `Preset ${index}`,
    content: `Prompt ${index}`,
    usageCount: 0,
    meta: { media: [{ id: `media-${index}` }] }
  }))
}
