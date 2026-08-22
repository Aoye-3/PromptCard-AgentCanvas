import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
import { cleanupAcquiredFixtures } from '../../scripts/e2e-fixture-cleanup'

const storageUrl = 'http://127.0.0.1:38102'
const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
  'base64'
)

test('copies project and text-node codes by keyboard without mutating the Canvas workspace', async ({ context, page, request }) => {
  test.setTimeout(60_000)
  const fixture = await createProjectFixture(request, 'keyboard', [textNode()])
  try {
    const consoleErrors = await preparePage(context, page, fixture.title)
    const writes = captureProjectWrites(page)
    const projectCopy = page.getByRole('button', { name: /^复制项目代码：/ })
    await projectCopy.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => clipboardText(page)).toBe(fixture.stored.referenceCode)
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)

    const text = page.getByTestId('rf__node-task9-text')
    await text.click({ button: 'right' })
    const selectedBefore = await selectedNodeIds(page)
    const copy = page.getByRole('menuitem', { name: /^复制节点代码：文字节点/ })
    await copy.focus()
    await page.keyboard.press('Space')
    await expect.poll(() => clipboardText(page)).toBe(fixture.stored.freeCanvas.nodes[0].referenceCode)
    expect(await selectedNodeIds(page)).toEqual(selectedBefore)
    await expect(page.locator('[data-free-canvas-text-node] [contenteditable="true"]')).toHaveCount(0)
    await expect(page.getByRole('menu', { name: '文字节点菜单' })).toBeVisible()
    await expect(page.getByText('可以直接修改当前画布')).toBeVisible()
    await expect.poll(() => writes).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally {
    await deleteProjectFixture(request, fixture.id)
  }
})

test('copies an image-node code by mouse with retry and a fully reachable long menu', async ({ context, page, request }) => {
  test.setTimeout(60_000)
  let assetId: string | null = null
  let fixture: Awaited<ReturnType<typeof createProjectFixture>> | null = null
  try {
    assetId = await createImageAsset(request)
    fixture = await createProjectFixture(request, 'image', [imageNode(assetId)])
    const consoleErrors = await preparePage(context, page, fixture.title)
    const writes = captureProjectWrites(page)
    const image = page.getByTestId('rf__node-task9-image')
    await image.click({ button: 'right' })
    const copy = page.getByRole('menuitem', { name: /^复制节点代码：图片节点/ })
    await expect(copy).toBeVisible()
    await expect(copy).toBeEnabled()
    await expect(page.getByRole('menuitem', { name: '垂直翻转' })).not.toBeInViewport()
    const selectedBefore = await selectedNodeIds(page)

    await page.evaluate(() => {
      const original = navigator.clipboard.writeText.bind(navigator.clipboard)
      let failures = 1
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (text: string) => {
          if (failures-- > 0) throw new DOMException('clipboard denied', 'NotAllowedError')
          return original(text)
        }
      })
    })
    await copy.click()
    await expect(page.getByRole('alert')).toContainText('复制节点代码失败')
    await page.getByRole('menuitem', { name: /^重试复制节点代码：图片节点/ }).click()
    await expect.poll(() => clipboardText(page)).toBe(fixture.stored.freeCanvas.nodes[0].referenceCode)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(await selectedNodeIds(page)).toEqual(selectedBefore)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const lastAction = page.getByRole('menuitem', { name: '垂直翻转' })
    await lastAction.scrollIntoViewIfNeeded()
    await expect(lastAction).toBeVisible()
    await expect(lastAction).toBeInViewport()
    await expect.poll(() => writes).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally {
    await cleanupAcquiredFixtures(
      { projectId: fixture?.id || null, assetId },
      {
        deleteProject: id => deleteProjectFixture(request, id),
        deleteAsset: id => deleteImageAsset(request, id)
      }
    )
  }
})

test('explains unsupported nodes and avoids horizontal overflow at 320 and 768 pixels', async ({ context, page, request }) => {
  test.setTimeout(60_000)
  const fixture = await createProjectFixture(request, 'unsupported', [arrowNode()])
  try {
    const consoleErrors = await preparePage(context, page, fixture.title)
    const writes = captureProjectWrites(page)
    expect(fixture.stored.freeCanvas.nodes[0].referenceCode).toBeUndefined()
    await page.getByRole('button', { name: 'Collapse Agent panel' }).click()

    for (const width of [320, 768]) {
      await page.setViewportSize({ width, height: 720 })
      await expect(page.getByRole('button', { name: /^复制项目代码：/ })).toBeVisible()
      await expect.poll(() => hasNoHorizontalOverflow(page)).toBe(true)
      await page.getByTestId('rf__node-task9-arrow').click({ button: 'right' })
      await expect(page.getByRole('menuitem', { name: /^复制节点代码：箭头节点/ })).toBeDisabled()
      await expect(page.getByRole('status').filter({ hasText: '箭头节点不支持节点代码' }))
        .toContainText('箭头节点不支持节点代码')
      await expect.poll(() => hasNoHorizontalOverflow(page)).toBe(true)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu', { name: '箭头节点菜单' })).toHaveCount(0)
    }
    await expect.poll(() => writes).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally {
    await deleteProjectFixture(request, fixture.id)
  }
})

const createProjectFixture = async (request: APIRequestContext, label: string, nodes: Array<Record<string, unknown>>) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const id = `copy-code-${label}-${suffix}`
  const title = `Copy code ${label} ${suffix}`
  const response = await request.post(`${storageUrl}/api/projects`, { data: taskProject(id, title, nodes) })
  expect(response.ok(), await response.text()).toBe(true)
  return { id, title, stored: await response.json() }
}

const preparePage = async (context: BrowserContext, page: Page, title: string) => {
  const consoleErrors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/', { waitUntil: 'networkidle' })
  const card = page.getByText(title, { exact: true }).locator('xpath=ancestor::article')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Open project' }).click()
  await expect(page.locator('[data-free-canvas-screen]')).toBeVisible()
  return consoleErrors
}

const taskProject = (id: string, title: string, nodes: Array<Record<string, unknown>>) => ({
  id, title, type: 'free-canvas', pages: [], currentPage: 0, meta: {},
  freeCanvas: { nodes, edges: [], selectedNodeId: null, viewport: { x: 0, y: 0, zoom: 1 }, meta: {} }
})

const textNode = () => ({
  id: 'task9-text', kind: 'text', title: 'Task 9 text', position: { x: 120, y: 120 }, width: 420, height: 180,
  fontSize: 'large', segments: [{ id: 'task9-segment', source: 'user', text: 'Task 9 text content', color: '#111827', createdAt: 1, updatedAt: 1 }], meta: {}
})
const imageNode = (assetId: string) => ({
  id: 'task9-image', kind: 'image', title: 'Task 9 image', position: { x: 480, y: 120 }, width: 320, height: 240,
  assetId, annotations: [], meta: { generationState: 'succeeded' }
})
const arrowNode = () => ({
  id: 'task9-arrow', kind: 'arrow', title: 'Task 9 arrow', position: { x: 120, y: 160 }, width: 180, height: 60,
  text: 'Task 9 arrow', color: '#111827', meta: {}
})

const captureProjectWrites = (page: Page): string[] => {
  const writes: string[] = []
  page.on('request', request => {
    if (/\/storage-api\/projects(?:\/[^/]+)?$/.test(request.url()) && request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`)
  })
  return writes
}
const selectedNodeIds = (page: Page): Promise<string[]> => page.locator('.react-flow__node.selected')
  .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id') || ''))
const clipboardText = (page: Page): Promise<string> => page.evaluate(() => navigator.clipboard.readText())
const hasNoHorizontalOverflow = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

const deleteProjectFixture = async (request: APIRequestContext, id: string) => {
  const trash = await request.post(`${storageUrl}/api/projects/trash`, {
    data: { ids: [id], deletedBy: 'user', deleteReason: 'task9-e2e-cleanup' }
  })
  expect(trash.ok(), await trash.text()).toBe(true)
  const removed = await request.delete(`${storageUrl}/api/projects/trash`, { data: { ids: [id] } })
  expect(removed.ok(), await removed.text()).toBe(true)
}

const createImageAsset = async (request: APIRequestContext): Promise<string> => {
  const response = await request.post(`${storageUrl}/api/assets`, {
    data: fixturePng,
    headers: { 'content-type': 'image/png', 'x-file-name': 'task9-copy-code.png' }
  })
  expect(response.ok(), await response.text()).toBe(true)
  return (await response.json()).id as string
}

const deleteImageAsset = async (request: APIRequestContext, id: string) => {
  const trash = await request.post(`${storageUrl}/api/storage/artifacts/trash`, {
    data: { ids: [id], deletedBy: 'user' }
  })
  expect(trash.ok(), await trash.text()).toBe(true)
  const removed = await request.post(`${storageUrl}/api/storage/artifacts/delete-forever`, { data: { ids: [id] } })
  expect(removed.ok(), await removed.text()).toBe(true)
}
