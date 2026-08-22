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
  context: '01ARZ3NDEKTSV4RRFFQ69G5FAZ'
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
