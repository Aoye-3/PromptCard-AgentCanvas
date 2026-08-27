import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentRuntimeService, parseAgentWorkspaceProposals } from './agent-runtime-service'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('agent runtime message contract', () => {
  it('serializes only project document and explicit Document node IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-1',
      conversationId: 'conversation-1',
      text: 'ok',
      proposals: [],
      canvasEdits: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await agentRuntimeService.sendMessage({
      content: 'Discuss the attached plan',
      projectId: 'project-1',
      documentResourceIds: ['document-resource-1'],
      explicitDocumentNodeIds: ['document-node-1'],
      file: new File(['secret'], 'secret.txt'),
      path: 'F:\\private\\secret.txt',
      providerFileId: 'provider-file-secret'
    } as Parameters<typeof agentRuntimeService.sendMessage>[0] & Record<string, unknown>)

    const request = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(String(request.body))
    expect(body).toMatchObject({
      content: 'Discuss the attached plan',
      projectId: 'project-1',
      documentResourceIds: ['document-resource-1'],
      explicitDocumentNodeIds: ['document-node-1']
    })
    expect(body).not.toHaveProperty('file')
    expect(body).not.toHaveProperty('path')
    expect(body).not.toHaveProperty('providerFileId')
    expect(JSON.stringify(body)).not.toContain('secret.txt')
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
