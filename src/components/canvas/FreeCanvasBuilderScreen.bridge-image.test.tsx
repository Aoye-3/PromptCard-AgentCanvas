import { describe, expect, it } from 'vitest'
import {
  createBridgeImageApplication,
  createBridgeImageNode,
  inspectBridgeImageApplication
} from './bridge/bridge-image-application'
import type { BridgeImageDelivery } from '@/storage/storage-service-client'
import type { IFreeCanvasProject } from '@/models/PromptHistory.model'

const delivery = (): BridgeImageDelivery => ({
  operationContext: {
    profileId: 'codex-local',
    scopes: ['bridge:deliver:image'],
    provenance: 'promptcard-bridge',
    clientInfo: { name: 'codex', version: '1.0.0' }
  },
  request: {
    clientRequestId: 'image-preview-1',
    normalizedRequestDigest: `sha256:${'a'.repeat(64)}`,
    kind: 'image.place',
    target: { cvcCode: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ' },
    sourceCodes: ['CVT-01ARZ3NDEKTSV4RRFFQ69G5FAW'],
    skillPins: [{
      skillCode: 'SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV',
      revision: 3,
      digest: `sha256:${'b'.repeat(64)}`
    }],
    rationale: 'Place the generated opening frame.',
    provenance: 'promptcard-bridge',
    payload: {
      stagedAssetHandle: 'AST-01ARZ3NDEKTSV4RRFFQ69G5FAV',
      altText: 'Opening frame'
    }
  },
  proposalId: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAX',
  state: 'pending_review',
  disposition: 'original',
  resultCodes: [],
  message: 'waiting',
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
  visualProposal: {
    kind: 'free_canvas_image_place',
    id: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAX',
    agentName: 'codex',
    title: 'opening.png',
    altText: 'Opening frame',
    assetId: 'bridge-image.png',
    contentType: 'image/png',
    width: 640,
    height: 360,
    rationale: 'Place the generated opening frame.',
    status: 'pending',
    createdAt: 0,
    bridgeDelivery: {
      profileId: 'codex-local',
      cvcCode: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      clientRequestId: 'image-preview-1',
      normalizedRequestDigest: `sha256:${'a'.repeat(64)}`,
      sourceCodes: ['CVT-01ARZ3NDEKTSV4RRFFQ69G5FAW'],
      skillPins: [{
        skillCode: 'SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV',
        revision: 3,
        digest: `sha256:${'b'.repeat(64)}`
      }],
      target: { cvcCode: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ' },
      stagedAssetHandle: 'AST-01ARZ3NDEKTSV4RRFFQ69G5FAV'
    }
  }
})

const canvas = (): IFreeCanvasProject => ({ nodes: [], edges: [], meta: {} })

describe('external Bridge image application', () => {
  it('creates one deterministic ordinary image with complete Bridge provenance', async () => {
    const item = delivery()
    const first = await createBridgeImageApplication(item)
    const replay = await createBridgeImageApplication(item)
    const node = createBridgeImageNode(item, first, { x: 40, y: 80 })

    expect(replay).toEqual(first)
    expect(node).toMatchObject({
      id: first.nodeId,
      kind: 'image',
      assetId: 'bridge-image.png',
      width: 360,
      height: 203,
      meta: {
        source: 'promptcard-bridge',
        bridgeDelivery: first.marker
      }
    })
    expect(node.meta).not.toHaveProperty('generationRunId')
    expect(inspectBridgeImageApplication(canvas(), first)).toEqual({ status: 'missing' })
    expect(inspectBridgeImageApplication({ ...canvas(), nodes: [node] }, first)).toEqual({ status: 'exact' })
  })

  it('fails closed instead of duplicating or accepting altered provenance', async () => {
    const item = delivery()
    const application = await createBridgeImageApplication(item)
    const node = createBridgeImageNode(item, application, { x: 0, y: 0 })
    const altered = { ...node, assetId: 'other.png' }

    expect(inspectBridgeImageApplication({ ...canvas(), nodes: [node, { ...node }] }, application))
      .toEqual({ status: 'conflict' })
    expect(inspectBridgeImageApplication({ ...canvas(), nodes: [altered] }, application))
      .toEqual({ status: 'conflict' })
  })
})
