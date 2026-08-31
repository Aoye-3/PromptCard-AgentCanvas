import { describe, expect, test } from 'vitest'
import type {
  IFreeCanvasImageNode,
  IFreeCanvasProject,
  IFreeCanvasTextNode
} from '@/models/PromptHistory.model'
import {
  removeImageGeneratorConnection,
  validateImageGeneratorConnection
} from './image-generator-connections'

const generatorNode = {
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
  promptDocument: { version: 1, segments: [] },
  regions: [],
  meta: {}
} as const

const textNode = (id: string): IFreeCanvasTextNode => ({
  id,
  kind: 'text',
  title: 'Text',
  position: { x: 0, y: 0 },
  width: 420,
  height: 180,
  fontSize: 'large',
  segments: [],
  meta: {}
})

const imageNode = (id: string): IFreeCanvasImageNode => ({
  id,
  kind: 'image',
  title: 'Image',
  position: { x: 0, y: 0 },
  width: 300,
  height: 220,
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
  selectedNodeId: null,
  meta: {}
})

describe('image generator canvas connections', () => {
  test('rejects a second prompt input for the same generator', () => {
    const project = projectWith([
      generatorNode as never,
      textNode('prompt-1'),
      textNode('prompt-2')
    ], [{
      id: 'prompt-edge-1',
      source: 'prompt-1',
      target: generatorNode.id,
      targetHandle: 'prompt',
      createdAt: 1
    }])

    expect(validateImageGeneratorConnection(project, {
      source: 'prompt-2',
      target: generatorNode.id,
      targetHandle: 'prompt'
    })).toEqual([{ code: 'prompt_input_limit' }])
  })

  test.each<[string, IFreeCanvasProject['nodes'][number]]>([
    ['document', {
      id: 'document-source', kind: 'document', title: 'Plan', position: { x: 0, y: 0 }, width: 560, height: 420,
      document: { version: 1, blocks: [], revision: 1, digest: 'digest', suggestions: [] },
      linkedDocumentResourceIds: [], meta: {}
    }],
    ['storyboard', {
      id: 'storyboard-source', kind: 'storyboard', title: 'Shots', position: { x: 0, y: 0 }, width: 640, height: 480,
      sequence: {
        id: 'sequence', name: 'Shots', description: '', style: '', constraints: '', rows: [],
        createdAt: 1, updatedAt: 1, meta: {}
      },
      source: {
        documentNodeId: 'document-source', documentRevision: 1, documentDigest: 'digest',
        documentResourceDigests: [], model: { connectionId: 'c', providerId: 'p', modelId: 'm', displayName: 'Model', capabilities: {} }, skills: []
      },
      pendingFieldChanges: [], meta: {}
    }],
    ['unsupported', {
      id: 'unsupported-source', kind: 'unsupported', originalKind: 'future-layout',
      title: 'Future', position: { x: 0, y: 0 }, width: 360, height: 220,
      originalNode: { id: 'unsupported-source', kind: 'future-layout' }, meta: {}
    }]
  ])('rejects a %s node as an image-generator Prompt source', (_kind, sourceNode) => {
    const project = projectWith([generatorNode as never, sourceNode])

    expect(validateImageGeneratorConnection(project, {
      source: sourceNode.id,
      target: generatorNode.id,
      targetHandle: 'prompt'
    })).toEqual([{ code: 'prompt_input_requires_text_source' }])
  })

  test('rejects an eleventh reference image input', () => {
    const images = Array.from({ length: 11 }, (_, index) => imageNode(`image-${index + 1}`))
    const project = projectWith([
      generatorNode as never,
      ...images
    ], images.slice(0, 10).map((image, index) => ({
      id: `reference-edge-${index + 1}`,
      source: image.id,
      target: generatorNode.id,
      targetHandle: 'reference-image' as const,
      inputOrder: index,
      referenceId: `reference-${index + 1}`,
      createdAt: index + 1
    })))

    expect(validateImageGeneratorConnection(project, {
      source: images[10].id,
      target: generatorNode.id,
      targetHandle: 'reference-image'
    })).toEqual([{ code: 'reference_image_input_limit' }])
  })

  test('rejects more than ten total source and reference image inputs', () => {
    const images = Array.from({ length: 11 }, (_, index) => imageNode(`image-${index + 1}`))
    const project = projectWith([
      generatorNode as never,
      ...images
    ], [
      {
        id: 'source-edge',
        source: images[0].id,
        target: generatorNode.id,
        targetHandle: 'source-image',
        createdAt: 1
      },
      ...images.slice(1, 10).map((image, index) => ({
        id: `reference-edge-${index + 1}`,
        source: image.id,
        target: generatorNode.id,
        targetHandle: 'reference-image' as const,
        inputOrder: index,
        referenceId: `reference-${index + 1}`,
        createdAt: index + 2
      }))
    ])

    expect(validateImageGeneratorConnection(project, {
      source: images[10].id,
      target: generatorNode.id,
      targetHandle: 'reference-image'
    })).toEqual([{ code: 'image_input_limit' }])
  })

  test('renumbers reference image inputOrder after removing a middle edge', () => {
    const project = projectWith([
      generatorNode as never,
      imageNode('image-1'),
      imageNode('image-2'),
      imageNode('image-3')
    ], [
      {
        id: 'reference-edge-1',
        source: 'image-1',
        target: generatorNode.id,
        targetHandle: 'reference-image',
        inputOrder: 0,
        referenceId: 'reference-1',
        createdAt: 1
      },
      {
        id: 'reference-edge-2',
        source: 'image-2',
        target: generatorNode.id,
        targetHandle: 'reference-image',
        inputOrder: 1,
        referenceId: 'reference-2',
        createdAt: 2
      },
      {
        id: 'reference-edge-3',
        source: 'image-3',
        target: generatorNode.id,
        targetHandle: 'reference-image',
        inputOrder: 2,
        referenceId: 'reference-3',
        createdAt: 3
      }
    ])

    const updated = removeImageGeneratorConnection(project, 'reference-edge-2')

    expect(updated.edges).toEqual([
      expect.objectContaining({ id: 'reference-edge-1', inputOrder: 0, referenceId: 'reference-1' }),
      expect.objectContaining({ id: 'reference-edge-3', inputOrder: 1, referenceId: 'reference-3' })
    ])
  })

  test.each(['source-image', 'reference-image'] as const)(
    'rejects a non-image source connected to the %s input',
    targetHandle => {
      const project = projectWith([generatorNode as never, textNode('not-an-image')])

      expect(validateImageGeneratorConnection(project, {
        source: 'not-an-image',
        target: generatorNode.id,
        targetHandle
      })).toEqual([{ code: 'image_input_requires_image_source' }])
    }
  )

  test('accepts a completed generator output as an image input', () => {
    const upstream = {
      ...generatorNode,
      id: 'generator-upstream',
      primaryAssetId: 'asset-generated',
      meta: { status: 'succeeded' }
    }
    const project = projectWith([upstream as never, generatorNode as never])

    expect(validateImageGeneratorConnection(project, {
      source: upstream.id,
      target: generatorNode.id,
      targetHandle: 'reference-image'
    })).toEqual([])
  })

  test('rejects a generator output before it has a local result asset', () => {
    const upstream = { ...generatorNode, id: 'generator-upstream', primaryAssetId: undefined }
    const project = projectWith([upstream as never, generatorNode as never])

    expect(validateImageGeneratorConnection(project, {
      source: upstream.id,
      target: generatorNode.id,
      targetHandle: 'source-image'
    })).toEqual([{ code: 'image_generator_output_unavailable' }])
  })
})
