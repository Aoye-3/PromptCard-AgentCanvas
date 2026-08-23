import { describe, expect, it } from 'vitest'
import type {
  IFreeCanvasImageNode,
  IFreeCanvasProject,
  IFreeCanvasTextNode
} from '@/models/PromptHistory.model'
import {
  applyCanvasLocalCommand,
  createCanvasCommandHistory,
  duplicateCanvasImageNode,
  executeCanvasLocalCommand,
  redoCanvasLocalCommand,
  undoCanvasLocalCommand
} from './canvas-command-history'

const imageNode = (id: string): IFreeCanvasImageNode => ({
  id,
  kind: 'image',
  title: id,
  position: { x: 0, y: 0 },
  width: 320,
  height: 240,
  assetId: `asset-${id}`,
  annotations: [],
  meta: {}
})

const textNode = (id: string): IFreeCanvasTextNode => ({
  id,
  kind: 'text',
  title: id,
  position: { x: 0, y: 0 },
  width: 320,
  height: 180,
  fontSize: 'large',
  segments: [],
  meta: {}
})

const project = (): IFreeCanvasProject => ({
  nodes: [imageNode('image-a'), textNode('text-b'), imageNode('image-c')],
  edges: [{
    id: 'edge-a-b',
    source: 'image-a',
    target: 'text-b',
    createdAt: 1
  }],
  viewport: null,
  selectedNodeId: 'image-a',
  meta: {}
})

describe('canvas command history', () => {
  it('duplicates an image without inheriting its Storage-owned CVM projection', () => {
    const source = {
      ...imageNode('image-a'),
      referenceCode: 'CVM-01ARZ3NDEKTSV4RRFFQ69G5FAX'
    }

    const duplicate = duplicateCanvasImageNode(source, 'image-copy')

    expect(source.referenceCode).toBe('CVM-01ARZ3NDEKTSV4RRFFQ69G5FAX')
    expect(duplicate.referenceCode).toBeUndefined()
    expect(duplicate.meta.duplicatedFromNodeId).toBe(source.id)
  })

  it('moves an image through the layer order without changing node data', () => {
    const result = applyCanvasLocalCommand(project(), {
      kind: 'reorder-node',
      nodeId: 'image-a',
      toIndex: 2
    })

    expect(result.project.nodes.map(node => node.id)).toEqual(['text-b', 'image-c', 'image-a'])
    expect(result.inverse).toEqual({ kind: 'reorder-node', nodeId: 'image-a', toIndex: 0 })
  })

  it('flips only an image presentation and can invert it', () => {
    const first = applyCanvasLocalCommand(project(), {
      kind: 'flip-image',
      nodeId: 'image-a',
      axis: 'horizontal'
    })
    const flipped = first.project.nodes[0] as IFreeCanvasImageNode

    expect(flipped.meta.presentation).toEqual({ flipX: true, flipY: false })
    expect(applyCanvasLocalCommand(first.project, first.inverse).project.nodes[0].meta.presentation)
      .toEqual({ flipX: false, flipY: false })
  })

  it('deletes nodes and incident edges, then restores them at their original indexes', () => {
    const first = applyCanvasLocalCommand(project(), {
      kind: 'delete-nodes',
      nodeIds: ['image-a']
    })

    expect(first.project.nodes.map(node => node.id)).toEqual(['text-b', 'image-c'])
    expect(first.project.edges).toEqual([])
    const restored = applyCanvasLocalCommand(first.project, first.inverse).project
    expect(restored.nodes.map(node => node.id)).toEqual(['image-a', 'text-b', 'image-c'])
    expect(restored.edges.map(edge => edge.id)).toEqual(['edge-a-b'])
  })

  it('undoes a local command without replacing unrelated asynchronous node updates', () => {
    const executed = executeCanvasLocalCommand(createCanvasCommandHistory(), project(), {
      kind: 'flip-image',
      nodeId: 'image-a',
      axis: 'horizontal'
    })
    const withAsyncResult: IFreeCanvasProject = {
      ...executed.project,
      nodes: executed.project.nodes.map(node => node.id === 'image-c'
        ? { ...node, assetId: 'asset-runtime-result', meta: { ...node.meta, generationState: 'succeeded' } }
        : node)
    }

    const undone = undoCanvasLocalCommand(executed.history, withAsyncResult)

    expect(undone.project.nodes.find(node => node.id === 'image-a')?.meta.presentation)
      .toEqual({ flipX: false, flipY: false })
    expect((undone.project.nodes.find(node => node.id === 'image-c') as IFreeCanvasImageNode).assetId)
      .toBe('asset-runtime-result')
  })

  it('supports redo after undo and clears redo after a new command', () => {
    const first = executeCanvasLocalCommand(createCanvasCommandHistory(), project(), {
      kind: 'flip-image',
      nodeId: 'image-a',
      axis: 'vertical'
    })
    const undone = undoCanvasLocalCommand(first.history, first.project)
    const redone = redoCanvasLocalCommand(undone.history, undone.project)

    expect(redone.project.nodes[0].meta.presentation).toEqual({ flipX: false, flipY: true })

    const replaced = executeCanvasLocalCommand(undone.history, undone.project, {
      kind: 'reorder-node',
      nodeId: 'image-a',
      toIndex: 2
    })
    expect(replaced.history.future).toEqual([])
  })
})
