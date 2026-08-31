import { applyDocumentChangeOperations } from '@/domain/documents/document-suggestions'
import { createPlanningDocumentV1, sha256Utf8 } from '@/domain/documents/planning-document'
import type { IFreeCanvasDocumentNode, IFreeCanvasProject } from '@/models/PromptHistory.model'
import type {
  BridgeDocumentChangeDelivery,
  BridgeDocumentCreateDelivery,
  BridgeDocumentDelivery
} from '@/storage/storage-service-client'

export interface BridgeDocumentApplication {
  kind: BridgeDocumentDelivery['request']['kind']
  nodeId: string | null
  documentCode: string | null
  resultDigest: string
  marker: {
    version: 1
    proposalId: string
    agentName: string
    profileId: string
    cvcCode: string
    clientRequestId: string
    normalizedRequestDigest: string
    sourceCodes: string[]
    skillPins: BridgeDocumentDelivery['request']['skillPins']
    documentCode: string | null
    baseRevision: number | null
    baseDigest: string | null
    resultDigest: string
  }
}

export type BridgeDocumentApplicationInspection =
  | { status: 'missing'; node?: undefined }
  | { status: 'exact'; node: IFreeCanvasDocumentNode }
  | { status: 'conflict'; node?: IFreeCanvasDocumentNode }

export const createBridgeDocumentApplication = (
  delivery: BridgeDocumentDelivery
): BridgeDocumentApplication => {
  const create = delivery.request.kind === 'document.create'
  const createDelivery = create ? delivery as BridgeDocumentCreateDelivery : null
  const changeDelivery = create ? null : delivery as BridgeDocumentChangeDelivery
  const resultDigest = create
    ? createPlanningDocumentV1(createDelivery!.request.payload.blocks).digest
    : `sha256:${sha256Utf8(canonicalJson({
        proposalId: delivery.proposalId,
        target: changeDelivery!.request.target,
        operations: changeDelivery!.request.payload.operations
      }))}`
  const documentCode = create ? null : changeDelivery!.request.target.documentCode
  const marker: BridgeDocumentApplication['marker'] = {
    version: 1,
    proposalId: delivery.proposalId,
    agentName: delivery.visualProposal.agentName,
    profileId: delivery.operationContext.profileId,
    cvcCode: delivery.request.target.cvcCode,
    clientRequestId: delivery.request.clientRequestId,
    normalizedRequestDigest: delivery.request.normalizedRequestDigest,
    sourceCodes: [...delivery.request.sourceCodes],
    skillPins: delivery.request.skillPins.map(pin => ({ ...pin })),
    documentCode,
    baseRevision: create ? null : changeDelivery!.request.target.baseRevision,
    baseDigest: create ? null : changeDelivery!.request.target.baseDigest,
    resultDigest
  }
  const identityDigest = sha256Utf8(canonicalJson(marker))
  return {
    kind: delivery.request.kind,
    nodeId: create ? `bridge-document-${identityDigest.slice(0, 32)}` : null,
    documentCode,
    resultDigest,
    marker
  }
}

export const createBridgeDocumentNode = (
  delivery: BridgeDocumentCreateDelivery,
  application: BridgeDocumentApplication,
  position: { x: number; y: number }
): IFreeCanvasDocumentNode => {
  const nodeId: string = application.nodeId || fail('bridge_document_application_kind_invalid')
  if (application.kind !== 'document.create') fail('bridge_document_application_kind_invalid')
  const document = createPlanningDocumentV1(delivery.request.payload.blocks)
  if (document.digest !== application.resultDigest) fail('bridge_document_result_integrity')
  return {
    id: nodeId,
    kind: 'document',
    title: delivery.request.payload.title,
    position,
    width: 560,
    height: 420,
    document,
    linkedDocumentResourceIds: [],
    meta: {
      source: 'promptcard-bridge',
      bridgeDocumentDelivery: application.marker
    }
  }
}

export const applyBridgeDocumentChange = (
  node: IFreeCanvasDocumentNode,
  delivery: BridgeDocumentChangeDelivery,
  application: BridgeDocumentApplication
): IFreeCanvasDocumentNode => {
  if (
    application.kind !== 'document.change'
    || node.referenceCode !== delivery.request.target.documentCode
    || node.document.revision !== delivery.request.target.baseRevision
    || node.document.digest !== delivery.request.target.baseDigest
  ) fail('bridge_document_target_conflict')
  const document = applyDocumentChangeOperations(
    node.document,
    delivery.proposalId,
    delivery.request.payload.operations
  )
  return {
    ...node,
    document,
    meta: {
      ...node.meta,
      source: 'promptcard-bridge',
      bridgeDocumentDelivery: { ...application.marker, resultDigest: document.digest }
    }
  }
}

export const inspectBridgeDocumentApplication = (
  canvas: IFreeCanvasProject,
  application: BridgeDocumentApplication
): BridgeDocumentApplicationInspection => {
  const documents = canvas.nodes.filter((node): node is IFreeCanvasDocumentNode => node.kind === 'document')
  if (application.kind === 'document.create') {
    const identity = documents.filter(node => markerProposalId(node) === application.marker.proposalId)
    const deterministic = documents.filter(node => node.id === application.nodeId)
    if (identity.length === 0 && deterministic.length === 0) return { status: 'missing' }
    if (identity.length !== 1 || deterministic.length !== 1 || identity[0] !== deterministic[0]) return { status: 'conflict' }
    const node = identity[0]
    return exactMarker(node, application) && node.document.digest === application.resultDigest
      ? { status: 'exact', node }
      : { status: 'conflict', node }
  }
  const targets = documents.filter(node => node.referenceCode === application.documentCode)
  if (targets.length !== 1) return { status: 'conflict' }
  const node = targets[0]
  const proposalMarker = markerProposalId(node)
  if (proposalMarker === application.marker.proposalId) {
    const marker = node.meta.bridgeDocumentDelivery as { resultDigest?: unknown }
    return exactMarker(node, { ...application, marker: { ...application.marker, resultDigest: String(marker.resultDigest) } })
      && marker.resultDigest === node.document.digest
      ? { status: 'exact', node }
      : { status: 'conflict', node }
  }
  return node.document.revision === application.marker.baseRevision
    && node.document.digest === application.marker.baseDigest
    ? { status: 'missing' }
    : { status: 'conflict', node }
}

const markerProposalId = (node: IFreeCanvasDocumentNode): string | undefined => {
  const marker = node.meta.bridgeDocumentDelivery
  return marker && typeof marker === 'object' && !Array.isArray(marker)
    && typeof (marker as { proposalId?: unknown }).proposalId === 'string'
    ? (marker as { proposalId: string }).proposalId
    : undefined
}

const exactMarker = (node: IFreeCanvasDocumentNode, application: BridgeDocumentApplication): boolean => (
  canonicalJson(node.meta.bridgeDocumentDelivery) === canonicalJson(application.marker)
)

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const fail = (code: string): never => {
  throw new Error(code)
}
