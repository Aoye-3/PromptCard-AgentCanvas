import { create } from 'zustand'
import { agentRuntimeService, type DeepSeekModelConfig, type DeepSeekModelConfigUpdate } from '@/services/agent-runtime-service'
import type {
  AgentAuthStatus,
  AgentCanvasEdit,
  AgentConversationSession,
  AgentInfo,
  AgentInteractionMode,
  AgentMessage,
  AgentPermissionScope,
  AgentModelInfo,
  AgentRuntimeStatus,
  AgentSessionKey,
  AgentSkillInfo,
  AgentToolInfo,
  AgentUser,
  AgentWorkspaceContext,
  AgentWorkspaceMode,
  AgentWorkspaceProposal,
  CanvasAgentNodeContext
} from '@/models/Agent.model'
import type { IPreset } from '@/models/Card.model'

interface AgentState {
  runtimeStatus: AgentRuntimeStatus
  authStatus: AgentAuthStatus
  runtimeError?: string
  user?: AgentUser
  models: AgentModelInfo[]
  skills: AgentSkillInfo[]
  tools: AgentToolInfo[]
  builtinTools: string[]
  subagentEnabled: boolean
  agents: AgentInfo[]
  sessionsByKey: Record<AgentSessionKey, AgentConversationSession>
  modelConfig?: DeepSeekModelConfig
  modelConfigSaving: boolean
  modelConfigTesting: boolean
  modelConfigTestResult?: { success: boolean; message: string }
  checkRuntime: () => Promise<void>
  bootstrapRuntime: () => Promise<void>
  loadModelConfig: () => Promise<void>
  saveModelConfig: (config: DeepSeekModelConfigUpdate) => Promise<void>
  testModelConfig: (config?: DeepSeekModelConfigUpdate) => Promise<void>
  sendMessage: (
    content: string,
    presets: IPreset[],
    options?: {
      workspaceContext?: AgentWorkspaceContext
      mode?: AgentWorkspaceMode
      permissionScope?: AgentPermissionScope
      sessionKey: AgentSessionKey
      conversationId?: string
      requestId?: string
      interactionMode?: AgentInteractionMode
      selectedSkillIds?: string[]
      canvasNodeContext?: CanvasAgentNodeContext
    }
  ) => Promise<{ proposals: AgentWorkspaceProposal[]; canvasEdits: AgentCanvasEdit[] }>
  getAgentSession: (sessionKey: AgentSessionKey) => AgentConversationSession
  hydrateSession: (sessionKey: AgentSessionKey, session: Partial<AgentConversationSession>) => void
  markProposalStatus: (id: string, status: 'approved' | 'rejected', sessionKey: AgentSessionKey) => void
  clearMessages: (sessionKey: AgentSessionKey) => void
}

const messageId = () => `agent-message-${Date.now()}-${Math.random().toString(16).slice(2)}`

const emptySession = (): AgentConversationSession => ({
  messages: [],
  proposals: [],
  running: false,
  updatedAt: 0
})

const getSessionFromState = (state: Pick<AgentState, 'sessionsByKey'>, sessionKey: AgentSessionKey) =>
  state.sessionsByKey[sessionKey] || emptySession()

const loadRuntimeCatalog = async () => {
  const catalog = await agentRuntimeService.catalog()

  return {
    models: catalog.models || [],
    skills: catalog.skills || [],
    tools: catalog.tools || [],
    builtinTools: catalog.builtins || [],
    subagentEnabled: Boolean(catalog.subagentEnabled),
    agents: catalog.agents || []
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  runtimeStatus: 'unknown',
  authStatus: 'unknown',
  models: [],
  skills: [],
  tools: [],
  builtinTools: [],
  subagentEnabled: false,
  agents: [],
  sessionsByKey: {},
  modelConfigSaving: false,
  modelConfigTesting: false,

  checkRuntime: async () => {
    set({ runtimeStatus: 'unknown', runtimeError: undefined })
    try {
      await agentRuntimeService.health()
      set({ runtimeStatus: 'connected' })
      await get().bootstrapRuntime()
    } catch (error) {
      set({
        runtimeStatus: 'disconnected',
        authStatus: 'unknown',
        runtimeError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  bootstrapRuntime: async () => {
    try {
      const bootstrap = await agentRuntimeService.bootstrap()
      const user = (bootstrap as { user?: AgentUser }).user as AgentUser
      const [catalog, modelConfig] = await Promise.all([
        loadRuntimeCatalog(),
        agentRuntimeService.getModelConfig()
      ])
      set({
        authStatus: 'authenticated',
        user,
        modelConfig,
        runtimeError: undefined,
        ...catalog
      })
    } catch (error) {
      set({
        authStatus: 'unauthenticated',
        user: undefined,
        runtimeError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  loadModelConfig: async () => {
    try {
      const modelConfig = await agentRuntimeService.getModelConfig()
      set({ modelConfig, runtimeError: undefined })
    } catch (error) {
      set({ runtimeError: error instanceof Error ? error.message : String(error) })
    }
  },

  saveModelConfig: async (config) => {
    set({ modelConfigSaving: true, runtimeError: undefined })
    try {
      const modelConfig = await agentRuntimeService.saveModelConfig(config)
      const catalog = await loadRuntimeCatalog()
      set({ modelConfigSaving: false, modelConfig, ...catalog })
    } catch (error) {
      set({
        modelConfigSaving: false,
        runtimeError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  testModelConfig: async (config = {}) => {
    set({ modelConfigTesting: true, modelConfigTestResult: undefined, runtimeError: undefined })
    try {
      const modelConfigTestResult = await agentRuntimeService.testModelConfig(config)
      set({ modelConfigTesting: false, modelConfigTestResult })
    } catch (error) {
      set({
        modelConfigTesting: false,
        modelConfigTestResult: {
          success: false,
          message: error instanceof Error ? error.message : String(error)
        }
      })
    }
  },

  sendMessage: async (content, presets, options) => {
    const sessionKey = options?.sessionKey
    if (!sessionKey) {
      throw new Error('Agent sessionKey is required')
    }
    const requestId = options?.requestId || messageId()
    const userMessage: AgentMessage = {
      id: messageId(),
      role: 'user',
      content,
      createdAt: Date.now()
    }
    set(state => ({
      sessionsByKey: updateSessions(state.sessionsByKey, sessionKey, session => ({
        ...session,
        running: true,
        runtimeError: undefined,
        messages: [...session.messages, userMessage],
        updatedAt: Date.now()
      })),
      runtimeError: undefined
    }))

    try {
      if (get().authStatus !== 'authenticated') {
        await get().bootstrapRuntime()
      }

      const result = await agentRuntimeService.sendMessage({
        threadId: getSessionFromState(get(), sessionKey).threadId,
        ...(options?.conversationId ? { conversationId: options.conversationId } : {}),
        requestId,
        content,
        mode: options?.mode,
        permissionScope: options?.permissionScope || (options?.workspaceContext ? 'workspace-chatbot-agent' : 'prompt-library-agent'),
        sessionKey,
        projectId: options?.workspaceContext?.projectId,
        ...(options?.interactionMode ? { interactionMode: options.interactionMode } : {}),
        workspaceContext: options?.workspaceContext,
        ...(options?.selectedSkillIds?.length ? { selectedSkillIds: options.selectedSkillIds } : {}),
        ...(options?.canvasNodeContext ? { canvasNodeContext: options.canvasNodeContext } : {}),
        promptLibrary: (
          options?.permissionScope === 'prompt-library-agent'
          || options?.canvasNodeContext?.mode === 'prompt-library'
            ? presets.slice(0, 200)
            : []
        ).map(preset => ({
          id: preset.id,
          type: preset.type,
          category: preset.category,
          label: preset.label,
          content: preset.content,
          meta: preset.meta
        }))
      })
      const proposals = result.proposals.map(proposal => ({
        ...proposal,
        threadId: proposal.threadId || result.threadId,
        contextId: proposal.contextId || options?.workspaceContext?.contextId
      }))
      const canvasEdits = (result.canvasEdits || []).map(edit => ({
        ...edit,
        threadId: edit.threadId || result.threadId,
        contextId: edit.contextId || options?.workspaceContext?.contextId
      }))

      set(state => ({
        sessionsByKey: updateSessions(state.sessionsByKey, sessionKey, session => ({
          ...session,
          running: false,
          runtimeError: undefined,
          retryRequest: undefined,
          threadId: result.threadId,
          conversationId: result.conversationId || options?.conversationId || session.conversationId,
          messages: [
            ...session.messages,
            {
              id: messageId(),
              role: 'assistant',
              content: result.text,
              createdAt: Date.now()
            }
          ],
          proposals: mergeProposals(session.proposals, proposals),
          updatedAt: Date.now()
        }))
      }))
      return { proposals, canvasEdits }
    } catch (error) {
      set(state => ({
        runtimeError: error instanceof Error ? error.message : String(error),
        sessionsByKey: updateSessions(state.sessionsByKey, sessionKey, session => ({
          ...session,
          running: false,
          runtimeError: error instanceof Error ? error.message : String(error),
          retryRequest: { requestId, content },
          messages: [
            ...session.messages,
            {
              id: messageId(),
              role: 'assistant',
              content: `Agent call failed: ${error instanceof Error ? error.message : String(error)}`,
              createdAt: Date.now()
            }
          ],
          updatedAt: Date.now()
        }))
      }))
      return { proposals: [], canvasEdits: [] }
    }
  },

  getAgentSession: (sessionKey) => getSessionFromState(get(), sessionKey),

  hydrateSession: (sessionKey, session) => {
    set(state => ({
      sessionsByKey: updateSessions(state.sessionsByKey, sessionKey, current => ({
        ...current,
        ...session,
        messages: session.messages || current.messages,
        proposals: session.proposals || current.proposals,
        running: false
      }))
    }))
  },

  markProposalStatus: (id, status, sessionKey) => {
    set(state => ({
      sessionsByKey: updateSessions(state.sessionsByKey, sessionKey, session => ({
        ...session,
        proposals: session.proposals.map(proposal =>
          proposal.id === id ? { ...proposal, status } : proposal
        ),
        updatedAt: Date.now()
      }))
    }))
  },

  clearMessages: (sessionKey) => {
    set(state => ({
      sessionsByKey: updateSessions(state.sessionsByKey, sessionKey, () => emptySession()),
      runtimeError: undefined
    }))
  }
}))

function updateSessions(
  sessionsByKey: Record<AgentSessionKey, AgentConversationSession>,
  sessionKey: AgentSessionKey,
  updater: (session: AgentConversationSession) => AgentConversationSession
) {
  const next = {
    ...sessionsByKey,
    [sessionKey]: updater(getSessionFromState({ sessionsByKey }, sessionKey))
  }
  return next
}

function mergeProposals(
  current: AgentWorkspaceProposal[],
  incoming: AgentWorkspaceProposal[]
) {
  const seen = new Set(current.map(proposal => proposal.id))
  return [
    ...current,
    ...incoming.filter(proposal => {
      if (seen.has(proposal.id)) return false
      seen.add(proposal.id)
      return true
    })
  ]
}
