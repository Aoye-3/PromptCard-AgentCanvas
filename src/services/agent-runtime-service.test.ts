import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentRuntimeService, parseAgentWorkspaceProposals } from './agent-runtime-service'
import { sha256Utf8 } from '@/domain/documents/planning-document'

const DOCUMENT_RESOURCE_ID = 'a'.repeat(32)
const DOCUMENT_NODE_ID = 'free-text-1700000000000-abc123'
const HANDOFF_SHOT_TEXT = '{"id":"shot-1"}'
const HANDOFF_SHOT_DIGEST = `sha256:${sha256Utf8(HANDOFF_SHOT_TEXT)}`
const HANDOFF_PROVENANCE = {
  model: {
    connectionId: 'connection-1', providerId: 'provider-1', modelId: 'model-1',
    displayName: 'Production Model', capabilities: { input: ['text'], toolCalling: true }
  },
  skills: [{ skillId: 'SKL-tone', revision: 2, digest: `sha256:${'d'.repeat(64)}` }]
}

const successfulMessageResponse = () => new Response(JSON.stringify({
  threadId: 'thread-1',
  conversationId: 'conversation-1',
  text: 'ok',
  proposals: [],
  canvasEdits: []
}), { status: 200, headers: { 'Content-Type': 'application/json' } })

const storyboardResponseSource = () => ({
  documentNodeId: 'document-1', documentRevision: 4, documentDigest: `sha256:${'b'.repeat(64)}`,
  documentResourceDigests: [`sha256:${'c'.repeat(64)}`],
  model: {
    connectionId: 'connection-1', providerId: 'provider-1', modelId: 'model-1',
    displayName: 'Model', capabilities: {}
  },
  skills: [{ skillId: 'skill-1', revision: 2, digest: `sha256:${'d'.repeat(64)}` }]
})

const storyboardResponseEdit = (source: unknown = storyboardResponseSource()) => ({
  kind: 'storyboard_create', id: 'edit-1', editId: 'edit-1', conversationId: 'conversation-1',
  requestId: 'request-1', nodeId: 'storyboard-1', expectedResultDigest: `sha256:${'a'.repeat(64)}`,
  base: { projectRevision: 7 },
  payload: {
    title: 'Shots',
    sequence: {
      id: 'sequence-1', name: 'Opening', description: '', style: 'ink', constraints: '', rows: [{
        id: 'row-1', cutLabel: '1', timeRange: '0-1s', subject: '', action: '', scene: '', camera: '',
        lighting: '', audio: '', duration: '1s', createdAt: 1, updatedAt: 1
      }],
      createdAt: 1, updatedAt: 1, meta: {}
    },
    source
  },
  rationale: 'Explicit transform'
})

const storyboardChangesResponseEdit = (payload: Record<string, unknown>) => ({
  kind: 'storyboard_changes', id: 'edit-2', editId: 'edit-2', conversationId: 'conversation-2',
  requestId: 'request-2', nodeId: 'storyboard-1', expectedResultDigest: `sha256:${'e'.repeat(64)}`,
  base: { projectRevision: 8, nodeRevision: 3, nodeDigest: `sha256:${'f'.repeat(64)}` },
  payload,
  rationale: 'Refine shots'
})

const documentResponseEdit = (
  kind: 'document_create' | 'document_changes',
  provenance: unknown = HANDOFF_PROVENANCE
) => ({
  kind,
  id: `edit-${kind}`,
  editId: `edit-${kind}`,
  conversationId: 'conversation-1',
  requestId: 'request-1',
  nodeId: 'document-1',
  expectedResultDigest: `sha256:${'a'.repeat(64)}`,
  base: kind === 'document_create'
    ? { projectRevision: 7 }
    : { projectRevision: 7, nodeRevision: 2, nodeDigest: `sha256:${'b'.repeat(64)}` },
  payload: kind === 'document_create'
    ? {
        title: 'Plan',
        blocks: [{ id: 'paragraph-1', type: 'paragraph', content: [{ text: 'Hello' }] }],
        linkedDocumentResourceIds: []
      }
    : {
        operations: [{
          kind: 'insert', blockId: 'paragraph-1', utf8Offset: 5,
          text: ' world', expectedTextDigest: `sha256:${'c'.repeat(64)}`
        }]
      },
  rationale: kind === 'document_create' ? 'Create a tracked planning document.' : 'Revise it.',
  ...(provenance !== undefined ? { provenance } : {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('agent runtime message contract', () => {
  it('serializes only a bounded Prompt retrieval request and rejects browser snapshots', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulMessageResponse())
    vi.stubGlobal('fetch', fetchMock)

    await agentRuntimeService.sendMessage({
      content: 'Find a rainy city prompt',
      promptRetrieval: {
        query: ' rainy city ', types: ['shot'], categories: ['cinematic'],
        exactCodes: ['PLP-01ARZ3NDEKTSV4RRFFQ69G5FAV'], limit: 10
      }
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.promptRetrieval).toEqual({
      query: 'rainy city', types: ['shot'], categories: ['cinematic'],
      exactCodes: ['PLP-01ARZ3NDEKTSV4RRFFQ69G5FAV'], limit: 10
    })
    expect(body).not.toHaveProperty('promptLibrary')

    await expect(agentRuntimeService.sendMessage({
      content: 'Do not accept a browser snapshot', promptLibrary: []
    } as unknown as Parameters<typeof agentRuntimeService.sendMessage>[0]))
      .rejects.toThrow('Invalid agent runtime message request.')
  })

  it.each([
    ['an empty query', { query: '', types: [], categories: [], exactCodes: [], limit: 10 }],
    ['duplicate filters', { query: 'city', types: ['shot', 'shot'], categories: [], exactCodes: [], limit: 10 }],
    ['an internal id', { query: 'city', types: [], categories: [], exactCodes: ['preset-1'], limit: 10 }],
    ['an excessive limit', { query: 'city', types: [], categories: [], exactCodes: [], limit: 21 }]
  ])('rejects Prompt retrieval containing %s before fetch', async (_label, promptRetrieval) => {
    const fetchMock = vi.fn().mockResolvedValue(successfulMessageResponse())
    vi.stubGlobal('fetch', fetchMock)

    await expect(agentRuntimeService.sendMessage({ content: 'Find it', promptRetrieval }))
      .rejects.toThrow('Invalid promptRetrieval.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

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
    const edit = documentResponseEdit('document_create')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-1', conversationId: 'conversation-1', requestId: 'request-1',
      text: 'ok', proposals: [], canvasEdits: [edit]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await agentRuntimeService.sendMessage({ content: 'Create it', projectId: 'project-1' })

    expect(result.canvasEdits).toEqual([edit])
  })

  it.each(['document_create', 'document_changes'] as const)(
    'preserves exact Agent provenance on an enriched %s response',
    async kind => {
      const edit = documentResponseEdit(kind)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        threadId: 'thread-1', conversationId: 'conversation-1', requestId: 'request-1',
        text: 'ok', proposals: [], canvasEdits: [edit]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

      const result = await agentRuntimeService.sendMessage({ content: 'Apply it', projectId: 'project-1' })

      expect(result.canvasEdits).toEqual([expect.objectContaining({ kind, provenance: HANDOFF_PROVENANCE })])
    }
  )

  it.each([
    ['missing model', { skills: [] }],
    ['null model', { model: null, skills: [] }],
    ['model extra key', { ...HANDOFF_PROVENANCE, model: { ...HANDOFF_PROVENANCE.model, trusted: true } }],
    ['non-NFC model id', { ...HANDOFF_PROVENANCE, model: { ...HANDOFF_PROVENANCE.model, modelId: 'e\u0301' } }],
    ['bad Skill digest', { ...HANDOFF_PROVENANCE, skills: [{ ...HANDOFF_PROVENANCE.skills[0], digest: 'sha256:nope' }] }],
    ['duplicate Skills', { ...HANDOFF_PROVENANCE, skills: [HANDOFF_PROVENANCE.skills[0], HANDOFF_PROVENANCE.skills[0]] }],
    ['nine Skills', {
      ...HANDOFF_PROVENANCE,
      skills: Array.from({ length: 9 }, (_, index) => ({
        skillId: `SKL-${index}`, revision: index, digest: `sha256:${index.toString(16).repeat(64)}`
      }))
    }]
  ])('rejects enriched Document create/change provenance with %s', async (_label, provenance) => {
    const fetchMock = vi.fn()
    for (const kind of ['document_create', 'document_changes'] as const) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        threadId: 'thread-1', conversationId: 'conversation-1', requestId: 'request-1',
        text: 'ok', proposals: [], canvasEdits: [documentResponseEdit(kind, provenance)]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    vi.stubGlobal('fetch', fetchMock)

    for (const kind of ['document_create', 'document_changes'] as const) {
      await expect(agentRuntimeService.sendMessage({ content: kind, projectId: 'project-1' }))
        .rejects.toThrow('Invalid agent canvas edits.')
    }
  })

  it('serializes only the explicit Storyboard transform selector and accepts an enriched create edit', async () => {
    const edit = storyboardResponseEdit()
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

  it('serializes one closed Document selection Prompt handoff selector', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-1', conversationId: 'conversation-1', text: 'ok', proposals: [], canvasEdits: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const basis = {
      kind: 'document-selection' as const, nodeId: 'document-1', documentRevision: 4,
      documentDigest: `sha256:${'a'.repeat(64)}`, blockId: 'paragraph-1',
      utf8Start: 0, utf8End: 5, selectedText: 'Café', selectedTextDigest: `sha256:${sha256Utf8('Café')}`
    }
    await agentRuntimeService.sendMessage({
      content: '转为 Prompt 提案', projectId: 'project-1', interactionMode: 'chat-experimental',
      documentWriteContext: { operationKind: 'prompt_handoff', basis }
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).documentWriteContext)
      .toEqual({ operationKind: 'prompt_handoff', basis })
  })

  it('accepts only a closed pending Prompt handoff proposal at experimental live ingress', async () => {
    const handoffBasis = {
      kind: 'storyboard-shot' as const, nodeId: 'storyboard-1', storyboardRevision: 3,
      storyboardDigest: `sha256:${'a'.repeat(64)}`, rowId: 'shot-1',
      shotDigest: HANDOFF_SHOT_DIGEST, shotText: HANDOFF_SHOT_TEXT
    }
    const valid = {
      kind: 'free_canvas_text_create', id: 'handoff-valid', agentName: 'PromptCard Agent',
      status: 'pending', createdAt: 1, title: 'Agent Prompt', userText: 'cinematic portrait',
      handoffBasis, rationale: 'explicit handoff', provenance: HANDOFF_PROVENANCE
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-1', conversationId: 'conversation-1', text: 'ok', canvasEdits: [],
      proposals: [
        valid,
        { ...valid, id: 'handoff-extra', browserTrusted: true },
        { ...valid, id: 'handoff-missing', handoffBasis: undefined },
        { ...valid, id: 'handoff-basis-extra', handoffBasis: { ...handoffBasis, browserTrusted: true } },
        { ...valid, id: 'handoff-shot-text-missing', handoffBasis: { ...handoffBasis, shotText: undefined } },
        {
          ...valid, id: 'handoff-shot-non-nfc',
          handoffBasis: {
            ...handoffBasis, shotText: 'e\u0301', shotDigest: `sha256:${sha256Utf8('e\u0301')}`
          }
        },
        {
          ...valid, id: 'handoff-document-offset',
          handoffBasis: {
            kind: 'document-selection', nodeId: 'document-1', documentRevision: 1,
            documentDigest: `sha256:${'e'.repeat(64)}`, blockId: 'paragraph-1',
            utf8Start: 0, utf8End: 4, selectedText: 'Café',
            selectedTextDigest: `sha256:${sha256Utf8('Café')}`
          }
        },
        {
          ...valid, id: 'handoff-rewrite', handoffBasis: undefined, sourceNodeId: 'text-1',
          basis: { baseNodeRevision: 1, templateDigest: `sha256:${'c'.repeat(64)}`, baseSegmentsDigest: `sha256:${'d'.repeat(64)}` }
        }
      ]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await agentRuntimeService.sendMessage({
      content: 'create proposal', projectId: 'project-1', interactionMode: 'chat-experimental',
      permissionScope: 'workspace-chatbot-agent'
    })

    expect(result.proposals).toEqual([expect.objectContaining({
      id: 'handoff-valid', handoffBasis, threadId: 'conversation-1', provenance: HANDOFF_PROVENANCE
    })])
  })

  it.each([
    ['model extra key', { ...HANDOFF_PROVENANCE, model: { ...HANDOFF_PROVENANCE.model, secret: 'x' } }],
    ['missing model display name', { ...HANDOFF_PROVENANCE, model: { connectionId: 'connection-1', providerId: 'provider-1', modelId: 'model-1', capabilities: {} } }],
    ['non-NFC model id', { ...HANDOFF_PROVENANCE, model: { ...HANDOFF_PROVENANCE.model, modelId: 'e\u0301' } }],
    ['negative skill revision', { ...HANDOFF_PROVENANCE, skills: [{ ...HANDOFF_PROVENANCE.skills[0], revision: -1 }] }],
    ['unsafe skill revision', { ...HANDOFF_PROVENANCE, skills: [{ ...HANDOFF_PROVENANCE.skills[0], revision: Number.MAX_SAFE_INTEGER + 1 }] }],
    ['forged skill digest', { ...HANDOFF_PROVENANCE, skills: [{ ...HANDOFF_PROVENANCE.skills[0], digest: 'sha256:nope' }] }],
    ['duplicate skills', { ...HANDOFF_PROVENANCE, skills: [HANDOFF_PROVENANCE.skills[0], HANDOFF_PROVENANCE.skills[0]] }],
    ['nine skills', { ...HANDOFF_PROVENANCE, skills: Array.from({ length: 9 }, (_, index) => ({ skillId: `SKL-${index}`, revision: 1, digest: `sha256:${index.toString(16).repeat(64)}` })) }],
    ['skill extra key', { ...HANDOFF_PROVENANCE, skills: [{ ...HANDOFF_PROVENANCE.skills[0], secret: 'x' }] }]
  ])('rejects experimental handoff provenance with %s', async (_label, provenance) => {
    const proposal = {
      kind: 'free_canvas_text_create', id: 'handoff-invalid-provenance', agentName: 'PromptCard Agent',
      status: 'pending', createdAt: 1, title: 'Agent Prompt', userText: 'cinematic portrait',
      handoffBasis: {
        kind: 'storyboard-shot', nodeId: 'storyboard-1', storyboardRevision: 3,
        storyboardDigest: `sha256:${'a'.repeat(64)}`, rowId: 'shot-1',
        shotDigest: HANDOFF_SHOT_DIGEST, shotText: HANDOFF_SHOT_TEXT
      }, rationale: 'explicit handoff', provenance
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-1', conversationId: 'conversation-1', text: 'ok', canvasEdits: [], proposals: [proposal]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const result = await agentRuntimeService.sendMessage({
      content: 'create proposal', projectId: 'project-1', interactionMode: 'chat-experimental',
      permissionScope: 'workspace-chatbot-agent'
    })
    expect(result.proposals).toEqual([])
  })

  it('rejects a model-reported conversation identity instead of trusting or preserving it', async () => {
    const proposal = {
      kind: 'free_canvas_text_create', id: 'handoff-forged-thread', agentName: 'PromptCard Agent',
      status: 'pending', createdAt: 1, title: 'Agent Prompt', userText: 'cinematic portrait',
      threadId: 'forged-conversation',
      handoffBasis: {
        kind: 'storyboard-shot', nodeId: 'storyboard-1', storyboardRevision: 3,
        storyboardDigest: `sha256:${'a'.repeat(64)}`, rowId: 'shot-1',
        shotDigest: HANDOFF_SHOT_DIGEST, shotText: HANDOFF_SHOT_TEXT
      }, rationale: 'explicit handoff', provenance: HANDOFF_PROVENANCE
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-1', conversationId: 'conversation-1', text: 'ok', canvasEdits: [], proposals: [proposal]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const result = await agentRuntimeService.sendMessage({
      content: 'create proposal', projectId: 'project-1', interactionMode: 'chat-experimental'
    })
    expect(result.proposals).toEqual([])
  })

  it('keeps the legacy source-bound Prompt create valid at prompt-edit live ingress', async () => {
    const rewrite = {
      kind: 'free_canvas_text_create', id: 'rewrite-valid', agentName: 'PromptCard Agent',
      status: 'pending', createdAt: 1, userText: 'rewritten', sourceNodeId: 'text-1',
      basis: { baseNodeRevision: 1, templateDigest: `sha256:${'c'.repeat(64)}`, baseSegmentsDigest: `sha256:${'d'.repeat(64)}` },
      rationale: 'rewrite'
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-1', text: 'ok', canvasEdits: [], proposals: [rewrite]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const result = await agentRuntimeService.sendMessage({
      content: 'rewrite', projectId: 'project-1', interactionMode: 'prompt-edit',
      permissionScope: 'workspace-chatbot-agent'
    })
    expect(result.proposals).toEqual([expect.objectContaining({ id: 'rewrite-valid', sourceNodeId: 'text-1' })])
  })

  it.each([
    ['empty rows', (candidate: Record<string, unknown>) => { candidate.rows = [] }],
    ['missing lighting', (candidate: Record<string, unknown>) => {
      delete (candidate.rows as Array<Record<string, unknown>>)[0].lighting
    }],
    ['missing audio', (candidate: Record<string, unknown>) => {
      delete (candidate.rows as Array<Record<string, unknown>>)[0].audio
    }],
    ['numeric lighting', (candidate: Record<string, unknown>) => {
      (candidate.rows as Array<Record<string, unknown>>)[0].lighting = 0
    }],
    ['null lighting', (candidate: Record<string, unknown>) => {
      (candidate.rows as Array<Record<string, unknown>>)[0].lighting = null
    }],
    ['a sequence extra key', (candidate: Record<string, unknown>) => { candidate.browserTrusted = true }],
    ['a row extra key', (candidate: Record<string, unknown>) => {
      (candidate.rows as Array<Record<string, unknown>>)[0].browserTrusted = true
    }],
    ['a decomposed sequence id', (candidate: Record<string, unknown>) => { candidate.id = 'Cafe\u0301' }],
    ['an unpaired surrogate row id', (candidate: Record<string, unknown>) => {
      (candidate.rows as Array<Record<string, unknown>>)[0].id = 'bad\ud800'
    }],
    ['an oversized sequence id', (candidate: Record<string, unknown>) => { candidate.id = 'x'.repeat(10_001) }],
    ['duplicate row ids', (candidate: Record<string, unknown>) => {
      const rows = candidate.rows as Array<Record<string, unknown>>
      rows.push({ ...rows[0] })
    }],
    ['an invalid sequence createdAt', (candidate: Record<string, unknown>) => { candidate.createdAt = -1 }],
    ['an invalid sequence updatedAt', (candidate: Record<string, unknown>) => { candidate.updatedAt = 1.5 }],
    ['invalid sequence metadata', (candidate: Record<string, unknown>) => { candidate.meta = [] }],
    ['an invalid row createdAt', (candidate: Record<string, unknown>) => {
      (candidate.rows as Array<Record<string, unknown>>)[0].createdAt = -1
    }],
    ['an invalid row updatedAt', (candidate: Record<string, unknown>) => {
      (candidate.rows as Array<Record<string, unknown>>)[0].updatedAt = 1.5
    }]
  ])('rejects enriched Storyboard creation with %s at service ingress', async (_label, mutate) => {
    const edit = storyboardResponseEdit()
    mutate(edit.payload.sequence as unknown as Record<string, unknown>)
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-1', conversationId: 'conversation-1', text: 'ok', proposals: [], canvasEdits: [edit]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(agentRuntimeService.sendMessage({ content: 'Create it', projectId: 'project-1' }))
      .rejects.toThrow('Invalid agent canvas edits.')
  })

  it.each([
    ['nine Skills', () => ({
      ...storyboardResponseSource(),
      skills: Array.from({ length: 9 }, (_, index) => ({
        skillId: `skill-${index + 1}`, revision: index + 1,
        digest: `sha256:${String(index + 1).repeat(64)}`
      }))
    })],
    ['a legacy three-key model', () => ({
      ...storyboardResponseSource(),
      model: { connectionId: 'connection-1', providerId: 'provider-1', modelId: 'model-1' }
    })],
    ['malformed model capabilities', () => ({
      ...storyboardResponseSource(),
      model: { ...storyboardResponseSource().model, capabilities: [] }
    })],
    ['a bad Document digest', () => ({ ...storyboardResponseSource(), documentDigest: 'not-a-digest' })],
    ['duplicate Skills', () => ({
      ...storyboardResponseSource(),
      skills: [storyboardResponseSource().skills[0], storyboardResponseSource().skills[0]]
    })],
    ['an extraneous source key', () => ({ ...storyboardResponseSource(), browserTrusted: true })]
  ])('rejects Storyboard response ingress with %s', async (_label, source) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-1', conversationId: 'conversation-1', text: 'ok', proposals: [],
      canvasEdits: [storyboardResponseEdit(source())]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(agentRuntimeService.sendMessage({ content: 'Create it', projectId: 'project-1' }))
      .rejects.toThrow('Invalid agent canvas edits.')
  })

  it('requires exact authoritative source provenance on enriched Storyboard changes', async () => {
    const valid = storyboardChangesResponseEdit({
      changes: [{ scope: 'row', rowId: 'row-1', field: 'camera', value: 'close-up' }],
      source: storyboardResponseSource()
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        threadId: 'thread-2', conversationId: 'conversation-2', text: 'ok', proposals: [], canvasEdits: [valid]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        threadId: 'thread-2', conversationId: 'conversation-2', text: 'ok', proposals: [],
        canvasEdits: [storyboardChangesResponseEdit({
          changes: [{ scope: 'row', rowId: 'row-1', field: 'camera', value: 'close-up' }]
        })]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(agentRuntimeService.sendMessage({ content: 'Refine it', projectId: 'project-1' }))
      .resolves.toMatchObject({ canvasEdits: [valid] })
    await expect(agentRuntimeService.sendMessage({ content: 'Refine it', projectId: 'project-1' }))
      .rejects.toThrow('Invalid agent canvas edits.')
  })

  it.each([
    ['33 operations', Array.from({ length: 33 }, (_, index) => ({
      scope: 'row', rowId: `row-${index + 1}`, field: 'camera', value: 'close-up'
    }))],
    ['an operation extra key', [{ scope: 'row', rowId: 'row-1', field: 'camera', value: 'close-up', browserTrusted: true }]],
    ['an illegal scope/field pair', [{ scope: 'sequence', field: 'camera', value: 'close-up' }]],
    ['a decomposed row id', [{ scope: 'row', rowId: 'Cafe\u0301', field: 'camera', value: 'close-up' }]],
    ['a decomposed value', [{ scope: 'row', rowId: 'row-1', field: 'camera', value: 'Cafe\u0301' }]],
    ['an unpaired surrogate', [{ scope: 'row', rowId: 'row-1', field: 'camera', value: 'bad\ud800' }]],
    ['an oversized field value', [{ scope: 'row', rowId: 'row-1', field: 'camera', value: 'x'.repeat(10_001) }]]
  ])('rejects enriched Storyboard changes with %s at service ingress', async (_label, changes) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      threadId: 'thread-2', conversationId: 'conversation-2', text: 'ok', proposals: [],
      canvasEdits: [storyboardChangesResponseEdit({ source: storyboardResponseSource(), changes })]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(agentRuntimeService.sendMessage({ content: 'Refine it', projectId: 'project-1' }))
      .rejects.toThrow('Invalid agent canvas edits.')
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
      conversationId: 'conversation one', requestId: 'request-1', editId: 'edit:one'
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
      conversationId: 'conversation-1', requestId: 'request-1', editId: 'edit-1'
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

  it.each([
    ['an unknown status', {
      status: 'maybe', conversationId: 'conversation-1', requestId: 'request-1', editId: 'edit-1'
    }],
    ['a mismatched conversation', {
      status: 'applied', conversationId: 'conversation-other', requestId: 'request-1', editId: 'edit-1'
    }],
    ['a mismatched request', {
      status: 'applied', conversationId: 'conversation-1', requestId: 'request-other', editId: 'edit-1'
    }],
    ['a mismatched edit', {
      status: 'applied', conversationId: 'conversation-1', requestId: 'request-1', editId: 'edit-other'
    }]
  ])('rejects an ACK response with %s', async (_label, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    })))

    await expect(agentRuntimeService.acknowledgeDocumentEdit(
      'project-1', 'conversation-1', 'edit-1', { requestId: 'request-1', status: 'applied' }
    )).rejects.toThrow('Invalid agent edit status.')
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
      conversationId: 'conversation-1', requestId: 'request-1', editId: 'edit-only',
      canvasEdits: [{ kind: 'document_create', id: 'edit-only' }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(agentRuntimeService.reconcileDocumentEdits('project-1', 'conversation-1'))
      .rejects.toThrow('Invalid agent canvas edits.')
  })

  it.each([
    ['an unknown status', { status: 'maybe', canvasEdits: [] }],
    ['a mismatched conversation', {
      status: 'applied', conversationId: 'conversation-other', requestId: 'request-1', editId: 'edit-1',
      canvasEdits: []
    }]
  ])('rejects reconciliation with %s', async (_label, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    })))

    await expect(agentRuntimeService.reconcileDocumentEdits('project-1', 'conversation-1'))
      .rejects.toThrow('Invalid agent edit reconciliation.')
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

  it('preserves a strict planning handoff basis without turning it into rewrite source authority', () => {
    const proposal = parseAgentWorkspaceProposals(JSON.stringify({
      kind: 'free_canvas_text_create', id: 'handoff-1', userText: 'cinematic portrait',
      handoffBasis: {
        kind: 'storyboard-shot', nodeId: 'storyboard-1', storyboardRevision: 3,
        storyboardDigest: `sha256:${'a'.repeat(64)}`, rowId: 'shot-1',
        shotDigest: HANDOFF_SHOT_DIGEST, shotText: HANDOFF_SHOT_TEXT
      }
    }))[0]
    expect(proposal).toMatchObject({
      kind: 'free_canvas_text_create', handoffBasis: expect.objectContaining({ kind: 'storyboard-shot', rowId: 'shot-1' })
    })
    expect(proposal).not.toHaveProperty('sourceNodeId')
  })

  it('rejects a Prompt create response that carries a malformed planning handoff basis', () => {
    expect(parseAgentWorkspaceProposals(JSON.stringify({
      kind: 'free_canvas_text_create', id: 'handoff-bad', userText: 'must not bypass freshness',
      handoffBasis: { kind: 'storyboard-shot', nodeId: 'storyboard-1', rowId: 'missing-authority' }
    }))).toEqual([])
  })

  it('rejects Prompt handoff digests that only imitate the sha256 prefix', () => {
    expect(parseAgentWorkspaceProposals(JSON.stringify({
      kind: 'free_canvas_text_create', id: 'handoff-forged-digest', userText: 'must not bypass freshness',
      handoffBasis: {
        kind: 'storyboard-shot', nodeId: 'storyboard-1', storyboardRevision: 3,
        storyboardDigest: 'sha256:not-a-digest', rowId: 'shot-1',
        shotDigest: HANDOFF_SHOT_DIGEST, shotText: HANDOFF_SHOT_TEXT
      }
    }))).toEqual([])
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
