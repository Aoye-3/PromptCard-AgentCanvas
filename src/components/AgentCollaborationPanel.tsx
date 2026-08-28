import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, FileText, Loader2, MoreHorizontal, Puzzle, RefreshCw, Send, Wand2, X } from 'lucide-react'
import { useAgentStore } from '@/stores/agent.store'
import { usePresetStore } from '@/stores/preset.store'
import { agentRuntimeService } from '@/services/agent-runtime-service'
import type {
  AgentMessage,
  AgentCanvasEdit,
  AgentDocumentAttachment,
  AgentModelInfo,
  AgentInteractionMode,
  AgentWorkspaceContext,
  AgentWorkspaceMode,
  AgentWorkspaceProposal,
  CanvasAgentEditMode,
  CanvasAgentSelection
} from '@/models/Agent.model'
import { AgentConversationMenu } from '@/components/agent/AgentConversationMenu'
import { AgentMarkdownMessage } from '@/components/agent/AgentMarkdownMessage'
import { CanvasAgentComposer, type CanvasAgentModelOption, type CanvasAgentNodeSummary } from '@/components/agent/CanvasAgentComposer'
import { AgentDocumentAttachments } from '@/components/agent/AgentDocumentAttachments'
import {
  attachCanvasAgentNode,
  clearCanvasAgentTarget,
  removeCanvasAgentNode,
  type CanvasAgentAttachment
} from '@/components/agent/canvas-agent-composer-model'
import { storageServiceClient, type AgentConversationDetail } from '@/storage/storage-service-client'
import { previewFreeCanvasTextInsertions } from '@/domain/free-canvas/free-canvas-project'
import type { IFreeCanvasTextNode, IFreeCanvasTextSegment } from '@/models/PromptHistory.model'

interface AgentCollaborationPanelProps {
  title: string
  mode: AgentWorkspaceMode
  workspaceContext: AgentWorkspaceContext
  sessionKey?: string
  onApplyWorkspaceProposal: (proposal: AgentWorkspaceProposal) => Promise<boolean | void> | boolean | void
  onApplyCanvasEdit?: (edit: AgentCanvasEdit) => Promise<boolean | void> | boolean | void
  autoApplyWorkspaceChanges?: boolean
  compact?: boolean
  embedded?: boolean
  contextLabel?: string
  draftRequest?: {
    id: string
    content?: string
    canvasNode?: {
      nodeId: string
      role: CanvasAgentAttachment['role']
      mode?: CanvasAgentEditMode
      selection?: CanvasAgentSelection
    }
  }
}

const agentQuickPrompts = [
  {
    label: '补全选中卡片',
    prompt: '请读取当前选中的卡片和页面上下文，直接补全选中卡片的内容。'
  },
  {
    label: '改写当前页',
    prompt: '请把当前页所有提示词卡片改写得更具体、更适合视频生成，并直接更新相关卡片。'
  },
  {
    label: '新增卡片',
    prompt: '请根据当前页面缺失的信息，新增一张最有帮助的提示词卡片。'
  }
] as const

const POST_SEND_APPLY_ERROR = '消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。'
const useCommitLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function AgentCollaborationPanel({
  title,
  mode,
  workspaceContext,
  sessionKey: sessionKeyProp,
  onApplyWorkspaceProposal,
  onApplyCanvasEdit,
  autoApplyWorkspaceChanges = false,
  compact = false,
  embedded = false,
  contextLabel = '已读取工作区',
  draftRequest
}: AgentCollaborationPanelProps) {
  const sessionKey = sessionKeyProp || `workspace:${mode.replace('-workspace', '')}:${workspaceContext.projectId}`
  const {
    runtimeStatus,
    authStatus,
    runtimeError,
    getAgentSession,
    checkRuntime,
    sendMessage,
    markProposalStatus,
    hydrateSession,
    models = [],
    skills,
    tools
  } = useAgentStore()
  const session = getAgentSession(sessionKey)
  const messages = session.messages
  const running = session.running
  const pendingProposals = session.proposals.filter(proposal => proposal.status === 'pending')
  const visibleRuntimeError = session.runtimeError || runtimeError
  const { presets, initialized, init } = usePresetStore()
  const [draft, setDraft] = useState(embedded ? '' : '告诉 Agent 你想怎么修改当前选中的提示词卡片。')
  const [appliedMessages, setAppliedMessages] = useState<AgentMessage[]>([])
  const [conversationId, setConversationId] = useState<string>()
  const retryRequest = session.retryRequest as (
    (NonNullable<typeof session.retryRequest> & { conversationId: string }) | undefined
  )
  const currentRetryRequest = retryRequest?.conversationId === conversationId
    ? retryRequest
    : undefined
  const [skillMenuOpen, setSkillMenuOpen] = useState(false)
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([])
  const [interactionMode, setInteractionMode] = useState<AgentInteractionMode>('prompt-edit')
  const [boundSkillIds, setBoundSkillIds] = useState<string[]>([])
  const [conversationRevision, setConversationRevision] = useState(1)
  const [canvasAttachments, setCanvasAttachments] = useState<CanvasAgentAttachment[]>([])
  const [documentAttachments, setDocumentAttachments] = useState<AgentDocumentAttachment[]>([])
  const [documentUploadingCount, setDocumentUploadingCount] = useState(0)
  const [canvasEditMode, setCanvasEditMode] = useState<CanvasAgentEditMode>('complete')
  const [canvasSelection, setCanvasSelection] = useState<(CanvasAgentSelection & { nodeId: string }) | undefined>()
  const [composerResetKey, setComposerResetKey] = useState(0)
  const [composerDraft, setComposerDraft] = useState<{ id: string; content: string }>()
  const [selectedModelKey, setSelectedModelKey] = useState('')
  const [modelSelectionRequired, setModelSelectionRequired] = useState(false)
  const [modelSaving, setModelSaving] = useState(false)
  const [modelSwitchError, setModelSwitchError] = useState<string>()
  const [postSendApplyError, setPostSendApplyError] = useState<string>()
  const [documentEditReconciling, setDocumentEditReconciling] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const onApplyCanvasEditRef = useRef(onApplyCanvasEdit)
  onApplyCanvasEditRef.current = onApplyCanvasEdit
  const canvasIdentityRef = useRef(`${sessionKey}:${workspaceContext.projectId}`)
  const postSendApplyIdentity = `${sessionKey}:${workspaceContext.projectId}:${conversationId || 'new'}`
  const postSendApplyIdentityRef = useRef(postSendApplyIdentity)
  const postSendApplyAttemptRef = useRef(0)
  const lastDraftRequestIdRef = useRef<string>()
  const externalSkills = skills.filter(skill => skill.source === 'external' && skill.id)
  const canvasNodes = useMemo(() => readCanvasNodeSummaries(workspaceContext), [workspaceContext])
  const documentNodes = useMemo(() => readDocumentNodeSummaries(workspaceContext), [workspaceContext])
  const canvasTextPreviewNodes = useMemo(() => readCanvasTextPreviewNodes(workspaceContext), [workspaceContext])
  const modelOptions = useMemo(() => models.flatMap(model => {
    const option = canvasAgentModelOption(model)
    return option ? [option] : []
  }), [models])
  const defaultModel = useMemo(() => (
    models.find(model => model.isDefault && model.available !== false)
  ), [models])
  const effectiveModelKey = modelSelectionRequired
    ? selectedModelKey
    : selectedModelKey || (defaultModel ? canvasAgentModelOption(defaultModel)?.key || '' : '')
  const effectiveModel = models.find(model => canvasAgentModelOption(model)?.key === effectiveModelKey)
  const visiblePanelError = visibleRuntimeError || postSendApplyError || modelSwitchError

  useCommitLayoutEffect(() => {
    if (postSendApplyIdentityRef.current === postSendApplyIdentity) return
    postSendApplyIdentityRef.current = postSendApplyIdentity
    postSendApplyAttemptRef.current += 1
  }, [postSendApplyIdentity])

  useEffect(() => {
    if (!initialized) init()
    checkRuntime()
  }, [checkRuntime, init, initialized])

  useEffect(() => {
    if (modelSelectionRequired) return
    if (selectedModelKey && modelOptions.some(model => model.key === selectedModelKey)) return
    const next = defaultModel ? canvasAgentModelOption(defaultModel) : undefined
    setSelectedModelKey(next?.key || '')
  }, [defaultModel, modelOptions, modelSelectionRequired, selectedModelKey])

  useEffect(() => {
    if (!draftRequest || lastDraftRequestIdRef.current === draftRequest.id) return
    if (typeof draftRequest.content === 'string') {
      if (embedded) setComposerDraft({ id: draftRequest.id, content: draftRequest.content })
      else setDraft(draftRequest.content)
      lastDraftRequestIdRef.current = draftRequest.id
    }
    if (draftRequest.canvasNode && canvasNodes.some(node => node.id === draftRequest.canvasNode!.nodeId)) {
      const request = draftRequest.canvasNode
      setCanvasAttachments(current => attachCanvasAgentNode(current, request.nodeId, request.role))
      if (request.mode) setCanvasEditMode(request.mode)
      if (request.role === 'target') {
        setCanvasSelection(request.selection ? { ...request.selection, nodeId: request.nodeId } : undefined)
      }
      lastDraftRequestIdRef.current = draftRequest.id
    }
  }, [canvasNodes, draftRequest, embedded])

  useEffect(() => {
    const validIds = new Set(canvasNodes.map(node => node.id))
    setCanvasAttachments(current => current.filter(attachment => validIds.has(attachment.nodeId)))
    setCanvasSelection(current => current && validIds.has(current.nodeId) ? current : undefined)
  }, [canvasNodes])

  useEffect(() => {
    const identity = `${sessionKey}:${workspaceContext.projectId}`
    if (canvasIdentityRef.current === identity) return
    canvasIdentityRef.current = identity
    setCanvasAttachments([])
    setDocumentAttachments([])
    setDocumentUploadingCount(0)
    setPostSendApplyError(undefined)
    setCanvasSelection(undefined)
    setCanvasEditMode('complete')
    setComposerResetKey(key => key + 1)
  }, [sessionKey, workspaceContext.projectId])

  useEffect(() => {
    if (!conversationId || !onApplyCanvasEditRef.current) {
      setDocumentEditReconciling(false)
      return
    }
    let cancelled = false
    const identity = `${sessionKey}:${workspaceContext.projectId}:${conversationId}`
    void (async () => {
      try {
        const reconciliation = await agentRuntimeService.reconcileDocumentEdits(
          workspaceContext.projectId,
          conversationId
        )
        if (cancelled || postSendApplyIdentityRef.current !== identity) return
        if (reconciliation.status === 'pending_apply' && reconciliation.canvasEdits.length === 1) {
          setDocumentEditReconciling(true)
          const applied = await onApplyCanvasEditRef.current?.(reconciliation.canvasEdits[0])
          if (applied === false && !cancelled && postSendApplyIdentityRef.current === identity) {
            setPostSendApplyError(POST_SEND_APPLY_ERROR)
          }
        }
      } catch {
        if (!cancelled && postSendApplyIdentityRef.current === identity) {
          setPostSendApplyError(POST_SEND_APPLY_ERROR)
        }
      } finally {
        if (!cancelled && postSendApplyIdentityRef.current === identity) {
          setDocumentEditReconciling(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [conversationId, sessionKey, workspaceContext.projectId])

  const conversationMessages = useMemo(
    () => [...messages, ...appliedMessages].sort((a, b) => a.createdAt - b.createdAt),
    [appliedMessages, messages]
  )

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [conversationMessages.length, running])

  const handleSend = async (
    content = draft,
    mentions: Array<{ nodeId: string; label: string }> = [],
    requestId?: string,
    retryDocuments?: {
      documentResourceIds: string[]
      explicitDocumentNodeIds: string[]
      documentAttachments: AgentDocumentAttachment[]
    }
  ) => {
    if (!content.trim() || running || documentUploadingCount > 0 || documentEditReconciling) return
    const applyAttempt = postSendApplyAttemptRef.current + 1
    postSendApplyAttemptRef.current = applyAttempt
    let applyIdentity = postSendApplyIdentityRef.current
    setPostSendApplyError(undefined)
    const promptLibraryMode = canvasEditMode === 'prompt-library'
    const target = promptLibraryMode
      ? undefined
      : canvasAttachments.find(attachment => attachment.role === 'target')
    const canvasNodeContext = interactionMode === 'prompt-edit'
      && embedded
      && mode === 'free-canvas-workspace'
      ? {
          mode: canvasEditMode,
          targetNodeId: target?.nodeId || null,
          referenceNodeIds: canvasAttachments
            .filter(attachment => promptLibraryMode || attachment.role === 'reference')
            .map(attachment => attachment.nodeId),
          mentions,
        }
      : undefined
    const activeDocumentAttachments = retryDocuments
      ? retryDocuments.documentAttachments
      : documentAttachments
    const documentResourceIds = retryDocuments
      ? retryDocuments.documentResourceIds
      : activeDocumentAttachments.map(attachment => attachment.resourceId)
    const explicitDocumentNodeIds = retryDocuments
      ? retryDocuments.explicitDocumentNodeIds
      : explicitDocumentMentions(mentions, documentNodes)
    const returned = await sendMessage(content.trim(), presets, {
      workspaceContext,
      mode,
      permissionScope: 'workspace-chatbot-agent',
      sessionKey,
      conversationId,
      requestId,
      interactionMode,
      selectedSkillIds: interactionMode === 'prompt-edit' ? selectedSkillIds : undefined,
      canvasNodeContext,
      ...(interactionMode === 'chat-experimental' ? {
        documentResourceIds,
        explicitDocumentNodeIds,
        documentAttachments: activeDocumentAttachments
      } : {})
    })
    const succeeded = !getAgentSession(sessionKey).runtimeError
    if (!succeeded) return
    const updatedConversationId = getAgentSession(sessionKey).conversationId
    if (
      updatedConversationId
      && updatedConversationId !== conversationId
      && postSendApplyAttemptRef.current === applyAttempt
      && postSendApplyIdentityRef.current === applyIdentity
    ) {
      applyIdentity = `${sessionKey}:${workspaceContext.projectId}:${updatedConversationId}`
      postSendApplyIdentityRef.current = applyIdentity
      setConversationId(updatedConversationId)
    }
    if (interactionMode === 'prompt-edit') setSelectedSkillIds([])

    setDraft('')
    setCanvasAttachments([])
    setDocumentAttachments([])
    setCanvasSelection(undefined)
    setCanvasEditMode('complete')
    setComposerResetKey(key => key + 1)

    try {
      const appliedCanvasEdits: AgentCanvasEdit[] = []
      if (onApplyCanvasEdit) {
        for (const edit of returned.canvasEdits) {
          const applied = await onApplyCanvasEdit(edit)
          if (applied === false) continue
          appliedCanvasEdits.push(edit)
        }
      }
      if (appliedCanvasEdits.length > 0) {
        setAppliedMessages(current => [
          ...current,
          {
            id: `agent-canvas-applied-${Date.now()}`,
            role: 'system',
            content: summarizeAppliedCanvasEdits(appliedCanvasEdits),
            createdAt: Date.now()
          }
        ])
      }

      if (autoApplyWorkspaceChanges) {
        const workspaceProposals = returned.proposals.filter(isDirectWorkspaceProposal)
        for (const proposal of workspaceProposals) {
          const applied = await onApplyWorkspaceProposal(proposal)
          if (applied === false) continue
          await setProposalStatus(proposal.id, 'approved')
        }
        if (workspaceProposals.length > 0) {
          setAppliedMessages(current => [
            ...current,
            {
              id: `agent-applied-${Date.now()}`,
              role: 'system',
              content: summarizeAppliedChanges(workspaceProposals),
              createdAt: Date.now()
            }
          ])
        }
      }
    } catch {
      if (
        postSendApplyAttemptRef.current === applyAttempt
        && postSendApplyIdentityRef.current === applyIdentity
      ) {
        setPostSendApplyError(POST_SEND_APPLY_ERROR)
      }
    }
  }

  const setDraftText = (content: string) => {
    if (embedded) {
      setComposerDraft({ id: `composer-draft-${Date.now()}-${Math.random()}`, content })
      return
    }
    setDraft(content)
  }

  const setProposalStatus = async (proposalId: string, status: 'approved' | 'rejected') => {
    if (conversationId) {
      await storageServiceClient.agentConversations.updateProposal(
        conversationId,
        proposalId,
        workspaceContext.projectId,
        status
      )
    }
    markProposalStatus(proposalId, status, sessionKey)
  }

  return (
    <div aria-label={title} className="flex h-full min-h-0 flex-col bg-white">
      {embedded ? (
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#e5e7eb] px-3">
          <div className="flex min-w-0 items-center gap-2 text-[11px]">
            <Bot className="h-3.5 w-3.5 shrink-0 text-[#5e5d59]" aria-hidden="true" />
            <span className="truncate font-semibold text-[#4d4c48]">{contextLabel}</span>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${runtimeStatus === 'connected' ? 'bg-emerald-600' : 'bg-amber-500'}`} />
            <span className="shrink-0 text-[#87867f]">
              {runtimeStatus === 'connected' ? authStatusText(authStatus) : statusText(runtimeStatus)}
            </span>
          </div>
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#87867f] transition hover:bg-[#f3f4f6] hover:text-[#141413]"
            onClick={() => checkRuntime()}
            title="Reconnect runtime"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
      <div className={`shrink-0 border-b border-gray-100 ${compact ? 'p-3' : 'p-5'}`}>
        <div className={`${compact ? 'mb-2' : 'mb-3'} flex items-center justify-between gap-3`}>
          <div className="flex items-center gap-2">
            <div className={`flex items-center justify-center bg-black text-white ${compact ? 'h-8 w-8 rounded-xl' : 'h-9 w-9 rounded-2xl'}`}>
              <Bot className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
            </div>
            <div>
              <h2 className={`${compact ? 'text-sm' : 'text-base'} font-black text-gray-950`}>{title}</h2>
              <p className="text-xs font-semibold text-gray-400">
                {runtimeStatus === 'connected' ? authStatusText(authStatus) : statusText(runtimeStatus)}
              </p>
            </div>
          </div>
          <button
            type="button"
            className={`${compact ? 'p-1.5' : 'p-2'} rounded-full bg-gray-100 text-gray-700 transition hover:bg-gray-200`}
            onClick={() => checkRuntime()}
            title="Reconnect runtime"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        {visiblePanelError && (
          <RuntimeErrorNotice error={visiblePanelError} />
        )}
      </div>
      )}

      {embedded && visiblePanelError && (
        <div className="mx-3 mt-2 shrink-0"><RuntimeErrorNotice error={visiblePanelError} dense /></div>
      )}

      {embedded ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-[#e5e7eb] px-2.5 py-1.5">
          <AgentConversationMenu
            projectId={workspaceContext.projectId}
            mode={mode}
            activeConversationId={conversationId}
            onConversationChange={handleConversationChange}
          />
          <select
            aria-label="Agent 交互模式"
            value={interactionMode}
            disabled={!conversationId || running}
            onChange={event => void persistConversationInteraction(
              event.target.value as AgentInteractionMode,
              []
            )}
            className="h-7 rounded-md border border-[#e5e7eb] bg-white px-2 text-[10px] font-bold text-[#4d4c48] disabled:opacity-50"
          >
            <option value="prompt-edit">提示词编辑</option>
            <option value="chat-experimental">对话模式【测试中】</option>
          </select>
          {interactionMode === 'prompt-edit' ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-[9px] font-bold text-amber-800" title="此内置 Skill 由画布入口自动绑定">
              <Wand2 className="h-3 w-3" /> Canvas Prompt Editor
            </span>
          ) : null}
        </div>
      ) : null}

      <div aria-label="Agent 对话消息" className={`${embedded ? 'flex-1 space-y-2 p-3' : compact ? 'flex-[3_1_0%] space-y-2 p-3' : 'flex-1 space-y-3 p-5'} min-h-0 overflow-y-auto`}>
        {conversationMessages.length === 0 ? (
          embedded ? (
            <div className="rounded-[10px] border border-[#e5e7eb] bg-white p-3">
              <div className="flex items-start gap-2">
                <Wand2 className="mt-0.5 h-4 w-4 shrink-0 text-[#c96442]" aria-hidden="true" />
                <div>
                  <h3 className="text-[13px] font-bold text-[#141413]">可以直接修改当前画布</h3>
                  <p className="mt-0.5 text-[11px] leading-4 text-[#87867f]">选中节点后，让 Agent 补全、改写或新增内容。</p>
                </div>
              </div>
              <div className="mt-3 overflow-hidden rounded-lg border border-[#f3f4f6]">
                {agentQuickPrompts.map((item, index) => (
                  <button
                    key={item.label}
                    type="button"
                    className={`flex h-9 w-full items-center gap-2 px-3 text-left text-[11px] font-semibold text-[#4d4c48] transition hover:bg-[#f9fafb] ${
                      index > 0 ? 'border-t border-[#f3f4f6]' : ''
                    }`}
                    onClick={() => setDraftText(item.prompt)}
                  >
                    <Wand2 className="h-3 w-3 text-[#87867f]" aria-hidden="true" />
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className={`${compact ? 'rounded-xl px-3 py-2 text-xs leading-5' : 'rounded-2xl px-4 py-3 text-sm'} bg-gray-50 font-semibold text-gray-400`}>
              还没有 Agent 对话。选中左侧卡片后，可以直接让 Agent 补全、改写或新增卡片。
            </div>
          )
        ) : (
          conversationMessages.map(message => (
            <div
              key={message.id}
              data-agent-message-role={message.role}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`${compact ? 'rounded-xl px-3 py-2 text-[13px] leading-5' : 'rounded-2xl px-4 py-3 text-sm leading-6'} max-w-[88%] break-words ${
                message.role === 'user'
                  ? 'rounded-br-md bg-[#141413] text-white'
                  : message.role === 'system'
                    ? 'rounded-bl-md bg-emerald-50 text-emerald-800'
                    : 'rounded-bl-md bg-[#f3f4f6] text-[#353431]'
              }`}>
                <div className="mb-1 text-[10px] font-black uppercase opacity-55">
                  {message.role === 'user' ? '你' : message.role === 'system' ? '已应用' : 'Agent'}
                </div>
                {message.role === 'assistant' ? (
                  <AgentMarkdownMessage content={message.content} />
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-sans">{message.content}</pre>
                )}
                {message.documentAttachments?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1" aria-label="历史文档附件">
                    {message.documentAttachments.map(attachment => (
                      <span
                        key={attachment.resourceId}
                        className="inline-flex max-w-full items-center gap-1 rounded-md border border-current/20 px-1.5 py-1 text-[10px] font-semibold"
                      >
                        <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                        <span className="max-w-40 truncate">{attachment.name}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} aria-hidden="true" />
      </div>

      {pendingProposals.length > 0 && (
        <div className="shrink-0 space-y-2 border-t border-gray-100 p-3">
          {pendingProposals.slice(-3).map(proposal => (
            <div key={proposal.id} className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <div className="text-xs font-black text-amber-900">{proposalTitle(proposal)}</div>
              {proposal.kind === 'free_canvas_text_update' ? (
                <>
                  <div className="mt-1 text-[10px] font-bold text-emerald-700">模板保持不变 · {canvasProposalModeLabel(proposal.editMode)}</div>
                  <CanvasTextProposalPreview proposal={proposal} node={canvasNodes.find(node => node.id === proposal.nodeId)} />
                </>
              ) : proposal.kind === 'free_canvas_text_insertions' ? (
                <CanvasTextInsertionsProposalPreview
                  proposal={proposal}
                  node={canvasTextPreviewNodes.find(node => node.id === proposal.nodeId)}
                />
              ) : <p className="mt-1 line-clamp-3 text-xs leading-5 text-amber-800">{proposalSummary(proposal)}</p>}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full bg-gray-950 px-3 py-1.5 text-xs font-black text-white"
                  onClick={async () => {
                    const applied = await onApplyWorkspaceProposal(proposal)
                    if (applied === false) return
                    await setProposalStatus(proposal.id, 'approved')
                  }}
                >
                  <Check className="h-3.5 w-3.5" />
                  Apply
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-amber-300 px-3 py-1.5 text-xs font-black text-amber-900"
                  onClick={() => void setProposalStatus(proposal.id, 'rejected')}
                >
                  <X className="h-3.5 w-3.5" />
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {embedded ? (
        <div className="shrink-0 border-t border-[#e5e7eb] bg-white p-2.5">
          {currentRetryRequest ? (
            <button
              type="button"
              aria-label="使用原请求重试"
              className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-900"
              onClick={() => {
                if (currentRetryRequest.conversationId !== conversationId) return
                return handleSend(
                  currentRetryRequest.content,
                  currentRetryRequest.explicitDocumentNodeIds.map(nodeId => ({
                    nodeId,
                    label: documentNodes.find(node => node.id === nodeId)?.title || nodeId
                  })),
                  currentRetryRequest.requestId,
                  {
                    documentResourceIds: currentRetryRequest.documentResourceIds,
                    explicitDocumentNodeIds: currentRetryRequest.explicitDocumentNodeIds,
                    documentAttachments: currentRetryRequest.documentAttachments
                  }
                ).catch(() => undefined)
              }}
            >
              使用原请求重试
            </button>
          ) : null}
          <div className="relative mb-2 flex min-w-0 items-center gap-1.5">
            {agentQuickPrompts.slice(0, 2).map(item => (
              <QuickPrompt
                key={item.label}
                label={item.label}
                onClick={() => setDraftText(item.prompt)}
                dense
              />
            ))}
            <button
              type="button"
              aria-label={agentQuickPrompts[2].label}
              title={agentQuickPrompts[2].label}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[#e5e7eb] bg-white text-[#5e5d59] transition hover:bg-[#f9fafb] hover:text-[#141413]"
              onClick={() => setDraftText(agentQuickPrompts[2].prompt)}
            >
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Skill 选择"
              className={`ml-auto inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[10px] font-bold ${(interactionMode === 'chat-experimental' ? boundSkillIds : selectedSkillIds).length ? 'border-sky-200 bg-sky-50 text-sky-800' : 'border-[#e5e7eb] text-[#5e5d59]'}`}
              onClick={() => setSkillMenuOpen(value => !value)}
              aria-expanded={skillMenuOpen}
            >
              <Puzzle className="h-3 w-3" /> Skill{(interactionMode === 'chat-experimental' ? boundSkillIds : selectedSkillIds).length ? ` · ${(interactionMode === 'chat-experimental' ? boundSkillIds : selectedSkillIds).length}` : ''}
            </button>
            {skillMenuOpen ? (
              <div className="absolute bottom-9 right-0 z-30 w-64 rounded-lg border border-gray-200 bg-white p-2 shadow-xl">
                <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                  {interactionMode === 'chat-experimental' ? '本对话持续启用' : '仅作用于下一条消息'}
                </div>
                {externalSkills.length === 0 ? <div className="px-2 py-3 text-xs text-gray-400">暂无可主动触发的外置 Skill</div> : externalSkills.map(skill => {
                  const dependencies = skill.toolDependencies || []
                  const availableTools = new Set(
                    interactionMode === 'chat-experimental' ? [] : tools.map(tool => tool.name)
                  )
                  const unavailable = dependencies.some(name => !availableTools.has(name))
                  const activeSkillIds = interactionMode === 'chat-experimental'
                    ? boundSkillIds
                    : selectedSkillIds
                  const selected = activeSkillIds.includes(skill.id!)
                  return <label key={skill.id} className={`flex items-start gap-2 rounded-md px-2 py-2 text-xs ${unavailable ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:bg-gray-50'}`} title={unavailable ? `缺少工具：${dependencies.filter(name => !availableTools.has(name)).join(', ')}` : skill.description}>
                    <input
                      type="checkbox"
                      disabled={unavailable}
                      checked={selected}
                      onChange={() => {
                        const next = selected
                          ? activeSkillIds.filter(id => id !== skill.id)
                          : [...activeSkillIds, skill.id!]
                        if (interactionMode === 'chat-experimental') {
                          void persistConversationInteraction(interactionMode, next)
                        } else {
                          setSelectedSkillIds(next)
                        }
                      }}
                    />
                    <span><span className="block font-bold text-gray-800">{skill.name}</span><span className="mt-0.5 block text-[10px] text-gray-400">v{skill.revision || 1} · {skill.trustState || skill.source}</span></span>
                  </label>
                })}
              </div>
            ) : null}
          </div>
          {interactionMode === 'chat-experimental' ? (
            <AgentDocumentAttachments
              projectId={workspaceContext.projectId}
              attachments={documentAttachments}
              disabled={running}
              resetKey={`${sessionKey}:${conversationId || 'new'}:${composerResetKey}`}
              onChange={setDocumentAttachments}
              onUploadingChange={setDocumentUploadingCount}
            />
          ) : null}
          <CanvasAgentComposer
            nodes={canvasNodes}
            documentNodes={interactionMode === 'chat-experimental' ? documentNodes : []}
            attachments={canvasAttachments}
            editMode={canvasEditMode}
            selection={canvasSelection ? withoutNodeId(canvasSelection) : undefined}
            running={running}
            disabled={runtimeStatus !== 'connected' || running || documentEditReconciling || documentUploadingCount > 0 || modelSaving || !effectiveModel || effectiveModel.available === false || (interactionMode === 'chat-experimental' && !conversationId)}
            externalDraft={composerDraft}
            resetKey={composerResetKey}
            modelOptions={modelOptions}
            selectedModelKey={effectiveModelKey}
            modelSaving={modelSaving}
            onEditModeChange={nextMode => {
              setCanvasEditMode(nextMode)
              if (nextMode === 'prompt-library') {
                setCanvasAttachments(clearCanvasAgentTarget)
                setCanvasSelection(undefined)
              }
            }}
            onRemoveNode={nodeId => {
              setCanvasAttachments(current => removeCanvasAgentNode(current, nodeId))
              setCanvasSelection(current => current?.nodeId === nodeId ? undefined : current)
            }}
            onSetTarget={nodeId => {
              setCanvasAttachments(current => attachCanvasAgentNode(current, nodeId, 'target'))
              setCanvasSelection(undefined)
            }}
            onClearTarget={() => {
              setCanvasAttachments(clearCanvasAgentTarget)
              setCanvasSelection(undefined)
            }}
            onModelChange={modelKey => void persistConversationModel(modelKey)}
            onSubmit={handleSend}
          />
        </div>
      ) : (
      <div className={`${compact ? 'shrink-0 p-3' : 'p-5'} border-t border-gray-100`}>
        <div className={`${compact ? 'mb-2 gap-1.5' : 'mb-3 gap-2'} flex flex-wrap`}>
          {agentQuickPrompts.map(item => (
            <QuickPrompt key={item.label} label={item.label} onClick={() => setDraftText(item.prompt)} />
          ))}
        </div>
        <textarea
          className={`${compact ? 'min-h-[86px] rounded-xl text-[13px] leading-5' : 'min-h-[112px] rounded-2xl text-sm leading-relaxed'} w-full resize-none border border-gray-200 bg-gray-50 px-3 py-2 text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:bg-white focus:ring-2 focus:ring-gray-100`}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder="例如：把主体卡片改得更具体，加入年龄、服装、情绪和画面细节..."
        />
        <button
          type="button"
          className={`${compact ? 'mt-2 py-2 text-[13px]' : 'mt-3 py-2.5 text-sm'} inline-flex w-full items-center justify-center gap-2 rounded-full bg-black px-4 font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300`}
          onClick={() => handleSend()}
          disabled={runtimeStatus !== 'connected' || running || documentEditReconciling || !draft.trim()}
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          发送给 Agent
        </button>
      </div>
      )}

    </div>
  )

  function handleConversationChange(conversation: AgentConversationDetail) {
    const nextApplyIdentity = `${sessionKey}:${workspaceContext.projectId}:${conversation.id}`
    if (postSendApplyIdentityRef.current !== nextApplyIdentity) {
      postSendApplyIdentityRef.current = nextApplyIdentity
      postSendApplyAttemptRef.current += 1
    }
    setPostSendApplyError(undefined)
    setConversationId(conversation.id)
    setInteractionMode(conversation.interactionMode || 'prompt-edit')
    setBoundSkillIds(conversation.boundSkillIds || [])
    setConversationRevision(conversation.revision || 1)
    hydrateSession(sessionKey, {
      conversationId: conversation.id,
      threadId: conversation.id,
      interactionMode: conversation.interactionMode || 'prompt-edit',
      boundSkillIds: conversation.boundSkillIds || [],
      revision: conversation.revision || 1,
      messages: conversation.messages.map((message, index) => ({
        id: message.id || `stored-message-${index}`,
        role: message.role,
        content: message.text,
        createdAt: message.createdAt || conversation.createdAt + index,
        ...(message.documentAttachments?.length ? {
          documentAttachments: message.documentAttachments.map(attachment => ({
            resourceId: attachment.resourceId,
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
            ...(attachment.sha256 ? { sha256: attachment.sha256 } : {})
          }))
        } : {})
      })),
      proposals: conversation.proposals as unknown as AgentWorkspaceProposal[],
      updatedAt: conversation.updatedAt
    })
    setCanvasAttachments([])
    setDocumentAttachments([])
    setDocumentUploadingCount(0)
    setCanvasSelection(undefined)
    setCanvasEditMode('complete')
    setComposerResetKey(key => key + 1)
    const boundModel = conversation.modelBinding
      ? models.find(model => (
          model.connectionId === conversation.modelBinding?.connectionId
          && model.providerId === conversation.modelBinding?.providerId
          && model.modelId === conversation.modelBinding?.modelId
        ))
      : undefined
    if (conversation.modelBinding && !boundModel) {
      setSelectedModelKey('')
      setModelSelectionRequired(true)
      return
    }
    const nextModel = boundModel || defaultModel
    const nextOption = nextModel ? canvasAgentModelOption(nextModel) : undefined
    setSelectedModelKey(nextOption?.key || '')
    setModelSelectionRequired(false)
    if (!conversation.modelBinding && nextOption) {
      void persistConversationModel(nextOption.key, conversation.id)
    }
  }

  async function persistConversationInteraction(
    nextMode: AgentInteractionMode,
    nextBoundSkillIds: string[]
  ) {
    if (!conversationId) return
    setModelSwitchError(undefined)
    try {
      const updated = await storageServiceClient.agentConversations.updateInteraction(
        conversationId,
        workspaceContext.projectId,
        {
          interactionMode: nextMode,
          boundSkillIds: nextMode === 'chat-experimental' ? nextBoundSkillIds : [],
          expectedRevision: conversationRevision
        }
      )
      setInteractionMode(updated.interactionMode)
      setBoundSkillIds(updated.boundSkillIds)
      setConversationRevision(updated.revision)
      setSelectedSkillIds([])
      setDocumentAttachments([])
      setDocumentUploadingCount(0)
      hydrateSession(sessionKey, {
        interactionMode: updated.interactionMode,
        boundSkillIds: updated.boundSkillIds,
        revision: updated.revision
      })
      if (updated.interactionMode === 'chat-experimental') {
        setCanvasAttachments([])
        setCanvasSelection(undefined)
        setCanvasEditMode('complete')
        setComposerResetKey(key => key + 1)
      }
    } catch (error) {
      setModelSwitchError(error instanceof Error ? error.message : String(error))
    }
  }

  async function persistConversationModel(modelKey: string, targetConversationId = conversationId) {
    const model = models.find(candidate => canvasAgentModelOption(candidate)?.key === modelKey)
    if (!model?.connectionId || !model.providerId || !model.modelId || model.available === false) return
    setModelSwitchError(undefined)
    setModelSaving(true)
    try {
      if (targetConversationId) {
        await agentRuntimeService.updateConversationModel(workspaceContext.projectId, targetConversationId, {
          connectionId: model.connectionId,
          providerId: model.providerId,
          modelId: model.modelId
        })
      }
      setSelectedModelKey(modelKey)
      setModelSelectionRequired(false)
    } catch (error) {
      setModelSwitchError(error instanceof Error ? error.message : String(error))
    } finally {
      setModelSaving(false)
    }
  }
}

function canvasAgentModelOption(model: AgentModelInfo): CanvasAgentModelOption | null {
  if (!model.connectionId || !model.providerId || !model.modelId) return null
  return {
    key: model.key || `${model.connectionId}:${model.modelId}`,
    displayName: model.displayName || model.display_name || model.modelId,
    available: model.available !== false,
    unavailableReason: model.unavailableReason
  }
}

function readCanvasNodeSummaries(workspaceContext: AgentWorkspaceContext): CanvasAgentNodeSummary[] {
  const nodes = Array.isArray(workspaceContext.snapshot.nodes) ? workspaceContext.snapshot.nodes : []
  return nodes.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const node = value as Record<string, unknown>
    if ((node.kind !== 'text' && node.kind !== 'image') || typeof node.id !== 'string') return []
    return [{
      id: node.id,
      title: String(node.title || node.id),
      displayText: String(node.displayText || ''),
      userText: String(node.userText || '')
    }]
  })
}

function readDocumentNodeSummaries(workspaceContext: AgentWorkspaceContext): CanvasAgentNodeSummary[] {
  const nodes = Array.isArray(workspaceContext.snapshot.nodes) ? workspaceContext.snapshot.nodes : []
  return nodes.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const node = value as Record<string, unknown>
    if (node.kind !== 'document' || typeof node.id !== 'string') return []
    return [{
      id: node.id,
      kind: 'document' as const,
      title: String(node.title || node.id),
      displayText: '',
      userText: ''
    }]
  })
}

function explicitDocumentMentions(
  mentions: Array<{ nodeId: string; label: string }>,
  documentNodes: CanvasAgentNodeSummary[]
): string[] {
  const documentNodeIds = new Set(documentNodes.map(node => node.id))
  const seen = new Set<string>()
  const result: string[] = []
  for (const mention of mentions) {
    if (!documentNodeIds.has(mention.nodeId) || seen.has(mention.nodeId)) continue
    seen.add(mention.nodeId)
    result.push(mention.nodeId)
    if (result.length === 5) break
  }
  return result
}

function readCanvasTextPreviewNodes(workspaceContext: AgentWorkspaceContext): IFreeCanvasTextNode[] {
  const nodes = Array.isArray(workspaceContext.snapshot.nodes) ? workspaceContext.snapshot.nodes : []
  return nodes.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const node = value as Record<string, unknown>
    if (node.kind !== 'text' || typeof node.id !== 'string' || !Array.isArray(node.segments)) return []
    const segments: IFreeCanvasTextSegment[] = node.segments.flatMap(value => {
      if (!value || typeof value !== 'object') return []
      const segment = value as Record<string, unknown>
      if (typeof segment.id !== 'string' || typeof segment.text !== 'string') return []
      const source: IFreeCanvasTextSegment['source'] | null = segment.source === 'preset' ? 'preset' : segment.source === 'user' ? 'user' : null
      if (!source) return []
      return [{
        id: segment.id,
        source,
        text: segment.text,
        color: typeof segment.color === 'string' ? segment.color : source === 'preset' ? '#ef4423' : '#111827',
        createdAt: 0,
        updatedAt: 0
      }]
    })
    return [{
      id: node.id,
      kind: 'text' as const,
      title: String(node.title || node.id),
      position: { x: 0, y: 0 },
      width: 0,
      height: 0,
      fontSize: 'large' as const,
      segments,
      meta: {}
    }]
  })
}

function withoutNodeId(selection: CanvasAgentSelection & { nodeId: string }): CanvasAgentSelection {
  return {
    start: selection.start,
    end: selection.end,
    selectedText: selection.selectedText,
    baseContentDigest: selection.baseContentDigest
  }
}

function QuickPrompt({ label, onClick, dense = false }: { label: string; onClick: () => void; dense?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={dense
        ? 'inline-flex h-7 min-w-0 items-center gap-1 rounded-lg border border-[#e5e7eb] bg-white px-2 text-[10px] font-semibold text-[#5e5d59] transition hover:bg-[#f9fafb] hover:text-[#141413]'
        : 'inline-flex items-center gap-1 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-black text-amber-800 transition hover:bg-amber-100'}
    >
      <Wand2 className={dense ? 'h-3 w-3 shrink-0' : 'h-3.5 w-3.5'} />
      <span className="truncate">{label}</span>
    </button>
  )
}

function CanvasTextProposalPreview({
  proposal,
  node
}: {
  proposal: Extract<AgentWorkspaceProposal, { kind: 'free_canvas_text_update' }>
  node?: CanvasAgentNodeSummary
}) {
  const before = proposal.editMode === 'rewrite_selection'
    ? proposal.selection?.selectedText || ''
    : node?.userText || ''
  return (
    <div className="mt-2 grid gap-1 text-[10px] leading-4">
      {proposal.editMode !== 'append' ? <div className="rounded-md bg-white/70 px-2 py-1 text-amber-900"><span className="font-bold">修改前：</span>{before || '（空）'}</div> : null}
      <div className="rounded-md bg-white px-2 py-1 text-amber-950"><span className="font-bold">{proposal.editMode === 'append' ? '新增内容：' : '修改后：'}</span>{proposal.userText}</div>
    </div>
  )
}

function CanvasTextInsertionsProposalPreview({
  proposal,
  node
}: {
  proposal: Extract<AgentWorkspaceProposal, { kind: 'free_canvas_text_insertions' }>
  node?: IFreeCanvasTextNode
}) {
  if (!node) return <p className="mt-1 text-xs leading-5 text-amber-800">目标文字节点已不存在，无法预览。</p>
  const preview = previewFreeCanvasTextInsertions(node, proposal.insertions)
  if (!preview.segments) {
    return <p className="mt-1 text-xs leading-5 text-amber-800">插入锚点无效：{preview.rejectionReason}</p>
  }
  return (
    <div className="mt-2 space-y-2" data-canvas-text-insertions-preview>
      <div className="rounded-md border border-amber-200 bg-white px-2 py-1.5 text-xs leading-5" aria-label="完整插入预览">
        {preview.segments.map(segment => (
          <span key={segment.id} style={{ color: segment.color }}>{segment.text}</span>
        ))}
      </div>
      <ul className="space-y-1 text-[10px] leading-4 text-amber-800">
        {proposal.insertions.map((insertion, index) => (
          <li key={`${insertion.anchor.type}-${index}`}>
            {insertion.anchor.position === 'before' ? '前插' : '后插'} · {insertion.reason}
          </li>
        ))}
      </ul>
    </div>
  )
}

function canvasProposalModeLabel(mode: Extract<AgentWorkspaceProposal, { kind: 'free_canvas_text_update' }>['editMode']) {
  if (mode === 'append') return '仅追加用户内容'
  if (mode === 'rewrite_selection') return '仅改写选区'
  return '改写整个用户部分'
}

function isDirectWorkspaceProposal(proposal: AgentWorkspaceProposal) {
  return proposal.kind === 'workspace_card_create' || proposal.kind === 'workspace_card_update'
}

function proposalTitle(proposal: AgentWorkspaceProposal) {
  if (proposal.kind === 'free_canvas_text_update') return 'Update selected text node'
  if (proposal.kind === 'free_canvas_text_insertions') return 'Insert into selected text node'
  if (proposal.kind === 'free_canvas_text_create') return 'Create text node'
  if (proposal.kind === 'prompt_library_write_proposal') return 'Add Prompt Library preset'
  return 'Agent workspace proposal'
}

function proposalSummary(proposal: AgentWorkspaceProposal) {
  if (proposal.kind === 'free_canvas_text_update' || proposal.kind === 'free_canvas_text_create') {
    return proposal.userText
  }
  if (proposal.kind === 'free_canvas_text_insertions') return proposal.insertions.map(insertion => insertion.text).join('\n')
  if (proposal.kind === 'prompt_library_write_proposal') {
    return `${proposal.presetDraft.label}: ${proposal.presetDraft.content}`
  }
  return proposal.rationale
}

function summarizeAppliedChanges(proposals: AgentWorkspaceProposal[]) {
  const created = proposals.filter(proposal => proposal.kind === 'workspace_card_create').length
  const updated = proposals
    .filter((proposal): proposal is Extract<AgentWorkspaceProposal, { kind: 'workspace_card_update' }> => proposal.kind === 'workspace_card_update')
    .reduce((count, proposal) => count + proposal.updates.length, 0)

  const parts = []
  if (updated) parts.push(`已更新 ${updated} 张卡片`)
  if (created) parts.push(`已新增 ${created} 张卡片`)
  return parts.length ? parts.join('，') : 'Agent 已返回修改，但没有可应用的卡片变更。'
}

function summarizeAppliedCanvasEdits(edits: AgentCanvasEdit[]) {
  const completed = edits.filter(edit => edit.kind === 'free_canvas_text_insertions').length
  const rewritten = edits.filter(edit => edit.kind === 'free_canvas_text_create').length
  const parts = []
  if (completed) parts.push(`已补全 ${completed} 个文字节点`)
  if (rewritten) parts.push(`已生成 ${rewritten} 个改写节点`)
  return parts.join('；') || '画布修改已应用'
}

export const AIChatbotBox = AgentCollaborationPanel

function RuntimeErrorNotice({ error, dense = false }: { error: string; dense?: boolean }) {
  return (
    <div
      role="alert"
      className={`${dense ? 'rounded-lg px-2.5 py-2 text-[11px]' : 'rounded-xl px-3 py-2.5 text-xs'} border border-red-200 bg-red-50 font-semibold leading-5 text-red-700`}
    >
      {summarizeRuntimeError(error)}
    </div>
  )
}

function summarizeRuntimeError(error: string) {
  const promptLibraryLimit = error.match(/at most\s+(\d+)\s+items[\s\S]*?not\s+(\d+)/i)
  if (promptLibraryLimit) {
    return `Prompt Library 条目超过上限（${promptLibraryLimit[2]}/${promptLibraryLimit[1]}）`
  }
  const normalized = error.replace(/\s+/g, ' ').trim()
  return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized
}

function statusText(status: string) {
  if (status === 'connected') return 'Runtime connected'
  if (status === 'disconnected') return 'Runtime disconnected'
  return 'Checking runtime'
}

function authStatusText(status: string) {
  if (status === 'authenticated') return 'Runtime ready'
  if (status === 'setup-required') return 'Setup required'
  if (status === 'unauthenticated') return 'Auth pending'
  return 'Bootstrapping'
}
