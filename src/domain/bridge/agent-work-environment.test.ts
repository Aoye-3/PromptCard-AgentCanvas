import { describe, expect, it } from 'vitest'
import {
  buildExternalAgentTask,
  parseAgentWorkEnvironmentSnapshot
} from './agent-work-environment'

const PRJ = 'PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const CVC = 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const CVD = 'CVD-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const DIGEST = `sha256:${'a'.repeat(64)}`

const snapshot = () => ({
  gateway: { ok: true, service: 'promptcard-runtime' },
  bridge: {
    configured: true,
    configurationError: null,
    selectedProfileId: 'codex-local',
    profiles: [{
      profileId: 'codex-local',
      scopes: ['bridge:read', 'bridge:deliver:document'],
      clientInfo: { name: 'codex', version: '1.0.0' },
      repositoryScoped: true,
      lastSeenAt: 7,
      connectionState: 'recently_active'
    }],
    contractVersion: '3.0.0',
    bootstrapSkill: { name: 'promptcard-bootstrap', revision: 1, digest: DIGEST },
    tools: [{
      name: 'promptcard_runtime_describe', mode: 'read', requiredScopes: ['bridge:read'], description: 'Describe.'
    }],
    writebackKinds: ['document.create'],
    constraints: {
      explicitContextRequired: true, userApprovalRequired: true,
      promptCreateOnly: true, arbitraryPathsAccepted: false
    }
  },
  workspace: {
    state: 'ready', projectCode: PRJ, cvcCode: CVC,
    contextRevision: 3, contextDigest: DIGEST, revoked: false,
    skills: [{
      skillCode: 'SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV', revision: 2,
      digest: DIGEST, projectionHealth: 'healthy'
    }],
    objects: [{
      reference: { namespace: 'canvasDocument', code: CVD },
      revision: 1, digest: DIGEST, title: 'Script'
    }],
    objectCodes: [CVD],
    pendingDeliveries: 1
  }
})

describe('Agent work environment contract', () => {
  it('accepts the closed v3 environment snapshot', () => {
    expect(parseAgentWorkEnvironmentSnapshot(snapshot()).workspace.state).toBe('ready')
  })

  it('rejects credentials, paths, and malformed exact references', () => {
    expect(() => parseAgentWorkEnvironmentSnapshot({
      ...snapshot(),
      bridge: {
        ...snapshot().bridge,
        profiles: [{ ...snapshot().bridge.profiles[0], token: 'must-not-enter-the-ui' }]
      }
    })).toThrow()
    const malformed = snapshot()
    malformed.workspace.objects[0].reference.code = PRJ
    expect(() => parseAgentWorkEnvironmentSnapshot(malformed)).toThrow()
  })

  it('builds a task with exact PRJ/CVC/object references and no focus inference', () => {
    const task = buildExternalAgentTask({
      projectCode: PRJ.toLowerCase(), cvcCode: CVC.toLowerCase(),
      objectCodes: [CVD.toLowerCase(), CVD], request: '把剧本拆成 12 个镜头。'
    })

    expect(task).toContain(`项目：${PRJ}`)
    expect(task).toContain(`工作上下文：${CVC}`)
    expect(task).toContain(`对象：${CVD}`)
    expect(task).toContain('promptcard_runtime_describe')
    expect(task).toContain('不要根据截图或当前界面焦点推断目标')
  })
})
