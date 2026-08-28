import { afterEach, describe, expect, test, vi } from 'vitest'
import type { IPromptProject } from '@/models/PromptHistory.model'
import { normalizeFreeCanvasProject } from '@/domain/free-canvas/free-canvas-project'
import { createPlanningDocumentV1 } from '@/domain/documents/planning-document'
import { storageServiceClient } from './storage-service-client'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('storageServiceClient', () => {
  test('uses an isolated project document identity client and strips internal fields', async () => {
    const unsafeResource = {
      id: 'document/one',
      projectId: 'project/one',
      originalFilename: 'plan.md',
      contentType: 'text/markdown',
      size: 7,
      sha256: 'a'.repeat(64),
      extractionKind: 'utf-8',
      extractionStatus: 'complete',
      normalizedTextDigest: 'b'.repeat(64),
      revision: 1,
      lifecycleStatus: 'active',
      createdAt: 1,
      updatedAt: 1,
      relativePath: 'documents/secret.md',
      normalizedText: '# secret',
      remoteFileId: 'provider-secret'
    }
    const expectedResource = {
      id: 'document/one',
      projectId: 'project/one',
      originalFilename: 'plan.md',
      contentType: 'text/markdown',
      size: 7,
      sha256: 'a'.repeat(64),
      extractionKind: 'utf-8',
      extractionStatus: 'complete',
      normalizedTextDigest: 'b'.repeat(64),
      revision: 1,
      lifecycleStatus: 'active',
      createdAt: 1,
      updatedAt: 1
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(unsafeResource))
      .mockResolvedValueOnce(jsonResponse({ resources: [unsafeResource] }))
      .mockResolvedValueOnce(jsonResponse(unsafeResource))
      .mockResolvedValueOnce(jsonResponse({ ...unsafeResource, lifecycleStatus: 'trash', revision: 2 }))
      .mockResolvedValueOnce(jsonResponse({ ...unsafeResource, lifecycleStatus: 'active', revision: 3 }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['# plan'], 'plan.md', { type: 'text/markdown' })

    await expect(storageServiceClient.projectDocumentResources.upload('project/one', file))
      .resolves.toEqual(expectedResource)
    await expect(storageServiceClient.projectDocumentResources.list('project/one'))
      .resolves.toEqual([expectedResource])
    await expect(storageServiceClient.projectDocumentResources.get('project/one', 'document/one'))
      .resolves.toEqual(expectedResource)
    await expect(storageServiceClient.projectDocumentResources.delete('project/one', 'document/one'))
      .resolves.toMatchObject({ lifecycleStatus: 'trash', revision: 2 })
    await expect(storageServiceClient.projectDocumentResources.restore('project/one', 'document/one'))
      .resolves.toMatchObject({ lifecycleStatus: 'active', revision: 3 })

    expect(fetchMock.mock.calls.map(call => [call[0], call[1]?.method])).toEqual([
      ['/storage-api/projects/project%2Fone/document-resources', 'POST'],
      ['/storage-api/projects/project%2Fone/document-resources', undefined],
      ['/storage-api/projects/project%2Fone/document-resources/document%2Fone', undefined],
      ['/storage-api/projects/project%2Fone/document-resources/document%2Fone', 'DELETE'],
      ['/storage-api/projects/project%2Fone/document-resources/document%2Fone/restore', 'POST']
    ])
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      body: file,
      headers: expect.objectContaining({
        'Content-Type': 'text/markdown',
        'X-File-Name': 'plan.md'
      })
    })
  })

  test('cancels a project document upload through the caller AbortSignal', async () => {
    const lifecycle = new AbortController()
    let requestSignal: AbortSignal | undefined
    let resolveFetch!: (response: Response) => void
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      resolveFetch = resolve
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['# plan'], 'plan.md', { type: 'text/markdown' })

    const upload = storageServiceClient.projectDocumentResources.upload('project/one', file, lifecycle.signal)
    lifecycle.abort('project-changed')
    await Promise.resolve()
    if (!requestSignal?.aborted) {
      resolveFetch(jsonResponse({
        id: 'a'.repeat(32), projectId: 'project/one', originalFilename: 'plan.md',
        contentType: 'text/markdown', size: 7, sha256: 'a'.repeat(64), extractionKind: 'utf-8',
        extractionStatus: 'complete', normalizedTextDigest: 'b'.repeat(64), revision: 1,
        lifecycleStatus: 'active', createdAt: 1, updatedAt: 1
      }))
    }

    await expect(upload).rejects.toMatchObject({ code: 'request_aborted', status: 0 })
    expect(requestSignal?.aborted).toBe(true)
  })

  test('creates, inspects and idempotently revokes a closed context-pack inspection', async () => {
    const inspection = contextPackInspection()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(inspection))
      .mockResolvedValueOnce(jsonResponse(inspection))
      .mockResolvedValueOnce(jsonResponse({
        ...inspection,
        revokedAt: 10,
        revokedBy: 'promptcard-ui',
        revocationReason: 'user-revoked'
      }))
    vi.stubGlobal('fetch', fetchMock)

    const payload = {
      projectCode: inspection.projectCode,
      projectRevision: inspection.projectRevision,
      nodeCodes: [inspection.entries[0].reference.code],
      placementHint: inspection.placementHint,
      creator: 'promptcard-ui' as const
    }

    await expect(storageServiceClient.contextPacks.create(payload)).resolves.toEqual(inspection)
    await expect(storageServiceClient.contextPacks.inspect(inspection.cvcCode)).resolves.toEqual(inspection)
    await expect(storageServiceClient.contextPacks.revoke(inspection.cvcCode, {
      actor: 'promptcard-ui', reason: 'user-revoked'
    })).resolves.toMatchObject({ cvcCode: inspection.cvcCode, revokedAt: 10 })

    expect(fetchMock.mock.calls.map(call => [call[0], call[1]?.method, call[1]?.body])).toEqual([
      ['/storage-api/context-packs', 'POST', JSON.stringify(payload)],
      [`/storage-api/context-packs/${inspection.cvcCode}`, undefined, undefined],
      [`/storage-api/context-packs/${inspection.cvcCode}/revoke`, 'POST', JSON.stringify({
        actor: 'promptcard-ui', reason: 'user-revoked'
      })]
    ])
  })

  test.each([
    ['an unknown root field', { internalId: 'secret-id' }],
    ['a malformed typed reference', { entries: [{
      reference: { namespace: 'canvasTemplate', code: 'CVT-invalid' },
      content: '{}',
      contentDigest: 'a'.repeat(64)
    }] }],
    ['a hidden nested URL field', { entries: [{
      ...contextPackInspection().entries[0],
      url: 'file:///secret/project.json'
    }] }]
  ])('fails closed when a context-pack response contains %s', async (_label, override) => {
    const payload = { ...contextPackInspection(), ...override }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)))

    await expect(storageServiceClient.contextPacks.inspect(contextPackInspection().cvcCode))
      .rejects.toMatchObject({ code: 'invalid_storage_response' })
  })

  test('rejects a malformed inspection code before issuing a context-pack request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(storageServiceClient.contextPacks.inspect('CVC-invalid'))
      .rejects.toMatchObject({ code: 'invalid_context_code' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('reports storage health without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(storageServiceClient.health()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/storage-api/health', expect.objectContaining({
      cache: 'no-cache',
      headers: { Accept: 'application/json' }
    }))
  })

  test('returns false when storage health is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    await expect(storageServiceClient.health()).resolves.toBe(false)
  })

  test('maps structured HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: { code: 'invalid_asset', message: 'Bad image', detail: { reason: 'signature' } }
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })))

    await expect(storageServiceClient.assets.diagnostics()).rejects.toMatchObject({
      name: 'StorageHttpError',
      status: 400,
      code: 'invalid_asset',
      message: 'Bad image',
      detail: { reason: 'signature' }
    })
  })

  test('maps revision conflicts with the current record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: { code: 'revision_conflict', message: 'Conflict', current: { id: 'p1', revision: 2 } }
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })))

    await expect(storageServiceClient.projects.update('p1', 1, { title: 'Stale' }))
      .rejects.toEqual(expect.objectContaining({
        name: 'StorageRevisionConflict',
        current: { id: 'p1', revision: 2 }
      }))
  })

  test('loads and atomically updates one project resource snapshot', async () => {
    const snapshot = {
      folders: [{ id: 'folder-1', projectId: 'project/1', parentId: null, name: 'Mood', sortOrder: 0, revision: 1, createdAt: 1, updatedAt: 1 }],
      resources: []
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(storageServiceClient.projectResources.getSnapshot('project/1')).resolves.toEqual(snapshot)
    await storageServiceClient.projectResources.updateLayout('project/1', {
      folders: [{ id: 'folder-1', parentId: null, sortOrder: 0, revision: 1 }],
      resources: []
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/storage-api/projects/project%2F1/resources',
      expect.any(Object)
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/storage-api/projects/project%2F1/resource-layout',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          folders: [{ id: 'folder-1', parentId: null, sortOrder: 0, revision: 1 }],
          resources: []
        })
      })
    )
  })

  test('returns null for a missing project', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: { code: 'not_found', message: 'Missing' }
    }), { status: 404, headers: { 'Content-Type': 'application/json' } })))

    await expect(storageServiceClient.projects.getById('missing')).resolves.toBeNull()
  })

  test('keeps response reference codes but strips them from project create and update payloads', async () => {
    const projected: IPromptProject = {
      id: 'project-1',
      title: 'Canvas',
      type: 'free-canvas',
      revision: 1,
      pages: [],
      currentPage: 0,
      referenceCode: 'PRJ-01M0N7FTG1PKB2AV2P8S62N6H8',
      freeCanvas: {
        nodes: [{
          id: 'text-1', kind: 'text', title: 'Text', position: { x: 0, y: 0 }, width: 420, height: 180,
          fontSize: 'large', segments: [], meta: {}, referenceCode: 'CVT-01M0N7FTG1PKB2AV2P8S62N6H8'
        }, {
          id: 'image-1', kind: 'image', title: 'Transient image', position: { x: 0, y: 0 }, width: 320, height: 240,
          transient: true, assetId: null, annotations: [], meta: {}, referenceCode: 'CVM-01M0N7FTG1PKB2AV2P8S62N6H8'
        }],
        edges: [], meta: {}
      },
      createdAt: 1, updatedAt: 1, lastOpenedAt: 1, meta: {}
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(projected), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(storageServiceClient.projects.getById('project-1')).resolves.toMatchObject({
      referenceCode: projected.referenceCode,
      freeCanvas: { nodes: [
        { referenceCode: projected.freeCanvas!.nodes[0].referenceCode },
        { referenceCode: projected.freeCanvas!.nodes[1].referenceCode, transient: true }
      ] }
    })
    projected.freeCanvas!.nodes[0].meta.referenceCodePending = true
    await storageServiceClient.projects.create(projected)
    await storageServiceClient.projects.update('project-1', 1, projected)

    const createPayload = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    const updatePayload = JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).updates
    for (const payload of [createPayload, updatePayload]) {
      expect(payload.referenceCode).toBeUndefined()
      expect(payload.freeCanvas.nodes[0].referenceCode).toBeUndefined()
      expect(payload.freeCanvas.nodes[0].meta.referenceCodePending).toBeUndefined()
      expect(payload.freeCanvas.nodes[1].referenceCode).toBeUndefined()
      expect(payload.freeCanvas.nodes[0].id).toBe('text-1')
      expect(payload.freeCanvas.nodes[1].transient).toBe(true)
    }
  })

  test('writes an unsupported Canvas projection back as its untouched original node', async () => {
    const originalNode = {
      id: 'future-node',
      kind: 'future-layout',
      title: 'Future layout',
      position: { x: 10, y: 20 },
      width: 360,
      height: 220,
      referenceCode: 'FUTURE-opaque-code',
      payload: { nested: [{ keep: true }] },
      meta: { referenceCodePending: true, futureFlag: 'preserve' }
    }
    const freeCanvas = normalizeFreeCanvasProject({
      nodes: [originalNode] as never,
      edges: [],
      meta: {}
    }, 1)
    const project: IPromptProject = {
      id: 'project-future', title: 'Future project', type: 'free-canvas', revision: 1,
      pages: [], currentPage: 0, freeCanvas,
      createdAt: 1, updatedAt: 1, lastOpenedAt: 1, meta: {}
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(project), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await storageServiceClient.projects.create(project)

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(payload.freeCanvas.nodes).toEqual([originalNode])
    expect(payload.freeCanvas.nodes[0].kind).toBe('future-layout')
    expect(payload.freeCanvas.nodes[0].originalNode).toBeUndefined()
  })

  test('writes a Document node as editor-neutral AST without derived or Tiptap state', async () => {
    const document = createPlanningDocumentV1([{
      id: 'paragraph-1',
      type: 'paragraph',
      content: [{ text: 'Plan ', href: 'https://example.com/brief' }]
    }], 3)
    const project: IPromptProject = {
      id: 'project-document', title: 'Document project', type: 'free-canvas', revision: 1,
      pages: [], currentPage: 0,
      freeCanvas: {
        nodes: [{
          id: 'document-1', kind: 'document', title: 'Plan', position: { x: 0, y: 0 },
          width: 560, height: 420, document, linkedDocumentResourceIds: [], meta: {}
        }],
        edges: [], viewport: null, selectedNodeId: 'document-1', meta: {}
      },
      createdAt: 1, updatedAt: 1, lastOpenedAt: 1, meta: {}
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(project), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await storageServiceClient.projects.create(project)

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(payload.freeCanvas.nodes[0].document).toEqual(document)
    expect(payload.freeCanvas.nodes[0].document.effectiveText).toBeUndefined()
    expect(payload.freeCanvas.nodes[0].tiptap).toBeUndefined()
  })

  test('manages project agent conversations and skills through scoped endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      conversations: [], skills: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)

    await storageServiceClient.agentConversations.list('project/1', 'trash')
    await storageServiceClient.agentConversations.create({
      projectId: 'project/1', entrypoint: 'workspace-chatbot-agent', mode: 'free-canvas'
    })
    await storageServiceClient.agentConversations.trash('conversation/1', 'project/1')
    await storageServiceClient.agentConversations.restore('conversation/1', 'project/1')
    await storageServiceClient.agentConversations.updateModel('conversation/1', 'project/1', {
      connectionId: 'connection-1', providerId: 'volcengine-ark', modelId: 'ark-chat'
    })
    await storageServiceClient.agentConversations.updateInteraction('conversation/1', 'project/1', {
      interactionMode: 'chat-experimental', boundSkillIds: ['SKL-one'], expectedRevision: 3
    })
    await storageServiceClient.agentConversations.deleteForever('conversation/1', 'project/1')
    await storageServiceClient.skills.list()

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/storage-api/agent-conversations?projectId=project%2F1&status=trash&limit=50', expect.any(Object))
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/storage-api/agent-conversations/conversation%2F1/trash', expect.objectContaining({ method: 'POST' }))
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/storage-api/projects/project%2F1/agent-conversations/conversation%2F1/model', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ modelBinding: { connectionId: 'connection-1', providerId: 'volcengine-ark', modelId: 'ark-chat' } })
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(6, '/storage-api/projects/project%2F1/conversations/conversation%2F1/interaction', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ interactionMode: 'chat-experimental', boundSkillIds: ['SKL-one'], expectedRevision: 3 })
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(7, '/storage-api/agent-conversations/conversation%2F1', expect.objectContaining({ method: 'DELETE' }))
    expect(fetchMock).toHaveBeenNthCalledWith(8, '/storage-api/skills', expect.any(Object))
  })

  test('manages inspected skills, exact reviews, independent pins, and projection repair', async () => {
    const responses = [
      { inspectionId: 'inspect-1', clean: true, manifest: { digest: 'sha256:one', entryCount: 0, totalBytes: 0, entries: [] }, findings: [] },
      { inspectionId: 'inspect-1', skill: { id: 'skill-1', referenceCode: 'SKL-ONE', revision: 1, digest: 'sha256:one', lifecycleStatus: 'active' } },
      { hosts: [{ id: 'codex', label: 'Codex .agents/skills', scopes: ['repo/one'] }] },
      { id: 'skill-1', revisions: [] },
      { skillId: 'skill-1', host: 'local-agent', scope: '', enabled: true, revision: 1, digest: 'sha256:one', projection: null, updatedAt: 1 },
      { skillId: 'skill-1', host: 'codex', scope: 'repo/one', enabled: true, revision: 1, digest: 'sha256:one', projection: { publicationName: 'skill-one' }, updatedAt: 1 },
      { skillId: 'skill-1', host: 'codex', scope: 'repo/one', enabled: true, revision: 1, digest: 'sha256:one', projection: { publicationName: 'skill-one' }, projectionHealth: { state: 'healthy' }, updatedAt: 1 },
      { id: 'skill-1', revisions: [], lifecycleStatus: 'archived' },
      { id: 'skill-1', revisions: [], lifecycleStatus: 'active' }
    ]
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(responses.shift())))
    vi.stubGlobal('fetch', fetchMock)

    await storageServiceClient.skills.inspectFolder('F:\\skills\\one')
    await storageServiceClient.skills.importInspected({
      inspectionId: 'inspect-1', operation: 'create', skill: { originLabel: 'one' }
    })
    await storageServiceClient.skills.describeHosts()
    await storageServiceClient.skills.reviewRevision('skill/1', 1, 'sha256:one', 'trusted')
    await storageServiceClient.skills.updateHostPin('skill/1', 'local-agent', { enabled: true, revision: 1 })
    await storageServiceClient.skills.updateHostPin('skill/1', 'codex', {
      enabled: true, revision: 1, repositoryScope: 'repo/one', publicationName: 'skill-one'
    })
    await storageServiceClient.skills.repairCodexProjection('skill/1', {
      repositoryScope: 'repo/one', expectedRevision: 1, expectedDigest: 'sha256:one'
    })
    await storageServiceClient.skills.archive('skill/1')
    await storageServiceClient.skills.restore('skill/1')

    expect(fetchMock.mock.calls.map(call => [call[0], call[1]?.method, call[1]?.body])).toEqual([
      ['/storage-api/skill-package-inspections/folder', 'POST', JSON.stringify({ path: 'F:\\skills\\one' })],
      ['/storage-api/skill-package-imports', 'POST', JSON.stringify({ inspectionId: 'inspect-1', operation: 'create', skill: { originLabel: 'one' } })],
      ['/storage-api/skill-hosts', undefined, undefined],
      ['/storage-api/skills/skill%2F1/revisions/1/review', 'POST', JSON.stringify({ expectedDigest: 'sha256:one', decision: 'trusted' })],
      ['/storage-api/skills/skill%2F1/host-pins/local-agent', 'PUT', JSON.stringify({ enabled: true, revision: 1 })],
      ['/storage-api/skills/skill%2F1/host-pins/codex', 'PUT', JSON.stringify({ enabled: true, revision: 1, repositoryScope: 'repo/one', publicationName: 'skill-one' })],
      ['/storage-api/skills/skill%2F1/host-pins/codex/repair', 'POST', JSON.stringify({ repositoryScope: 'repo/one', expectedRevision: 1, expectedDigest: 'sha256:one' })],
      ['/storage-api/skills/skill%2F1/archive', 'POST', undefined],
      ['/storage-api/skills/skill%2F1/restore', 'POST', undefined]
    ])
  })

  test('reports request timeouts', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))

    const request = expect(storageServiceClient.projects.getAll()).rejects.toEqual(expect.objectContaining({
      name: 'StorageHttpError',
      code: 'timeout',
      status: 0
    }))
    await vi.advanceTimersByTimeAsync(10_000)

    await request
  })

  test('classifies a lifecycle-cancelled project update as an external abort', async () => {
    vi.useFakeTimers()
    const lifecycle = new AbortController()
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const pending = expect(storageServiceClient.projects.update(
      'project-1',
      3,
      { title: 'Latest' },
      { signal: lifecycle.signal }
    )).rejects.toMatchObject({
      name: 'StorageHttpError',
      code: 'request_aborted',
      status: 0
    })

    lifecycle.abort()
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
    expect(fetchMock).toHaveBeenCalledWith('/storage-api/projects/project-1', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ revision: 3, updates: { title: 'Latest' } })
    }))
  })

  test('infers image upload content type from the filename', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'asset.webp',
      filename: 'board.webp',
      contentType: 'image/webp',
      size: 3
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File([new Uint8Array([1, 2, 3])], 'board.webp')

    await storageServiceClient.assets.upload(file)

    expect(fetchMock).toHaveBeenCalledWith('/storage-api/assets', expect.objectContaining({
      method: 'POST',
      body: file,
      headers: expect.objectContaining({
        'Content-Type': 'image/webp',
        'X-File-Name': 'board.webp'
      })
    }))
  })

  test('allows asset uploads 30 seconds before timing out', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)

    const request = expect(storageServiceClient.assets.upload(
      new File([new Uint8Array([1, 2, 3])], 'board.png', { type: 'image/png' })
    )).rejects.toMatchObject({ code: 'timeout', status: 0 })

    await vi.advanceTimersByTimeAsync(10_000)
    const signal = fetchMock.mock.calls[0][1]?.signal
    expect(signal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(20_000)
    await request
  })

  test('combines an external abort signal and removes its listener and timeout after success', async () => {
    vi.useFakeTimers()
    const external = new AbortController()
    const addListener = vi.spyOn(external.signal, 'addEventListener')
    const removeListener = vi.spyOn(external.signal, 'removeEventListener')
    let fetchSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      fetchSignal = init?.signal || undefined
      return Promise.resolve(new Response(JSON.stringify({ runs: [], nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    }))

    await storageServiceClient.imageGenerationRuns.getPage({
      projectId: 'project-1', nodeId: 'node-1', signal: external.signal
    })

    expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
    external.abort()
    expect(fetchSignal?.aborted).toBe(false)
  })

  test('keeps the 10 second timeout active while composing an external signal', async () => {
    vi.useFakeTimers()
    const external = new AbortController()
    const addListener = vi.spyOn(external.signal, 'addEventListener')
    const removeListener = vi.spyOn(external.signal, 'removeEventListener')
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })))

    const pending = expect(storageServiceClient.imageGenerationRuns.getPage({
      projectId: 'project-1', nodeId: 'node-1', signal: external.signal
    })).rejects.toMatchObject({ code: 'timeout', status: 0 })
    await vi.advanceTimersByTimeAsync(10_000)

    await pending
    expect(external.signal.aborted).toBe(false)
    expect(addListener).toHaveBeenCalled()
    expect(removeListener).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('imports official Seedream image formats as original and provider-ready assets', async () => {
    const payload = {
      originalAsset: { id: 'asset-original', filename: 'board.gif', contentType: 'image/gif', size: 3 },
      previewAsset: { id: 'asset-preview', filename: 'board.png', contentType: 'image/png', size: 4 },
      providerInputAsset: { id: 'asset-provider', filename: 'board.png', contentType: 'image/png', size: 4 },
      width: 64,
      height: 64
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['gif'], 'board.gif', { type: 'image/gif' })

    await expect(storageServiceClient.imageAssets.import(file)).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith('/storage-api/image-assets/import', expect.objectContaining({
      method: 'POST',
      body: file,
      headers: expect.objectContaining({
        'Content-Type': 'image/gif',
        'X-File-Name': 'board.gif'
      })
    }))
  })

  test('records a permanent annotation-flattened asset derivation', async () => {
    const payload = {
      id: 'derivation-1',
      sourceAssetId: 'asset-source',
      derivedAssetId: 'asset-flattened',
      kind: 'annotation-flattened',
      transform: { format: 'png' },
      annotationDocument: { version: 1, marks: [] },
      createdAt: 1
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(storageServiceClient.imageAssets.createDerivation({
      sourceAssetId: 'asset-source',
      derivedAssetId: 'asset-flattened',
      kind: 'annotation-flattened',
      transform: { format: 'png' },
      annotationDocument: { version: 1, marks: [] }
    })).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith('/storage-api/image-assets/derivations', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        sourceAssetId: 'asset-source',
        derivedAssetId: 'asset-flattened',
        kind: 'annotation-flattened',
        transform: { format: 'png' },
        annotationDocument: { version: 1, marks: [] }
      })
    }))
    expect(Reflect.has(storageServiceClient.imageAssets, 'delete')).toBe(false)
  })

  test('sends one atomic Recent Capture registration request', async () => {
    const payload = { presets: [{ id: 'preset-1' }], captures: [{ id: 'capture-1' }] }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(storageServiceClient.recentCaptures.registerToPromptLibrary({
      mode: 'separate',
      captures: [{ id: 'capture-1', revision: 2, label: 'Hero', content: 'A hero', type: 'subject' }]
    })).resolves.toEqual(payload)

    expect(fetchMock).toHaveBeenCalledWith(
      '/storage-api/recent-captures/register-to-prompt-library',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          mode: 'separate',
          captures: [{ id: 'capture-1', revision: 2, label: 'Hero', content: 'A hero', type: 'subject' }]
        })
      })
    )
  })

  test('deletes one Recent Capture with optimistic revision checking', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    const deleteCapture = Reflect.get(storageServiceClient.recentCaptures, 'delete') as
      | ((id: string, revision: number) => Promise<void>)
      | undefined
    expect(deleteCapture).toBeTypeOf('function')
    if (!deleteCapture) return

    await deleteCapture('capture/one', 3)

    expect(fetchMock).toHaveBeenCalledWith(
      '/storage-api/recent-captures/capture%2Fone',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ revision: 3 })
      })
    )
  })

  test('lists and trashes storage artifacts through the storage lifecycle API', async () => {
    const artifact = {
      assetId: 'asset/one', familyAssetIds: ['asset/one'], category: 'generated-content',
      status: 'active', title: 'Generated.png', contentType: 'image/png', mediaType: 'image',
      sizeBytes: 12, createdAt: 1, trashedAt: null, referenceCount: 0,
      previewUrl: '/storage-api/assets/asset%2Fone'
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ artifacts: [artifact], nextCursor: null }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ artifacts: [{ ...artifact, status: 'trash' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(storageServiceClient.storageArtifacts.getPage({
      category: 'generated-content', status: 'active', mediaType: 'image', query: 'Generated',
      sort: 'size-desc', limit: 25
    })).resolves.toEqual({ artifacts: [artifact], nextCursor: null })
    await storageServiceClient.storageArtifacts.trash(['asset/one'])

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/storage-api/storage/artifacts?category=generated-content&status=active&mediaType=image&query=Generated&sort=size-desc&limit=25'
    )
    expect(fetchMock.mock.calls[1]).toEqual([
      '/storage-api/storage/artifacts/trash',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ ids: ['asset/one'], deletedBy: 'user' }) })
    ])
  })

  test('pages permanent image generation history by project and node without a delete API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runs: [{
        id: 'run-1', projectId: 'project/1', nodeId: 'node 1', connectionId: 'connection-1',
        providerId: 'volcengine', modelId: 'seedream', state: 'failed', createdAt: 1,
        requestSnapshot: {
          mode: 'generate', resolution: '2K', aspectRatio: '16:9', width: 2048, height: 1152,
          promptOptimization: 'fast',
          outputFormat: 'png', watermark: false,
          promptDocument: { version: 1, segments: [{ type: 'text', text: 'Prompt' }] },
          inputAssets: [{
            referenceId: 'reference-1',
            role: 'source-image',
            assetId: 'asset-derived',
            sourceAssetId: 'asset-original',
            order: 0
          }],
          regions: [],
          operation: {
            operation: 'multi-view',
            recipeId: 'multi-view/default',
            recipeVersion: '1',
            source: {
              nodeId: 'node 1',
              originalAssetId: 'asset-original',
              canvasAssetId: 'asset-derived',
              providerAssetId: 'asset-provider'
            },
            preservationIntents: ['identity', 'style'],
            parameters: {
              viewCount: 5,
              views: ['front', 'left', 'rear']
            },
            operationGroupId: 'group-1',
            operationItemId: 'item-front',
            viewSpec: 'front'
          },
          remoteUrl: 'https://provider.example/output'
        },
        outputAssetIds: [],
        error: { code: 'failed', message: 'Safe failure', retryable: false },
        secret: 'raw-secret'
      }],
      nextCursor: 'next-page'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await storageServiceClient.imageGenerationRuns.getPage({
      projectId: 'project/1', nodeId: 'node 1', cursor: 'cursor/1', limit: 25
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/storage-api/image-generation-runs?projectId=project%2F1&nodeId=node+1&cursor=cursor%2F1&limit=25',
      expect.any(Object)
    )
    expect(page.nextCursor).toBe('next-page')
    expect(page.runs[0].requestSnapshot).toMatchObject({
      aspectRatio: '16:9',
      width: 2048,
      height: 1152,
      promptOptimization: 'fast',
      inputAssets: [{
        referenceId: 'reference-1',
        role: 'source-image',
        assetId: 'asset-derived',
        sourceAssetId: 'asset-original',
        order: 0
      }],
      operation: {
        operation: 'multi-view',
        recipeId: 'multi-view/default',
        recipeVersion: '1',
        source: {
          nodeId: 'node 1',
          originalAssetId: 'asset-original',
          canvasAssetId: 'asset-derived',
          providerAssetId: 'asset-provider'
        },
        preservationIntents: ['identity', 'style'],
        parameters: {
          viewCount: 5,
          views: ['front', 'left', 'rear']
        },
        operationGroupId: 'group-1',
        operationItemId: 'item-front',
        viewSpec: 'front'
      }
    })
    expect(JSON.stringify(page)).not.toContain('provider.example')
    expect(JSON.stringify(page)).not.toContain('raw-secret')
    expect(Reflect.has(storageServiceClient.imageGenerationRuns, 'delete')).toBe(false)
  })

  test('requires project scope for every image generation history query', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      runs: [], nextCursor: null
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)

    await storageServiceClient.imageGenerationRuns.getPage({ projectId: 'project/1', limit: 10 })
    await storageServiceClient.imageGenerationRuns.getPage({ projectId: 'project/1', nodeId: 'node 1' })
    await storageServiceClient.imageGenerationRuns.getPage({
      projectId: 'project/1', conversationId: 'conversation 1'
    })

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/storage-api/image-generation-runs?projectId=project%2F1&limit=10',
      '/storage-api/image-generation-runs?projectId=project%2F1&nodeId=node+1',
      '/storage-api/image-generation-runs?projectId=project%2F1&conversationId=conversation+1'
    ])
  })

  test('pages project-scoped image generation conversations without exposing delete', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      conversations: [{
        id: 'conversation-1', projectId: 'project/1', title: '玻璃灯塔', createdAt: 1, updatedAt: 2,
        latestRunId: 'run-1', latestState: 'succeeded', previewAssetId: 'asset-1', turnCount: 1,
        secret: 'must-not-survive'
      }],
      nextCursor: 'next/page'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await storageServiceClient.imageGenerationConversations.getPage({
      projectId: 'project/1', cursor: 'cursor/1', limit: 20
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/storage-api/image-generation-conversations?projectId=project%2F1&cursor=cursor%2F1&limit=20',
      expect.any(Object)
    )
    expect(page).toEqual({
      conversations: [{
        id: 'conversation-1', projectId: 'project/1', title: '玻璃灯塔', createdAt: 1, updatedAt: 2,
        latestRunId: 'run-1', latestState: 'succeeded', previewAssetId: 'asset-1', turnCount: 1
      }],
      nextCursor: 'next/page'
    })
    expect(Reflect.has(storageServiceClient.imageGenerationConversations, 'delete')).toBe(false)
  })

  test('loads one conversation and its project-scoped chronological runs', async () => {
    const conversation = {
      id: 'conversation-1', projectId: 'project-1', title: '产品渲染', createdAt: 1, updatedAt: 2, turnCount: 1
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(conversation), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ runs: [], nextCursor: null }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(storageServiceClient.imageGenerationConversations.getById('conversation/1', 'project/1'))
      .resolves.toMatchObject({ id: 'conversation-1', projectId: 'project-1' })
    await expect(storageServiceClient.imageGenerationConversations.getRuns({
      conversationId: 'conversation/1', projectId: 'project/1', limit: 25
    })).resolves.toEqual({ runs: [], nextCursor: null })

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/storage-api/image-generation-conversations/conversation%2F1?projectId=project%2F1',
      '/storage-api/image-generation-conversations/conversation%2F1/runs?projectId=project%2F1&limit=25'
    ])
  })

  test('lists pending canvas placements and marks one placed without a delete API', async () => {
    const placement = {
      runId: 'run-1', projectId: 'project/1', conversationId: 'conversation-1', assetId: 'asset-1',
      state: 'pending', createdAt: 1, updatedAt: 1
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ placements: [placement] }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...placement, state: 'placed', canvasNodeId: 'image-node-1', updatedAt: 2
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(storageServiceClient.imageGenerationPlacements.getPending('project/1'))
      .resolves.toEqual([placement])
    await expect(storageServiceClient.imageGenerationPlacements.markPlaced('run/1', 'image-node-1'))
      .resolves.toMatchObject({ state: 'placed', canvasNodeId: 'image-node-1' })

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/storage-api/image-generation-placements?projectId=project%2F1&state=pending',
      '/storage-api/image-generation-placements/run%2F1'
    ])
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'PATCH', body: JSON.stringify({ state: 'placed', canvasNodeId: 'image-node-1' })
    })
    expect(Reflect.has(storageServiceClient.imageGenerationPlacements, 'delete')).toBe(false)
  })

  test('loads one permanent image generation run by id and returns null when missing', async () => {
    const run = {
      id: 'run-1', projectId: 'project-1', nodeId: 'node-1', connectionId: 'connection-1',
      providerId: 'volcengine', modelId: 'seedream', state: 'succeeded', createdAt: 1,
      requestSnapshot: {
        mode: 'generate', resolution: '1K', aspectRatio: '1:1', outputFormat: 'png', watermark: false,
        promptOptimization: 'standard',
        promptDocument: { version: 1, segments: [] }, inputAssets: [], regions: []
      },
      outputAssetIds: ['asset-1']
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(run), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: { code: 'not_found' } }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(storageServiceClient.imageGenerationRuns.getById('run/1', 'project/1'))
      .resolves.toMatchObject({ id: 'run-1' })
    await expect(storageServiceClient.imageGenerationRuns.getById('missing', 'project/1')).resolves.toBeNull()
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/storage-api/image-generation-runs/run%2F1?projectId=project%2F1',
      '/storage-api/image-generation-runs/missing?projectId=project%2F1'
    ])
  })
})

const jsonResponse = (payload: unknown): Response => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'Content-Type': 'application/json' }
})

const contextPackInspection = () => ({
  cvcCode: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ',
  projectCode: 'PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectRevision: 7,
  createdAt: 9,
  creator: 'promptcard-ui',
  entries: [{
    reference: { namespace: 'canvasTemplate' as const, code: 'CVT-01ARZ3NDEKTSV4RRFFQ69G5FAW' },
    content: '{"kind":"text","text":"First content","title":"First","truncated":false}',
    contentDigest: `sha256:${'a'.repeat(64)}`
  }],
  sourceCodes: [],
  sourceBoundaries: [{
    nodeCode: 'CVT-01ARZ3NDEKTSV4RRFFQ69G5FAW',
    promptLibraryReferences: [],
    canvasMediaReferences: []
  }],
  placementHint: {
    mode: 'after-selection' as const,
    anchorNodeCodes: ['CVT-01ARZ3NDEKTSV4RRFFQ69G5FAW']
  },
  snapshotDigest: `sha256:${'b'.repeat(64)}`,
  revokedAt: null,
  revokedBy: null,
  revocationReason: null
})
