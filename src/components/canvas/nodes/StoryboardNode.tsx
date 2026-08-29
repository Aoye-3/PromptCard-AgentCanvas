import type { IFreeCanvasStoryboardNode } from '@/models/PromptHistory.model'

export function StoryboardNode({
  node,
  selected,
  locked = false,
  onRequestRevision,
  onResolve
}: {
  node: IFreeCanvasStoryboardNode
  selected: boolean
  locked?: boolean
  onRequestRevision?: () => void
  onResolve: (ids: readonly string[] | 'all', action: 'accept' | 'reject') => void
}) {
  return (
    <article
      aria-label={`分镜表：${node.title}`}
      className={`overflow-hidden rounded-lg border bg-white shadow-xl ${selected ? 'border-sky-500 ring-2 ring-sky-200' : 'border-gray-200'}`}
      style={{ width: node.width, minHeight: node.height }}
    >
      <header className="border-b border-gray-200 px-4 py-3">
        <span className="text-[10px] font-black uppercase tracking-widest text-sky-700">Storyboard</span>
        <strong className="block text-sm text-gray-900">{node.title}</strong>
        <span className="text-[10px] text-gray-500">{`Document r${node.source.documentRevision} · ${node.source.model.modelId}`}</span>
        {onRequestRevision ? (
          <button
            type="button"
            disabled={locked || node.pendingFieldChanges.length > 0}
            aria-label={`让 Agent 修订分镜表 ${node.title}`}
            onClick={onRequestRevision}
          >
            让 Agent 修订
          </button>
        ) : null}
      </header>
      <div className="grid gap-2 p-3">
        <div className="text-xs font-semibold text-gray-800">{node.sequence.name}</div>
        {node.sequence.rows.map(row => (
          <div key={row.id} className="rounded border border-gray-100 bg-gray-50 p-2 text-[11px] text-gray-600">
            <b>{row.cutLabel}</b> · {row.subject} · {row.action} · {row.camera}
          </div>
        ))}
        {node.pendingFieldChanges.map(change => (
          <div key={change.id} className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px]">
            <b>{change.field}</b>
            <div><del className="text-red-700">{change.previousValue}</del> → <ins className="text-emerald-700 no-underline">{change.newValue}</ins></div>
            <div className="mt-1 flex gap-1">
              <button type="button" disabled={locked} aria-label={`接受 ${change.field} 修改`} onClick={() => onResolve([change.id], 'accept')}>接受</button>
              <button type="button" disabled={locked} aria-label={`拒绝 ${change.field} 修改`} onClick={() => onResolve([change.id], 'reject')}>拒绝</button>
            </div>
          </div>
        ))}
      </div>
      {node.pendingFieldChanges.length > 0 ? (
        <footer className="flex gap-2 border-t border-gray-200 px-3 py-2">
          <button type="button" disabled={locked} aria-label="接受全部分镜修改" onClick={() => onResolve('all', 'accept')}>全部接受</button>
          <button type="button" disabled={locked} aria-label="拒绝全部分镜修改" onClick={() => onResolve('all', 'reject')}>全部拒绝</button>
        </footer>
      ) : null}
    </article>
  )
}
