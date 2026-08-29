import { describe, expect, test, vi } from 'vitest'
import { createThreeStageProject } from '@/domain/projects/project-normalization'
import { storyboardDigest } from '@/domain/storyboard/canvas-storyboard'
import { updateFreeCanvasNodePosition, threeStageFormNodeId, createFreeCanvasMediaNode, addFreeCanvasMediaNode, addFreeCanvasEdge, mediaNodeFlowId } from './free-canvas'
import {
  addFreeCanvasImageAnnotation,
  appendFreeCanvasUserText,
  createFreeCanvasImageGeneratorNode,
  createFreeCanvasDocumentNode,
  createFreeCanvasImageGenerationPlaceholder,
  createFreeCanvasImageNodeFromMedia,
  createFreeCanvasProject,
  createFreeCanvasTextNode,
  createQuickTextNode,
  freeCanvasTextSegmentsToPlainText,
  failFreeCanvasImageGeneration,
  fitFreeCanvasImageNodeFrameToContent,
  completeFreeCanvasImageGeneration,
  migrateLegacyThreeStageFreeCanvasProject,
  normalizeFreeCanvasProject,
  replaceFreeCanvasTextRange,
  replaceFreeCanvasImageAnnotations,
  removeFreeCanvasImageAnnotation,
  removeFreeCanvasProjectNodes,
  updateFreeCanvasImageAnnotation,
  updateFreeCanvasImageNodeFrame,
  updateFreeCanvasNodePosition as updateFreeCanvasProjectNodePosition,
  updateFreeCanvasTextNodeStyle,
  updateFreeCanvasTextNodeUserText,
  renameFreeCanvasTextNode,
  replaceFreeCanvasUserTextRange,
  applyFreeCanvasTextInsertions,
  createFreeCanvasAgentRewriteNode,
  freeCanvasTextNodeRevision,
  matchesFreeCanvasTextProposalBasis,
  previewFreeCanvasTextInsertions
} from './free-canvas-project'
import type { IPromptProject, PlanningDocumentBlockV1 } from '@/models/PromptHistory.model'
import { createPlanningDocumentV1, planningDocumentDigest } from '@/domain/documents/planning-document'

describe('free canvas project domain', () => {
  test('previews interleaved insertions without changing the anchored segments', () => {
    const node = {
      ...createFreeCanvasTextNode('', { x: 80, y: 100 }, 100),
      id: 'source-text',
      segments: [
        { id: 'preset-1', source: 'preset' as const, text: 'Preset', color: '#ef4423', createdAt: 1, updatedAt: 1 },
        { id: 'user-1', source: 'user' as const, text: 'User', color: '#123456', createdAt: 2, updatedAt: 2 }
      ]
    }

    const preview = previewFreeCanvasTextInsertions(node, [
      { text: 'Before preset', anchor: { type: 'segment', segmentId: 'preset-1', position: 'before' } },
      { text: 'After user', anchor: { type: 'text', segmentId: 'user-1', text: 'User', position: 'after' } }
    ], 500)

    expect(preview.rejectionReason).toBeNull()
    expect(preview.segments?.map(segment => [segment.id, segment.source, segment.text, segment.color])).toEqual([
      [expect.stringMatching(/^segment-500-user-/), 'user', 'Before preset', '#111827'],
      ['preset-1', 'preset', 'Preset', '#ef4423'],
      ['user-1', 'user', 'User', '#123456'],
      [expect.stringMatching(/^segment-501-user-/), 'user', 'After user', '#111827']
    ])
  })

  test('rejects all text insertions when an anchor is ambiguous or too many are proposed', () => {
    const node = {
      ...createFreeCanvasTextNode('', { x: 80, y: 100 }, 100),
      id: 'source-text',
      segments: [
        { id: 'user-1', source: 'user' as const, text: 'repeat repeat', color: '#111827', createdAt: 1, updatedAt: 1 },
        { id: 'user-2', source: 'user' as const, text: 'another segment', color: '#111827', createdAt: 2, updatedAt: 2 }
      ]
    }
    const project = createFreeCanvasProject(100, { nodes: [node] })

    const ambiguous = applyFreeCanvasTextInsertions(project, node.id, [
      { text: 'cannot apply', anchor: { type: 'text', segmentId: 'user-1', text: 'repeat', position: 'after' } }
    ], 500)
    const excessive = applyFreeCanvasTextInsertions(project, node.id, Array.from({ length: 17 }, (_, index) => ({
      text: `extra ${index}`,
      anchor: { type: 'segment' as const, segmentId: 'user-1', position: 'after' as const }
    })), 500)
    const overlappingNode = {
      ...node,
      segments: [{ ...node.segments[0], text: 'aaa' }]
    }
    const overlappingProject = createFreeCanvasProject(100, { nodes: [overlappingNode] })
    const overlapping = applyFreeCanvasTextInsertions(overlappingProject, overlappingNode.id, [
      { text: 'cannot apply', anchor: { type: 'text', segmentId: 'user-1', text: 'aa', position: 'after' } }
    ], 500)

    expect(ambiguous).toEqual({ project, rejectionReason: 'text_anchor_not_unique' })
    expect(excessive).toEqual({ project, rejectionReason: 'too_many_insertions' })
    expect(overlapping).toEqual({ project: overlappingProject, rejectionReason: 'text_anchor_not_unique' })
  })

  test('inserts at a unique Unicode text anchor without altering source characters or colors', () => {
    const node = {
      ...createFreeCanvasTextNode('', { x: 80, y: 100 }, 100),
      id: 'source-text',
      segments: [
        { id: 'preset-1', source: 'preset' as const, text: '开场🎬\n夜景', color: '#ef4423', createdAt: 1, updatedAt: 1 },
        { id: 'user-1', source: 'user' as const, text: '保持原文', color: '#123456', createdAt: 2, updatedAt: 2 }
      ]
    }

    const preview = previewFreeCanvasTextInsertions(node, [{
      text: '补充镜头',
      anchor: { type: 'text', segmentId: 'preset-1', text: '🎬\n', position: 'after' }
    }], 500)

    expect(preview.rejectionReason).toBeNull()
    expect(preview.segments?.map(segment => [segment.source, segment.text, segment.color])).toEqual([
      ['preset', '开场🎬\n', '#ef4423'],
      ['user', '补充镜头', '#111827'],
      ['preset', '夜景', '#ef4423'],
      ['user', '保持原文', '#123456']
    ])
    expect(preview.segments?.[0].id).toBe('preset-1')
    expect(preview.segments?.filter(segment => segment.source === 'preset').map(segment => segment.text).join('')).toBe('开场🎬\n夜景')
  })

  test('creates a collision-free rewrite node that retains the source presentation and provenance', () => {
    const source = {
      ...createFreeCanvasTextNode('Original text', { x: 80, y: 100 }, 100),
      id: 'source-text',
      title: 'Shot prompt',
      width: 560,
      height: 220,
      fontSize: 'huge' as const
    }
    const blockingNode = {
      ...createFreeCanvasTextNode('Blocking', { x: 688, y: 100 }, 101),
      id: 'blocking-text',
      title: 'Shot prompt · 改写'
    }
    const project = createFreeCanvasProject(100, { nodes: [source, blockingNode] })

    const rewrite = createFreeCanvasAgentRewriteNode(project, source, 'Rewritten text', {
      baseNodeRevision: 100,
      templateDigest: 'sha256:template',
      baseSegmentsDigest: 'sha256:segments'
    }, 500, {
      model: {
        connectionId: 'connection-1',
        providerId: 'volcengine-ark',
        modelId: 'doubao-seed-2-0-lite-260215',
        displayName: 'Doubao Seed 2.0 Lite'
      },
      skills: [{ skillId: 'SKL-canvas-prompt-editor', revision: 3, digest: 'sha256:skill' }]
    })

    expect(rewrite).toMatchObject({
      kind: 'text',
      title: 'Shot prompt · 改写 (2)',
      position: { x: 688, y: 344 },
      width: 560,
      height: 220,
      fontSize: 'huge',
      segments: [expect.objectContaining({ source: 'user', text: 'Rewritten text', color: '#111827' })],
      meta: {
        provenance: {
          kind: 'agent-rewrite',
          sourceNodeId: 'source-text',
          basis: {
            baseNodeRevision: 100,
            templateDigest: 'sha256:template',
            baseSegmentsDigest: 'sha256:segments'
          },
          model: {
            connectionId: 'connection-1',
            providerId: 'volcengine-ark',
            modelId: 'doubao-seed-2-0-lite-260215',
            displayName: 'Doubao Seed 2.0 Lite'
          },
          skills: [{ skillId: 'SKL-canvas-prompt-editor', revision: 3, digest: 'sha256:skill' }]
        }
      }
    })
  })

  test('keeps derived rewrite titles within the text-node naming limit', () => {
    const source = {
      ...createFreeCanvasTextNode('Original text', { x: 80, y: 100 }, 100),
      id: 'source-text',
      title: 'A'.repeat(32)
    }
    const first = createFreeCanvasAgentRewriteNode(
      createFreeCanvasProject(100, { nodes: [source] }),
      source,
      'Rewrite',
      { baseNodeRevision: 100, templateDigest: 'sha256:t', baseSegmentsDigest: 'sha256:s' },
      500
    )
    const second = createFreeCanvasAgentRewriteNode(
      createFreeCanvasProject(100, { nodes: [source, first] }),
      source,
      'Rewrite again',
      { baseNodeRevision: 100, templateDigest: 'sha256:t', baseSegmentsDigest: 'sha256:s' },
      501
    )

    expect(first.title).toHaveLength(32)
    expect(first.title.endsWith(' · 改写')).toBe(true)
    expect(second.title).toHaveLength(32)
    expect(second.title.endsWith(' (2)')).toBe(true)
  })

  test('requires every rewrite basis value to match the source text node', () => {
    const node = {
      ...createFreeCanvasTextNode('Original', { x: 0, y: 0 }, 100),
      segments: [{ id: 'segment-1', source: 'user' as const, text: 'Original', color: '#111827', createdAt: 1, updatedAt: 9 }]
    }
    const basis = { baseNodeRevision: 9, templateDigest: 'sha256:template', baseSegmentsDigest: 'sha256:segments' }

    expect(freeCanvasTextNodeRevision(node)).toBe(9)
    expect(matchesFreeCanvasTextProposalBasis(node, basis, {
      templateDigest: 'sha256:template',
      baseSegmentsDigest: 'sha256:segments'
    })).toBe(true)
    expect(matchesFreeCanvasTextProposalBasis(node, basis, {
      templateDigest: 'sha256:changed-template',
      baseSegmentsDigest: 'sha256:segments'
    })).toBe(false)
    expect(matchesFreeCanvasTextProposalBasis(node, basis, {
      templateDigest: 'sha256:template',
      baseSegmentsDigest: 'sha256:changed-segments'
    })).toBe(false)
  })

  test('creates an empty standalone free canvas project payload', () => {
    const project = createFreeCanvasProject(100)

    expect(project.nodes).toEqual([])
    expect(project.edges).toEqual([])
    expect(project.selectedNodeId).toBeNull()
  })

  test('removes the last node without blocking the empty canvas', () => {
    const node = createQuickTextNode('Use dusk lighting', { x: 20, y: 40 }, 100)
    const project = createFreeCanvasProject(100, { nodes: [node], selectedNodeId: node.id })

    const updated = removeFreeCanvasProjectNodes(project, [node.id])

    expect(updated.nodes).toEqual([])
    expect(updated.edges).toEqual([])
    expect(updated.selectedNodeId).toBeNull()
  })

  test('normalizes image nodes with an empty annotations array', () => {
    const image = createFreeCanvasImageNodeFromMedia(createFreeCanvasMediaNode('imageAsset', { x: 20, y: 40 }, 100), 101)
    const project = createFreeCanvasProject(100, { nodes: [{ ...image, annotations: undefined } as never] })

    expect(project.nodes[0]).toMatchObject({
      kind: 'image',
      annotations: []
    })
  })

  test('preserves response-only reference codes while normalizing supported Canvas nodes', () => {
    const text = { ...createFreeCanvasTextNode('Prompt', { x: 0, y: 0 }, 100), referenceCode: 'CVT-response' }
    const image = {
      ...createFreeCanvasImageNodeFromMedia(createFreeCanvasMediaNode('imageAsset', { x: 20, y: 40 }, 100), 101),
      referenceCode: 'CVM-response'
    }
    const project = createFreeCanvasProject(102, { nodes: [text, image] })

    expect(project.nodes.map(node => node.referenceCode)).toEqual(['CVT-response', 'CVM-response'])
  })

  test('preserves only strict boolean transient markers while normalizing image nodes', () => {
    const image = createFreeCanvasImageNodeFromMedia(createFreeCanvasMediaNode('imageAsset', { x: 20, y: 40 }, 100), 101)
    const nodes = [
      { ...image, id: 'transient-true', transient: true },
      { ...image, id: 'transient-false', transient: false },
      { ...image, id: 'transient-malformed', transient: 'true' }
    ]

    const normalized = normalizeFreeCanvasProject({ nodes: nodes as never, edges: [], meta: {} }, 102)

    expect(normalized.nodes.map(node => node.kind === 'image' ? node.transient : undefined))
      .toEqual([true, false, undefined])
  })

  test('creates a stable running image generation placeholder', () => {
    const node = createFreeCanvasImageGenerationPlaceholder({
      runId: 'image-run-0123456789abcdef0123456789abcdef',
      conversationId: 'conversation-1',
      prompt: 'A red apple',
      position: { x: 120, y: 240 },
      width: 320,
      height: 180
    })

    expect(node).toMatchObject({
      id: 'free-image-generation-image-run-0123456789abcdef0123456789abcdef',
      kind: 'image',
      position: { x: 120, y: 240 },
      width: 320,
      height: 180,
      assetId: null,
      imagePrompt: 'A red apple',
      meta: {
        generationRunId: 'image-run-0123456789abcdef0123456789abcdef',
        conversationId: 'conversation-1',
        generationState: 'running',
        source: 'image-generation-conversation'
      }
    })
  })

  test('completes a placeholder without overwriting its moved and resized frame', () => {
    const runId = 'image-run-0123456789abcdef0123456789abcdef'
    const placeholder = createFreeCanvasImageGenerationPlaceholder({
      runId,
      conversationId: 'conversation-1',
      prompt: 'A red apple',
      position: { x: 120, y: 240 },
      width: 320,
      height: 180
    })
    const moved = updateFreeCanvasProjectNodePosition(
      updateFreeCanvasImageNodeFrame(createFreeCanvasProject(1, { nodes: [placeholder] }), placeholder.id, {
        width: 480,
        height: 270
      }),
      placeholder.id,
      { x: 400, y: 500 }
    )

    const completed = completeFreeCanvasImageGeneration(moved, runId, 'asset-output.png', '/asset-output.png')

    expect(completed.nodes[0]).toMatchObject({
      id: placeholder.id,
      position: { x: 400, y: 500 },
      width: 480,
      height: 270,
      assetId: 'asset-output.png',
      imageUrl: '/asset-output.png',
      meta: { generationState: 'succeeded', generatedResult: true }
    })
    expect(completed.nodes[0].meta).not.toHaveProperty('generationErrorCode')
  })

  test('keeps running generation nodes when removal is requested and allows failed nodes to be removed', () => {
    const runId = 'image-run-0123456789abcdef0123456789abcdef'
    const placeholder = createFreeCanvasImageGenerationPlaceholder({
      runId,
      conversationId: 'conversation-1',
      prompt: 'A red apple',
      position: { x: 0, y: 0 },
      width: 320,
      height: 320
    })
    const running = createFreeCanvasProject(1, { nodes: [placeholder], selectedNodeId: placeholder.id })

    expect(removeFreeCanvasProjectNodes(running, [placeholder.id]).nodes).toHaveLength(1)

    const failed = failFreeCanvasImageGeneration(running, runId, 'rate_limited')
    expect(failed.nodes[0]).toMatchObject({ meta: { generationState: 'failed', generationErrorCode: 'rate_limited' } })
    expect(removeFreeCanvasProjectNodes(failed, [placeholder.id]).nodes).toHaveLength(0)
  })

  test('creates a generator bound to the current image.primary assignment', () => {
    const node = createFreeCanvasImageGeneratorNode(
      { x: 30, y: 40 },
      { connectionId: 'ark-primary', modelId: 'doubao-seedream-5-0-pro-260628' },
      100
    )

    expect(node).toMatchObject({
      id: 'free-image-generator-100', kind: 'image-generator', title: 'Image generator',
      position: { x: 30, y: 40 }, mode: 'generate',
      binding: { connectionId: 'ark-primary', modelId: 'doubao-seedream-5-0-pro-260628' },
      settings: { resolution: '1K', aspectRatio: 'smart', outputFormat: 'png', watermark: false },
      promptDocument: { version: 1, segments: [] }, regions: [], meta: { status: 'idle' }
    })
  })

  test('round-trips typed image generator nodes without losing persisted fields', () => {
    const generator = {
      id: 'generator-1',
      kind: 'image-generator',
      title: 'Seedream generator',
      position: { x: 120, y: 240 },
      width: 420,
      height: 560,
      mode: 'region-edit',
      binding: {
        connectionId: 'ark-connection',
        modelId: 'doubao-seedream-5-0-pro-260628'
      },
      settings: {
        resolution: '2K',
        aspectRatio: '1:1',
        outputFormat: 'png',
        watermark: true
      },
      promptDocument: {
        version: 1,
        segments: [
          { type: 'text', text: 'Change the background using ' },
          { type: 'reference', referenceId: 'reference-1', label: 'Product' }
        ]
      },
      regions: [
        { type: 'point', x: 120, y: 240 },
        { type: 'bbox', x: 100, y: 200, width: 300, height: 400 }
      ],
      activeRunId: 'run-1',
      primaryAssetId: 'asset-1',
      meta: { inspectorTab: 'regions' }
    }

    const project = createFreeCanvasProject(100, { nodes: [generator as never] })

    expect(project.nodes[0]).toEqual(generator)
  })

  test('normalizes malformed legacy image regions to safe integer grid geometry', () => {
    const project = createFreeCanvasProject(100, {
      nodes: [{
        id: 'legacy-region-generator',
        kind: 'image-generator',
        binding: { connectionId: 'connection-1', modelId: 'image-model-1' },
        regions: [
          { type: 'point', x: -4.6, y: 1_000.7 },
          { type: 'point', x: 'not-a-number', y: 20 },
          { type: 'bbox', x: 800.2, y: 900.4, width: -600.3, height: -800.3 },
          { type: 'bbox', x: 10, y: 20, width: 0, height: 30 },
          null
        ]
      } as never]
    })

    expect(project.nodes[0]).toMatchObject({
      regions: [
        { type: 'point', x: 0, y: 999 },
        { type: 'bbox', x: 200, y: 100, width: 600, height: 800 }
      ]
    })
  })

  test('round-trips aligned image region bindings when earlier malformed geometry is discarded', () => {
    const normalized = createFreeCanvasProject(100, {
      nodes: [{
        id: 'bound-region-generator',
        kind: 'image-generator',
        binding: { connectionId: 'connection-1', modelId: 'image-model-1' },
        regions: [
          { type: 'point', x: 'not-a-number', y: 20 },
          { type: 'bbox', x: 100, y: 200, width: 300, height: 400 }
        ],
        meta: {
          imageRegionBindings: [
            { regionId: 'region-bad', referenceId: 'reference-bad' },
            { regionId: 'region-good', referenceId: 'reference-good' }
          ]
        }
      } as never]
    })
    const project = createFreeCanvasProject(101, normalized)

    expect(project.nodes[0]).toMatchObject({
      regions: [{ type: 'bbox', x: 100, y: 200, width: 300, height: 400 }],
      meta: {
        imageRegionBindings: [{ regionId: 'region-good', referenceId: 'reference-good' }]
      }
    })
  })

  test('normalizes multiple discarded, missing, and extra region bindings without shifting identities', () => {
    const project = createFreeCanvasProject(100, {
      nodes: [{
        id: 'mixed-bound-region-generator',
        kind: 'image-generator',
        binding: { connectionId: 'connection-1', modelId: 'image-model-1' },
        regions: [
          { type: 'point', x: Number.NaN, y: 20 },
          { type: 'bbox', x: 100, y: 200, width: 300, height: 400 },
          { type: 'bbox', x: 10, y: 20, width: 0, height: 30 },
          { type: 'point', x: 500, y: 600 },
          { type: 'bbox', x: 700, y: 800, width: 50, height: 60 }
        ],
        meta: {
          imageRegionBindings: [
            { regionId: 'region-discarded-point', referenceId: 'reference-discarded-point' },
            { regionId: 'region-first', referenceId: 'reference-first' },
            { regionId: 'region-discarded-box', referenceId: 'reference-discarded-box' },
            null,
            { regionId: 'region-last', referenceId: 'reference-last' },
            { regionId: 'region-extra', referenceId: 'reference-extra' }
          ]
        }
      } as never]
    })

    expect(project.nodes[0]).toMatchObject({
      regions: [
        { type: 'bbox', x: 100, y: 200, width: 300, height: 400 },
        { type: 'point', x: 500, y: 600 },
        { type: 'bbox', x: 700, y: 800, width: 50, height: 60 }
      ],
      meta: {
        imageRegionBindings: [
          { regionId: 'region-first', referenceId: 'reference-first' },
          { regionId: 'region-1', referenceId: '' },
          { regionId: 'region-last', referenceId: 'reference-last' }
        ]
      }
    })
  })

  test('keeps legacy image regions without binding metadata safe', () => {
    const project = createFreeCanvasProject(100, {
      nodes: [{
        id: 'legacy-unbound-region-generator',
        kind: 'image-generator',
        binding: { connectionId: 'connection-1', modelId: 'image-model-1' },
        regions: [{ type: 'bbox', x: 100, y: 200, width: 300, height: 400 }],
        meta: { inspectorTab: 'regions' }
      } as never]
    })

    expect(project.nodes[0]).toMatchObject({
      regions: [{ type: 'bbox', x: 100, y: 200, width: 300, height: 400 }],
      meta: { inspectorTab: 'regions' }
    })
    expect(project.nodes[0].meta).not.toHaveProperty('imageRegionBindings')
  })

  test('round-trips typed image generator edge metadata', () => {
    const project = createFreeCanvasProject(100, {
      nodes: [
        {
          id: 'source-image',
          kind: 'image',
          title: 'Image',
          position: { x: 0, y: 0 },
          width: 300,
          height: 220,
          annotations: [],
          meta: {}
        },
        {
          id: 'generator-1',
          kind: 'image-generator',
          binding: { connectionId: 'connection-1', modelId: 'image-model-1' }
        } as never
      ],
      edges: [{
        id: 'reference-edge',
        source: 'source-image',
        target: 'generator-1',
        sourceHandle: 'image-output',
        targetHandle: 'reference-image',
        inputOrder: 0,
        referenceId: 'reference-1',
        label: 'Product',
        createdAt: 50
      }]
    })

    expect(project.edges[0]).toEqual({
      id: 'reference-edge',
      source: 'source-image',
      target: 'generator-1',
      sourceHandle: 'image-output',
      targetHandle: 'reference-image',
      inputOrder: 0,
      referenceId: 'reference-1',
      label: 'Product',
      createdAt: 50
    })
  })

  test('keeps legacy text, image, and arrow node payloads compatible', () => {
    const project = createFreeCanvasProject(100, {
      nodes: [
        {
          id: 'legacy-text',
          kind: 'text',
          title: 'Text',
          position: { x: 1, y: 2 },
          width: 300,
          height: 120,
          fontSize: 'medium',
          segments: [],
          meta: { legacy: true }
        },
        {
          id: 'legacy-image',
          kind: 'image',
          title: 'Image',
          position: { x: 3, y: 4 },
          width: 320,
          height: 240,
          assetId: 'asset-old',
          imageUrl: '/old.png',
          imagePrompt: 'old prompt',
          sourceNodeId: null,
          crop: null,
          annotations: [],
          meta: { legacy: true }
        },
        {
          id: 'legacy-arrow',
          kind: 'arrow',
          title: 'Arrow',
          position: { x: 5, y: 6 },
          width: 260,
          height: 120,
          text: 'Next',
          color: '#123456',
          meta: { legacy: true }
        }
      ]
    })

    expect(project.nodes.map(node => node.kind)).toEqual(['text', 'image', 'arrow'])
    expect(project.nodes[0]).toMatchObject({ id: 'legacy-text', fontSize: 'medium', meta: { legacy: true } })
    expect(project.nodes[1]).toMatchObject({ id: 'legacy-image', assetId: 'asset-old', imageUrl: '/old.png' })
    expect(project.nodes[2]).toMatchObject({ id: 'legacy-arrow', text: 'Next', color: '#123456' })
  })

  test('keeps planning documents and storyboards isolated from Prompt text normalization', () => {
    const planningDocument = createPlanningDocumentV1([
      { id: 'paragraph-1', type: 'paragraph', content: [{ text: 'Private planning prose', bold: true }] }
    ], 3)
    const document = {
      id: 'document-1',
      kind: 'document',
      title: 'Creative brief',
      position: { x: 10, y: 20 },
      width: 560,
      height: 420,
      document: planningDocument,
      linkedDocumentResourceIds: ['resource-1'],
      meta: { collapsed: false }
    }
    const storyboard = {
      id: 'storyboard-1',
      kind: 'storyboard',
      title: 'Opening sequence',
      position: { x: 620, y: 20 },
      width: 640,
      height: 480,
      sequence: {
        id: 'sequence-1',
        name: 'Opening',
        description: 'Arrival',
        style: 'Cinematic',
        constraints: 'No dialogue',
        rows: [],
        createdAt: 1,
        updatedAt: 2,
        meta: {}
      },
      source: {
        documentNodeId: 'document-1',
        documentRevision: 3,
        documentDigest: planningDocument.digest,
        documentResourceDigests: ['resource-digest'],
        model: { connectionId: 'connection-1', providerId: 'provider-1', modelId: 'model-1' },
        skills: [{ skillId: 'skill-1', revision: 2, digest: 'skill-digest' }]
      },
      pendingFieldChanges: [],
      meta: {}
    }

    const project = normalizeFreeCanvasProject({
      nodes: [document, storyboard] as never,
      edges: [],
      meta: {}
    }, 100)

    expect(project.nodes.map(node => node.kind)).toEqual(['document', 'storyboard'])
    expect(project.nodes[0]).toMatchObject(document)
    expect(project.nodes[1]).toMatchObject(storyboard)
    expect(project.nodes.every(node => node.kind !== 'text')).toBe(true)
  })

  test('reloads strict Storyboard digest/marker evidence and freezes corrupted evidence losslessly', () => {
    const sequence = {
      id: 'sequence-strict', name: 'Opening', description: '', style: 'ink', constraints: '',
      rows: [{
        id: 'row-1', cutLabel: '1', timeRange: '0-3s', subject: 'Mara', action: 'enters', scene: 'hall',
        camera: 'wide', lighting: '', audio: '', duration: '3s', createdAt: 1, updatedAt: 1
      }],
      createdAt: 1, updatedAt: 1, meta: {}
    }
    const digest = storyboardDigest(sequence, [])
    const strictNode = {
      id: 'storyboard-strict', kind: 'storyboard', title: 'Strict shots', position: { x: 0, y: 0 },
      width: 680, height: 440, sequence,
      source: {
        documentNodeId: 'document-1', documentRevision: 4, documentDigest: `sha256:${'a'.repeat(64)}`,
        documentResourceDigests: [], model: { connectionId: 'c', providerId: 'p', modelId: 'm' }, skills: []
      },
      pendingFieldChanges: [], revision: 0, digest,
      agentAppliedEdit: {
        conversationId: 'conversation-1', requestId: 'request-1', editId: 'edit-1', resultDigest: digest
      },
      meta: {}
    }

    const valid = normalizeFreeCanvasProject({ nodes: [strictNode] as never, edges: [], meta: {} }, 100)
    const corrupt = normalizeFreeCanvasProject({
      nodes: [{ ...strictNode, digest: `sha256:${'f'.repeat(64)}` }] as never, edges: [], meta: {}
    }, 100)

    expect(valid.nodes[0]).toMatchObject({ kind: 'storyboard', revision: 0, digest, agentAppliedEdit: strictNode.agentAppliedEdit })
    expect(corrupt.nodes[0]).toMatchObject({
      kind: 'unsupported', originalKind: 'storyboard',
      originalNode: expect.objectContaining({ id: 'storyboard-strict', digest: `sha256:${'f'.repeat(64)}` })
    })
  })

  test.each([
    { label: 'empty document', blocks: [] },
    { label: 'empty bullet list', blocks: [{ id: 'empty-list', type: 'bulletList', items: [] }] },
    { label: 'empty ordered list', blocks: [{ id: 'empty-list', type: 'orderedList', items: [] }] },
    { label: 'empty check list', blocks: [{ id: 'empty-list', type: 'checkList', items: [] }] },
    { label: 'zero-length inline', blocks: [{ id: 'empty-inline', type: 'paragraph', content: [{ text: '' }] }] },
    {
      label: 'adjacent identical marked runs',
      blocks: [{
        id: 'adjacent-inline',
        type: 'paragraph',
        content: [
          { text: 'A', bold: true, italic: true, href: 'https://example.com/same' },
          { text: 'B', bold: true, italic: true, href: 'https://example.com/same' }
        ]
      }]
    }
  ] as Array<{ label: string; blocks: PlanningDocumentBlockV1[] }>)('freezes a correct-digest unrenderable Document ($label) as lossless unsupported data', ({ blocks }) => {
    const digestInput = { version: 1 as const, blocks, suggestions: [] }
    const document = { ...digestInput, revision: 2, digest: planningDocumentDigest(digestInput) }
    const originalNode = {
      id: 'document-invalid-structure',
      kind: 'document',
      title: 'Preserve the invalid structure',
      position: { x: 10, y: 20 },
      width: 560,
      height: 420,
      document,
      linkedDocumentResourceIds: ['resource-1'],
      futureNodeAttribute: { preserve: ['exactly'] },
      meta: { collapsed: true }
    }

    const project = normalizeFreeCanvasProject({ nodes: [originalNode] as never, edges: [], meta: {} }, 100)

    expect(project.nodes[0]).toMatchObject({
      id: 'document-invalid-structure',
      kind: 'unsupported',
      originalKind: 'document',
      originalNode
    })
    if (project.nodes[0].kind !== 'unsupported') throw new Error('Expected unsupported node')
    expect(project.nodes[0].originalNode).not.toBe(originalNode)
    expect(Object.isFrozen(project.nodes[0].originalNode)).toBe(true)
    expect(Object.isFrozen(project.nodes[0].originalNode.document)).toBe(true)
  })

  test.each([
    {
      label: 'unknown version',
      document: { version: 2, blocks: [], revision: 0, digest: 'sha256:invalid', suggestions: [] }
    },
    {
      label: 'digest mismatch',
      document: { version: 1, blocks: [], revision: 0, digest: 'sha256:invalid', suggestions: [] }
    },
    {
      label: 'unknown AST block',
      document: {
        version: 1,
        blocks: [{ id: 'code-1', type: 'codeBlock', content: [{ text: 'secret' }] }],
        revision: 0,
        digest: 'sha256:invalid',
        suggestions: []
      }
    },
    {
      label: 'Task 7 suggestion data',
      document: {
        version: 1,
        blocks: [],
        revision: 0,
        digest: 'sha256:invalid',
        suggestions: [{ id: 'future-suggestion', operation: { arbitrary: true } }]
      }
    }
  ])('projects an invalid Document ($label) as a lossless read-only unsupported node', ({ document }) => {
    const originalNode = {
      id: 'document-invalid',
      kind: 'document',
      title: 'Do not lose this node',
      position: { x: 10, y: 20 },
      width: 560,
      height: 420,
      document,
      linkedDocumentResourceIds: ['resource-1'],
      futureNodeAttribute: { preserve: ['byte-for-structure'] },
      meta: { collapsed: true }
    }
    const project = normalizeFreeCanvasProject({
      nodes: [
        originalNode,
        { ...createFreeCanvasTextNode('Prompt', { x: 0, y: 0 }, 100), id: 'text-1' }
      ] as never,
      edges: [{ id: 'invalid-document-edge', source: 'document-invalid', target: 'text-1', createdAt: 1 }],
      meta: {}
    }, 100)

    expect(project.nodes[0]).toMatchObject({
      id: 'document-invalid',
      kind: 'unsupported',
      originalKind: 'document',
      originalNode
    })
    if (project.nodes[0].kind !== 'unsupported') throw new Error('Expected unsupported node')
    expect(project.nodes[0].originalNode).not.toBe(originalNode)
    expect(Object.isFrozen(project.nodes[0].originalNode)).toBe(true)
    expect(Object.isFrozen(project.nodes[0].originalNode.document)).toBe(true)
    expect(project.edges).toEqual([])
  })

  test('preserves a strict top-level Agent edit marker while normalizing and cloning a Document node', () => {
    const node = createFreeCanvasDocumentNode({ x: 12, y: 34 }, 100)
    const agentAppliedEdit = {
      conversationId: 'conversation-1',
      requestId: 'request-1',
      editId: 'edit-1',
      resultDigest: node.document.digest
    }
    const normalized = normalizeFreeCanvasProject({
      nodes: [{ ...node, agentAppliedEdit }], edges: [], meta: {}
    }, 101)

    expect(normalized.nodes[0]).toMatchObject({ kind: 'document', agentAppliedEdit })
    if (normalized.nodes[0].kind !== 'document') throw new Error('Expected Document node')
    expect(normalized.nodes[0].agentAppliedEdit).toEqual(agentAppliedEdit)
    expect(normalized.nodes[0].agentAppliedEdit).not.toBe(agentAppliedEdit)
    expect(normalized.nodes[0].document.digest).toBe(node.document.digest)
  })

  test.each([
    { conversationId: '', requestId: 'request-1', editId: 'edit-1', resultDigest: 'sha256:x' },
    { conversationId: 'conversation-1', requestId: 'request-1', editId: 'edit-1' },
    { conversationId: 'conversation-1', requestId: 'request-1', editId: 'edit-1', resultDigest: 'sha256:x', extra: true }
  ])('freezes a correct-document-digest node with malformed Agent marker as lossless unsupported data', marker => {
    const node = createFreeCanvasDocumentNode({ x: 12, y: 34 }, 100)
    const originalNode = { ...node, agentAppliedEdit: marker }
    const normalized = normalizeFreeCanvasProject({ nodes: [originalNode] as never, edges: [], meta: {} }, 101)

    expect(normalized.nodes[0]).toMatchObject({ kind: 'unsupported', originalKind: 'document', originalNode })
    if (normalized.nodes[0].kind !== 'unsupported') throw new Error('Expected unsupported node')
    expect(Object.isFrozen(normalized.nodes[0].originalNode)).toBe(true)
    expect(Object.isFrozen(normalized.nodes[0].originalNode.agentAppliedEdit)).toBe(true)
  })

  test('projects unknown node kinds as detached read-only data and drops their connections', () => {
    const unknownNode = {
      id: 'future-1',
      kind: 'future-layout',
      title: 'Future node',
      position: { x: 40, y: 50 },
      width: 360,
      height: 220,
      payload: { nested: [{ value: 'preserve exactly' }] },
      meta: { futureFlag: true }
    }
    const textNode = {
      id: 'text-1', kind: 'text', title: 'Prompt', position: { x: 0, y: 0 }, width: 420, height: 180,
      fontSize: 'large', segments: [], meta: {}
    }
    const project = normalizeFreeCanvasProject({
      nodes: [unknownNode, textNode] as never,
      edges: [{ id: 'future-edge', source: 'future-1', target: 'text-1', createdAt: 1 }],
      selectedNodeId: 'future-1',
      meta: {}
    }, 100)

    expect(project.nodes[0]).toMatchObject({
      id: 'future-1',
      kind: 'unsupported',
      originalKind: 'future-layout',
      originalNode: unknownNode
    })
    if (project.nodes[0].kind !== 'unsupported') throw new Error('Expected unsupported node')
    expect(project.nodes[0].originalNode).not.toBe(unknownNode)
    expect(Object.isFrozen(project.nodes[0].originalNode)).toBe(true)
    expect(Object.isFrozen((project.nodes[0].originalNode.payload as { nested: unknown[] }).nested)).toBe(true)
    unknownNode.payload.nested[0].value = 'mutated source'
    expect(project.nodes[0].originalNode).toMatchObject({
      payload: { nested: [{ value: 'preserve exactly' }] }
    })
    expect(project.edges).toEqual([])
    expect(project.selectedNodeId).toBe('future-1')
  })

  test('keeps malformed generator payloads as safe generator nodes with a validation warning', () => {
    const project = createFreeCanvasProject(100, {
      nodes: [{
        id: 'damaged-generator',
        kind: 'image-generator',
        binding: { connectionId: 42, modelId: null },
        meta: { imported: true }
      } as never]
    })

    expect(project.nodes[0]).toMatchObject({
      id: 'damaged-generator',
      kind: 'image-generator',
      mode: 'generate',
      binding: { connectionId: '', modelId: '' },
      settings: {
        resolution: '1K',
        aspectRatio: 'smart',
        outputFormat: 'png',
        watermark: false
      },
      promptDocument: { version: 1, segments: [] },
      regions: [],
      meta: {
        imported: true,
        validationWarnings: ['invalid_image_model_binding']
      }
    })
  })

  test('adds annotations to legacy image nodes that do not have annotations yet', () => {
    const image = createFreeCanvasImageNodeFromMedia(createFreeCanvasMediaNode('imageAsset', { x: 20, y: 40 }, 100), 101)
    const project = createFreeCanvasProject(100, { nodes: [{ ...image, annotations: undefined } as never] })

    const updated = addFreeCanvasImageAnnotation({
      ...project,
      nodes: project.nodes.map(node => node.kind === 'image' ? ({ ...node, annotations: undefined } as never) : node)
    }, image.id, 'rect', 102)

    if (updated.nodes[0].kind !== 'image') throw new Error('Expected image node')
    expect(updated.nodes[0].annotations).toEqual([
      expect.objectContaining({ kind: 'rect', fill: '#ffffff' })
    ])
  })

  test('adds, updates, and removes image annotations', () => {
    const image = createFreeCanvasImageNodeFromMedia(createFreeCanvasMediaNode('imageAsset', { x: 20, y: 40 }, 100), 101)
    const project = createFreeCanvasProject(100, { nodes: [image] })

    const withAnnotation = addFreeCanvasImageAnnotation(project, image.id, 'shotNumber', 102)
    const annotation = withAnnotation.nodes[0].kind === 'image' ? withAnnotation.nodes[0].annotations[0] : null
    if (!annotation) throw new Error('Expected image annotation')

    expect(annotation).toMatchObject({
      kind: 'shotNumber',
      text: '1',
      width: 0.065,
      height: 0.065,
      color: '#ffffff',
      fill: '#111827'
    })

    const updated = updateFreeCanvasImageAnnotation(withAnnotation, image.id, annotation.id, {
      x: 0.25,
      y: 0.2,
      text: '12'
    })

    if (updated.nodes[0].kind !== 'image') throw new Error('Expected image node')
    expect(updated.nodes[0].annotations[0]).toMatchObject({ x: 0.25, y: 0.2, text: '12' })

    const removed = removeFreeCanvasImageAnnotation(updated, image.id, annotation.id)

    if (removed.nodes[0].kind !== 'image') throw new Error('Expected image node')
    expect(removed.nodes[0].annotations).toEqual([])
  })

  test('bulk replaces image annotations for isolated editor saves', () => {
    const image = createFreeCanvasImageNodeFromMedia(createFreeCanvasMediaNode('imageAsset', { x: 20, y: 40 }, 100), 101)
    const project = createFreeCanvasProject(100, { nodes: [{ ...image, annotations: undefined } as never] })

    const updated = replaceFreeCanvasImageAnnotations(project, image.id, [{
      id: 'draft-rect',
      kind: 'rect',
      x: 0.2,
      y: 0.15,
      width: 0.3,
      height: 0.2,
      color: '#111827',
      fill: '#ffffff',
      createdAt: 101,
      updatedAt: 102,
      meta: {}
    }], 103)

    if (updated.nodes[0].kind !== 'image') throw new Error('Expected image node')
    expect(updated.nodes[0].annotations).toEqual([
      expect.objectContaining({ id: 'draft-rect', kind: 'rect', x: 0.2, y: 0.15, fill: '#ffffff' })
    ])
  })

  test('preserves arrow endpoints and freehand paths when saving image annotations', () => {
    const image = createFreeCanvasImageNodeFromMedia(createFreeCanvasMediaNode('imageAsset', { x: 20, y: 40 }, 100), 101)
    const project = createFreeCanvasProject(100, { nodes: [image] })

    const updated = replaceFreeCanvasImageAnnotations(project, image.id, [
      {
        id: 'draft-arrow',
        kind: 'arrow',
        x: 0.1,
        y: 0.2,
        width: 0.5,
        height: 0.3,
        color: '#ef4423',
        points: [{ x: 0.1, y: 0.2 }, { x: 0.6, y: 0.5 }],
        createdAt: 101,
        updatedAt: 102,
        meta: {}
      },
      {
        id: 'draft-freehand',
        kind: 'freehand',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        color: '#ef4423',
        strokeWidth: 4,
        points: [{ x: 0.2, y: 0.7 }, { x: 0.3, y: 0.65 }, { x: 0.4, y: 0.68 }],
        createdAt: 101,
        updatedAt: 102,
        meta: {}
      }
    ], 103)

    if (updated.nodes[0].kind !== 'image') throw new Error('Expected image node')
    expect(updated.nodes[0].annotations).toEqual([
      expect.objectContaining({
        id: 'draft-arrow',
        kind: 'arrow',
        points: [{ x: 0.1, y: 0.2 }, { x: 0.6, y: 0.5 }]
      }),
      expect.objectContaining({
        id: 'draft-freehand',
        kind: 'freehand',
        points: [{ x: 0.2, y: 0.7 }, { x: 0.3, y: 0.65 }, { x: 0.4, y: 0.68 }]
      })
    ])
  })

  test('resizes image nodes without changing normalized annotation placement', () => {
    const image = createFreeCanvasImageNodeFromMedia(createFreeCanvasMediaNode('imageAsset', { x: 20, y: 40 }, 100), 101)
    const project = addFreeCanvasImageAnnotation(createFreeCanvasProject(100, { nodes: [image] }), image.id, 'rect', 102)

    const resized = updateFreeCanvasImageNodeFrame(project, image.id, {
      position: { x: 80, y: 120 },
      width: 640,
      height: 360
    })

    if (resized.nodes[0].kind !== 'image') throw new Error('Expected image node')
    expect(resized.nodes[0]).toMatchObject({
      position: { x: 80, y: 120 },
      width: 640,
      height: 360
    })
    expect(resized.nodes[0].annotations[0]).toMatchObject({ x: 0.08, y: 0.08, width: 0.28, height: 0.18 })
  })

  test('fits a mismatched image node frame to the intrinsic image content without moving the content', () => {
    const frame = fitFreeCanvasImageNodeFrameToContent({
      position: { x: 100, y: 80 },
      width: 400,
      height: 400,
      crop: null
    }, 1600, 900)

    expect(frame).toEqual({
      position: { x: 100, y: 167.5 },
      width: 400,
      height: 225
    })
  })

  test('creates quick text as red preset text and appends black user text', () => {
    const node = createQuickTextNode('Template message', { x: 20, y: 40 }, 100)
    const project = createFreeCanvasProject(100, { nodes: [node] })

    const updated = appendFreeCanvasUserText(project, node.id, 'User addition', 101)
    const textNode = updated.nodes[0]

    expect(textNode.kind).toBe('text')
    if (textNode.kind !== 'text') throw new Error('Expected text node')
    expect(textNode.segments).toEqual([
      expect.objectContaining({ source: 'preset', text: 'Template message', color: '#ef4423' }),
      expect.objectContaining({ source: 'user', text: 'User addition', color: '#111827' })
    ])
  })

  test('assigns stable TXT names and normalizes legacy Text titles', () => {
    const created = createFreeCanvasTextNode('Prompt', { x: 20, y: 40 }, 100)
    expect(created.title).toMatch(/^TXT-[A-Z0-9]{6}$/)

    const normalized = createFreeCanvasProject(101, {
      nodes: [{ ...created, id: 'free-text-stable-node', title: 'Text' }]
    })
    expect(normalized.nodes[0].title).toMatch(/^TXT-[A-Z0-9]{6}$/)
    expect(normalized.nodes[0].title).toBe(createFreeCanvasProject(102, normalized).nodes[0].title)
  })

  test('renames text nodes while rejecting duplicate and @ names', () => {
    const first = { ...createFreeCanvasTextNode('One', { x: 0, y: 0 }, 100), title: 'First' }
    const second = { ...createFreeCanvasTextNode('Two', { x: 0, y: 0 }, 101), title: 'Second' }
    const project = createFreeCanvasProject(102, { nodes: [first, second] })

    expect(renameFreeCanvasTextNode(project, first.id, 'Hero prompt').nodes[0].title).toBe('Hero prompt')
    expect(() => renameFreeCanvasTextNode(project, first.id, 'second')).toThrow('text_node_title_duplicate')
    expect(() => renameFreeCanvasTextNode(project, first.id, '@hero')).toThrow('text_node_title_invalid')
  })

  test('joins text node segments as visible plain text', () => {
    const node = createQuickTextNode('Template\nmessage', { x: 20, y: 40 }, 100)
    const project = appendFreeCanvasUserText(createFreeCanvasProject(100, { nodes: [node] }), node.id, '\nUser addition', 101)
    const textNode = project.nodes[0]

    if (textNode.kind !== 'text') throw new Error('Expected text node')
    expect(freeCanvasTextSegmentsToPlainText(textNode.segments)).toBe('Template\nmessage\nUser addition')
    expect(freeCanvasTextSegmentsToPlainText([])).toBe('')
  })

  test('agent-safe text updates only change user segments', () => {
    const node = createQuickTextNode('Locked template', { x: 20, y: 40 }, 100)
    const project = appendFreeCanvasUserText(createFreeCanvasProject(100, { nodes: [node] }), node.id, 'Draft', 101)

    const updated = updateFreeCanvasTextNodeUserText(project, node.id, 'Agent rewrite', 'replace', 102)

    if (updated.nodes[0].kind !== 'text') throw new Error('Expected text node')
    expect(updated.nodes[0].segments).toEqual([
      expect.objectContaining({ source: 'preset', text: 'Locked template' }),
      expect.objectContaining({ source: 'user', text: 'Agent rewrite' })
    ])
  })

  test('agent selection rewrite changes only the selected user range', () => {
    const node = createQuickTextNode('Locked template', { x: 20, y: 40 }, 100)
    const project = appendFreeCanvasUserText(createFreeCanvasProject(100, { nodes: [node] }), node.id, 'cold blue light', 101)

    const updated = replaceFreeCanvasUserTextRange(project, node.id, { start: 0, end: 4 }, 'warm', 102)

    if (updated.nodes[0].kind !== 'text') throw new Error('Expected text node')
    expect(updated.nodes[0].segments).toEqual([
      expect.objectContaining({ source: 'preset', text: 'Locked template' }),
      expect.objectContaining({ source: 'user', text: 'warm blue light' })
    ])
  })

  test('inserts black user text inside preset text and splits the preset segment', () => {
    const node = createQuickTextNode('Template', { x: 20, y: 40 }, 100)
    const project = createFreeCanvasProject(100, { nodes: [node] })

    const updated = replaceFreeCanvasTextRange(project, node.id, { start: 4, end: 4 }, ' user ', '#111827', 101)

    if (updated.nodes[0].kind !== 'text') throw new Error('Expected text node')
    expect(updated.nodes[0].segments).toEqual([
      expect.objectContaining({ source: 'preset', text: 'Temp', color: '#ef4423' }),
      expect.objectContaining({ source: 'user', text: ' user ', color: '#111827' }),
      expect.objectContaining({ source: 'preset', text: 'late', color: '#ef4423' })
    ])
  })

  test('manual range replacement can delete preset text', () => {
    const node = createQuickTextNode('Locked template', { x: 20, y: 40 }, 100)
    const project = createFreeCanvasProject(100, { nodes: [node] })

    const updated = replaceFreeCanvasTextRange(project, node.id, { start: 0, end: 7 }, '', '#111827', 101)

    if (updated.nodes[0].kind !== 'text') throw new Error('Expected text node')
    expect(updated.nodes[0].segments).toEqual([
      expect.objectContaining({ source: 'preset', text: 'template' })
    ])
  })

  test('manual range replacement merges adjacent user text', () => {
    const node = createQuickTextNode('Template', { x: 20, y: 40 }, 100)
    let project = createFreeCanvasProject(100, { nodes: [node] })
    project = replaceFreeCanvasTextRange(project, node.id, { start: 8, end: 8 }, ' one', '#111827', 101)

    const updated = replaceFreeCanvasTextRange(project, node.id, { start: 12, end: 12 }, ' two', '#111827', 102)

    if (updated.nodes[0].kind !== 'text') throw new Error('Expected text node')
    expect(updated.nodes[0].segments).toEqual([
      expect.objectContaining({ source: 'preset', text: 'Template' }),
      expect.objectContaining({ source: 'user', text: ' one two' })
    ])
  })

  test('text color style stores future user text color without changing preset text', () => {
    const node = createQuickTextNode('Template', { x: 20, y: 40 }, 100)
    const project = createFreeCanvasProject(100, { nodes: [node] })

    const updated = updateFreeCanvasTextNodeStyle(project, node.id, { color: '#3b82f6' })

    if (updated.nodes[0].kind !== 'text') throw new Error('Expected text node')
    expect(updated.nodes[0].meta.userTextColor).toBe('#3b82f6')
    expect(updated.nodes[0].segments).toEqual([
      expect.objectContaining({ source: 'preset', text: 'Template', color: '#ef4423' })
    ])
  })

  test('migrates legacy three-stage free canvas projects into text and media nodes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(500)
    let threeStage = createThreeStageProject(100)
    const graphNodeId = threeStageFormNodeId(threeStage.pages![0].items[0].form.id)
    threeStage = updateFreeCanvasNodePosition(threeStage, graphNodeId, { x: 321, y: 654 })
    const image = createFreeCanvasMediaNode('imageAsset', { x: 90, y: 120 }, 200)
    threeStage = addFreeCanvasMediaNode(threeStage, image)
    threeStage = addFreeCanvasEdge(threeStage, {
      id: 'edge-form-image',
      source: graphNodeId,
      target: mediaNodeFlowId(image.id)
    }, 300)

    const legacyProject: IPromptProject = {
      id: 'legacy-free-canvas',
      title: 'Legacy free canvas',
      type: 'three-stage',
      revision: 1,
      pages: [],
      currentPage: 0,
      threeStage,
      createdAt: 1,
      updatedAt: 2,
      lastOpenedAt: 3,
      meta: { builderTemplateId: 'free-canvas' }
    }

    const migrated = migrateLegacyThreeStageFreeCanvasProject(legacyProject)

    expect(migrated.type).toBe('free-canvas')
    expect(migrated.threeStage).toBeUndefined()
    expect(migrated.freeCanvas?.nodes.some(node => node.kind === 'text' && node.position.x === 321 && node.position.y === 654)).toBe(true)
    expect(migrated.freeCanvas?.nodes.some(node => node.kind === 'image' && node.position.x === 90 && node.position.y === 120)).toBe(true)
    expect(migrated.freeCanvas?.edges).toHaveLength(1)
  })
})
