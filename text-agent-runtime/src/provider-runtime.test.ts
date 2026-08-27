import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTextProviderRuntime } from './provider-runtime.ts'

describe('PI text provider runtime', () => {
  beforeEach(() => {
    process.env.PROMPTCARD_GATEWAY_INTERNAL_URL = 'http://127.0.0.1:14003/api/promptcard/runtime'
    process.env.PROMPTCARD_INTERNAL_TOKEN = 'internal-test-token'
  })

  afterEach(() => {
    delete process.env.PROMPTCARD_GATEWAY_INTERNAL_URL
    delete process.env.PROMPTCARD_INTERNAL_TOKEN
  })

  it('registers PI-native chat models through the PI provider collection', async () => {
    const runtime = await createTextProviderRuntime(
      descriptor('pi-native', 'deepseek', 'deepseek-chat')
    )

    expect(runtime.model.provider).toBe('pi-native:deepseek')
    expect(runtime.model.api).toBe('openai-completions')
    expect(runtime.model.baseUrl).toContain('/internal/pi-proxy/connection-1')
    expect(runtime.models.getProviders().map(provider => provider.id)).toEqual(['pi-native:deepseek'])
  })

  it('registers SDK chat models separately from PI-native providers', async () => {
    const runtime = await createTextProviderRuntime(
      descriptor('sdk', 'volcengine-ark', 'doubao-seed-2-0-lite-260215')
    )

    expect(runtime.model.provider).toBe('sdk:volcengine-ark')
    expect(runtime.model.api).toBe('promptcard-sdk-chat')
    expect(runtime.integrationGroup.id).toBe('volcengine-ark-sdk')
  })

  it('uses the descriptor resolved by Gateway without model discovery', async () => {
    const runtime = await createTextProviderRuntime(
      descriptor('sdk', 'volcengine-ark', 'doubao-seed-2-0-lite-260215')
    )

    expect(runtime.model.id).toBe('doubao-seed-2-0-lite-260215')
    expect((runtime.model as typeof runtime.model & { promptcardConnectionId?: string }).promptcardConnectionId)
      .toBe('connection-1')
  })

  it('carries only the Gateway-issued document invocation handle on SDK models', async () => {
    const runtime = await createTextProviderRuntime(
      descriptor('sdk', 'volcengine-ark', 'doubao-seed-2-0-lite-260215'),
      'opaque-request-handle'
    )

    expect((runtime.model as typeof runtime.model & {
      promptcardDocumentInvocationHandle?: string
    }).promptcardDocumentInvocationHandle).toBe('opaque-request-handle')
  })

  it('rejects image model descriptors at the text boundary', async () => {
    const value = descriptor('sdk', 'volcengine-ark', 'seedream')
    value.model.modality = 'image'
    await expect(createTextProviderRuntime(value))
      .rejects.toThrow('Text model descriptor is invalid')
  })
})

function descriptor(
  kind: 'pi-native' | 'sdk',
  providerId: string,
  modelId: string
) {
  return {
    connectionId: 'connection-1',
    providerId,
    model: {
      id: modelId,
      displayName: modelId,
      modality: 'chat',
      capabilities: { input: ['text'] as Array<'text' | 'image' | 'pdf'> },
      integrationGroup: {
        id: kind === 'pi-native' ? 'pi-native' : 'volcengine-ark-sdk',
        displayName: kind === 'pi-native' ? 'PI 原生' : '方舟 SDK',
        kind
      }
    }
  }
}
