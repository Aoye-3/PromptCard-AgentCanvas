import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentPromptCitation, AgentPromptRetrievalState } from '@/models/Agent.model'

export function AgentMarkdownMessage({
  content,
  citations = [],
  promptRetrieval
}: {
  content: string
  citations?: AgentPromptCitation[]
  promptRetrieval?: AgentPromptRetrievalState
}) {
  return (
    <div className="min-w-0">
      <div
        data-agent-markdown="true"
        className="min-w-0 break-words text-[13px] leading-6 text-[#353431] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:break-all [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[#c9c7bf] [&_blockquote]:pl-3 [&_blockquote]:text-[#5e5d59] [&_code]:rounded [&_code]:bg-black/[0.06] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-black [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-[15px] [&_h2]:font-black [&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-bold [&_hr]:my-3 [&_hr]:border-[#d9d8d3] [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[#242422] [&_pre]:p-3 [&_pre]:text-[#f7f7f4] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[11px] [&_strong]:font-black [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      >
        <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-[#9a4f31] underline decoration-[#d8a48f] underline-offset-2"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 max-w-full overflow-x-auto rounded-lg border border-[#d9d8d3]">
              <table className="w-full min-w-max border-collapse text-left text-[11px] [&_td]:border-t [&_td]:border-[#e5e4df] [&_td]:px-2 [&_td]:py-1.5 [&_th]:bg-white/70 [&_th]:px-2 [&_th]:py-1.5 [&_th]:font-black">
                {children}
              </table>
            </div>
          )
        }}
      >
        {content}
        </ReactMarkdown>
      </div>
      {citations.length > 0 && (
        <div data-testid="agent-prompt-citations" className="mt-3 rounded-xl border border-violet-100 bg-violet-50/60 px-3 py-2">
          <div className="text-[10px] font-black uppercase tracking-[0.12em] text-violet-600">Prompt 引用</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {citations.map(citation => (
              <span key={`${citation.referenceCode}:${citation.revision}`} title={citation.digest} className="rounded-full border border-violet-200 bg-white px-2 py-1 text-[10px] font-bold text-violet-700">
                {citation.referenceCode} · r{citation.revision} · {citation.title}
              </span>
            ))}
          </div>
        </div>
      )}
      {promptRetrieval?.degraded && (
        <div data-testid="agent-prompt-retrieval-degraded" className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
          Prompt 检索当前不可用，本轮未注入检索证据；其他 Agent 能力不受影响。
        </div>
      )}
    </div>
  )
}
