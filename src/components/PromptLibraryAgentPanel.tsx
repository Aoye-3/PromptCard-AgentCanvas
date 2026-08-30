import { useEffect, useMemo, useState } from 'react'
import { Bot, Check, Loader2, Send, Sparkles, X } from 'lucide-react'
import { useAgentStore } from '@/stores/agent.store'
import { usePresetStore } from '@/stores/preset.store'
import type { AgentWorkspaceProposal, PromptLibraryWriteProposal } from '@/models/Agent.model'
import {
  approvePromptLibraryProposalBatch,
  isAdditivePromptLibraryProposal,
  rejectPromptLibraryProposalBatch
} from '@/utils/prompt-library-agent-proposals'

const PROMPT_LIBRARY_SESSION_KEY = 'prompt-library:global'

export function PromptLibraryAgentPanel() {
  const { runtimeStatus, runtimeError, getAgentSession, checkRuntime, sendMessage, markProposalStatus } = useAgentStore()
  const session = getAgentSession(PROMPT_LIBRARY_SESSION_KEY)
  const running = session.running
  const proposals = session.proposals
  const visibleRuntimeError = session.runtimeError || runtimeError
  const { presets, initialized, init, addPreset } = usePresetStore()
  const [draft, setDraft] = useState('请根据这个需求生成一组可入库提示词：')
  const [selectedProposalIds, setSelectedProposalIds] = useState<string[]>([])

  useEffect(() => {
    if (!initialized) init()
    checkRuntime()
  }, [checkRuntime, init, initialized])

  const promptLibraryProposals = useMemo(
    () => proposals.filter(isPromptLibraryProposal),
    [proposals]
  )
  const pendingCreateProposals = useMemo(
    () => promptLibraryProposals.filter(isAdditivePromptLibraryProposal),
    [promptLibraryProposals]
  )
  const selectedPendingCount = selectedProposalIds.filter(id =>
    pendingCreateProposals.some(proposal => proposal.id === id)
  ).length
  const latestCitations = [...session.messages].reverse().find(message => message.citations?.length)?.citations || []
  const latestRetrieval = [...session.messages].reverse().find(message => message.promptRetrieval)?.promptRetrieval

  const handleSend = async () => {
    if (!draft.trim() || running) return
    await sendMessage(
      `请把用户输入拆解成多个可复用 Prompt 库条目。只生成 create 类型的 prompt_library_write_proposal，不要更新、归档、删除或覆盖已有条目。\n\n用户输入：${draft.trim()}`,
      presets,
      {
        sessionKey: PROMPT_LIBRARY_SESSION_KEY,
        permissionScope: 'prompt-library-agent'
      }
    )
    setDraft('')
  }

  const toggleProposal = (proposalId: string) => {
    setSelectedProposalIds(ids =>
      ids.includes(proposalId) ? ids.filter(id => id !== proposalId) : [...ids, proposalId]
    )
  }

  const approveSelected = async (ids = selectedProposalIds) => {
    await approvePromptLibraryProposalBatch(promptLibraryProposals, ids, {
      addPreset,
      markProposalStatus: (id: string, status: 'approved' | 'rejected') => markProposalStatus(id, status, PROMPT_LIBRARY_SESSION_KEY)
    })
    setSelectedProposalIds(current => current.filter(id => !ids.includes(id)))
  }

  const rejectSelected = (ids = selectedProposalIds) => {
    rejectPromptLibraryProposalBatch(promptLibraryProposals, ids, {
      markProposalStatus: (id: string, status: 'approved' | 'rejected') => markProposalStatus(id, status, PROMPT_LIBRARY_SESSION_KEY)
    })
    setSelectedProposalIds(current => current.filter(id => !ids.includes(id)))
  }

  const selectAllPending = () => {
    setSelectedProposalIds(pendingCreateProposals.map(proposal => proposal.id))
  }

  return (
    <aside className="h-full min-h-0 overflow-hidden rounded-[24px] border border-gray-100 bg-white shadow-[0_18px_45px_rgba(15,23,42,0.06)]">
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-gray-100 bg-gradient-to-br from-white to-violet-50 px-6 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-black text-gray-950">PMAgent 助手</h2>
                  <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-black text-emerald-700">AI</span>
                </div>
                <p className="mt-1 text-sm font-semibold text-gray-500">我可以帮你拆解长提示词，并生成多个可入库提案</p>
              </div>
            </div>
            <button
              type="button"
              className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-black text-gray-700 hover:bg-gray-50"
              onClick={() => {
                setDraft('')
                setSelectedProposalIds([])
              }}
            >
              清空对话
            </button>
          </div>
          {visibleRuntimeError && (
            <div className="mt-4 rounded-2xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              {visibleRuntimeError}
            </div>
          )}
        </div>

        <div data-testid="prompt-library-agent-proposals-scroll" className="min-h-0 flex-1 overflow-y-auto bg-white px-5 py-4">
          <div className="mb-4 rounded-2xl bg-violet-50 px-4 py-3 text-sm leading-6 text-gray-700">
            Agent 只能生成新增入库提案。所有提案都需要你同意后才会写入 Prompt 库。
          </div>

          {latestCitations.length > 0 && (
            <div data-testid="prompt-library-retrieval-citations" className="mb-4 rounded-2xl border border-violet-100 bg-white px-4 py-3">
              <div className="text-xs font-black text-violet-700">本轮检索证据</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {latestCitations.map(citation => (
                  <span key={`${citation.referenceCode}:${citation.revision}`} title={citation.digest} className="rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-bold text-violet-700">
                    {citation.referenceCode} · r{citation.revision} · {citation.title}
                  </span>
                ))}
              </div>
            </div>
          )}

          {latestRetrieval?.degraded && (
            <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800">
              Prompt 检索当前不可用，本轮没有向 Agent 注入库内容；你仍可继续使用其他功能。
            </div>
          )}

          <div className="mb-4 rounded-2xl border border-violet-100 bg-violet-50/70 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-3 text-sm font-bold text-gray-700">
                <input
                  type="checkbox"
                  checked={pendingCreateProposals.length > 0 && selectedPendingCount === pendingCreateProposals.length}
                  onChange={event => event.target.checked ? selectAllPending() : setSelectedProposalIds([])}
                  className="h-4 w-4 accent-violet-600"
                />
                已选择 {selectedPendingCount} 项
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={selectedPendingCount === 0}
                  onClick={() => approveSelected()}
                  className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-xs font-black text-white disabled:bg-gray-200 disabled:text-gray-400"
                >
                  <Check className="h-3.5 w-3.5" />
                  批量同意入库
                </button>
                <button
                  type="button"
                  disabled={selectedPendingCount === 0}
                  onClick={() => rejectSelected()}
                  className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-white px-4 py-2 text-xs font-black text-violet-700 disabled:border-gray-100 disabled:text-gray-400"
                >
                  <X className="h-3.5 w-3.5" />
                  批量否决
                </button>
                <button type="button" onClick={() => setSelectedProposalIds([])} className="rounded-xl px-3 py-2 text-xs font-black text-gray-500 hover:bg-white">
                  清空选择
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {promptLibraryProposals.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-200 p-6 text-sm font-semibold text-gray-400">
                暂无可审批提案。输入一段长提示词后，Agent 会拆解成多个新增条目。
              </div>
            ) : (
              promptLibraryProposals.map((proposal, index) => {
                const pendingCreate = isAdditivePromptLibraryProposal(proposal)
                const checked = selectedProposalIds.includes(proposal.id)
                return (
                  <div key={proposal.id} className={`rounded-2xl border p-4 ${pendingCreate ? 'border-gray-100 bg-white' : 'border-gray-100 bg-gray-50 opacity-70'}`}>
                    <div className="grid grid-cols-[24px_34px_minmax(0,1fr)_auto] items-start gap-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!pendingCreate}
                        onChange={() => toggleProposal(proposal.id)}
                        className="mt-1 h-4 w-4 accent-violet-600 disabled:opacity-30"
                      />
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 text-xs font-black text-gray-500">
                        {index + 1}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-black text-gray-950">{proposal.presetDraft.label}</div>
                        <div className="mt-2 grid gap-2 text-xs leading-5 text-gray-500">
                          <div><span className="font-bold text-gray-700">分类</span>：{proposal.presetDraft.type}</div>
                          <div><span className="font-bold text-gray-700">内容</span>：{proposal.presetDraft.content}</div>
                        </div>
                        {proposal.rationale && <p className="mt-2 text-xs leading-5 text-amber-700">{proposal.rationale}</p>}
                      </div>
                      <span className="rounded-full bg-gray-100 px-2 py-1 text-[11px] font-black text-gray-500">{proposal.status}</span>
                    </div>
                    {pendingCreate && (
                      <div className="mt-4 flex justify-end gap-2">
                        <button type="button" onClick={() => approveSelected([proposal.id])} className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-black text-violet-700">
                          <Check className="h-3.5 w-3.5" />
                          同意
                        </button>
                        <button type="button" onClick={() => rejectSelected([proposal.id])} className="inline-flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs font-black text-red-600">
                          <X className="h-3.5 w-3.5" />
                          否决
                        </button>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-gray-100 bg-white p-5">
          <textarea
            className="min-h-[96px] w-full resize-none rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm leading-relaxed text-gray-900 outline-none focus:border-violet-300 focus:bg-white focus:ring-2 focus:ring-violet-100"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="输入一段长提示词，或者粘贴你想拆解的完整需求..."
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-gray-500">
              <Sparkles className="h-4 w-4 text-violet-500" />
              Enter 发送
            </div>
            <button
              type="button"
              className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-lg shadow-violet-200 disabled:bg-gray-200 disabled:shadow-none"
              onClick={handleSend}
              disabled={runtimeStatus !== 'connected' || running || !draft.trim()}
              title="发送"
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

function isPromptLibraryProposal(proposal: AgentWorkspaceProposal): proposal is PromptLibraryWriteProposal {
  return proposal.kind === 'prompt_library_write_proposal' || Boolean((proposal as PromptLibraryWriteProposal).presetDraft)
}
