export type ModelModality = 'chat' | 'image'
export type ModelSlot = 'chat.primary' | 'image.primary'
export type ModelIntegrationKind = 'pi-native' | 'sdk'
export type ModelCatalogSource = 'provider-catalog' | 'remote' | 'cached'
export type ImageModelMode = 'generate' | 'edit' | 'region-edit'
export type ImageOutputFormat = 'png' | 'jpeg'
export type ImageRegionInput = 'point' | 'bbox'
export type ImagePromptOptimizationMode = 'standard' | 'fast'
export type ImageAnnotationInput = 'raster-markup'
export type ImageResponseTransport = 'url' | 'b64_json'
export type ImageReferenceRole = 'source' | 'identity' | 'style' | 'material' | 'layout' | 'content'
export type ImageReferenceSource = 'asset' | 'url' | 'base64' | 'provider-file'
export type ImageOutputCountMode = 'single' | 'variations' | 'ordered-sequence'
export type ImageOutputCountGuarantee = 'exact' | 'best-effort' | 'provider-decides'
export type ImageAlphaSupport = 'supported' | 'unsupported' | 'unknown'
export type ImageExecutionSubmission = 'synchronous' | 'async-job'
export type ImageExecutionProgress = 'none' | 'partial-image' | 'per-output' | 'percentage'
export type ImageExecutionCompletion = 'inline' | 'poll' | 'webhook'
export type ImageDeliveryForm = 'base64' | 'temporary-url'

export interface ImageReferenceCapabilities {
  maxCount: number
  ordering: 'positional' | 'unordered'
  nativeRoles: ImageReferenceRole[]
  acceptedSources: ImageReferenceSource[]
}

export interface ImageOutputCapabilities {
  countMode: ImageOutputCountMode
  countGuarantee: ImageOutputCountGuarantee
  maxCount: number | null
  formats: ImageOutputFormat[]
  alpha: ImageAlphaSupport
}

export interface ImageExecutionCapabilities {
  submission: ImageExecutionSubmission
  progress: ImageExecutionProgress[]
  completion: ImageExecutionCompletion[]
  cancellation: boolean
}

export interface ImageDeliveryCapabilities {
  forms: ImageDeliveryForm[]
  urlTtlSeconds: number | null
  browserReadable: boolean | 'unknown'
  mustPersistImmediately: boolean
}

export interface ModelProvider {
  id: string
  displayName: string
  defaultApiBase: string
  integrationGroups?: Partial<Record<ModelModality, ModelIntegrationGroup>>
}

export interface ModelIntegrationGroup {
  id: string
  displayName: string
  kind: ModelIntegrationKind
}

export interface ModelCapabilities {
  input?: Array<'text' | 'image' | 'pdf'>
  toolCalling?: boolean
  contextWindow?: number
  modes?: ImageModelMode[]
  resolutions?: Array<'1K' | '2K'>
  aspectRatios?: string[]
  customSize?: {
    minPixels: number
    maxPixels: number
    minAspectRatio: number
    maxAspectRatio: number
  } | null
  outputFormats?: ImageOutputFormat[]
  watermark?: boolean
  maxReferenceImages?: number
  mentionStrategy?: string
  promptOptimization?: {
    modes: ImagePromptOptimizationMode[]
    default: ImagePromptOptimizationMode
  }
  inputConstraints?: {
    formats: string[]
    maxImages: number
    maxBytesPerImage: number
    maxPixelsPerImage: number
    minSideExclusive: number
    minAspectRatio: number
    maxAspectRatio: number
  }
  annotationInputs?: ImageAnnotationInput[]
  regionInputs?: ImageRegionInput[]
  responseTransports?: ImageResponseTransport[]
  outputCount?: number
  streaming?: boolean
  references?: ImageReferenceCapabilities
  outputs?: ImageOutputCapabilities
  execution?: ImageExecutionCapabilities
  delivery?: ImageDeliveryCapabilities
}

export interface ModelCatalogEntry {
  id: string
  providerId: string
  modality: ModelModality
  displayName: string
  capabilities?: ModelCapabilities
  integrationGroup?: ModelIntegrationGroup
  source?: ModelCatalogSource
  assignable?: boolean
}

export interface ModelCatalog {
  providers: ModelProvider[]
  models: ModelCatalogEntry[]
}

export interface ConnectionModelCatalog {
  connectionId: string
  providerId: string
  models: ModelCatalogEntry[]
}

export interface GroupedModelCatalog {
  id: string
  displayName: string
  kind: ModelIntegrationKind
  models: ModelCatalogEntry[]
}

export interface ModelConnectionTestState {
  ok: boolean
  checkedAt: number
  message: string
}

export interface ModelConnection {
  id: string
  providerId: string
  displayName: string
  apiBase: string
  enabled: boolean
  agentChatModelIds?: string[]
  credentialConfigured: boolean
  credentialMask?: string | null
  createdAt: number
  updatedAt: number
  lastTest?: ModelConnectionTestState
}

export interface ModelAssignment {
  slot: ModelSlot
  connectionId: string
  modelId: string
}

export interface ImageModelBinding {
  connectionId: string
  modelId: string
}

export interface ModelConnectionInput {
  providerId: string
  displayName: string
  apiBase: string
  enabled: boolean
  agentChatModelIds?: string[]
  credential?: string
  clearCredential?: boolean
}

export interface ModelAssignmentInput {
  connectionId: string
  modelId: string
}

export interface ModelConnectionTestResult {
  success: boolean
  message: string
}

export type ImageGenerationProviderStatus = 'ready' | 'missing' | 'incompatible' | 'check_failed'

export interface ImageGenerationSdkError {
  code: string
  message: string
}

export interface ImageGenerationProviderDiagnostic {
  providerId: string
  status: ImageGenerationProviderStatus
  sdk: {
    packageName: string
    installedVersion: string | null
    requiredVersion: string
    compatible: boolean
    error: ImageGenerationSdkError | null
  }
}

export interface ImageGenerationStatus {
  serverEnabled: boolean
  checkedAt: number
  credentialStore: { available: boolean }
  providers: ImageGenerationProviderDiagnostic[]
}

export interface ModelConnectionDependencies {
  assignments: ModelSlot[]
  canvasNodeCount: number | null
  canvasNodeCountAvailable: boolean
}

export interface RuntimeErrorPresentation {
  message: string
  action: string
}

const DEFAULT_RUNTIME_ERROR: RuntimeErrorPresentation = {
  message: '图片生成失败，请稍后重试。',
  action: '稍后重试'
}

const RUNTIME_ERROR_PRESENTATIONS: Record<string, RuntimeErrorPresentation> = {
  credential_missing: { message: '所选模型连接尚未配置凭据。', action: '更新凭据' },
  credential_store_unavailable: { message: '系统凭据库当前不可用。', action: '查看服务状态' },
  connection_disabled: { message: '所选模型连接已停用。', action: '前往连接' },
  connection_not_tested: { message: '所选模型连接尚未测试成功。', action: '前往连接' },
  connection_test_failed: { message: '所选模型连接的最近一次测试失败。', action: '前往连接' },
  assignment_missing: { message: '尚未配置默认图片模型。', action: '前往配置' },
  runtime_disabled: { message: '图片生成服务尚未启用。', action: '查看服务状态' },
  image_generation_disabled: { message: '图片生成服务尚未启用。', action: '查看服务状态' },
  ark_sdk_missing: { message: 'Ark SDK 尚未安装或无法导入。', action: '重新检测' },
  ark_sdk_incompatible: { message: 'Ark SDK 版本不兼容。', action: '重新检测' },
  ark_sdk_check_failed: { message: '无法检测 Ark SDK。', action: '重新检测' },
  invalid_size: { message: '所选图片尺寸不受支持。', action: '修改参数' },
  invalid_custom_size: { message: '自定义图片尺寸不符合模型限制。', action: '修改参数' },
  too_many_images: { message: '图片输入超过模型上限。', action: '修改参数' },
  invalid_input: { message: '图片生成输入无效。', action: '修改参数' },
  invalid_input_asset: { message: '参考图片不符合模型要求。', action: '修改参数' },
  input_images_too_large: { message: '参考图片总大小超过限制。', action: '修改参数' },
  csrf_validation_failed: { message: '服务安全校验失败，请刷新后重试。', action: '刷新重试' },
  request_forbidden: { message: '当前请求未通过安全校验。', action: '刷新重试' },
  authentication_failed: { message: '模型服务凭据无效。', action: '更新凭据' },
  invalid_runtime_response: { message: '图片生成服务返回了无效结果。', action: '稍后重试' },
  generation_busy: { message: '当前模型连接正在处理其他请求。', action: '稍后重试' },
  rate_limited: { message: '图片服务请求过于频繁，请稍后重试。', action: '稍后重试' },
  timeout: { message: '图片生成超时。', action: '稍后重试' },
  service_unavailable: { message: '图片生成服务暂时不可用。', action: '稍后重试' },
  storage_write_failed: { message: '生成结果无法写入本地存储。', action: '检查本地存储' },
  invalid_operation_context: { message: '图片操作上下文不一致。', action: '重新发起操作' },
  invalid_operation_source: { message: '图片操作源资产不一致。', action: '重新发起操作' },
  invalid_operation_mode: { message: '图片操作模式或区域无效。', action: '修改参数' },
  invalid_operation_group: { message: '多视图操作组无效。', action: '重新发起操作' },
  run_conflict: { message: '生成任务与已有记录冲突。', action: '重新发起操作' },
  run_already_started: { message: '生成任务已在其他执行流程中启动。', action: '等待状态更新' },
  generation_failed: DEFAULT_RUNTIME_ERROR
}

export const getRuntimeErrorPresentation = (code: string): RuntimeErrorPresentation => (
  RUNTIME_ERROR_PRESENTATIONS[code] || DEFAULT_RUNTIME_ERROR
)

export type ModelAssignmentValidationErrorCode =
  | 'model_not_found'
  | 'incompatible_model_slot'

export interface ModelAssignmentValidationError {
  code: ModelAssignmentValidationErrorCode
}

const SLOT_MODALITY: Record<ModelSlot, ModelModality> = {
  'chat.primary': 'chat',
  'image.primary': 'image'
}

export const validateModelAssignment = (
  assignment: ModelAssignment,
  catalog: readonly ModelCatalogEntry[]
): ModelAssignmentValidationError[] => {
  const model = catalog.find(candidate => candidate.id === assignment.modelId)
  if (!model) return [{ code: 'model_not_found' }]
  return model.modality === SLOT_MODALITY[assignment.slot]
    ? []
    : [{ code: 'incompatible_model_slot' }]
}

export const groupAssignableModels = (
  models: readonly ModelCatalogEntry[],
  modality: ModelModality
): GroupedModelCatalog[] => {
  const groups = new Map<string, GroupedModelCatalog>()
  models
    .filter(model => model.modality === modality && model.assignable !== false && model.integrationGroup)
    .forEach(model => {
      const integrationGroup = model.integrationGroup!
      const group = groups.get(integrationGroup.id) || {
        ...integrationGroup,
        models: []
      }
      group.models.push(model)
      groups.set(group.id, group)
    })
  return [...groups.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'pi-native' ? -1 : 1
    return left.displayName.localeCompare(right.displayName, 'zh-CN')
  })
}
