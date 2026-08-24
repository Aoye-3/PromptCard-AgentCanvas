import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  reviewRevision: vi.fn(),
  getHostPin: vi.fn(),
  updateHostPin: vi.fn(),
  repairCodexProjection: vi.fn(),
  inspectFolder: vi.fn(),
  inspectArchive: vi.fn(),
  importInspected: vi.fn(),
  describeHosts: vi.fn()
}))

vi.mock('@/storage/storage-service-client', async importOriginal => {
  const original = await importOriginal<typeof import('@/storage/storage-service-client')>()
  return {
    ...original,
    storageServiceClient: {
      ...original.storageServiceClient,
      skills: mocks
    }
  }
})

import { SkillHubScreen } from './SkillHubScreen'

const summary = {
  id: 'SKL-tone',
  slug: 'tone-helper',
  name: 'Tone Helper',
  description: 'External writing helper.',
  source: 'external' as const,
  trustState: 'trusted' as const,
  toolDependencies: ['search_prompt_library'],
  revision: 2,
  digest: 'sha256:two',
  referenceCode: 'SKL-01ARZ3NDEKTSV4RRFFQ69G5FAW',
  lifecycleStatus: 'active' as const
}

const detail = {
  ...summary,
  currentRevision: 2,
  archivedAt: null,
  revisions: [
    {
      revision: 2,
      digest: 'sha256:two',
      instructions: 'New instructions',
      references: ['PLP-NEW'],
      createdAt: 20,
      provenance: { sourceKind: 'external', originLabel: 'tone-v2.zip' },
      declaredCapabilities: { tools: ['search_prompt_library'] },
      trustReview: { state: 'trusted', reviewedAt: 21 },
      entries: [
        { type: 'instruction', path: 'SKILL.md', contentType: 'text/markdown', size: 20, digest: 'sha256:skill-two' },
        { type: 'reference', path: 'references/new.md', contentType: 'text/markdown', size: 10, digest: 'sha256:new' }
      ]
    },
    {
      revision: 1,
      digest: 'sha256:one',
      instructions: 'Old instructions',
      references: [],
      createdAt: 10,
      provenance: { sourceKind: 'external', originLabel: 'tone-v1.zip' },
      declaredCapabilities: { tools: [] },
      trustReview: { state: 'trusted', reviewedAt: 11 },
      entries: [
        { type: 'instruction', path: 'SKILL.md', contentType: 'text/markdown', size: 18, digest: 'sha256:skill-one' }
      ]
    }
  ]
}

const localPin = {
  skillId: summary.id,
  skillReferenceCode: summary.referenceCode,
  host: 'local-agent' as const,
  scope: '',
  enabled: true,
  revision: 1,
  digest: 'sha256:one',
  projection: null,
  updatedAt: 30
}

const codexPin = {
  skillId: summary.id,
  skillReferenceCode: summary.referenceCode,
  host: 'codex' as const,
  scope: 'local-repository',
  enabled: true,
  revision: 2,
  digest: 'sha256:two',
  projection: { publicationName: 'tone-helper' },
  projectionHealth: { state: 'unhealthy', code: 'codex_projection_drift' },
  updatedAt: 31
}

const alternateCodexPin = {
  ...codexPin,
  scope: 'alternate-repository',
  revision: 1,
  digest: 'sha256:one',
  projection: { publicationName: 'tone-helper-alt' },
  updatedAt: 32
}

const thirdCodexPin = {
  ...codexPin,
  scope: 'third-repository',
  projection: { publicationName: 'tone-helper-third' },
  updatedAt: 33
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

const textOf = (node: ReactTestInstance) => node.children.filter(child => typeof child === 'string').join('')
const button = (root: ReactTestInstance, label: string) => root.findAllByType('button').find(node =>
  node.props['aria-label'] === label || textOf(node).includes(label)
)
const input = (root: ReactTestInstance, label: string) => root.findAll(node =>
  node.type === 'input' && node.props['aria-label'] === label
)[0]

async function renderHub() {
  let renderer: ReactTestRenderer
  await act(async () => {
    renderer = create(<SkillHubScreen initialSkills={[summary]} />)
  })
  return renderer!
}

async function openDetail(renderer: ReactTestRenderer) {
  await act(async () => button(renderer.root, 'Tone Helper')?.props.onClick())
}

describe('SkillHubScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.get.mockResolvedValue(detail)
    mocks.describeHosts.mockResolvedValue([
      { id: 'local-agent', label: 'Local Agent', scopes: [''] },
      { id: 'codex', label: 'Codex .agents/skills', scopes: ['local-repository', 'alternate-repository', 'third-repository'] }
    ])
    mocks.getHostPin.mockImplementation((_id: string, host: string, scope?: string) => Promise.resolve(
      host === 'codex'
        ? (scope === 'alternate-repository' ? alternateCodexPin : scope === 'third-repository' ? thirdCodexPin : codexPin)
        : localPin
    ))
    mocks.updateHostPin.mockImplementation((_id: string, host: string, payload: Record<string, unknown>) => Promise.resolve({
      ...(host === 'codex' ? codexPin : localPin), enabled: payload.enabled, revision: payload.revision
    }))
    mocks.repairCodexProjection.mockResolvedValue({ ...codexPin, projectionHealth: { state: 'healthy' } })
    mocks.archive.mockResolvedValue({ ...detail, lifecycleStatus: 'archived', archivedAt: 40 })
    mocks.restore.mockResolvedValue(detail)
  })

  it('shows builtin and external skill metadata without script execution controls', async () => {
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(<SkillHubScreen initialSkills={[
        {
          id: 'SKL-canvas', slug: 'canvas-prompt-editor', name: 'Canvas Prompt Editor',
          description: 'Protects template segments.', source: 'builtin', trustState: 'first-party',
          capabilityId: 'canvas.prompt.edit', toolDependencies: ['emit_canvas_text_update'],
          revision: 1, digest: 'sha256:canvas',
          referenceCode: 'SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV', lifecycleStatus: 'active'
        },
        summary
      ]} />)
    })
    const markup = JSON.stringify(renderer!.toJSON())
    expect(markup).toContain('SkillHub')
    expect(markup).toContain('Canvas Prompt Editor')
    expect(markup).toContain('Tone Helper')
    expect(markup).toContain('emit_canvas_text_update')
    expect(markup).toContain('first-party')
    expect(markup).not.toContain('运行脚本')
  })

  it('loads revision history, diff, trust state, and independent host pins', async () => {
    const renderer = await renderHub()
    await openDetail(renderer)
    const markup = JSON.stringify(renderer.toJSON())
    expect(mocks.get).toHaveBeenCalledWith(summary.referenceCode)
    expect(mocks.getHostPin).toHaveBeenCalledWith(summary.referenceCode, 'local-agent', undefined)
    expect(mocks.getHostPin).toHaveBeenCalledWith(summary.referenceCode, 'codex', 'local-repository')
    expect(markup).toContain('Revision 历史')
    expect(markup).toContain('revision 2')
    expect(markup).toContain('references/new.md')
    expect(markup).toContain('本地 Agent')
    expect(markup).toContain('Codex .agents/skills 投影')
    expect(markup).toContain('codex_projection_drift')
  })

  it('updates only the selected host pin and preserves its independent revision', async () => {
    const renderer = await renderHub()
    await openDetail(renderer)
    const localRevision = renderer.root.findAll(node => node.type === 'select' && node.props['aria-label'] === '本地 Agent revision')[0]
    await act(async () => localRevision.props.onChange({ target: { value: '2' } }))
    await act(async () => button(renderer.root, '应用本地 Agent 设置')?.props.onClick())
    expect(mocks.updateHostPin).toHaveBeenCalledTimes(1)
    expect(mocks.updateHostPin).toHaveBeenCalledWith(summary.referenceCode, 'local-agent', { enabled: true, revision: 2 })
  })

  it('offers explicit repair recovery for a drifted Codex projection', async () => {
    const renderer = await renderHub()
    await openDetail(renderer)
    await act(async () => button(renderer.root, '修复 Codex 投影')?.props.onClick())
    expect(mocks.repairCodexProjection).toHaveBeenCalledWith(summary.referenceCode, {
      repositoryScope: 'local-repository', expectedRevision: 2, expectedDigest: 'sha256:two'
    })
  })

  it('loads and operates on each configured Codex repository scope independently', async () => {
    const renderer = await renderHub()
    await openDetail(renderer)
    const scope = renderer.root.findAll(node => node.type === 'select' && node.props['aria-label'] === 'Codex repository scope')[0]

    await act(async () => scope.props.onChange({ target: { value: 'alternate-repository' } }))

    expect(mocks.getHostPin).toHaveBeenCalledWith(summary.referenceCode, 'codex', 'alternate-repository')
    expect(JSON.stringify(renderer.toJSON())).toContain('tone-helper-alt')
    await act(async () => button(renderer.root, '修复 Codex 投影')?.props.onClick())
    expect(mocks.repairCodexProjection).toHaveBeenCalledWith(summary.referenceCode, {
      repositoryScope: 'alternate-repository', expectedRevision: 1, expectedDigest: 'sha256:one'
    })
  })

  it('locks host actions during scope loads and ignores stale scope responses', async () => {
    const alternate = deferred<typeof alternateCodexPin>()
    const third = deferred<typeof thirdCodexPin>()
    mocks.getHostPin.mockImplementation((_id: string, host: string, scope?: string) => {
      if (host !== 'codex') return Promise.resolve(localPin)
      if (scope === 'alternate-repository') return alternate.promise
      if (scope === 'third-repository') return third.promise
      return Promise.resolve(codexPin)
    })
    const renderer = await renderHub()
    await openDetail(renderer)
    const initialScope = renderer.root.findAll(node => node.type === 'select' && node.props['aria-label'] === 'Codex repository scope')[0]

    act(() => initialScope.props.onChange({ target: { value: 'alternate-repository' } }))
    expect(renderer.root.findAll(node => node.type === 'select' && node.props['aria-label'] === 'Codex repository scope')[0].props.disabled).toBe(true)
    expect(button(renderer.root, '应用Codex .agents/skills 投影 设置')?.props.disabled).toBe(true)
    expect(button(renderer.root, '修复 Codex 投影')?.props.disabled).toBe(true)

    act(() => initialScope.props.onChange({ target: { value: 'third-repository' } }))
    await act(async () => { third.resolve(thirdCodexPin); await Promise.resolve() })
    await act(async () => { alternate.resolve(alternateCodexPin); await Promise.resolve() })

    const markup = JSON.stringify(renderer.toJSON())
    expect(markup).toContain('third-repository')
    expect(markup).toContain('tone-helper-third')
    expect(markup).not.toContain('tone-helper-alt')
  })

  it('archives and restores an external skill without changing host pins', async () => {
    const renderer = await renderHub()
    await openDetail(renderer)
    await act(async () => button(renderer.root, '归档 Skill')?.props.onClick())
    expect(mocks.archive).toHaveBeenCalledWith(summary.referenceCode)
    expect(mocks.updateHostPin).not.toHaveBeenCalled()
    await act(async () => button(renderer.root, '恢复 Skill')?.props.onClick())
    expect(mocks.restore).toHaveBeenCalledWith(summary.referenceCode)
  })

  it('keeps a package with blocking findings inert and unavailable for import', async () => {
    mocks.inspectFolder.mockResolvedValue({
      inspectionId: 'inspection-blocked', clean: false,
      manifest: { digest: 'sha256:blocked', entryCount: 1, totalBytes: 10, entries: [] },
      findings: [{ code: 'package.inert_manifest', severity: 'error', blocking: true, path: 'package.json', message: 'Executable package metadata is not allowed' }]
    })
    const renderer = await renderHub()
    await act(async () => button(renderer.root, '导入 Skill')?.props.onClick())
    await act(async () => input(renderer.root, 'Skill 文件夹路径').props.onChange({ target: { value: 'F:\\skills\\unsafe' } }))
    await act(async () => button(renderer.root, '仅检查，不导入')?.props.onClick())
    const markup = JSON.stringify(renderer.toJSON())
    expect(mocks.inspectFolder).toHaveBeenCalledWith('F:\\skills\\unsafe')
    expect(markup).toContain('package.inert_manifest')
    expect(button(renderer.root, '确认导入')?.props.disabled).toBe(true)
    expect(mocks.importInspected).not.toHaveBeenCalled()
  })

  it('imports a clean inspection as a new untrusted canonical skill', async () => {
    mocks.inspectFolder.mockResolvedValue({
      inspectionId: 'inspection-clean', clean: true,
      manifest: { digest: 'sha256:clean', entryCount: 1, totalBytes: 12, entries: [
        { type: 'instruction', path: 'SKILL.md', contentType: 'text/markdown', size: 12, digest: 'sha256:entry' }
      ] }, findings: []
    })
    mocks.importInspected.mockResolvedValue({
      inspectionId: 'inspection-clean',
      skill: { id: 'SKL-new', referenceCode: 'SKL-NEW', revision: 1, digest: 'sha256:clean', lifecycleStatus: 'active' }
    })
    mocks.list.mockResolvedValue([summary])
    const renderer = await renderHub()
    await act(async () => button(renderer.root, '导入 Skill')?.props.onClick())
    await act(async () => input(renderer.root, 'Skill 文件夹路径').props.onChange({ target: { value: 'F:\\skills\\clean' } }))
    await act(async () => button(renderer.root, '仅检查，不导入')?.props.onClick())
    await act(async () => button(renderer.root, '确认导入')?.props.onClick())
    expect(mocks.importInspected).toHaveBeenCalledWith({
      inspectionId: 'inspection-clean', operation: 'create', skill: { originLabel: 'F:\\skills\\clean' }
    })
    expect(mocks.list).toHaveBeenCalledTimes(1)
  })
})
