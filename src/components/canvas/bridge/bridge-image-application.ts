import { canvasImageAssetUrl } from '@/components/canvas/canvas-image-assets'
import { createFreeCanvasImageNodeFromMedia } from '@/domain/free-canvas/free-canvas-project'
import type { IFreeCanvasImageNode, IFreeCanvasProject } from '@/models/PromptHistory.model'
import type { BridgeImageDelivery } from '@/storage/storage-service-client'

export interface BridgeImageApplication {
  nodeId: string
  assetId: string
  marker: {
    version: 1
    proposalId: string
    profileId: string
    cvcCode: string
    clientRequestId: string
    normalizedRequestDigest: string
    sourceCodes: string[]
    skillPins: BridgeImageDelivery['request']['skillPins']
    target: BridgeImageDelivery['request']['target']
    stagedAssetHandle: string
    resultDigest: string
  }
}

export const createBridgeImageApplication = async (
  delivery: BridgeImageDelivery
): Promise<BridgeImageApplication> => {
  const resultDigest = await sha256Text(canonicalJson({
    assetId: delivery.visualProposal.assetId,
    contentType: delivery.visualProposal.contentType,
    width: delivery.visualProposal.width,
    height: delivery.visualProposal.height,
    altText: delivery.visualProposal.altText
  }))
  const marker: BridgeImageApplication['marker'] = {
    version: 1,
    proposalId: delivery.proposalId,
    profileId: delivery.operationContext.profileId,
    cvcCode: delivery.request.target.cvcCode,
    clientRequestId: delivery.request.clientRequestId,
    normalizedRequestDigest: delivery.request.normalizedRequestDigest,
    sourceCodes: delivery.request.sourceCodes,
    skillPins: delivery.request.skillPins,
    target: delivery.request.target,
    stagedAssetHandle: delivery.request.payload.stagedAssetHandle,
    resultDigest
  }
  const applicationDigest = await sha256Text(canonicalJson(marker))
  return {
    nodeId: `bridge-image-${applicationDigest.slice(7, 39)}`,
    assetId: delivery.visualProposal.assetId,
    marker
  }
}

export const createBridgeImageNode = (
  delivery: BridgeImageDelivery,
  application: BridgeImageApplication,
  position: { x: number; y: number }
): IFreeCanvasImageNode => {
  const sourceWidth = Math.max(1, delivery.visualProposal.width)
  const sourceHeight = Math.max(1, delivery.visualProposal.height)
  const width = Math.min(360, sourceWidth)
  const height = Math.max(1, Math.round(sourceHeight * (width / sourceWidth)))
  const created = createFreeCanvasImageNodeFromMedia({
    id: application.nodeId,
    kind: 'imageAsset',
    title: delivery.visualProposal.title || 'External Agent Image',
    position,
    width,
    height,
    assetId: delivery.visualProposal.assetId,
    imageUrl: canvasImageAssetUrl(delivery.visualProposal.assetId),
    imagePrompt: '',
    sourceNodeId: null,
    meta: {
      source: 'promptcard-bridge',
      altText: delivery.visualProposal.altText,
      bridgeDelivery: application.marker
    }
  })
  return { ...created, id: application.nodeId }
}

export const inspectBridgeImageApplication = (
  canvas: IFreeCanvasProject,
  application: BridgeImageApplication
): { status: 'missing' | 'exact' | 'conflict' } => {
  const identityMatches = canvas.nodes.filter((node): node is IFreeCanvasImageNode => {
    if (node.kind !== 'image') return false
    const marker = node.meta?.bridgeDelivery as { proposalId?: unknown } | undefined
    return marker?.proposalId === application.marker.proposalId
  })
  const deterministicMatches = canvas.nodes.filter(node => node.id === application.nodeId)
  if (identityMatches.length === 0 && deterministicMatches.length === 0) return { status: 'missing' }
  if (
    identityMatches.length !== 1
    || deterministicMatches.length !== 1
    || deterministicMatches[0] !== identityMatches[0]
  ) return { status: 'conflict' }
  const node = identityMatches[0]
  const exact = node.assetId === application.assetId
    && node.meta?.source === 'promptcard-bridge'
    && canonicalJson(node.meta?.bridgeDelivery) === canonicalJson(application.marker)
  return exact ? { status: 'exact' } : { status: 'conflict' }
}

const sha256Text = async (value: string): Promise<string> => {
  if (!globalThis.crypto?.subtle) throw new Error('sha256_unavailable')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(', ')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}: ${canonicalJson(child)}`)
    return `{${entries.join(', ')}}`
  }
  return JSON.stringify(value)
}
