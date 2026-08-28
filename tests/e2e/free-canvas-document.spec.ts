import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

test('creates, edits, expands, collapses, moves, and reloads a neutral Document draft', async ({ page }) => {
  const storage = await routeStorage(page)
  await openFreeCanvasProject(page)

  await page.getByTitle('Document').click()
  const node = page.locator('[data-document-node]')
  await expect(node).toBeVisible()
  await expect(node.locator('.react-flow__handle')).toHaveCount(0)

  const inlineEditor = node.locator('[contenteditable="true"]')
  await expect(inlineEditor).toHaveCount(1)
  await inlineEditor.fill('Browser planning draft')
  await expect.poll(() => storedDocumentText(storage.project())).toBe('Browser planning draft')
  expect(JSON.stringify(storage.project())).not.toContain('tiptap')
  expect(JSON.stringify(storage.project())).not.toContain('effectiveText')

  await node.getByRole('button', { name: '展开编辑器' }).click()
  const dialog = page.getByRole('dialog', { name: '未命名文档' })
  await expect(dialog).toBeVisible()
  await expect(node.locator('[contenteditable="true"]')).toHaveCount(0)
  await expect(dialog.locator('[contenteditable="true"]')).toHaveCount(1)
  await dialog.locator('[contenteditable="true"]').fill('Browser planning draft expanded')
  await expect.poll(() => storedDocumentText(storage.project())).toBe('Browser planning draft expanded')

  await dialog.getByRole('button', { name: '关闭展开编辑器' }).click()
  await expect(dialog).toBeHidden()
  await expect(node.locator('[contenteditable="true"]')).toHaveCount(1)
  await node.getByRole('button', { name: '折叠文档' }).click()
  await expect(node.locator('[contenteditable="true"]')).toHaveCount(0)
  await expect(node.locator('[data-document-collapsed-summary]')).toContainText('Browser planning draft expanded')

  const beforeMove = await requiredBox(node)
  await dragFromLocator(page, node.getByText('未命名文档'), 120, 70)
  const afterMove = await requiredBox(node)
  expect(afterMove.x).toBeGreaterThan(beforeMove.x + 60)
  expect(afterMove.y).toBeGreaterThan(beforeMove.y + 30)

  await page.reload({ waitUntil: 'domcontentloaded' })
  const projectTitle = String(storage.project()?.title || '')
  await page.getByText(projectTitle, { exact: true }).click()
  const reloadedNode = page.locator('[data-document-node]')
  await expect(reloadedNode).toContainText('Browser planning draft expanded')
})

async function openFreeCanvasProject(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByText('Create project').click()
  await page.locator('[data-builder-template-id]').first().click()
}

async function dragFromLocator(page: Page, locator: Locator, deltaX: number, deltaY: number) {
  const box = await requiredBox(locator)
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 12 })
  await page.mouse.up()
}

async function requiredBox(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Expected element to have a bounding box')
  return box
}

function storedDocumentText(project: Record<string, unknown> | null): string | null {
  const freeCanvas = project?.freeCanvas as { nodes?: Array<Record<string, unknown>> } | undefined
  const node = freeCanvas?.nodes?.find(candidate => candidate.kind === 'document')
  const document = node?.document as { blocks?: Array<{ content?: Array<{ text?: string }> }> } | undefined
  return document?.blocks?.flatMap(block => block.content || []).map(inline => inline.text || '').join('') ?? null
}

async function routeStorage(page: Page) {
  let currentProject: Record<string, unknown> | null = null
  await page.route('**/storage-api/projects', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { projects: currentProject ? [currentProject] : [] } })
      return
    }
    currentProject = await projectFromWrite(route, currentProject)
    await route.fulfill({ json: currentProject })
  })
  await page.route('**/storage-api/projects/*', async route => {
    currentProject = await projectFromWrite(route, currentProject)
    await route.fulfill({ json: currentProject })
  })
  await page.route('**/storage-api/presets', route => route.fulfill({ json: { presets: [] } }))
  await page.route('**/storage-api/presets/trash', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/storage-api/projects/trash', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/storage-api/migrations/browser-cache', route => route.fulfill({ json: { projects: 0, presets: 0 } }))
  return { project: () => currentProject }
}

async function projectFromWrite(route: Route, currentProject: Record<string, unknown> | null) {
  if (route.request().method() === 'POST') {
    return { ...(route.request().postDataJSON() as Record<string, unknown>), revision: 1 }
  }
  const body = route.request().postDataJSON() as { revision: number; updates: Record<string, unknown> }
  return { ...(currentProject || body.updates), ...body.updates, revision: body.revision + 1 }
}
