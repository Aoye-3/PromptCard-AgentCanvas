import type { CardType, IPreset } from '@/models/Card.model'
import type { IPromptProject } from '@/models/PromptHistory.model'
import type { ImageOperationRecipeSnapshot } from '@/domain/image-actions/image-operations'
import { validatePublicReferenceCode } from '@/domain/reference-codes/reference-code'
import type { AgentDocumentAttachmentAudit, AgentInteractionMode } from '@/models/Agent.model'

export interface TrashEntry<T> {
  id: string
  deletedAt: number
  deletedBy: 'user' | 'agent'
  deleteReason?: string | null
  payload: T
}

export interface RecentCaptureItem {
  id: string
  assetId: string
  kind: 'screenshot' | 'pastedMedia' | 'screenRecording'
  status: 'recent' | 'annotated' | 'registeredToPromptLibrary' | 'placedOnCanvas' | 'archived'
  purpose: 'inspirationReference' | 'generatedResult' | 'promptAttachment' | 'shotOutput'
  role?: 'character' | 'scene' | 'prop' | 'composition' | 'lighting' | 'color' | 'style' | 'mood' | 'other' | null
  title: string
  prompt: string
  userNote: string
  sourcePlatform: string
  sourceUrl: string
  contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4'
  originalFilename?: string
  registeredPromptId?: string | null
  registeredAt?: number | null
  linkedProjectId?: string | null
  linkedCanvasNodeId?: string | null
  durationMs?: number
  hasAudio?: boolean
  size: number
  width: number
  height: number
  capturedAt: number
  origin: Record<string, unknown>
  createdAt: number
  updatedAt: number
  revision: number
}

export type AssetLifecycleStatus = 'active' | 'trash' | 'deleted'
export type StorageArtifactCategory = 'generated-content' | 'external-media' | 'project-material' | 'other'
export type StorageArtifactMediaType = 'image' | 'video' | 'audio' | 'other'

export interface StorageArtifact {
  assetId: string
  familyAssetIds: string[]
  category: StorageArtifactCategory
  status: Exclude<AssetLifecycleStatus, 'deleted'>
  title: string
  contentType: string
  mediaType: StorageArtifactMediaType
  sizeBytes: number
  createdAt: number
  trashedAt?: number | null
  referenceCount: number
  previewUrl: string
}

export interface StorageUsageSummary {
  userAssetBytes: number
  activeBytes: number
  trashBytes: number
  internalDerivativeBytes: number
  systemBytes: number
  orphanBytes: number
  assetSoftThresholdBytes: number
  assetWarningLevel: 'normal' | 'warning'
  diskTotalBytes: number
  diskFreeBytes: number
  diskWarningLevel: 'normal' | 'warning' | 'critical'
  artifactCount: number
}

export interface AssetReference {
  kind: 'project' | 'prompt' | 'project-resource'
  id: string
  status: 'active' | 'trash'
  title: string
}

export interface StorageArtifactQuery {
  category?: StorageArtifactCategory
  status?: 'active' | 'trash'
  mediaType?: StorageArtifactMediaType
  query?: string
  sort?: 'created-desc' | 'size-desc' | 'name-asc'
  cursor?: string
  limit?: number
}

export interface RecentCaptureRegistrationRequest {
  intent?: 'initial' | 'analysis-derived'
  mode: 'separate' | 'merged'
  captures: Array<{
    id: string
    revision: number
    label?: string
    content?: string
    type?: CardType
    category?: string
  }>
  prompt?: {
    label: string
    content: string
    type: CardType
    category?: string
  }
}

export interface RecentCaptureRegistrationResult {
  presets: IPreset[]
  captures: RecentCaptureItem[]
}

export type ImageGenerationRunState = 'queued' | 'running' | 'succeeded' | 'failed'

export interface ImageGenerationRunSnapshot {
  mode: string
  promptOptimization: 'standard' | 'fast'
  promptDocument: {
    version: number
    segments: Array<{ type: 'text'; text: string } | { type: 'reference'; referenceId: string; label: string }>
  }
  inputAssets: Array<{
    referenceId: string
    role: 'source-image' | 'reference-image'
    assetId: string
    sourceAssetId?: string
    order: number
  }>
  regions: Array<Record<string, string | number>>
  resolution: string
  aspectRatio?: string
  width?: number
  height?: number
  outputFormat: string
  watermark: boolean
  operation?: ImageOperationRecipeSnapshot
}

export interface ImageGenerationRun {
  id: string
  projectId: string
  nodeId?: string
  conversationId?: string
  connectionId: string
  providerId: string
  modelId: string
  state: ImageGenerationRunState
  requestSnapshot: ImageGenerationRunSnapshot
  outputAssetIds: string[]
  outputAssetStates?: Record<string, AssetLifecycleStatus | 'missing'>
  createdAt: number
  startedAt?: number
  finishedAt?: number
  providerRequestId?: string
  error?: { code: string; message: string; retryable: boolean }
  usage?: Record<string, number>
}

export interface ImageGenerationRunPage {
  runs: ImageGenerationRun[]
  nextCursor: string | null
}

export interface ImageGenerationRunQuery {
  projectId: string
  nodeId?: string
  conversationId?: string
  cursor?: string | null
  limit?: number
  signal?: AbortSignal
}

export interface ImageGenerationConversationSummary {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  latestRunId?: string
  latestState?: ImageGenerationRunState
  previewAssetId?: string
  turnCount: number
}

export interface ImageGenerationConversationPage {
  conversations: ImageGenerationConversationSummary[]
  nextCursor: string | null
}

export interface ImageGenerationConversationQuery {
  projectId: string
  cursor?: string | null
  limit?: number
  signal?: AbortSignal
}

export interface ImageGenerationConversationRunQuery extends ImageGenerationConversationQuery {
  conversationId: string
}

export interface ImageGenerationCanvasPlacement {
  runId: string
  projectId: string
  conversationId: string
  assetId: string
  state: 'pending' | 'placed'
  canvasNodeId?: string
  createdAt: number
  updatedAt: number
}

export interface ImageAssetRecord {
  id: string
  filename: string
  contentType: string
  size: number
}

export interface ImageAssetImportResult {
  originalAsset: ImageAssetRecord
  previewAsset: ImageAssetRecord
  providerInputAsset: ImageAssetRecord
  width: number
  height: number
}

export interface ProjectDocumentResource {
  id: string
  projectId: string
  originalFilename: string
  contentType: 'text/plain' | 'text/markdown' | 'application/pdf' |
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  size: number
  sha256: string
  extractionKind: 'utf-8' | 'docx' | 'none'
  extractionStatus: 'complete' | 'not-applicable'
  normalizedTextDigest: string | null
  revision: number
  lifecycleStatus: 'active' | 'trash'
  createdAt: number
  updatedAt: number
}

export interface ImageAssetDerivation {
  id: string
  sourceAssetId: string
  derivedAssetId: string
  kind: 'preview' | 'provider-input' | 'annotation-flattened'
  transform: Record<string, unknown>
  annotationDocument?: Record<string, unknown>
  createdAt: number
}

export type CreateImageAssetDerivationRequest = Omit<ImageAssetDerivation, 'id' | 'createdAt'>

export interface ProjectResourceFolder {
  id: string
  projectId: string
  parentId: string | null
  name: string
  sortOrder: number
  revision: number
  createdAt: number
  updatedAt: number
}

export interface ProjectResource {
  id: string
  projectId: string
  kind: 'subject' | 'material'
  name: string
  sourceAssetId: string
  previewAssetId: string
  providerAssetId: string
  width: number
  height: number
  contentType: string
  folderId: string | null
  sortOrder: number
  revision: number
  createdAt: number
  updatedAt: number
}

export interface ProjectResourceSnapshot {
  folders: ProjectResourceFolder[]
  resources: ProjectResource[]
}

export interface ProjectResourceLayout {
  folders: Array<Pick<ProjectResourceFolder, 'id' | 'parentId' | 'sortOrder' | 'revision'>>
  resources: Array<Pick<ProjectResource, 'id' | 'folderId' | 'sortOrder' | 'revision'>>
}

export interface AgentConversationSummary {
  id: string
  projectId: string
  entrypoint: string
  mode: string
  title: string
  status: 'active' | 'trash'
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
  modelBinding?: AgentConversationModelBinding | null
  interactionMode: AgentInteractionMode
  boundSkillIds: string[]
  revision: number
}

export interface AgentConversationModelBinding {
  connectionId: string
  providerId: string
  modelId: string
}

export interface AgentConversationDetail extends AgentConversationSummary {
  messages: Array<{
    id?: string
    role: 'user' | 'assistant' | 'system'
    text: string
    createdAt?: number
    documentAttachments?: AgentDocumentAttachmentAudit[]
  }>
  proposals: Array<Record<string, unknown>>
  turns: Array<Record<string, unknown>>
}

export interface AgentConversationPage {
  conversations: AgentConversationSummary[]
  nextCursor: string | null
}

export interface SkillSummary {
  id: string
  referenceCode: string
  slug: string
  name: string
  description: string
  source: 'builtin' | 'external'
  trustState: 'first-party' | 'trusted' | 'untrusted'
  capabilityId?: string | null
  toolDependencies: string[]
  revision: number
  digest: string
  lifecycleStatus: 'active' | 'archived'
}

export interface SkillPackageEntry {
  type: 'instruction' | 'reference' | 'script' | 'asset'
  path: string
  contentType: string
  contentBase64?: string
  size: number
  digest: string
}

export interface SkillRevision {
  revision: number
  digest: string
  instructions: string
  references: unknown[]
  createdAt: number
  digestVersion?: string
  legacyDigest?: string | null
  provenance: Record<string, unknown>
  declaredCapabilities: Record<string, unknown>
  entries: SkillPackageEntry[]
  trustReview: { state: 'trusted' | 'untrusted'; digest: string; reviewedAt: number } | null
}

export interface SkillDetail extends Omit<SkillSummary, 'revision' | 'digest'> {
  currentRevision: number
  archivedAt: number | null
  revisions: SkillRevision[]
}

export interface SkillInspectionFinding {
  code: string
  severity: 'info' | 'warning' | 'error'
  blocking: boolean
  path: string
  message: string
  rule?: string
  line?: number
}

export interface SkillInspection {
  inspectionId: string
  clean: boolean
  manifest: {
    digest: string
    entryCount: number
    totalBytes: number
    entries: SkillPackageEntry[]
  }
  findings: SkillInspectionFinding[]
}

export interface SkillImportRequest {
  inspectionId: string
  operation: 'create' | 'revise'
  skill: { originLabel?: string; skillId?: string; id?: string; slug?: string; name?: string; description?: string }
}

export interface SkillImportResult {
  inspectionId: string
  skill: Pick<SkillSummary, 'id' | 'referenceCode' | 'revision' | 'digest' | 'lifecycleStatus'>
}

export type SkillHost = 'local-agent' | 'codex'

export interface SkillHostPin {
  skillId: string
  skillReferenceCode: string
  host: SkillHost
  scope: string
  enabled: boolean
  revision: number
  digest: string
  projection: ({ publicationName?: string } & Record<string, unknown>) | null
  projectionHealth?: { state: string; code?: string }
  updatedAt: number
}

export interface SkillHostDescription {
  id: SkillHost
  label: string
  scopes: string[]
}

export type CreateProjectResourceFolder = Pick<ProjectResourceFolder, 'name'> &
  Partial<Pick<ProjectResourceFolder, 'id' | 'parentId' | 'sortOrder'>>

export type CreateProjectResource = Pick<
  ProjectResource,
  'kind' | 'name' | 'sourceAssetId' | 'previewAssetId' | 'providerAssetId' | 'width' | 'height' | 'contentType'
> & Partial<Pick<ProjectResource, 'id' | 'folderId' | 'sortOrder'>>

export class StorageRevisionConflict<T> extends Error {
  current: T

  constructor(current: T) {
    super('Storage revision conflict')
    this.name = 'StorageRevisionConflict'
    this.current = current
  }
}

export class StorageHttpError extends Error {
  status: number
  code: string
  detail?: unknown

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message)
    this.name = 'StorageHttpError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

const JSON_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json'
}

type ErrorEnvelope = {
  detail?: {
    code?: string
    message?: string
    detail?: unknown
    current?: unknown
  }
}

async function request<T>(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController()
  const externalSignal = init?.signal
  let timedOut = false
  const abortFromExternalSignal = () => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) abortFromExternalSignal()
  else externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true })
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...JSON_HEADERS,
        ...(init?.headers || {})
      }
    })
  } catch (error) {
    const externallyAborted = !timedOut && externalSignal?.aborted
    throw new StorageHttpError(
      0,
      timedOut ? 'timeout' : externallyAborted ? 'request_aborted' : 'service_unavailable',
      timedOut
        ? 'Storage request timed out.'
        : externallyAborted
          ? 'Storage request was cancelled.'
          : 'Storage service is unavailable.',
      error
    )
  } finally {
    globalThis.clearTimeout(timeoutId)
    externalSignal?.removeEventListener('abort', abortFromExternalSignal)
  }

  const payload = await response.json().catch(() => null) as (T & ErrorEnvelope) | ErrorEnvelope | null
  const storageError = (payload as ErrorEnvelope | null)?.detail

  if (response.status === 409 && storageError?.code === 'revision_conflict') {
    throw new StorageRevisionConflict(storageError.current)
  }
  if (!response.ok) {
    throw new StorageHttpError(
      response.status,
      storageError?.code || 'storage_request_failed',
      storageError?.message || `Storage request failed: ${response.status}`,
      storageError?.detail
    )
  }
  return payload as T
}

async function isHealthy(): Promise<boolean> {
  const controller = new AbortController()
  const timeoutId = globalThis.setTimeout(() => controller.abort(), 750)
  try {
    const response = await fetch('/storage-api/health', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-cache'
    })
    return response.ok
  } catch {
    return false
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
}

const projectWritePayload = (project: Partial<IPromptProject>): Record<string, unknown> => {
  const payload: Record<string, unknown> = { ...project }
  delete payload.referenceCode
  if (!project.freeCanvas) return payload
  payload.freeCanvas = {
    ...project.freeCanvas,
    nodes: project.freeCanvas.nodes.map(node => {
      if (node.kind === 'unsupported') return structuredClone(node.originalNode)
      const nodePayload = { ...node }
      delete nodePayload.referenceCode
      if (nodePayload.meta.referenceCodePending === true) {
        const meta = { ...nodePayload.meta }
        delete meta.referenceCodePending
        nodePayload.meta = meta
      }
      return nodePayload
    })
  }
  return payload
}

export interface ContextPackEntry {
  reference: {
    namespace: 'canvasTemplate' | 'canvasMedia'
    code: string
  }
  content: string
  contentDigest: string
}

export interface ContextPackSourceBoundary {
  nodeCode: string
  promptLibraryReferences: string[]
  canvasMediaReferences: string[]
}

export interface ContextPackPlacementHint {
  mode: 'after-selection'
  anchorNodeCodes: string[]
}

export interface ContextPackInspection {
  cvcCode: string
  projectCode: string
  projectRevision: number
  createdAt: number
  creator: string
  entries: ContextPackEntry[]
  sourceCodes: string[]
  sourceBoundaries: ContextPackSourceBoundary[]
  placementHint: ContextPackPlacementHint
  snapshotDigest: string
  revokedAt: number | null
  revokedBy: string | null
  revocationReason: string | null
}

export interface ContextPackCreateRequest {
  projectCode: string
  projectRevision: number
  nodeCodes: string[]
  placementHint: ContextPackPlacementHint
  creator: 'promptcard-ui'
}

const parseProjectDocumentResource = (value: unknown): ProjectDocumentResource => {
  if (!value || typeof value !== 'object') {
    throw new StorageHttpError(502, 'invalid_storage_response', 'Storage returned an invalid document resource.')
  }
  const candidate = value as Record<string, unknown>
  const contentTypes = new Set([
    'text/plain',
    'text/markdown',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ])
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.projectId !== 'string' ||
    typeof candidate.originalFilename !== 'string' ||
    typeof candidate.contentType !== 'string' || !contentTypes.has(candidate.contentType) ||
    typeof candidate.size !== 'number' ||
    typeof candidate.sha256 !== 'string' ||
    !['utf-8', 'docx', 'none'].includes(String(candidate.extractionKind)) ||
    !['complete', 'not-applicable'].includes(String(candidate.extractionStatus)) ||
    !(typeof candidate.normalizedTextDigest === 'string' || candidate.normalizedTextDigest === null) ||
    typeof candidate.revision !== 'number' ||
    !['active', 'trash'].includes(String(candidate.lifecycleStatus)) ||
    typeof candidate.createdAt !== 'number' ||
    typeof candidate.updatedAt !== 'number'
  ) {
    throw new StorageHttpError(502, 'invalid_storage_response', 'Storage returned an invalid document resource.')
  }
  return {
    id: candidate.id,
    projectId: candidate.projectId,
    originalFilename: candidate.originalFilename,
    contentType: candidate.contentType as ProjectDocumentResource['contentType'],
    size: candidate.size,
    sha256: candidate.sha256,
    extractionKind: candidate.extractionKind as ProjectDocumentResource['extractionKind'],
    extractionStatus: candidate.extractionStatus as ProjectDocumentResource['extractionStatus'],
    normalizedTextDigest: candidate.normalizedTextDigest,
    revision: candidate.revision,
    lifecycleStatus: candidate.lifecycleStatus as ProjectDocumentResource['lifecycleStatus'],
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt
  }
}

export const storageServiceClient = {
  health: isHealthy,

  assets: {
    async upload(file: File): Promise<{ id: string; filename: string; contentType: string; size: number }> {
      const contentType = inferAssetContentType(file)
      if (!contentType) throw new StorageHttpError(400, 'invalid_asset', '仅支持 PNG、JPEG、WebP 图片和 MP4、WebM 视频。')
      return request('/storage-api/assets', {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'X-File-Name': encodeURIComponent(file.name)
        },
        body: file
      }, 30_000)
    },
    url(assetId: string): string {
      return `/storage-api/assets/${encodeURIComponent(assetId)}`
    },
    diagnostics(): Promise<{ unregisteredFiles: string[]; missingFiles: string[]; unreferencedAssets: string[]; missingReferences: string[] }> {
      return request('/storage-api/assets/diagnostics')
    }
  },
  recentCaptures: {
    async getAll(): Promise<RecentCaptureItem[]> {
      return (await request<{ captures: RecentCaptureItem[] }>('/storage-api/recent-captures')).captures
    },
    async getById(id: string): Promise<RecentCaptureItem | null> {
      try {
        return await request<RecentCaptureItem>(`/storage-api/recent-captures/${encodeURIComponent(id)}`)
      } catch (error) {
        if (error instanceof StorageHttpError && error.status === 404) return null
        throw error
      }
    },
    create(capture: Partial<RecentCaptureItem> & Pick<RecentCaptureItem, 'assetId'>): Promise<RecentCaptureItem> {
      return request('/storage-api/recent-captures', { method: 'POST', body: JSON.stringify(capture) })
    },
    update(id: string, revision: number, updates: Partial<RecentCaptureItem>): Promise<RecentCaptureItem> {
      return request(`/storage-api/recent-captures/${encodeURIComponent(id)}`, {
        method: 'PUT', body: JSON.stringify({ revision, updates })
      })
    },
    async delete(id: string, revision: number): Promise<void> {
      await request(`/storage-api/recent-captures/${encodeURIComponent(id)}`, {
        method: 'DELETE', body: JSON.stringify({ revision })
      })
    },
    registerToPromptLibrary(payload: RecentCaptureRegistrationRequest): Promise<RecentCaptureRegistrationResult> {
      return request('/storage-api/recent-captures/register-to-prompt-library', {
        method: 'POST', body: JSON.stringify(payload)
      })
    }
  },
  storageArtifacts: {
    getSummary(): Promise<StorageUsageSummary> {
      return request('/storage-api/storage/summary')
    },
    getPage(query: StorageArtifactQuery = {}): Promise<{ artifacts: StorageArtifact[]; nextCursor?: string | null }> {
      const parameters = new URLSearchParams()
      if (query.category) parameters.set('category', query.category)
      if (query.status) parameters.set('status', query.status)
      if (query.mediaType) parameters.set('mediaType', query.mediaType)
      if (query.query) parameters.set('query', query.query)
      if (query.sort) parameters.set('sort', query.sort)
      if (query.cursor) parameters.set('cursor', query.cursor)
      if (query.limit !== undefined) parameters.set('limit', String(query.limit))
      const queryString = parameters.toString()
      return request(`/storage-api/storage/artifacts${queryString ? `?${queryString}` : ''}`)
    },
    async getReferences(assetId: string): Promise<AssetReference[]> {
      return (await request<{ references: AssetReference[] }>(
        `/storage-api/storage/artifacts/${encodeURIComponent(assetId)}/references`
      )).references
    },
    async trash(ids: string[]): Promise<StorageArtifact[]> {
      return (await request<{ artifacts: StorageArtifact[] }>('/storage-api/storage/artifacts/trash', {
        method: 'POST', body: JSON.stringify({ ids, deletedBy: 'user' })
      })).artifacts
    },
    async restore(ids: string[]): Promise<StorageArtifact[]> {
      return (await request<{ artifacts: StorageArtifact[] }>('/storage-api/storage/artifacts/restore', {
        method: 'POST', body: JSON.stringify({ ids })
      })).artifacts
    },
    async deleteForever(ids: string[]): Promise<void> {
      await request('/storage-api/storage/artifacts/delete-forever', {
        method: 'POST', body: JSON.stringify({ ids })
      })
    },
    async reconcileOrphans(): Promise<StorageArtifact[]> {
      return (await request<{ artifacts: StorageArtifact[] }>('/storage-api/storage/reconcile-orphans', {
        method: 'POST'
      })).artifacts
    },
    downloadUrl(assetId: string): string {
      return `/storage-api/storage/artifacts/${encodeURIComponent(assetId)}/download`
    }
  },
  imageAssets: {
    async import(file: File): Promise<ImageAssetImportResult> {
      const contentType = inferImageImportContentType(file)
      if (!contentType) {
        throw new StorageHttpError(
          400,
          'invalid_asset',
          '仅支持 JPEG、PNG、WebP、BMP、TIFF、GIF、HEIC 和 HEIF 图片。'
        )
      }
      return request('/storage-api/image-assets/import', {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'X-File-Name': encodeURIComponent(file.name)
        },
        body: file
      }, 30_000)
    },
    createDerivation(payload: CreateImageAssetDerivationRequest): Promise<ImageAssetDerivation> {
      return request('/storage-api/image-assets/derivations', {
        method: 'POST',
        body: JSON.stringify(payload)
      })
    }
  },
  projectDocumentResources: {
    async upload(projectId: string, file: File, signal?: AbortSignal): Promise<ProjectDocumentResource> {
      const contentType = inferDocumentContentType(file)
      if (!contentType) {
        throw new StorageHttpError(
          400,
          'invalid_document',
          'Only TXT, Markdown, PDF, and DOCX documents are supported.'
        )
      }
      const payload = await request<unknown>(
        `/storage-api/projects/${encodeURIComponent(projectId)}/document-resources`,
        {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            'X-File-Name': encodeURIComponent(file.name)
          },
          body: file,
          signal
        },
        60_000
      )
      return parseProjectDocumentResource(payload)
    },
    async list(projectId: string): Promise<ProjectDocumentResource[]> {
      const payload = await request<{ resources?: unknown[] }>(
        `/storage-api/projects/${encodeURIComponent(projectId)}/document-resources`
      )
      if (!Array.isArray(payload.resources)) {
        throw new StorageHttpError(502, 'invalid_storage_response', 'Storage returned an invalid document list.')
      }
      return payload.resources.map(parseProjectDocumentResource)
    },
    async get(projectId: string, resourceId: string): Promise<ProjectDocumentResource> {
      return parseProjectDocumentResource(await request<unknown>(
        `/storage-api/projects/${encodeURIComponent(projectId)}/document-resources/${encodeURIComponent(resourceId)}`
      ))
    },
    async delete(projectId: string, resourceId: string): Promise<ProjectDocumentResource> {
      return parseProjectDocumentResource(await request<unknown>(
        `/storage-api/projects/${encodeURIComponent(projectId)}/document-resources/${encodeURIComponent(resourceId)}`,
        { method: 'DELETE' }
      ))
    },
    async restore(projectId: string, resourceId: string): Promise<ProjectDocumentResource> {
      return parseProjectDocumentResource(await request<unknown>(
        `/storage-api/projects/${encodeURIComponent(projectId)}/document-resources/${encodeURIComponent(resourceId)}/restore`,
        { method: 'POST' }
      ))
    }
  },
  imageGenerationRuns: {
    async getPage(query: ImageGenerationRunQuery): Promise<ImageGenerationRunPage> {
      const parameters = new URLSearchParams({ projectId: query.projectId })
      if (query.nodeId) parameters.set('nodeId', query.nodeId)
      if (query.conversationId) parameters.set('conversationId', query.conversationId)
      if (query.cursor) parameters.set('cursor', query.cursor)
      if (query.limit !== undefined) parameters.set('limit', String(query.limit))
      const queryString = parameters.toString()
      const page = await request<{ runs?: unknown[]; nextCursor?: unknown }>(
        `/storage-api/image-generation-runs${queryString ? `?${queryString}` : ''}`,
        { signal: query.signal }
      )
      return {
        runs: Array.isArray(page.runs) ? page.runs.flatMap(normalizeImageGenerationRun) : [],
        nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null
      }
    },
    async getById(id: string, projectId: string): Promise<ImageGenerationRun | null> {
      try {
        const parameters = new URLSearchParams({ projectId })
        const payload = await request<unknown>(
          `/storage-api/image-generation-runs/${encodeURIComponent(id)}?${parameters.toString()}`
        )
        return normalizeImageGenerationRun(payload)[0] || null
      } catch (error) {
        if (error instanceof StorageHttpError && error.status === 404) return null
        throw error
      }
    }
  },
  imageGenerationConversations: {
    async getPage(query: ImageGenerationConversationQuery): Promise<ImageGenerationConversationPage> {
      const parameters = new URLSearchParams({ projectId: query.projectId })
      if (query.cursor) parameters.set('cursor', query.cursor)
      if (query.limit !== undefined) parameters.set('limit', String(query.limit))
      const page = await request<{ conversations?: unknown[]; nextCursor?: unknown }>(
        `/storage-api/image-generation-conversations?${parameters.toString()}`,
        { signal: query.signal }
      )
      return {
        conversations: Array.isArray(page.conversations)
          ? page.conversations.flatMap(normalizeImageGenerationConversation)
          : [],
        nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null
      }
    },
    async getById(id: string, projectId: string): Promise<ImageGenerationConversationSummary | null> {
      try {
        const parameters = new URLSearchParams({ projectId })
        const payload = await request<unknown>(
          `/storage-api/image-generation-conversations/${encodeURIComponent(id)}?${parameters.toString()}`
        )
        return normalizeImageGenerationConversation(payload)[0] || null
      } catch (error) {
        if (error instanceof StorageHttpError && error.status === 404) return null
        throw error
      }
    },
    async getRuns(query: ImageGenerationConversationRunQuery): Promise<ImageGenerationRunPage> {
      const parameters = new URLSearchParams({ projectId: query.projectId })
      if (query.cursor) parameters.set('cursor', query.cursor)
      if (query.limit !== undefined) parameters.set('limit', String(query.limit))
      const page = await request<{ runs?: unknown[]; nextCursor?: unknown }>(
        `/storage-api/image-generation-conversations/${encodeURIComponent(query.conversationId)}/runs?${parameters.toString()}`,
        { signal: query.signal }
      )
      return {
        runs: Array.isArray(page.runs) ? page.runs.flatMap(normalizeImageGenerationRun) : [],
        nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null
      }
    }
  },
  imageGenerationPlacements: {
    async getPending(projectId: string, signal?: AbortSignal): Promise<ImageGenerationCanvasPlacement[]> {
      const parameters = new URLSearchParams({ projectId, state: 'pending' })
      const payload = await request<{ placements?: unknown[] }>(
        `/storage-api/image-generation-placements?${parameters.toString()}`,
        { signal }
      )
      return Array.isArray(payload.placements)
        ? payload.placements.flatMap(normalizeImageGenerationPlacement)
        : []
    },
    async markPlaced(runId: string, canvasNodeId: string): Promise<ImageGenerationCanvasPlacement> {
      const payload = await request<unknown>(
        `/storage-api/image-generation-placements/${encodeURIComponent(runId)}`,
        { method: 'PATCH', body: JSON.stringify({ state: 'placed', canvasNodeId }) }
      )
      const placement = normalizeImageGenerationPlacement(payload)[0]
      if (!placement) throw new StorageHttpError(502, 'invalid_response', 'Storage returned an invalid placement')
      return placement
    }
  },
  agentConversations: {
    list(
      projectId: string,
      status: 'active' | 'trash' = 'active',
      cursor?: string | null,
      limit = 50
    ): Promise<AgentConversationPage> {
      const params = new URLSearchParams({ projectId, status, limit: String(limit) })
      if (cursor) params.set('cursor', cursor)
      return request(`/storage-api/agent-conversations?${params.toString()}`)
    },
    create(input: {
      projectId: string
      entrypoint: string
      mode: string
      title?: string
      modelBinding?: AgentConversationModelBinding | null
    }): Promise<AgentConversationSummary> {
      return request('/storage-api/agent-conversations', {
        method: 'POST',
        body: JSON.stringify(input)
      })
    },
    get(id: string, projectId: string, includeTrash = false): Promise<AgentConversationDetail> {
      const params = new URLSearchParams({ projectId })
      if (includeTrash) params.set('includeTrash', 'true')
      return request(`/storage-api/agent-conversations/${encodeURIComponent(id)}?${params.toString()}`)
    },
    rename(id: string, projectId: string, title: string): Promise<AgentConversationDetail> {
      return request(`/storage-api/agent-conversations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ projectId, title })
      })
    },
    updateModel(id: string, projectId: string, modelBinding: AgentConversationModelBinding | null): Promise<AgentConversationSummary> {
      return request(`/storage-api/projects/${encodeURIComponent(projectId)}/agent-conversations/${encodeURIComponent(id)}/model`, {
        method: 'PATCH',
        body: JSON.stringify({ modelBinding })
      })
    },
    updateInteraction(
      id: string,
      projectId: string,
      metadata: {
        interactionMode: AgentInteractionMode
        boundSkillIds: string[]
        expectedRevision: number
      }
    ): Promise<AgentConversationSummary> {
      return request(`/storage-api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(id)}/interaction`, {
        method: 'PATCH',
        body: JSON.stringify(metadata)
      })
    },
    trash(id: string, projectId: string): Promise<AgentConversationSummary> {
      return request(`/storage-api/agent-conversations/${encodeURIComponent(id)}/trash`, {
        method: 'POST', body: JSON.stringify({ projectId })
      })
    },
    restore(id: string, projectId: string): Promise<AgentConversationSummary> {
      return request(`/storage-api/agent-conversations/${encodeURIComponent(id)}/restore`, {
        method: 'POST', body: JSON.stringify({ projectId })
      })
    },
    deleteForever(id: string, projectId: string): Promise<{ ok: true }> {
      return request(`/storage-api/agent-conversations/${encodeURIComponent(id)}`, {
        method: 'DELETE', body: JSON.stringify({ projectId })
      })
    },
    updateProposal(id: string, proposalId: string, projectId: string, status: 'approved' | 'rejected') {
      return request(`/storage-api/agent-conversations/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}`, {
        method: 'PATCH', body: JSON.stringify({ projectId, status })
      })
    }
  },
  skills: {
    async list(): Promise<SkillSummary[]> {
      return (await request<{ skills: SkillSummary[] }>('/storage-api/skills')).skills
    },
    get(id: string): Promise<SkillDetail> {
      return request(`/storage-api/skills/${encodeURIComponent(id)}`)
    },
    archive(id: string): Promise<SkillDetail> {
      return request(`/storage-api/skills/${encodeURIComponent(id)}/archive`, { method: 'POST' })
    },
    restore(id: string): Promise<SkillDetail> {
      return request(`/storage-api/skills/${encodeURIComponent(id)}/restore`, { method: 'POST' })
    },
    reviewRevision(id: string, revision: number, expectedDigest: string, decision: 'trusted' | 'untrusted'): Promise<SkillDetail> {
      return request(`/storage-api/skills/${encodeURIComponent(id)}/revisions/${revision}/review`, {
        method: 'POST', body: JSON.stringify({ expectedDigest, decision })
      })
    },
    inspectFolder(path: string): Promise<SkillInspection> {
      return request('/storage-api/skill-package-inspections/folder', {
        method: 'POST', body: JSON.stringify({ path })
      })
    },
    inspectArchive(filename: string, contentBase64: string): Promise<SkillInspection> {
      return request('/storage-api/skill-package-inspections/archive', {
        method: 'POST', body: JSON.stringify({ filename, contentBase64 })
      })
    },
    importInspected(payload: SkillImportRequest): Promise<SkillImportResult> {
      return request('/storage-api/skill-package-imports', {
        method: 'POST', body: JSON.stringify(payload)
      })
    },
    async describeHosts(): Promise<SkillHostDescription[]> {
      return (await request<{ hosts: SkillHostDescription[] }>('/storage-api/skill-hosts')).hosts
    },
    getHostPin(id: string, host: SkillHost, repositoryScope?: string): Promise<SkillHostPin> {
      const query = repositoryScope === undefined ? '' : `?repositoryScope=${encodeURIComponent(repositoryScope)}`
      return request(`/storage-api/skills/${encodeURIComponent(id)}/host-pins/${host}${query}`)
    },
    updateHostPin(
      id: string,
      host: SkillHost,
      payload: { enabled: boolean; revision: number; repositoryScope?: string; publicationName?: string }
    ): Promise<SkillHostPin> {
      return request(`/storage-api/skills/${encodeURIComponent(id)}/host-pins/${host}`, {
        method: 'PUT', body: JSON.stringify(payload)
      })
    },
    repairCodexProjection(
      id: string,
      payload: { repositoryScope: string; expectedRevision: number; expectedDigest: string }
    ): Promise<SkillHostPin> {
      return request(`/storage-api/skills/${encodeURIComponent(id)}/host-pins/codex/repair`, {
        method: 'POST', body: JSON.stringify(payload)
      })
    }
  },
  projectResources: {
    getSnapshot(projectId: string, signal?: AbortSignal): Promise<ProjectResourceSnapshot> {
      return request(
        `/storage-api/projects/${encodeURIComponent(projectId)}/resources`,
        { signal }
      )
    },
    createFolder(projectId: string, folder: CreateProjectResourceFolder): Promise<ProjectResourceFolder> {
      return request(`/storage-api/projects/${encodeURIComponent(projectId)}/resource-folders`, {
        method: 'POST',
        body: JSON.stringify(folder)
      })
    },
    updateFolder(
      projectId: string,
      folderId: string,
      revision: number,
      updates: Partial<Pick<ProjectResourceFolder, 'name' | 'parentId' | 'sortOrder'>>
    ): Promise<ProjectResourceFolder> {
      return request(
        `/storage-api/projects/${encodeURIComponent(projectId)}/resource-folders/${encodeURIComponent(folderId)}`,
        { method: 'PUT', body: JSON.stringify({ revision, updates }) }
      )
    },
    async deleteFolder(projectId: string, folderId: string, revision: number): Promise<void> {
      await request(
        `/storage-api/projects/${encodeURIComponent(projectId)}/resource-folders/${encodeURIComponent(folderId)}`,
        { method: 'DELETE', body: JSON.stringify({ revision }) }
      )
    },
    createResource(projectId: string, resource: CreateProjectResource): Promise<ProjectResource> {
      return request(`/storage-api/projects/${encodeURIComponent(projectId)}/resources`, {
        method: 'POST',
        body: JSON.stringify(resource)
      })
    },
    updateResource(
      projectId: string,
      resourceId: string,
      revision: number,
      updates: Partial<Pick<ProjectResource, 'name' | 'folderId' | 'sortOrder'>>
    ): Promise<ProjectResource> {
      return request(
        `/storage-api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}`,
        { method: 'PUT', body: JSON.stringify({ revision, updates }) }
      )
    },
    async deleteResource(projectId: string, resourceId: string, revision: number): Promise<void> {
      await request(
        `/storage-api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}`,
        { method: 'DELETE', body: JSON.stringify({ revision }) }
      )
    },
    updateLayout(projectId: string, layout: ProjectResourceLayout): Promise<ProjectResourceSnapshot> {
      return request(`/storage-api/projects/${encodeURIComponent(projectId)}/resource-layout`, {
        method: 'PUT',
        body: JSON.stringify(layout)
      })
    }
  },
  contextPacks: {
    async create(payload: ContextPackCreateRequest): Promise<ContextPackInspection> {
      return parseContextPackInspection(await request<unknown>('/storage-api/context-packs', {
        method: 'POST', body: JSON.stringify(payload)
      }))
    },
    async inspect(cvcCode: string): Promise<ContextPackInspection> {
      const code = requireContextPackCode(cvcCode)
      return parseContextPackInspection(await request<unknown>(
        `/storage-api/context-packs/${encodeURIComponent(code)}`
      ))
    },
    async revoke(
      cvcCode: string,
      payload: { actor: 'promptcard-ui'; reason: 'user-revoked' }
    ): Promise<ContextPackInspection> {
      const code = requireContextPackCode(cvcCode)
      return parseContextPackInspection(await request<unknown>(
        `/storage-api/context-packs/${encodeURIComponent(code)}/revoke`,
        { method: 'POST', body: JSON.stringify(payload) }
      ))
    }
  },
  projects: {
    async getAll(): Promise<IPromptProject[]> {
      return (await request<{ projects: IPromptProject[] }>('/storage-api/projects')).projects
    },
    async getById(id: string, options: { signal?: AbortSignal } = {}): Promise<IPromptProject | null> {
      try {
        return await request<IPromptProject>(`/storage-api/projects/${encodeURIComponent(id)}`, {
          signal: options.signal
        })
      } catch (error) {
        if (error instanceof StorageHttpError && error.status === 404) return null
        throw error
      }
    },
    create(project: Partial<IPromptProject>, options: { signal?: AbortSignal } = {}): Promise<IPromptProject> {
      return request('/storage-api/projects', {
        method: 'POST', body: JSON.stringify(projectWritePayload(project)), signal: options.signal
      })
    },
    update(
      id: string,
      revision: number,
      updates: Partial<IPromptProject>,
      options: { signal?: AbortSignal } = {}
    ): Promise<IPromptProject> {
      return request(`/storage-api/projects/${encodeURIComponent(id)}`, {
        method: 'PUT', body: JSON.stringify({ revision, updates: projectWritePayload(updates) }), signal: options.signal
      })
    },
    async trash(ids: string[], deletedBy: 'user' | 'agent' = 'user', deleteReason?: string): Promise<IPromptProject[]> {
      return (await request<{ projects: IPromptProject[] }>('/storage-api/projects/trash', {
        method: 'POST', body: JSON.stringify({ ids, deletedBy, deleteReason })
      })).projects
    },
    async getTrash(): Promise<TrashEntry<IPromptProject>[]> {
      return (await request<{ items: TrashEntry<IPromptProject>[] }>('/storage-api/projects/trash')).items
    },
    async restore(ids: string[]): Promise<IPromptProject[]> {
      return (await request<{ projects: IPromptProject[] }>('/storage-api/projects/trash/restore', {
        method: 'POST', body: JSON.stringify({ ids })
      })).projects
    },
    async deleteForever(ids: string[]): Promise<void> {
      await request('/storage-api/projects/trash', { method: 'DELETE', body: JSON.stringify({ ids }) })
    }
  },
  presets: {
    async getAll(): Promise<IPreset[]> {
      return (await request<{ presets: IPreset[] }>('/storage-api/presets')).presets
    },
    async getById(id: string): Promise<IPreset | undefined> {
      try {
        return await request<IPreset>(`/storage-api/presets/${encodeURIComponent(id)}`)
      } catch (error) {
        if (error instanceof StorageHttpError && error.status === 404) return undefined
        throw error
      }
    },
    create(preset: Partial<IPreset>): Promise<IPreset> {
      return request('/storage-api/presets', { method: 'POST', body: JSON.stringify(preset) })
    },
    update(id: string, revision: number, updates: Partial<IPreset>): Promise<IPreset> {
      return request(`/storage-api/presets/${encodeURIComponent(id)}`, {
        method: 'PUT', body: JSON.stringify({ revision, updates })
      })
    },
    async replaceAll(presets: IPreset[]): Promise<IPreset[]> {
      return (await request<{ presets: IPreset[] }>('/storage-api/presets/batch', {
        method: 'PUT', body: JSON.stringify({ presets })
      })).presets
    },
    async reorder(orderedIds: string[], revisions: Record<string, number>): Promise<IPreset[]> {
      return (await request<{ presets: IPreset[] }>('/storage-api/presets/reorder', {
        method: 'POST', body: JSON.stringify({ orderedIds, revisions })
      })).presets
    },
    incrementUsage(id: string, revision: number): Promise<IPreset> {
      return request(`/storage-api/presets/${encodeURIComponent(id)}/increment-usage`, {
        method: 'POST', body: JSON.stringify({ revision })
      })
    },
    async trash(ids: string[], deletedBy: 'user' | 'agent' = 'user', deleteReason?: string): Promise<IPreset[]> {
      return (await request<{ presets: IPreset[] }>('/storage-api/presets/trash', {
        method: 'POST', body: JSON.stringify({ ids, deletedBy, deleteReason })
      })).presets
    },
    async getTrash(): Promise<TrashEntry<IPreset>[]> {
      return (await request<{ items: TrashEntry<IPreset>[] }>('/storage-api/presets/trash')).items
    },
    async restore(ids: string[]): Promise<IPreset[]> {
      return (await request<{ presets: IPreset[] }>('/storage-api/presets/trash/restore', {
        method: 'POST', body: JSON.stringify({ ids })
      })).presets
    },
    async deleteForever(ids: string[]): Promise<void> {
      await request('/storage-api/presets/trash', { method: 'DELETE', body: JSON.stringify({ ids }) })
    }
  },
  migrateBrowserCache(payload: {
    migrationId: string
    projects?: IPromptProject[]
    workspace?: unknown
    presets?: IPreset[]
  }): Promise<{ projects: number; presets: number; alreadyApplied: boolean }> {
    return request('/storage-api/migrations/browser-cache', { method: 'POST', body: JSON.stringify(payload) })
  }
}

const inferAssetContentType = (file: File): string | null => {
  if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return file.type
  if (['video/mp4', 'video/webm'].includes(file.type)) return file.type
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'mp4') return 'video/mp4'
  if (extension === 'webm') return 'video/webm'
  return null
}

const inferImageImportContentType = (file: File): string | null => {
  const supportedTypes = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/bmp',
    'image/tiff',
    'image/gif',
    'image/heic',
    'image/heif'
  ])
  if (supportedTypes.has(file.type.toLowerCase())) return file.type.toLowerCase()
  const extension = file.name.split('.').pop()?.toLowerCase()
  const byExtension: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    gif: 'image/gif',
    heic: 'image/heic',
    heif: 'image/heif'
  }
  return extension ? byExtension[extension] || null : null
}

const inferDocumentContentType = (file: File): ProjectDocumentResource['contentType'] | null => {
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0]
  const expected = extension ? {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }[extension] : undefined
  if (!expected || (file.type && file.type.toLowerCase() !== expected)) return null
  return expected as ProjectDocumentResource['contentType']
}

const normalizeImageGenerationRun = (candidate: unknown): ImageGenerationRun[] => {
  if (!isRecord(candidate)) return []
  const state = candidate.state
  if (
    !isRunState(state)
    || !hasStrings(candidate, ['id', 'projectId', 'connectionId', 'providerId', 'modelId'])
    || (typeof candidate.nodeId !== 'string' && typeof candidate.conversationId !== 'string')
    || !isNonNegativeInteger(candidate.createdAt)
  ) return []
  const requestSnapshot = normalizeRunSnapshot(candidate.requestSnapshot)
  if (!requestSnapshot) return []
  const run: ImageGenerationRun = {
    id: candidate.id as string,
    projectId: candidate.projectId as string,
    connectionId: candidate.connectionId as string,
    providerId: candidate.providerId as string,
    modelId: candidate.modelId as string,
    state,
    requestSnapshot,
    outputAssetIds: Array.isArray(candidate.outputAssetIds)
      ? candidate.outputAssetIds.filter((item): item is string => typeof item === 'string')
      : [],
    createdAt: candidate.createdAt as number
  }
  if (isRecord(candidate.outputAssetStates)) {
    run.outputAssetStates = Object.fromEntries(
      Object.entries(candidate.outputAssetStates).filter((entry): entry is [string, AssetLifecycleStatus | 'missing'] => (
        entry[1] === 'active' || entry[1] === 'trash' || entry[1] === 'deleted' || entry[1] === 'missing'
      ))
    )
  }
  if (typeof candidate.nodeId === 'string' && candidate.nodeId) run.nodeId = candidate.nodeId
  if (typeof candidate.conversationId === 'string' && candidate.conversationId) run.conversationId = candidate.conversationId
  if (isNonNegativeInteger(candidate.startedAt)) run.startedAt = candidate.startedAt
  if (isNonNegativeInteger(candidate.finishedAt)) run.finishedAt = candidate.finishedAt
  if (typeof candidate.providerRequestId === 'string') run.providerRequestId = candidate.providerRequestId
  if (isRecord(candidate.error) && hasStrings(candidate.error, ['code', 'message']) && typeof candidate.error.retryable === 'boolean') {
    run.error = {
      code: candidate.error.code as string,
      message: candidate.error.message as string,
      retryable: candidate.error.retryable
    }
  }
  if (isRecord(candidate.usage)) {
    run.usage = Object.fromEntries(Object.entries(candidate.usage).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
  }
  return [run]
}

const normalizeImageGenerationConversation = (candidate: unknown): ImageGenerationConversationSummary[] => {
  if (
    !isRecord(candidate)
    || !hasStrings(candidate, ['id', 'projectId', 'title'])
    || !isNonNegativeInteger(candidate.createdAt)
    || !isNonNegativeInteger(candidate.updatedAt)
    || !isNonNegativeInteger(candidate.turnCount)
  ) return []
  const conversation: ImageGenerationConversationSummary = {
    id: candidate.id as string,
    projectId: candidate.projectId as string,
    title: candidate.title as string,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    turnCount: candidate.turnCount
  }
  if (typeof candidate.latestRunId === 'string') conversation.latestRunId = candidate.latestRunId
  if (isRunState(candidate.latestState)) conversation.latestState = candidate.latestState
  if (typeof candidate.previewAssetId === 'string') conversation.previewAssetId = candidate.previewAssetId
  return [conversation]
}

const normalizeImageGenerationPlacement = (candidate: unknown): ImageGenerationCanvasPlacement[] => {
  if (
    !isRecord(candidate)
    || !hasStrings(candidate, ['runId', 'projectId', 'conversationId', 'assetId'])
    || (candidate.state !== 'pending' && candidate.state !== 'placed')
    || !isNonNegativeInteger(candidate.createdAt)
    || !isNonNegativeInteger(candidate.updatedAt)
  ) return []
  const placement: ImageGenerationCanvasPlacement = {
    runId: candidate.runId as string,
    projectId: candidate.projectId as string,
    conversationId: candidate.conversationId as string,
    assetId: candidate.assetId as string,
    state: candidate.state,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt
  }
  if (typeof candidate.canvasNodeId === 'string' && candidate.canvasNodeId) placement.canvasNodeId = candidate.canvasNodeId
  return [placement]
}

const normalizeRunSnapshot = (candidate: unknown): ImageGenerationRunSnapshot | null => {
  if (!isRecord(candidate) || !isRecord(candidate.promptDocument)) return null
  const promptDocument = candidate.promptDocument
  const segments: ImageGenerationRunSnapshot['promptDocument']['segments'] = []
  if (Array.isArray(promptDocument.segments)) promptDocument.segments.forEach(segment => {
    if (!isRecord(segment)) return
    if (segment.type === 'text' && typeof segment.text === 'string') {
      segments.push({ type: 'text', text: segment.text })
      return
    }
    if (segment.type === 'reference' && typeof segment.referenceId === 'string' && typeof segment.label === 'string') {
      segments.push({ type: 'reference', referenceId: segment.referenceId, label: segment.label })
    }
  })
  const inputAssets = Array.isArray(candidate.inputAssets) ? candidate.inputAssets.flatMap(item => {
    if (
      !isRecord(item)
      || typeof item.referenceId !== 'string'
      || typeof item.assetId !== 'string'
      || !Number.isInteger(item.order)
    ) return []
    return [{
      referenceId: item.referenceId,
      role: item.role === 'source-image' ? 'source-image' as const : 'reference-image' as const,
      assetId: item.assetId,
      ...(typeof item.sourceAssetId === 'string' ? { sourceAssetId: item.sourceAssetId } : {}),
      order: item.order as number
    }]
  }) : []
  const regions = Array.isArray(candidate.regions) ? candidate.regions.flatMap(normalizeRunRegion) : []
  const operation = normalizeOperationSnapshot(candidate.operation)
  return {
    mode: typeof candidate.mode === 'string' ? candidate.mode : 'generate',
    promptOptimization: candidate.promptOptimization === 'fast' ? 'fast' : 'standard',
    promptDocument: {
      version: Number.isInteger(promptDocument.version) ? promptDocument.version as number : 1,
      segments
    },
    inputAssets,
    regions,
    resolution: typeof candidate.resolution === 'string' ? candidate.resolution : '',
    aspectRatio: typeof candidate.aspectRatio === 'string' ? candidate.aspectRatio : '',
    ...(isPositiveInteger(candidate.width) ? { width: candidate.width } : {}),
    ...(isPositiveInteger(candidate.height) ? { height: candidate.height } : {}),
    outputFormat: typeof candidate.outputFormat === 'string' ? candidate.outputFormat : '',
    watermark: candidate.watermark === true,
    ...(operation ? { operation } : {})
  }
}

const normalizeOperationSnapshot = (candidate: unknown): ImageOperationRecipeSnapshot | null => {
  if (
    !isRecord(candidate)
    || !isImageProductOperation(candidate.operation)
    || !hasStrings(candidate, ['recipeId', 'recipeVersion'])
    || !isRecord(candidate.source)
    || !hasStrings(candidate.source, ['nodeId', 'originalAssetId', 'canvasAssetId', 'providerAssetId'])
    || !Array.isArray(candidate.preservationIntents)
    || !candidate.preservationIntents.every(intent => typeof intent === 'string')
    || !isRecord(candidate.parameters)
  ) return null

  const parameters: ImageOperationRecipeSnapshot['parameters'] = {}
  for (const [key, value] of Object.entries(candidate.parameters)) {
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      parameters[key] = value
      continue
    }
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
      parameters[key] = [...value] as string[]
      continue
    }
    return null
  }

  return {
    operation: candidate.operation,
    recipeId: candidate.recipeId as string,
    recipeVersion: candidate.recipeVersion as string,
    source: {
      nodeId: candidate.source.nodeId as string,
      originalAssetId: candidate.source.originalAssetId as string,
      canvasAssetId: candidate.source.canvasAssetId as string,
      providerAssetId: candidate.source.providerAssetId as string
    },
    preservationIntents: [...candidate.preservationIntents] as string[],
    parameters,
    ...(typeof candidate.operationGroupId === 'string' ? { operationGroupId: candidate.operationGroupId } : {}),
    ...(typeof candidate.operationItemId === 'string' ? { operationItemId: candidate.operationItemId } : {}),
    ...(typeof candidate.viewSpec === 'string' ? { viewSpec: candidate.viewSpec } : {})
  }
}

const normalizeRunRegion = (candidate: unknown): Array<Record<string, string | number>> => {
  if (!isRecord(candidate) || typeof candidate.referenceId !== 'string') return []
  if (candidate.type === 'point' && Number.isInteger(candidate.x) && Number.isInteger(candidate.y)) {
    return [{ type: 'point', referenceId: candidate.referenceId, x: candidate.x as number, y: candidate.y as number }]
  }
  if (
    candidate.type === 'bbox'
    && Number.isInteger(candidate.x1) && Number.isInteger(candidate.y1)
    && Number.isInteger(candidate.x2) && Number.isInteger(candidate.y2)
  ) {
    return [{
      type: 'bbox', referenceId: candidate.referenceId,
      x1: candidate.x1 as number, y1: candidate.y1 as number,
      x2: candidate.x2 as number, y2: candidate.y2 as number
    }]
  }
  return []
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object')

const CONTEXT_PACK_INSPECTION_KEYS = [
  'cvcCode', 'projectCode', 'projectRevision', 'createdAt', 'creator', 'entries',
  'sourceCodes', 'sourceBoundaries', 'placementHint', 'snapshotDigest',
  'revokedAt', 'revokedBy', 'revocationReason'
] as const

const parseContextPackInspection = (value: unknown): ContextPackInspection => {
  const invalid = () => {
    throw new StorageHttpError(502, 'invalid_storage_response', 'Storage returned an invalid context pack response.')
  }
  if (!isClosedRecord(value, CONTEXT_PACK_INSPECTION_KEYS)) return invalid()
  const cvcCode = validatePublicReferenceCode(value.cvcCode, 'CVC')
  const projectCode = validatePublicReferenceCode(value.projectCode, 'PRJ')
  if (
    !cvcCode
    || !projectCode
    || !isPositiveInteger(value.projectRevision)
    || !isNonNegativeInteger(value.createdAt)
    || typeof value.creator !== 'string'
    || !value.creator
    || !Array.isArray(value.entries)
    || !Array.isArray(value.sourceCodes)
    || !Array.isArray(value.sourceBoundaries)
    || !isClosedRecord(value.placementHint, ['mode', 'anchorNodeCodes'])
    || value.placementHint.mode !== 'after-selection'
    || !Array.isArray(value.placementHint.anchorNodeCodes)
    || !isSha256(value.snapshotDigest)
  ) return invalid()

  const entries = value.entries.flatMap(parseContextPackEntry)
  const sourceCodes = value.sourceCodes.flatMap(parseContextSourceCode)
  const sourceBoundaries = value.sourceBoundaries.flatMap(parseContextSourceBoundary)
  const anchorNodeCodes = value.placementHint.anchorNodeCodes.flatMap(parseContextNodeCode)
  if (
    entries.length !== value.entries.length
    || sourceCodes.length !== value.sourceCodes.length
    || sourceBoundaries.length !== value.sourceBoundaries.length
    || anchorNodeCodes.length !== value.placementHint.anchorNodeCodes.length
    || anchorNodeCodes.length === 0
    || !anchorNodeCodes.every(code => entries.some(entry => entry.reference.code === code))
  ) return invalid()

  const active = value.revokedAt === null && value.revokedBy === null && value.revocationReason === null
  const revoked = isNonNegativeInteger(value.revokedAt)
    && typeof value.revokedBy === 'string' && Boolean(value.revokedBy)
    && typeof value.revocationReason === 'string' && Boolean(value.revocationReason)
  if (!active && !revoked) return invalid()

  return {
    cvcCode,
    projectCode,
    projectRevision: value.projectRevision,
    createdAt: value.createdAt,
    creator: value.creator,
    entries,
    sourceCodes,
    sourceBoundaries,
    placementHint: { mode: 'after-selection', anchorNodeCodes },
    snapshotDigest: value.snapshotDigest,
    revokedAt: active ? null : value.revokedAt as number,
    revokedBy: active ? null : value.revokedBy as string,
    revocationReason: active ? null : value.revocationReason as string
  }
}

const parseContextPackEntry = (value: unknown): ContextPackEntry[] => {
  if (
    !isClosedRecord(value, ['reference', 'content', 'contentDigest'])
    || !isClosedRecord(value.reference, ['namespace', 'code'])
    || typeof value.content !== 'string'
    || !isSha256(value.contentDigest)
  ) return []
  const namespace = value.reference.namespace
  const expectedPrefix = namespace === 'canvasTemplate'
    ? 'CVT'
    : namespace === 'canvasMedia'
      ? 'CVM'
      : null
  const code = expectedPrefix ? validatePublicReferenceCode(value.reference.code, expectedPrefix) : null
  if (!code || (namespace !== 'canvasTemplate' && namespace !== 'canvasMedia') || !isSafeContextEntryContent(value.content, namespace)) return []
  return [{
    reference: { namespace, code },
    content: value.content,
    contentDigest: value.contentDigest
  }]
}

const parseContextSourceBoundary = (value: unknown): ContextPackSourceBoundary[] => {
  if (
    !isClosedRecord(value, ['nodeCode', 'promptLibraryReferences', 'canvasMediaReferences'])
    || !Array.isArray(value.promptLibraryReferences)
    || !Array.isArray(value.canvasMediaReferences)
  ) return []
  const nodeCode = parseContextNodeCode(value.nodeCode)[0]
  const promptLibraryReferences = value.promptLibraryReferences.flatMap(parsePromptSourceCode)
  const canvasMediaReferences = value.canvasMediaReferences.flatMap(code => parseReferenceCode(code, 'CVM'))
  if (
    !nodeCode
    || promptLibraryReferences.length !== value.promptLibraryReferences.length
    || canvasMediaReferences.length !== value.canvasMediaReferences.length
  ) return []
  return [{ nodeCode, promptLibraryReferences, canvasMediaReferences }]
}

const parseContextNodeCode = (value: unknown): string[] => (
  parseReferenceCode(value, 'CVT').concat(parseReferenceCode(value, 'CVM'))
)

const parsePromptSourceCode = (value: unknown): string[] => (
  parseReferenceCode(value, 'PLP').concat(parseReferenceCode(value, 'PLM'))
)

const parseContextSourceCode = (value: unknown): string[] => (
  parsePromptSourceCode(value).concat(parseReferenceCode(value, 'CVM'))
)

const parseReferenceCode = (
  value: unknown,
  prefix: 'PLP' | 'PLM' | 'CVT' | 'CVM'
): string[] => {
  const code = validatePublicReferenceCode(value, prefix)
  return code ? [code] : []
}

const isSafeContextEntryContent = (
  content: string,
  namespace: 'canvasTemplate' | 'canvasMedia'
): boolean => {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return false
  }
  if (namespace === 'canvasTemplate') {
    return isClosedRecord(value, ['kind', 'text', 'title', 'truncated'])
      && value.kind === 'text'
      && typeof value.text === 'string'
      && typeof value.title === 'string'
      && typeof value.truncated === 'boolean'
  }
  if (!isRecord(value)) return false
  const required = ['height', 'kind', 'title', 'width']
  const optional = ['contentType', 'size']
  if (!hasOnlyKeys(value, required, optional)) return false
  return value.kind === 'image'
    && typeof value.title === 'string'
    && typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0
    && typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0
    && (value.contentType === undefined || typeof value.contentType === 'string')
    && (value.size === undefined || isNonNegativeInteger(value.size))
}

const requireContextPackCode = (value: string): string => {
  const code = validatePublicReferenceCode(value, 'CVC')
  if (code) return code
  throw new StorageHttpError(400, 'invalid_context_code', 'Canvas context code is invalid.')
}

const isClosedRecord = <K extends string>(
  value: unknown,
  keys: readonly K[]
): value is Record<K, unknown> => (
  isRecord(value)
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key as K))
)

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: string[],
  optional: string[]
): boolean => (
  required.every(key => Object.prototype.hasOwnProperty.call(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
)

const isSha256 = (value: unknown): value is string => (
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
)
const hasStrings = (value: Record<string, unknown>, keys: string[]): boolean => keys.every(key => typeof value[key] === 'string')
const isNonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0
const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0
const isRunState = (value: unknown): value is ImageGenerationRunState => (
  value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed'
)
const isImageProductOperation = (value: unknown): value is ImageOperationRecipeSnapshot['operation'] => (
  value === 'reference-generate'
  || value === 'effect-render'
  || value === 'global-edit'
  || value === 'region-redraw'
  || value === 'erase'
  || value === 'outpaint'
  || value === 'text-edit'
  || value === 'multi-view'
  || value === 'upscale'
  || value === 'subject-extract'
)
