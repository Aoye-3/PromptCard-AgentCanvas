import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSdkGatewayStream } from './sdk-gateway-stream.ts'

describe('SDK Gateway stream document carrier', () => {
  beforeEach(() => {
    process.env.PROMPTCARD_GATEWAY_INTERNAL_URL = 'http://127.0.0.1:14003/api/promptcard/runtime'
    process.env.PROMPTCARD_INTERNAL_TOKEN = 'internal-test-token'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.PROMPTCARD_GATEWAY_INTERNAL_URL
    delete process.env.PROMPTCARD_INTERNAL_TOKEN
  })

  it('posts the opaque handle without document identities, bytes, or provider ids', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'stop',
        usage: { input: 1, output: 1 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const model = {
      id: 'doubao-seed-2-0-lite-260215',
      name: 'Doubao',
      api: 'promptcard-sdk-chat',
      provider: 'sdk:volcengine-ark',
      baseUrl: 'http://gateway.test',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
      promptcardConnectionId: 'connection-1',
      promptcardDocumentInvocationHandle: 'opaque-request-handle'
    }

    createSdkGatewayStream(model as never, {
      systemPrompt: 'system',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 }],
      tools: []
    } as never, undefined)
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    const body = JSON.parse(String(requests[0].init.body))
    expect(body.documentInvocationHandle).toBe('opaque-request-handle')
    expect(body).not.toHaveProperty('documentResourceIds')
    expect(body).not.toHaveProperty('remoteFileId')
    expect(body).not.toHaveProperty('contentBase64')
    expect(requests[0].init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-PromptCard-Internal-Token': 'internal-test-token'
    })
  })
})
