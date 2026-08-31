import { createHash } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { completedPromptCardCalls, runRealCodexPrompt, type RealCodexRun } from './support/real-codex-host'

const storageUrl = 'http://127.0.0.1:38102'
const repositoryScope = 'real-codex-e2e'

interface StoredDocument {
  revision: number
  digest: string
  blocks: Array<{ content?: Array<{ text?: string }> }>
  suggestions: unknown[]
}

interface StoredNode {
  id: string
  kind: string
  title: string
  referenceCode: string
  document?: StoredDocument
  meta: Record<string, unknown>
}

interface StoredProject {
  revision: number
  freeCanvas: { nodes: StoredNode[] }
}

test.describe.configure({ mode: 'serial' })

test('real Codex creates and changes a reviewable Document through the packaged work environment', async ({
  context,
  page,
  request
}) => {
  test.skip(process.env.PROMPTCARD_REAL_CODEX_ACCEPTANCE !== '1', 'requires an explicit real Codex acceptance run')
  test.setTimeout(480_000)
  const fixture = await createFixture(request)
  const contextCodes: string[] = []
  page.on('dialog', dialog => void dialog.accept())

  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openProject(page, request, fixture.projectId, fixture.projectTitle)
    const cvcCode = await createContextPack(page, request, fixture.projectId, fixture.sourceCode)
    contextCodes.push(cvcCode)
    const title = `Codex reviewed script ${fixture.suffix}`
    const body = 'A creator waits beneath the rain as the last train leaves the platform.'
    const previewId = `${fixture.suffix}-document-create-preview`
    const commitId = `${fixture.suffix}-document-create-commit`
    const previewDigest = digest(previewId)
    const commitDigest = digest(commitId)

    const run = await runRealCodexPrompt([
      'You are a newly connected external creative Agent with no PromptCard internal-schema knowledge.',
      'Do not inspect repository files and do not use shell, browser, apps, plugins, or non-PromptCard tools.',
      `Work only in project ${fixture.projectCode} and context ${cvcCode}.`,
      'First follow the packaged environment: describe Runtime, describe Workspace, read every exact approved Skill pin,',
      `and resolve the exact source object ${fixture.sourceCode}.`,
      `Create exactly one review-only Document proposal titled “${title}”.`,
      `Its one paragraph block must have id “opening” and exact text “${body}”.`,
      `Use ${fixture.sourceCode} as the only source code and include the exact approved Skill pin from Workspace.`,
      `Use preview clientRequestId “${previewId}” with normalizedRequestDigest “${previewDigest}”.`,
      `After preview succeeds, commit that returned proposal using clientRequestId “${commitId}” and digest “${commitDigest}”.`,
      'Do not create any other proposal. Stop after commit reports pending review.'
    ].join(' '), 300_000)

    assertSuccessfulCalls(run, [
      'promptcard_runtime_describe',
      'promptcard_workspace_describe',
      'promptcard_skill_read',
      'promptcard_reference_resolve',
      'promptcard_delivery_preview',
      'promptcard_delivery_commit'
    ])
    expect(toolPayload(run, 'promptcard_delivery_commit')).toMatchObject({ state: 'pending_review' })

    await reviewPending(page, title, '接受外部 Agent 文档 提案')
    const project = await getProject(request, fixture.projectId)
    const documents = project.freeCanvas.nodes.filter(node => node.kind === 'document' && node.title === title)
    expect(documents).toHaveLength(1)
    expect(documents[0].referenceCode).toMatch(/^CVD-/)
    expect(documentText(documents[0].document!)).toBe(body)
    expect(documents[0].meta.bridgeDocumentDelivery).toEqual(expect.objectContaining({
      profileId: 'codex-e2e',
      cvcCode,
      sourceCodes: [fixture.sourceCode],
      skillPins: [expect.objectContaining({ skillCode: fixture.skillCode, revision: 1 })]
    }))

    const created = documents[0]
    const changeCvc = await createContextPack(page, request, fixture.projectId, created.referenceCode)
    contextCodes.push(changeCvc)
    const replacement = 'A filmmaker waits beneath the rain as the last train leaves the platform.'
    const changePreviewId = `${fixture.suffix}-document-change-preview`
    const changeCommitId = `${fixture.suffix}-document-change-commit`
    const changeRun = await runRealCodexPrompt([
      'You are a newly connected external creative Agent with no PromptCard internal-schema knowledge.',
      'Do not inspect repository files and do not use shell, browser, apps, plugins, or non-PromptCard tools.',
      `Work only in project ${fixture.projectCode} and context ${changeCvc}.`,
      'Follow the packaged environment: describe Runtime, describe Workspace, read every exact approved Skill pin,',
      `and resolve the exact accepted Document ${created.referenceCode}.`,
      `Create exactly one review-only change proposal that replaces the complete text in block “opening” with “${replacement}”.`,
      'Use the exact Document revision/digest returned by Workspace or reference resolution and preserve native tracked review.',
      `Use ${created.referenceCode} as the only source code and copy the exact approved Skill pin from Workspace.`,
      `Use preview clientRequestId “${changePreviewId}” with normalizedRequestDigest “${digest(changePreviewId)}”.`,
      `After preview succeeds, commit that proposal using clientRequestId “${changeCommitId}” and digest “${digest(changeCommitId)}”.`,
      'Do not create any other proposal. Stop after commit reports pending review.'
    ].join(' '), 300_000)

    assertSuccessfulCalls(changeRun, [
      'promptcard_runtime_describe',
      'promptcard_workspace_describe',
      'promptcard_skill_read',
      'promptcard_reference_resolve',
      'promptcard_delivery_preview',
      'promptcard_delivery_commit'
    ])
    expect(toolPayload(changeRun, 'promptcard_delivery_commit')).toMatchObject({ state: 'pending_review' })
    await reviewPending(page, `修改文档 ${created.referenceCode}`, '接受外部 Agent 文档 提案')

    const projectWithSuggestion = await getProject(request, fixture.projectId)
    const changed = projectWithSuggestion.freeCanvas.nodes.find(node => node.referenceCode === created.referenceCode)
    expect(changed?.document?.suggestions.length).toBeGreaterThan(0)
    expect(documentText(changed!.document!)).toBe(replacement)
    const documentNode = page.locator(`.react-flow__node[data-id="${created.id}"]`)
    await expect(documentNode.locator('[data-document-suggestion-kind="insert"]')).toBeVisible()
    await expect(documentNode.locator('[data-document-suggestion-kind="delete"]')).toBeVisible()
    await documentNode.getByRole('button', { name: '全部接受修订' }).click()
    await expect.poll(async () => {
      const stored = (await getProject(request, fixture.projectId)).freeCanvas.nodes
        .find(node => node.referenceCode === created.referenceCode)
      return {
        text: stored?.document ? documentText(stored.document) : '',
        suggestions: stored?.document?.suggestions.length ?? -1
      }
    }).toEqual({ text: replacement, suggestions: 0 })
  } finally {
    for (const code of contextCodes.reverse()) await revokeContext(request, code)
    await cleanupFixture(request, fixture)
  }
})

function assertSuccessfulCalls(run: RealCodexRun, requiredTools: string[]) {
  const calls = completedPromptCardCalls(run)
  const tools = calls.map(call => call?.tool)
  expect(tools[0]).toBe('promptcard_runtime_describe')
  expect(tools[1]).toBe('promptcard_workspace_describe')
  const failed = calls.filter(call => call?.status !== 'completed')
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
  for (const tool of requiredTools) expect(tools).toContain(tool)
}

function toolPayload(run: RealCodexRun, tool: string): Record<string, unknown> {
  const text = completedPromptCardCalls(run).find(call => call?.tool === tool)
    ?.result?.content?.map(item => item.text || '').join('') || '{}'
  return JSON.parse(text) as Record<string, unknown>
}

async function createFixture(request: APIRequestContext) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const projectId = `real-codex-loop-${suffix}`
  const projectTitle = `Real Codex Loop ${suffix}`
  const projectResponse = await request.post(`${storageUrl}/api/projects`, {
    data: {
      id: projectId,
      title: projectTitle,
      type: 'free-canvas',
      pages: [],
      currentPage: 0,
      meta: {},
      freeCanvas: {
        nodes: [{
          id: 'script-source',
          kind: 'text',
          title: 'Last train script',
          position: { x: 120, y: 120 },
          width: 420,
          height: 180,
          fontSize: 'large',
          segments: [{
            id: 'source',
            source: 'user',
            text: 'EXT. RAILWAY PLATFORM — RAIN — NIGHT. The last train departs.',
            color: '#111827',
            createdAt: 1,
            updatedAt: 1
          }],
          meta: {}
        }],
        edges: [],
        selectedNodeId: 'script-source',
        viewport: { x: 0, y: 0, zoom: 1 },
        meta: {}
      }
    }
  })
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true)
  const project = await projectResponse.json() as {
    referenceCode: string
    freeCanvas: { nodes: Array<{ referenceCode: string }> }
  }
  const skillId = `real-codex-loop-skill-${suffix}`
  const skillResponse = await request.post(`${storageUrl}/api/skills`, {
    data: {
      id: skillId,
      slug: `loop-story-planning-${suffix}`,
      name: 'Real Codex Loop Story Planning',
      description: 'Turns an explicit script source into reviewable planning assets.',
      source: 'external',
      trustState: 'trusted',
      instructions: 'Keep cause-and-effect explicit. Preserve the rain motif. Every creative write requires human review.',
      declaredCapabilities: { tools: ['promptcard_delivery_preview', 'promptcard_delivery_commit'] }
    }
  })
  expect(skillResponse.ok(), await skillResponse.text()).toBe(true)
  const skill = await skillResponse.json() as { referenceCode: string }
  const pinResponse = await request.put(`${storageUrl}/api/skills/${skill.referenceCode}/host-pins/codex`, {
    data: {
      enabled: true,
      revision: 1,
      repositoryScope,
      publicationName: `real-codex-loop-${suffix}`
    }
  })
  expect(pinResponse.ok(), await pinResponse.text()).toBe(true)
  return {
    suffix,
    projectId,
    projectTitle,
    projectCode: project.referenceCode,
    sourceCode: project.freeCanvas.nodes[0].referenceCode,
    skillCode: skill.referenceCode
  }
}

async function openProject(page: Page, request: APIRequestContext, projectId: string, title: string) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const card = page.getByText(title, { exact: true }).locator('xpath=ancestor::article')
  const saveResponse = page.waitForResponse(response => (
    response.request().method() === 'PUT'
    && new URL(response.url()).pathname.endsWith(`/storage-api/projects/${projectId}`)
  ))
  await card.getByRole('button', { name: 'Open project' }).click()
  await saveResponse
  await expect(page.locator('[data-free-canvas-screen]')).toBeVisible()
  await waitForStableProjectRevision(request, projectId)
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
  await expect.poll(async () => {
    const [project, context] = await Promise.all([
      getProject(request, projectId),
      getContextPack(request, code)
    ])
    return context.projectRevision === project.revision
  }, { timeout: 10_000, intervals: [250, 500, 1_000] }).toBe(true)
  return code
}

async function waitForStableProjectRevision(request: APIRequestContext, projectId: string) {
  let previous = -1
  let stableSamples = 0
  await expect.poll(async () => {
    const revision = (await getProject(request, projectId)).revision
    stableSamples = revision === previous ? stableSamples + 1 : 0
    previous = revision
    return stableSamples >= 2
  }, { timeout: 10_000, intervals: [250, 500, 750, 1_000] }).toBe(true)
}

async function getContextPack(request: APIRequestContext, code: string) {
  const response = await request.get(`${storageUrl}/api/context-packs/${code}`)
  expect(response.ok(), await response.text()).toBe(true)
  return response.json() as Promise<{ projectRevision: number }>
}

async function reviewPending(page: Page, title: string, acceptLabel: string) {
  await page.getByRole('button', { name: '刷新外部 Agent 提案' }).click()
  const inbox = page.locator('[data-bridge-delivery-inbox]')
  await expect(inbox.getByText(title, { exact: true })).toBeVisible()
  await inbox.getByRole('button', { name: acceptLabel }).click()
  await expect(inbox.getByText(title, { exact: true })).toHaveCount(0)
}

async function getProject(request: APIRequestContext, id: string) {
  const response = await request.get(`${storageUrl}/api/projects/${id}`)
  expect(response.ok(), await response.text()).toBe(true)
  return response.json() as Promise<StoredProject>
}

function documentText(document: StoredDocument): string {
  return document.blocks.flatMap(block => block.content || []).map(item => item.text || '').join('')
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

async function revokeContext(request: APIRequestContext, cvcCode: string) {
  const response = await request.post(`${storageUrl}/api/context-packs/${cvcCode}/revoke`, {
    data: { actor: 'real-codex-acceptance', reason: 'test-cleanup' }
  })
  expect(response.ok(), await response.text()).toBe(true)
}

async function cleanupFixture(
  request: APIRequestContext,
  fixture: Awaited<ReturnType<typeof createFixture>>
) {
  const disable = await request.put(`${storageUrl}/api/skills/${fixture.skillCode}/host-pins/codex`, {
    data: { enabled: false, revision: 1, repositoryScope }
  })
  expect(disable.ok(), await disable.text()).toBe(true)
  const archive = await request.post(`${storageUrl}/api/skills/${fixture.skillCode}/archive`)
  expect(archive.ok(), await archive.text()).toBe(true)
  const trash = await request.post(`${storageUrl}/api/projects/trash`, {
    data: { ids: [fixture.projectId], deletedBy: 'user', deleteReason: 'real-codex-acceptance-cleanup' }
  })
  expect(trash.ok(), await trash.text()).toBe(true)
  const removed = await request.delete(`${storageUrl}/api/projects/trash`, {
    data: { ids: [fixture.projectId] }
  })
  expect(removed.ok(), await removed.text()).toBe(true)
}
