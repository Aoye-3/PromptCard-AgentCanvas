import { describe, expect, it } from 'vitest'
import { createPlanningDocumentV1 } from '@/domain/documents/planning-document'
import { storyboardDigest } from '@/domain/storyboard/canvas-storyboard'
import type { IFreeCanvasDocumentNode, IFreeCanvasProject, IFreeCanvasStoryboardNode } from '@/models/PromptHistory.model'
import type {
  BridgeStoryboardChangeDelivery,
  BridgeStoryboardCreateDelivery
} from '@/storage/storage-service-client'
import {
  applyBridgeStoryboardChange,
  createBridgeStoryboardApplication,
  createBridgeStoryboardNode,
  inspectBridgeStoryboardApplication
} from './bridge-storyboard-application'

const CVC = 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ'
const CVD = 'CVD-01ARZ3NDEKTSV4RRFFQ69G5FAW'
const CVS = 'CVS-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const DIGEST = `sha256:${'a'.repeat(64)}`

const documentNode = (): IFreeCanvasDocumentNode => {
  const document = createPlanningDocumentV1([{
    id: 'opening', type: 'paragraph', content: [{ text: 'Rain.' }]
  }], 2)
  return {
    id: 'document-node', referenceCode: CVD, kind: 'document', title: 'Script',
    position: { x: 0, y: 0 }, width: 560, height: 420,
    document, linkedDocumentResourceIds: [], meta: {}
  }
}

const createDelivery = (): BridgeStoryboardCreateDelivery => {
  const document = documentNode()
  const sequence = {
    name: 'Opening', description: 'Quiet reveal', style: 'Naturalistic', constraints: 'No dialogue',
    rows: [{
      cutLabel: '1', timeRange: '00:00-00:04', subject: 'Street', action: 'Rain falls',
      scene: 'Night exterior', camera: 'Slow push', lighting: 'Neon', audio: 'Rain', duration: '4s'
    }]
  }
  return {
    operationContext: {
      profileId: 'codex-local', scopes: ['bridge:deliver:storyboard'], provenance: 'promptcard-bridge',
      clientInfo: { name: 'codex', version: '1.0.0' }
    },
    request: {
      clientRequestId: 'storyboard-create', normalizedRequestDigest: DIGEST,
      kind: 'storyboard.create', target: { cvcCode: CVC }, sourceCodes: [CVD], skillPins: [],
      rationale: 'Create shots.', provenance: 'promptcard-bridge',
      payload: {
        title: 'Opening shots', sourceDocumentCode: CVD,
        sourceDocumentRevision: document.document.revision,
        sourceDocumentDigest: document.document.digest, sequence
      }
    },
    proposalId: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAR', state: 'pending_review', disposition: 'original',
    resultCodes: [], message: 'waiting', createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z',
    visualProposal: {
      kind: 'storyboard_create', id: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAR', agentName: 'codex',
      title: 'Opening shots', sourceDocumentCode: CVD,
      sourceDocumentRevision: document.document.revision,
      sourceDocumentDigest: document.document.digest, sequence,
      rationale: 'Create shots.', status: 'pending', createdAt: 1,
      bridgeDelivery: {
        profileId: 'codex-local', cvcCode: CVC, clientRequestId: 'storyboard-create',
        normalizedRequestDigest: DIGEST, sourceCodes: [CVD], skillPins: []
      }
    }
  }
}

const storyboardNode = (): IFreeCanvasStoryboardNode => {
  const sequence = {
    id: 'sequence', name: 'Opening', description: 'Quiet reveal', style: 'Naturalistic', constraints: 'No dialogue',
    rows: [{
      id: 'row-1', cutLabel: '1', timeRange: '00:00-00:04', subject: 'Street', action: 'Rain falls',
      scene: 'Night exterior', camera: 'Slow push', lighting: 'Neon', audio: 'Rain', duration: '4s',
      createdAt: 1, updatedAt: 1
    }],
    createdAt: 1, updatedAt: 1, meta: {}
  }
  return {
    id: 'storyboard-node', referenceCode: CVS, kind: 'storyboard', title: 'Opening shots',
    position: { x: 600, y: 0 }, width: 680, height: 440, sequence,
    source: {
      documentNodeId: 'document-node', documentRevision: 2, documentDigest: documentNode().document.digest,
      documentResourceDigests: [],
      model: {
        connectionId: 'bridge:codex-local', providerId: 'promptcard-bridge', modelId: 'codex',
        displayName: 'codex', capabilities: {}
      },
      skills: []
    },
    pendingFieldChanges: [], revision: 1, digest: storyboardDigest(sequence, []), meta: {}
  }
}

const changeDelivery = (node: IFreeCanvasStoryboardNode): BridgeStoryboardChangeDelivery => ({
  ...createDelivery(),
  request: {
    ...createDelivery().request,
    clientRequestId: 'storyboard-change', kind: 'storyboard.change',
    target: {
      cvcCode: CVC, storyboardCode: CVS,
      baseRevision: node.revision || 0, baseDigest: node.digest || ''
    },
    sourceCodes: [CVS],
    payload: { changes: [{ scope: 'row', rowOrdinal: 0, field: 'duration', value: '3s' }] }
  },
  proposalId: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAQ',
  visualProposal: {
    kind: 'storyboard_changes', id: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAQ', agentName: 'codex',
    storyboardCode: CVS, baseRevision: node.revision || 0, baseDigest: node.digest || '',
    changes: [{ scope: 'row', rowOrdinal: 0, field: 'duration', value: '3s' }],
    rationale: 'Tighten shot.', status: 'pending', createdAt: 2,
    bridgeDelivery: {
      profileId: 'codex-local', cvcCode: CVC, clientRequestId: 'storyboard-change',
      normalizedRequestDigest: DIGEST, sourceCodes: [CVS], skillPins: []
    }
  }
})

const canvas = (nodes: IFreeCanvasProject['nodes']): IFreeCanvasProject => ({
  nodes, edges: [], selectedNodeId: null, viewport: null, meta: {}
})

describe('Bridge Storyboard application', () => {
  it('creates one deterministic native Storyboard linked to the exact Document', () => {
    const delivery = createDelivery()
    const application = createBridgeStoryboardApplication(delivery)
    const node = createBridgeStoryboardNode(delivery, application, documentNode(), { x: 20, y: 40 })

    expect(node.id).toBe(application.nodeId)
    expect(node.sequence.rows[0].id).toMatch(/^bridge-shot-/)
    expect(node.source.documentNodeId).toBe('document-node')
    expect(node.source.model.providerId).toBe('promptcard-bridge')
    expect(inspectBridgeStoryboardApplication(canvas([documentNode(), node]), application)).toEqual({
      status: 'exact', node
    })
  })

  it('maps an ordinal change into the existing row field review model', () => {
    const original = storyboardNode()
    const delivery = changeDelivery(original)
    const application = createBridgeStoryboardApplication(delivery)
    const changed = applyBridgeStoryboardChange(original, delivery, application)

    expect(changed.sequence.rows[0].duration).toBe('4s')
    expect(changed.pendingFieldChanges).toEqual([expect.objectContaining({
      scope: 'row', rowId: 'row-1', field: 'duration', previousValue: '4s', newValue: '3s'
    })])
    expect(inspectBridgeStoryboardApplication(canvas([changed]), application)).toEqual({
      status: 'exact', node: changed
    })
  })

  it('fails closed on a stale target and reports duplicate create identity as conflict', () => {
    const original = storyboardNode()
    const delivery = changeDelivery(original)
    const application = createBridgeStoryboardApplication(delivery)
    expect(() => applyBridgeStoryboardChange(
      { ...original, revision: 2 }, delivery, application
    )).toThrow('bridge_storyboard_target_conflict')

    const createApplication = createBridgeStoryboardApplication(createDelivery())
    const first = createBridgeStoryboardNode(createDelivery(), createApplication, documentNode(), { x: 0, y: 0 })
    expect(inspectBridgeStoryboardApplication(
      canvas([first, { ...first, id: `${first.id}-copy` }]), createApplication
    ).status).toBe('conflict')
  })
})
