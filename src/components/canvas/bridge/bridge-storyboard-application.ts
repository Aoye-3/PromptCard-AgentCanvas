import {
  isValidPersistedStoryboardSequence,
  isValidStoryboardPendingFieldChanges,
  storyboardDigest
} from '@/domain/storyboard/canvas-storyboard'
import { sha256Utf8 } from '@/domain/documents/planning-document'
import type {
  IFreeCanvasDocumentNode,
  IFreeCanvasProject,
  IFreeCanvasStoryboardNode,
  IStoryboardRow,
  IStoryboardSequence,
  StoryboardFieldChange,
  StoryboardRowField,
  StoryboardSequenceField
} from '@/models/PromptHistory.model'
import type {
  BridgeStoryboardChangeDelivery,
  BridgeStoryboardCreateDelivery,
  BridgeStoryboardDelivery
} from '@/storage/storage-service-client'

export interface BridgeStoryboardApplication {
  kind: BridgeStoryboardDelivery['request']['kind']
  nodeId: string | null
  storyboardCode: string | null
  marker: {
    version: 1
    proposalId: string
    agentName: string
    profileId: string
    cvcCode: string
    clientRequestId: string
    normalizedRequestDigest: string
    sourceCodes: string[]
    skillPins: BridgeStoryboardDelivery['request']['skillPins']
    storyboardCode: string | null
    baseRevision: number | null
    baseDigest: string | null
  }
}

export type BridgeStoryboardApplicationInspection =
  | { status: 'missing'; node?: undefined }
  | { status: 'exact'; node: IFreeCanvasStoryboardNode }
  | { status: 'conflict'; node?: IFreeCanvasStoryboardNode }

export const createBridgeStoryboardApplication = (
  delivery: BridgeStoryboardDelivery
): BridgeStoryboardApplication => {
  const create = delivery.request.kind === 'storyboard.create'
  const change = create ? null : delivery as BridgeStoryboardChangeDelivery
  const marker: BridgeStoryboardApplication['marker'] = {
    version: 1,
    proposalId: delivery.proposalId,
    agentName: delivery.visualProposal.agentName,
    profileId: delivery.operationContext.profileId,
    cvcCode: delivery.request.target.cvcCode,
    clientRequestId: delivery.request.clientRequestId,
    normalizedRequestDigest: delivery.request.normalizedRequestDigest,
    sourceCodes: [...delivery.request.sourceCodes],
    skillPins: delivery.request.skillPins.map(pin => ({ ...pin })),
    storyboardCode: create ? null : change!.request.target.storyboardCode,
    baseRevision: create ? null : change!.request.target.baseRevision,
    baseDigest: create ? null : change!.request.target.baseDigest
  }
  const identity = sha256Utf8(canonicalJson(marker))
  return {
    kind: delivery.request.kind,
    nodeId: create ? `bridge-storyboard-${identity.slice(0, 32)}` : null,
    storyboardCode: marker.storyboardCode,
    marker
  }
}

export const createBridgeStoryboardNode = (
  delivery: BridgeStoryboardCreateDelivery,
  application: BridgeStoryboardApplication,
  documentNode: IFreeCanvasDocumentNode,
  position: { x: number; y: number }
): IFreeCanvasStoryboardNode => {
  const nodeId = application.nodeId
  if (application.kind !== 'storyboard.create') fail('bridge_storyboard_application_kind_invalid')
  const payload = delivery.request.payload
  if (
    documentNode.referenceCode !== payload.sourceDocumentCode
    || documentNode.document.revision !== payload.sourceDocumentRevision
    || documentNode.document.digest !== payload.sourceDocumentDigest
  ) fail('bridge_storyboard_source_conflict')
  const timestamp = delivery.visualProposal.createdAt
  const identity = sha256Utf8(canonicalJson(application.marker)).slice(0, 20)
  const sequence: IStoryboardSequence = {
    id: `bridge-sequence-${identity}`,
    name: payload.sequence.name,
    description: payload.sequence.description,
    style: payload.sequence.style,
    constraints: payload.sequence.constraints,
    rows: payload.sequence.rows.map((row, index): IStoryboardRow => ({
      id: `bridge-shot-${identity}-${index}`,
      ...row,
      createdAt: timestamp,
      updatedAt: timestamp
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
    meta: {}
  }
  if (!isValidPersistedStoryboardSequence(sequence)) fail('bridge_storyboard_sequence_invalid')
  return {
    id: nodeId ?? fail('bridge_storyboard_application_kind_invalid'),
    kind: 'storyboard',
    title: payload.title,
    position,
    width: 680,
    height: 440,
    sequence,
    source: {
      documentNodeId: documentNode.id,
      documentRevision: documentNode.document.revision,
      documentDigest: documentNode.document.digest,
      documentResourceDigests: [],
      model: {
        connectionId: `bridge:${delivery.operationContext.profileId}`,
        providerId: 'promptcard-bridge',
        modelId: delivery.operationContext.clientInfo?.name || delivery.operationContext.profileId,
        displayName: delivery.visualProposal.agentName,
        capabilities: {}
      },
      skills: delivery.request.skillPins.map(pin => ({
        skillId: pin.skillCode,
        revision: pin.revision,
        digest: pin.digest
      }))
    },
    pendingFieldChanges: [],
    revision: 0,
    digest: storyboardDigest(sequence, []),
    meta: {
      source: 'promptcard-bridge',
      bridgeStoryboardDelivery: application.marker
    }
  }
}

export const applyBridgeStoryboardChange = (
  node: IFreeCanvasStoryboardNode,
  delivery: BridgeStoryboardChangeDelivery,
  application: BridgeStoryboardApplication
): IFreeCanvasStoryboardNode => {
  if (
    application.kind !== 'storyboard.change'
    || node.referenceCode !== delivery.request.target.storyboardCode
    || (node.revision ?? 0) !== delivery.request.target.baseRevision
    || (node.digest ?? storyboardDigest(node.sequence, node.pendingFieldChanges)) !== delivery.request.target.baseDigest
    || node.pendingFieldChanges.length > 0
  ) fail('bridge_storyboard_target_conflict')
  const pendingFieldChanges = delivery.request.payload.changes.map((change, index): StoryboardFieldChange => {
    const id = `sbf-${delivery.proposalId}-${index}`
    if (change.scope === 'sequence') {
      const field = change.field as StoryboardSequenceField
      return {
        id, editId: delivery.proposalId, scope: 'sequence', field,
        previousValue: node.sequence[field], newValue: change.value
      }
    }
    const row = node.sequence.rows[change.rowOrdinal]
    if (!row) fail('bridge_storyboard_row_not_found')
    const field = change.field as StoryboardRowField
    return {
      id, editId: delivery.proposalId, scope: 'row', rowId: row.id, field,
      previousValue: row[field] || '', newValue: change.value
    }
  })
  if (!isValidStoryboardPendingFieldChanges(pendingFieldChanges, node.sequence)) {
    fail('bridge_storyboard_changes_invalid')
  }
  const revision = (node.revision ?? 0) + 1
  const digest = storyboardDigest(node.sequence, pendingFieldChanges)
  return {
    ...node,
    pendingFieldChanges,
    revision,
    digest,
    meta: {
      ...node.meta,
      source: 'promptcard-bridge',
      bridgeStoryboardDelivery: application.marker
    }
  }
}

export const inspectBridgeStoryboardApplication = (
  canvas: IFreeCanvasProject,
  application: BridgeStoryboardApplication
): BridgeStoryboardApplicationInspection => {
  const storyboards = canvas.nodes.filter(
    (node): node is IFreeCanvasStoryboardNode => node.kind === 'storyboard'
  )
  if (application.kind === 'storyboard.create') {
    const identity = storyboards.filter(node => markerProposalId(node) === application.marker.proposalId)
    const deterministic = storyboards.filter(node => node.id === application.nodeId)
    if (identity.length === 0 && deterministic.length === 0) return { status: 'missing' }
    if (identity.length !== 1 || deterministic.length !== 1 || identity[0] !== deterministic[0]) {
      return { status: 'conflict' }
    }
    const node = identity[0]
    return exactMarker(node, application) && node.digest === storyboardDigest(node.sequence, node.pendingFieldChanges)
      ? { status: 'exact', node }
      : { status: 'conflict', node }
  }
  const targets = storyboards.filter(node => node.referenceCode === application.storyboardCode)
  if (targets.length !== 1) return { status: 'conflict' }
  const node = targets[0]
  if (markerProposalId(node) === application.marker.proposalId) {
    return exactMarker(node, application)
      && node.digest === storyboardDigest(node.sequence, node.pendingFieldChanges)
      ? { status: 'exact', node }
      : { status: 'conflict', node }
  }
  return (node.revision ?? 0) === application.marker.baseRevision
    && (node.digest ?? storyboardDigest(node.sequence, node.pendingFieldChanges)) === application.marker.baseDigest
    ? { status: 'missing' }
    : { status: 'conflict', node }
}

const markerProposalId = (node: IFreeCanvasStoryboardNode): string | undefined => {
  const marker = node.meta.bridgeStoryboardDelivery
  return marker && typeof marker === 'object' && !Array.isArray(marker)
    && typeof (marker as { proposalId?: unknown }).proposalId === 'string'
    ? (marker as { proposalId: string }).proposalId
    : undefined
}

const exactMarker = (
  node: IFreeCanvasStoryboardNode,
  application: BridgeStoryboardApplication
): boolean => canonicalJson(node.meta.bridgeStoryboardDelivery) === canonicalJson(application.marker)

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
