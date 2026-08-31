import { expect, test, type APIRequestContext } from '@playwright/test'
import { completedPromptCardCalls, runRealCodexPrompt } from './support/real-codex-host'

const storageUrl = 'http://127.0.0.1:38102'
const repositoryScope = 'real-codex-e2e'
const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
  'base64'
)

test('a real Codex host discovers PromptCard without prior internal schema knowledge', async ({ request }) => {
  test.skip(process.env.PROMPTCARD_REAL_CODEX_ACCEPTANCE !== '1', 'requires an explicit real Codex acceptance run')
  test.setTimeout(300_000)
  let fixture: Awaited<ReturnType<typeof createDiscoveryFixture>> | null = null
  try {
    fixture = await createDiscoveryFixture(request)
    const run = await runRealCodexPrompt([
      'You are a newly connected external creative Agent. You have no prior knowledge of PromptCard internal schemas.',
      'Do not inspect repository files and do not use shell, browser, or non-PromptCard tools.',
      `Discover the available PromptCard environment for project ${fixture.projectCode} and context ${fixture.cvcCode}.`,
      'Follow the environment’s own progressive-disclosure guidance before doing anything else.',
      'Then inspect every exact creative object in the context, read every exact approved Skill pin,',
      `search bounded Prompt evidence using the exact marker “${fixture.searchMarker}”, resolve that exact Prompt result,`,
      'and read one authorized image asset. Do not create or commit any proposal in this turn.',
      'Finish with a concise summary of only the actual public codes you successfully read.'
    ].join(' '))
    const calls = completedPromptCardCalls(run)
    const tools = calls.map(call => call?.tool)
    expect(tools[0]).toBe('promptcard_runtime_describe')
    expect(tools[1]).toBe('promptcard_workspace_describe')
    expect(tools).toContain('promptcard_skill_read')
    expect(tools).toContain('promptcard_reference_resolve')
    expect(tools).toContain('promptcard_prompt_search')
    expect(tools).toContain('promptcard_asset_read')
    const failedCalls = calls.filter(call => call?.status !== 'completed')
    expect(failedCalls, JSON.stringify(failedCalls, null, 2)).toEqual([])
    expect(resultText(calls, 'promptcard_skill_read')).toContain('Keep cause-and-effect explicit')
    expect(resultText(calls, 'promptcard_workspace_describe')).toContain(fixture.sourceCode)
    expect(resultText(calls, 'promptcard_prompt_search')).toContain(fixture.promptCode)
    expect(resultText(calls, 'promptcard_asset_read')).toContain(fixture.imageCode)
  } finally {
    if (fixture) await cleanupDiscoveryFixture(request, fixture)
  }
})

const createDiscoveryFixture = async (request: APIRequestContext) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const searchMarker = `RainSignal${suffix.replace(/[^a-z0-9]/gi, '')}`
  const assetResponse = await request.post(`${storageUrl}/api/assets`, {
    data: fixturePng,
    headers: { 'content-type': 'image/png', 'x-file-name': `real-codex-${suffix}.png` }
  })
  expect(assetResponse.ok(), await assetResponse.text()).toBe(true)
  const asset = await assetResponse.json() as { id: string }
  const presetResponse = await request.post(`${storageUrl}/api/presets`, {
    data: {
      type: 'custom', category: 'storyboard', label: `Rain station ${searchMarker}`,
      content: `Rain cuts across an empty station platform while the last train departs. ${searchMarker}`,
      meta: {}
    }
  })
  expect(presetResponse.ok(), await presetResponse.text()).toBe(true)
  const preset = await presetResponse.json() as { id: string; referenceCode: string }
  const projectId = `real-codex-discovery-${suffix}`
  const projectResponse = await request.post(`${storageUrl}/api/projects`, {
    data: {
      id: projectId, title: `Real Codex discovery ${suffix}`, type: 'free-canvas',
      pages: [], currentPage: 0, meta: {},
      freeCanvas: {
        nodes: [
          {
            id: 'script-source', kind: 'text', title: 'Rain station source',
            position: { x: 120, y: 120 }, width: 420, height: 180, fontSize: 'large',
            segments: [{
              id: 'source', source: 'user', text: 'EXT. STATION PLATFORM — RAIN — NIGHT',
              color: '#111827', createdAt: 1, updatedAt: 1
            }],
            promptLibraryReferences: [preset.referenceCode], meta: {}
          },
          {
            id: 'visual-source', kind: 'image', title: 'Rain station reference',
            position: { x: 580, y: 120 }, width: 320, height: 240,
            assetId: asset.id, annotations: [], meta: { generationState: 'succeeded' }
          }
        ],
        edges: [], selectedNodeId: 'script-source', viewport: { x: 0, y: 0, zoom: 1 }, meta: {}
      }
    }
  })
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true)
  const project = await projectResponse.json() as {
    referenceCode: string
    revision: number
    freeCanvas: { nodes: Array<{ referenceCode: string }> }
  }
  const [sourceCode, imageCode] = project.freeCanvas.nodes.map(node => node.referenceCode)
  const contextResponse = await request.post(`${storageUrl}/api/context-packs`, {
    data: {
      projectCode: project.referenceCode,
      projectRevision: project.revision,
      nodeCodes: [sourceCode, imageCode],
      placementHint: { mode: 'after-selection', anchorNodeCodes: [sourceCode, imageCode] },
      creator: 'real-codex-acceptance'
    }
  })
  expect(contextResponse.ok(), await contextResponse.text()).toBe(true)
  const context = await contextResponse.json() as { cvcCode: string }
  const skillId = `real-codex-skill-${suffix}`
  const skillResponse = await request.post(`${storageUrl}/api/skills`, {
    data: {
      id: skillId,
      slug: `story-planning-${suffix}`,
      name: 'Real Codex Story Planning',
      description: 'A bounded acceptance Skill for story planning.',
      source: 'external',
      trustState: 'trusted',
      instructions: 'Keep cause-and-effect explicit. Preserve human review for every creative write.',
      declaredCapabilities: { tools: [] }
    }
  })
  expect(skillResponse.ok(), await skillResponse.text()).toBe(true)
  const skill = await skillResponse.json() as { referenceCode: string }
  const pinResponse = await request.put(`${storageUrl}/api/skills/${skill.referenceCode}/host-pins/codex`, {
    data: {
      enabled: true, revision: 1, repositoryScope,
      publicationName: `real-codex-story-planning-${suffix}`
    }
  })
  expect(pinResponse.ok(), await pinResponse.text()).toBe(true)
  return {
    projectId,
    projectCode: project.referenceCode,
    sourceCode,
    imageCode,
    cvcCode: context.cvcCode,
    promptId: preset.id,
    promptCode: preset.referenceCode,
    searchMarker,
    assetId: asset.id,
    skillCode: skill.referenceCode
  }
}

const cleanupDiscoveryFixture = async (
  request: APIRequestContext,
  fixture: Awaited<ReturnType<typeof createDiscoveryFixture>>
) => {
  const disable = await request.put(`${storageUrl}/api/skills/${fixture.skillCode}/host-pins/codex`, {
    data: { enabled: false, revision: 1, repositoryScope }
  })
  expect(disable.ok(), await disable.text()).toBe(true)
  const archive = await request.post(`${storageUrl}/api/skills/${fixture.skillCode}/archive`)
  expect(archive.ok(), await archive.text()).toBe(true)
  const revoke = await request.post(`${storageUrl}/api/context-packs/${fixture.cvcCode}/revoke`, {
    data: { actor: 'real-codex-acceptance', reason: 'test-cleanup' }
  })
  expect(revoke.ok(), await revoke.text()).toBe(true)
  const trashProject = await request.post(`${storageUrl}/api/projects/trash`, {
    data: { ids: [fixture.projectId], deletedBy: 'user', deleteReason: 'real-codex-acceptance-cleanup' }
  })
  expect(trashProject.ok(), await trashProject.text()).toBe(true)
  const deleteProject = await request.delete(`${storageUrl}/api/projects/trash`, { data: { ids: [fixture.projectId] } })
  expect(deleteProject.ok(), await deleteProject.text()).toBe(true)
  const trashPreset = await request.post(`${storageUrl}/api/presets/trash`, {
    data: { ids: [fixture.promptId], deletedBy: 'user', deleteReason: 'real-codex-acceptance-cleanup' }
  })
  expect(trashPreset.ok(), await trashPreset.text()).toBe(true)
  const deletePreset = await request.delete(`${storageUrl}/api/presets/trash`, { data: { ids: [fixture.promptId] } })
  expect(deletePreset.ok(), await deletePreset.text()).toBe(true)
  const trashAsset = await request.post(`${storageUrl}/api/storage/artifacts/trash`, {
    data: { ids: [fixture.assetId], deletedBy: 'user' }
  })
  expect(trashAsset.ok(), await trashAsset.text()).toBe(true)
  const deleteAsset = await request.post(`${storageUrl}/api/storage/artifacts/delete-forever`, {
    data: { ids: [fixture.assetId] }
  })
  expect(deleteAsset.ok(), await deleteAsset.text()).toBe(true)
}

const resultText = (
  calls: ReturnType<typeof completedPromptCardCalls>,
  tool: string
): string => calls.find(call => call?.tool === tool)?.result?.content
  ?.map(item => item.text || '').join('\n') || ''
