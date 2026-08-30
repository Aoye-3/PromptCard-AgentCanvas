import { create } from 'zustand'
import { agentRuntimeService, type DeepSeekModelConfig, type DeepSeekModelConfigUpdate } from '@/services/agent-runtime-service'
import type {
  AgentAuthStatus,
  AgentCanvasEdit,
  AgentConversationSession,
  AgentDocumentAttachment,
  AgentInfo,
  AgentInteractionMode,
  AgentPlanningWriteContext,
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
      documentResourceIds?: string[]
      explicitDocumentNodeIds?: string[]
      documentAttachments?: AgentDocumentAttachment[]
      documentWriteContext?: AgentPlanningWriteContext
    }
  ) => Promise<{ proposals: AgentWorkspaceProposal[]; canvasEdits: AgentCanvasEdit[] }>
  getAgentSession: (sessionKey: AgentSessionKey) => AgentConversationSession
  hydrateSession: (sessionKey: AgentSessionKey, session: Partial<AgentConversationSession>) => void
  markProposalStatus: (id: string, status: 'approved' | 'rejected', sessionKey: AgentSessionKey) => void
  clearMessages: (sessionKey: AgentSessionKey) => void
}

const messageId = () => `agent-message-${Date.now()}-${Math.random().toString(16).slice(2)}`

type ScopedRetryRequest = NonNullable<AgentConversationSession['retryRequest']> & {
  conversationId: string
  userMessageId: string
  errorMessageId: string
}

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

  sendMessage: async (content, _presets, options) => {
    const sessionKey = options?.sessionKey
    if (!sessionKey) {
      throw new Error('Agent sessionKey is required')
    }
    const requestId = options?.requestId || messageId()
    const initialSession = getSessionFromState(get(), sessionKey)
    const conversationId = options?.conversationId || initialSession.conversationId || ''
    const pendingRetry = initialSession.retryRequest as ScopedRetryRequest | undefined
    const isRetry = Boolean(
      options?.requestId
      && pendingRetry?.requestId === requestId
      && pendingRetry.content === content
      && pendingRetry.conversationId === conversationId
      && initialSession.messages.some(message => message.id === pendingRetry.userMessageId)
    )
    const documentRequest = isRetry && pendingRetry
      ? {
          documentResourceIds: [...pendingRetry.documentResourceIds],
          explicitDocumentNodeIds: [...pendingRetry.explicitDocumentNodeIds],
          documentAttachments: pendingRetry.documentAttachments.map(attachment => ({ ...attachment }))
        }
      : {
          documentResourceIds: [...(options?.documentResourceIds ?? [])],
          explicitDocumentNodeIds: [...(options?.explicitDocumentNodeIds ?? [])],
          documentAttachments: (options?.documentAttachments ?? []).map(attachment => ({ ...attachment }))
        }
    const includesDocumentRequest = Boolean(
      isRetry
      || options?.documentResourceIds !== undefined
      || options?.explicitDocumentNodeIds !== undefined
      || options?.documentAttachments !== undefined
    )
    const userMessage: AgentMessage = {
      id: messageId(),
      role: 'user',
      content,
      createdAt: Date.now(),
      ...(documentRequest.documentAttachments.length ? {
        documentAttachments: documentRequest.documentAttachments.map(attachment => ({
          resourceId: attachment.resourceId,
          name: attachment.name,
          contentType: attachment.contentType,
          size: attachment.size,
          sha256: attachment.sha256
        }))
      } : {})
    }
    const errorMessageId = isRetry && pendingRetry ? pendingRetry.errorMessageId : messageId()
    set(state => ({
      sessionsByKey: updateSessions(state.sessionsByKey, sessionKey, session => ({
        ...session,
        running: true,
        runtimeError: undefined,
        messages: isRetry ? session.messages : [...session.messages, userMessage],
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
        ...(options?.documentWriteContext ? { documentWriteContext: options.documentWriteContext } : {}),
        ...(includesDocumentRequest ? {
          documentResourceIds: documentRequest.documentResourceIds,
          explicitDocumentNodeIds: documentRequest.explicitDocumentNodeIds
        } : {}),
        ...(
          options?.interactionMode !== 'chat-experimental'
          && (
            options?.permissionScope === 'prompt-library-agent'
            || options?.canvasNodeContext?.mode === 'prompt-library'
          )
            ? {
                promptRetrieval: {
                  query: content.trim().slice(0, 256),
                  types: [],
                  categories: [],
                  exactCodes: [],
                  limit: 10
                }
              }
            : {}
        )
      })
      const proposals = result.proposals.map(proposal => ({
        ...proposal,
        threadId: proposal.threadId || result.threadId,
        contextId: proposal.contextId || options?.workspaceContext?.contextId
      }))
      const canvasEdits = (result.canvasEdits || []).map(edit => (
        edit.kind === 'document_create' || edit.kind === 'document_changes' || edit.kind === 'storyboard_create' || edit.kind === 'storyboard_changes'
          ? edit
          : {
              ...edit,
              threadId: edit.threadId || result.threadId,
              contextId: edit.contextId || options?.workspaceContext?.contextId
            }
      ))
      const citations = promptCitations(result.diagnostics)
      const promptRetrieval = promptRetrievalState(result.diagnostics)

      set(state => ({
        sessionsByKey: updateSessions(state.sessionsByKey, sessionKey, session => ({
          ...session,
          running: false,
          runtimeError: undefined,
          retryRequest: undefined,
          threadId: result.threadId,
          conversationId: result.conversationId || options?.conversationId || session.conversationId,
          messages: [
            ...(
              isRetry && pendingRetry
                ? session.messages.filter(message => message.id !== pendingRetry.errorMessageId)
                : session.messages
            ),
            {
              id: messageId(),
              role: 'assistant',
              content: result.text,
              createdAt: Date.now(),
              ...(citations.length
                ? { citations }
                : {}),
              ...(promptRetrieval ? { promptRetrieval } : {})
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
          retryRequest: {
            requestId,
            content,
            conversationId,
            userMessageId: isRetry && pendingRetry ? pendingRetry.userMessageId : userMessage.id,
            errorMessageId,
            documentResourceIds: documentRequest.documentResourceIds,
            explicitDocumentNodeIds: documentRequest.explicitDocumentNodeIds,
            documentAttachments: documentRequest.documentAttachments
          } as ScopedRetryRequest,
          messages: [
            ...session.messages.filter(message => message.id !== errorMessageId),
            {
              id: errorMessageId,
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
        running: false,
        runtimeError: undefined,
        retryRequest: undefined
      })),
      runtimeError: undefined
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

function promptCitations(diagnostics: unknown): NonNullable<AgentMessage['citations']> {
  if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) return []
  const retrieval = (diagnostics as Record<string, unknown>).promptRetrieval
  if (!retrieval || typeof retrieval !== 'object' || Array.isArray(retrieval)) return []
  const citations = (retrieval as Record<string, unknown>).citations
  if (!Array.isArray(citations)) return []
  return citations.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const item = value as Record<string, unknown>
    if (
      typeof item.referenceCode !== 'string'
      || typeof item.title !== 'string'
      || !Number.isSafeInteger(item.revision)
      || typeof item.digest !== 'string'
    ) return []
    return [{
      referenceCode: item.referenceCode,
      title: item.title,
      revision: Number(item.revision),
      digest: item.digest
    }]
  })
}

function promptRetrievalState(diagnostics: unknown): AgentMessage['promptRetrieval'] {
  if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) return undefined
  const value = (diagnostics as Record<string, unknown>).promptRetrieval
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const retrieval = value as Record<string, unknown>
  if (
    typeof retrieval.degraded !== 'boolean'
    || !Number.isSafeInteger(retrieval.resultCount)
    || !Number.isSafeInteger(retrieval.staleRejectedCount)
  ) return undefined
  return {
    degraded: retrieval.degraded,
    resultCount: Number(retrieval.resultCount),
    staleRejectedCount: Number(retrieval.staleRejectedCount),
    ...(typeof retrieval.auditId === 'string' ? { auditId: retrieval.auditId } : {}),
    ...(typeof retrieval.errorCode === 'string' ? { errorCode: retrieval.errorCode } : {})
  }
}
