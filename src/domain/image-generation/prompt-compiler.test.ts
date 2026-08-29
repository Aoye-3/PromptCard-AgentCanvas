import { describe, expect, it } from 'vitest'
import type {
  IFreeCanvasImageGeneratorNode,
  IFreeCanvasImageNode,
  IFreeCanvasNode,
  IFreeCanvasProject,
  IFreeCanvasTextNode,
  PromptDocument
} from '@/models/PromptHistory.model'
import { quickMessagePresetToCanvasSource } from '@/domain/prompt-library/quick-messages'
import { compileImageGeneratorPrompt } from './prompt-compiler'

const generatorNode = (promptDocument: PromptDocument = { version: 1, segments: [] }): IFreeCanvasImageGeneratorNode => ({
  id: 'generator-1',
  kind: 'image-generator',
  title: 'Generator',
  position: { x: 0, y: 0 },
  width: 420,
  height: 560,
  mode: 'generate',
  binding: { connectionId: 'connection-1', modelId: 'image-model-1' },
  settings: {
    resolution: '1K',
    aspectRatio: 'smart',
    outputFormat: 'png',
    watermark: false
  },
  promptDocument,
  regions: [],
  meta: {}
})

const textNode = (id: string, text: string, source: 'preset' | 'user' = 'user'): IFreeCanvasTextNode => ({
  id,
  kind: 'text',
  title: 'Prompt',
  position: { x: 0, y: 0 },
  width: 420,
  height: 180,
  fontSize: 'large',
  segments: [{
    id: `${id}-segment`,
    source,
    text,
    color: source === 'preset' ? '#ef4423' : '#111827',
    createdAt: 1,
    updatedAt: 1
  }],
  meta: {}
})

const imageNode = (id: string, title: string, assetId: string): IFreeCanvasImageNode => ({
  id,
  kind: 'image',
  title,
  position: { x: 0, y: 0 },
  width: 300,
  height: 220,
  assetId,
  annotations: [],
  meta: {}
})

const projectWith = (
  nodes: IFreeCanvasProject['nodes'],
  edges: IFreeCanvasProject['edges'] = []
): IFreeCanvasProject => ({
  nodes,
  edges,
  viewport: null,
  selectedNodeId: 'generator-1',
  meta: {}
})

describe('compileImageGeneratorPrompt', () => {
  it('uses local explicit content before a connected prompt and otherwise snapshots upstream text', () => {
    const upstream = textNode('prompt-1', 'Connected prompt')
    const connectedProject = projectWith([generatorNode(), upstream], [{
      id: 'prompt-edge',
      source: upstream.id,
      target: 'generator-1',
      targetHandle: 'prompt',
      createdAt: 1
    }])

    const connected = compileImageGeneratorPrompt(connectedProject, 'generator-1')
    const local = compileImageGeneratorPrompt(projectWith([
      generatorNode({ version: 1, segments: [{ type: 'text', text: 'Local override' }] }),
      upstream
    ], connectedProject.edges), 'generator-1')

    expect(connected.source).toBe('connected')
    expect(connected.prompt).toBe('Connected prompt')
    expect(connected.promptDocument).toEqual({
      version: 1,
      segments: [{ type: 'text', text: 'Connected prompt' }]
    })
    expect(local.source).toBe('local')
    expect(local.prompt).toBe('Local override')
  })

  it('returns a detached prompt snapshot that later upstream edits cannot mutate', () => {
    const upstream = textNode('prompt-1', 'Original prompt')
    const project = projectWith([generatorNode(), upstream], [{
      id: 'prompt-edge',
      source: upstream.id,
      target: 'generator-1',
      targetHandle: 'prompt',
      createdAt: 1
    }])

    const snapshot = compileImageGeneratorPrompt(project, 'generator-1')
    upstream.segments[0].text = 'Changed later'

    expect(snapshot.prompt).toBe('Original prompt')
    expect(snapshot.promptDocument.segments).toEqual([{ type: 'text', text: 'Original prompt' }])
  })

  it('uses the upstream prompt when the persisted local text is empty', () => {
    const upstream = textNode('prompt-1', 'Connected prompt')
    const project = projectWith([
      generatorNode({ version: 1, segments: [{ type: 'text', text: '' }] }),
      upstream
    ], [{
      id: 'prompt-edge',
      source: upstream.id,
      target: 'generator-1',
      targetHandle: 'prompt',
      createdAt: 1
    }])

    const result = compileImageGeneratorPrompt(project, 'generator-1')

    expect(result.source).toBe('connected')
    expect(result.prompt).toBe('Connected prompt')
    expect(result.validationErrors).not.toContainEqual({ code: 'missing_prompt' })
  })

  it('keeps token identity and asset binding stable while figure numbers follow reordered inputOrder', () => {
    const document: PromptDocument = {
      version: 1,
      segments: [
        { type: 'text', text: 'Blend ' },
        { type: 'reference', referenceId: 'ref-product', label: 'Product' },
        { type: 'text', text: ' with ' },
        { type: 'reference', referenceId: 'ref-style', label: 'Style' }
      ]
    }
    const nodes = [
      generatorNode(document),
      imageNode('image-product', 'Product', 'asset-product'),
      imageNode('image-style', 'Style', 'asset-style')
    ]
    const edges: IFreeCanvasProject['edges'] = [
      {
        id: 'edge-product',
        source: 'image-product',
        target: 'generator-1',
        sourceHandle: 'image-output',
        targetHandle: 'reference-image',
        inputOrder: 0,
        referenceId: 'ref-product',
        createdAt: 1
      },
      {
        id: 'edge-style',
        source: 'image-style',
        target: 'generator-1',
        sourceHandle: 'image-output',
        targetHandle: 'reference-image',
        inputOrder: 1,
        referenceId: 'ref-style',
        createdAt: 2
      }
    ]

    const before = compileImageGeneratorPrompt(projectWith(nodes, edges), 'generator-1')
    const after = compileImageGeneratorPrompt(projectWith(nodes, [
      { ...edges[0], inputOrder: 1 },
      { ...edges[1], inputOrder: 0 }
    ]), 'generator-1')

    expect(before.prompt).toBe('Blend 图1 with 图2')
    expect(after.prompt).toBe('Blend 图2 with 图1')
    expect(after.promptDocument).toEqual(document)
    expect(after.inputAssets).toEqual([
      { referenceId: 'ref-style', role: 'reference-image', assetId: 'asset-style', order: 0 },
      { referenceId: 'ref-product', role: 'reference-image', assetId: 'asset-product', order: 1 }
    ])
  })

  it('keeps a disconnected token visible as an explicit unresolved validation error', () => {
    const document: PromptDocument = {
      version: 1,
      segments: [{ type: 'reference', referenceId: 'ref-product', label: 'Product' }]
    }

    const result = compileImageGeneratorPrompt(projectWith([generatorNode(document)]), 'generator-1')

    expect(result.canGenerate).toBe(false)
    expect(result.prompt).toBe('@Product')
    expect(result.validationErrors).toContainEqual({
      code: 'unresolved_reference',
      referenceId: 'ref-product'
    })
  })

  it('rejects planning and unknown nodes from connected Prompt and image inputs', () => {
    const isolatedNodes: IFreeCanvasNode[] = [
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
        sequence: { id: 'sequence', name: 'PRIVATE STORYBOARD BODY', description: '', style: '', constraints: '', rows: [], createdAt: 1, updatedAt: 1, meta: {} },
        source: {
          documentNodeId: 'document', documentRevision: 1, documentDigest: 'digest', documentResourceDigests: [],
          model: { connectionId: 'c', providerId: 'p', modelId: 'm', displayName: 'Model', capabilities: {} }, skills: []
        }, pendingFieldChanges: [], meta: {}
      },
      {
        id: 'unknown', kind: 'unsupported', originalKind: 'future-layout', title: 'Future',
        position: { x: 0, y: 0 }, width: 360, height: 220,
        originalNode: { id: 'unknown', kind: 'future-layout', assetId: 'private-asset' }, meta: {}
      }
    ]
    const project = projectWith([generatorNode(), ...isolatedNodes], [
      { id: 'document-prompt', source: 'document', target: 'generator-1', targetHandle: 'prompt', createdAt: 1 },
      { id: 'storyboard-prompt', source: 'storyboard', target: 'generator-1', targetHandle: 'prompt', createdAt: 2 },
      {
        id: 'unknown-image', source: 'unknown', target: 'generator-1', targetHandle: 'reference-image',
        referenceId: 'unknown-reference', createdAt: 3
      }
    ])

    const result = compileImageGeneratorPrompt(project, 'generator-1')

    expect(result.inputAssets).toEqual([])
    expect(result.prompt).toBe('')
    expect(result.validationErrors).toContainEqual({ code: 'connected_prompt_unresolved', edgeId: 'document-prompt' })
    expect(result.validationErrors).toContainEqual({
      code: 'unresolved_reference', referenceId: 'unknown-reference', edgeId: 'unknown-image'
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE DOCUMENT BODY')
    expect(JSON.stringify(result)).not.toContain('PRIVATE STORYBOARD BODY')
    expect(JSON.stringify(result)).not.toContain('private-asset')

    const storyboardOnly = compileImageGeneratorPrompt(projectWith(
      [generatorNode(), isolatedNodes[1]],
      [{ id: 'storyboard-only-prompt', source: 'storyboard', target: 'generator-1', targetHandle: 'prompt', createdAt: 1 }]
    ), 'generator-1')
    expect(storyboardOnly.validationErrors).toContainEqual({
      code: 'connected_prompt_unresolved', edgeId: 'storyboard-only-prompt'
    })
    expect(JSON.stringify(storyboardOnly)).not.toContain('PRIVATE STORYBOARD BODY')
  })

  it('lists only connected source/reference images with stable reference and asset identities', () => {
    const nodes = [
      generatorNode({ version: 1, segments: [{ type: 'text', text: 'Edit' }] }),
      imageNode('source', 'Source', 'asset-source'),
      imageNode('reference', 'Reference', 'asset-reference'),
      imageNode('unconnected', 'Unconnected', 'asset-unconnected')
    ]
    const project = projectWith(nodes, [
      {
        id: 'edge-source',
        source: 'source',
        target: 'generator-1',
        sourceHandle: 'image-output',
        targetHandle: 'source-image',
        createdAt: 1
      },
      {
        id: 'edge-reference',
        source: 'reference',
        target: 'generator-1',
        sourceHandle: 'image-output',
        targetHandle: 'reference-image',
        inputOrder: 0,
        referenceId: 'ref-reference',
        createdAt: 2
      }
    ])

    expect(compileImageGeneratorPrompt(project, 'generator-1').references).toEqual([
      {
        edgeId: 'edge-source',
        nodeId: 'source',
        referenceId: 'reference-edge-source',
        label: 'Source',
        role: 'source-image',
        assetId: 'asset-source',
        order: 0
      },
      {
        edgeId: 'edge-reference',
        nodeId: 'reference',
        referenceId: 'ref-reference',
        label: 'Reference',
        role: 'reference-image',
        assetId: 'asset-reference',
        order: 1
      }
    ])
  })

  it('accepts a completed image generator output as a downstream image input', () => {
    const upstream = {
      ...generatorNode({ version: 1, segments: [{ type: 'text', text: 'Upstream' }] }),
      id: 'upstream-generator',
      title: 'Upstream result',
      primaryAssetId: 'asset-upstream'
    }
    const project = projectWith([
      generatorNode({ version: 1, segments: [{ type: 'text', text: 'Continue' }] }),
      upstream
    ], [{
      id: 'edge-upstream',
      source: upstream.id,
      target: 'generator-1',
      sourceHandle: 'image-output',
      targetHandle: 'reference-image',
      inputOrder: 0,
      referenceId: 'ref-upstream',
      createdAt: 1
    }])

    expect(compileImageGeneratorPrompt(project, 'generator-1').inputAssets).toEqual([{
      referenceId: 'ref-upstream',
      role: 'reference-image',
      assetId: 'asset-upstream',
      order: 0
    }])
  })

  it('compiles a connected quick-message canvas source through the same prompt path', () => {
    const quickSource = quickMessagePresetToCanvasSource({
      id: 'quick-1',
      label: 'Cinematic light',
      content: 'Use low-key cinematic lighting'
    })
    const quickNode = {
      ...textNode('quick-node', quickSource.text, 'preset'),
      title: quickSource.title,
      meta: { quickMessagePresetId: quickSource.presetId }
    }
    const project = projectWith([generatorNode(), quickNode], [{
      id: 'prompt-edge',
      source: quickNode.id,
      target: 'generator-1',
      targetHandle: 'prompt',
      createdAt: 1
    }])

    expect(compileImageGeneratorPrompt(project, 'generator-1').prompt).toBe('Use low-key cinematic lighting')
  })

  it('blocks the generate-ready snapshot when a persisted region binding is stale', () => {
    const generator = {
      ...generatorNode({ version: 1, segments: [{ type: 'text', text: 'Edit product' }] }),
      mode: 'region-edit' as const,
      regions: [{ type: 'point' as const, x: 400, y: 500 }],
      meta: {
        imageRegionBindings: [{ regionId: 'region-stale', referenceId: 'ref-reference' }]
      }
    }
    const project = projectWith([
      generator,
      imageNode('source', 'Source', 'asset-source'),
      imageNode('reference', 'Reference', 'asset-reference')
    ], [
      {
        id: 'edge-source', source: 'source', target: generator.id,
        targetHandle: 'source-image', referenceId: 'ref-source', createdAt: 1
      },
      {
        id: 'edge-reference', source: 'reference', target: generator.id,
        targetHandle: 'reference-image', referenceId: 'ref-reference', createdAt: 2
      }
    ])

    const snapshot = compileImageGeneratorPrompt(project, generator.id)

    expect(snapshot.canGenerate).toBe(false)
    expect(snapshot.validationErrors).toContainEqual({
      code: 'stale_region_reference',
      regionId: 'region-stale',
      referenceId: 'ref-reference'
    })
  })

  it('keeps generation blocked after source disconnect even when stale regions are rebound to a reference', () => {
    const generator = {
      ...generatorNode({ version: 1, segments: [{ type: 'text', text: 'Edit product' }] }),
      mode: 'region-edit' as const,
      regions: [{ type: 'point' as const, x: 400, y: 500 }],
      meta: {
        imageRegionBindings: [{ regionId: 'region-rebound', referenceId: 'ref-reference' }]
      }
    }
    const project = projectWith([
      generator,
      imageNode('reference', 'Reference', 'asset-reference')
    ], [{
      id: 'edge-reference', source: 'reference', target: generator.id,
      targetHandle: 'reference-image', referenceId: 'ref-reference', createdAt: 1
    }])

    const snapshot = compileImageGeneratorPrompt(project, generator.id)

    expect(snapshot.canGenerate).toBe(false)
    expect(snapshot.validationErrors).toContainEqual({ code: 'missing_source_image' })
    expect(snapshot.validationErrors).not.toContainEqual(expect.objectContaining({
      code: 'unresolved_region_reference'
    }))
  })
})
