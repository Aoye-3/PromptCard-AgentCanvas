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
        media: [{
          id: 'internal-media-id',
          kind: 'image',
          source: 'asset',
          assetId: asset.id,
          title: 'Reference frame'
        }]
      }
    }
  })
  expect(createResponse.ok(), await createResponse.text()).toBe(true)
  const preset = await createResponse.json()
  const mediaCode = preset.meta.media[0].referenceCode as string
  expect(preset.referenceCode).toMatch(/^PLP-/)
  expect(mediaCode).toMatch(/^PLM-/)

  const trashResponse = await request.post(`${storageUrl}/api/presets/trash`, { data: { ids: [preset.id], deletedBy: 'user' } })
  expect(trashResponse.ok(), await trashResponse.text()).toBe(true)
  const trash = await request.get(`${storageUrl}/api/presets/trash`)
  expect(trash.ok(), await trash.text()).toBe(true)
  expect((await trash.json()).items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: preset.id,
      payload: expect.objectContaining({ referenceCode: preset.referenceCode })
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

  await card.getByRole('button', { name: '复制 Prompt 编码' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(preset.referenceCode)

  await card.click()
  const dialog = page.getByRole('button', { name: '复制媒体编码：Reference frame' })
  await expect(dialog).toBeVisible()
  await dialog.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(mediaCode)
  expect(consoleErrors).toEqual([])
})
