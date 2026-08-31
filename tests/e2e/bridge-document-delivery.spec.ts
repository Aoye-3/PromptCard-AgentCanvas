import { createHash } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const storageUrl = 'http://127.0.0.1:38102'
const gatewayUrl = 'http://127.0.0.1:38101/api/promptcard/bridge/v3'
const bridgeToken = process.env.PROMPTCARD_E2E_BRIDGE_TOKEN || ''
const bridgePhase = process.env.PROMPTCARD_E2E_BRIDGE_PHASE || ''
const restartStatePath = resolve('tests/.runtime/bridge-document-restart-state.json')

interface StoredDocumentInline {
  text?: string
}

interface StoredDocumentBlock {
  content?: StoredDocumentInline[]
}

interface StoredDocument {
  revision: number
  digest: string
  blocks: StoredDocumentBlock[]
  suggestions: unknown[]
}

interface StoredCanvasNode {
  id: string
  kind: string
  title: string
  referenceCode: string
  document?: StoredDocument
  sequence?: StoredStoryboardSequence
  source?: StoredStoryboardSource
  pendingFieldChanges?: StoredStoryboardFieldChange[]
  revision?: number
  digest?: string
  meta: Record<string, unknown>
}

interface StoredDocumentNode extends StoredCanvasNode {
  kind: 'document'
  document: StoredDocument
}

interface StoredStoryboardRow {
  id: string
  camera: string
}

interface StoredStoryboardSequence {
  rows: StoredStoryboardRow[]
}

interface StoredStoryboardSource {
  documentNodeId: string
  documentRevision: number
  documentDigest: string
}

interface StoredStoryboardFieldChange {
  scope: 'sequence' | 'row'
  field: string
  previousValue: string
  newValue: string
}

interface StoredStoryboardNode extends StoredCanvasNode {
  kind: 'storyboard'
  sequence: StoredStoryboardSequence
  source: StoredStoryboardSource
  pendingFieldChanges: StoredStoryboardFieldChange[]
  revision: number
  digest: string
}

interface StoredProject {
  revision: number
  freeCanvas: {
    nodes: StoredCanvasNode[]
  }
}

interface RestartState {
  fixture: Awaited<ReturnType<typeof createProjectFixture>>
  sourceCvc: string
  documentCvc: string
  documentNodeId: string
  documentCode: string
  createRequest: ReturnType<typeof documentCreateRequest>
  commitRequest: {
    clientRequestId: string
    normalizedRequestDigest: string
    proposalId: string
  }
  storyboardCvc: string
  storyboardNodeId: string
  storyboardCode: string
  storyboardTitle: string
  storyboardCreateRequest: Record<string, unknown>
  storyboardCreateCommitRequest: {
    clientRequestId: string
    normalizedRequestDigest: string
    proposalId: string
  }
  storyboardChangeRequest: Record<string, unknown>
  storyboardChangeCommitRequest: {
    clientRequestId: string
    normalizedRequestDigest: string
    proposalId: string
  }
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

test('real Gateway creates and changes a reviewed Document without duplicate application', async ({ context, page, request }) => {
  test.skip(!bridgeToken, 'Run through npm run test:e2e:bridge so the real Gateway profile is configured.')
  test.skip(Boolean(bridgePhase), 'The restart runner uses the dedicated prepare/recover tests.')

  const fixture = await createProjectFixture(request)
  const contextCodes: string[] = []
  page.on('dialog', dialog => dialog.accept())

  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openProject(page, fixture.id, fixture.title)
    const firstCvc = await createContextPack(page, request, fixture.id, fixture.sourceCode)
    contextCodes.push(firstCvc)

    const runtime = await bridgeGet(request, '/runtime')
    expect(runtime.contractVersion).toBe('3.0.0')
    expect(runtime.bootstrapSkill.name).toBe('promptcard-bootstrap')
    const workspace = await bridgeGet(
      request,
      `/workspace?projectCode=${fixture.projectCode}&cvcCode=${firstCvc}`
    )
    expect(workspace.projectCode).toBe(fixture.projectCode)
    expect(workspace.cvcCode).toBe(firstCvc)

    const createRequest = {
      clientRequestId: `${fixture.id}-document-create-preview`,
      normalizedRequestDigest: digest(`${fixture.id}:document-create-preview`),
      kind: 'document.create',
      target: { cvcCode: firstCvc },
      sourceCodes: [fixture.sourceCode],
      skillPins: [],
      rationale: 'Turn the selected script note into a reviewable Document.',
      provenance: 'promptcard-bridge',
      payload: {
        title: 'Bridge-reviewed script',
        blocks: [{
          id: 'opening',
          type: 'paragraph',
          content: [{ text: 'A rainy opening.' }]
        }]
      }
    }
    const createPreview = await bridgePost(request, '/delivery/preview', createRequest)
    const createCommitRequest = {
      clientRequestId: `${fixture.id}-document-create-commit`,
      normalizedRequestDigest: digest(`${fixture.id}:document-create-commit`),
      proposalId: createPreview.proposalId
    }
    const createCommit = await bridgePost(request, '/delivery/commit', createCommitRequest)
    expect(createCommit.state).toBe('pending_review')

    await reviewPendingDocument(page, 'Bridge-reviewed script')
    const projectAfterCreate = await getProject(request, fixture.id)
    const createdNode = requiredDocumentNode(projectAfterCreate, 'Bridge-reviewed script')
    expect(createdNode.referenceCode).toMatch(/^CVD-/)
    expect(documentText(createdNode.document)).toBe('A rainy opening.')

    const replayPreview = await bridgePost(request, '/delivery/preview', createRequest)
    expect(replayPreview.proposalId).toBe(createPreview.proposalId)
    expect(replayPreview.disposition).toBe('replay')
    const replayCommit = await bridgePost(request, '/delivery/commit', createCommitRequest)
    expect(replayCommit.state).toBe('accepted')
    expect((await getProject(request, fixture.id)).freeCanvas.nodes.filter(
      (node: Record<string, unknown>) => node.referenceCode === createdNode.referenceCode
    )).toHaveLength(1)

    const changeCvc = await createContextPack(page, request, fixture.id, createdNode.referenceCode)
    contextCodes.push(changeCvc)
    const changeWorkspace = await bridgeGet(
      request,
      `/workspace?projectCode=${fixture.projectCode}&cvcCode=${changeCvc}`
    )
    expect(changeWorkspace.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: { namespace: 'canvasDocument', code: createdNode.referenceCode } })
    ]))

    const originalText = 'A rainy opening.'
    const replacementText = 'A stormy opening.'
    const changeRequest = {
      clientRequestId: `${fixture.id}-document-change-preview`,
      normalizedRequestDigest: digest(`${fixture.id}:document-change-preview`),
      kind: 'document.change',
      target: {
        cvcCode: changeCvc,
        documentCode: createdNode.referenceCode,
        baseRevision: createdNode.document.revision,
        baseDigest: createdNode.document.digest
      },
      sourceCodes: [createdNode.referenceCode],
      skillPins: [],
      rationale: 'Clarify the opening while preserving tracked review.',
      provenance: 'promptcard-bridge',
      payload: {
        operations: [{
          kind: 'replace',
          blockId: 'opening',
          utf8Start: 0,
          utf8End: Buffer.byteLength(originalText, 'utf8'),
          text: replacementText,
          expectedTextDigest: digest(originalText)
        }]
      }
    }
    const changePreview = await bridgePost(request, '/delivery/preview', changeRequest)
    const changeCommitRequest = {
      clientRequestId: `${fixture.id}-document-change-commit`,
      normalizedRequestDigest: digest(`${fixture.id}:document-change-commit`),
      proposalId: changePreview.proposalId
    }
    await bridgePost(request, '/delivery/commit', changeCommitRequest)
    await reviewPendingDocument(page, `修改文档 ${createdNode.referenceCode}`)

    const projectWithSuggestion = await getProject(request, fixture.id)
    const changedNode = requiredDocumentNode(projectWithSuggestion, 'Bridge-reviewed script')
    expect(changedNode.document.suggestions.length).toBeGreaterThan(0)
    expect(documentText(changedNode.document)).toBe(replacementText)
    const changedNodeUi = page.locator(`.react-flow__node[data-id="${createdNode.id}"]`)
    await expect(changedNodeUi.locator('[data-document-suggestion-kind="insert"]')).toBeVisible()
    await expect(changedNodeUi.locator('[data-document-suggestion-kind="delete"]')).toBeVisible()
    await changedNodeUi.getByRole('button', { name: '全部接受修订' }).click()
    await expect.poll(async () => {
      const saved = requiredDocumentNode(await getProject(request, fixture.id), 'Bridge-reviewed script')
      return { text: documentText(saved.document), suggestions: saved.document.suggestions.length }
    }).toEqual({ text: replacementText, suggestions: 0 })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await openProject(page, fixture.id, fixture.title, false)
    const restoredNode = page.locator(`.react-flow__node[data-id="${createdNode.id}"]`)
    await expect(restoredNode).toContainText(replacementText)
    const finalProject = await getProject(request, fixture.id)
    expect(finalProject.freeCanvas.nodes.filter(
      (node: Record<string, unknown>) => node.referenceCode === createdNode.referenceCode
    )).toHaveLength(1)
    const status = await bridgeGet(
      request,
      `/delivery/status?clientRequestId=${encodeURIComponent(changeCommitRequest.clientRequestId)}`
    )
    expect(status.state).toBe('accepted')
    expect(status.resultCodes).toEqual([createdNode.referenceCode])
  } finally {
    if (!page.isClosed()) {
      for (const code of contextCodes) await revokeContext(request, code)
      await deleteProjectFixture(request, fixture.id)
    }
  }
})

test('real Gateway creates and changes a native Storyboard with field review and replay', async ({ context, page, request }) => {
  test.skip(!bridgeToken, 'Run through npm run test:e2e:bridge so the real Gateway profile is configured.')
  test.skip(Boolean(bridgePhase), 'The restart runner uses the dedicated prepare/recover tests.')

  const fixture = await createProjectFixture(request)
  const contextCodes: string[] = []
  const dialogMessages: string[] = []
  page.on('dialog', dialog => {
    dialogMessages.push(dialog.message())
    void dialog.accept()
  })

  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openProject(page, fixture.id, fixture.title)
    const sourceCvc = await createContextPack(page, request, fixture.id, fixture.sourceCode)
    contextCodes.push(sourceCvc)

    const documentRequest = documentCreateRequest(fixture, sourceCvc, 'storyboard-source')
    const documentPreview = await bridgePost(request, '/delivery/preview', documentRequest)
    await bridgePost(request, '/delivery/commit', {
      clientRequestId: `${fixture.id}-storyboard-source-document-commit`,
      normalizedRequestDigest: digest(`${fixture.id}:storyboard-source-document-commit`),
      proposalId: documentPreview.proposalId
    })
    await reviewPendingDocument(page, documentRequest.payload.title)
    const documentNode = requiredDocumentNode(
      await getProject(request, fixture.id), documentRequest.payload.title
    )

    const documentCvc = await createContextPack(page, request, fixture.id, documentNode.referenceCode)
    contextCodes.push(documentCvc)
    const createRequest = {
      clientRequestId: `${fixture.id}-storyboard-create-preview`,
      normalizedRequestDigest: digest(`${fixture.id}:storyboard-create-preview`),
      kind: 'storyboard.create',
      target: { cvcCode: documentCvc },
      sourceCodes: [documentNode.referenceCode],
      skillPins: [],
      rationale: 'Turn the accepted Document into a reviewable Storyboard.',
      provenance: 'promptcard-bridge',
      payload: {
        title: 'Bridge-reviewed storyboard',
        sourceDocumentCode: documentNode.referenceCode,
        sourceDocumentRevision: documentNode.document.revision,
        sourceDocumentDigest: documentNode.document.digest,
        sequence: {
          name: 'Opening sequence', description: 'Rainy reveal', style: 'Naturalistic', constraints: 'No dialogue',
          rows: [{
            cutLabel: '1', timeRange: '00:00-00:04', subject: 'Empty street', action: 'Rain falls',
            scene: 'Night exterior', camera: 'Wide', lighting: 'Neon reflections', audio: 'Rain', duration: '4s'
          }]
        }
      }
    }
    const createPreview = await bridgePost(request, '/delivery/preview', createRequest)
    const createCommitRequest = {
      clientRequestId: `${fixture.id}-storyboard-create-commit`,
      normalizedRequestDigest: digest(`${fixture.id}:storyboard-create-commit`),
      proposalId: createPreview.proposalId
    }
    await bridgePost(request, '/delivery/commit', createCommitRequest)
    try {
      await reviewPendingStoryboard(page, createRequest.payload.title, dialogMessages)
    } catch (error) {
      const diagnosticProject = await getProject(request, fixture.id)
      const diagnosticNode = diagnosticProject.freeCanvas.nodes.find(node => node.kind === 'storyboard')
      throw new Error(`${String(error)} storedStoryboard=${JSON.stringify(diagnosticNode)}`)
    }

    const created = requiredStoryboardNode(
      await getProject(request, fixture.id), createRequest.payload.title
    )
    expect(created.referenceCode).toMatch(/^CVS-/)
    expect(created.source).toMatchObject({
      documentNodeId: documentNode.id,
      documentRevision: documentNode.document.revision,
      documentDigest: documentNode.document.digest
    })
    expect(created.pendingFieldChanges).toEqual([])
    expect(created.sequence.rows[0].camera).toBe('Wide')

    const replayPreview = await bridgePost(request, '/delivery/preview', createRequest)
    expect(replayPreview.proposalId).toBe(createPreview.proposalId)
    expect(replayPreview.disposition).toBe('replay')
    const replayCommit = await bridgePost(request, '/delivery/commit', createCommitRequest)
    expect(replayCommit.state).toBe('accepted')
    expect((await getProject(request, fixture.id)).freeCanvas.nodes.filter(
      node => node.referenceCode === created.referenceCode
    )).toHaveLength(1)

    const storyboardCvc = await createContextPack(page, request, fixture.id, created.referenceCode)
    contextCodes.push(storyboardCvc)
    const workspace = await bridgeGet(
      request,
      `/workspace?projectCode=${fixture.projectCode}&cvcCode=${storyboardCvc}`
    )
    expect(workspace.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: { namespace: 'canvasStoryboard', code: created.referenceCode } })
    ]))

    const changeRequest = {
      clientRequestId: `${fixture.id}-storyboard-change-preview`,
      normalizedRequestDigest: digest(`${fixture.id}:storyboard-change-preview`),
      kind: 'storyboard.change',
      target: {
        cvcCode: storyboardCvc,
        storyboardCode: created.referenceCode,
        baseRevision: created.revision,
        baseDigest: created.digest
      },
      sourceCodes: [created.referenceCode],
      skillPins: [],
      rationale: 'Tighten the first shot while preserving field review.',
      provenance: 'promptcard-bridge',
      payload: {
        changes: [{ scope: 'row', rowOrdinal: 0, field: 'camera', value: 'Close-up' }]
      }
    }
    const changePreview = await bridgePost(request, '/delivery/preview', changeRequest)
    const changeCommitRequest = {
      clientRequestId: `${fixture.id}-storyboard-change-commit`,
      normalizedRequestDigest: digest(`${fixture.id}:storyboard-change-commit`),
      proposalId: changePreview.proposalId
    }
    await bridgePost(request, '/delivery/commit', changeCommitRequest)
    await reviewPendingStoryboard(page, `修改分镜 ${created.referenceCode}`, dialogMessages)

    const pending = requiredStoryboardNode(
      await getProject(request, fixture.id), createRequest.payload.title
    )
    expect(pending.sequence.rows[0].camera).toBe('Wide')
    expect(pending.pendingFieldChanges).toEqual([
      expect.objectContaining({
        scope: 'row', field: 'camera', previousValue: 'Wide', newValue: 'Close-up'
      })
    ])
    const storyboardUi = page.locator(`.react-flow__node[data-id="${created.id}"]`)
    await expect(storyboardUi.getByText('Wide', { exact: true })).toBeVisible()
    await expect(storyboardUi.getByText('Close-up', { exact: true })).toBeVisible()
    await storyboardUi.getByRole('button', { name: '接受 camera 修改' }).click()
    await expect.poll(async () => {
      const saved = requiredStoryboardNode(
        await getProject(request, fixture.id), createRequest.payload.title
      )
      return { camera: saved.sequence.rows[0].camera, pending: saved.pendingFieldChanges.length }
    }).toEqual({ camera: 'Close-up', pending: 0 })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await openProject(page, fixture.id, fixture.title, false)
    await expect(page.locator(`.react-flow__node[data-id="${created.id}"]`)).toContainText('Close-up')
    const status = await bridgeGet(
      request,
      `/delivery/status?clientRequestId=${encodeURIComponent(changeCommitRequest.clientRequestId)}`
    )
    expect(status.state).toBe('accepted')
    expect(status.resultCodes).toEqual([created.referenceCode])
    expect((await getProject(request, fixture.id)).freeCanvas.nodes.filter(
      node => node.referenceCode === created.referenceCode
    )).toHaveLength(1)
  } finally {
    if (!page.isClosed()) {
      for (const code of contextCodes) await revokeContext(request, code)
      await deleteProjectFixture(request, fixture.id)
    }
  }
})

test('prepare accepted Document and pending Storyboard change for process restart recovery', async ({ context, page, request }) => {
  test.skip(bridgePhase !== 'prepare', 'Only the restart acceptance prepare phase runs this test.')
  const fixture = await createProjectFixture(request)
  const dialogMessages: string[] = []
  page.on('dialog', dialog => {
    dialogMessages.push(dialog.message())
    void dialog.accept()
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openProject(page, fixture.id, fixture.title)
  const sourceCvc = await createContextPack(page, request, fixture.id, fixture.sourceCode)
  const createRequest = documentCreateRequest(fixture, sourceCvc, 'restart')
  const createPreview = await bridgePost(request, '/delivery/preview', createRequest)
  const commitRequest = {
    clientRequestId: `${fixture.id}-restart-document-create-commit`,
    normalizedRequestDigest: digest(`${fixture.id}:restart-document-create-commit`),
    proposalId: createPreview.proposalId
  }
  await bridgePost(request, '/delivery/commit', commitRequest)
  await reviewPendingDocument(page, createRequest.payload.title)
  const stored = await getProject(request, fixture.id)
  const documentNode = requiredDocumentNode(stored, createRequest.payload.title)
  const documentCvc = await createContextPack(page, request, fixture.id, documentNode.referenceCode)

  const storyboardTitle = 'Restart-safe storyboard'
  const storyboardCreateRequest = {
    clientRequestId: `${fixture.id}-restart-storyboard-create-preview`,
    normalizedRequestDigest: digest(`${fixture.id}:restart-storyboard-create-preview`),
    kind: 'storyboard.create',
    target: { cvcCode: documentCvc },
    sourceCodes: [documentNode.referenceCode],
    skillPins: [],
    rationale: 'Create a Storyboard whose review state survives a process restart.',
    provenance: 'promptcard-bridge',
    payload: {
      title: storyboardTitle,
      sourceDocumentCode: documentNode.referenceCode,
      sourceDocumentRevision: documentNode.document.revision,
      sourceDocumentDigest: documentNode.document.digest,
      sequence: {
        name: 'Restart sequence', description: 'Durable rain reveal', style: 'Naturalistic', constraints: 'No dialogue',
        rows: [{
          cutLabel: '1', timeRange: '00:00-00:04', subject: 'Empty street', action: 'Rain falls',
          scene: 'Night exterior', camera: 'Wide', lighting: 'Neon reflections', audio: 'Rain', duration: '4s'
        }]
      }
    }
  }
  const storyboardCreatePreview = await bridgePost(request, '/delivery/preview', storyboardCreateRequest)
  const storyboardCreateCommitRequest = {
    clientRequestId: `${fixture.id}-restart-storyboard-create-commit`,
    normalizedRequestDigest: digest(`${fixture.id}:restart-storyboard-create-commit`),
    proposalId: storyboardCreatePreview.proposalId
  }
  await bridgePost(request, '/delivery/commit', storyboardCreateCommitRequest)
  await reviewPendingStoryboard(page, storyboardTitle, dialogMessages)
  const storyboardNode = requiredStoryboardNode(await getProject(request, fixture.id), storyboardTitle)
  const storyboardCvc = await createContextPack(page, request, fixture.id, storyboardNode.referenceCode)
  const storyboardChangeRequest = {
    clientRequestId: `${fixture.id}-restart-storyboard-change-preview`,
    normalizedRequestDigest: digest(`${fixture.id}:restart-storyboard-change-preview`),
    kind: 'storyboard.change',
    target: {
      cvcCode: storyboardCvc,
      storyboardCode: storyboardNode.referenceCode,
      baseRevision: storyboardNode.revision,
      baseDigest: storyboardNode.digest
    },
    sourceCodes: [storyboardNode.referenceCode],
    skillPins: [],
    rationale: 'Keep this field-level change pending across restart.',
    provenance: 'promptcard-bridge',
    payload: { changes: [{ scope: 'row', rowOrdinal: 0, field: 'camera', value: 'Close-up' }] }
  }
  const storyboardChangePreview = await bridgePost(request, '/delivery/preview', storyboardChangeRequest)
  const storyboardChangeCommitRequest = {
    clientRequestId: `${fixture.id}-restart-storyboard-change-commit`,
    normalizedRequestDigest: digest(`${fixture.id}:restart-storyboard-change-commit`),
    proposalId: storyboardChangePreview.proposalId
  }
  const pendingChange = await bridgePost(request, '/delivery/commit', storyboardChangeCommitRequest)
  expect(pendingChange.state).toBe('pending_review')

  await writeFile(restartStatePath, JSON.stringify({
    fixture,
    sourceCvc,
    documentCvc,
    documentNodeId: documentNode.id,
    documentCode: documentNode.referenceCode,
    createRequest,
    commitRequest,
    storyboardCvc,
    storyboardNodeId: storyboardNode.id,
    storyboardCode: storyboardNode.referenceCode,
    storyboardTitle,
    storyboardCreateRequest,
    storyboardCreateCommitRequest,
    storyboardChangeRequest,
    storyboardChangeCommitRequest
  }, null, 2), 'utf8')
})

test('recovers Document and completes pending Storyboard review after real service restart', async ({ page, request }) => {
  test.skip(bridgePhase !== 'recover', 'Only the restart acceptance recovery phase runs this test.')
  const state = JSON.parse(await readFile(restartStatePath, 'utf8')) as RestartState
  try {
    const runtime = await bridgeGet(request, '/runtime')
    expect(runtime.contractVersion).toBe('3.0.0')
    const status = await bridgeGet(
      request,
      `/delivery/status?clientRequestId=${encodeURIComponent(state.commitRequest.clientRequestId)}`
    )
    expect(status.state).toBe('accepted')
    expect(status.resultCodes).toEqual([state.documentCode])
    expect(status.request.sourceCodes).toEqual([state.fixture.sourceCode])
    expect(status.request.skillPins).toEqual([])

    const replayPreview = await bridgePost(request, '/delivery/preview', state.createRequest)
    expect(replayPreview.proposalId).toBe(state.commitRequest.proposalId)
    expect(replayPreview.disposition).toBe('replay')
    const replayCommit = await bridgePost(request, '/delivery/commit', state.commitRequest)
    expect(replayCommit.state).toBe('accepted')

    const storyboardCreateStatus = await bridgeGet(
      request,
      `/delivery/status?clientRequestId=${encodeURIComponent(state.storyboardCreateCommitRequest.clientRequestId)}`
    )
    expect(storyboardCreateStatus.state).toBe('accepted')
    expect(storyboardCreateStatus.resultCodes).toEqual([state.storyboardCode])
    const pendingStoryboardStatus = await bridgeGet(
      request,
      `/delivery/status?clientRequestId=${encodeURIComponent(state.storyboardChangeCommitRequest.clientRequestId)}`
    )
    expect(pendingStoryboardStatus.state).toBe('pending_review')

    const workspace = await bridgeGet(
      request,
      `/workspace?projectCode=${state.fixture.projectCode}&cvcCode=${state.documentCvc}`
    )
    expect(workspace.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: { namespace: 'canvasDocument', code: state.documentCode } })
    ]))
    const storyboardWorkspace = await bridgeGet(
      request,
      `/workspace?projectCode=${state.fixture.projectCode}&cvcCode=${state.storyboardCvc}`
    )
    expect(storyboardWorkspace.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: { namespace: 'canvasStoryboard', code: state.storyboardCode } })
    ]))

    const stored = await getProject(request, state.fixture.id)
    const documents = stored.freeCanvas.nodes.filter(node => node.referenceCode === state.documentCode)
    expect(documents).toHaveLength(1)
    expect(documents[0].id).toBe(state.documentNodeId)
    expect(documents[0].meta.bridgeDocumentDelivery).toMatchObject({
      proposalId: state.commitRequest.proposalId,
      profileId: 'codex-e2e',
      cvcCode: state.sourceCvc,
      sourceCodes: [state.fixture.sourceCode],
      skillPins: []
    })
    const storyboards = stored.freeCanvas.nodes.filter(node => node.referenceCode === state.storyboardCode)
    expect(storyboards).toHaveLength(1)
    expect(storyboards[0]).toMatchObject({
      id: state.storyboardNodeId,
      kind: 'storyboard',
      meta: {
        bridgeStoryboardDelivery: expect.objectContaining({
          proposalId: state.storyboardCreateCommitRequest.proposalId,
          profileId: 'codex-e2e',
          sourceCodes: [state.documentCode]
        })
      }
    })

    await page.addInitScript(({ key, value }) => {
      globalThis.localStorage.setItem(key, value)
    }, {
      key: `promptcard:active-bridge-context:${state.fixture.id}`,
      value: state.storyboardCvc
    })
    await openProject(page, state.fixture.id, state.fixture.title)
    const restoredNode = page.locator(`.react-flow__node[data-id="${state.documentNodeId}"]`)
    await expect(restoredNode).toContainText('A rainy opening.')
    const dialogMessages: string[] = []
    page.on('dialog', dialog => {
      dialogMessages.push(dialog.message())
      void dialog.accept()
    })
    await reviewPendingStoryboard(page, `修改分镜 ${state.storyboardCode}`, dialogMessages)
    const storyboardUi = page.locator(`.react-flow__node[data-id="${state.storyboardNodeId}"]`)
    await expect(storyboardUi.getByText('Wide', { exact: true })).toBeVisible()
    await expect(storyboardUi.getByText('Close-up', { exact: true })).toBeVisible()
    await storyboardUi.getByRole('button', { name: '接受 camera 修改' }).click()
    await expect.poll(async () => {
      const saved = requiredStoryboardNode(await getProject(request, state.fixture.id), state.storyboardTitle)
      return { camera: saved.sequence.rows[0].camera, pending: saved.pendingFieldChanges.length }
    }).toEqual({ camera: 'Close-up', pending: 0 })

    const acceptedStoryboardStatus = await bridgeGet(
      request,
      `/delivery/status?clientRequestId=${encodeURIComponent(state.storyboardChangeCommitRequest.clientRequestId)}`
    )
    expect(acceptedStoryboardStatus.state).toBe('accepted')
    expect(acceptedStoryboardStatus.resultCodes).toEqual([state.storyboardCode])
    const createReplay = await bridgePost(request, '/delivery/preview', state.storyboardCreateRequest)
    expect(createReplay).toMatchObject({
      proposalId: state.storyboardCreateCommitRequest.proposalId,
      disposition: 'replay',
      state: 'previewed'
    })
    const createCommitReplay = await bridgePost(
      request, '/delivery/commit', state.storyboardCreateCommitRequest
    )
    expect(createCommitReplay).toMatchObject({
      state: 'accepted', resultCodes: [state.storyboardCode]
    })
    const changeReplay = await bridgePost(request, '/delivery/preview', state.storyboardChangeRequest)
    expect(changeReplay).toMatchObject({
      proposalId: state.storyboardChangeCommitRequest.proposalId,
      disposition: 'replay',
      state: 'previewed'
    })
    const changeCommitReplay = await bridgePost(
      request, '/delivery/commit', state.storyboardChangeCommitRequest
    )
    expect(changeCommitReplay).toMatchObject({
      state: 'accepted', resultCodes: [state.storyboardCode]
    })
    expect((await getProject(request, state.fixture.id)).freeCanvas.nodes.filter(
      node => node.referenceCode === state.storyboardCode
    )).toHaveLength(1)
  } finally {
    if (!page.isClosed()) {
      await revokeContext(request, state.documentCvc)
      await revokeContext(request, state.storyboardCvc)
      await revokeContext(request, state.sourceCvc)
      await deleteProjectFixture(request, state.fixture.id)
      await unlink(restartStatePath)
    }
  }
})

const bridgeHeaders = () => ({ authorization: `Bearer ${bridgeToken}` })

async function bridgeGet(request: APIRequestContext, path: string) {
  const response = await request.get(`${gatewayUrl}${path}`, { headers: bridgeHeaders() })
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}

async function bridgePost(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`${gatewayUrl}${path}`, { headers: bridgeHeaders(), data })
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}

async function createProjectFixture(request: APIRequestContext) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const id = `bridge-document-${suffix}`
  const title = `Bridge Document ${suffix}`
  const sourceNodeId = 'script-source'
  const response = await request.post(`${storageUrl}/api/projects`, {
    data: {
      id,
      title,
      type: 'free-canvas',
      pages: [],
      currentPage: 0,
      meta: {},
      freeCanvas: {
        nodes: [{
          id: sourceNodeId,
          kind: 'text',
          title: 'Script source',
          position: { x: 120, y: 120 },
          width: 420,
          height: 180,
          fontSize: 'large',
          segments: [{
            id: 'source-segment',
            source: 'user',
            text: 'EXT. STREET — RAIN — NIGHT',
            color: '#111827',
            createdAt: 1,
            updatedAt: 1
          }],
          meta: {}
        }],
        edges: [],
        selectedNodeId: sourceNodeId,
        viewport: { x: 0, y: 0, zoom: 1 },
        meta: {}
      }
    }
  })
  expect(response.ok(), await response.text()).toBe(true)
  const stored = await response.json()
  return {
    id,
    title,
    projectCode: stored.referenceCode as string,
    sourceNodeId,
    sourceCode: stored.freeCanvas.nodes[0].referenceCode as string
  }
}

async function openProject(page: Page, projectId: string, title: string, navigate = true) {
  if (navigate) await page.goto('/', { waitUntil: 'domcontentloaded' })
  const card = page.getByText(title, { exact: true }).locator('xpath=ancestor::article')
  const saveResponse = page.waitForResponse(response => (
    response.request().method() === 'PUT'
    && new URL(response.url()).pathname.endsWith(`/storage-api/projects/${projectId}`)
  ))
  await card.getByRole('button', { name: 'Open project' }).click()
  await saveResponse
  await expect(page.locator('[data-free-canvas-screen]')).toBeVisible()
}

async function createContextPack(
  page: Page,
  request: APIRequestContext,
  projectId: string,
  expectedCode: string
) {
  await page.getByRole('button', { name: '复制 Agent/MCP 上下文' }).click()
  const dialog = page.getByRole('dialog', { name: '复制 Agent/MCP 上下文' })
  await expect(dialog.getByRole('listitem')).toContainText(expectedCode)
  await expect.poll(async () => {
    const revision = (await getProject(request, projectId)).revision
    return (await dialog.innerText()).includes(`项目修订 ${revision}`)
  }).toBe(true)
  await dialog.getByRole('button', { name: '创建并复制 CVC' }).click()
  const code = await dialog.getByTestId('context-pack-code').innerText()
  expect(code).toMatch(/^CVC-/)
  await dialog.getByRole('button', { name: '关闭 Agent/MCP 上下文' }).click()
  return code
}

async function reviewPendingDocument(page: Page, title: string) {
  await page.getByRole('button', { name: '刷新外部 Agent 提案' }).click()
  const inbox = page.locator('[data-bridge-delivery-inbox]')
  await expect(inbox.getByText(title, { exact: true })).toBeVisible()
  await inbox.getByRole('button', { name: '接受外部 Agent 文档 提案' }).click()
  await expect(inbox.getByText(title, { exact: true })).toHaveCount(0)
}

async function reviewPendingStoryboard(page: Page, title: string, dialogMessages: string[]) {
  const refresh = page.getByRole('button', { name: '刷新外部 Agent 提案' })
  await expect(refresh).toBeVisible({ timeout: 15_000 })
  await refresh.click()
  const inbox = page.locator('[data-bridge-delivery-inbox]')
  await expect(inbox.getByText(title, { exact: true })).toBeVisible()
  await inbox.getByRole('button', { name: '接受外部 Agent 分镜 提案' }).click()
  try {
    await expect(inbox.getByText(title, { exact: true })).toHaveCount(0, { timeout: 30_000 })
  } catch {
    const errors = await inbox.getByRole('alert').allTextContents()
    throw new Error(`Storyboard review did not persist. dialogs=${JSON.stringify(dialogMessages)} errors=${JSON.stringify(errors)}`)
  }
}

async function getProject(request: APIRequestContext, id: string) {
  const response = await request.get(`${storageUrl}/api/projects/${id}`)
  expect(response.ok(), await response.text()).toBe(true)
  return response.json() as Promise<StoredProject>
}

function requiredDocumentNode(project: StoredProject, title: string): StoredDocumentNode {
  const node = project.freeCanvas.nodes.find((candidate): candidate is StoredDocumentNode => (
    candidate.kind === 'document' && candidate.title === title
  ))
  expect(node).toBeTruthy()
  return node
}

function requiredStoryboardNode(project: StoredProject, title: string): StoredStoryboardNode {
  const node = project.freeCanvas.nodes.find((candidate): candidate is StoredStoryboardNode => (
    candidate.kind === 'storyboard' && candidate.title === title
  ))
  expect(node).toBeTruthy()
  return node
}

function documentText(document: StoredDocument): string {
  return document.blocks.flatMap(block => block.content || [])
    .map(inline => inline.text || '').join('')
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function documentCreateRequest(
  fixture: Awaited<ReturnType<typeof createProjectFixture>>,
  cvcCode: string,
  suffix: string
) {
  return {
    clientRequestId: `${fixture.id}-${suffix}-document-create-preview`,
    normalizedRequestDigest: digest(`${fixture.id}:${suffix}:document-create-preview`),
    kind: 'document.create',
    target: { cvcCode },
    sourceCodes: [fixture.sourceCode],
    skillPins: [],
    rationale: 'Create a restart-safe reviewed Document.',
    provenance: 'promptcard-bridge',
    payload: {
      title: 'Restart-safe script',
      blocks: [{ id: 'opening', type: 'paragraph', content: [{ text: 'A rainy opening.' }] }]
    }
  }
}

async function revokeContext(request: APIRequestContext, code: string) {
  const response = await request.post(`${storageUrl}/api/context-packs/${code}/revoke`, {
    data: { actor: 'bridge-e2e', reason: 'test-cleanup' }
  })
  expect(response.ok(), await response.text()).toBe(true)
}

async function deleteProjectFixture(request: APIRequestContext, id: string) {
  const trash = await request.post(`${storageUrl}/api/projects/trash`, {
    data: { ids: [id], deletedBy: 'user', deleteReason: 'bridge-e2e-cleanup' }
  })
  expect(trash.ok(), await trash.text()).toBe(true)
  const removed = await request.delete(`${storageUrl}/api/projects/trash`, { data: { ids: [id] } })
  expect(removed.ok(), await removed.text()).toBe(true)
}
