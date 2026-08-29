import { describe, expect, it } from 'vitest'
import type { IFreeCanvasImageNode, IFreeCanvasNode, IFreeCanvasTextNode } from '@/models/PromptHistory.model'
import type { ImageGenerationRun } from '@/storage/storage-service-client'
import {
  buildConversationGenerationRequest,
  compileConversationPromptDocument,
  createEmptyConversationDraft,
  injectCanvasNodesIntoDraft,
  projectRunToTurn,
  removeConversationTextReference,
  rebuildPreparedImageGenerationRequest
} from './project-conversation'

const textNode = (id: string, text: string): IFreeCanvasTextNode => ({
  id,
  kind: 'text',
  title: id,
  position: { x: 0, y: 0 },
  width: 240,
  height: 120,
  fontSize: 'medium',
  segments: [{ id: `${id}-segment`, source: 'user', text, color: '#111827', createdAt: 1, updatedAt: 1 }],
  meta: {}
})

const imageNode = (id: string, assetId?: string): IFreeCanvasImageNode => ({
  id,
  kind: 'image',
  title: id,
  position: { x: 0, y: 0 },
  width: 240,
  height: 240,
  assetId,
  annotations: [],
  meta: {}
})

describe('project image generation conversations', () => {
  it('builds an independent conversation request without a canvas node or prior turns', () => {
    const draft = {
      ...createEmptyConversationDraft(),
      promptDocument: {
        version: 1 as const,
        segments: [{ type: 'text' as const, text: 'Create a quiet observatory' }]
      },
      connectionId: 'ark-primary',
      modelId: 'seedream',
      inputs: [{
        referenceId: 'reference-1',
        role: 'reference-image' as const,
        assetId: 'asset-derived',
        sourceAssetId: 'asset-original',
        order: 0
      }]
    }

    expect(buildConversationGenerationRequest('project-1', 'conversation-1', draft)).toEqual({
      projectId: 'project-1',
      conversationId: 'conversation-1',
      connectionId: 'ark-primary',
      modelId: 'seedream',
      mode: 'generate',
      promptDocument: { version: 1, segments: [{ type: 'text', text: 'Create a quiet observatory' }] },
      inputs: [{
        referenceId: 'reference-1',
        role: 'reference-image',
        assetId: 'asset-derived',
        sourceAssetId: 'asset-original',
        order: 0
      }],
      regions: [],
      resolution: '2K',
      aspectRatio: '1:1',
      outputFormat: 'png',
      watermark: false,
      promptOptimization: 'standard'
    })
  })

  it('injects only explicit usable canvas nodes and reports rejected selections', () => {
    const result = injectCanvasNodesIntoDraft(createEmptyConversationDraft(), [
      textNode('text-1', 'First prompt'),
      imageNode('image-1', 'asset-local'),
      imageNode('image-missing')
    ])

    expect(result.draft.promptDocument).toEqual({ version: 1, segments: [{ type: 'text', text: '' }] })
    expect(result.draft.textReferences).toEqual([{
      nodeId: 'text-1',
      label: 'text-1',
      text: 'First prompt',
      order: 0
    }])
    expect(result.draft.inputs).toMatchObject([{
      assetId: 'asset-local',
      order: 0,
      role: 'reference-image'
    }])
    expect(result.rejected).toEqual([{ nodeId: 'image-missing', reason: '图片节点没有可用的本地资产。' }])
  })

  it('rejects planning and unknown nodes without adding Prompt text or image inputs', () => {
    const nodes: IFreeCanvasNode[] = [
      {
        id: 'document', kind: 'document', title: 'Plan', position: { x: 0, y: 0 }, width: 560, height: 420,
        document: {
          version: 1,
          blocks: [{ id: 'paragraph', type: 'paragraph', content: [{ text: 'PRIVATE DOCUMENT BODY' }] }],
          revision: 1, digest: 'digest', suggestions: []
        },
        linkedDocumentResourceIds: [], meta: {}
      },
      {
        id: 'storyboard', kind: 'storyboard', title: 'Shots', position: { x: 0, y: 0 }, width: 640, height: 480,
        sequence: { id: 'sequence', name: 'Shots', description: 'PRIVATE SHOTS', style: '', constraints: '', rows: [], createdAt: 1, updatedAt: 1, meta: {} },
        source: {
          documentNodeId: 'document', documentRevision: 1, documentDigest: 'digest', documentResourceDigests: [],
          model: { connectionId: 'c', providerId: 'p', modelId: 'm', displayName: 'Model', capabilities: {} }, skills: []
        },
        pendingFieldChanges: [], meta: {}
      },
      {
        id: 'unknown', kind: 'unsupported', originalKind: 'future-layout', title: 'Future',
        position: { x: 0, y: 0 }, width: 360, height: 220,
        originalNode: { id: 'unknown', kind: 'future-layout', secret: 'PRIVATE UNKNOWN' }, meta: {}
      }
    ]

    const result = injectCanvasNodesIntoDraft(createEmptyConversationDraft(), nodes)

    expect(result.draft.textReferences).toEqual([])
    expect(result.draft.inputs).toEqual([])
    expect(result.rejected).toEqual(nodes.map(node => ({
      nodeId: node.id,
      reason: '该节点类型不能作为图片生成输入。'
    })))
    expect(JSON.stringify(result.draft)).not.toContain('PRIVATE')
  })

  it('refreshes a repeated text reference without changing its order or visible prompt', () => {
    const first = injectCanvasNodesIntoDraft(createEmptyConversationDraft(), [
      { ...textNode('text-1', 'First snapshot'), title: 'First title' }
    ])
    const second = injectCanvasNodesIntoDraft(first.draft, [
      { ...textNode('text-1', 'Updated snapshot'), title: 'Updated title' }
    ])

    expect(second.draft.promptDocument).toEqual({ version: 1, segments: [{ type: 'text', text: '' }] })
    expect(second.draft.textReferences).toEqual([{
      nodeId: 'text-1',
      label: 'Updated title',
      text: 'Updated snapshot',
      order: 0
    }])
  })

  it('compiles manual prompt before ordered text reference snapshots', () => {
    const draft = {
      ...createEmptyConversationDraft(),
      promptDocument: { version: 1 as const, segments: [{ type: 'text' as const, text: 'User instruction' }] },
      textReferences: [
        { nodeId: 'text-2', label: 'Second', text: 'Second reference', order: 1 },
        { nodeId: 'text-1', label: 'First', text: 'First reference', order: 0 }
      ]
    }

    expect(compileConversationPromptDocument(draft)).toEqual({
      version: 1,
      segments: [{ type: 'text', text: 'User instruction\nFirst reference\nSecond reference' }]
    })
    expect(buildConversationGenerationRequest('project-1', 'conversation-1', draft).promptDocument)
      .toEqual(compileConversationPromptDocument(draft))
  })

  it('removes a text reference without changing the visible prompt', () => {
    const promptDocument = { version: 1 as const, segments: [{ type: 'text' as const, text: 'Keep me' }] }
    const draft = {
      ...createEmptyConversationDraft(),
      promptDocument,
      textReferences: [{ nodeId: 'text-1', label: 'Text 1', text: 'Reference', order: 0 }]
    }

    const next = removeConversationTextReference(draft, 'text-1')

    expect(next.promptDocument).toEqual(promptDocument)
    expect(next.textReferences).toEqual([])
  })

  it('preserves provider-neutral operation and creative lineage in the request snapshot', () => {
    const draft = {
      ...createEmptyConversationDraft(),
      connectionId: 'connection-1',
      modelId: 'image-model-1',
      operation: {
        operation: 'effect-render' as const,
        recipeId: 'effect-render/product-sketch',
        recipeVersion: '1',
        source: {
          nodeId: 'node-source',
          originalAssetId: 'asset-original',
          canvasAssetId: 'asset-canvas',
          providerAssetId: 'asset-provider'
        },
        preservationIntents: ['保留产品轮廓', '保留材质颜色'],
        parameters: { preset: 'product-sketch', referenceOrder: ['source'] }
      }
    }

    expect(buildConversationGenerationRequest('project-1', 'conversation-1', draft).operation)
      .toEqual(draft.operation)
  })

  it('projects the immutable run snapshot into a display turn', () => {
    const run = {
      id: 'run-1', projectId: 'project-1', conversationId: 'conversation-1',
      connectionId: 'ark-primary', providerId: 'volcengine-ark', modelId: 'seedream', state: 'succeeded',
      requestSnapshot: {
        mode: 'edit',
        promptOptimization: 'standard',
        promptDocument: { version: 1, segments: [{ type: 'text', text: 'Make it warmer' }] },
        inputAssets: [], regions: [], resolution: '2K', aspectRatio: '16:9', outputFormat: 'png', watermark: false
      },
      outputAssetIds: ['asset-output'], createdAt: 10, finishedAt: 20
    } satisfies ImageGenerationRun

    expect(projectRunToTurn(run, modelId => modelId === 'seedream' ? 'Seedream 5.0 Pro' : modelId)).toMatchObject({
      id: 'run-1',
      prompt: 'Make it warmer',
      state: 'succeeded',
      settings: { workflow: 'smart-edit', modelLabel: 'Seedream 5.0 Pro', resolution: '2K', aspectRatio: '16:9' },
      result: { assetId: 'asset-output', imageUrl: '/storage-api/assets/asset-output' }
    })
  })

  it('rebuilds an authorized queued multi-view request from its immutable snapshot', () => {
    const run = {
      id: 'image-run-0123456789abcdef0123456789abcdef',
      projectId: 'project-1',
      nodeId: 'node-source',
      connectionId: 'ark-primary',
      providerId: 'volcengine-ark',
      modelId: 'seedream',
      state: 'queued',
      requestSnapshot: {
        mode: 'edit',
        promptOptimization: 'standard',
        promptDocument: { version: 1, segments: [{ type: 'text', text: 'front view' }] },
        inputAssets: [{
          referenceId: 'source', role: 'source-image', assetId: 'asset-provider',
          sourceAssetId: 'asset-original', order: 0
        }],
        regions: [],
        resolution: '2K',
        aspectRatio: '1:1',
        outputFormat: 'png',
        watermark: false,
        operation: {
          operation: 'multi-view',
          recipeId: 'multi-view/product-turntable',
          recipeVersion: '1',
          source: {
            nodeId: 'node-source', originalAssetId: 'asset-original',
            canvasAssetId: 'asset-canvas', providerAssetId: 'asset-provider'
          },
          preservationIntents: ['keep identity'],
          parameters: { view: 'front' },
          operationGroupId: 'group-1',
          operationItemId: 'item-1',
          viewSpec: 'front'
        }
      },
      outputAssetIds: [],
      createdAt: 10
    } satisfies ImageGenerationRun

    expect(rebuildPreparedImageGenerationRequest(run)).toEqual({
      runId: run.id,
      projectId: 'project-1',
      nodeId: 'node-source',
      connectionId: 'ark-primary',
      modelId: 'seedream',
      mode: 'edit',
      promptDocument: { version: 1, segments: [{ type: 'text', text: 'front view' }] },
      inputs: run.requestSnapshot.inputAssets,
      regions: [],
      resolution: '2K',
      aspectRatio: '1:1',
      outputFormat: 'png',
      watermark: false,
      promptOptimization: 'standard',
      operation: run.requestSnapshot.operation
    })
    expect(rebuildPreparedImageGenerationRequest({ ...run, state: 'running' })).toBeNull()
  })
})
