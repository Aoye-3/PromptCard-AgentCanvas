import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const storageUrl = 'http://127.0.0.1:38102'

test('copies project and typed Canvas node codes without changing Canvas workspace state', async ({ context, page, request }) => {
  const suffix = Date.now()
  const projectId = `copy-code-${suffix}`
  const title = `Copy code ${suffix}`
  let created = false

  try {
    const createResponse = await request.post(`${storageUrl}/api/projects`, {
      data: taskProject(projectId, title)
    })
    expect(createResponse.ok(), await createResponse.text()).toBe(true)
    created = true
    const stored = await createResponse.json()
    const projectCode = stored.referenceCode as string
    const textCode = stored.freeCanvas.nodes[0].referenceCode as string
    const imageCode = stored.freeCanvas.nodes[1].referenceCode as string
    expect(projectCode).toMatch(/^PRJ-/)
    expect(textCode).toMatch(/^CVT-/)
    expect(imageCode).toMatch(/^CVM-/)
    expect(stored.freeCanvas.nodes[2].referenceCode).toBeUndefined()

    const consoleErrors: string[] = []
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/', { waitUntil: 'networkidle' })
    await openProject(page, title)

    const projectWrites: string[] = []
    page.on('request', requestEvent => {
      if (/\/storage-api\/projects(?:\/[^/]+)?$/.test(requestEvent.url()) && requestEvent.method() !== 'GET') {
        projectWrites.push(`${requestEvent.method()} ${requestEvent.url()}`)
      }
    })
    const projectCopy = page.getByRole('button', { name: /^复制项目代码：/ })
    await expect(projectCopy).toBeVisible()
    await projectCopy.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => clipboardText(page)).toBe(projectCode)
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)
    await expect(page.getByText('可以直接修改当前画布')).toBeVisible()

    const textNode = page.getByTestId('rf__node-task9-text')
    await expect(textNode).toBeVisible()
    await textNode.click({ button: 'right' })
    const textCopy = page.getByRole('menuitem', { name: /^复制节点代码：文字节点/ })
    await expect(textCopy).toBeVisible()
    await textCopy.focus()
    await page.keyboard.press('Space')
    await expect.poll(() => clipboardText(page)).toBe(textCode)
    await expect(textNode).toHaveClass(/selected/)
    await expect(page.locator('[data-free-canvas-text-node] [contenteditable="true"]')).toHaveCount(0)
    await expect(page.getByRole('menu', { name: '文字节点菜单' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: '文字节点菜单' })).toHaveCount(0)

    const imageNode = page.getByTestId('rf__node-task9-image')
    await expect(imageNode).toBeVisible()
    await imageNode.click({ button: 'right' })
    const imageCopy = page.getByRole('menuitem', { name: /^复制节点代码：图片节点/ })
    await expect(imageCopy).toBeVisible()
    await page.evaluate(() => {
      const original = navigator.clipboard.writeText.bind(navigator.clipboard)
      let failures = 1
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (text: string) => {
          if (failures > 0) {
            failures -= 1
            throw new DOMException('clipboard denied', 'NotAllowedError')
          }
          return original(text)
        }
      })
    })
    await imageCopy.click()
    await expect(page.getByRole('alert')).toContainText('复制节点代码失败')
    await page.getByRole('menuitem', { name: /^重试复制节点代码：图片节点/ }).click()
    await expect.poll(() => clipboardText(page)).toBe(imageCode)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(imageNode).toHaveClass(/selected/)
    await expect(page.getByText('可以直接修改当前画布')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.keyboard.press('Escape')

    const arrowNode = page.getByTestId('rf__node-task9-arrow')
    await expect(arrowNode).toBeVisible()
    await arrowNode.click({ button: 'right' })
    const unsupportedCopy = page.getByRole('menuitem', { name: /^复制节点代码：箭头节点/ })
    await expect(unsupportedCopy).toBeDisabled()
    await expect(page.getByRole('status')).toContainText('箭头节点不支持节点代码')
    await expect(arrowNode).toHaveClass(/selected/)
    await page.keyboard.press('Escape')

    for (const width of [320, 768]) {
      await page.setViewportSize({ width, height: 720 })
      await expect(projectCopy).toBeVisible()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await textNode.click({ button: 'right' })
      await expect(page.getByRole('menuitem', { name: /^复制节点代码：文字节点/ })).toBeVisible()
      await page.keyboard.press('Escape')
    }

    await expect.poll(() => projectWrites).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally {
    if (created) await deleteProjectFixture(request, projectId)
  }
})

const taskProject = (id: string, title: string) => ({
  id,
  title,
  type: 'free-canvas',
  pages: [],
  currentPage: 0,
  meta: {},
  freeCanvas: {
    nodes: [
      {
        id: 'task9-text', kind: 'text', title: 'Task 9 text', position: { x: 120, y: 120 },
        width: 420, height: 180, fontSize: 'large',
        segments: [{
          id: 'task9-segment', source: 'user', text: 'Task 9 text content', color: '#111827',
          createdAt: 1, updatedAt: 1
        }],
        meta: {}
      },
      {
        id: 'task9-image', kind: 'image', title: 'Task 9 image', position: { x: 620, y: 120 },
        width: 320, height: 240, assetId: 'task9-placeholder.png', annotations: [],
        meta: { generationState: 'succeeded' }
      },
      {
        id: 'task9-arrow', kind: 'arrow', title: 'Task 9 arrow', position: { x: 420, y: 440 },
        width: 180, height: 60, text: 'Task 9 arrow', color: '#111827', meta: {}
      }
    ],
    edges: [],
    selectedNodeId: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    meta: {}
  }
})

const clipboardText = (page: Page): Promise<string> => page.evaluate(() => navigator.clipboard.readText())

const openProject = async (page: Page, title: string) => {
  const card = page.getByText(title, { exact: true }).locator('xpath=ancestor::article')
  await expect(card).toBeVisible({ timeout: 60_000 })
  await card.getByRole('button', { name: 'Open project' }).click()
  await expect(page.locator('[data-free-canvas-screen]')).toBeVisible()
}

const deleteProjectFixture = async (request: APIRequestContext, id: string) => {
  const trash = await request.post(`${storageUrl}/api/projects/trash`, {
    data: { ids: [id], deletedBy: 'user', deleteReason: 'task9-e2e-cleanup' }
  })
  if (!trash.ok()) return
  await request.delete(`${storageUrl}/api/projects/trash`, { data: { ids: [id] } })
}
