import { describe, expect, it } from 'vitest'
import { createPlanningDocumentV1, sha256Utf8 } from '@/domain/documents/planning-document'
import { normalizeFreeCanvasProject } from '@/domain/free-canvas/free-canvas-project'
import type { IFreeCanvasDocumentNode, IFreeCanvasProject } from '@/models/PromptHistory.model'
import type { BridgeDocumentChangeDelivery, BridgeDocumentCreateDelivery } from '@/storage/storage-service-client'
import {
  applyBridgeDocumentChange,
  createBridgeDocumentApplication,
  createBridgeDocumentNode,
  inspectBridgeDocumentApplication
} from './bridge-document-application'

const CVC = 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ'
const CVD = 'CVD-01ARZ3NDEKTSV4RRFFQ69G5FAW'

describe('bridge Document application', () => {
  it('creates one deterministic native Document with a durable external marker', () => {
    const delivery = createDelivery()
    const application = createBridgeDocumentApplication(delivery)
    const node = createBridgeDocumentNode(delivery, application, { x: 10, y: 20 })
    const canvas = project([node])

    expect(node).toMatchObject({ kind: 'document', title: 'Analysis', position: { x: 10, y: 20 } })
    expect(node.meta.bridgeDocumentDelivery).toEqual(application.marker)
    expect(inspectBridgeDocumentApplication(canvas, application)).toEqual({ status: 'exact', node })
    expect(inspectBridgeDocumentApplication(normalizeFreeCanvasProject(canvas, 1), application).status).toBe('exact')
    expect(createBridgeDocumentApplication(delivery)).toEqual(application)
  })

  it('applies a CVD-targeted change as native tracked suggestions and replays exactly', () => {
    const document = createPlanningDocumentV1([
      { id: 'opening', type: 'paragraph', content: [{ text: 'Opening image' }] }
    ], 2)
    const node: IFreeCanvasDocumentNode = {
      id: 'internal-document-id', referenceCode: CVD, kind: 'document', title: 'Script',
      position: { x: 0, y: 0 }, width: 560, height: 420, document,
      linkedDocumentResourceIds: [], meta: {}
    }
    const delivery = changeDelivery(document.revision, document.digest)
    const application = createBridgeDocumentApplication(delivery)
    const updated = applyBridgeDocumentChange(node, delivery, application)

    expect(updated.document.revision).toBe(3)
    expect(updated.document.suggestions.map(item => item.kind)).toEqual(['delete', 'insert'])
    expect(updated.document.blocks[0]).toMatchObject({ content: [{ text: 'First image' }] })
    expect(inspectBridgeDocumentApplication(project([updated]), application)).toEqual({ status: 'exact', node: updated })
    expect(inspectBridgeDocumentApplication(normalizeFreeCanvasProject(project([updated]), 1), application).status).toBe('exact')
  })

  it('fails closed for stale CVD authority and marker collisions', () => {
    const document = createPlanningDocumentV1([
      { id: 'opening', type: 'paragraph', content: [{ text: 'Opening image' }] }
    ], 2)
    const node: IFreeCanvasDocumentNode = {
      id: 'internal-document-id', referenceCode: CVD, kind: 'document', title: 'Script',
      position: { x: 0, y: 0 }, width: 560, height: 420, document,
      linkedDocumentResourceIds: [], meta: {}
    }
    const delivery = changeDelivery(document.revision, document.digest)
    const application = createBridgeDocumentApplication(delivery)
    const stale = { ...node, document: { ...document, revision: 3 } }

    expect(inspectBridgeDocumentApplication(project([stale]), application).status).toBe('conflict')
    expect(() => applyBridgeDocumentChange(stale, delivery, application)).toThrow('bridge_document_target_conflict')
    expect(inspectBridgeDocumentApplication(project([
      node,
      { ...node, id: 'duplicate-internal-id' }
    ]), application).status).toBe('conflict')
  })
})

const project = (nodes: IFreeCanvasDocumentNode[]): IFreeCanvasProject => ({
  nodes, edges: [], selectedNodeId: null, viewport: { x: 0, y: 0, zoom: 1 }, meta: {}
})

const base = () => ({
  operationContext: {
    profileId: 'codex-local', scopes: ['bridge:deliver:document'], provenance: 'promptcard-bridge' as const,
    clientInfo: { name: 'codex', version: '1.0.0' }
  },
  state: 'pending_review' as const, disposition: 'original' as const, resultCodes: [], message: 'waiting',
  createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z'
})

const marker = (clientRequestId: string, digest: string, sourceCodes: string[]) => ({
  profileId: 'codex-local', cvcCode: CVC, clientRequestId,
  normalizedRequestDigest: digest, sourceCodes, skillPins: []
})

const createDelivery = (): BridgeDocumentCreateDelivery => {
  const digest = `sha256:${'a'.repeat(64)}`
  const blocks = [{ id: 'summary', type: 'paragraph' as const, content: [{ text: 'A rainy opening.' }] }]
  return {
    ...base(),
    request: {
      clientRequestId: 'create-1', normalizedRequestDigest: digest, kind: 'document.create', target: { cvcCode: CVC },
      sourceCodes: [], skillPins: [], rationale: 'Create analysis.', provenance: 'promptcard-bridge',
      payload: { title: 'Analysis', blocks }
    },
    proposalId: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAT',
    visualProposal: {
      kind: 'document_create', id: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAT', agentName: 'codex',
      title: 'Analysis', blocks, rationale: 'Create analysis.', status: 'pending', createdAt: 0,
      bridgeDelivery: marker('create-1', digest, [])
    }
  }
}

const changeDelivery = (baseRevision: number, baseDigest: string): BridgeDocumentChangeDelivery => {
  const digest = `sha256:${'b'.repeat(64)}`
  const expectedTextDigest = `sha256:${sha256Utf8('Opening image')}`
  const operations = [{
    kind: 'replace' as const, blockId: 'opening', utf8Start: 0, utf8End: 7,
    text: 'First', expectedTextDigest
  }]
  return {
    ...base(),
    request: {
      clientRequestId: 'change-1', normalizedRequestDigest: digest, kind: 'document.change',
      target: { cvcCode: CVC, documentCode: CVD, baseRevision, baseDigest },
      sourceCodes: [CVD], skillPins: [], rationale: 'Clarify opening.', provenance: 'promptcard-bridge',
      payload: { operations }
    },
    proposalId: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAS',
    visualProposal: {
      kind: 'document_changes', id: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAS', agentName: 'codex',
      documentCode: CVD, baseRevision, baseDigest, operations, rationale: 'Clarify opening.',
      status: 'pending', createdAt: 0, bridgeDelivery: marker('change-1', digest, [CVD])
    }
  }
}
