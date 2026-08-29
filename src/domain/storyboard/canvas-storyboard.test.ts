import { describe, expect, it } from 'vitest'
import type { AgentStoryboardChangesEdit, AgentStoryboardCreateEdit } from '@/models/Agent.model'
import type { IFreeCanvasStoryboardNode, IStoryboardSequence } from '@/models/PromptHistory.model'
import { applyStoryboardChanges, createStoryboardNode, resolveStoryboardFieldChanges, storyboardDigest } from './canvas-storyboard'

const sequence = (): IStoryboardSequence => ({
  id: 'sequence-1', name: 'Opening', description: 'The effective draft.', style: 'ink', constraints: 'No captions',
  rows: [{ id: 'row-1', cutLabel: '1', timeRange: '00:00-00:03', subject: 'Mara', action: 'opens the door', scene: 'hallway', camera: 'wide', lighting: 'dawn', audio: 'hinge', duration: '3s', createdAt: 10, updatedAt: 10 }],
  createdAt: 10, updatedAt: 10, meta: {}
})

const provenance = {
  documentNodeId: 'document-1', documentRevision: 7, documentDigest: `sha256:${'a'.repeat(64)}`,
  documentResourceDigests: [`sha256:${'b'.repeat(64)}`],
  model: { connectionId: 'connection-1', providerId: 'provider-1', modelId: 'model-1' },
  skills: [{ skillId: 'skill-1', revision: 4, digest: `sha256:${'c'.repeat(64)}` }]
}

const createEdit = (): AgentStoryboardCreateEdit => ({
  kind: 'storyboard_create', id: 'edit-1', editId: 'edit-1', conversationId: 'conversation-1',
  requestId: 'request-1', nodeId: 'storyboard-1', expectedResultDigest: storyboardDigest(sequence(), []),
  base: { projectRevision: 12 }, payload: { title: 'Shot plan', sequence: sequence(), source: provenance },
  rationale: 'Explicit transform'
})

describe('Canvas Storyboard direct edits', () => {
  it('creates the deterministic Storyboard with exact authoritative source provenance', () => {
    const edit = createEdit()
    const node = createStoryboardNode(edit, { x: 40, y: 80 })

    expect(node).toMatchObject({
      id: 'storyboard-1', kind: 'storyboard', title: 'Shot plan', revision: 0,
      digest: edit.expectedResultDigest, sequence: edit.payload.sequence, source: provenance,
      pendingFieldChanges: [],
      agentAppliedEdit: { conversationId: 'conversation-1', requestId: 'request-1', editId: 'edit-1', resultDigest: edit.expectedResultDigest }
    })
  })

  it('keeps later sequence and row edits as reviewable differences and rejects stale bases', () => {
    const initial = createStoryboardNode(createEdit(), { x: 0, y: 0 })
    const changes: AgentStoryboardChangesEdit = {
      kind: 'storyboard_changes', id: 'edit-2', editId: 'edit-2', conversationId: 'conversation-1',
      requestId: 'request-2', nodeId: initial.id, expectedResultDigest: '',
      base: { projectRevision: 13, nodeRevision: initial.revision!, nodeDigest: initial.digest! },
      payload: { changes: [
        { scope: 'sequence', field: 'style', value: 'watercolour' },
        { scope: 'row', rowId: 'row-1', field: 'camera', value: 'close-up' }
      ] }, rationale: 'Refine the shots'
    }
    changes.expectedResultDigest = storyboardDigest(initial.sequence, [
      { id: 'sbf-edit-2-0', editId: 'edit-2', scope: 'sequence', field: 'style', previousValue: 'ink', newValue: 'watercolour' },
      { id: 'sbf-edit-2-1', editId: 'edit-2', scope: 'row', rowId: 'row-1', field: 'camera', previousValue: 'wide', newValue: 'close-up' }
    ])

    const pending = applyStoryboardChanges(initial, changes)
    expect(pending.pendingFieldChanges).toHaveLength(2)
    expect(pending.sequence.style).toBe('ink')
    expect(() => applyStoryboardChanges({ ...initial, revision: 1 }, changes)).toThrow('storyboard_edit_stale')

    const acceptedOne = resolveStoryboardFieldChanges(pending, ['sbf-edit-2-0'], 'accept')
    expect(acceptedOne.sequence.style).toBe('watercolour')
    expect(acceptedOne.sequence.rows[0].camera).toBe('wide')
    expect(acceptedOne.pendingFieldChanges).toHaveLength(1)

    const rejectedRest = resolveStoryboardFieldChanges(acceptedOne, 'all', 'reject')
    expect(rejectedRest.sequence.rows[0].camera).toBe('wide')
    expect(rejectedRest.pendingFieldChanges).toEqual([])
  })

  it('does not accept fields outside the closed Storyboard sequence/row allow-list', () => {
    const node = createStoryboardNode(createEdit(), { x: 0, y: 0 }) satisfies IFreeCanvasStoryboardNode
    const invalid = {
      kind: 'storyboard_changes', id: 'edit-2', editId: 'edit-2', conversationId: 'conversation-1',
      requestId: 'request-2', nodeId: node.id, expectedResultDigest: `sha256:${'d'.repeat(64)}`,
      base: { projectRevision: 2, nodeRevision: node.revision, nodeDigest: node.digest },
      payload: { changes: [{ scope: 'row', rowId: 'row-1', field: 'imageUrl', value: 'secret' }] }, rationale: ''
    } as unknown as AgentStoryboardChangesEdit

    expect(() => applyStoryboardChanges(node, invalid)).toThrow('storyboard_field_invalid')
  })
})
