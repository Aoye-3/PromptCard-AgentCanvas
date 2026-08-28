import { describe, expect, it } from 'vitest'
import type {
  IFreeCanvasDocumentNode,
  IFreeCanvasImageNode,
  IFreeCanvasProject,
  IFreeCanvasTextNode
} from '@/models/PromptHistory.model'
import {
  applyCanvasLocalCommand,
  canvasHistoryEntryDocumentNodeIds,
  createCanvasCommandHistory,
  discardCanvasCommandHistoryEntry,
  duplicateCanvasImageNode,
  executeCanvasLocalCommand,
  recoverFailedCanvasHistoryStep,
  redoCanvasLocalCommand,
  undoCanvasLocalCommand
} from './canvas-command-history'
import type { CanvasLocalCommand } from './canvas-command-history'
import { createPlanningDocumentV1, planningDocumentEffectiveText } from '@/domain/documents/planning-document'

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

const documentNode = (id: string, text = 'Before'): IFreeCanvasDocumentNode => ({
  id,
  kind: 'document',
  title: id,
  position: { x: 0, y: 0 },
  width: 560,
  height: 420,
  document: createPlanningDocumentV1([{ id: `${id}-paragraph`, type: 'paragraph', content: [{ text }] }]),
  linkedDocumentResourceIds: [],
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
  it.each([
    {
      label: 'Document',
      projectNodes: [documentNode('shared-id')],
      insertedNode: documentNode('shared-id', 'Replacement')
    },
    {
      label: 'other-kind',
      projectNodes: [textNode('shared-id')],
      insertedNode: documentNode('shared-id', 'Replacement')
    },
    {
      label: 'malformed existing duplicates',
      projectNodes: [documentNode('shared-id'), textNode('shared-id')],
      insertedNode: documentNode('shared-id', 'Replacement')
    }
  ])('rejects insert-node before mutation when the id collides with $label authority', ({ projectNodes, insertedNode }) => {
    const canvas = { ...project(), nodes: projectNodes }
    const command: CanvasLocalCommand = { kind: 'insert-node', node: insertedNode, index: 0 }

    const result = applyCanvasLocalCommand(canvas, command)
    const history = createCanvasCommandHistory()
    const executed = executeCanvasLocalCommand(history, canvas, command)

    expect(result.project).toBe(canvas)
    expect(result.inverse).toEqual(command)
    expect(executed).toEqual({ project: canvas, history })
  })

  it.each([
    {
      label: 'an existing Document',
      projectNodes: [documentNode('shared-id')],
      restoredNodes: [{ index: 0, node: textNode('shared-id') }]
    },
    {
      label: 'an existing other-kind node',
      projectNodes: [textNode('shared-id')],
      restoredNodes: [{ index: 0, node: documentNode('shared-id') }]
    },
    {
      label: 'duplicate ids inside the restore payload',
      projectNodes: [],
      restoredNodes: [
        { index: 0, node: documentNode('shared-id') },
        { index: 1, node: textNode('shared-id') }
      ]
    }
  ])('rejects restore-nodes before mutation when it would introduce $label', ({ projectNodes, restoredNodes }) => {
    const canvas = { ...project(), nodes: projectNodes }
    const command: CanvasLocalCommand = {
      kind: 'restore-nodes',
      nodes: restoredNodes,
      edges: [],
      selectedNodeId: null
    }

    const result = applyCanvasLocalCommand(canvas, command)
    const history = createCanvasCommandHistory()
    const executed = executeCanvasLocalCommand(history, canvas, command)

    expect(result.project).toBe(canvas)
    expect(result.inverse).toEqual(command)
    expect(executed).toEqual({ project: canvas, history })
  })

  it.each([
    {
      label: 'an existing edge id',
      edges: [{ index: 0, edge: { id: 'edge-a-b', source: 'shared-id', target: 'text-b', createdAt: 2 } }]
    },
    {
      label: 'duplicate edge ids inside the payload',
      edges: [
        { index: 0, edge: { id: 'edge-new', source: 'shared-id', target: 'text-b', createdAt: 2 } },
        { index: 1, edge: { id: 'edge-new', source: 'image-a', target: 'shared-id', createdAt: 3 } }
      ]
    },
    {
      label: 'a dangling source',
      edges: [{ index: 0, edge: { id: 'edge-new', source: 'missing-node', target: 'shared-id', createdAt: 2 } }]
    },
    {
      label: 'a dangling target',
      edges: [{ index: 0, edge: { id: 'edge-new', source: 'shared-id', target: 'missing-node', createdAt: 2 } }]
    }
  ])('rejects restore-nodes atomically when its edges contain $label', ({ edges }) => {
    const canvas = project()
    const command: CanvasLocalCommand = {
      kind: 'restore-nodes',
      nodes: [{ index: 1, node: documentNode('shared-id') }],
      edges,
      selectedNodeId: 'shared-id'
    }

    const result = applyCanvasLocalCommand(canvas, command)
    const history = createCanvasCommandHistory()
    const executed = executeCanvasLocalCommand(history, canvas, command)

    expect(result.project).toBe(canvas)
    expect(result.inverse).toEqual(command)
    expect(executed).toEqual({ project: canvas, history })
  })

  it('records detached reorder, flip, and delete command snapshots', () => {
    const reorder: Extract<CanvasLocalCommand, { kind: 'reorder-node' }> = {
      kind: 'reorder-node', nodeId: 'image-a', toIndex: 2
    }
    const reordered = executeCanvasLocalCommand(createCanvasCommandHistory(), project(), reorder)
    reorder.nodeId = 'mutated-node'
    reorder.toIndex = 99
    expect(reordered.history.past[0].redo).toEqual({
      kind: 'reorder-node', nodeId: 'image-a', toIndex: 2
    })

    const flip: Extract<CanvasLocalCommand, { kind: 'flip-image' }> = {
      kind: 'flip-image', nodeId: 'image-a', axis: 'horizontal'
    }
    const flipped = executeCanvasLocalCommand(createCanvasCommandHistory(), project(), flip)
    flip.nodeId = 'mutated-node'
    flip.axis = 'vertical'
    expect(flipped.history.past[0]).toMatchObject({
      undo: { kind: 'flip-image', nodeId: 'image-a', axis: 'horizontal' },
      redo: { kind: 'flip-image', nodeId: 'image-a', axis: 'horizontal' }
    })

    const source = project()
    source.nodes[0].meta = { nested: { label: 'before' } }
    source.edges[0].label = 'before edge'
    const deletion: Extract<CanvasLocalCommand, { kind: 'delete-nodes' }> = {
      kind: 'delete-nodes', nodeIds: ['image-a']
    }
    const deleted = executeCanvasLocalCommand(createCanvasCommandHistory(), source, deletion)
    deletion.nodeIds[0] = 'mutated-node'
    ;(source.nodes[0].meta.nested as { label: string }).label = 'mutated'
    source.edges[0].label = 'mutated edge'
    expect(deleted.history.past[0].redo).toEqual({ kind: 'delete-nodes', nodeIds: ['image-a'] })
    expect(deleted.history.past[0].undo).toMatchObject({
      kind: 'restore-nodes',
      nodes: [{ node: { id: 'image-a', meta: { nested: { label: 'before' } } } }],
      edges: [{ edge: { id: 'edge-a-b', label: 'before edge' } }]
    })
  })

  it('deeply snapshots inserted and updated Document commands after execution', () => {
    const insertedNode = structuredClone(documentNode('document-new', 'Inserted'))
    insertedNode.meta = { nested: { label: 'before' } }
    const insert: Extract<CanvasLocalCommand, { kind: 'insert-node' }> = {
      kind: 'insert-node', node: insertedNode, index: 1
    }
    const inserted = executeCanvasLocalCommand(createCanvasCommandHistory(), project(), insert)
    const insertedDigest = insertedNode.document.digest
    const insertedBlock = insertedNode.document.blocks[0]
    if (insertedBlock.type !== 'paragraph') throw new Error('Expected paragraph fixture')
    insertedBlock.content[0].text = 'Mutated inserted content'
    insertedNode.document.digest = 'sha256:mutated'
    ;(insertedNode.meta.nested as { label: string }).label = 'mutated'
    insertedNode.position.x = 999

    const recordedInsert = inserted.history.past[0].redo
    expect(recordedInsert.kind).toBe('insert-node')
    if (recordedInsert.kind !== 'insert-node' || recordedInsert.node.kind !== 'document') {
      throw new Error('Expected recorded Document insert')
    }
    expect(planningDocumentEffectiveText(recordedInsert.node.document)).toBe('Inserted')
    expect(recordedInsert.node.document.digest).toBe(insertedDigest)
    expect(recordedInsert.node.meta).toEqual({ nested: { label: 'before' } })
    expect(recordedInsert.node.position.x).toBe(0)

    const updatedDocument = structuredClone(documentNode('document-update', 'After').document)
    const update: Extract<CanvasLocalCommand, { kind: 'update-document' }> = {
      kind: 'update-document', nodeId: 'document-update', document: updatedDocument
    }
    const updateCanvas = { ...project(), nodes: [documentNode('document-update', 'Before')] }
    const updated = executeCanvasLocalCommand(createCanvasCommandHistory(), updateCanvas, update)
    const updatedDigest = updatedDocument.digest
    const updatedBlock = updatedDocument.blocks[0]
    if (updatedBlock.type !== 'paragraph') throw new Error('Expected paragraph fixture')
    updatedBlock.content[0].text = 'Mutated updated content'
    updatedDocument.digest = 'sha256:mutated'
    const recordedUpdate = updated.history.past[0].redo
    expect(recordedUpdate.kind).toBe('update-document')
    if (recordedUpdate.kind !== 'update-document') throw new Error('Expected recorded Document update')
    expect(planningDocumentEffectiveText(recordedUpdate.document)).toBe('After')
    expect(recordedUpdate.document.digest).toBe(updatedDigest)
  })

  it('deeply preserves the top-level Agent edit marker in Document command snapshots', () => {
    const source = documentNode('document-marker', 'Before')
    source.agentAppliedEdit = {
      conversationId: 'conversation-1',
      requestId: 'request-1',
      editId: 'edit-1',
      resultDigest: source.document.digest
    }
    const canvas = { ...project(), nodes: [source] }

    const inserted = executeCanvasLocalCommand(createCanvasCommandHistory(), project(), {
      kind: 'insert-node', node: source, index: 0
    })
    const recordedInsert = inserted.history.past[0].redo
    if (recordedInsert.kind !== 'insert-node' || recordedInsert.node.kind !== 'document') {
      throw new Error('Expected recorded Document insert')
    }
    expect(recordedInsert.node.agentAppliedEdit).toEqual(source.agentAppliedEdit)
    expect(recordedInsert.node.agentAppliedEdit).not.toBe(source.agentAppliedEdit)

    const updated = applyCanvasLocalCommand(canvas, {
      kind: 'update-document',
      nodeId: source.id,
      document: createPlanningDocumentV1([{
        id: 'document-marker-paragraph', type: 'paragraph', content: [{ text: 'After' }]
      }], 1)
    }).project.nodes[0]
    if (updated.kind !== 'document') throw new Error('Expected updated Document')
    expect(updated.agentAppliedEdit).toEqual(source.agentAppliedEdit)
    expect(updated.agentAppliedEdit).not.toBe(source.agentAppliedEdit)
  })

  it('applies restore from detached node and edge snapshots without retaining caller payload refs', () => {
    const restoredNode = structuredClone(documentNode('document-restored', 'Restored'))
    restoredNode.meta = { nested: { label: 'before' } }
    const restoredEdge = {
      id: 'edge-restored', source: 'document-restored', target: 'text-b', label: 'before edge', createdAt: 2
    }
    const restore: Extract<CanvasLocalCommand, { kind: 'restore-nodes' }> = {
      kind: 'restore-nodes',
      nodes: [{ index: 1, node: restoredNode }],
      edges: [{ index: 1, edge: restoredEdge }],
      selectedNodeId: 'document-restored'
    }
    const restored = executeCanvasLocalCommand(createCanvasCommandHistory(), project(), restore)
    const restoredDigest = restoredNode.document.digest
    const restoredBlock = restoredNode.document.blocks[0]
    if (restoredBlock.type !== 'paragraph') throw new Error('Expected paragraph fixture')
    restoredBlock.content[0].text = 'Mutated restored content'
    restoredNode.document.digest = 'sha256:mutated'
    ;(restoredNode.meta.nested as { label: string }).label = 'mutated'
    restoredEdge.label = 'mutated edge'
    restore.nodes[0].index = 99
    restore.edges[0].index = 99

    const appliedNode = restored.project.nodes.find(node => node.id === 'document-restored')
    expect(appliedNode?.kind).toBe('document')
    if (!appliedNode || appliedNode.kind !== 'document') throw new Error('Expected restored Document')
    expect(planningDocumentEffectiveText(appliedNode.document)).toBe('Restored')
    expect(appliedNode.document.digest).toBe(restoredDigest)
    expect(appliedNode.meta).toEqual({ nested: { label: 'before' } })
    expect(restored.project.edges.find(edge => edge.id === 'edge-restored')?.label).toBe('before edge')

    const recordedRestore = restored.history.past[0].redo
    expect(recordedRestore.kind).toBe('restore-nodes')
    if (recordedRestore.kind !== 'restore-nodes') throw new Error('Expected recorded restore')
    expect(recordedRestore.nodes[0].index).toBe(1)
    expect(recordedRestore.edges[0]).toMatchObject({
      index: 1,
      edge: { id: 'edge-restored', label: 'before edge' }
    })
  })

  it('collects deterministic affected Document ids from update, insert, restore, and paired delete commands', () => {
    expect(canvasHistoryEntryDocumentNodeIds({
      undo: { kind: 'update-document', nodeId: 'document-b', document: documentNode('document-b').document },
      redo: { kind: 'update-document', nodeId: 'document-b', document: documentNode('document-b', 'After').document }
    })).toEqual(['document-b'])

    expect(canvasHistoryEntryDocumentNodeIds({
      undo: { kind: 'delete-nodes', nodeIds: ['image-a', 'document-a'] },
      redo: { kind: 'insert-node', node: documentNode('document-a'), index: 1 }
    })).toEqual(['document-a'])

    expect(canvasHistoryEntryDocumentNodeIds({
      undo: {
        kind: 'restore-nodes',
        nodes: [
          { index: 2, node: documentNode('document-c') },
          { index: 1, node: imageNode('image-a') },
          { index: 0, node: documentNode('document-a') }
        ],
        edges: [],
        selectedNodeId: null
      },
      redo: { kind: 'delete-nodes', nodeIds: ['document-c', 'image-a', 'document-a'] }
    })).toEqual(['document-a', 'document-c'])
  })

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

  it('applies a deeply cloned Document update and returns a deeply cloned inverse', () => {
    const source = documentNode('document-a')
    const nextDocument = createPlanningDocumentV1([
      { id: 'document-a-paragraph', type: 'paragraph', content: [{ text: 'After', bold: true }] }
    ], 1)
    const canvas: IFreeCanvasProject = { ...project(), nodes: [source, ...project().nodes] }

    const applied = applyCanvasLocalCommand(canvas, {
      kind: 'update-document',
      nodeId: source.id,
      document: nextDocument
    })
    nextDocument.blocks[0].id = 'mutated-caller-id'

    const updatedNode = applied.project.nodes[0] as IFreeCanvasDocumentNode
    expect(planningDocumentEffectiveText(updatedNode.document)).toBe('After')
    expect(updatedNode.document.blocks[0].id).toBe('document-a-paragraph')
    expect(applied.inverse).toMatchObject({
      kind: 'update-document',
      nodeId: source.id,
      document: source.document
    })
    expect((applied.inverse as { document: unknown }).document).not.toBe(source.document)
  })

  it('undoes and redoes a Document update without replacing unrelated asynchronous node changes', () => {
    const source = documentNode('document-a')
    const canvas: IFreeCanvasProject = { ...project(), nodes: [source, ...project().nodes] }
    const nextDocument = createPlanningDocumentV1([
      { id: 'document-a-paragraph', type: 'paragraph', content: [{ text: 'After' }] }
    ], 1)
    const executed = executeCanvasLocalCommand(createCanvasCommandHistory(), canvas, {
      kind: 'update-document',
      nodeId: source.id,
      document: nextDocument
    })
    nextDocument.blocks[0].id = 'mutated-after-execute'
    const withAsyncResult: IFreeCanvasProject = {
      ...executed.project,
      nodes: executed.project.nodes.map(node => node.id === 'image-c'
        ? { ...node, assetId: 'asset-runtime-result', meta: { ...node.meta, generationState: 'succeeded' } }
        : node)
    }

    const undone = undoCanvasLocalCommand(executed.history, withAsyncResult)
    const redone = redoCanvasLocalCommand(undone.history, undone.project)

    const undoneDocument = undone.project.nodes.find(node => node.id === source.id) as IFreeCanvasDocumentNode
    const redoneDocument = redone.project.nodes.find(node => node.id === source.id) as IFreeCanvasDocumentNode
    expect(planningDocumentEffectiveText(undoneDocument.document)).toBe('Before')
    expect(planningDocumentEffectiveText(redoneDocument.document)).toBe('After')
    expect(redoneDocument.document.blocks[0].id).toBe('document-a-paragraph')
    expect((redone.project.nodes.find(node => node.id === 'image-c') as IFreeCanvasImageNode).assetId)
      .toBe('asset-runtime-result')
  })

  it('does not update a missing or non-Document target', () => {
    const canvas = project()
    const document = createPlanningDocumentV1([
      { id: 'paragraph-empty', type: 'paragraph', content: [] }
    ])

    expect(applyCanvasLocalCommand(canvas, { kind: 'update-document', nodeId: 'missing', document }).project).toBe(canvas)
    expect(applyCanvasLocalCommand(canvas, { kind: 'update-document', nodeId: 'text-b', document }).project).toBe(canvas)
  })

  it('discards only a failed Document entry while preserving a later image command', () => {
    const source = documentNode('document-a')
    const canvas: IFreeCanvasProject = { ...project(), nodes: [source, ...project().nodes] }
    const documentCommand = executeCanvasLocalCommand(createCanvasCommandHistory(), canvas, {
      kind: 'update-document',
      nodeId: source.id,
      document: createPlanningDocumentV1([{ id: 'document-a-paragraph', type: 'paragraph', content: [{ text: 'After' }] }])
    })
    const imageCommand = executeCanvasLocalCommand(documentCommand.history, documentCommand.project, {
      kind: 'flip-image', nodeId: 'image-a', axis: 'horizontal'
    })
    const failedEntry = documentCommand.history.past[0]

    const recovered = discardCanvasCommandHistoryEntry(imageCommand.history, failedEntry)
    const undone = undoCanvasLocalCommand(recovered, imageCommand.project)
    const redone = redoCanvasLocalCommand(undone.history, undone.project)

    expect(recovered.past).toEqual([imageCommand.history.past[1]])
    expect(undone.project.nodes.find(node => node.id === 'image-a')?.meta.presentation)
      .toEqual({ flipX: false, flipY: false })
    expect(redone.project.nodes.find(node => node.id === 'image-a')?.meta.presentation)
      .toEqual({ flipX: true, flipY: false })
  })

  it('restores a failed undo before a later image command so the later command remains undoable and redoable', () => {
    const first = executeCanvasLocalCommand(createCanvasCommandHistory(), project(), {
      kind: 'reorder-node', nodeId: 'image-a', toIndex: 2
    })
    const targetEntry = first.history.past[0]
    const appliedUndo = undoCanvasLocalCommand(first.history, first.project)
    const later = executeCanvasLocalCommand(appliedUndo.history, appliedUndo.project, {
      kind: 'flip-image', nodeId: 'image-c', axis: 'vertical'
    })

    const recovered = recoverFailedCanvasHistoryStep(later.history, first.history, targetEntry, 'undo')
    const undoneLater = undoCanvasLocalCommand(recovered, later.project)
    const redoneLater = redoCanvasLocalCommand(undoneLater.history, undoneLater.project)

    expect(recovered.past).toEqual([targetEntry, later.history.past[0]])
    expect((undoneLater.project.nodes.find(node => node.id === 'image-c') as IFreeCanvasImageNode).meta.presentation)
      .toEqual({ flipX: false, flipY: false })
    expect((redoneLater.project.nodes.find(node => node.id === 'image-c') as IFreeCanvasImageNode).meta.presentation)
      .toEqual({ flipX: false, flipY: true })
  })

  it('removes a failed redo without dropping a later image command or inventing a stale future', () => {
    const first = executeCanvasLocalCommand(createCanvasCommandHistory(), project(), {
      kind: 'reorder-node', nodeId: 'image-a', toIndex: 2
    })
    const undone = undoCanvasLocalCommand(first.history, first.project)
    const targetEntry = undone.history.future[0]
    const appliedRedo = redoCanvasLocalCommand(undone.history, undone.project)
    const later = executeCanvasLocalCommand(appliedRedo.history, appliedRedo.project, {
      kind: 'flip-image', nodeId: 'image-c', axis: 'vertical'
    })

    const recovered = recoverFailedCanvasHistoryStep(later.history, undone.history, targetEntry, 'redo')
    const undoneLater = undoCanvasLocalCommand(recovered, later.project)
    const redoneLater = redoCanvasLocalCommand(undoneLater.history, undoneLater.project)

    expect(recovered.past).toEqual([later.history.past[1]])
    expect(recovered.future).toEqual([])
    expect((undoneLater.project.nodes.find(node => node.id === 'image-c') as IFreeCanvasImageNode).meta.presentation)
      .toEqual({ flipX: false, flipY: false })
    expect((redoneLater.project.nodes.find(node => node.id === 'image-c') as IFreeCanvasImageNode).meta.presentation)
      .toEqual({ flipX: false, flipY: true })
  })
})
