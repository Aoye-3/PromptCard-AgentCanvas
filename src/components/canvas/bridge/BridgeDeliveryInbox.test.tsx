import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { BridgeDeliveryInbox } from './BridgeDeliveryInbox'
import type { BridgePromptDelivery } from '@/storage/storage-service-client'


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
    expect(renderer.root.findByProps({ role: 'alert' }).children).toContain('Prompt 尚未可靠保存，提案仍保留在待审阅队列。')
    renderer.unmount()
  })
})
