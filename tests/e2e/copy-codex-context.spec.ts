import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
import { cleanupAcquiredFixtureGraph } from '../../scripts/e2e-fixture-cleanup'

const storageUrl = 'http://127.0.0.1:38102'
const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
  'base64'
)

test('previews, copies, inspects after focus change and revokes one immutable CVC with clipboard recovery', async ({ context, page, request }) => {
  test.setTimeout(120_000)
  let assetId: string | null = null
  let first: Awaited<ReturnType<typeof createProjectFixture>> | null = null
  let second: Awaited<ReturnType<typeof createProjectFixture>> | null = null
  try {
    assetId = await createImageAsset(request)
    first = await createProjectFixture(request, 'source', [textNode(), imageNode(assetId), arrowNode()])
    second = await createProjectFixture(request, 'focus', [focusTextNode()])
    await preparePage(context, page, first.title)
    const releaseFirstSave = deferred()
    const firstSaveReachedStorage = deferred()
    const projectWrites: Array<Record<string, unknown>> = []
    let holdNextProjectWrite = false
    await page.route(`**/storage-api/projects/${first.id}`, async route => {
      if (route.request().method() !== 'PUT') return route.continue()
      const body = route.request().postDataJSON() as { updates?: Record<string, unknown> }
      projectWrites.push(body.updates || {})
      if (!holdNextProjectWrite) return route.continue()
      holdNextProjectWrite = false
      const response = await route.fetch()
      firstSaveReachedStorage.resolve()
      await releaseFirstSave.promise
      await route.fulfill({ response })
    })
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

    holdNextProjectWrite = true
    await page.getByTestId('rf__node-task11-image').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '创建副本' }).click()
    await expect(page.locator('.react-flow__node')).toHaveCount(4)
    const duplicateId = await page.locator('.react-flow__node').evaluateAll(nodes => (
      nodes.map(node => node.getAttribute('data-id')).find(id => id && !['task11-text', 'task11-image', 'task11-arrow'].includes(id)) || ''
    ))
    expect(duplicateId).not.toBe('')
    await firstSaveReachedStorage.promise
    const firstWriteNodes = ((projectWrites[0].freeCanvas as { nodes: Array<Record<string, unknown>> }).nodes)
    const firstWriteCopy = firstWriteNodes.find(node => node.id === duplicateId)!
    expect(firstWriteCopy.referenceCode).toBeUndefined()
    expect((firstWriteCopy.meta as Record<string, unknown>).referenceCodePending).toBeUndefined()

    const duplicateNode = page.locator(`.react-flow__node[data-id="${duplicateId}"]`)
    const beforeMove = await duplicateNode.boundingBox()
    expect(beforeMove).not.toBeNull()
    await page.mouse.move(beforeMove!.x + 40, beforeMove!.y + 40)
    await page.mouse.down()
    await page.mouse.move(beforeMove!.x + 180, beforeMove!.y + 130, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await duplicateNode.boundingBox())?.x || 0).toBeGreaterThan(beforeMove!.x + 80)
    releaseFirstSave.resolve()
    await expect.poll(() => projectWrites.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    await expect.poll(async () => {
      const response = await request.get(`${storageUrl}/api/projects/${first?.id}`)
      const stored = await response.json()
      return stored.freeCanvas.nodes.length === 4
    }, { timeout: 15_000 }).toBe(true)
    const storedAfterDuplicate = await (await request.get(`${storageUrl}/api/projects/${first.id}`)).json()
    const originalStored = storedAfterDuplicate.freeCanvas.nodes.find((node: { id: string }) => node.id === 'task11-image')
    const duplicateStored = storedAfterDuplicate.freeCanvas.nodes.find((node: { id: string }) => node.id === duplicateId)
    expect([originalStored.referenceCode, duplicateStored.referenceCode]).toEqual([
      expect.stringMatching(/^CVM-/), expect.stringMatching(/^CVM-/)
    ])
    expect(duplicateStored.referenceCode).not.toBe(originalStored.referenceCode)
    expect(duplicateStored.position.x).toBeGreaterThan(firstWriteCopy.position.x as number)

    await duplicateNode.click()
    await expect(page.locator('.react-flow__node.selected')).toHaveAttribute('data-id', duplicateId)
    await page.getByRole('button', { name: '复制 Agent/MCP 上下文' }).click()
    const dialog = page.getByRole('dialog', { name: '复制 Agent/MCP 上下文' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(`${first.stored.referenceCode} · 项目修订 ${storedAfterDuplicate.revision}`)
    await expect(dialog.getByRole('listitem')).toHaveText([
      new RegExp(`图片.*Task 11 image 副本.*${duplicateStored.referenceCode}`)
    ])
    await expect(dialog).not.toContainText(originalStored.referenceCode)

    const createRequest = page.waitForRequest(request => (
      request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/storage-api/context-packs')
    ))
    await dialog.getByRole('button', { name: '创建并复制 CVC' }).click()
    expect((await createRequest).postDataJSON().nodeCodes).toEqual([duplicateStored.referenceCode])
    await expect(dialog.getByRole('alert')).toContainText('上下文已创建，但复制失败')
    const cvcCode = await dialog.getByTestId('context-pack-code').innerText()
    expect(cvcCode).toMatch(/^CVC-/)
    const before = await getContext(request, cvcCode, 'resolve')
    await dialog.getByRole('button', { name: '重试复制 CVC' }).click()
    await expect.poll(() => clipboardText(page)).toBe(cvcCode)
    await expect(dialog.getByRole('alert')).toHaveCount(0)

    await dialog.getByRole('button', { name: '关闭 Agent/MCP 上下文' }).click()
    await page.getByRole('button', { name: 'Back' }).click()
    const focusCard = page.getByText(second.title, { exact: true }).locator('xpath=ancestor::article')
    await focusCard.getByRole('button', { name: 'Open project' }).click()
    await expect(page.locator('[data-free-canvas-screen]')).toBeVisible()
    await page.getByRole('button', { name: '复制 Agent/MCP 上下文' }).click()
    const focusDialog = page.getByRole('dialog', { name: '复制 Agent/MCP 上下文' })
    await focusDialog.getByLabel('检查 CVC').fill(cvcCode.toLowerCase())
    await focusDialog.getByRole('button', { name: '检查快照' }).click()
    const snapshot = focusDialog.getByLabel('不可变快照检查')
    await expect(snapshot).toContainText('不可变快照')
    await expect(snapshot).toContainText(first.stored.referenceCode)
    await expect(snapshot).toContainText('Task 11 image 副本')
    await expect(snapshot).toContainText(duplicateStored.referenceCode)
    await expect(snapshot).not.toContainText(originalStored.referenceCode)
    const after = await getContext(request, cvcCode, 'resolve')
    expect(after).toEqual(before)

    await focusDialog.getByRole('button', { name: '撤销此 CVC' }).click()
    await expect(snapshot).toContainText('已撤销，不再是可用复制上下文')
    await expect(focusDialog.getByRole('button', { name: '撤销此 CVC' })).toBeDisabled()
    const revoked = await request.get(`${storageUrl}/api/context-packs/${cvcCode}/resolve`)
    expect(revoked.status()).toBe(410)
    expect((await revoked.json()).detail.code).toBe('context_revoked')

    await page.setViewportSize({ width: 320, height: 720 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    await cleanupAcquiredFixtureGraph(
      {
        projectIds: [first?.id || null, second?.id || null],
        assetIds: [assetId]
      },
      {
        deleteProject: id => deleteProjectFixture(request, id),
        deleteAsset: id => deleteImageAsset(request, id)
      }
    )
  }
})

test('keeps modifier multi-selection when preparing an explicit multi-object CVC', async ({ context, page, request }) => {
  test.setTimeout(90_000)
  let fixture: Awaited<ReturnType<typeof createProjectFixture>> | null = null
  try {
    fixture = await createProjectFixture(request, 'multi-selection', [textNode(), secondTextNode()])
    await preparePage(context, page, fixture.title)
    await page.getByTestId('rf__node-task11-text').click()
    await page.getByTestId('rf__node-task11-second').click({
      modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control']
    })
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)

    await page.getByRole('button', { name: '复制 Agent/MCP 上下文' }).click()
    const dialog = page.getByRole('dialog', { name: '复制 Agent/MCP 上下文' })
    const references = fixture.stored.freeCanvas.nodes.map((node: { referenceCode: string }) => node.referenceCode)
    await expect(dialog.getByRole('listitem')).toHaveCount(2)
    for (const code of references) await expect(dialog.getByText(code, { exact: true })).toBeVisible()
  } finally {
    if (fixture) await deleteProjectFixture(request, fixture.id)
  }
})

const createProjectFixture = async (request: APIRequestContext, label: string, nodes: Array<Record<string, unknown>>) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const id = `context-${label}-${suffix}`
  const title = `Context ${label} ${suffix}`
  const response = await request.post(`${storageUrl}/api/projects`, {
    data: { id, title, type: 'free-canvas', pages: [], currentPage: 0, meta: {}, freeCanvas: { nodes, edges: [], selectedNodeId: null, viewport: { x: 0, y: 0, zoom: 1 }, meta: {} } }
  })
  expect(response.ok(), await response.text()).toBe(true)
  return { id, title, stored: await response.json() }
}

const preparePage = async (context: BrowserContext, page: Page, title: string) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/', { waitUntil: 'networkidle' })
  const card = page.getByText(title, { exact: true }).locator('xpath=ancestor::article')
  await card.getByRole('button', { name: 'Open project' }).click()
  await expect(page.locator('[data-free-canvas-screen]')).toBeVisible()
}

const textNode = () => ({
  id: 'task11-text', kind: 'text', title: 'Task 11 text', position: { x: 120, y: 120 }, width: 420, height: 180,
  fontSize: 'large', segments: [{ id: 'segment', source: 'user', text: 'Frozen task 11 text', color: '#111827', createdAt: 1, updatedAt: 1 }], meta: {}
})
const focusTextNode = () => ({
  id: 'task11-focus', kind: 'text', title: 'Focus project text', position: { x: 120, y: 120 }, width: 420, height: 180,
  fontSize: 'large', segments: [], meta: {}
})
const secondTextNode = () => ({
  id: 'task11-second', kind: 'text', title: 'Task 11 second', position: { x: 600, y: 120 }, width: 420, height: 180,
  fontSize: 'large', segments: [{ id: 'second-segment', source: 'user', text: 'Second explicit context object', color: '#111827', createdAt: 1, updatedAt: 1 }], meta: {}
})
const imageNode = (assetId: string) => ({
  id: 'task11-image', kind: 'image', title: 'Task 11 image', position: { x: 560, y: 120 }, width: 320, height: 240,
  assetId, annotations: [], meta: { generationState: 'succeeded' }
})
const arrowNode = () => ({
  id: 'task11-arrow', kind: 'arrow', title: 'Task 11 arrow', position: { x: 240, y: 420 }, width: 180, height: 60,
  text: 'unsupported', color: '#111827', meta: {}
})

const getContext = async (request: APIRequestContext, code: string, suffix: 'resolve') => {
  const response = await request.get(`${storageUrl}/api/context-packs/${code}/${suffix}`)
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}
const clipboardText = (page: Page): Promise<string> => page.evaluate(() => navigator.clipboard.readText())

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

const deleteProjectFixture = async (request: APIRequestContext, id: string) => {
  const trash = await request.post(`${storageUrl}/api/projects/trash`, { data: { ids: [id], deletedBy: 'user', deleteReason: 'task11-e2e-cleanup' } })
  expect(trash.ok(), await trash.text()).toBe(true)
  const removed = await request.delete(`${storageUrl}/api/projects/trash`, { data: { ids: [id] } })
  expect(removed.ok(), await removed.text()).toBe(true)
}
const createImageAsset = async (request: APIRequestContext): Promise<string> => {
  const response = await request.post(`${storageUrl}/api/assets`, {
    data: fixturePng,
    headers: { 'content-type': 'image/png', 'x-file-name': 'task11-context.png' }
  })
  expect(response.ok(), await response.text()).toBe(true)
  return (await response.json()).id as string
}
const deleteImageAsset = async (request: APIRequestContext, id: string) => {
  const trash = await request.post(`${storageUrl}/api/storage/artifacts/trash`, { data: { ids: [id], deletedBy: 'user' } })
  expect(trash.ok(), await trash.text()).toBe(true)
  const removed = await request.post(`${storageUrl}/api/storage/artifacts/delete-forever`, { data: { ids: [id] } })
  expect(removed.ok(), await removed.text()).toBe(true)
}
