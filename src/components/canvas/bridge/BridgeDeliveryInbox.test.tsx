import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { BridgeDeliveryInbox } from './BridgeDeliveryInbox'
import type {
  BridgeDocumentChangeDelivery,
  BridgeDocumentCreateDelivery,
  BridgeImageDelivery,
  BridgePromptDelivery
} from '@/storage/storage-service-client'


const delivery = (): BridgePromptDelivery => ({
  operationContext: {
    profileId: 'codex-local', scopes: ['bridge:deliver:prompt'],
    provenance: 'promptcard-bridge', clientInfo: { name: 'codex', version: '1.0.0' }
  },
  request: {
    clientRequestId: 'preview-1', normalizedRequestDigest: `sha256:${'a'.repeat(64)}`,
    kind: 'prompt.create', target: { cvcCode: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ' },
    sourceCodes: [], skillPins: [], rationale: 'Create a prompt.', provenance: 'promptcard-bridge',
    payload: { title: 'Opening', userText: 'Wide shot' }
  },
  proposalId: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAV', state: 'pending_review',
  disposition: 'original', resultCodes: [], message: 'waiting',
  createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
  visualProposal: {
    kind: 'free_canvas_text_create', id: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAV',
    agentName: 'codex', title: 'Opening', userText: 'Wide shot',
    segments: [{ source: 'user', text: 'Wide shot' }], rationale: 'Create a prompt.',
    status: 'pending', createdAt: 0,
    bridgeDelivery: {
      profileId: 'codex-local', cvcCode: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      clientRequestId: 'preview-1', normalizedRequestDigest: `sha256:${'a'.repeat(64)}`,
      sourceCodes: [], skillPins: []
    }
  }
})

const imageDelivery = (): BridgeImageDelivery => ({
  operationContext: {
    profileId: 'codex-local', scopes: ['bridge:deliver:image'],
    provenance: 'promptcard-bridge', clientInfo: { name: 'codex', version: '1.0.0' }
  },
  request: {
    clientRequestId: 'image-preview-1', normalizedRequestDigest: `sha256:${'c'.repeat(64)}`,
    kind: 'image.place', target: { cvcCode: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ' },
    sourceCodes: [], skillPins: [], rationale: 'Place the frame.', provenance: 'promptcard-bridge',
    payload: { stagedAssetHandle: 'AST-01ARZ3NDEKTSV4RRFFQ69G5FAV', altText: 'Opening frame' }
  },
  proposalId: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAX', state: 'pending_review',
  disposition: 'original', resultCodes: [], message: 'waiting',
  createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
  visualProposal: {
    kind: 'free_canvas_image_place', id: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAX',
    agentName: 'codex', title: 'opening.png', altText: 'Opening frame',
    assetId: 'bridge-image.png', contentType: 'image/png', width: 640, height: 360,
    rationale: 'Place the frame.', status: 'pending', createdAt: 0,
    bridgeDelivery: {
      profileId: 'codex-local', cvcCode: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      clientRequestId: 'image-preview-1', normalizedRequestDigest: `sha256:${'c'.repeat(64)}`,
      sourceCodes: [], skillPins: [], target: { cvcCode: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ' },
      stagedAssetHandle: 'AST-01ARZ3NDEKTSV4RRFFQ69G5FAV'
    }
  }
})

const documentCreateDelivery = (): BridgeDocumentCreateDelivery => ({
  operationContext: {
    profileId: 'codex-local', scopes: ['bridge:deliver:document'], provenance: 'promptcard-bridge',
    clientInfo: { name: 'codex', version: '1.0.0' }
  },
  request: {
    clientRequestId: 'document-create-1', normalizedRequestDigest: `sha256:${'d'.repeat(64)}`,
    kind: 'document.create', target: { cvcCode: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ' },
    sourceCodes: ['CVD-01ARZ3NDEKTSV4RRFFQ69G5FAW'],
    skillPins: [{ skillCode: 'SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV', revision: 3, digest: `sha256:${'e'.repeat(64)}` }],
    rationale: 'Create the script analysis.', provenance: 'promptcard-bridge',
    payload: { title: 'Script analysis', blocks: [{ id: 'opening', type: 'paragraph', content: [{ text: 'Rain.' }] }] }
  },
  proposalId: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAT', state: 'pending_review', disposition: 'original',
  resultCodes: [], message: 'waiting', createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z',
  visualProposal: {
    kind: 'document_create', id: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAT', agentName: 'codex',
    title: 'Script analysis', blocks: [{ id: 'opening', type: 'paragraph', content: [{ text: 'Rain.' }] }],
    rationale: 'Create the script analysis.', status: 'pending', createdAt: 0,
    bridgeDelivery: {
      profileId: 'codex-local', cvcCode: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAZ', clientRequestId: 'document-create-1',
      normalizedRequestDigest: `sha256:${'d'.repeat(64)}`, sourceCodes: ['CVD-01ARZ3NDEKTSV4RRFFQ69G5FAW'],
      skillPins: [{ skillCode: 'SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV', revision: 3, digest: `sha256:${'e'.repeat(64)}` }]
    }
  }
})

const documentChangeDelivery = (): BridgeDocumentChangeDelivery => {
  const created = documentCreateDelivery()
  const operation = {
    kind: 'replace' as const, blockId: 'opening', utf8Start: 0, utf8End: 4, text: 'Storm',
    expectedTextDigest: `sha256:${'f'.repeat(64)}`
  }
  return {
    ...created,
    request: {
      ...created.request,
      clientRequestId: 'document-change-1', kind: 'document.change',
      target: {
        cvcCode: created.request.target.cvcCode, documentCode: 'CVD-01ARZ3NDEKTSV4RRFFQ69G5FAW',
        baseRevision: 2, baseDigest: `sha256:${'a'.repeat(64)}`
      },
      payload: { operations: [operation] }
    },
    proposalId: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAS',
    visualProposal: {
      ...created.visualProposal,
      kind: 'document_changes', id: 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAS',
      documentCode: 'CVD-01ARZ3NDEKTSV4RRFFQ69G5FAW', baseRevision: 2,
      baseDigest: `sha256:${'a'.repeat(64)}`, operations: [operation]
    }
  }
}

describe('BridgeDeliveryInbox', () => {
  it('shows an external Prompt proposal and records acceptance after durable apply', async () => {
    const item = delivery()
    const client = {
      list: vi.fn().mockResolvedValue([item]),
      decide: vi.fn().mockResolvedValue({ ...item, state: 'accepted' })
    }
    const onAccept = vi.fn().mockResolvedValue(['CVT-01ARZ3NDEKTSV4RRFFQ69G5FAW'])
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<BridgeDeliveryInbox
        cvcCode={item.request.target.cvcCode}
        client={client}
        onAccept={onAccept}
      />)
    })

    expect(renderer.root.findByProps({ 'data-bridge-delivery-title': true }).children).toContain('Opening')
    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '接受外部 Agent Prompt 提案' }).props.onClick()
    })

    expect(onAccept).toHaveBeenCalledWith(item)
    expect(client.decide).toHaveBeenCalledWith(
      item.request.target.cvcCode,
      item.proposalId,
      'accepted',
      ['CVT-01ARZ3NDEKTSV4RRFFQ69G5FAW']
    )
    expect(renderer.root.findAllByProps({ 'data-bridge-delivery-title': true })).toHaveLength(0)
    renderer.unmount()
  })

  it('rejects without applying or returning result codes', async () => {
    const item = delivery()
    const client = {
      list: vi.fn().mockResolvedValue([item]),
      decide: vi.fn().mockResolvedValue({ ...item, state: 'rejected' })
    }
    const onAccept = vi.fn()
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<BridgeDeliveryInbox
        cvcCode={item.request.target.cvcCode}
        client={client}
        onAccept={onAccept}
      />)
    })
    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '拒绝外部 Agent Prompt 提案' }).props.onClick()
    })
    expect(onAccept).not.toHaveBeenCalled()
    expect(client.decide).toHaveBeenCalledWith(
      item.request.target.cvcCode, item.proposalId, 'rejected', []
    )
    renderer.unmount()
  })

  it('keeps the proposal pending when the Canvas save does not return a Prompt code', async () => {
    const item = delivery()
    const client = {
      list: vi.fn().mockResolvedValue([item]),
      decide: vi.fn()
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<BridgeDeliveryInbox
        cvcCode={item.request.target.cvcCode}
        client={client}
        onAccept={vi.fn().mockResolvedValue([])}
      />)
    })
    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '接受外部 Agent Prompt 提案' }).props.onClick()
    })
    expect(client.decide).not.toHaveBeenCalled()
    expect(renderer.root.findAllByProps({ 'data-bridge-delivery-title': true })).toHaveLength(1)
    expect(renderer.root.findByProps({ role: 'alert' }).children).toContain('提案尚未可靠保存，仍保留在待审阅队列。')
    renderer.unmount()
  })

  it('previews a staged image and records its saved Canvas media code', async () => {
    const item = imageDelivery()
    const client = {
      list: vi.fn().mockResolvedValue([item]),
      decide: vi.fn().mockResolvedValue({ ...item, state: 'accepted' })
    }
    const onAccept = vi.fn().mockResolvedValue(['CVM-01ARZ3NDEKTSV4RRFFQ69G5FAW'])
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<BridgeDeliveryInbox
        cvcCode={item.request.target.cvcCode}
        client={client}
        onAccept={onAccept}
      />)
    })

    expect(renderer.root.findByType('img').props).toMatchObject({
      src: '/storage-api/assets/bridge-image.png',
      alt: 'Opening frame'
    })
    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '接受外部 Agent 图片 提案' }).props.onClick()
    })
    expect(client.decide).toHaveBeenCalledWith(
      item.request.target.cvcCode,
      item.proposalId,
      'accepted',
      ['CVM-01ARZ3NDEKTSV4RRFFQ69G5FAW']
    )
    renderer.unmount()
  })

  it.each([
    ['创建', documentCreateDelivery(), 'Script analysis'],
    ['修改', documentChangeDelivery(), '修改文档 CVD-01ARZ3NDEKTSV4RRFFQ69G5FAW']
  ])('shows Document %s proposals with exact provenance and records the CVD', async (_label, item, title) => {
    const client = {
      list: vi.fn().mockResolvedValue([item]),
      decide: vi.fn().mockResolvedValue({ ...item, state: 'accepted' })
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<BridgeDeliveryInbox
        cvcCode={item.request.target.cvcCode}
        client={client}
        onAccept={vi.fn().mockResolvedValue(['CVD-01ARZ3NDEKTSV4RRFFQ69G5FAY'])}
      />)
    })

    expect(renderer.root.findByProps({ 'data-bridge-delivery-title': true }).children).toContain(title)
    expect(renderer.root.findByProps({ 'data-bridge-delivery-provenance': true }).children.join('')).toContain('SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV@3')
    expect(renderer.root.findByProps({ 'data-bridge-delivery-provenance': true }).children.join('')).toContain('CVD-01ARZ3NDEKTSV4RRFFQ69G5FAW')
    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '接受外部 Agent 文档 提案' }).props.onClick()
    })
    expect(client.decide).toHaveBeenCalledWith(
      item.request.target.cvcCode, item.proposalId, 'accepted', ['CVD-01ARZ3NDEKTSV4RRFFQ69G5FAY']
    )
    renderer.unmount()
  })
})
