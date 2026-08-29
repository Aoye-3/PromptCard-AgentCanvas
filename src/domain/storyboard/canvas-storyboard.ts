import type { AgentStoryboardChangesEdit, AgentStoryboardCreateEdit } from '@/models/Agent.model'
import type {
  IFreeCanvasPosition,
  IFreeCanvasStoryboardNode,
  IStoryboardRow,
  IStoryboardSequence,
  StoryboardFieldChange,
  StoryboardRowField,
  StoryboardSequenceField
} from '@/models/PromptHistory.model'
import { sha256Utf8 } from '@/domain/documents/planning-document'

export const STORYBOARD_SEQUENCE_FIELDS: readonly StoryboardSequenceField[] = [
  'name', 'description', 'style', 'constraints'
]
export const STORYBOARD_ROW_FIELDS: readonly StoryboardRowField[] = [
  'cutLabel', 'timeRange', 'subject', 'action', 'scene', 'camera', 'lighting', 'audio', 'duration'
]

const canonicalJson = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

const canonicalSequence = (sequence: IStoryboardSequence) => ({
  id: sequence.id,
  name: sequence.name,
  description: sequence.description,
  style: sequence.style,
  constraints: sequence.constraints,
  rows: sequence.rows.map(row => ({
    id: row.id,
    cutLabel: row.cutLabel,
    timeRange: row.timeRange,
    subject: row.subject,
    action: row.action,
    scene: row.scene,
    camera: row.camera,
    lighting: row.lighting || '',
    audio: row.audio || '',
    duration: row.duration
  }))
})

export const storyboardDigest = (
  sequence: IStoryboardSequence,
  pendingFieldChanges: readonly StoryboardFieldChange[]
): string => `sha256:${sha256Utf8(canonicalJson({
  sequence: canonicalSequence(sequence),
  pendingFieldChanges
}))}`

const cloneSequence = (sequence: IStoryboardSequence): IStoryboardSequence => structuredClone(sequence)

const assertSequence = (sequence: IStoryboardSequence) => {
  if (!sequence || !sequence.id || sequence.rows.length > 200) throw new Error('storyboard_sequence_invalid')
  const values = [sequence.name, sequence.description, sequence.style, sequence.constraints]
  const rowIds = new Set<string>()
  sequence.rows.forEach(row => {
    if (!row.id || rowIds.has(row.id)) throw new Error('storyboard_sequence_invalid')
    rowIds.add(row.id)
    values.push(row.cutLabel, row.timeRange, row.subject, row.action, row.scene, row.camera, row.lighting || '', row.audio || '', row.duration)
  })
  if (values.some(value => typeof value !== 'string' || value.length > 10_000)) throw new Error('storyboard_sequence_invalid')
  if (new TextEncoder().encode(values.join('')).length > 256_000) throw new Error('storyboard_sequence_invalid')
}

export const createStoryboardNode = (
  edit: AgentStoryboardCreateEdit,
  position: IFreeCanvasPosition
): IFreeCanvasStoryboardNode => {
  assertSequence(edit.payload.sequence)
  const sequence = cloneSequence(edit.payload.sequence)
  const digest = storyboardDigest(sequence, [])
  if (digest !== edit.expectedResultDigest) throw new Error('storyboard_result_digest_mismatch')
  return {
    id: edit.nodeId,
    kind: 'storyboard',
    title: edit.payload.title.normalize('NFC').trim() || 'Storyboard',
    position: { ...position },
    width: 680,
    height: 440,
    sequence,
    source: structuredClone(edit.payload.source),
    pendingFieldChanges: [],
    revision: 0,
    digest,
    agentAppliedEdit: {
      conversationId: edit.conversationId,
      requestId: edit.requestId,
      editId: edit.editId,
      resultDigest: edit.expectedResultDigest
    },
    meta: {}
  }
}

export const applyStoryboardChanges = (
  node: IFreeCanvasStoryboardNode,
  edit: AgentStoryboardChangesEdit
): IFreeCanvasStoryboardNode => {
  const revision = node.revision ?? 0
  const digest = node.digest ?? storyboardDigest(node.sequence, node.pendingFieldChanges)
  if (edit.nodeId !== node.id || edit.base.nodeRevision !== revision || edit.base.nodeDigest !== digest) {
    throw new Error('storyboard_edit_stale')
  }
  if (node.pendingFieldChanges.length) throw new Error('storyboard_review_pending')
  const pendingFieldChanges = edit.payload.changes.map((change, index): StoryboardFieldChange => {
    const id = `sbf-${edit.editId}-${index}`
    const newValue = normalizedFieldValue(change.value)
    if (change.scope === 'sequence') {
      if (!STORYBOARD_SEQUENCE_FIELDS.includes(change.field)) throw new Error('storyboard_field_invalid')
      return { id, editId: edit.editId, scope: 'sequence', field: change.field, previousValue: node.sequence[change.field], newValue }
    }
    if (!STORYBOARD_ROW_FIELDS.includes(change.field)) throw new Error('storyboard_field_invalid')
    const row = node.sequence.rows.find(candidate => candidate.id === change.rowId)
    if (!row) throw new Error('storyboard_row_missing')
    return { id, editId: edit.editId, scope: 'row', rowId: row.id, field: change.field, previousValue: row[change.field] || '', newValue }
  })
  if (!pendingFieldChanges.length || new Set(pendingFieldChanges.map(change => `${change.scope}:${change.scope === 'row' ? change.rowId : ''}:${change.field}`)).size !== pendingFieldChanges.length) {
    throw new Error('storyboard_changes_invalid')
  }
  const resultDigest = storyboardDigest(node.sequence, pendingFieldChanges)
  if (resultDigest !== edit.expectedResultDigest) throw new Error('storyboard_result_digest_mismatch')
  return {
    ...node,
    pendingFieldChanges,
    revision: revision + 1,
    digest: resultDigest,
    agentAppliedEdit: {
      conversationId: edit.conversationId,
      requestId: edit.requestId,
      editId: edit.editId,
      resultDigest: edit.expectedResultDigest
    }
  }
}

export const resolveStoryboardFieldChanges = (
  node: IFreeCanvasStoryboardNode,
  ids: readonly string[] | 'all',
  action: 'accept' | 'reject'
): IFreeCanvasStoryboardNode => {
  const selected = ids === 'all' ? new Set(node.pendingFieldChanges.map(change => change.id)) : new Set(ids)
  if (!selected.size || [...selected].some(id => !node.pendingFieldChanges.some(change => change.id === id))) {
    throw new Error('storyboard_change_missing')
  }
  const sequence = cloneSequence(node.sequence)
  if (action === 'accept') {
    node.pendingFieldChanges.filter(change => selected.has(change.id)).forEach(change => {
      if (change.scope === 'sequence') sequence[change.field] = change.newValue
      else {
        const row = sequence.rows.find(candidate => candidate.id === change.rowId)
        if (!row) throw new Error('storyboard_row_missing')
        setRowField(row, change.field, change.newValue)
      }
    })
  }
  const pendingFieldChanges = node.pendingFieldChanges.filter(change => !selected.has(change.id))
  const revision = (node.revision ?? 0) + 1
  return { ...node, sequence, pendingFieldChanges, revision, digest: storyboardDigest(sequence, pendingFieldChanges) }
}

const normalizedFieldValue = (value: string): string => {
  if (typeof value !== 'string') throw new Error('storyboard_field_invalid')
  const normalized = value.normalize('NFC')
  if (normalized.length > 10_000 || new TextEncoder().encode(normalized).length > 32_000) throw new Error('storyboard_field_invalid')
  return normalized
}

const setRowField = (row: IStoryboardRow, field: StoryboardRowField, value: string) => {
  row[field] = value
}
