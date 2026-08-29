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

  it('accepts one closed enriched Document create edit from Gateway', async () => {
    const edit = {
      kind: 'document_create',
      id: '2c16cf56-20c8-5eb7-b1b0-a9d32e986025',
      editId: '2c16cf56-20c8-5eb7-b1b0-a9d32e986025',
      conversationId: 'conversation-1',
      requestId: 'request-1',
      nodeId: 'document-1',
      expectedResultDigest: `sha256:${'a'.repeat(64)}`,
      base: { projectRevision: 7 },
      payload: {
        title: 'Plan',
        blocks: [{ id: 'paragraph-1', type: 'paragraph', content: [{ text: 'Hello' }] }],
        linkedDocumentResourceIds: []
      },
      rationale: 'Create a tracked planning document.',
      provenance: { model: null, skills: [] }
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-1', conversationId: 'conversation-1', requestId: 'request-1',
      text: 'ok', proposals: [], canvasEdits: [edit]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await agentRuntimeService.sendMessage({ content: 'Create it', projectId: 'project-1' })

    expect(result.canvasEdits).toEqual([edit])
  })

  it('serializes only the explicit Storyboard transform selector and accepts an enriched create edit', async () => {
    const sequence = {
      id: 'sequence-1', name: 'Opening', description: '', style: 'ink', constraints: '', rows: [{
        id: 'row-1', cutLabel: '1', timeRange: '0-1s', subject: '', action: '', scene: '', camera: '',
        lighting: '', audio: '', duration: '1s', createdAt: 1, updatedAt: 1
      }],
      createdAt: 1, updatedAt: 1, meta: {}
    }
    const edit = {
      kind: 'storyboard_create', id: 'edit-1', editId: 'edit-1', conversationId: 'conversation-1',
      requestId: 'request-1', nodeId: 'storyboard-1', expectedResultDigest: `sha256:${'a'.repeat(64)}`,
      base: { projectRevision: 7 },
      payload: {
        title: 'Shots', sequence,
        source: {
          documentNodeId: 'document-1', documentRevision: 4, documentDigest: `sha256:${'b'.repeat(64)}`,
          documentResourceDigests: [`sha256:${'c'.repeat(64)}`],
          model: { connectionId: 'connection-1', providerId: 'provider-1', modelId: 'model-1', displayName: 'Model', capabilities: {} },
          skills: [{ skillId: 'skill-1', revision: 2, digest: `sha256:${'d'.repeat(64)}` }]
        }
      }, rationale: 'Explicit transform'
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-1', conversationId: 'conversation-1', text: 'ok', proposals: [], canvasEdits: [edit]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await agentRuntimeService.sendMessage({
      content: '从文档创建分镜表', projectId: 'project-1', interactionMode: 'chat-experimental',
      documentWriteContext: { operationKind: 'storyboard_create', documentNodeId: 'document-1' }
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).documentWriteContext).toEqual({
      operationKind: 'storyboard_create', documentNodeId: 'document-1'
    })
    expect(result.canvasEdits).toEqual([edit])
  })

  it('rejects a malformed enriched Document edit before it can be applied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-1', conversationId: 'conversation-1', requestId: 'request-1', text: 'ok', proposals: [],
      canvasEdits: [{
        kind: 'document_changes', id: 'edit-1', conversationId: 'conversation-1', requestId: 'request-1',
        nodeId: 'document-1', expectedResultDigest: `sha256:${'a'.repeat(64)}`,
        base: { projectRevision: 7, nodeRevision: 2, nodeDigest: `sha256:${'b'.repeat(64)}` },
        payload: { operations: [] }, rationale: 'missing editId'
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(agentRuntimeService.sendMessage({ content: 'Change it', projectId: 'project-1' }))
      .rejects.toThrow('Invalid agent canvas edits.')
  })
})

describe('agent document apply acknowledgement contract', () => {
  it('sends an exact applied acknowledgement through the existing runtime prefix', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'applied',
      editId: 'edit-1'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await agentRuntimeService.acknowledgeDocumentEdit(
      'project/one',
      'conversation one',
      'edit:one',
      { requestId: 'request-1', status: 'applied' }
    )

    expect(fetchMock).toHaveBeenCalledWith(
      '/agent-api/promptcard/runtime/projects/project%2Fone/conversations/conversation%20one/edits/edit%3Aone/ack',
      expect.objectContaining({
        credentials: 'include',
        method: 'POST',
        body: JSON.stringify({ requestId: 'request-1', status: 'applied' })
      })
    )
  })

  it('sends a bounded failed acknowledgement without leaking provider evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'pending_apply',
      editId: 'edit-1'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await agentRuntimeService.acknowledgeDocumentEdit('project-1', 'conversation-1', 'edit-1', {
      requestId: 'request-1',
      status: 'failed',
      errorCode: 'failed_conflict'
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toEqual({
      requestId: 'request-1',
      status: 'failed',
      errorCode: 'failed_conflict'
    })
    expect(JSON.stringify(body)).not.toContain('providerFileId')
    expect(JSON.stringify(body)).not.toContain('F:\\')
  })

  it('reconciles pending edits with an empty closed body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'idle', canvasEdits: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await agentRuntimeService.reconcileDocumentEdits('project-1', 'conversation-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/agent-api/promptcard/runtime/projects/project-1/conversations/conversation-1/edits/reconcile',
      expect.objectContaining({
        credentials: 'include',
        method: 'POST',
        body: JSON.stringify({})
      })
    )
  })

  it('rejects a malformed replayed Document edit during restart reconciliation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'pending_apply',
      canvasEdits: [{ kind: 'document_create', id: 'edit-only' }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(agentRuntimeService.reconcileDocumentEdits('project-1', 'conversation-1'))
      .rejects.toThrow('Invalid agent canvas edits.')
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
