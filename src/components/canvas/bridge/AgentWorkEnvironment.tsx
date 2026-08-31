import {
  AlertCircle, Bot, Check, ChevronDown, ChevronUp, Copy,
  Link2, Loader2, RefreshCw, ShieldCheck, Unplug
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useClipboardCopyFeedback } from '@/components/prompt-media/useClipboardCopyFeedback'
import {
  buildExternalAgentTask,
  type AgentWorkEnvironmentSnapshot
} from '@/domain/bridge/agent-work-environment'
import { normalizeContextPackCode } from '@/domain/context-packs/context-pack'
import { agentRuntimeService } from '@/services/agent-runtime-service'
import {
  storageServiceClient,
  type BridgeDelivery,
  type ContextPackInspection
} from '@/storage/storage-service-client'
import { BridgeDeliveryInbox } from './BridgeDeliveryInbox'

type EnvironmentClient = Pick<typeof agentRuntimeService, 'bridgeEnvironment'>
type ContextClient = Pick<typeof storageServiceClient.contextPacks, 'inspect'>
type DeliveryClient = Pick<typeof storageServiceClient.bridgeDeliveries, 'list' | 'decide'>

interface AgentWorkEnvironmentProps {
  projectCode: string
  projectRevision: number
  cvcCode: string | null
  selectedObjectCodes: string[]
  onCvcChange: (cvcCode: string | null) => void
  onAccept: (delivery: BridgeDelivery) => Promise<string[]>
  environmentClient?: EnvironmentClient
  contextClient?: ContextClient
  deliveryClient?: DeliveryClient
}

export const AgentWorkEnvironment = ({
  projectCode,
  projectRevision,
  cvcCode,
  selectedObjectCodes,
  onCvcChange,
  onAccept,
  environmentClient = agentRuntimeService,
  contextClient = storageServiceClient.contextPacks,
  deliveryClient = storageServiceClient.bridgeDeliveries
}: AgentWorkEnvironmentProps) => {
  const requestGenerationRef = useRef(0)
  const [expanded, setExpanded] = useState(true)
  const [snapshot, setSnapshot] = useState<AgentWorkEnvironmentSnapshot | null>(null)
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [contextDraft, setContextDraft] = useState(cvcCode || '')
  const [contextBusy, setContextBusy] = useState(false)
  const [taskRequest, setTaskRequest] = useState('读取所选创作对象，基于现有上下文继续创作；先说明你的理解，再提交结构化提案。')
  const copyTarget = `external-agent-task:${projectCode}:${cvcCode || 'none'}`
  const { copyFailed, copyText, isCopied } = useClipboardCopyFeedback(copyTarget)

  useEffect(() => setContextDraft(cvcCode || ''), [cvcCode])

  const refresh = useCallback(async () => {
    const generation = ++requestGenerationRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await environmentClient.bridgeEnvironment({
        projectCode,
        cvcCode,
        profileId: selectedProfileId
      })
      if (requestGenerationRef.current !== generation) return
      setSnapshot(result)
      setSelectedProfileId(current => current || result.bridge.selectedProfileId)
    } catch {
      if (requestGenerationRef.current === generation) {
        setError('无法读取 Agent 工作环境，请确认本地 Gateway 已启动。')
      }
    } finally {
      if (requestGenerationRef.current === generation) setLoading(false)
    }
  }, [cvcCode, environmentClient, projectCode, selectedProfileId])

  useEffect(() => {
    void refresh()
    const interval = globalThis.setInterval(() => void refresh(), 5_000)
    return () => {
      requestGenerationRef.current += 1
      globalThis.clearInterval(interval)
    }
  }, [refresh])

  const activateContext = async () => {
    const code = normalizeContextPackCode(contextDraft)
    if (!code) {
      setError('请输入有效的 CVC。')
      return
    }
    setContextBusy(true)
    setError(null)
    try {
      const inspection = await contextClient.inspect(code)
      const contextError = inspectedContextError(inspection, projectCode)
      if (contextError) {
        setError(contextError)
        return
      }
      setContextDraft(inspection.cvcCode)
      onCvcChange(inspection.cvcCode)
    } catch {
      setError('无法验证此 CVC；当前工作环境未切换。')
    } finally {
      setContextBusy(false)
    }
  }

  const workspace = snapshot?.workspace.state === 'ready' ? snapshot.workspace : null
  const objectCodes = useMemo(() => new Set(workspace?.objectCodes || []), [workspace])
  const exactSelectedCodes = useMemo(() => (
    [...new Set(selectedObjectCodes.map(code => code.trim().toUpperCase()))]
      .filter(code => objectCodes.has(code))
  ), [selectedObjectCodes, objectCodes])
  const missingSelectionCount = selectedObjectCodes.length - exactSelectedCodes.length
  const selectedProfile = snapshot?.bridge.profiles.find(profile => profile.profileId === selectedProfileId)
    || snapshot?.bridge.profiles.find(profile => profile.profileId === snapshot.bridge.selectedProfileId)
    || null

  const copyTask = async () => {
    if (!workspace || exactSelectedCodes.length === 0) return
    try {
      await copyText(buildExternalAgentTask({
        projectCode: workspace.projectCode,
        cvcCode: workspace.cvcCode,
        objectCodes: exactSelectedCodes,
        request: taskRequest
      }), copyTarget)
    } catch {
      setError('无法构建外部 Agent 任务，请重新选择 CVC 中的对象。')
    }
  }

  return (
    <div className="border-b border-gray-200 bg-white" data-agent-work-environment>
      <section className="border-b border-gray-100 bg-slate-50/70 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
              selectedProfile?.connectionState === 'recently_active'
                ? 'bg-emerald-100 text-emerald-700'
                : snapshot?.bridge.configured
                  ? 'bg-sky-100 text-sky-700'
                  : 'bg-gray-200 text-gray-500'
            }`}>
              {snapshot?.bridge.configured ? <Bot className="h-4 w-4" /> : <Unplug className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
              <h3 className="text-xs font-black text-gray-950">Agent 工作环境</h3>
              <p className="truncate text-[10px] font-semibold text-gray-500">
                {environmentStatusLabel(snapshot, selectedProfile)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="刷新 Agent 工作环境"
              className="rounded-md p-1.5 text-gray-500 hover:bg-white disabled:opacity-50"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              aria-label={expanded ? '收起 Agent 工作环境' : '展开 Agent 工作环境'}
              className="rounded-md p-1.5 text-gray-500 hover:bg-white"
              onClick={() => setExpanded(value => !value)}
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {expanded && (
          <div className="mt-3 max-h-[42vh] space-y-3 overflow-y-auto pr-1">
            {error && <p role="alert" className="rounded-lg bg-rose-50 px-2.5 py-2 text-[11px] font-semibold text-rose-700">{error}</p>}

            <div className="grid grid-cols-2 gap-2">
              <EnvironmentMetric label="PRJ" value={projectCode} detail={`revision ${projectRevision}`} />
              <EnvironmentMetric
                label="CVC"
                value={cvcCode || '未选择'}
                detail={workspace ? `snapshot revision ${workspace.contextRevision}` : workspaceFailureLabel(snapshot)}
                danger={snapshot?.workspace.state === 'unavailable'}
              />
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-2.5">
              <label htmlFor="agent-work-environment-cvc" className="text-[10px] font-black uppercase tracking-wide text-gray-500">显式工作上下文</label>
              <div className="mt-1.5 flex gap-1.5">
                <input
                  id="agent-work-environment-cvc"
                  aria-label="Agent 工作环境 CVC"
                  value={contextDraft}
                  placeholder="CVC-…"
                  onChange={event => setContextDraft(event.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 font-mono text-[10px] uppercase outline-none focus:border-gray-900"
                />
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md bg-gray-950 px-2 py-1 text-[10px] font-bold text-white disabled:bg-gray-300"
                  disabled={contextBusy}
                  onClick={() => void activateContext()}
                >
                  {contextBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}
                  验证并切换
                </button>
                {cvcCode && (
                  <button type="button" className="rounded-md border border-gray-200 px-2 text-[10px] font-bold text-gray-600" onClick={() => onCvcChange(null)}>清除</button>
                )}
              </div>
              <p className="mt-1.5 text-[10px] leading-4 text-gray-500">切换前由 Storage 检查项目归属和撤销状态；本地偏好不会授予 Bridge 权限。</p>
            </div>

            {snapshot && (
              <div className="rounded-lg border border-gray-200 bg-white p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-black uppercase tracking-wide text-gray-500">受信 Profile 与权限</span>
                  <span className="text-[10px] font-semibold text-gray-400">v{snapshot.bridge.contractVersion}</span>
                </div>
                {snapshot.bridge.profiles.length > 0 ? (
                  <>
                    <select
                      aria-label="Agent Bridge Profile"
                      value={selectedProfileId || snapshot.bridge.selectedProfileId || ''}
                      onChange={event => setSelectedProfileId(event.target.value || null)}
                      className="mt-1.5 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs font-bold text-gray-800"
                    >
                      {snapshot.bridge.profiles.map(profile => (
                        <option key={profile.profileId} value={profile.profileId}>
                          {profile.clientInfo?.name || profile.profileId} · {profile.connectionState === 'recently_active' ? '近期已连接' : '已配置'}
                        </option>
                      ))}
                    </select>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(selectedProfile?.scopes || []).map(scope => <ScopeBadge key={scope} scope={scope} />)}
                    </div>
                    <p className="mt-1.5 text-[10px] text-gray-500">选择仅改变环境展示；外部 Agent 仍由自己的 Bearer profile 决定权限。</p>
                  </>
                ) : (
                  <p className="mt-1.5 text-[11px] font-semibold text-amber-700">未配置 Bridge profile。普通 Canvas 与本地 Agent 不受影响。</p>
                )}
              </div>
            )}

            {workspace && (
              <>
                <div className="rounded-lg border border-gray-200 bg-white p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-black uppercase tracking-wide text-gray-500">Bootstrap / Skill / Tool</span>
                    <span className="text-[10px] font-bold text-emerald-700"><ShieldCheck className="mr-1 inline h-3 w-3" />环境可读</span>
                  </div>
                  <p className="mt-1.5 break-all text-[10px] text-gray-600">
                    {snapshot!.bridge.bootstrapSkill.name}@{snapshot!.bridge.bootstrapSkill.revision}
                  </p>
                  <details className="mt-1.5 text-[10px] text-gray-600">
                    <summary className="cursor-pointer font-bold text-gray-700">查看内置上手说明</summary>
                    <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 font-sans leading-4">{snapshot!.bridge.bootstrapSkill.instructions}</pre>
                  </details>
                  <div className="mt-2 space-y-1">
                    {workspace.skills.length > 0 ? workspace.skills.map(skill => (
                      <div key={skill.skillCode} className="rounded-md bg-gray-50 px-2 py-1.5 text-[10px] text-gray-600">
                        <span className="font-bold text-gray-800">{skill.skillCode}@{skill.revision}</span>
                        <span className={`ml-1.5 font-bold ${skill.projectionHealth === 'healthy' ? 'text-emerald-700' : 'text-amber-700'}`}>{skill.projectionHealth}</span>
                        <span className="mt-0.5 block truncate font-mono text-gray-400" title={skill.digest}>{skill.digest}</span>
                      </div>
                    )) : <p className="text-[10px] text-gray-500">当前 profile 没有启用且可信的 Codex Skill pin。</p>}
                  </div>
                  <details className="mt-2 text-[10px] text-gray-600">
                    <summary className="cursor-pointer font-bold text-gray-700">{snapshot!.bridge.tools.length} 个 Tool · {snapshot!.bridge.writebackKinds.length} 类写回</summary>
                    <div className="mt-1.5 space-y-1">
                      {snapshot!.bridge.tools.map(tool => (
                        <p key={tool.name} className="rounded bg-gray-50 px-2 py-1"><code>{tool.name}</code> · {tool.mode}</p>
                      ))}
                    </div>
                  </details>
                </div>

                <div className="rounded-lg border border-gray-200 bg-white p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-black uppercase tracking-wide text-gray-500">精确对象任务</span>
                    <span className="text-[10px] font-bold text-gray-500">{exactSelectedCodes.length}/{selectedObjectCodes.length} 已授权</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {exactSelectedCodes.map(code => <code key={code} className="rounded bg-sky-50 px-1.5 py-1 text-[9px] font-bold text-sky-800">{code}</code>)}
                  </div>
                  {missingSelectionCount > 0 && (
                    <p className="mt-1.5 text-[10px] font-semibold text-amber-700"><AlertCircle className="mr-1 inline h-3 w-3" />{missingSelectionCount} 个所选对象不在当前 CVC，未加入任务。</p>
                  )}
                  <textarea
                    aria-label="外部 Agent 任务描述"
                    value={taskRequest}
                    onChange={event => setTaskRequest(event.target.value)}
                    className="mt-2 min-h-16 w-full resize-y rounded-md border border-gray-300 px-2 py-1.5 text-[11px] leading-4 outline-none focus:border-gray-900"
                  />
                  <button
                    type="button"
                    className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-gray-950 px-2 py-1.5 text-xs font-bold text-white disabled:bg-gray-300"
                    disabled={exactSelectedCodes.length === 0 || !taskRequest.trim()}
                    onClick={() => void copyTask()}
                  >
                    {isCopied(copyTarget) ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {isCopied(copyTarget) ? '已复制精确任务' : '复制给外部 Agent'}
                  </button>
                  {copyFailed(copyTarget) && <p role="alert" className="mt-1.5 text-[10px] font-semibold text-rose-700">复制失败，请检查剪贴板权限。</p>}
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <BridgeDeliveryInbox cvcCode={cvcCode} client={deliveryClient} onAccept={onAccept} />
    </div>
  )
}

const EnvironmentMetric = ({
  label, value, detail, danger = false
}: { label: string; value: string; detail: string; danger?: boolean }) => (
  <div className="min-w-0 rounded-lg border border-gray-200 bg-white p-2">
    <span className="text-[9px] font-black uppercase tracking-wide text-gray-400">{label}</span>
    <code className={`mt-0.5 block truncate text-[9px] font-bold ${danger ? 'text-rose-700' : 'text-gray-800'}`} title={value}>{value}</code>
    <span className="mt-0.5 block truncate text-[9px] text-gray-400">{detail}</span>
  </div>
)

const ScopeBadge = ({ scope }: { scope: string }) => (
  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-slate-600">{scope}</span>
)

const environmentStatusLabel = (
  snapshot: AgentWorkEnvironmentSnapshot | null,
  profile: AgentWorkEnvironmentSnapshot['bridge']['profiles'][number] | null
): string => {
  if (!snapshot) return '正在读取 Bridge、Skill 与 Tool…'
  if (!snapshot.bridge.configured) return 'Bridge 未配置 · 本地功能保持可用'
  if (profile?.connectionState === 'recently_active') return `${profile.clientInfo?.name || profile.profileId} 近期已连接`
  return `${profile?.clientInfo?.name || profile?.profileId || 'Bridge'} 已配置 · 等待 Agent 调用`
}

const workspaceFailureLabel = (snapshot: AgentWorkEnvironmentSnapshot | null): string => {
  if (!snapshot) return '正在检查'
  if (snapshot.workspace.state === 'ready') return `snapshot revision ${snapshot.workspace.contextRevision}`
  if (snapshot.workspace.errorCode === 'explicit_context_required') return '需要显式选择'
  if (snapshot.workspace.errorCode === 'context_revoked') return '已撤销'
  if (snapshot.workspace.errorCode === 'context_project_mismatch') return '项目不匹配'
  if (snapshot.workspace.errorCode === 'bridge_profile_unavailable') return 'profile 不可用'
  return snapshot.workspace.errorCode
}

const inspectedContextError = (
  inspection: ContextPackInspection,
  projectCode: string
): string | null => {
  if (inspection.projectCode !== projectCode) return '此 CVC 属于另一个项目，未切换。'
  if (inspection.revokedAt !== null) return '此 CVC 已撤销，未切换。'
  return null
}
