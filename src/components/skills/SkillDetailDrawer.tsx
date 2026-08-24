import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Archive, GitCompare, RefreshCw, RotateCcw, ShieldCheck, X } from 'lucide-react'
import {
  StorageHttpError,
  storageServiceClient,
  type SkillDetail,
  type SkillHost,
  type SkillHostPin,
  type SkillRevision,
  type SkillSummary
} from '@/storage/storage-service-client'
import { diffSkillRevisions } from './skill-revision-diff'

interface SkillDetailDrawerProps {
  skill: SkillSummary
  onClose: () => void
  onChanged: (detail: SkillDetail) => void
}

interface HostDraft {
  enabled: boolean
  revision: number
}

export function SkillDetailDrawer({ skill, onClose, onChanged }: SkillDetailDrawerProps) {
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [localPin, setLocalPin] = useState<SkillHostPin | null>(null)
  const [codexPin, setCodexPin] = useState<SkillHostPin | null>(null)
  const [localDraft, setLocalDraft] = useState<HostDraft>({ enabled: false, revision: skill.revision })
  const [codexDraft, setCodexDraft] = useState<HostDraft>({ enabled: false, revision: skill.revision })
  const [codexScopes, setCodexScopes] = useState<string[]>(['local-repository'])
  const [repositoryScope, setRepositoryScope] = useState('local-repository')
  const [publicationName, setPublicationName] = useState(skill.slug)
  const [compareRevision, setCompareRevision] = useState<number | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const scopeRequest = useRef(0)

  useEffect(() => {
    let active = true
    const load = async () => {
      setError('')
      try {
        const [loaded, hosts] = await Promise.all([
          storageServiceClient.skills.get(skill.referenceCode),
          storageServiceClient.skills.describeHosts()
        ])
        if (!active) return
        const scopes = hosts.find(host => host.id === 'codex')?.scopes || []
        const scope = scopes[0] || 'local-repository'
        const [local, codex] = await Promise.all([
          optionalPin(skill.referenceCode, 'local-agent'),
          optionalPin(skill.referenceCode, 'codex', scope)
        ])
        if (!active) return
        setDetail(loaded)
        setCodexScopes(scopes.length ? scopes : [scope])
        setRepositoryScope(scope)
        setLocalPin(local)
        setCodexPin(codex)
        setLocalDraft({ enabled: local?.enabled || false, revision: local?.revision || loaded.currentRevision })
        setCodexDraft({ enabled: codex?.enabled || false, revision: codex?.revision || loaded.currentRevision })
        setPublicationName(String(codex?.projection?.publicationName || loaded.slug))
        setCompareRevision(loaded.revisions[1]?.revision || null)
      } catch (reason) {
        if (active) setError(errorMessage(reason))
      }
    }
    void load()
    return () => { active = false }
  }, [skill.referenceCode, skill.revision, skill.slug])

  const currentRevision = detail?.revisions.find(revision => revision.revision === detail.currentRevision) || null
  const compared = detail?.revisions.find(revision => revision.revision === compareRevision) || null
  const changes = useMemo(() => currentRevision && compared ? diffSkillRevisions(currentRevision, compared) : [], [compared, currentRevision])

  const changeLifecycle = async (action: 'archive' | 'restore') => {
    if (!detail) return
    setBusy(action)
    setError('')
    try {
      const updated = await storageServiceClient.skills[action](detail.referenceCode)
      setDetail(updated)
      onChanged(updated)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy('')
    }
  }

  const review = async (revision: SkillRevision) => {
    if (!detail) return
    setBusy('review')
    setError('')
    try {
      const updated = await storageServiceClient.skills.reviewRevision(
        detail.referenceCode, revision.revision, revision.digest, 'trusted'
      )
      setDetail(updated)
      onChanged(updated)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy('')
    }
  }

  const applyHost = async (host: SkillHost) => {
    if (!detail) return
    const draft = host === 'codex' ? codexDraft : localDraft
    setBusy(host)
    setError('')
    try {
      const updated = await storageServiceClient.skills.updateHostPin(
        detail.referenceCode,
        host,
        host === 'codex'
          ? { ...draft, repositoryScope, publicationName }
          : draft
      )
      if (host === 'codex') setCodexPin(updated)
      else setLocalPin(updated)
    } catch (reason) {
      setError(errorCode(reason))
    } finally {
      setBusy('')
    }
  }

  const changeRepositoryScope = async (scope: string) => {
    if (!detail || scope === repositoryScope) return
    const request = ++scopeRequest.current
    setBusy('scope')
    setError('')
    try {
      const pin = await optionalPin(detail.referenceCode, 'codex', scope)
      if (request !== scopeRequest.current) return
      setRepositoryScope(scope)
      setCodexPin(pin)
      setCodexDraft({ enabled: pin?.enabled || false, revision: pin?.revision || detail.currentRevision })
      setPublicationName(String(pin?.projection?.publicationName || detail.slug))
    } catch (reason) {
      if (request === scopeRequest.current) setError(errorMessage(reason))
    } finally {
      if (request === scopeRequest.current) setBusy('')
    }
  }

  const repairCodex = async () => {
    if (!detail || !codexPin) return
    setBusy('repair')
    setError('')
    try {
      const repaired = await storageServiceClient.skills.repairCodexProjection(detail.referenceCode, {
        repositoryScope,
        expectedRevision: codexPin.revision,
        expectedDigest: codexPin.digest
      })
      setCodexPin(repaired)
    } catch (reason) {
      setError(errorCode(reason))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-gray-950/25" role="dialog" aria-modal="true" aria-label={`${skill.name} 详情`} onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <aside className="h-full w-full max-w-2xl overflow-y-auto bg-white shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-gray-100 bg-white px-6 py-5">
          <div>
            <h2 className="text-2xl font-black text-gray-950">{skill.name}</h2>
            <p className="mt-1 text-xs font-medium text-gray-500">{skill.referenceCode}</p>
          </div>
          <button type="button" aria-label="关闭 Skill 详情" onClick={onClose} className="rounded-full p-2 text-gray-500 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </header>

        <div className="space-y-7 p-6">
          {error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</div> : null}
          {!detail ? <div role="status" className="py-10 text-center text-sm text-gray-400">正在读取 canonical Skill…</div> : (
            <>
              <section>
                <p className="text-sm leading-6 text-gray-600">{detail.description}</p>
                <dl className="mt-4 grid gap-3 rounded-xl bg-gray-50 p-4 text-sm sm:grid-cols-2">
                  <Detail label="来源 / 当前信任" value={`${detail.source} · ${detail.trustState}`} />
                  <Detail label="生命周期" value={detail.lifecycleStatus} />
                  <Detail label="当前 revision" value={`${detail.currentRevision} · ${currentRevision?.digest || ''}`} />
                  <Detail label="工具依赖" value={detail.toolDependencies.join(', ') || '无'} />
                </dl>
                {detail.source === 'external' ? (
                  <div className="mt-4 flex items-center gap-3">
                    <button type="button" disabled={Boolean(busy)} onClick={() => changeLifecycle(detail.lifecycleStatus === 'active' ? 'archive' : 'restore')} className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-xs font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                      {detail.lifecycleStatus === 'active' ? <><Archive className="h-3.5 w-3.5" /> 归档 Skill</> : <><RotateCcw className="h-3.5 w-3.5" /> 恢复 Skill</>}
                    </button>
                    {detail.lifecycleStatus === 'archived' ? <span className="text-xs text-amber-700">先恢复，再调整 Host；归档不会静默移动 pin。</span> : null}
                  </div>
                ) : null}
              </section>

              <section>
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-sm font-black text-gray-950">Revision 历史</h3>
                  {detail.revisions.length > 1 ? (
                    <label className="flex items-center gap-2 text-xs font-bold text-gray-500"><GitCompare className="h-3.5 w-3.5" /> 对比
                      <select aria-label="对比 revision" value={compareRevision || ''} onChange={event => setCompareRevision(Number(event.target.value))} className="rounded border border-gray-200 px-2 py-1">
                        {detail.revisions.filter(revision => revision.revision !== detail.currentRevision).map(revision => <option key={revision.revision} value={revision.revision}>revision {revision.revision}</option>)}
                      </select>
                    </label>
                  ) : null}
                </div>
                <ol className="mt-3 space-y-2">{detail.revisions.map(revision => (
                  <li key={revision.revision} className="rounded-lg border border-gray-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-black text-gray-900">revision {revision.revision}</span>
                      <span className={`rounded px-2 py-1 text-[10px] font-black ${revision.trustReview?.state === 'trusted' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{revision.trustReview?.state || 'unreviewed'}</span>
                    </div>
                    <code className="mt-1 block break-all text-[11px] text-gray-400">{revision.digest}</code>
                    <p className="mt-2 text-xs text-gray-500">{new Date(revision.createdAt).toLocaleString()} · {String(revision.provenance.originLabel || revision.provenance.sourceKind || 'unknown')}</p>
                    {detail.source === 'external' && revision.trustReview?.state !== 'trusted' ? <button type="button" disabled={Boolean(busy) || detail.lifecycleStatus !== 'active'} onClick={() => review(revision)} className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40"><ShieldCheck className="h-3.5 w-3.5" /> 批准 revision {revision.revision}</button> : null}
                  </li>
                ))}</ol>
                {changes.length ? <div className="mt-4 rounded-lg border border-gray-200">
                  <div className="border-b border-gray-100 px-3 py-2 text-xs font-black text-gray-600">revision {detail.currentRevision} 相对 revision {compareRevision}</div>
                  <ul className="divide-y divide-gray-100">{changes.map(change => <li key={change.path} className="flex items-center justify-between gap-3 px-3 py-2 text-xs"><code className="break-all text-gray-700">{change.path}</code><span className={diffTone(change.status)}>{change.status}</span></li>)}</ul>
                </div> : null}
              </section>

              <section>
                <h3 className="text-sm font-black text-gray-950">Host 状态</h3>
                <p className="mt-1 text-xs text-gray-500">两张卡各自保存 revision 与启用状态；操作一侧不会移动另一侧。</p>
                <div className="mt-3 grid gap-4 lg:grid-cols-2">
                  <HostCard
                    title="本地 Agent"
                    pin={localPin}
                    draft={localDraft}
                    revisions={detail.revisions}
                    disabled={Boolean(busy) || (detail.lifecycleStatus !== 'active' && localDraft.enabled)}
                    busy={busy === 'local-agent'}
                    onDraft={setLocalDraft}
                    onApply={() => applyHost('local-agent')}
                  />
                  <HostCard
                    title="Codex .agents/skills 投影"
                    pin={codexPin}
                    draft={codexDraft}
                    revisions={detail.revisions}
                    disabled={Boolean(busy) || (detail.lifecycleStatus !== 'active' && codexDraft.enabled)}
                    busy={busy === 'codex'}
                    onDraft={setCodexDraft}
                    onApply={() => applyHost('codex')}
                  >
                    <label className="block text-xs font-bold text-gray-600">Repository scope
                      <select aria-label="Codex repository scope" value={repositoryScope} disabled={Boolean(busy)} onChange={event => void changeRepositoryScope(event.target.value)} className="mt-1 h-9 w-full rounded border border-gray-200 bg-gray-50 px-2 font-mono text-xs disabled:opacity-40">
                        {codexScopes.map(scope => <option key={scope} value={scope}>{scope}</option>)}
                      </select>
                    </label>
                    <label className="block text-xs font-bold text-gray-600">Publication name
                      <input aria-label="Codex publication name" value={publicationName} onChange={event => setPublicationName(event.target.value)} className="mt-1 h-9 w-full rounded border border-gray-200 px-2 text-xs" />
                    </label>
                    {codexPin?.projectionHealth?.state && codexPin.projectionHealth.state !== 'healthy' ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                        <span className="flex items-center gap-2 font-black"><AlertTriangle className="h-3.5 w-3.5" /> {codexPin.projectionHealth.code || codexPin.projectionHealth.state}</span>
                        <button type="button" disabled={Boolean(busy) || detail.lifecycleStatus !== 'active' || detail.trustState === 'untrusted'} onClick={repairCodex} className="mt-2 flex items-center gap-2 rounded bg-amber-500 px-2 py-1.5 font-black text-gray-950 disabled:opacity-40"><RefreshCw className="h-3.5 w-3.5" /> 修复 Codex 投影</button>
                      </div>
                    ) : null}
                  </HostCard>
                </div>
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

function HostCard({ title, pin, draft, revisions, disabled, busy, onDraft, onApply, children }: {
  title: string
  pin: SkillHostPin | null
  draft: HostDraft
  revisions: SkillRevision[]
  disabled: boolean
  busy: boolean
  onDraft: (draft: HostDraft) => void
  onApply: () => void
  children?: ReactNode
}) {
  return <article className="space-y-3 rounded-xl border border-gray-200 p-4">
    <div className="flex items-start justify-between gap-3"><h4 className="text-sm font-black text-gray-900">{title}</h4><span className={`rounded px-2 py-1 text-[10px] font-black ${pin?.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{pin?.enabled ? 'enabled' : 'disabled'}</span></div>
    <p className="break-all text-[11px] text-gray-400">{pin ? `pinned revision ${pin.revision} · ${pin.digest}` : '尚未配置 pin'}</p>
    <label className="flex items-center gap-2 text-xs font-bold text-gray-600"><input aria-label={`${title} enabled`} type="checkbox" checked={draft.enabled} onChange={event => onDraft({ ...draft, enabled: event.target.checked })} /> 启用</label>
    <label className="block text-xs font-bold text-gray-600">Revision
      <select aria-label={`${title} revision`} value={draft.revision} onChange={event => onDraft({ ...draft, revision: Number(event.target.value) })} className="mt-1 h-9 w-full rounded border border-gray-200 px-2 text-xs">
        {revisions.map(revision => <option key={revision.revision} value={revision.revision}>revision {revision.revision} · {revision.trustReview?.state || 'unreviewed'}</option>)}
      </select>
    </label>
    {children}
    <button type="button" aria-label={`应用${title} 设置`} disabled={disabled || busy} onClick={onApply} className="h-9 rounded-lg bg-gray-950 px-3 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">应用 {title} 设置</button>
  </article>
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</dt><dd className="mt-1 break-words font-semibold text-gray-800">{value}</dd></div>
}

async function optionalPin(id: string, host: SkillHost, repositoryScope?: string): Promise<SkillHostPin | null> {
  try {
    return await storageServiceClient.skills.getHostPin(id, host, repositoryScope)
  } catch (reason) {
    if (reason instanceof StorageHttpError && reason.status === 404) return null
    throw reason
  }
}

function diffTone(status: string): string {
  if (status === 'added') return 'font-black text-emerald-700'
  if (status === 'removed') return 'font-black text-red-700'
  if (status === 'modified') return 'font-black text-amber-700'
  return 'font-bold text-gray-400'
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function errorCode(reason: unknown): string {
  return reason instanceof StorageHttpError ? reason.code : errorMessage(reason)
}
