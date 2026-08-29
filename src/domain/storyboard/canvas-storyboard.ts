import type {
  AgentStoryboardChangesEdit,
  AgentStoryboardCreateEdit,
  AgentStoryboardFieldChangeOperation
} from '@/models/Agent.model'
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

const storyboardSequenceTextValues = (sequence: IStoryboardSequence): string[] => [
  sequence.name, sequence.description, sequence.style, sequence.constraints,
  ...sequence.rows.flatMap(row => [
    row.cutLabel, row.timeRange, row.subject, row.action, row.scene, row.camera,
    row.lighting || '', row.audio || '', row.duration
  ])
]

const storyboardSequenceTextBytes = (sequence: IStoryboardSequence): number => (
  storyboardSequenceTextValues(sequence).reduce(
    (total, value) => total + new TextEncoder().encode(value.normalize('NFC')).length,
    0
  )
)

export const isValidStoryboardChangeOperations = (
  value: unknown,
  sequence?: IStoryboardSequence
): value is AgentStoryboardFieldChangeOperation[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return false
  const rowIds = sequence ? new Set(sequence.rows.map(row => row.id)) : null
  const identities = new Set<string>()
  return value.every(operation => {
    if (!isPlainRecord(operation) || !isWellFormedNfcText(operation.value)) return false
    if (operation.scope === 'sequence') {
      if (
        !hasExactKeys(operation, ['scope', 'field', 'value'])
        || !STORYBOARD_SEQUENCE_FIELDS.includes(operation.field as StoryboardSequenceField)
      ) return false
      const identity = `sequence:${String(operation.field)}`
      if (identities.has(identity)) return false
      identities.add(identity)
      return true
    }
    if (operation.scope !== 'row' || !hasExactKeys(operation, ['scope', 'rowId', 'field', 'value'])) return false
    if (
      !isWellFormedNfcText(operation.rowId, true)
      || !STORYBOARD_ROW_FIELDS.includes(operation.field as StoryboardRowField)
      || (rowIds !== null && !rowIds.has(operation.rowId))
    ) return false
    const identity = `row:${operation.rowId}:${String(operation.field)}`
    if (identities.has(identity)) return false
    identities.add(identity)
    return true
  })
}

export const isValidStoryboardPendingFieldChanges = (
  value: unknown,
  sequence: IStoryboardSequence
): value is StoryboardFieldChange[] => {
  if (!Array.isArray(value) || value.length > 32) return false
  try {
    assertSequence(sequence)
  } catch {
    return false
  }
  const rows = new Map(sequence.rows.map(row => [row.id, row]))
  const changeIds = new Set<string>()
  const identities = new Set<string>()
  const prospective = cloneSequence(sequence)
  for (const change of value) {
    if (!isPlainRecord(change) || (change.scope !== 'sequence' && change.scope !== 'row')) return false
    const keys = [
      'id', 'editId', 'scope', ...(change.scope === 'row' ? ['rowId'] : []),
      'field', 'previousValue', 'newValue'
    ]
    if (
      !hasExactKeys(change, keys)
      || !isWellFormedNfcText(change.id, true) || changeIds.has(change.id)
      || !isWellFormedNfcText(change.editId, true)
      || !isWellFormedNfcText(change.previousValue)
      || !isWellFormedNfcText(change.newValue)
    ) return false
    if (change.scope === 'sequence') {
      if (!STORYBOARD_SEQUENCE_FIELDS.includes(change.field as StoryboardSequenceField)) return false
      const field = change.field as StoryboardSequenceField
      const identity = `sequence:${field}`
      if (identities.has(identity) || change.previousValue !== sequence[field]) return false
      prospective[field] = change.newValue
      identities.add(identity)
    } else {
      if (
        !isWellFormedNfcText(change.rowId, true)
        || !STORYBOARD_ROW_FIELDS.includes(change.field as StoryboardRowField)
      ) return false
      const row = rows.get(change.rowId)
      const prospectiveRow = prospective.rows.find(candidate => candidate.id === change.rowId)
      const field = change.field as StoryboardRowField
      const identity = `row:${change.rowId}:${field}`
      if (!row || !prospectiveRow || identities.has(identity) || change.previousValue !== (row[field] || '')) return false
      setRowField(prospectiveRow, field, change.newValue)
      identities.add(identity)
    }
    changeIds.add(change.id)
  }
  try {
    assertSequence(prospective)
    return true
  } catch {
    return false
  }
}

const assertSequence = (sequence: IStoryboardSequence) => {
  if (!sequence || !sequence.id || sequence.rows.length > 200) throw new Error('storyboard_sequence_invalid')
  const values = storyboardSequenceTextValues(sequence)
  const rowIds = new Set<string>()
  sequence.rows.forEach(row => {
    if (!row.id || rowIds.has(row.id)) throw new Error('storyboard_sequence_invalid')
    rowIds.add(row.id)
  })
  if (values.some(value => !isWellFormedNfcText(value))) {
    throw new Error('storyboard_sequence_invalid')
  }
  if (storyboardSequenceTextBytes(sequence) > MAX_STORYBOARD_AGGREGATE_TEXT_BYTES) {
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
  if (
    !isValidStoryboardSourceProvenance(edit.payload.source)
    || canonicalJson(edit.payload.source) !== canonicalJson(node.source)
  ) throw new Error('storyboard_source_mismatch')
  const revision = node.revision ?? 0
  const digest = node.digest ?? storyboardDigest(node.sequence, node.pendingFieldChanges)
  if (edit.nodeId !== node.id || edit.base.nodeRevision !== revision || edit.base.nodeDigest !== digest) {
    throw new Error('storyboard_edit_stale')
  }
  if (node.pendingFieldChanges.length) throw new Error('storyboard_review_pending')
  if (!isValidStoryboardChangeOperations(edit.payload.changes, node.sequence)) {
    throw new Error('storyboard_changes_invalid')
  }
  const pendingFieldChanges = edit.payload.changes.map((change, index): StoryboardFieldChange => {
    const id = `sbf-${edit.editId}-${index}`
    const newValue = change.value
    if (change.scope === 'sequence') {
      if (!STORYBOARD_SEQUENCE_FIELDS.includes(change.field)) throw new Error('storyboard_field_invalid')
      return { id, editId: edit.editId, scope: 'sequence', field: change.field, previousValue: node.sequence[change.field], newValue }
    }
    if (!STORYBOARD_ROW_FIELDS.includes(change.field)) throw new Error('storyboard_field_invalid')
    const row = node.sequence.rows.find(candidate => candidate.id === change.rowId)
    if (!row) throw new Error('storyboard_row_missing')
    return { id, editId: edit.editId, scope: 'row', rowId: row.id, field: change.field, previousValue: row[change.field] || '', newValue }
  })
  if (!isValidStoryboardPendingFieldChanges(pendingFieldChanges, node.sequence)) {
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
  if (!isValidStoryboardPendingFieldChanges(node.pendingFieldChanges, node.sequence)) {
    throw new Error('storyboard_changes_invalid')
  }
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
  if (!isValidStoryboardPendingFieldChanges(pendingFieldChanges, sequence)) {
    throw new Error('storyboard_changes_invalid')
  }
  const revision = (node.revision ?? 0) + 1
  return { ...node, sequence, pendingFieldChanges, revision, digest: storyboardDigest(sequence, pendingFieldChanges) }
}

const setRowField = (row: IStoryboardRow, field: StoryboardRowField, value: string) => {
  row[field] = value
}
