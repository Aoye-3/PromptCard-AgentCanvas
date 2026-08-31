import { validatePublicReferenceCode } from '@/domain/reference-codes/reference-code'

export type BridgeConnectionState = 'configured' | 'recently_active'
export type BridgeWorkspaceState = 'ready' | 'context_required' | 'unavailable'

export interface AgentWorkEnvironmentProfile {
  profileId: string
  scopes: string[]
  clientInfo?: { name: string; version: string }
  repositoryScoped: boolean
  lastSeenAt: number | null
  connectionState: BridgeConnectionState
}

export interface AgentWorkEnvironmentTool {
  name: string
  mode: 'read' | 'proposal' | 'status'
  requiredScopes: string[]
  description: string
}

export interface AgentWorkEnvironmentSkill {
  skillCode: string
  revision: number
  digest: string
  projectionHealth: 'healthy' | 'missing' | 'stale'
}

export interface AgentWorkEnvironmentObject {
  reference: {
    namespace: 'canvasDocument' | 'canvasStoryboard'
    code: string
  }
  revision: number
  digest: string
  title: string
}

export type AgentWorkEnvironmentWorkspace = {
  state: Exclude<BridgeWorkspaceState, 'ready'>
  errorCode: string
} | {
  state: 'ready'
  projectCode: string
  cvcCode: string
  contextRevision: number
  contextDigest: string
  revoked: boolean
  skills: AgentWorkEnvironmentSkill[]
  objects: AgentWorkEnvironmentObject[]
  objectCodes: string[]
  pendingDeliveries: number
}

export interface AgentWorkEnvironmentSnapshot {
  gateway: { ok: true; service: 'promptcard-runtime' }
  bridge: {
    configured: boolean
    configurationError: string | null
    selectedProfileId: string | null
    profiles: AgentWorkEnvironmentProfile[]
    contractVersion: '3.0.0'
    bootstrapSkill: { name: 'promptcard-bootstrap'; revision: number; digest: string; instructions: string }
    tools: AgentWorkEnvironmentTool[]
    writebackKinds: string[]
    constraints: {
      explicitContextRequired: true
      userApprovalRequired: true
      promptCreateOnly: true
      arbitraryPathsAccepted: false
    }
  }
  workspace: AgentWorkEnvironmentWorkspace
}

export const parseAgentWorkEnvironmentSnapshot = (value: unknown): AgentWorkEnvironmentSnapshot => {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['gateway', 'bridge', 'workspace'])
    || !isRecord(value.gateway)
    || !hasOnlyKeys(value.gateway, ['ok', 'service'])
    || !isRecord(value.bridge)
    || !isRecord(value.workspace)
  ) {
    throw new Error('Invalid Bridge environment response.')
  }
  if (value.gateway.ok !== true || value.gateway.service !== 'promptcard-runtime') {
    throw new Error('Invalid Bridge environment response.')
  }
  const bridge = value.bridge
  if (
    !hasOnlyKeys(bridge, [
      'configured', 'configurationError', 'selectedProfileId', 'profiles',
      'contractVersion', 'bootstrapSkill', 'tools', 'writebackKinds', 'constraints'
    ])
    || typeof bridge.configured !== 'boolean'
    || (bridge.configurationError !== null && typeof bridge.configurationError !== 'string')
    || (bridge.selectedProfileId !== null && typeof bridge.selectedProfileId !== 'string')
    || bridge.contractVersion !== '3.0.0'
    || !isRecord(bridge.bootstrapSkill)
    || !hasOnlyKeys(bridge.bootstrapSkill, ['name', 'revision', 'digest', 'instructions'])
    || bridge.bootstrapSkill.name !== 'promptcard-bootstrap'
    || !isPositiveInteger(bridge.bootstrapSkill.revision)
    || !isSha256(bridge.bootstrapSkill.digest)
    || typeof bridge.bootstrapSkill.instructions !== 'string'
    || bridge.bootstrapSkill.instructions.length < 1
    || bridge.bootstrapSkill.instructions.length > 8_000
    || !Array.isArray(bridge.profiles)
    || bridge.profiles.length > 16
    || !bridge.profiles.every(isProfile)
    || !Array.isArray(bridge.tools)
    || bridge.tools.length > 32
    || !bridge.tools.every(isTool)
    || !Array.isArray(bridge.writebackKinds)
    || bridge.writebackKinds.length > 16
    || !bridge.writebackKinds.every(item => typeof item === 'string' && item.length <= 80)
    || !isConstraints(bridge.constraints)
  ) throw new Error('Invalid Bridge environment response.')
  const profileIds = bridge.profiles.map(profile => profile.profileId)
  if (
    new Set(profileIds).size !== profileIds.length
    || (bridge.selectedProfileId !== null && !profileIds.includes(bridge.selectedProfileId))
  ) throw new Error('Invalid Bridge environment response.')
  if (!isWorkspace(value.workspace)) throw new Error('Invalid Bridge environment response.')
  return value as unknown as AgentWorkEnvironmentSnapshot
}

export const buildExternalAgentTask = ({
  projectCode,
  cvcCode,
  objectCodes,
  request
}: {
  projectCode: string
  cvcCode: string
  objectCodes: string[]
  request: string
}): string => {
  const project = validatePublicReferenceCode(projectCode.trim().toUpperCase(), 'PRJ')
  const context = validatePublicReferenceCode(cvcCode.trim().toUpperCase(), 'CVC')
  const objects = [...new Set(objectCodes.map(code => code.trim().toUpperCase()))]
  if (!project || !context || objects.length === 0 || !objects.every(isCreativeObjectCode)) {
    throw new Error('Exact PromptCard references are required.')
  }
  const task = request.trim()
  if (!task) throw new Error('A task description is required.')
  return [
    '请使用 PromptCard MCP 完成以下任务。不要根据截图或当前界面焦点推断目标。',
    '',
    `项目：${project}`,
    `工作上下文：${context}`,
    `对象：${objects.join(', ')}`,
    '',
    '开始顺序：',
    '1. 调用 promptcard_runtime_describe。',
    `2. 调用 promptcard_workspace_describe，显式传入 projectCode=${project} 和 cvcCode=${context}。`,
    '3. 遵循 Runtime 返回的 bootstrapSkill.instructions；不要把 promptcard-bootstrap 当作 SKL 读取。',
    '4. 只读取工作环境返回的精确 Skill revision/digest/health 与上述对象引用。',
    '5. 所有写回先 preview 再 commit，并等待我在 PromptCard 可视化界面审阅。',
    '',
    `任务：${task}`
  ].join('\n')
}

const isProfile = (value: unknown): value is AgentWorkEnvironmentProfile => {
  if (!isRecord(value)) return false
  if (!hasOnlyKeys(value, [
    'profileId', 'scopes', 'clientInfo', 'repositoryScoped',
    'lastSeenAt', 'connectionState'
  ], ['clientInfo'])) return false
  return typeof value.profileId === 'string'
    && /^[a-z][a-z0-9._-]{0,63}$/.test(value.profileId)
    && Array.isArray(value.scopes)
    && value.scopes.length <= 6
    && value.scopes.every(scope => typeof scope === 'string' && scope.startsWith('bridge:'))
    && new Set(value.scopes).size === value.scopes.length
    && typeof value.repositoryScoped === 'boolean'
    && (value.lastSeenAt === null || isNonNegativeInteger(value.lastSeenAt))
    && (value.connectionState === 'configured' || value.connectionState === 'recently_active')
    && (value.clientInfo === undefined || (
      isRecord(value.clientInfo)
      && hasOnlyKeys(value.clientInfo, ['name', 'version'])
      && typeof value.clientInfo.name === 'string'
      && typeof value.clientInfo.version === 'string'
    ))
}

const isTool = (value: unknown): value is AgentWorkEnvironmentTool => (
  isRecord(value)
  && hasOnlyKeys(value, ['name', 'mode', 'requiredScopes', 'description'])
  && typeof value.name === 'string'
  && /^promptcard_[a-z_]+$/.test(value.name)
  && (value.mode === 'read' || value.mode === 'proposal' || value.mode === 'status')
  && Array.isArray(value.requiredScopes)
  && value.requiredScopes.length <= 6
  && value.requiredScopes.every(scope => typeof scope === 'string' && scope.startsWith('bridge:'))
  && typeof value.description === 'string'
)

const isConstraints = (value: unknown): boolean => (
  isRecord(value)
  && hasOnlyKeys(value, [
    'explicitContextRequired', 'userApprovalRequired',
    'promptCreateOnly', 'arbitraryPathsAccepted'
  ])
  && value.explicitContextRequired === true
  && value.userApprovalRequired === true
  && value.promptCreateOnly === true
  && value.arbitraryPathsAccepted === false
)

const isWorkspace = (value: Record<string, unknown>): value is AgentWorkEnvironmentWorkspace => {
  if (value.state === 'context_required' || value.state === 'unavailable') {
    return hasOnlyKeys(value, ['state', 'errorCode'])
      && typeof value.errorCode === 'string'
      && value.errorCode.length > 0
  }
  if (
    value.state !== 'ready'
    || !hasOnlyKeys(value, [
      'state', 'projectCode', 'cvcCode', 'contextRevision', 'contextDigest',
      'revoked', 'skills', 'objects', 'objectCodes', 'pendingDeliveries'
    ])
    || !validatePublicReferenceCode(value.projectCode, 'PRJ')
    || !validatePublicReferenceCode(value.cvcCode, 'CVC')
    || !isNonNegativeInteger(value.contextRevision)
    || !isSha256(value.contextDigest)
    || typeof value.revoked !== 'boolean'
    || !Array.isArray(value.skills)
    || value.skills.length > 8
    || !value.skills.every(isSkill)
    || !Array.isArray(value.objects)
    || value.objects.length > 256
    || !value.objects.every(isWorkspaceObject)
    || !Array.isArray(value.objectCodes)
    || value.objectCodes.length > 256
    || !value.objectCodes.every(code => typeof code === 'string' && isCreativeObjectCode(code))
    || new Set(value.objectCodes).size !== value.objectCodes.length
    || !isNonNegativeInteger(value.pendingDeliveries)
  ) return false
  return true
}

const isSkill = (value: unknown): value is AgentWorkEnvironmentSkill => (
  isRecord(value)
  && hasOnlyKeys(value, ['skillCode', 'revision', 'digest', 'projectionHealth'])
  && Boolean(validatePublicReferenceCode(value.skillCode, 'SKL'))
  && isPositiveInteger(value.revision)
  && isSha256(value.digest)
  && (value.projectionHealth === 'healthy' || value.projectionHealth === 'missing' || value.projectionHealth === 'stale')
)

const isWorkspaceObject = (value: unknown): value is AgentWorkEnvironmentObject => {
  if (!isRecord(value) || !isRecord(value.reference)) return false
  if (
    !hasOnlyKeys(value, ['reference', 'revision', 'digest', 'title'])
    || !hasOnlyKeys(value.reference, ['namespace', 'code'])
  ) return false
  const expected = value.reference.namespace === 'canvasDocument'
    ? 'CVD'
    : value.reference.namespace === 'canvasStoryboard'
      ? 'CVS'
      : null
  return expected !== null
    && Boolean(validatePublicReferenceCode(value.reference.code, expected))
    && isNonNegativeInteger(value.revision)
    && isSha256(value.digest)
    && typeof value.title === 'string'
}

const isCreativeObjectCode = (value: string): boolean => (
  Boolean(validatePublicReferenceCode(value, 'CVD'))
  || Boolean(validatePublicReferenceCode(value, 'CVS'))
  || Boolean(validatePublicReferenceCode(value, 'CVT'))
  || Boolean(validatePublicReferenceCode(value, 'CVM'))
)

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)
const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean => (
  required.every(key => optional.includes(key) || Object.prototype.hasOwnProperty.call(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
)
const isSha256 = (value: unknown): value is string => (
  typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
)
const isNonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0
const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0
