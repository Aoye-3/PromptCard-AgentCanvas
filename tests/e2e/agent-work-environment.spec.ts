import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
import { cleanupAcquiredFixtureGraph } from '../../scripts/e2e-fixture-cleanup'

const storageUrl = 'http://127.0.0.1:38102'
const gatewayUrl = 'http://127.0.0.1:38101'
const bridgeToken = process.env.PROMPTCARD_E2E_BRIDGE_TOKEN || ''

test.skip(bridgeToken === '', 'requires the real Gateway Bridge profile')

interface StoredFixtureProject {
  referenceCode: string
  revision: number
  freeCanvas: { nodes: Array<{ referenceCode: string }> }
}

test('shows a connected external Agent environment and copies an exact CVC object task', async ({ context, page, request }) => {
  test.setTimeout(90_000)
  let project: Awaited<ReturnType<typeof createProjectFixture>> | null = null
  let otherProject: Awaited<ReturnType<typeof createProjectFixture>> | null = null
  try {
    project = await createProjectFixture(request, 'work-environment')
    otherProject = await createProjectFixture(request, 'other-project')
    await preparePage(context, page, project.title)
    const activity = await request.get(`${gatewayUrl}/api/promptcard/bridge/v3/runtime`, {
      headers: { Authorization: `Bearer ${bridgeToken}` }
    })
    expect(activity.ok(), await activity.text()).toBe(true)
    const node = page.getByTestId('rf__node-agent-work-text')
    await node.click()
    const currentProjectResponse = await request.get(`${storageUrl}/api/projects/${project.id}`)
    expect(currentProjectResponse.ok(), await currentProjectResponse.text()).toBe(true)
    const currentProject = await currentProjectResponse.json() as StoredFixtureProject
    const contextPack = await createContextPack(request, currentProject)
    const cvcCode = contextPack.cvcCode as string

    const environment = page.locator('[data-agent-work-environment]')
    await expect(environment).toBeVisible()
    await environment.getByLabel('Agent 工作环境 CVC').fill(cvcCode)
    await environment.getByRole('button', { name: '验证并切换' }).click()
    await expect(environment).toContainText('codex 近期已连接')
    await expect(environment).toContainText('promptcard-bootstrap')
    await expect(environment).toContainText('bridge:read')
    await expect(environment).toContainText(project.stored.referenceCode)
    await expect(environment).toContainText(cvcCode)
    await expect(environment).toContainText('1/1 已授权')

    await environment.getByLabel('外部 Agent 任务描述').fill('把这个场景扩展成三段式镜头。')
    await environment.getByRole('button', { name: '复制给外部 Agent' }).click()
    await expect(environment.getByRole('button', { name: '已复制精确任务' })).toBeVisible()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain(`项目：${project?.stored.referenceCode}`)
    expect(copied).toContain(`工作上下文：${cvcCode}`)
    expect(copied).toContain(`对象：${project.stored.freeCanvas.nodes[0].referenceCode}`)
    expect(copied).toContain('promptcard_runtime_describe')
    expect(copied).toContain('不要根据截图或当前界面焦点推断目标')

    const otherContext = await createContextPack(request, otherProject.stored)
    await environment.getByLabel('Agent 工作环境 CVC').fill(otherContext.cvcCode)
    await environment.getByRole('button', { name: '验证并切换' }).click()
    await expect(environment.getByRole('alert')).toContainText('另一个项目')
    await expect(environment.getByLabel('Agent 工作环境 CVC')).toHaveValue(otherContext.cvcCode)
    await expect(environment).toContainText(cvcCode)
  } finally {
    await cleanupAcquiredFixtureGraph(
      { projectIds: [project?.id || null, otherProject?.id || null], assetIds: [] },
      { deleteProject: id => deleteProjectFixture(request, id), deleteAsset: async () => undefined }
    )
  }
})

const createProjectFixture = async (request: APIRequestContext, label: string) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const id = `agent-env-${label}-${suffix}`
  const title = `Agent environment ${label} ${suffix}`
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
          id: 'agent-work-text', kind: 'text', title: `Scene ${label}`,
          position: { x: 160, y: 140 }, width: 420, height: 180, fontSize: 'large',
          segments: [{
            id: 'segment-1', source: 'user', text: 'Rain falls across the empty platform.',
            color: '#111827', createdAt: 1, updatedAt: 1
          }],
          meta: {}
        }],
        edges: [], selectedNodeId: null, viewport: { x: 0, y: 0, zoom: 1 }, meta: {}
      }
    }
  })
  expect(response.ok(), await response.text()).toBe(true)
  return { id, title, stored: await response.json() as StoredFixtureProject }
}

const createContextPack = async (request: APIRequestContext, project: StoredFixtureProject) => {
  const response = await request.post(`${storageUrl}/api/context-packs`, {
    data: {
      projectCode: project.referenceCode,
      projectRevision: project.revision,
      nodeCodes: [project.freeCanvas.nodes[0].referenceCode],
      placementHint: {
        mode: 'after-selection',
        anchorNodeCodes: [project.freeCanvas.nodes[0].referenceCode]
      },
      creator: 'promptcard-ui'
    }
  })
  expect(response.ok(), await response.text()).toBe(true)
  return response.json() as Promise<{ cvcCode: string }>
}

const preparePage = async (context: BrowserContext, page: Page, title: string) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/', { waitUntil: 'networkidle' })
  const card = page.getByText(title, { exact: true }).locator('xpath=ancestor::article')
  await card.getByRole('button', { name: 'Open project' }).click()
  await expect(page.locator('[data-free-canvas-screen]')).toBeVisible()
}

const deleteProjectFixture = async (request: APIRequestContext, id: string) => {
  const trash = await request.post(`${storageUrl}/api/projects/trash`, {
    data: { ids: [id], deletedBy: 'user', deleteReason: 'agent-work-environment-e2e-cleanup' }
  })
  expect(trash.ok(), await trash.text()).toBe(true)
  const removed = await request.delete(`${storageUrl}/api/projects/trash`, { data: { ids: [id] } })
  expect(removed.ok(), await removed.text()).toBe(true)
}
