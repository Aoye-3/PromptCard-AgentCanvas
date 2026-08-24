import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, BookOpen, CheckCircle2, ChevronRight, Filter, Import, Puzzle, Search, ShieldCheck, Wrench } from 'lucide-react'
import { storageServiceClient, type SkillDetail, type SkillSummary } from '@/storage/storage-service-client'
import { SkillDetailDrawer } from './SkillDetailDrawer'
import { SkillImportDialog } from './SkillImportDialog'

type SkillFilter = 'all' | 'builtin' | 'external'

export function SkillHubScreen({ initialSkills }: { initialSkills?: SkillSummary[] }) {
  const [skills, setSkills] = useState<SkillSummary[]>(initialSkills || [])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SkillFilter>('all')
  const [selected, setSelected] = useState<SkillSummary | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [loading, setLoading] = useState(!initialSkills)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setError('')
      const next = await storageServiceClient.skills.list()
      setSkills(next)
      setSelected(current => current ? next.find(skill => skill.id === current.id) || null : null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (initialSkills) return
    void refresh()
  }, [initialSkills, refresh])

  const visible = useMemo(() => skills.filter(skill => {
    const matchesFilter = filter === 'all' || skill.source === filter
    const normalized = query.trim().toLowerCase()
    const matchesQuery = !normalized || `${skill.name} ${skill.slug} ${skill.description}`.toLowerCase().includes(normalized)
    return matchesFilter && matchesQuery
  }), [filter, query, skills])

  const handleChanged = (detail: SkillDetail) => {
    setSkills(current => current.map(skill => skill.id === detail.id ? summaryFromDetail(detail) : skill))
    setSelected(summaryFromDetail(detail))
  }

  return (
    <section className="min-h-screen bg-[#fafaf8] px-6 py-8 lg:px-10" aria-labelledby="skillhub-title">
      <header className="mx-auto max-w-6xl">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-amber-600">
              <Puzzle className="h-4 w-4" /> Runtime capabilities
            </div>
            <h1 id="skillhub-title" className="text-4xl font-black tracking-tight text-gray-950">SkillHub</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
              管理 Agent 可读取的功能说明、引用与工具依赖。导入只做惰性检查，不执行脚本、hook 或安装器。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800 sm:flex">
              <ShieldCheck className="h-4 w-4" /> 受 Gateway 权限约束
            </div>
            <button type="button" onClick={() => setImportOpen(true)} className="flex h-10 items-center gap-2 rounded-lg bg-gray-950 px-4 text-sm font-bold text-white hover:bg-gray-800">
              <Import className="h-4 w-4" /> 导入 Skill
            </button>
          </div>
        </div>

        <div className="mt-7 flex flex-col gap-3 border-b border-gray-200 pb-5 sm:flex-row sm:items-center">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <span className="sr-only">搜索 Skill</span>
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、能力或说明" className="h-11 w-full rounded-lg border border-gray-200 bg-white pl-10 pr-3 text-sm outline-none focus:border-amber-300 focus:ring-4 focus:ring-amber-50" />
          </label>
          <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white p-1" aria-label="Skill 来源筛选">
            <Filter className="ml-2 h-4 w-4 text-gray-400" />
            {(['all', 'builtin', 'external'] as const).map(value => (
              <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-md px-3 py-2 text-xs font-bold ${filter === value ? 'bg-gray-950 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>
                {value === 'all' ? '全部' : value === 'builtin' ? '内置' : '外置'}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="mx-auto mt-5 max-w-6xl overflow-hidden rounded-lg border border-gray-200 bg-white">
        {loading ? <div className="p-10 text-center text-sm text-gray-400" role="status">正在读取 Skill…</div> : null}
        {error ? <div className="p-6 text-sm font-semibold text-red-700" role="alert">{error}</div> : null}
        {!loading && !error && visible.length === 0 ? <div className="p-10 text-center text-sm text-gray-400">没有匹配的 Skill</div> : null}
        <ul className="divide-y divide-gray-100">
          {visible.map(skill => (
            <li key={skill.id}>
              <button type="button" aria-label={skill.name} onClick={() => setSelected(skill)} className="grid w-full gap-3 px-5 py-4 text-left transition hover:bg-[#fafaf8] sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    {skill.source === 'builtin' ? <BookOpen className="h-4 w-4 text-amber-500" /> : <Puzzle className="h-4 w-4 text-sky-600" />}
                    <span className="font-bold text-gray-950">{skill.name}</span>
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-gray-500">v{skill.revision}</span>
                    {skill.lifecycleStatus === 'archived' ? <span className="flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700"><Archive className="h-3 w-3" /> 已归档</span> : null}
                  </span>
                  <span className="mt-1 block truncate text-xs text-gray-500">{skill.description}</span>
                </span>
                <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-500"><Wrench className="h-3.5 w-3.5" /> {skill.toolDependencies.join(', ') || '无需工具'}</span>
                <span className={`flex items-center justify-between gap-3 text-xs font-bold ${skill.trustState === 'untrusted' ? 'text-amber-700' : 'text-emerald-700'}`}><CheckCircle2 className="h-4 w-4" /> {skill.trustState}<ChevronRight className="h-4 w-4 text-gray-300" /></span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {selected ? <SkillDetailDrawer skill={selected} onClose={() => setSelected(null)} onChanged={handleChanged} /> : null}
      {importOpen ? <SkillImportDialog skills={skills} onClose={() => setImportOpen(false)} onImported={async () => {
        setImportOpen(false)
        await refresh()
      }} /> : null}
    </section>
  )
}

function summaryFromDetail(detail: SkillDetail): SkillSummary {
  const current = detail.revisions.find(revision => revision.revision === detail.currentRevision)
  return {
    id: detail.id,
    referenceCode: detail.referenceCode,
    slug: detail.slug,
    name: detail.name,
    description: detail.description,
    source: detail.source,
    trustState: detail.trustState,
    capabilityId: detail.capabilityId,
    toolDependencies: detail.toolDependencies,
    revision: detail.currentRevision,
    digest: current?.digest || '',
    lifecycleStatus: detail.lifecycleStatus
  }
}
