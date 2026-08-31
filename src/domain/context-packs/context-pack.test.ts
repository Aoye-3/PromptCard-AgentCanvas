import { describe, expect, it } from 'vitest'
import type { IFreeCanvasNode, IPromptProject } from '@/models/PromptHistory.model'
import {
  buildContextPackCreateRequest,
  createContextPackSelectionPreview,
  normalizeContextPackCode
} from './context-pack'

const ulids = {
  project: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  firstText: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  image: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  secondText: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
  context: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
  document: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  storyboard: '01ARZ3NDEKTSV4RRFFQ69G5FB1'
} as const

const textNode = (id: string, title: string, referenceCode?: string): IFreeCanvasNode => ({
  id,
  kind: 'text',
  title,
  referenceCode,
  position: { x: 0, y: 0 },
  width: 420,
  height: 180,
  fontSize: 'large',
  segments: [],
  meta: {}
})

const imageNode = (id: string, title: string, referenceCode?: string, meta: Record<string, unknown> = {}): IFreeCanvasNode => ({
  id,
  kind: 'image',
  title,
  referenceCode,
  position: { x: 0, y: 0 },
  width: 320,
  height: 240,
  annotations: [],
  meta
})

const documentNode = (referenceCode?: string): IFreeCanvasNode => ({
  id: 'document', kind: 'document', title: 'Script document', referenceCode,
  position: { x: 0, y: 0 }, width: 560, height: 420,
  document: { version: 1, blocks: [], revision: 1, digest: 'sha256:' + 'a'.repeat(64), suggestions: [] },
  linkedDocumentResourceIds: [], meta: {}
})

const storyboardNode = (referenceCode?: string): IFreeCanvasNode => ({
  id: 'storyboard', kind: 'storyboard', title: 'Shot board', referenceCode,
  position: { x: 0, y: 0 }, width: 640, height: 480,
  sequence: { id: 'sequence', name: 'Shots', description: '', style: '', constraints: '', rows: [], createdAt: 1, updatedAt: 1, meta: {} },
  source: {
    documentNodeId: 'document', documentRevision: 1, documentDigest: 'sha256:' + 'a'.repeat(64),
    documentResourceDigests: [], model: { connectionId: 'c', providerId: 'p', modelId: 'm', displayName: 'Model', capabilities: {} }, skills: []
  },
  pendingFieldChanges: [], meta: {}
})

const project = (overrides: Partial<IPromptProject> = {}): IPromptProject => ({
  id: 'project-internal',
  referenceCode: `PRJ-${ulids.project}`,
  title: 'Context project',
  type: 'free-canvas',
  revision: 7,
  pages: [],
  currentPage: 0,
  freeCanvas: { nodes: [], edges: [], meta: {} },
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  meta: {},
  ...overrides
})

describe('context-pack selection domain', () => {
  it('omits a copied node that still carries another node Storage projection before code backfill', () => {
    const original = imageNode('image', 'Reference frame', `CVM-${ulids.image}`)
    const duplicated = {
      ...original,
      id: 'image-copy',
      title: 'Reference frame copy',
      meta: { ...original.meta, duplicatedFromNodeId: original.id }
    } as IFreeCanvasNode

    const preview = createContextPackSelectionPreview([original, duplicated], ['image-copy'])

    expect(preview).toEqual({ items: [], selectedCount: 1, omittedCount: 1 })
  })

  it('orders only explicitly selected stable CVT/CVM nodes by persisted Canvas order', () => {
    const nodes: IFreeCanvasNode[] = [
      textNode('text-first', 'First', `CVT-${ulids.firstText}`),
      { id: 'arrow', kind: 'arrow', title: 'Arrow', position: { x: 0, y: 0 }, width: 100, height: 50, text: '', color: '#000', meta: {} },
      imageNode('image', 'Image', `CVM-${ulids.image}`),
      textNode('text-second', 'Second', `CVT-${ulids.secondText}`),
      textNode('not-selected', 'Not selected', `CVT-01ARZ3NDEKTSV4RRFFQ69G5FB0`)
    ]

    const preview = createContextPackSelectionPreview(nodes, [
      'text-second', 'arrow', 'image', 'text-first', 'text-second'
    ])

    expect(preview.items).toEqual([
      { nodeId: 'text-first', code: `CVT-${ulids.firstText}`, type: '文字', title: 'First' },
      { nodeId: 'image', code: `CVM-${ulids.image}`, type: '图片', title: 'Image' },
      { nodeId: 'text-second', code: `CVT-${ulids.secondText}`, type: '文字', title: 'Second' }
    ])
    expect(preview.selectedCount).toBe(4)
    expect(preview.omittedCount).toBe(1)
  })

  it('includes stable CVD/CVS creative objects as explicit Agent context', () => {
    const preview = createContextPackSelectionPreview([
      documentNode(`CVD-${ulids.document}`),
      storyboardNode(`CVS-${ulids.storyboard}`)
    ], ['storyboard', 'document'])

    expect(preview).toEqual({
      items: [
        { nodeId: 'document', code: `CVD-${ulids.document}`, type: '文档', title: 'Script document' },
        { nodeId: 'storyboard', code: `CVS-${ulids.storyboard}`, type: '分镜', title: 'Shot board' }
      ],
      selectedCount: 2,
      omittedCount: 0
    })
  })

  it('omits unsupported, transient, running, failed, missing-code and malformed-code selections', () => {
    const nodes: IFreeCanvasNode[] = [
      textNode('missing', 'Missing'),
      textNode('malformed', 'Malformed', 'CVT-not-a-code'),
      imageNode('transient', 'Transient', `CVM-${ulids.image}`, { generationState: 'succeeded' }),
      imageNode('running', 'Running', `CVM-${ulids.image}`, { generationState: 'running' }),
      imageNode('failed', 'Failed', `CVM-${ulids.image}`, { generationState: 'failed' }),
      { id: 'generator', kind: 'image-generator', title: 'Generator', position: { x: 0, y: 0 }, width: 420, height: 560, mode: 'generate', binding: { connectionId: '', modelId: '' }, settings: {} as never, promptDocument: { version: 1, segments: [] }, regions: [], meta: {} }
    ]
    ;(nodes[2] as Extract<IFreeCanvasNode, { kind: 'image' }>).transient = true

    const preview = createContextPackSelectionPreview(nodes, nodes.map(node => node.id))

    expect(preview.items).toEqual([])
    expect(preview.selectedCount).toBe(6)
    expect(preview.omittedCount).toBe(6)
  })

  it('omits planning and unknown nodes even when they carry stale image reference codes', () => {
    const staleCode = `CVM-${ulids.image}`
    const nodes: IFreeCanvasNode[] = [
      {
        id: 'document', kind: 'document', title: 'Plan', position: { x: 0, y: 0 }, width: 560, height: 420,
        referenceCode: staleCode,
        document: { version: 1, blocks: [], revision: 1, digest: 'digest', suggestions: [] },
        linkedDocumentResourceIds: [], meta: {}
      },
      {
        id: 'storyboard', kind: 'storyboard', title: 'Shots', position: { x: 0, y: 0 }, width: 640, height: 480,
        referenceCode: staleCode,
        sequence: { id: 'sequence', name: 'Shots', description: '', style: '', constraints: '', rows: [], createdAt: 1, updatedAt: 1, meta: {} },
        source: {
          documentNodeId: 'document', documentRevision: 1, documentDigest: 'digest', documentResourceDigests: [],
          model: { connectionId: 'c', providerId: 'p', modelId: 'm', displayName: 'Model', capabilities: {} }, skills: []
        },
        pendingFieldChanges: [], meta: {}
      },
      {
        id: 'unknown', kind: 'unsupported', originalKind: 'future-layout', title: 'Future',
        position: { x: 0, y: 0 }, width: 360, height: 220, referenceCode: staleCode,
        originalNode: { id: 'unknown', kind: 'future-layout' }, meta: {}
      }
    ]

    expect(createContextPackSelectionPreview(nodes, nodes.map(node => node.id))).toEqual({
      items: [], selectedCount: 3, omittedCount: 3
    })
  })

  it('builds the exact Task 10 payload with placement anchors matching the ordered explicit selection', () => {
    const preview = createContextPackSelectionPreview([
      imageNode('image', 'Image', `CVM-${ulids.image}`),
      textNode('text', 'Text', `CVT-${ulids.firstText}`)
    ], ['text', 'image'])

    expect(buildContextPackCreateRequest(project(), preview)).toEqual({
      projectCode: `PRJ-${ulids.project}`,
      projectRevision: 7,
      nodeCodes: [`CVM-${ulids.image}`, `CVT-${ulids.firstText}`],
      placementHint: {
        mode: 'after-selection',
        anchorNodeCodes: [`CVM-${ulids.image}`, `CVT-${ulids.firstText}`]
      },
      creator: 'promptcard-ui'
    })
  })

  it.each([
    [project(), createContextPackSelectionPreview([], []), 'empty selection'],
    [project({ referenceCode: undefined }), createContextPackSelectionPreview([textNode('text', 'Text', `CVT-${ulids.firstText}`)], ['text']), 'missing PRJ'],
    [project({ revision: 0 }), createContextPackSelectionPreview([textNode('text', 'Text', `CVT-${ulids.firstText}`)], ['text']), 'invalid revision']
  ])('refuses to build a request for %s', (candidate, preview) => {
    expect(buildContextPackCreateRequest(candidate, preview)).toBeNull()
  })

  it('normalizes case and whitespace for a manually inspected CVC without accepting another namespace', () => {
    expect(normalizeContextPackCode(`  cvc-${ulids.context.toLowerCase()}  `)).toBe(`CVC-${ulids.context}`)
    expect(normalizeContextPackCode(`PRJ-${ulids.project}`)).toBeNull()
    expect(normalizeContextPackCode('CVC-invalid')).toBeNull()
  })
})
