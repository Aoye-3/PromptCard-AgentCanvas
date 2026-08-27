import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentRuntimeService, parseAgentWorkspaceProposals } from './agent-runtime-service'

const DOCUMENT_RESOURCE_ID = 'a'.repeat(32)
const DOCUMENT_NODE_ID = 'free-text-1700000000000-abc123'

const successfulMessageResponse = () => new Response(JSON.stringify({
  threadId: 'thread-1',
  conversationId: 'conversation-1',
  text: 'ok',
  proposals: [],
  canvasEdits: []
}), { status: 200, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('agent runtime message contract', () => {
  it('serializes only project document and explicit Document node IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulMessageResponse())
    vi.stubGlobal('fetch', fetchMock)

    await agentRuntimeService.sendMessage({
      content: 'Discuss the attached plan',
      projectId: 'project-1',
      documentResourceIds: [DOCUMENT_RESOURCE_ID],
      explicitDocumentNodeIds: [DOCUMENT_NODE_ID]
    })

    const request = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(String(request.body))
    expect(body).toMatchObject({
      content: 'Discuss the attached plan',
      projectId: 'project-1',
      documentResourceIds: [DOCUMENT_RESOURCE_ID],
      explicitDocumentNodeIds: [DOCUMENT_NODE_ID]
    })
    expect(body).not.toHaveProperty('file')
    expect(body).not.toHaveProperty('path')
    expect(body).not.toHaveProperty('providerFileId')
    expect(JSON.stringify(body)).not.toContain('secret.txt')
  })

  it.each([
    ['a File', { file: new File(['secret'], 'secret.txt') }],
    ['a local path', { path: 'F:\\private\\secret.txt' }],
    ['a URL', { url: 'https://provider.example/file/123' }],
    ['a data/base64 payload', { data: 'data:application/pdf;base64,AAAA' }],
    ['a provider handle', { providerFileId: 'provider-file-secret' }],
    ['an attachment object', { attachment: { id: DOCUMENT_RESOURCE_ID } }]
  ])('rejects a closed runtime request containing %s before fetch', async (_label, extra) => {
    const fetchMock = vi.fn().mockResolvedValue(successfulMessageResponse())
    vi.stubGlobal('fetch', fetchMock)

    await expect(agentRuntimeService.sendMessage({
      content: 'Discuss the attached plan',
      ...extra
    } as Parameters<typeof agentRuntimeService.sendMessage>[0] & Record<string, unknown>))
      .rejects.toThrow('Invalid agent runtime message request.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-array value', DOCUMENT_RESOURCE_ID],
    ['more than five values', Array.from({ length: 6 }, (_, index) => index.toString(16).padStart(32, '0'))],
    ['duplicate values', [DOCUMENT_RESOURCE_ID, DOCUMENT_RESOURCE_ID]],
    ['a local path', ['F:\\private\\plan.pdf']],
    ['a URL', ['https://provider.example/file/123']],
    ['a data/base64 value', ['data:application/pdf;base64,AAAA']],
    ['a provider handle object', [{ providerFileId: 'provider-secret' }]]
  ])('rejects documentResourceIds containing %s before fetch', async (_label, documentResourceIds) => {
    const fetchMock = vi.fn().mockResolvedValue(successfulMessageResponse())
    vi.stubGlobal('fetch', fetchMock)

    await expect(agentRuntimeService.sendMessage({
      content: 'Discuss the document',
      documentResourceIds
    } as unknown as Parameters<typeof agentRuntimeService.sendMessage>[0]))
      .rejects.toThrow('Invalid documentResourceIds.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-array value', DOCUMENT_NODE_ID],
    ['more than five values', Array.from({ length: 6 }, (_, index) => `document-node-${index}`)],
    ['duplicate values', [DOCUMENT_NODE_ID, DOCUMENT_NODE_ID]],
    ['a local path', ['F:\\private\\node']],
    ['a URL', ['https://provider.example/node/123']],
    ['a data/base64 value', ['data:text/plain;base64,AAAA']],
    ['a provider handle object', [{ providerNodeId: 'provider-secret' }]],
    ['an overlong Canvas ID', [`document-${'a'.repeat(192)}`]]
  ])('rejects explicitDocumentNodeIds containing %s before fetch', async (_label, explicitDocumentNodeIds) => {
    const fetchMock = vi.fn().mockResolvedValue(successfulMessageResponse())
    vi.stubGlobal('fetch', fetchMock)

    await expect(agentRuntimeService.sendMessage({
      content: 'Discuss the document',
      explicitDocumentNodeIds
    } as unknown as Parameters<typeof agentRuntimeService.sendMessage>[0]))
      .rejects.toThrow('Invalid explicitDocumentNodeIds.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts the existing Canvas ID character set without requiring UUIDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulMessageResponse())
    vi.stubGlobal('fetch', fetchMock)

    await agentRuntimeService.sendMessage({
      content: 'Discuss these nodes',
      explicitDocumentNodeIds: [
        DOCUMENT_NODE_ID,
        '550e8400-e29b-41d4-a716-446655440000',
        'document:section_1.2'
      ]
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).explicitDocumentNodeIds).toEqual([
      DOCUMENT_NODE_ID,
      '550e8400-e29b-41d4-a716-446655440000',
      'document:section_1.2'
    ])
  })
})

describe('agent runtime proposal parsing', () => {
  it('parses bounded interleaved text insertions and a rewrite basis', () => {
    const proposals = parseAgentWorkspaceProposals(JSON.stringify({
      kind: 'agent_workspace_proposals',
      proposals: [
        {
          kind: 'free_canvas_text_insertions', id: 'insert-1', nodeId: 'text-1',
          baseNodeRevision: 9, templateDigest: 'sha256:template', baseSegmentsDigest: 'sha256:segments',
          insertions: [{
            text: 'new clause',
            reason: 'Adds the missing visual detail.',
            anchor: { type: 'segment', segmentId: 'segment-1', position: 'after' }
          }]
        },
        {
          kind: 'free_canvas_text_create', id: 'rewrite-1', sourceNodeId: 'text-1', userText: 'rewritten',
          basis: { baseNodeRevision: 9, templateDigest: 'sha256:template', baseSegmentsDigest: 'sha256:segments' }
        }
      ]
    }))

    expect(proposals).toEqual([
      expect.objectContaining({
        kind: 'free_canvas_text_insertions',
        baseSegmentsDigest: 'sha256:segments',
        insertions: [{
          text: 'new clause',
          reason: 'Adds the missing visual detail.',
          anchor: { type: 'segment', segmentId: 'segment-1', position: 'after' }
        }]
      }),
      expect.objectContaining({
        kind: 'free_canvas_text_create',
        sourceNodeId: 'text-1',
        basis: { baseNodeRevision: 9, templateDigest: 'sha256:template', baseSegmentsDigest: 'sha256:segments' }
      })
    ])
  })

  it('requires a segment id for a text insertion anchor', () => {
    const proposals = parseAgentWorkspaceProposals(JSON.stringify({
      kind: 'free_canvas_text_insertions', id: 'insert-text-1', nodeId: 'text-1',
      baseNodeRevision: 9, templateDigest: 'sha256:template', baseSegmentsDigest: 'sha256:segments',
      insertions: [{
        text: 'inserted', reason: 'Adds a detail.',
        anchor: { type: 'text', segmentId: 'segment-1', text: '🎬\n', position: 'after' }
      }]
    }))

    expect(proposals).toEqual([expect.objectContaining({
      insertions: [{
        text: 'inserted', reason: 'Adds a detail.',
        anchor: { type: 'text', segmentId: 'segment-1', text: '🎬\n', position: 'after' }
      }]
    })])
  })

  it('parses a free canvas text creation proposal', () => {
    const proposals = parseAgentWorkspaceProposals(JSON.stringify({
      kind: 'free_canvas_text_create',
      id: 'create-1',
      agentName: 'PromptCard Agent',
      title: 'Agent Prompt',
      userText: 'cinematic portrait',
      rationale: 'No text node is selected.',
      status: 'pending',
      createdAt: 1
    }))

    expect(proposals).toEqual([
      expect.objectContaining({
        kind: 'free_canvas_text_create',
        id: 'create-1',
        title: 'Agent Prompt',
        userText: 'cinematic portrait'
      })
    ])
  })

  it('parses an editable media prompt preview without treating it as a write', () => {
    const proposals = parseAgentWorkspaceProposals(JSON.stringify({
      kind: 'media_prompt_preview', id: 'preview-1',
      previewDraft: { label: 'Industrial', type: 'style', category: 'media', content: 'brushed metal' },
      rationale: 'Derived from the selected image.'
    }))

    expect(proposals).toEqual([expect.objectContaining({
      kind: 'media_prompt_preview',
      previewDraft: expect.objectContaining({ content: 'brushed metal' })
    })])
  })

  it('parses append and selection rewrite canvas proposals without legacy mode fallback', () => {
    const proposals = parseAgentWorkspaceProposals(JSON.stringify({
      kind: 'agent_workspace_proposals',
      proposals: [
        {
          kind: 'free_canvas_text_update', id: 'append-1', nodeId: 'text-1',
          editMode: 'append', userText: 'new detail', baseContentDigest: 'sha256:base'
        },
        {
          kind: 'free_canvas_text_update', id: 'rewrite-1', nodeId: 'text-1',
          editMode: 'rewrite_selection', userText: 'warm',
          selection: { start: 0, end: 4, selectedText: 'cold' },
          baseContentDigest: 'sha256:base'
        }
      ]
    }))

    expect(proposals).toEqual([
      expect.objectContaining({ editMode: 'append', userText: 'new detail' }),
      expect.objectContaining({
        editMode: 'rewrite_selection',
        selection: { start: 0, end: 4, selectedText: 'cold' }
      })
    ])
  })
})
