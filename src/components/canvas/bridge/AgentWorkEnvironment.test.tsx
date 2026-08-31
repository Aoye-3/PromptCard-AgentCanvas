import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentWorkEnvironmentSnapshot } from '@/domain/bridge/agent-work-environment'
import type { ContextPackInspection } from '@/storage/storage-service-client'
import { AgentWorkEnvironment } from './AgentWorkEnvironment'

const PRJ = 'PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const CVC = 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER_CVC = 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAA'
const CVD = 'CVD-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const DIGEST = `sha256:${'a'.repeat(64)}`

const environment = (): AgentWorkEnvironmentSnapshot => ({
  gateway: { ok: true, service: 'promptcard-runtime' },
  bridge: {
    configured: true,
    configurationError: null,
    selectedProfileId: 'codex-local',
    profiles: [{
      profileId: 'codex-local', scopes: ['bridge:read', 'bridge:deliver:document'],
      clientInfo: { name: 'codex', version: '1.0.0' }, repositoryScoped: true,
      lastSeenAt: 1, connectionState: 'recently_active'
    }],
    contractVersion: '3.0.0',
    bootstrapSkill: {
      name: 'promptcard-bootstrap', revision: 4, digest: DIGEST,
      instructions: 'Use the explicit Workspace and preview before commit.'
    },
    tools: [{
      name: 'promptcard_runtime_describe', mode: 'read',
      requiredScopes: ['bridge:read'], description: 'Describe the runtime.'
    }],
    writebackKinds: ['document.create'],
    constraints: {
      explicitContextRequired: true, userApprovalRequired: true,
      promptCreateOnly: true, arbitraryPathsAccepted: false
    }
  },
  workspace: {
    state: 'ready', projectCode: PRJ, cvcCode: CVC, contextRevision: 4,
    contextDigest: DIGEST, revoked: false,
    skills: [{
      skillCode: 'SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV', revision: 2,
      digest: DIGEST, projectionHealth: 'healthy'
    }],
    objects: [{
      reference: { namespace: 'canvasDocument', code: CVD },
      revision: 1, digest: DIGEST, title: 'Episode 1'
    }],
    objectCodes: [CVD],
    pendingDeliveries: 0
  }
})

const inspection = (projectCode = PRJ): ContextPackInspection => ({
  cvcCode: OTHER_CVC, projectCode, projectRevision: 4, createdAt: 1,
  creator: 'promptcard-ui', entries: [], sourceCodes: [], sourceBoundaries: [],
  placementHint: { mode: 'after-selection', anchorNodeCodes: [] },
  snapshotDigest: DIGEST, revokedAt: null, revokedBy: null, revocationReason: null
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AgentWorkEnvironment', () => {
  it('shows the exact environment and copies a bootstrap-first task for authorized selections', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
    vi.stubGlobal('navigator', { clipboard })
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<AgentWorkEnvironment
        projectCode={PRJ}
        projectRevision={4}
        cvcCode={CVC}
        selectedObjectCodes={[CVD]}
        onCvcChange={vi.fn()}
        onAccept={vi.fn().mockResolvedValue([])}
        environmentClient={{ bridgeEnvironment: vi.fn().mockResolvedValue(environment()) }}
        contextClient={{ inspect: vi.fn().mockResolvedValue(inspection()) }}
        deliveryClient={{ list: vi.fn().mockResolvedValue([]), decide: vi.fn() }}
      />)
    })

    const text = JSON.stringify(renderer.toJSON())
    expect(text).toContain('promptcard-bootstrap')
    expect(text).toContain('查看内置上手说明')
    expect(text).toContain('Bootstrap / Skill / Tool')
    expect(text).toContain(CVD)
    const copyButton = renderer.root.findAllByType('button').find(button => button.children.flat().includes('复制给外部 Agent'))
    expect(copyButton?.props.disabled).toBe(false)
    await act(async () => copyButton?.props.onClick())
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining(`工作上下文：${CVC}`))
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('promptcard_runtime_describe'))
    renderer.unmount()
  })

  it('refuses to switch a local CVC preference when Storage proves another project', async () => {
    const onCvcChange = vi.fn()
    const contextClient = { inspect: vi.fn().mockResolvedValue(inspection('PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAA')) }
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<AgentWorkEnvironment
        projectCode={PRJ}
        projectRevision={4}
        cvcCode={null}
        selectedObjectCodes={[]}
        onCvcChange={onCvcChange}
        onAccept={vi.fn().mockResolvedValue([])}
        environmentClient={{ bridgeEnvironment: vi.fn().mockResolvedValue({
          ...environment(), workspace: { state: 'context_required', errorCode: 'explicit_context_required' }
        }) }}
        contextClient={contextClient}
        deliveryClient={{ list: vi.fn().mockResolvedValue([]), decide: vi.fn() }}
      />)
    })
    const input = renderer.root.findByProps({ 'aria-label': 'Agent 工作环境 CVC' })
    await act(async () => input.props.onChange({ target: { value: OTHER_CVC } }))
    const button = renderer.root.findAllByType('button').find(item => item.children.flat().includes('验证并切换'))
    await act(async () => button?.props.onClick())

    expect(contextClient.inspect).toHaveBeenCalledWith(OTHER_CVC)
    expect(onCvcChange).not.toHaveBeenCalled()
    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('另一个项目')
    renderer.unmount()
  })
})
