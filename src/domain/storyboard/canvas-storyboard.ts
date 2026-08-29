import type { AgentStoryboardChangesEdit, AgentStoryboardCreateEdit } from '@/models/Agent.model'
import type {
  IFreeCanvasPosition,
  IFreeCanvasStoryboardNode,
  IStoryboardRow,
  IStoryboardSequence,
  StoryboardSourceProvenance,
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
export const MAX_STORYBOARD_AGGREGATE_TEXT_BYTES = 256_000
const MAX_STORYBOARD_FIELD_BYTES = 10_000
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u

const isPlainRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => (
  Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
)

const isNonNegativeSafeInteger = (value: unknown): value is number => (
  Number.isSafeInteger(value) && Number(value) >= 0
)

const isWellFormedNfcText = (value: unknown, nonempty = false): value is string => {
  if (typeof value !== 'string' || value !== value.normalize('NFC')) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return (!nonempty || value.length > 0) && new TextEncoder().encode(value).length <= MAX_STORYBOARD_FIELD_BYTES
}

export const isValidStoryboardSourceProvenance = (
  value: unknown
): value is StoryboardSourceProvenance => {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'documentNodeId', 'documentRevision', 'documentDigest', 'documentResourceDigests', 'model', 'skills'
  ])) return false
  const model = value.model
  const skills = value.skills
  if (
    !isWellFormedNfcText(value.documentNodeId, true)
    || !isNonNegativeSafeInteger(value.documentRevision)
    || typeof value.documentDigest !== 'string' || !SHA256_DIGEST_PATTERN.test(value.documentDigest)
    || !Array.isArray(value.documentResourceDigests) || value.documentResourceDigests.length > 5
    || value.documentResourceDigests.some(digest => typeof digest !== 'string' || !SHA256_DIGEST_PATTERN.test(digest))
    || !isPlainRecord(model)
    || !hasExactKeys(model, ['connectionId', 'providerId', 'modelId', 'displayName', 'capabilities'])
    || ['connectionId', 'providerId', 'modelId', 'displayName'].some(key => !isWellFormedNfcText(model[key], true))
    || !isPlainRecord(model.capabilities)
    || !Array.isArray(skills) || skills.length > 8
  ) return false
  const skillIds = new Set<string>()
  return skills.every(skill => {
    if (!isPlainRecord(skill) || !hasExactKeys(skill, ['skillId', 'revision', 'digest'])) return false
    if (
      !isWellFormedNfcText(skill.skillId, true)
      || skillIds.has(skill.skillId)
      || !isNonNegativeSafeInteger(skill.revision)
      || typeof skill.digest !== 'string' || !SHA256_DIGEST_PATTERN.test(skill.digest)
    ) return false
    skillIds.add(skill.skillId)
    return true
  })
}

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
  if (values.some(value => typeof value !== 'string' || new TextEncoder().encode(value.normalize('NFC')).length > MAX_STORYBOARD_FIELD_BYTES)) {
    throw new Error('storyboard_sequence_invalid')
  }
  if (new TextEncoder().encode(values.map(value => value.normalize('NFC')).join('')).length > MAX_STORYBOARD_AGGREGATE_TEXT_BYTES) {
    throw new Error('storyboard_sequence_invalid')
  }
}

export const createStoryboardNode = (
  edit: AgentStoryboardCreateEdit,
  position: IFreeCanvasPosition
): IFreeCanvasStoryboardNode => {
  if (!isValidStoryboardSourceProvenance(edit.payload.source)) throw new Error('storyboard_source_invalid')
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
  if (
    edit.payload.changes.reduce(
      (total, change) => total + new TextEncoder().encode(change.value.normalize('NFC')).length,
      0
    ) > MAX_STORYBOARD_AGGREGATE_TEXT_BYTES
  ) throw new Error('storyboard_changes_invalid')
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
  if (new TextEncoder().encode(normalized).length > MAX_STORYBOARD_FIELD_BYTES) throw new Error('storyboard_field_invalid')
  return normalized
}

const setRowField = (row: IStoryboardRow, field: StoryboardRowField, value: string) => {
  row[field] = value
}
