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
  model: { connectionId: 'connection-1', providerId: 'provider-1', modelId: 'model-1', displayName: 'Model', capabilities: {} },
  skills: [{ skillId: 'skill-1', revision: 4, digest: `sha256:${'c'.repeat(64)}` }]
}

const createEdit = (): AgentStoryboardCreateEdit => ({
  kind: 'storyboard_create', id: 'edit-1', editId: 'edit-1', conversationId: 'conversation-1',
  requestId: 'request-1', nodeId: 'storyboard-1', expectedResultDigest: storyboardDigest(sequence(), []),
  base: { projectRevision: 12 }, payload: { title: 'Shot plan', sequence: sequence(), source: provenance },
  rationale: 'Explicit transform'
})

const aggregateSequence = (totalBytes: number): IStoryboardSequence => {
  const value = sequence()
  value.rows = Array.from({ length: 3 }, (_, index) => ({
    ...value.rows[0], id: `row-${index + 1}`, createdAt: index + 1, updatedAt: index + 1
  }))
  const targets: Array<[Record<string, unknown>, string]> = [
    ...(['name', 'description', 'style', 'constraints'] as const).map(field => [value as unknown as Record<string, unknown>, field] as [Record<string, unknown>, string]),
    ...value.rows.flatMap(row => (['cutLabel', 'timeRange', 'subject', 'action', 'scene', 'camera', 'lighting', 'audio', 'duration'] as const)
      .map(field => [row as unknown as Record<string, unknown>, field] as [Record<string, unknown>, string]))
  ]
  let remaining = totalBytes
  targets.forEach(([target, field]) => {
    const size = Math.min(10_000, remaining)
    target[field] = 'a'.repeat(size)
    remaining -= size
  })
  if (remaining !== 0) throw new Error('aggregate fixture too large')
  return value
}

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

  it.each([
    ['nine Skills', {
      ...provenance,
      skills: Array.from({ length: 9 }, (_, index) => ({
        skillId: `skill-${index + 1}`, revision: index + 1,
        digest: `sha256:${String(index + 1).repeat(64)}`
      }))
    }],
    ['a legacy three-key model', {
      ...provenance,
      model: { connectionId: 'connection-1', providerId: 'provider-1', modelId: 'model-1' }
    }],
    ['malformed model capabilities', {
      ...provenance, model: { ...provenance.model, capabilities: [] }
    }],
    ['a bad Document digest', { ...provenance, documentDigest: 'not-a-digest' }],
    ['duplicate Skills', { ...provenance, skills: [provenance.skills[0], provenance.skills[0]] }],
    ['an extraneous source key', { ...provenance, browserTrusted: true }]
  ])('rejects direct apply with non-canonical Storyboard source provenance: %s', (_label, source) => {
    const edit = createEdit()
    edit.payload = { ...edit.payload, source: source as typeof provenance }

    expect(() => createStoryboardNode(edit, { x: 0, y: 0 })).toThrow('storyboard_source_invalid')
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

  it('accepts the frozen aggregate byte boundary and rejects one byte over it', () => {
    const exactSequence = aggregateSequence(256_000)
    const exact = { ...createEdit(), expectedResultDigest: storyboardDigest(exactSequence, []) }
    exact.payload = { ...exact.payload, sequence: exactSequence }
    const overSequence = aggregateSequence(256_001)
    const over = { ...createEdit(), expectedResultDigest: storyboardDigest(overSequence, []) }
    over.payload = { ...over.payload, sequence: overSequence }

    expect(createStoryboardNode(exact, { x: 0, y: 0 }).digest).toBe(exact.expectedResultDigest)
    expect(() => createStoryboardNode(over, { x: 0, y: 0 })).toThrow('storyboard_sequence_invalid')
  })
})
