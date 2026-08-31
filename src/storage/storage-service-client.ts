import type { CardType, IPreset } from '@/models/Card.model'
import type { IPromptProject, PlanningDocumentBlockV1 } from '@/models/PromptHistory.model'
import type { DocumentChangeOperation } from '@/domain/documents/document-suggestions'
import { parsePlanningDocumentV1 } from '@/domain/documents/planning-document'
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
    namespace: 'canvasTemplate' | 'canvasMedia' | 'canvasDocument' | 'canvasStoryboard'
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

export type BridgeDeliveryState = 'previewed' | 'pending_review' | 'accepted' | 'rejected' | 'failed'

export interface BridgePromptDelivery {
  operationContext: {
    profileId: string
    scopes: string[]
    provenance: 'promptcard-bridge'
    clientInfo?: { name: string; version: string }
  }
  request: {
    clientRequestId: string
    normalizedRequestDigest: string
    kind: 'prompt.create'
    target: { cvcCode: string }
    sourceCodes: string[]
    skillPins: Array<{ skillCode: string; revision: number; digest: string }>
    rationale: string
    provenance: 'promptcard-bridge'
    payload: { title: string; userText: string }
  }
  proposalId: string
  state: BridgeDeliveryState
  disposition: 'original' | 'replay' | 'conflict'
  resultCodes: string[]
  message: string
  createdAt: string
  updatedAt: string
  visualProposal: {
    kind: 'free_canvas_text_create'
    id: string
    agentName: string
    title: string
    userText: string
    segments: Array<{ source: 'user'; text: string }>
    rationale: string
    status: 'pending' | 'approved' | 'rejected'
    createdAt: number
    bridgeDelivery: {
      profileId: string
      cvcCode: string
      clientRequestId: string
      normalizedRequestDigest: string
      sourceCodes: string[]
      skillPins: Array<{ skillCode: string; revision: number; digest: string }>
    }
  }
}

export interface BridgeImageDelivery {
  operationContext: {
    profileId: string
    scopes: string[]
    provenance: 'promptcard-bridge'
    clientInfo?: { name: string; version: string }
  }
  request: {
    clientRequestId: string
    normalizedRequestDigest: string
    kind: 'image.place'
    target: {
      cvcCode: string
      storyboardCode?: string
      baseRevision?: number
      baseDigest?: string
      shotOrdinal?: number
    }
    sourceCodes: string[]
    skillPins: Array<{ skillCode: string; revision: number; digest: string }>
    rationale: string
    provenance: 'promptcard-bridge'
    payload: { stagedAssetHandle: string; altText?: string }
  }
  proposalId: string
  state: BridgeDeliveryState
  disposition: 'original' | 'replay' | 'conflict'
  resultCodes: string[]
  message: string
  createdAt: string
  updatedAt: string
  visualProposal: {
    kind: 'free_canvas_image_place'
    id: string
    agentName: string
    title: string
    altText: string
    assetId: string
    contentType: 'image/png' | 'image/jpeg' | 'image/webp'
    width: number
    height: number
    rationale: string
    status: 'pending' | 'approved' | 'rejected'
    createdAt: number
    bridgeDelivery: {
      profileId: string
      cvcCode: string
      clientRequestId: string
      normalizedRequestDigest: string
      sourceCodes: string[]
      skillPins: Array<{ skillCode: string; revision: number; digest: string }>
      target: BridgeImageDelivery['request']['target']
      stagedAssetHandle: string
    }
  }
}

interface BridgeDocumentDeliveryBase {
  operationContext: {
    profileId: string
    scopes: string[]
    provenance: 'promptcard-bridge'
    clientInfo?: { name: string; version: string }
  }
  proposalId: string
  state: BridgeDeliveryState
  disposition: 'original' | 'replay' | 'conflict'
  resultCodes: string[]
  message: string
  createdAt: string
  updatedAt: string
}

interface BridgeDocumentProposalBase {
  id: string
  agentName: string
  rationale: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
  bridgeDelivery: {
    profileId: string
    cvcCode: string
    clientRequestId: string
    normalizedRequestDigest: string
    sourceCodes: string[]
    skillPins: Array<{ skillCode: string; revision: number; digest: string }>
  }
}

type BridgeDocumentBlock = Extract<
  PlanningDocumentBlockV1,
  { type: 'paragraph' | 'blockquote' | 'heading' }
>

export interface BridgeDocumentCreateDelivery extends BridgeDocumentDeliveryBase {
  request: {
    clientRequestId: string
    normalizedRequestDigest: string
    kind: 'document.create'
    target: { cvcCode: string }
    sourceCodes: string[]
    skillPins: Array<{ skillCode: string; revision: number; digest: string }>
    rationale: string
    provenance: 'promptcard-bridge'
    payload: { title: string; blocks: BridgeDocumentBlock[] }
  }
  visualProposal: BridgeDocumentProposalBase & {
    kind: 'document_create'
    title: string
    blocks: BridgeDocumentBlock[]
  }
}

export interface BridgeDocumentChangeDelivery extends BridgeDocumentDeliveryBase {
  request: {
    clientRequestId: string
    normalizedRequestDigest: string
    kind: 'document.change'
    target: { cvcCode: string; documentCode: string; baseRevision: number; baseDigest: string }
    sourceCodes: string[]
    skillPins: Array<{ skillCode: string; revision: number; digest: string }>
    rationale: string
    provenance: 'promptcard-bridge'
    payload: { operations: DocumentChangeOperation[] }
  }
  visualProposal: BridgeDocumentProposalBase & {
    kind: 'document_changes'
    documentCode: string
    baseRevision: number
    baseDigest: string
    operations: DocumentChangeOperation[]
  }
}

export type BridgeDocumentDelivery = BridgeDocumentCreateDelivery | BridgeDocumentChangeDelivery

export interface BridgeStoryboardRowPayload {
  cutLabel: string
  timeRange: string
  subject: string
  action: string
  scene: string
  camera: string
  lighting: string
  audio: string
  duration: string
}

export interface BridgeStoryboardSequencePayload {
  name: string
  description: string
  style: string
  constraints: string
  rows: BridgeStoryboardRowPayload[]
}

export type BridgeStoryboardChange =
  | { scope: 'sequence'; field: 'name' | 'description' | 'style' | 'constraints'; value: string }
  | {
    scope: 'row'
    rowOrdinal: number
    field: 'cutLabel' | 'timeRange' | 'subject' | 'action' | 'scene' | 'camera' | 'lighting' | 'audio' | 'duration'
    value: string
  }

interface BridgeStoryboardDeliveryBase extends BridgeDocumentDeliveryBase {}

interface BridgeStoryboardProposalBase extends BridgeDocumentProposalBase {}

export interface BridgeStoryboardCreateDelivery extends BridgeStoryboardDeliveryBase {
  request: {
    clientRequestId: string
    normalizedRequestDigest: string
    kind: 'storyboard.create'
    target: { cvcCode: string }
    sourceCodes: string[]
    skillPins: Array<{ skillCode: string; revision: number; digest: string }>
    rationale: string
    provenance: 'promptcard-bridge'
    payload: {
      title: string
      sourceDocumentCode: string
      sourceDocumentRevision: number
      sourceDocumentDigest: string
      sequence: BridgeStoryboardSequencePayload
    }
  }
  visualProposal: BridgeStoryboardProposalBase & {
    kind: 'storyboard_create'
    title: string
    sourceDocumentCode: string
    sourceDocumentRevision: number
    sourceDocumentDigest: string
    sequence: BridgeStoryboardSequencePayload
  }
}

export interface BridgeStoryboardChangeDelivery extends BridgeStoryboardDeliveryBase {
  request: {
    clientRequestId: string
    normalizedRequestDigest: string
    kind: 'storyboard.change'
    target: { cvcCode: string; storyboardCode: string; baseRevision: number; baseDigest: string }
    sourceCodes: string[]
    skillPins: Array<{ skillCode: string; revision: number; digest: string }>
    rationale: string
    provenance: 'promptcard-bridge'
    payload: { changes: BridgeStoryboardChange[] }
  }
  visualProposal: BridgeStoryboardProposalBase & {
    kind: 'storyboard_changes'
    storyboardCode: string
    baseRevision: number
    baseDigest: string
    changes: BridgeStoryboardChange[]
  }
}

export type BridgeStoryboardDelivery = BridgeStoryboardCreateDelivery | BridgeStoryboardChangeDelivery
export type BridgeDelivery = BridgePromptDelivery | BridgeImageDelivery | BridgeDocumentDelivery | BridgeStoryboardDelivery

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
  bridgeDeliveries: {
    async list(cvcCode: string, state: BridgeDeliveryState = 'pending_review'): Promise<BridgeDelivery[]> {
      const code = requireContextPackCode(cvcCode)
      const payload = await request<{ deliveries?: unknown[] }>(
        `/storage-api/context-packs/${encodeURIComponent(code)}/bridge-deliveries?state=${encodeURIComponent(state)}`
      )
      if (!Array.isArray(payload.deliveries)) {
        throw new StorageHttpError(502, 'invalid_storage_response', 'Storage returned an invalid Bridge delivery list.')
      }
      return payload.deliveries.map(parseBridgeDelivery)
    },
    async decide(
      cvcCode: string,
      proposalId: string,
      decision: 'accepted' | 'rejected',
      resultCodes: string[]
    ): Promise<BridgeDelivery> {
      const code = requireContextPackCode(cvcCode)
      if (!/^DVP-[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(proposalId)) {
        throw new StorageHttpError(400, 'invalid_delivery_proposal', 'Bridge proposal code is invalid.')
      }
      return parseBridgeDelivery(await request<unknown>(
        `/storage-api/context-packs/${encodeURIComponent(code)}/bridge-deliveries/${encodeURIComponent(proposalId)}/decision`,
        { method: 'POST', body: JSON.stringify({ decision, resultCodes }) }
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

const parseBridgePromptDelivery = (value: unknown): BridgePromptDelivery => {
  const invalid = (): never => {
    throw new StorageHttpError(502, 'invalid_storage_response', 'Storage returned an invalid Bridge delivery.')
  }
  if (!isClosedRecord(value, [
    'operationContext', 'request', 'proposalId', 'state', 'disposition', 'resultCodes',
    'message', 'createdAt', 'updatedAt', 'visualProposal'
  ])) return invalid()
  if (
    !isRecord(value.operationContext)
    || !hasOnlyKeys(value.operationContext, ['profileId', 'scopes', 'provenance'], ['clientInfo'])
    || typeof value.operationContext.profileId !== 'string'
    || !Array.isArray(value.operationContext.scopes)
    || !value.operationContext.scopes.every(scope => typeof scope === 'string')
    || value.operationContext.provenance !== 'promptcard-bridge'
    || (value.operationContext.clientInfo !== undefined && (
      !isClosedRecord(value.operationContext.clientInfo, ['name', 'version'])
      || typeof value.operationContext.clientInfo.name !== 'string'
      || typeof value.operationContext.clientInfo.version !== 'string'
    ))
    || !isClosedRecord(value.request, [
      'clientRequestId', 'normalizedRequestDigest', 'kind', 'target', 'sourceCodes',
      'skillPins', 'rationale', 'provenance', 'payload'
    ])
    || typeof value.request.clientRequestId !== 'string'
    || !isSha256(value.request.normalizedRequestDigest)
    || value.request.kind !== 'prompt.create'
    || !isClosedRecord(value.request.target, ['cvcCode'])
    || !validatePublicReferenceCode(value.request.target.cvcCode, 'CVC')
    || !Array.isArray(value.request.sourceCodes)
    || !value.request.sourceCodes.every(code => typeof code === 'string')
    || !Array.isArray(value.request.skillPins)
    || !value.request.skillPins.every(isBridgeSkillPin)
    || typeof value.request.rationale !== 'string'
    || value.request.provenance !== 'promptcard-bridge'
    || !isClosedRecord(value.request.payload, ['title', 'userText'])
    || typeof value.request.payload.title !== 'string'
    || typeof value.request.payload.userText !== 'string'
    || typeof value.proposalId !== 'string'
    || !/^DVP-[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.proposalId)
    || !['previewed', 'pending_review', 'accepted', 'rejected', 'failed'].includes(String(value.state))
    || !['original', 'replay', 'conflict'].includes(String(value.disposition))
    || !Array.isArray(value.resultCodes)
    || !value.resultCodes.every(code => typeof code === 'string')
    || typeof value.message !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !isClosedRecord(value.visualProposal, [
      'kind', 'id', 'agentName', 'title', 'userText', 'segments', 'rationale',
      'status', 'createdAt', 'bridgeDelivery'
    ])
    || value.visualProposal.kind !== 'free_canvas_text_create'
    || value.visualProposal.id !== value.proposalId
    || typeof value.visualProposal.agentName !== 'string'
    || typeof value.visualProposal.title !== 'string'
    || typeof value.visualProposal.userText !== 'string'
    || !Array.isArray(value.visualProposal.segments)
    || !value.visualProposal.segments.every(segment => (
      isClosedRecord(segment, ['source', 'text'])
      && segment.source === 'user'
      && typeof segment.text === 'string'
    ))
    || typeof value.visualProposal.rationale !== 'string'
    || !['pending', 'approved', 'rejected'].includes(String(value.visualProposal.status))
    || typeof value.visualProposal.createdAt !== 'number'
    || !isClosedRecord(value.visualProposal.bridgeDelivery, [
      'profileId', 'cvcCode', 'clientRequestId', 'normalizedRequestDigest',
      'sourceCodes', 'skillPins'
    ])
    || value.visualProposal.bridgeDelivery.profileId !== value.operationContext.profileId
    || value.visualProposal.bridgeDelivery.cvcCode !== value.request.target.cvcCode
    || value.visualProposal.bridgeDelivery.clientRequestId !== value.request.clientRequestId
    || value.visualProposal.bridgeDelivery.normalizedRequestDigest !== value.request.normalizedRequestDigest
    || !Array.isArray(value.visualProposal.bridgeDelivery.sourceCodes)
    || !Array.isArray(value.visualProposal.bridgeDelivery.skillPins)
    || !value.visualProposal.bridgeDelivery.skillPins.every(isBridgeSkillPin)
  ) return invalid()
  return value as unknown as BridgePromptDelivery
}

const parseBridgeDelivery = (value: unknown): BridgeDelivery => {
  if (!isRecord(value) || !isRecord(value.request)) {
    throw new StorageHttpError(502, 'invalid_storage_response', 'Storage returned an invalid Bridge delivery.')
  }
  if (value.request.kind === 'prompt.create') return parseBridgePromptDelivery(value)
  if (value.request.kind === 'image.place') return parseBridgeImageDelivery(value)
  if (value.request.kind === 'document.create' || value.request.kind === 'document.change') {
    return parseBridgeDocumentDelivery(value)
  }
  if (value.request.kind === 'storyboard.create' || value.request.kind === 'storyboard.change') {
    return parseBridgeStoryboardDelivery(value)
  }
  throw new StorageHttpError(502, 'invalid_storage_response', 'Storage returned an invalid Bridge delivery.')
}

const parseBridgeDocumentDelivery = (value: unknown): BridgeDocumentDelivery => {
  const invalid = (): never => {
    throw new StorageHttpError(502, 'invalid_storage_response', 'Storage returned an invalid Bridge document delivery.')
  }
  if (!isClosedRecord(value, [
    'operationContext', 'request', 'proposalId', 'state', 'disposition', 'resultCodes',
    'message', 'createdAt', 'updatedAt', 'visualProposal'
  ]) || !isRecord(value.operationContext) || !isRecord(value.request) || !isRecord(value.visualProposal)) {
    return invalid()
  }
  const request = value.request
  const proposal = value.visualProposal
  const create = request.kind === 'document.create'
  if (!create && request.kind !== 'document.change') return invalid()
  if (
    !hasOnlyKeys(value.operationContext, ['profileId', 'scopes', 'provenance'], ['clientInfo'])
    || typeof value.operationContext.profileId !== 'string'
    || !Array.isArray(value.operationContext.scopes)
    || !value.operationContext.scopes.every(scope => typeof scope === 'string')
    || value.operationContext.provenance !== 'promptcard-bridge'
    || (value.operationContext.clientInfo !== undefined && (
      !isClosedRecord(value.operationContext.clientInfo, ['name', 'version'])
      || typeof value.operationContext.clientInfo.name !== 'string'
      || typeof value.operationContext.clientInfo.version !== 'string'
    ))
    || !isClosedRecord(request, [
      'clientRequestId', 'normalizedRequestDigest', 'kind', 'target', 'sourceCodes',
      'skillPins', 'rationale', 'provenance', 'payload'
    ])
    || typeof request.clientRequestId !== 'string'
    || !isSha256(request.normalizedRequestDigest)
    || !Array.isArray(request.sourceCodes)
    || !request.sourceCodes.every(isBridgeSourceCode)
    || !Array.isArray(request.skillPins)
    || !request.skillPins.every(isBridgeSkillPin)
    || typeof request.rationale !== 'string'
    || request.provenance !== 'promptcard-bridge'
    || typeof value.proposalId !== 'string'
    || !/^DVP-[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.proposalId)
    || !['previewed', 'pending_review', 'accepted', 'rejected', 'failed'].includes(String(value.state))
    || !['original', 'replay', 'conflict'].includes(String(value.disposition))
    || !Array.isArray(value.resultCodes)
    || !value.resultCodes.every(code => typeof code === 'string')
    || typeof value.message !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !isBridgeDocumentTarget(request.target, create)
    || !isBridgeDocumentPayload(request.payload, create)
    || !isBridgeDocumentVisualProposal(proposal, create)
    || proposal.id !== value.proposalId
  ) return invalid()
  const proposalBridge = proposal.bridgeDelivery
  if (!isRecord(proposalBridge)
    || proposalBridge.profileId !== value.operationContext.profileId
    || proposalBridge.cvcCode !== request.target.cvcCode
    || proposalBridge.clientRequestId !== request.clientRequestId
    || proposalBridge.normalizedRequestDigest !== request.normalizedRequestDigest
    || !bridgeValuesEqual(proposalBridge.sourceCodes, request.sourceCodes)
    || !bridgeValuesEqual(proposalBridge.skillPins, request.skillPins)
  ) return invalid()
  if (create) {
    if (
      proposal.kind !== 'document_create'
      || proposal.title !== request.payload.title
      || !bridgeValuesEqual(proposal.blocks, request.payload.blocks)
    ) return invalid()
  } else if (
    proposal.kind !== 'document_changes'
    || proposal.documentCode !== request.target.documentCode
    || proposal.baseRevision !== request.target.baseRevision
    || proposal.baseDigest !== request.target.baseDigest
    || !bridgeValuesEqual(proposal.operations, request.payload.operations)
  ) return invalid()
  return value as unknown as BridgeDocumentDelivery
}

const isBridgeDocumentVisualProposal = (value: Record<string, unknown>, create: boolean): boolean => {
  const keys = create
    ? ['kind', 'id', 'agentName', 'title', 'blocks', 'rationale', 'status', 'createdAt', 'bridgeDelivery']
    : ['kind', 'id', 'agentName', 'documentCode', 'baseRevision', 'baseDigest', 'operations', 'rationale', 'status', 'createdAt', 'bridgeDelivery']
  if (
    !isClosedRecord(value, keys)
    || typeof value.agentName !== 'string'
    || typeof value.rationale !== 'string'
    || !['pending', 'approved', 'rejected'].includes(String(value.status))
    || typeof value.createdAt !== 'number'
    || !isClosedRecord(value.bridgeDelivery, [
      'profileId', 'cvcCode', 'clientRequestId', 'normalizedRequestDigest', 'sourceCodes', 'skillPins'
    ])
    || typeof value.bridgeDelivery.profileId !== 'string'
    || !validatePublicReferenceCode(value.bridgeDelivery.cvcCode, 'CVC')
    || typeof value.bridgeDelivery.clientRequestId !== 'string'
    || !isSha256(value.bridgeDelivery.normalizedRequestDigest)
    || !Array.isArray(value.bridgeDelivery.sourceCodes)
    || !value.bridgeDelivery.sourceCodes.every(isBridgeSourceCode)
    || !Array.isArray(value.bridgeDelivery.skillPins)
    || !value.bridgeDelivery.skillPins.every(isBridgeSkillPin)
  ) return false
  return create
    ? value.kind === 'document_create' && typeof value.title === 'string' && isBridgeDocumentBlocks(value.blocks)
    : value.kind === 'document_changes'
      && Boolean(validatePublicReferenceCode(value.documentCode, 'CVD'))
      && isNonNegativeInteger(value.baseRevision)
      && isSha256(value.baseDigest)
      && isBridgeDocumentOperations(value.operations)
}

const isBridgeDocumentTarget = (value: unknown, create: boolean): value is Record<string, unknown> => {
  if (!isRecord(value)) return false
  if (create) return isClosedRecord(value, ['cvcCode']) && Boolean(validatePublicReferenceCode(value.cvcCode, 'CVC'))
  return isClosedRecord(value, ['cvcCode', 'documentCode', 'baseRevision', 'baseDigest'])
    && Boolean(validatePublicReferenceCode(value.cvcCode, 'CVC'))
    && Boolean(validatePublicReferenceCode(value.documentCode, 'CVD'))
    && isNonNegativeInteger(value.baseRevision)
    && isSha256(value.baseDigest)
}

const isBridgeDocumentPayload = (value: unknown, create: boolean): value is Record<string, unknown> => {
  if (!isRecord(value)) return false
  return create
    ? isClosedRecord(value, ['title', 'blocks'])
      && typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 500
      && isBridgeDocumentBlocks(value.blocks)
    : isClosedRecord(value, ['operations']) && isBridgeDocumentOperations(value.operations)
}

const isBridgeDocumentBlocks = (value: unknown): value is BridgeDocumentBlock[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) return false
  const ids = new Set<string>()
  const inline = (item: unknown): boolean => isRecord(item)
    && hasOnlyKeys(item, ['text'], ['bold', 'italic', 'href'])
    && typeof item.text === 'string'
    && item.text.length <= 10_000
    && (item.bold === undefined || item.bold === true)
    && (item.italic === undefined || item.italic === true)
    && (item.href === undefined || (typeof item.href === 'string' && item.href.length > 0 && item.href.length <= 2048))
  const content = (item: unknown): boolean => Array.isArray(item) && item.length <= 200 && item.every(inline)
  const uniqueId = (item: unknown): boolean => {
    if (typeof item !== 'string' || !item || item.length > 128 || ids.has(item)) return false
    ids.add(item)
    return true
  }
  return value.every(block => {
    if (!isRecord(block) || !uniqueId(block.id)) return false
    if (block.type === 'paragraph' || block.type === 'blockquote') {
      return isClosedRecord(block, ['id', 'type', 'content']) && content(block.content)
    }
    if (block.type === 'heading') {
      return isClosedRecord(block, ['id', 'type', 'level', 'content'])
        && [1, 2, 3].includes(Number(block.level)) && content(block.content)
    }
    return false
  })
}

const isBridgeDocumentOperations = (value: unknown): value is DocumentChangeOperation[] => (
  Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(operation => {
    if (!isRecord(operation)
      || typeof operation.blockId !== 'string' || operation.blockId.length === 0 || operation.blockId.length > 128
      || !isSha256(operation.expectedTextDigest)) return false
    if (operation.kind === 'insert') {
      return isClosedRecord(operation, ['kind', 'blockId', 'utf8Offset', 'text', 'expectedTextDigest'])
        && isNonNegativeInteger(operation.utf8Offset)
        && typeof operation.text === 'string' && operation.text.length > 0 && operation.text.length <= 10_000
    }
    if (operation.kind === 'delete') {
      return isClosedRecord(operation, ['kind', 'blockId', 'utf8Start', 'utf8End', 'expectedTextDigest'])
        && isNonNegativeInteger(operation.utf8Start) && isNonNegativeInteger(operation.utf8End)
        && Number(operation.utf8End) > Number(operation.utf8Start)
    }
    return operation.kind === 'replace'
      && isClosedRecord(operation, ['kind', 'blockId', 'utf8Start', 'utf8End', 'text', 'expectedTextDigest'])
      && isNonNegativeInteger(operation.utf8Start) && isNonNegativeInteger(operation.utf8End)
      && Number(operation.utf8End) > Number(operation.utf8Start)
      && typeof operation.text === 'string' && operation.text.length > 0 && operation.text.length <= 10_000
  })
)

const parseBridgeStoryboardDelivery = (value: unknown): BridgeStoryboardDelivery => {
  const invalid = (): never => {
    throw new StorageHttpError(502, 'invalid_storage_response', 'Storage returned an invalid Bridge storyboard delivery.')
  }
  if (!isClosedRecord(value, [
    'operationContext', 'request', 'proposalId', 'state', 'disposition', 'resultCodes',
    'message', 'createdAt', 'updatedAt', 'visualProposal'
  ]) || !isRecord(value.operationContext) || !isRecord(value.request) || !isRecord(value.visualProposal)) {
    return invalid()
  }
  const request = value.request
  const proposal = value.visualProposal
  const create = request.kind === 'storyboard.create'
  if ((!create && request.kind !== 'storyboard.change')
    || !hasOnlyKeys(value.operationContext, ['profileId', 'scopes', 'provenance'], ['clientInfo'])
    || typeof value.operationContext.profileId !== 'string'
    || !Array.isArray(value.operationContext.scopes)
    || !value.operationContext.scopes.every(scope => typeof scope === 'string')
    || value.operationContext.provenance !== 'promptcard-bridge'
    || (value.operationContext.clientInfo !== undefined && (
      !isClosedRecord(value.operationContext.clientInfo, ['name', 'version'])
      || typeof value.operationContext.clientInfo.name !== 'string'
      || typeof value.operationContext.clientInfo.version !== 'string'
    ))
    || !isClosedRecord(request, [
      'clientRequestId', 'normalizedRequestDigest', 'kind', 'target', 'sourceCodes',
      'skillPins', 'rationale', 'provenance', 'payload'
    ])
    || typeof request.clientRequestId !== 'string'
    || !isSha256(request.normalizedRequestDigest)
    || !Array.isArray(request.sourceCodes)
    || !request.sourceCodes.every(isBridgeSourceCode)
    || !Array.isArray(request.skillPins)
    || !request.skillPins.every(isBridgeSkillPin)
    || typeof request.rationale !== 'string'
    || request.provenance !== 'promptcard-bridge'
    || typeof value.proposalId !== 'string'
    || !/^DVP-[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.proposalId)
    || !['previewed', 'pending_review', 'accepted', 'rejected', 'failed'].includes(String(value.state))
    || !['original', 'replay', 'conflict'].includes(String(value.disposition))
    || !Array.isArray(value.resultCodes)
    || !value.resultCodes.every(code => typeof code === 'string')
    || typeof value.message !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !isBridgeStoryboardTarget(request.target, create)
    || !isBridgeStoryboardPayload(request.payload, create)
    || !isBridgeStoryboardVisualProposal(proposal, create)
    || proposal.id !== value.proposalId
  ) return invalid()
  const proposalBridge = proposal.bridgeDelivery
  if (!isRecord(proposalBridge)
    || proposalBridge.profileId !== value.operationContext.profileId
    || proposalBridge.cvcCode !== request.target.cvcCode
    || proposalBridge.clientRequestId !== request.clientRequestId
    || proposalBridge.normalizedRequestDigest !== request.normalizedRequestDigest
    || !bridgeValuesEqual(proposalBridge.sourceCodes, request.sourceCodes)
    || !bridgeValuesEqual(proposalBridge.skillPins, request.skillPins)
  ) return invalid()
  if (create) {
    if (proposal.kind !== 'storyboard_create'
      || proposal.title !== request.payload.title
      || proposal.sourceDocumentCode !== request.payload.sourceDocumentCode
      || proposal.sourceDocumentRevision !== request.payload.sourceDocumentRevision
      || proposal.sourceDocumentDigest !== request.payload.sourceDocumentDigest
      || !bridgeValuesEqual(proposal.sequence, request.payload.sequence)
    ) return invalid()
  } else if (proposal.kind !== 'storyboard_changes'
    || proposal.storyboardCode !== request.target.storyboardCode
    || proposal.baseRevision !== request.target.baseRevision
    || proposal.baseDigest !== request.target.baseDigest
    || !bridgeValuesEqual(proposal.changes, request.payload.changes)
  ) return invalid()
  return value as unknown as BridgeStoryboardDelivery
}

const isBridgeStoryboardVisualProposal = (value: Record<string, unknown>, create: boolean): boolean => {
  const keys = create
    ? [
        'kind', 'id', 'agentName', 'title', 'sourceDocumentCode', 'sourceDocumentRevision',
        'sourceDocumentDigest', 'sequence', 'rationale', 'status', 'createdAt', 'bridgeDelivery'
      ]
    : [
        'kind', 'id', 'agentName', 'storyboardCode', 'baseRevision', 'baseDigest',
        'changes', 'rationale', 'status', 'createdAt', 'bridgeDelivery'
      ]
  if (!isClosedRecord(value, keys)
    || typeof value.agentName !== 'string'
    || typeof value.rationale !== 'string'
    || !['pending', 'approved', 'rejected'].includes(String(value.status))
    || typeof value.createdAt !== 'number'
    || !isClosedRecord(value.bridgeDelivery, [
      'profileId', 'cvcCode', 'clientRequestId', 'normalizedRequestDigest', 'sourceCodes', 'skillPins'
    ])
    || typeof value.bridgeDelivery.profileId !== 'string'
    || !validatePublicReferenceCode(value.bridgeDelivery.cvcCode, 'CVC')
    || typeof value.bridgeDelivery.clientRequestId !== 'string'
    || !isSha256(value.bridgeDelivery.normalizedRequestDigest)
    || !Array.isArray(value.bridgeDelivery.sourceCodes)
    || !value.bridgeDelivery.sourceCodes.every(isBridgeSourceCode)
    || !Array.isArray(value.bridgeDelivery.skillPins)
    || !value.bridgeDelivery.skillPins.every(isBridgeSkillPin)
  ) return false
  return create
    ? value.kind === 'storyboard_create'
      && typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 500
      && Boolean(validatePublicReferenceCode(value.sourceDocumentCode, 'CVD'))
      && isNonNegativeInteger(value.sourceDocumentRevision)
      && isSha256(value.sourceDocumentDigest)
      && isBridgeStoryboardSequence(value.sequence)
    : value.kind === 'storyboard_changes'
      && Boolean(validatePublicReferenceCode(value.storyboardCode, 'CVS'))
      && isNonNegativeInteger(value.baseRevision)
      && isSha256(value.baseDigest)
      && isBridgeStoryboardChanges(value.changes)
}

const isBridgeStoryboardTarget = (value: unknown, create: boolean): value is Record<string, unknown> => {
  if (!isRecord(value)) return false
  if (create) return isClosedRecord(value, ['cvcCode']) && Boolean(validatePublicReferenceCode(value.cvcCode, 'CVC'))
  return isClosedRecord(value, ['cvcCode', 'storyboardCode', 'baseRevision', 'baseDigest'])
    && Boolean(validatePublicReferenceCode(value.cvcCode, 'CVC'))
    && Boolean(validatePublicReferenceCode(value.storyboardCode, 'CVS'))
    && isNonNegativeInteger(value.baseRevision)
    && isSha256(value.baseDigest)
}

const isBridgeStoryboardPayload = (value: unknown, create: boolean): value is Record<string, unknown> => {
  if (!isRecord(value)) return false
  if (!create) return isClosedRecord(value, ['changes']) && isBridgeStoryboardChanges(value.changes)
  return isClosedRecord(value, [
    'title', 'sourceDocumentCode', 'sourceDocumentRevision', 'sourceDocumentDigest', 'sequence'
  ])
    && typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 500
    && Boolean(validatePublicReferenceCode(value.sourceDocumentCode, 'CVD'))
    && isNonNegativeInteger(value.sourceDocumentRevision)
    && isSha256(value.sourceDocumentDigest)
    && isBridgeStoryboardSequence(value.sequence)
}

const STORYBOARD_ROW_FIELDS = [
  'cutLabel', 'timeRange', 'subject', 'action', 'scene',
  'camera', 'lighting', 'audio', 'duration'
] as const

const isBridgeStoryboardSequence = (value: unknown): value is BridgeStoryboardSequencePayload => (
  isClosedRecord(value, ['name', 'description', 'style', 'constraints', 'rows'])
  && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 10_000
  && (['description', 'style', 'constraints'] as const).every(field => (
    typeof value[field] === 'string' && value[field].length <= 10_000
  ))
  && Array.isArray(value.rows) && value.rows.length > 0 && value.rows.length <= 200
  && value.rows.every(row => isClosedRecord(row, STORYBOARD_ROW_FIELDS)
    && STORYBOARD_ROW_FIELDS.every(field => typeof row[field] === 'string' && row[field].length <= 10_000))
)

const isBridgeStoryboardChanges = (value: unknown): value is BridgeStoryboardChange[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return false
  const identities = new Set<string>()
  return value.every(change => {
    if (!isRecord(change) || typeof change.value !== 'string' || change.value.length > 10_000) return false
    if (change.scope === 'sequence') {
      const valid = isClosedRecord(change, ['scope', 'field', 'value'])
        && ['name', 'description', 'style', 'constraints'].includes(String(change.field))
      const identity = `sequence:${String(change.field)}`
      if (!valid || identities.has(identity)) return false
      identities.add(identity)
      return true
    }
    const valid = change.scope === 'row'
      && isClosedRecord(change, ['scope', 'rowOrdinal', 'field', 'value'])
      && isNonNegativeInteger(change.rowOrdinal) && change.rowOrdinal <= 199
      && STORYBOARD_ROW_FIELDS.includes(change.field as typeof STORYBOARD_ROW_FIELDS[number])
    const identity = `row:${String(change.rowOrdinal)}:${String(change.field)}`
    if (!valid || identities.has(identity)) return false
    identities.add(identity)
    return true
  })
}

const isBridgeSourceCode = (value: unknown): boolean => (
  ['PLP', 'PLM', 'PRJ', 'CVT', 'CVM', 'CVC', 'CVD', 'CVS', 'SKL'].some(prefix => (
    Boolean(validatePublicReferenceCode(value, prefix as Parameters<typeof validatePublicReferenceCode>[1]))
  ))
)

const bridgeValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((item, index) => bridgeValuesEqual(item, right[index]))
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && bridgeValuesEqual(left[key], right[key]))
  }
  return left === right
}

const parseBridgeImageDelivery = (value: unknown): BridgeImageDelivery => {
  const invalid = (): never => {
    throw new StorageHttpError(502, 'invalid_storage_response', 'Storage returned an invalid Bridge image delivery.')
  }
  if (!isClosedRecord(value, [
    'operationContext', 'request', 'proposalId', 'state', 'disposition', 'resultCodes',
    'message', 'createdAt', 'updatedAt', 'visualProposal'
  ])) return invalid()
  if (
    !isRecord(value.operationContext)
    || !isClosedRecord(value.request, [
      'clientRequestId', 'normalizedRequestDigest', 'kind', 'target', 'sourceCodes',
      'skillPins', 'rationale', 'provenance', 'payload'
    ])
    || !isRecord(value.request.target)
    || !isRecord(value.request.payload)
    || !isClosedRecord(value.visualProposal, [
      'kind', 'id', 'agentName', 'title', 'altText', 'assetId', 'contentType',
      'width', 'height', 'rationale', 'status', 'createdAt', 'bridgeDelivery'
    ])
    || !isClosedRecord(value.visualProposal.bridgeDelivery, [
      'profileId', 'cvcCode', 'clientRequestId', 'normalizedRequestDigest',
      'sourceCodes', 'skillPins', 'target', 'stagedAssetHandle'
    ])
  ) return invalid()
  if (
    !isRecord(value.operationContext)
    || !hasOnlyKeys(value.operationContext, ['profileId', 'scopes', 'provenance'], ['clientInfo'])
    || typeof value.operationContext.profileId !== 'string'
    || !Array.isArray(value.operationContext.scopes)
    || !value.operationContext.scopes.every(scope => typeof scope === 'string')
    || value.operationContext.provenance !== 'promptcard-bridge'
    || (value.operationContext.clientInfo !== undefined && (
      !isClosedRecord(value.operationContext.clientInfo, ['name', 'version'])
      || typeof value.operationContext.clientInfo.name !== 'string'
      || typeof value.operationContext.clientInfo.version !== 'string'
    ))
    || !isClosedRecord(value.request, [
      'clientRequestId', 'normalizedRequestDigest', 'kind', 'target', 'sourceCodes',
      'skillPins', 'rationale', 'provenance', 'payload'
    ])
    || typeof value.request.clientRequestId !== 'string'
    || !isSha256(value.request.normalizedRequestDigest)
    || value.request.kind !== 'image.place'
    || !isBridgeImageTarget(value.request.target)
    || !Array.isArray(value.request.sourceCodes)
    || !value.request.sourceCodes.every(code => typeof code === 'string')
    || !Array.isArray(value.request.skillPins)
    || !value.request.skillPins.every(isBridgeSkillPin)
    || typeof value.request.rationale !== 'string'
    || value.request.provenance !== 'promptcard-bridge'
    || !hasOnlyKeys(value.request.payload, ['stagedAssetHandle'], ['altText'])
    || typeof value.request.payload.stagedAssetHandle !== 'string'
    || !/^AST-[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.request.payload.stagedAssetHandle)
    || (value.request.payload.altText !== undefined && typeof value.request.payload.altText !== 'string')
    || typeof value.proposalId !== 'string'
    || !/^DVP-[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.proposalId)
    || !['previewed', 'pending_review', 'accepted', 'rejected', 'failed'].includes(String(value.state))
    || !['original', 'replay', 'conflict'].includes(String(value.disposition))
    || !Array.isArray(value.resultCodes)
    || !value.resultCodes.every(code => typeof code === 'string')
    || typeof value.message !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !isClosedRecord(value.visualProposal, [
      'kind', 'id', 'agentName', 'title', 'altText', 'assetId', 'contentType',
      'width', 'height', 'rationale', 'status', 'createdAt', 'bridgeDelivery'
    ])
    || value.visualProposal.kind !== 'free_canvas_image_place'
    || value.visualProposal.id !== value.proposalId
    || typeof value.visualProposal.agentName !== 'string'
    || typeof value.visualProposal.title !== 'string'
    || typeof value.visualProposal.altText !== 'string'
    || typeof value.visualProposal.assetId !== 'string'
    || !['image/png', 'image/jpeg', 'image/webp'].includes(String(value.visualProposal.contentType))
    || !isPositiveInteger(value.visualProposal.width)
    || !isPositiveInteger(value.visualProposal.height)
    || typeof value.visualProposal.rationale !== 'string'
    || !['pending', 'approved', 'rejected'].includes(String(value.visualProposal.status))
    || typeof value.visualProposal.createdAt !== 'number'
    || !isClosedRecord(value.visualProposal.bridgeDelivery, [
      'profileId', 'cvcCode', 'clientRequestId', 'normalizedRequestDigest',
      'sourceCodes', 'skillPins', 'target', 'stagedAssetHandle'
    ])
    || value.visualProposal.bridgeDelivery.profileId !== value.operationContext.profileId
    || value.visualProposal.bridgeDelivery.cvcCode !== value.request.target.cvcCode
    || value.visualProposal.bridgeDelivery.clientRequestId !== value.request.clientRequestId
    || value.visualProposal.bridgeDelivery.normalizedRequestDigest !== value.request.normalizedRequestDigest
    || value.visualProposal.bridgeDelivery.stagedAssetHandle !== value.request.payload.stagedAssetHandle
    || !Array.isArray(value.visualProposal.bridgeDelivery.sourceCodes)
    || !Array.isArray(value.visualProposal.bridgeDelivery.skillPins)
    || !value.visualProposal.bridgeDelivery.skillPins.every(isBridgeSkillPin)
    || !isBridgeImageTarget(value.visualProposal.bridgeDelivery.target)
  ) return invalid()
  return value as unknown as BridgeImageDelivery
}

const isBridgeImageTarget = (value: unknown): boolean => {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['cvcCode'],
    ['storyboardCode', 'baseRevision', 'baseDigest', 'shotOrdinal']
  ) || !validatePublicReferenceCode(value.cvcCode, 'CVC')) return false
  const optional = [value.storyboardCode, value.baseRevision, value.baseDigest, value.shotOrdinal]
  if (optional.every(item => item === undefined)) return true
  return validatePublicReferenceCode(value.storyboardCode, 'CVS') !== null
    && isNonNegativeInteger(value.baseRevision)
    && isSha256(value.baseDigest)
    && isNonNegativeInteger(value.shotOrdinal)
    && Number(value.shotOrdinal) <= 199
}

const isBridgeSkillPin = (value: unknown): boolean => (
  isClosedRecord(value, ['skillCode', 'revision', 'digest'])
  && Boolean(validatePublicReferenceCode(value.skillCode, 'SKL'))
  && isPositiveInteger(value.revision)
  && isSha256(value.digest)
)

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
      : namespace === 'canvasDocument'
        ? 'CVD'
        : namespace === 'canvasStoryboard'
          ? 'CVS'
          : null
  const code = expectedPrefix ? validatePublicReferenceCode(value.reference.code, expectedPrefix) : null
  if (!code || !isContextEntryNamespace(namespace) || !isSafeContextEntryContent(value.content, namespace)) return []
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
  parseReferenceCode(value, 'CVT')
    .concat(parseReferenceCode(value, 'CVM'))
    .concat(parseReferenceCode(value, 'CVD'))
    .concat(parseReferenceCode(value, 'CVS'))
)

const parsePromptSourceCode = (value: unknown): string[] => (
  parseReferenceCode(value, 'PLP').concat(parseReferenceCode(value, 'PLM'))
)

const parseContextSourceCode = (value: unknown): string[] => (
  parsePromptSourceCode(value).concat(parseReferenceCode(value, 'CVM'))
)

const parseReferenceCode = (
  value: unknown,
  prefix: 'PLP' | 'PLM' | 'CVT' | 'CVM' | 'CVD' | 'CVS'
): string[] => {
  const code = validatePublicReferenceCode(value, prefix)
  return code ? [code] : []
}

const isSafeContextEntryContent = (
  content: string,
  namespace: ContextPackEntry['reference']['namespace']
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
  if (namespace === 'canvasDocument') {
    if (
      !isClosedRecord(value, ['kind', 'title', 'revision', 'digest', 'document'])
      || value.kind !== 'document'
      || typeof value.title !== 'string'
      || !isNonNegativeInteger(value.revision)
      || !isSha256(value.digest)
      || !isClosedRecord(value.document, ['version', 'blocks', 'suggestions'])
    ) return false
    return parsePlanningDocumentV1({
      ...value.document,
      revision: value.revision,
      digest: value.digest
    }).ok
  }
  if (namespace === 'canvasStoryboard') return isSafeStoryboardContextEntry(value)
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

const isContextEntryNamespace = (
  value: unknown
): value is ContextPackEntry['reference']['namespace'] => (
  value === 'canvasTemplate'
  || value === 'canvasMedia'
  || value === 'canvasDocument'
  || value === 'canvasStoryboard'
)

const isSafeStoryboardContextEntry = (value: unknown): boolean => {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['kind', 'title', 'revision', 'digest', 'sequence'], ['pendingFieldChanges'])
    || value.kind !== 'storyboard'
    || typeof value.title !== 'string'
    || !isNonNegativeInteger(value.revision)
    || !isSha256(value.digest)
    || !isClosedRecord(value.sequence, ['name', 'description', 'style', 'constraints', 'rows'])
    || typeof value.sequence.name !== 'string'
    || typeof value.sequence.description !== 'string'
    || typeof value.sequence.style !== 'string'
    || typeof value.sequence.constraints !== 'string'
    || !Array.isArray(value.sequence.rows)
    || value.sequence.rows.length > 200
  ) return false
  const fields = [
    'ordinal', 'cutLabel', 'timeRange', 'subject', 'action',
    'scene', 'camera', 'lighting', 'audio', 'duration'
  ] as const
  if (!value.sequence.rows.every((row, index) => (
    isClosedRecord(row, fields)
    && row.ordinal === index
    && fields.slice(1).every(field => typeof row[field] === 'string')
  ))) return false
  return value.pendingFieldChanges === undefined
    || isSafeStoryboardPendingFieldChanges(value.pendingFieldChanges, value.sequence.rows.length)
}

const isSafeStoryboardPendingFieldChanges = (value: unknown, rowCount: number): boolean => {
  if (!Array.isArray(value) || value.length > 32) return false
  const identities = new Set<string>()
  const sequenceFields = new Set(['name', 'description', 'style', 'constraints'])
  const rowFields = new Set([
    'cutLabel', 'timeRange', 'subject', 'action', 'scene',
    'camera', 'lighting', 'audio', 'duration'
  ])
  return value.every(change => {
    if (!isRecord(change)) return false
    let identity: string
    if (change.scope === 'sequence') {
      if (!isClosedRecord(change, ['scope', 'field']) || !sequenceFields.has(String(change.field))) return false
      identity = `sequence:${change.field}`
    } else {
      if (
        !isClosedRecord(change, ['scope', 'rowOrdinal', 'field'])
        || change.scope !== 'row'
        || !isNonNegativeInteger(change.rowOrdinal)
        || Number(change.rowOrdinal) >= rowCount
        || !rowFields.has(String(change.field))
      ) return false
      identity = `row:${change.rowOrdinal}:${change.field}`
    }
    if (identities.has(identity)) return false
    identities.add(identity)
    return true
  })
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
