import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileArchive, FolderOpen, ShieldAlert, X } from 'lucide-react'
import {
  storageServiceClient,
  type SkillInspection,
  type SkillSummary
} from '@/storage/storage-service-client'

interface SkillImportDialogProps {
  skills: SkillSummary[]
  onClose: () => void
  onImported: () => void | Promise<void>
}

export function SkillImportDialog({ skills, onClose, onImported }: SkillImportDialogProps) {
  const [source, setSource] = useState<'folder' | 'archive'>('folder')
  const [folderPath, setFolderPath] = useState('')
  const [archive, setArchive] = useState<File | null>(null)
  const [operation, setOperation] = useState<'create' | 'revise'>('create')
  const [targetSkillId, setTargetSkillId] = useState('')
  const [inspection, setInspection] = useState<SkillInspection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const revisable = useMemo(() => skills.filter(skill => skill.source === 'external' && skill.lifecycleStatus === 'active'), [skills])

  const inspect = async () => {
    setBusy(true)
    setError('')
    setInspection(null)
    try {
      const result = source === 'folder'
        ? await storageServiceClient.skills.inspectFolder(folderPath.trim())
        : archive
          ? await storageServiceClient.skills.inspectArchive(archive.name, await fileToBase64(archive))
          : null
      if (!result) throw new Error('请选择 Skill 归档文件')
      setInspection(result)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!inspection?.clean) return
    setBusy(true)
    setError('')
    try {
      const originLabel = source === 'folder' ? folderPath.trim() : archive?.name || 'archive'
      const skill = operation === 'create'
        ? { originLabel }
        : { originLabel, skillId: targetSkillId }
      await storageServiceClient.skills.importInspected({ inspectionId: inspection.inspectionId, operation, skill })
      await onImported()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-gray-950/35 p-4" role="dialog" aria-modal="true" aria-label="导入 Skill">
      <section className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-gray-100 bg-white px-6 py-5">
          <div>
            <h2 className="text-xl font-black text-gray-950">导入 Skill</h2>
            <p className="mt-1 text-xs text-gray-500">先冻结并检查包快照，确认后才写入 canonical revision。</p>
          </div>
          <button type="button" aria-label="关闭导入 Skill" onClick={onClose} className="rounded-full p-2 text-gray-500 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </header>

        <div className="space-y-6 p-6">
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-1">
            <button type="button" onClick={() => { setSource('folder'); setInspection(null) }} className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-bold ${source === 'folder' ? 'bg-white text-gray-950 shadow-sm' : 'text-gray-500'}`}><FolderOpen className="h-4 w-4" /> 本地文件夹</button>
            <button type="button" onClick={() => { setSource('archive'); setInspection(null) }} className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-bold ${source === 'archive' ? 'bg-white text-gray-950 shadow-sm' : 'text-gray-500'}`}><FileArchive className="h-4 w-4" /> ZIP/TAR 归档</button>
          </div>

          {source === 'folder' ? (
            <label className="block text-sm font-bold text-gray-700">
              Skill 文件夹路径
              <input aria-label="Skill 文件夹路径" value={folderPath} onChange={event => { setFolderPath(event.target.value); setInspection(null) }} placeholder="F:\\projects\\my-skill" className="mt-2 h-11 w-full rounded-lg border border-gray-200 px-3 font-mono text-sm outline-none focus:border-amber-300" />
              <span className="mt-1 block text-xs font-normal text-gray-400">首版使用显式路径；Storage 会拒绝链接、reparse 与检查后变更。</span>
            </label>
          ) : (
            <label className="block text-sm font-bold text-gray-700">
              Skill 归档
              <input aria-label="Skill 归档文件" type="file" accept=".zip,.tar,.gz,.tgz" onChange={event => { setArchive(event.target.files?.[0] || null); setInspection(null) }} className="mt-2 block w-full rounded-lg border border-gray-200 p-2 text-sm" />
            </label>
          )}

          <button type="button" disabled={busy || (source === 'folder' ? !folderPath.trim() : !archive)} onClick={inspect} className="h-10 rounded-lg border border-gray-300 px-4 text-sm font-bold text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? '正在检查…' : '仅检查，不导入'}
          </button>

          {error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</div> : null}
          {inspection ? <InspectionReview inspection={inspection} /> : null}

          {inspection ? (
            <div className="space-y-4 border-t border-gray-100 pt-5">
              <div className="flex gap-2">
                {(['create', 'revise'] as const).map(value => (
                  <button key={value} type="button" onClick={() => setOperation(value)} className={`rounded-lg px-3 py-2 text-xs font-bold ${operation === value ? 'bg-gray-950 text-white' : 'border border-gray-200 text-gray-600'}`}>{value === 'create' ? '创建新 Skill' : '追加 revision'}</button>
                ))}
              </div>
              {operation === 'revise' ? (
                <label className="block text-sm font-bold text-gray-700">目标 Skill
                  <select aria-label="目标 Skill" value={targetSkillId} onChange={event => setTargetSkillId(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-gray-200 px-3 text-sm">
                    <option value="">选择 active external Skill</option>
                    {revisable.map(skill => <option key={skill.id} value={skill.referenceCode}>{skill.name} · v{skill.revision}</option>)}
                  </select>
                </label>
              ) : null}
              <div className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">
                导入后的 external revision 默认为未审核；不会移动 Codex 或本地 Agent 的现有 pin。
              </div>
              <button type="button" disabled={busy || !inspection.clean || (operation === 'revise' && !targetSkillId)} onClick={commit} className="h-11 rounded-lg bg-amber-500 px-5 text-sm font-black text-gray-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40">
                确认导入
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function InspectionReview({ inspection }: { inspection: SkillInspection }) {
  return (
    <section aria-label="Skill 检查结果" className={`rounded-xl border p-4 ${inspection.clean ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-200 bg-amber-50/50'}`}>
      <div className="flex items-start gap-3">
        {inspection.clean ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" /> : <ShieldAlert className="mt-0.5 h-5 w-5 text-amber-600" />}
        <div>
          <h3 className="text-sm font-black text-gray-900">{inspection.clean ? '检查通过，可以导入' : '存在阻断项，不能导入'}</h3>
          <p className="mt-1 text-xs text-gray-500">{inspection.manifest.entryCount} 个条目 · {inspection.manifest.totalBytes} bytes · {inspection.manifest.digest}</p>
        </div>
      </div>
      {inspection.findings.length ? <ul className="mt-4 space-y-2">{inspection.findings.map((finding, index) => (
        <li key={`${finding.code}-${finding.path}-${index}`} className="rounded-lg border border-amber-200 bg-white p-3 text-xs">
          <span className="flex items-center gap-2 font-black text-amber-800"><AlertTriangle className="h-3.5 w-3.5" /> {finding.code}</span>
          <span className="mt-1 block text-gray-600">{finding.message}</span>
          {finding.path ? <code className="mt-1 block break-all text-gray-500">{finding.path}{finding.line ? `:${finding.line}` : ''}</code> : null}
        </li>
      ))}</ul> : null}
      <div className="mt-4">
        <h4 className="text-xs font-black uppercase tracking-wide text-gray-500">惰性包预览</h4>
        <p className="mt-1 text-xs text-gray-500">只显示冻结快照的元数据，不加载或执行条目内容。</p>
        <ul className="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">{inspection.manifest.entries.map(entry => (
          <li key={entry.path} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-xs"><code className="break-all text-gray-700">{entry.path}</code><span className="text-gray-400">{entry.type} · {entry.size} B</span></li>
        ))}</ul>
      </div>
    </section>
  )
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
