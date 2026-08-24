import { expect, test, type Route } from '@playwright/test'

const referenceCode = 'SKL-01ARZ3NDEKTSV4RRFFQ69G5FAW'
const digestOne = `sha256:${'1'.repeat(64)}`
const digestTwo = `sha256:${'2'.repeat(64)}`

const summary = {
  id: 'skill-tone', referenceCode, slug: 'tone-helper', name: 'Tone Helper',
  description: 'External writing helper.', source: 'external', trustState: 'untrusted',
  capabilityId: 'tone.helper', toolDependencies: ['search_prompt_library'], revision: 2,
  digest: digestTwo, lifecycleStatus: 'active'
}

const revisionTwo = {
  revision: 2, digest: digestTwo, instructions: 'New instructions', references: ['PLP-NEW'],
  createdAt: 20, provenance: { sourceKind: 'external', originLabel: 'tone-v2.zip' },
  declaredCapabilities: { tools: ['search_prompt_library'] }, trustReview: null,
  entries: [
    { type: 'instruction', path: 'SKILL.md', contentType: 'text/markdown', size: 20, digest: digestTwo },
    { type: 'reference', path: 'references/new.md', contentType: 'text/markdown', size: 10, digest: digestOne }
  ]
}

const revisionOne = {
  revision: 1, digest: digestOne, instructions: 'Old instructions', references: [],
  createdAt: 10, provenance: { sourceKind: 'external', originLabel: 'tone-v1.zip' },
  declaredCapabilities: { tools: [] }, trustReview: { state: 'trusted', digest: digestOne, reviewedAt: 11 },
  entries: [{ type: 'instruction', path: 'SKILL.md', contentType: 'text/markdown', size: 18, digest: digestOne }]
}

test('reviews import/history/trust and keeps local-Agent/Codex recovery independent', async ({ page }) => {
  let detail = { ...summary, currentRevision: 2, archivedAt: null, revisions: [revisionTwo, revisionOne] }
  const hostUpdates: Array<{ host: string; body: Record<string, unknown> }> = []
  let repairs = 0
  let inspections = 0
  let importBody: Record<string, unknown> | null = null

  const localPin = {
    skillId: summary.id, skillReferenceCode: referenceCode, host: 'local-agent', scope: '',
    enabled: true, revision: 1, digest: digestOne, projection: null, updatedAt: 30
  }
  const codexPin = {
    skillId: summary.id, skillReferenceCode: referenceCode, host: 'codex', scope: 'local-repository',
    enabled: true, revision: 2, digest: digestTwo, projection: { publicationName: 'tone-helper' },
    projectionHealth: { state: 'unhealthy', code: 'codex_projection_drift' }, updatedAt: 31
  }

  await page.route('**/storage-api/skill-hosts', route => json(route, {
    hosts: [
      { id: 'local-agent', label: 'Local Agent', scopes: [''] },
      { id: 'codex', label: 'Codex .agents/skills', scopes: ['local-repository'] }
    ]
  }))
  await page.route('**/storage-api/skill-package-inspections/folder', async route => {
    inspections += 1
    if (inspections === 1) {
      return json(route, {
        inspectionId: 'inspection-blocked', clean: false,
        manifest: { digest: digestOne, entryCount: 1, totalBytes: 10, entries: [] },
        findings: [{ code: 'package.inert_manifest', severity: 'error', blocking: true, path: 'package.json', message: 'Executable package metadata is not allowed' }]
      })
    }
    return json(route, {
      inspectionId: 'inspection-clean', clean: true,
      manifest: { digest: digestTwo, entryCount: 1, totalBytes: 12, entries: [
        { type: 'instruction', path: 'SKILL.md', contentType: 'text/markdown', size: 12, digest: digestTwo }
      ] }, findings: []
    })
  })
  await page.route('**/storage-api/skill-package-imports', async route => {
    importBody = route.request().postDataJSON()
    return json(route, { inspectionId: 'inspection-clean', skill: { id: 'new-skill', referenceCode: 'SKL-NEW', revision: 1, digest: digestTwo, lifecycleStatus: 'active' } })
  })
  await page.route('**/storage-api/skills**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (request.method() === 'GET' && path.endsWith('/storage-api/skills')) return json(route, { skills: [summary] })
    if (request.method() === 'GET' && path.endsWith(`/storage-api/skills/${referenceCode}`)) return json(route, detail)
    if (request.method() === 'GET' && path.includes('/host-pins/local-agent')) return json(route, localPin)
    if (request.method() === 'GET' && path.includes('/host-pins/codex')) return json(route, codexPin)
    if (request.method() === 'POST' && path.endsWith('/review')) {
      detail = {
        ...detail,
        trustState: 'trusted',
        revisions: [{ ...revisionTwo, trustReview: { state: 'trusted', digest: digestTwo, reviewedAt: 40 } }, revisionOne]
      }
      return json(route, detail)
    }
    if (request.method() === 'PUT' && path.includes('/host-pins/')) {
      const host = path.endsWith('/codex') ? 'codex' : 'local-agent'
      const body = request.postDataJSON() as Record<string, unknown>
      hostUpdates.push({ host, body })
      return json(route, { ...(host === 'codex' ? codexPin : localPin), ...body })
    }
    if (request.method() === 'POST' && path.endsWith('/host-pins/codex/repair')) {
      repairs += 1
      return json(route, { ...codexPin, projectionHealth: { state: 'healthy' } })
    }
    if (request.method() === 'POST' && path.endsWith('/archive')) {
      detail = { ...detail, lifecycleStatus: 'archived', archivedAt: 50 }
      return json(route, detail)
    }
    if (request.method() === 'POST' && path.endsWith('/restore')) {
      detail = { ...detail, lifecycleStatus: 'active', archivedAt: null }
      return json(route, detail)
    }
    return route.abort()
  })

  await page.goto('/', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'SkillHub' }).click()
  await expect(page.getByRole('heading', { name: 'SkillHub' })).toBeVisible()
  await expect(page.getByText('导入只做惰性检查，不执行脚本、hook 或安装器。')).toBeVisible()

  await page.getByRole('button', { name: 'Tone Helper' }).click()
  const drawer = page.getByRole('dialog', { name: 'Tone Helper 详情' })
  await expect(drawer).toContainText('Revision 历史')
  await expect(drawer).toContainText('Codex .agents/skills 投影')
  await expect(drawer).toContainText('codex_projection_drift')
  await drawer.getByRole('button', { name: '批准 revision 2' }).click()
  await expect(drawer.getByText('trusted').first()).toBeVisible()

  await drawer.getByLabel('本地 Agent revision').selectOption('2')
  await drawer.getByRole('button', { name: '应用本地 Agent 设置' }).click()
  await expect.poll(() => hostUpdates.length).toBe(1)
  expect(hostUpdates).toEqual([{ host: 'local-agent', body: { enabled: true, revision: 2 } }])

  await drawer.getByRole('button', { name: '修复 Codex 投影' }).click()
  await expect.poll(() => repairs).toBe(1)
  await expect(drawer.getByText('codex_projection_drift')).toHaveCount(0)

  await drawer.getByRole('button', { name: '归档 Skill' }).click()
  await expect(drawer).toContainText('先恢复，再调整 Host')
  await drawer.getByRole('button', { name: '恢复 Skill' }).click()
  expect(hostUpdates).toHaveLength(1)
  await drawer.getByRole('button', { name: '关闭 Skill 详情' }).click()

  await page.getByRole('button', { name: '导入 Skill' }).click()
  const importer = page.getByRole('dialog', { name: '导入 Skill' })
  await importer.getByLabel('Skill 文件夹路径').fill('F:\\skills\\unsafe')
  await importer.getByRole('button', { name: '仅检查，不导入' }).click()
  await expect(importer).toContainText('package.inert_manifest')
  await expect(importer.getByRole('button', { name: '确认导入' })).toBeDisabled()

  await importer.getByLabel('Skill 文件夹路径').fill('F:\\skills\\clean')
  await importer.getByRole('button', { name: '仅检查，不导入' }).click()
  await expect(importer).toContainText('只显示冻结快照的元数据，不加载或执行条目内容。')
  await importer.getByRole('button', { name: '确认导入' }).click()
  await expect.poll(() => importBody).not.toBeNull()
  expect(importBody).toEqual({ inspectionId: 'inspection-clean', operation: 'create', skill: { originLabel: 'F:\\skills\\clean' } })
})

const json = (route: Route, body: unknown) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body)
})
