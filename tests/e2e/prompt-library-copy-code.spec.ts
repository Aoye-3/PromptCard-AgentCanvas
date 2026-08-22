import { expect, test } from '@playwright/test'

const storageUrl = 'http://127.0.0.1:38102'
const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWgAAAAjSURBVHicY/z//z8DJYARjGJkYGBgYIABJgYGBgYGhjEwMAAA0gQGd5GOYQAAAABJRU5ErkJggg==',
  'base64'
)

test('Prompt Library copies prompt and media reference codes without exposing internal IDs', async ({ context, page, request }) => {
  const label = `编码复制 ${Date.now()}`
  const assetResponse = await request.post(`${storageUrl}/api/assets`, {
    data: fixturePng,
    headers: { 'content-type': 'image/png', 'x-file-name': 'reference-frame.png' }
  })
  expect(assetResponse.ok(), await assetResponse.text()).toBe(true)
  const asset = await assetResponse.json()
  const createResponse = await request.post(`${storageUrl}/api/presets`, {
    data: {
      type: 'custom',
      category: 'custom',
      label,
      content: 'This is prompt content, not an external reference code.',
      meta: {
        media: [
          {
            id: 'internal-media-id',
            kind: 'image',
            source: 'asset',
            assetId: asset.id,
            title: 'Reference frame'
          },
          {
            id: 'internal-media-id-2',
            kind: 'image',
            source: 'asset',
            assetId: asset.id,
            title: 'Second reference'
          }
        ]
      }
    }
  })
  expect(createResponse.ok(), await createResponse.text()).toBe(true)
  const preset = await createResponse.json()
  const mediaCodes = preset.meta.media.map((item: { referenceCode: string }) => item.referenceCode)
  expect(preset.referenceCode).toMatch(/^PLP-/)
  expect(mediaCodes).toEqual([expect.stringMatching(/^PLM-/), expect.stringMatching(/^PLM-/)])

  const trashResponse = await request.post(`${storageUrl}/api/presets/trash`, { data: { ids: [preset.id], deletedBy: 'user' } })
  expect(trashResponse.ok(), await trashResponse.text()).toBe(true)
  const trash = await request.get(`${storageUrl}/api/presets/trash`)
  expect(trash.ok(), await trash.text()).toBe(true)
  expect((await trash.json()).items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: preset.id,
      payload: expect.objectContaining({
        referenceCode: preset.referenceCode,
        meta: expect.objectContaining({ media: expect.arrayContaining([
          expect.objectContaining({ referenceCode: mediaCodes[0] }),
          expect.objectContaining({ referenceCode: mediaCodes[1] })
        ]) })
      })
    })
  ]))
  const restoreResponse = await request.post(`${storageUrl}/api/presets/trash/restore`, { data: { ids: [preset.id] } })
  expect(restoreResponse.ok(), await restoreResponse.text()).toBe(true)
  await expect(restoreResponse.json()).resolves.toMatchObject({
    presets: [expect.objectContaining({ referenceCode: preset.referenceCode })]
  })

  const consoleErrors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.locator('[data-app-nav-tab="library"]').click()
  const card = page.getByText(label, { exact: true }).locator('xpath=ancestor::*[@role="button"]')
  await expect(card).toBeVisible()

  const listCodeButton = card.getByRole('button', { name: '复制 Prompt 编码' })
  await listCodeButton.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(preset.referenceCode)
  await expect(page.getByRole('button', { name: '关闭预览' })).toHaveCount(0)
  await listCodeButton.focus()
  await page.keyboard.press('Space')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(preset.referenceCode)
  await expect(page.getByRole('button', { name: '关闭预览' })).toHaveCount(0)
  await listCodeButton.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(preset.referenceCode)
  await expect(page.getByRole('button', { name: '关闭预览' })).toHaveCount(0)

  await card.click()
  const firstMediaCodeButton = page.getByRole('button', { name: '复制媒体编码：Reference frame' })
  const secondMediaCodeButton = page.getByRole('button', { name: '复制媒体编码：Second reference' })
  await expect(firstMediaCodeButton).toBeVisible()
  await expect(secondMediaCodeButton).toBeVisible()
  await firstMediaCodeButton.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(mediaCodes[0])
  await expect(page.getByRole('button', { name: '关闭预览' })).toBeVisible()

  await page.evaluate(() => {
    const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard)
    let failuresRemaining = 1
    Object.defineProperty(globalThis, '__promptLibraryCopyFailures', {
      configurable: true,
      get: () => failuresRemaining,
      set: (value: number) => {
        failuresRemaining = value
      }
    })
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1
          throw new DOMException('clipboard denied', 'NotAllowedError')
        }
        return originalWriteText(text)
      }
    })
  })

  await firstMediaCodeButton.click()
  const firstRetry = page.getByRole('button', { name: '重试复制媒体编码：Reference frame' })
  await expect(page.getByRole('alert')).toContainText('复制媒体编码失败')
  await firstRetry.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(mediaCodes[0])
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '关闭预览' })).toBeVisible()

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __promptLibraryCopyFailures: number }).__promptLibraryCopyFailures = 1
  })
  await secondMediaCodeButton.click()
  const secondRetry = page.getByRole('button', { name: '重试复制媒体编码：Second reference' })
  await expect(page.getByRole('alert')).toContainText('复制媒体编码失败')
  await secondRetry.focus()
  await page.keyboard.press('Space')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(mediaCodes[1])
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '关闭预览' })).toBeVisible()

  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 720 })
    await expect(page.getByRole('button', { name: '复制 Prompt 编码' }).last()).toBeVisible()
    await expect(firstMediaCodeButton).toBeVisible()
    await expect(secondMediaCodeButton).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await secondMediaCodeButton.click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(mediaCodes[1])
  }
  expect(consoleErrors).toEqual([])
})
