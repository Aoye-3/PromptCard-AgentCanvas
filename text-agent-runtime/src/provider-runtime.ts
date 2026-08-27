import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
  type StreamFunction
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { sdkGatewayApi } from './sdk-gateway-stream.ts'

const SDK_CHAT_API = 'promptcard-sdk-chat'

export interface TextModelDescriptor {
  connectionId: string
  providerId: string
  model: {
    id: string
    displayName: string
    modality: string
    capabilities?: {
      input?: Array<'text' | 'image' | 'pdf'>
    }
    integrationGroup: {
      id: string
      displayName: string
      kind: 'pi-native' | 'sdk'
    }
  }
}

export interface TextProviderRuntime {
  models: Models
  model: Model<Api>
  stream: StreamFunction
  integrationGroup: TextModelDescriptor['model']['integrationGroup']
}

export async function createTextProviderRuntime(
  descriptorValue: unknown,
  documentInvocationHandle?: string
): Promise<TextProviderRuntime> {
  const gatewayUrl = requiredUrl('PROMPTCARD_GATEWAY_INTERNAL_URL')
  const internalToken = requiredEnv('PROMPTCARD_INTERNAL_TOKEN')
  const descriptor = validateDescriptor(descriptorValue)
  const group = descriptor.model.integrationGroup
  const runtimeProviderId = `${group.kind}:${descriptor.providerId}`
  const api = group.kind === 'pi-native' ? 'openai-completions' : SDK_CHAT_API
  const model: Model<Api> = {
    id: descriptor.model.id,
    name: descriptor.model.displayName,
    api,
    provider: runtimeProviderId,
    baseUrl: group.kind === 'pi-native'
      ? `${gatewayUrl}/internal/pi-proxy/${encodeURIComponent(descriptor.connectionId)}`
      : gatewayUrl,
    reasoning: false,
    input: (descriptor.model.capabilities?.input || ['text'])
      .filter((input): input is 'text' | 'image' => input !== 'pdf'),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192
  }
  const promptcardModel = model as Model<Api> & {
    promptcardConnectionId?: string
    promptcardDocumentInvocationHandle?: string
  }
  promptcardModel.promptcardConnectionId = descriptor.connectionId
  if (group.kind === 'sdk' && documentInvocationHandle) {
    promptcardModel.promptcardDocumentInvocationHandle = documentInvocationHandle
  }
  const provider = createProvider({
    id: runtimeProviderId,
    name: group.displayName,
    auth: {
      apiKey: {
        name: 'PromptCard internal gateway',
        resolve: async () => ({
          auth: {
            apiKey: 'promptcard-internal',
            headers: { 'X-PromptCard-Internal-Token': internalToken }
          },
          source: 'PromptCard credential boundary'
        })
      }
    },
    models: [model],
    api: group.kind === 'pi-native' ? openAICompletionsApi() : sdkGatewayApi()
  })
  const models = createModels()
  models.setProvider(provider)
  const resolvedModel = models.getModel(runtimeProviderId, model.id)
  if (!resolvedModel) throw new Error('Text model registration failed')
  return {
    models,
    model: resolvedModel,
    stream: (target, context, options) => models.streamSimple(target, context, options),
    integrationGroup: group
  }
}

function validateDescriptor(value: unknown): TextModelDescriptor {
  if (!value || typeof value !== 'object') throw new Error('Text model descriptor is invalid')
  const descriptor = value as TextModelDescriptor
  const group = descriptor.model?.integrationGroup
  if (
    !descriptor.connectionId
    || !descriptor.providerId
    || !descriptor.model?.id
    || !descriptor.model?.displayName
    || descriptor.model.modality !== 'chat'
    || !group
    || !['pi-native', 'sdk'].includes(group.kind)
  ) {
    throw new Error('Text model descriptor is invalid')
  }
  return descriptor
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function requiredUrl(name: string) {
  return requiredEnv(name).replace(/\/$/, '')
}
