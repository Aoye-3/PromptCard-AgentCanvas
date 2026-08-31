import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const storageUrl = 'http://127.0.0.1:38102'
const runtimeUrl = 'http://127.0.0.1:38101'
const sourceNodeId = 'plan-007-source-image'
const promptMarker = 'PLAN007_MULTI_VIEW 保持同一产品身份、材质和白色背景'
const expectedViews = ['front', 'left', 'top']

test.describe.serial('zero-cost multi-view generation', () => {
  test.describe.configure({ timeout: 120_000 })

  let providerSessionToken = ''
  let providerSessionReady = false

  test.beforeEach(({ browserName: _browserName }, testInfo) => {
    providerSessionToken = `w${testInfo.workerIndex}-r${testInfo.retry}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    providerSessionReady = false
  })

  test.afterEach(async ({ request }) => {
    if (providerSessionReady) await releaseProvider(request, providerSessionToken)
  })

  test('persists the three-member group before release and preserves moved placeholder geometry', async ({ page, request }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const projectId = `plan-007-multi-view-success-${suffix}`
    const projectTitle = `Plan 007 多视图成功 ${suffix}`
    const otherProjectTitle = `Plan 007 隔离项目 ${suffix}`
    const storageConsoleErrors: string[] = []
    page.on('console', message => {
      if (message.type() === 'error' && message.text().includes('StorageHttpError')) {
        storageConsoleErrors.push(message.text())
      }
    })
    const asset = await seedAsset(request, `plan-007-source-${suffix}.png`)
    await seedProject(request, projectId, projectTitle, asset.id)
    await seedProject(request, `plan-007-other-${suffix}`, otherProjectTitle)
    await resetProvider(request, providerSessionToken, { paused: true })
    providerSessionReady = true
    await enableImageGenerationFeature(page)

    await page.goto('/', { waitUntil: 'networkidle' })
    await openProject(page, projectTitle)
    const dialog = await openMultiViewWorkbench(page)
    await dialog.getByRole('textbox').fill(`${promptMarker} PLAN007_MULTI_VIEW:${providerSessionToken}`)
    await expect(dialog).toContainText('不是精确 3D 重建')
    await dialog.getByRole('button', { name: '选择模型三视图（正视、左视、俯视）' }).click()
    await expect(dialog.locator('[data-multi-view-request-count]')).toHaveText('3')
    await expectSelectedViews(dialog, expectedViews)
    expect((await providerState(request, providerSessionToken)).requests).toHaveLength(0)

    await dialog.getByRole('button', { name: 'Generate 3' }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(async () => (await providerState(request, providerSessionToken)).requests.length).toBe(1)

    const persistedBeforeRelease = await waitForGroup(request, projectId, 3)
    const groupNodes = multiViewNodes(persistedBeforeRelease)
    expect(groupNodes.map(node => node.meta.operationViewSpec)).toEqual(expectedViews)
    expect(new Set(groupNodes.map(node => node.meta.operationGroupId)).size).toBe(1)
    expect(new Set(groupNodes.map(node => node.meta.operationItemId)).size).toBe(3)
    const originalNodeIds = groupNodes.map(node => node.id)
    const originalRunIds = groupNodes.map(node => node.meta.generationRunId)
    const runsBeforeRelease = await generationRuns(request, projectId)
    expect(runsBeforeRelease).toHaveLength(3)
    expect(new Set(runsBeforeRelease.map(run => run.id))).toEqual(new Set(originalRunIds))
    expect(runsBeforeRelease.map(run => run.state).sort()).toEqual(['queued', 'queued', 'running'])
    const runningRun = runsBeforeRelease.find(run => run.state === 'running')!
    const movingNode = groupNodes.find(node => node.meta.generationRunId === runningRun.id)!
    expect(movingNode.meta).toMatchObject({ generationState: 'running', operationViewSpec: 'front' })

    const collapsePanel = page.getByRole('button', { name: 'Collapse Agent panel' })
    await collapsePanel.click()
    await expect(page.getByRole('button', { name: 'Open Agent panel' })).toBeVisible()
    const groupPanelLayout = page.locator('[data-multi-view-group]').first()
    const resourceLibrary = page.locator('[data-project-resource-library]')
    const resourceLibraryBounds = await resourceLibrary.boundingBox()
    const groupPanelBounds = await groupPanelLayout.boundingBox()
    expect(resourceLibraryBounds).not.toBeNull()
    expect(groupPanelBounds).not.toBeNull()
    expect(groupPanelBounds!.x).toBeGreaterThanOrEqual(resourceLibraryBounds!.x + resourceLibraryBounds!.width)
    const resourceLibraryToggle = resourceLibrary.locator('nav > button').first()
    await resourceLibraryToggle.click()
    await expect(groupPanelLayout).toBeHidden()
    await resourceLibraryToggle.click()
    await expect(groupPanelLayout).toBeVisible()
    const groupPanel = page.getByRole('region', { name: '多角度结果组' })
    await groupPanel.getByRole('button', { name: /正视/ }).click()
    await page.keyboard.press('Shift+1')
    await page.waitForTimeout(500)
    const oldPosition = { ...movingNode.position }
    await dragFlowNode(page, movingNode.id, 74, 46)
    await expect.poll(async () => {
      const project = await storageJson(request, `/api/projects/${projectId}`)
      const node = project.freeCanvas.nodes.find((candidate: SavedNode) => candidate.id === movingNode.id)
      return node?.position
    }).not.toEqual(oldPosition)
    const movedProject = await storageJson(request, `/api/projects/${projectId}`)
    const movedPosition = multiViewNodes(movedProject).find(node => node.id === movingNode.id)!.position
    expect(movedPosition).toBeTruthy()

    await releaseProvider(request, providerSessionToken)
    await expect.poll(async () => (await providerState(request, providerSessionToken)).requests.length, { timeout: 30_000 }).toBe(3)
    await expect.poll(async () => terminalRunStates(request, projectId), { timeout: 30_000 })
      .toEqual(['succeeded', 'succeeded', 'succeeded'])
    const succeededProject = await waitForGenerationStates(request, projectId, ['succeeded', 'succeeded', 'succeeded'])
    const succeededNodes = multiViewNodes(succeededProject)
    expect(succeededNodes.map(node => node.id)).toEqual(originalNodeIds)
    expect(succeededNodes.map(node => node.meta.generationRunId)).toEqual(originalRunIds)
    expect(succeededNodes.find(node => node.id === movingNode.id)?.position).toEqual(movedPosition)

    assertLineage(succeededNodes, await generationRuns(request, projectId), projectId, asset.id)
    const provider = await providerState(request, providerSessionToken)
    expect(provider.requests.map((item: ProviderRequest) => item.viewSpec)).toEqual(expectedViews)
    expect(JSON.stringify(provider.requests)).not.toMatch(/authorization|credential|temporary|file:\/|[A-Z]:\\/i)

    await page.reload({ waitUntil: 'networkidle' })
    if (!await page.locator('[data-free-canvas-screen]').isVisible()) await openProject(page, projectTitle)
    await expect(page.locator('[data-image-generation-state="succeeded"]')).toHaveCount(3)
    await page.getByRole('button', { name: 'Back' }).click()
    await openProject(page, otherProjectTitle)
    await page.getByRole('button', { name: 'Back' }).click()
    await openProject(page, projectTitle)
    await expect(page.locator('[data-image-generation-state="succeeded"]')).toHaveCount(3)

    const restoredProject = await storageJson(request, `/api/projects/${projectId}`)
    const restoredNodes = multiViewNodes(restoredProject)
    expect(restoredNodes.map(node => node.id)).toEqual(originalNodeIds)
    expect(restoredNodes.map(node => node.meta.generationRunId)).toEqual(originalRunIds)
    expect(restoredNodes.find(node => node.id === movingNode.id)?.position).toEqual(movedPosition)
    expect((await providerState(request, providerSessionToken)).requests).toHaveLength(3)
    expect(storageConsoleErrors).toEqual([])
  })

  test('silences only the in-flight project PUT cancelled by a real reload', async ({ page, request }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const projectId = `plan-007-reload-cancel-${suffix}`
    const projectTitle = `Plan 007 重载取消 ${suffix}`
    const storageConsoleErrors: string[] = []
    const failedProjectPuts: string[] = []
    const dialogs: string[] = []
    const pageHideEvents: boolean[] = []
    let markPutStarted: () => void = () => undefined
    let releasePut: () => void = () => undefined
    const putStarted = new Promise<void>(resolve => { markPutStarted = resolve })
    const putCanContinue = new Promise<void>(resolve => { releasePut = resolve })

    page.on('console', message => {
      if (message.type() === 'error' && message.text().includes('StorageHttpError')) {
        storageConsoleErrors.push(message.text())
      }
    })
    page.on('requestfailed', request => {
      if (request.method() === 'PUT' && request.url().includes(`/storage-api/projects/${projectId}`)) {
        failedProjectPuts.push(request.failure()?.errorText || 'request failed')
      }
    })
    page.on('dialog', async dialog => {
      dialogs.push(dialog.message())
      await dialog.dismiss()
    })

    await seedProject(request, projectId, projectTitle)
    await page.goto('/', { waitUntil: 'networkidle' })
    await openProject(page, projectTitle)
    await expect.poll(async () => (
      await storageJson(request, `/api/projects/${projectId}`)
    ).revision).toBeGreaterThan(1)
    const revisionBeforeCancelledSave = (await storageJson(request, `/api/projects/${projectId}`)).revision
    await page.exposeFunction('__recordPlan007PageHide', (persisted: boolean) => {
      pageHideEvents.push(persisted)
    })
    await page.evaluate(() => {
      window.addEventListener('pagehide', event => {
        void (window as unknown as {
          __recordPlan007PageHide: (persisted: boolean) => Promise<void>
        }).__recordPlan007PageHide(event.persisted)
      }, { once: true })
    })
    await page.route(`**/storage-api/projects/${projectId}`, async route => {
      if (route.request().method() !== 'PUT') {
        await route.fallback()
        return
      }
      markPutStarted()
      await Promise.race([
        putCanContinue,
        new Promise<void>(resolve => setTimeout(resolve, 5_000))
      ])
      await route.abort('aborted').catch(() => undefined)
    })

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await putStarted
    const reload = page.reload({ waitUntil: 'domcontentloaded' })
    await expect.poll(() => pageHideEvents).toEqual([false])
    releasePut()
    await reload

    const projectAfterReload = await storageJson(request, `/api/projects/${projectId}`)
    expect(projectAfterReload.revision).toBe(revisionBeforeCancelledSave)
    expect(failedProjectPuts).toHaveLength(1)
    expect(storageConsoleErrors).toEqual([])
    expect(dialogs).toEqual([])
  })

  test('derives partial state and retries only the failed view with a new durable run', async ({ page, request }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const projectId = `plan-007-multi-view-partial-${suffix}`
    const projectTitle = `Plan 007 多视图部分成功 ${suffix}`
    const asset = await seedAsset(request, `plan-007-partial-${suffix}.png`)
    await seedProject(request, projectId, projectTitle, asset.id)
    await resetProvider(request, providerSessionToken, { failCalls: [2] })
    providerSessionReady = true
    await enableImageGenerationFeature(page)

    await page.goto('/', { waitUntil: 'networkidle' })
    await openProject(page, projectTitle)
    const dialog = await openMultiViewWorkbench(page)
    await dialog.getByRole('button', { name: '选择模型三视图（正视、左视、俯视）' }).click()
    await dialog.getByRole('textbox').fill(`${promptMarker} PLAN007_MULTI_VIEW:${providerSessionToken}`)
    await dialog.getByRole('button', { name: 'Generate 3' }).click()

    await expect.poll(async () => terminalRunStates(request, projectId), { timeout: 30_000 })
      .toEqual(['failed', 'succeeded', 'succeeded'])
    const partialProject = await waitForGenerationStates(request, projectId, ['failed', 'succeeded', 'succeeded'])
    const initialMembers = multiViewNodes(partialProject)
    const failedMember = initialMembers.find(node => node.meta.operationViewSpec === 'left')
    expect(failedMember?.meta.generationState).toBe('failed')
    const failedRunId = failedMember!.meta.generationRunId
    const failedNodeId = failedMember!.id
    const failedItemId = failedMember!.meta.operationItemId
    const groupId = failedMember!.meta.operationGroupId
    const initialNodeIds = initialMembers.map(node => node.id)
    const succeededAssetIds = initialMembers
      .filter(node => node.meta.generationState === 'succeeded')
      .map(node => node.assetId)
    expect(succeededAssetIds.every(Boolean)).toBe(true)

    const panel = page.getByRole('region', { name: '多角度结果组' })
    await expect(panel).toContainText('部分完成')
    await expect(panel).toContainText('2/3 成功 · 1 失败')
    await panel.getByRole('button', { name: '重试此视角' }).click()
    const retryDialog = page.getByRole('dialog', { name: '多角度工作台' })
    await expect(retryDialog.locator('[data-multi-view-request-count]')).toHaveText('1')
    await expect(retryDialog.locator('[data-multi-view-locked-view]')).toContainText('左视')
    await expect(retryDialog.locator('[data-camera-direction-grid]')).toHaveCount(0)
    await expect(retryDialog.getByRole('button', { name: '选择模型三视图（正视、左视、俯视）' })).toHaveCount(0)
    await expect(retryDialog.getByRole('button', { name: /选择补充视角/ })).toHaveCount(0)
    await retryDialog.getByRole('textbox').fill(`${promptMarker} PLAN007_MULTI_VIEW:${providerSessionToken} retry`)
    await expect(retryDialog.locator('[data-multi-view-request-count]')).toHaveText('1')
    await retryDialog.getByRole('button', { name: 'Generate 1' }).click()

    await expect.poll(async () => (await providerState(request, providerSessionToken)).requests.length, { timeout: 30_000 }).toBe(4)
    await expect.poll(async () => terminalRunStates(request, projectId), { timeout: 30_000 })
      .toEqual(['failed', 'succeeded', 'succeeded', 'succeeded'])
    const retriedProject = await waitForGenerationStates(request, projectId, ['succeeded', 'succeeded', 'succeeded'])
    const retriedMembers = multiViewNodes(retriedProject)
    const leftMembers = retriedMembers.filter(node => node.meta.operationViewSpec === 'left')
    expect(retriedMembers.map(node => node.id)).toEqual(initialNodeIds)
    expect(leftMembers).toHaveLength(1)
    const retriedLeft = leftMembers[0]
    expect(retriedLeft).toMatchObject({
      id: failedNodeId,
      meta: {
        operationGroupId: groupId,
        operationItemId: failedItemId,
        operationViewSpec: 'left',
        generationState: 'succeeded'
      }
    })
    expect(retriedLeft.meta.generationRunId).not.toBe(failedRunId)
    expect(retriedMembers.filter(node => node.meta.operationViewSpec === 'front')).toHaveLength(1)
    expect(retriedMembers.filter(node => node.meta.operationViewSpec === 'top')).toHaveLength(1)
    expect(retriedMembers.filter(node => succeededAssetIds.includes(node.assetId))).toHaveLength(2)

    const succeededPanel = page.getByRole('region', { name: '多角度结果组' })
    await expect(succeededPanel).toContainText('全部成功')
    await expect(succeededPanel).toContainText('3/3 成功 · 0 失败')
    await expect(succeededPanel.getByRole('button', { name: '重试此视角' })).toHaveCount(0)

    const runs = await generationRuns(request, projectId)
    const historicalFailure = runs.find(run => run.id === failedRunId)
    expect(historicalFailure).toMatchObject({ state: 'failed', error: { code: 'test_provider_failure', retryable: true } })
    const leftRuns = runs.filter(run => run.requestSnapshot.operation.viewSpec === 'left')
    expect(leftRuns).toHaveLength(2)
    expect(leftRuns.map(run => run.requestSnapshot.operation.operationItemId))
      .toEqual([failedItemId, failedItemId])
    expect(leftRuns.map(run => run.id)).toContain(failedRunId)
    expect(leftRuns.map(run => run.id)).toContain(retriedLeft.meta.generationRunId)
    expect((await providerState(request, providerSessionToken)).requests.map((item: ProviderRequest) => item.viewSpec))
      .toEqual(['front', 'left', 'top', 'left'])
  })
})

type SavedNode = {
  id: string
  kind: string
  position: { x: number; y: number }
  width: number
  height: number
  assetId: string | null
  imageUrl?: string
  meta: Record<string, string>
}

type SavedRun = {
  id: string
  projectId: string
  nodeId: string
  connectionId: string
  providerId: string
  modelId: string
  state: string
  outputAssetIds: string[]
  requestSnapshot: {
    operation: {
      operation: string
      recipeId: string
      recipeVersion: string
      source: Record<string, string>
      operationGroupId: string
      operationItemId: string
      viewSpec: string
    }
  }
  error?: { code: string; retryable: boolean }
}

type ProviderRequest = { call: number; viewSpec: string }

async function seedAsset(request: APIRequestContext, filename: string) {
  const response = await request.post(`${storageUrl}/api/assets`, {
    data: readFileSync(resolve('public/app-icon.png')),
    headers: { 'content-type': 'image/png', 'x-file-name': filename }
  })
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}

async function seedProject(request: APIRequestContext, id: string, title: string, assetId?: string) {
  const nodes = assetId ? [{
    id: sourceNodeId,
    kind: 'image',
    title: 'Plan 007 本地主体',
      position: { x: 120, y: 320 },
    width: 260,
    height: 260,
    assetId,
    imageUrl: `/storage-api/assets/${assetId}`,
    imagePrompt: '',
    sourceNodeId: null,
    crop: null,
    annotations: [],
    meta: { originalAssetId: assetId }
  }] : []
  const response = await request.post(`${storageUrl}/api/projects`, {
    data: {
      id,
      title,
      type: 'free-canvas',
      revision: 1,
      pages: [],
      currentPage: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
      meta: {},
      freeCanvas: {
        nodes,
        edges: [],
        selectedNodeId: assetId ? sourceNodeId : null,
        viewport: { x: 0, y: 0, zoom: 1 },
        meta: {}
      }
    }
  })
  expect(response.ok(), await response.text()).toBe(true)
}

async function enableImageGenerationFeature(page: Page) {
  await page.goto('/', { waitUntil: 'commit' })
  await page.evaluate(async () => {
    await new Promise<void>((resolvePromise, reject) => {
      const open = indexedDB.open('PromptCard')
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('promptcard')) open.result.createObjectStore('promptcard')
      }
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const transaction = open.result.transaction('promptcard', 'readwrite')
        transaction.objectStore('promptcard').put({
          theme: 'light',
          defaultMode: 'learn',
          autoSave: true,
          autoSaveIdleSeconds: 0.05,
          presetSort: 'usage',
          meta: { featureFlags: { imageGenerationNodeV1: true } }
        }, 'settings')
        transaction.oncomplete = () => {
          open.result.close()
          resolvePromise()
        }
        transaction.onerror = () => reject(transaction.error)
      }
    })
  })
}

async function openProject(page: Page, title: string) {
  const card = page.getByText(title, { exact: true }).locator('xpath=ancestor::article')
  await expect(card).toBeVisible({ timeout: 60_000 })
  await card.getByRole('button', { name: 'Open project' }).click()
  await expect(page.locator('[data-free-canvas-screen]')).toBeVisible()
}

async function openMultiViewWorkbench(page: Page) {
  const source = page.locator(`.react-flow__node[data-id="${sourceNodeId}"]`)
  await source.click({ button: 'right', position: { x: 80, y: 120 } })
  const menu = page.getByRole('menu', { name: '图片节点菜单' })
  await expect(menu).toBeVisible()
  const action = menu.getByRole('menuitem', { name: '多角度' })
  await expect(action).toBeEnabled({ timeout: 30_000 })
  await action.click()
  const dialog = page.getByRole('dialog', { name: '多角度工作台' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function expectSelectedViews(dialog: Locator, selected: string[]) {
  const labels: Record<string, string> = { front: '正视', left: '左视', top: '俯视' }
  for (const [view, label] of Object.entries(labels)) {
    await expect(dialog.getByRole('button', { name: `选择方位 ${label}` }))
      .toHaveAttribute('aria-pressed', selected.includes(view) ? 'true' : 'false')
  }
}

async function dragFlowNode(page: Page, nodeId: string, deltaX: number, deltaY: number) {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  await expect(node).toBeVisible()
  const point = await unobscuredNodePoint(node)
  expect(point, `No unobscured drag point for ${nodeId}`).not.toBeNull()
  await page.mouse.move(point!.x, point!.y)
  await page.mouse.down()
  await page.mouse.move(point!.x + 6, point!.y + 4, { steps: 2 })
  await page.mouse.move(point!.x + deltaX, point!.y + deltaY, { steps: 20 })
  await page.waitForTimeout(100)
  await page.mouse.up()
}

async function unobscuredNodePoint(node: Locator) {
  return node.evaluate(element => {
    const rect = element.getBoundingClientRect()
    for (const yRatio of [0.2, 0.5, 0.8]) {
      for (const xRatio of [0.2, 0.5, 0.8]) {
        const x = rect.left + rect.width * xRatio
        const y = rect.top + rect.height * yRatio
        const hit = document.elementFromPoint(x, y)
        if (hit === element || (hit instanceof Node && element.contains(hit))) return { x, y }
      }
    }
    return null
  })
}

function multiViewNodes(project: { freeCanvas: { nodes: SavedNode[] } }): SavedNode[] {
  return project.freeCanvas.nodes.filter(node => node.meta.imageOperation === 'multi-view')
}

async function waitForGroup(request: APIRequestContext, projectId: string, count: number) {
  await expect.poll(async () => {
    const project = await storageJson(request, `/api/projects/${projectId}`)
    return multiViewNodes(project).length
  }).toBe(count)
  return storageJson(request, `/api/projects/${projectId}`)
}

async function waitForGenerationStates(request: APIRequestContext, projectId: string, states: string[]) {
  await expect.poll(async () => {
    const project = await storageJson(request, `/api/projects/${projectId}`)
    return multiViewNodes(project).map(node => node.meta.generationState).sort()
  }, { timeout: 30_000 }).toEqual([...states].sort())
  return storageJson(request, `/api/projects/${projectId}`)
}

async function generationRuns(request: APIRequestContext, projectId: string): Promise<SavedRun[]> {
  const page = await storageJson(request, `/api/image-generation-runs?projectId=${projectId}&limit=100`)
  return page.runs
}

async function terminalRunStates(request: APIRequestContext, projectId: string) {
  const runs = await generationRuns(request, projectId)
  return runs.map(run => run.state).sort()
}

function assertLineage(nodes: SavedNode[], runs: SavedRun[], projectId: string, sourceAssetId: string) {
  const runsById = new Map(runs.map(run => [run.id, run]))
  nodes.forEach(node => {
    const run = runsById.get(node.meta.generationRunId)
    expect(node.meta).toMatchObject({
      source: 'contextual-image-operation',
      imageOperation: 'multi-view',
      imageRecipeId: 'multi-view/identity-preserving',
      imageRecipeVersion: '1',
      sourceAssetId,
      sourceCanvasNodeId: sourceNodeId
    })
    expect(run).toMatchObject({
      projectId,
      nodeId: sourceNodeId,
      connectionId: 'e2e-ark-image',
      providerId: 'volcengine-ark',
      modelId: 'doubao-seedream-5-0-pro-260628',
      state: 'succeeded',
      requestSnapshot: {
        operation: {
          operation: 'multi-view',
          recipeId: 'multi-view/identity-preserving',
          recipeVersion: '1',
          operationGroupId: node.meta.operationGroupId,
          operationItemId: node.meta.operationItemId,
          viewSpec: node.meta.operationViewSpec,
          source: {
            nodeId: sourceNodeId,
            originalAssetId: sourceAssetId,
            canvasAssetId: sourceAssetId,
            providerAssetId: sourceAssetId
          }
        }
      }
    })
    expect(run!.outputAssetIds).toEqual([node.assetId])
    expect(node.imageUrl).toContain(`/storage-api/assets/${node.assetId}`)
  })
}

async function resetProvider(
  request: APIRequestContext,
  token: string,
  controls: { paused?: boolean; failCalls?: number[]; failViews?: string[] }
) {
  const response = await request.post(`${runtimeUrl}/__test__/multi-view-provider/reset`, {
    data: { token, ...controls }
  })
  expect(response.ok(), await response.text()).toBe(true)
}

async function releaseProvider(request: APIRequestContext, token: string) {
  const response = await request.post(`${runtimeUrl}/__test__/multi-view-provider/release`, { data: { token } })
  expect(response.ok(), await response.text()).toBe(true)
}

async function providerState(request: APIRequestContext, token: string) {
  const response = await request.get(`${runtimeUrl}/__test__/multi-view-provider`, { params: { token } })
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}

async function storageJson(request: APIRequestContext, path: string) {
  const response = await request.get(`${storageUrl}${path}`)
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}
