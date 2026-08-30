import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentMarkdownMessage } from './AgentMarkdownMessage'

describe('AgentMarkdownMessage', () => {
  it('renders revision-pinned Prompt citations outside model markdown', () => {
    const markup = renderToStaticMarkup(
      <AgentMarkdownMessage
        content="Use this reference."
        citations={[{
          referenceCode: 'PLP-01ARZ3NDEKTSV4RRFFQ69G5FAV',
          title: 'Rainy city',
          revision: 3,
          digest: `sha256:${'a'.repeat(64)}`
        }]}
      />
    )

    expect(markup).toContain('data-testid="agent-prompt-citations"')
    expect(markup).toContain('PLP-01ARZ3NDEKTSV4RRFFQ69G5FAV · r3 · Rainy city')
  })

  it('renders an explicit degraded retrieval state', () => {
    const markup = renderToStaticMarkup(
      <AgentMarkdownMessage
        content="No evidence was injected."
        promptRetrieval={{ degraded: true, resultCount: 0, staleRejectedCount: 0, errorCode: 'prompt_retrieval_unavailable' }}
      />
    )

    expect(markup).toContain('data-testid="agent-prompt-retrieval-degraded"')
    expect(markup).toContain('Prompt 检索当前不可用')
  })
})
