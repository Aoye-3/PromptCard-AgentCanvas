import type {
  DocumentSuggestion,
  PlanningDocumentBlockV1,
  PlanningDocumentV1,
  PlanningInlineV1
} from '@/models/PromptHistory.model'
import {
  clonePlanningDocumentV1,
  planningDocumentDigest,
  sha256Utf8
} from './planning-document'

export type DocumentChangeOperation =
  | { kind: 'insert'; blockId: string; utf8Offset: number; text: string; expectedTextDigest: string }
  | { kind: 'delete'; blockId: string; utf8Start: number; utf8End: number; expectedTextDigest: string }
  | { kind: 'replace'; blockId: string; utf8Start: number; utf8End: number; text: string; expectedTextDigest: string }

type PreparedOperation = {
  index: number
  operation: DocumentChangeOperation
  blockId: string
  start: number
  end: number
  inserted: PlanningInlineV1[]
  deleted: PlanningInlineV1[]
}

const MAX_DOCUMENT_CHANGE_OPERATIONS = 16
const MAX_DOCUMENT_CHANGE_TEXT_BYTES = 64 * 1024

export const deterministicDocumentSuggestionGroupId = (editId: string, operationIndex: number): string => (
  `docsg-${sha256Utf8(JSON.stringify([
    'document-suggestion-group-v1',
    normalizeIdentity(editId),
    normalizeOperationIndex(operationIndex)
  ]))}`
)

export const deterministicDocumentSuggestionId = (
  editId: string,
  operationIndex: number,
  kind: DocumentSuggestion['kind']
): string => {
  if (kind !== 'insert' && kind !== 'delete') fail('document_suggestion_kind_invalid')
  return `docs-${sha256Utf8(JSON.stringify([
    'document-suggestion-v1',
    normalizeIdentity(editId),
    normalizeOperationIndex(operationIndex),
    kind
  ]))}`
}

export const applyDocumentChangeOperations = (
  document: PlanningDocumentV1,
  editId: string,
  operations: DocumentChangeOperation[]
): PlanningDocumentV1 => {
  const normalizedEditId = normalizeIdentity(editId)
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_DOCUMENT_CHANGE_OPERATIONS) {
    fail('document_change_operations_invalid')
  }
  const source = clonePlanningDocumentV1(document)
  const pendingLeaves = new Set(source.suggestions.map(suggestion => suggestion.blockId))
  const prepared = operations.map((operation, index) => prepareOperation(source.blocks, operation, index, pendingLeaves))
  assertOperationsDoNotOverlap(prepared)

  let blocks = source.blocks
  for (const operation of [...prepared].sort((left, right) => (
    left.blockId === right.blockId ? right.start - left.start : left.blockId.localeCompare(right.blockId)
  ))) {
    blocks = replaceLeafContent(blocks, operation.blockId, content => (
      replaceRichRange(content, operation.start, operation.end, operation.inserted)
    ))
  }

  const suggestions = prepared.flatMap(operation => buildSuggestions(normalizedEditId, operation, prepared))
  const next = {
    version: 1 as const,
    blocks,
    revision: source.revision + 1,
    suggestions: [...source.suggestions, ...suggestions]
  }
  return { ...next, digest: planningDocumentDigest(next) }
}

export const acceptDocumentSuggestion = (
  document: PlanningDocumentV1,
  suggestionId: string
): PlanningDocumentV1 => {
  const suggestion = document.suggestions.find(item => item.id === suggestionId)
  if (!suggestion) fail('document_suggestion_not_found')
  return finalizeDocument(document, document.blocks, document.suggestions.filter(item => item.groupId !== suggestion.groupId))
}

export const rejectDocumentSuggestion = (
  document: PlanningDocumentV1,
  suggestionId: string
): PlanningDocumentV1 => {
  const suggestion = document.suggestions.find(item => item.id === suggestionId)
  if (!suggestion) fail('document_suggestion_not_found')
  const rejected = rejectSuggestionGroup(document.blocks, document.suggestions, suggestion.groupId)
  return finalizeDocument(document, rejected.blocks, rejected.suggestions)
}

export const acceptAllDocumentSuggestions = (document: PlanningDocumentV1): PlanningDocumentV1 => {
  if (document.suggestions.length === 0) return clonePlanningDocumentV1(document)
  return finalizeDocument(document, document.blocks, [])
}

export const rejectAllDocumentSuggestions = (document: PlanningDocumentV1): PlanningDocumentV1 => {
  if (document.suggestions.length === 0) return clonePlanningDocumentV1(document)
  let blocks = clonePlanningDocumentV1(document).blocks
  let suggestions = document.suggestions.map(cloneSuggestion)
  const groups = [...new Set(suggestions.map(suggestion => suggestion.groupId))]
    .sort((left, right) => groupStart(suggestions, right) - groupStart(suggestions, left))
  for (const groupId of groups) {
    const rejected = rejectSuggestionGroup(blocks, suggestions, groupId)
    blocks = rejected.blocks
    suggestions = rejected.suggestions
  }
  return finalizeDocument(document, blocks, [])
}

const prepareOperation = (
  blocks: PlanningDocumentBlockV1[],
  value: unknown,
  index: number,
  pendingLeaves: Set<string>
): PreparedOperation => {
  if (!isRecord(value) || (value.kind !== 'insert' && value.kind !== 'delete' && value.kind !== 'replace')) {
    fail('document_change_operation_invalid')
  }
  const allowed = value.kind === 'insert'
    ? ['kind', 'blockId', 'utf8Offset', 'text', 'expectedTextDigest']
    : value.kind === 'delete'
      ? ['kind', 'blockId', 'utf8Start', 'utf8End', 'expectedTextDigest']
      : ['kind', 'blockId', 'utf8Start', 'utf8End', 'text', 'expectedTextDigest']
  assertExactKeys(value, allowed, 'document_change_unknown_attribute')
  const blockId = normalizeIdentity(value.blockId)
  if (pendingLeaves.has(blockId)) fail('document_change_pending_leaf')
  const content = findLeafContent(blocks, blockId)
  if (!content) fail('document_change_leaf_not_found')
  const leafText = contentText(content)
  if (value.expectedTextDigest !== `sha256:${sha256Utf8(leafText.normalize('NFC'))}`) {
    fail('document_change_text_digest_mismatch')
  }
  const start = value.kind === 'insert'
    ? normalizeOffset(value.utf8Offset)
    : normalizeOffset(value.utf8Start)
  const end = value.kind === 'insert' ? start : normalizeOffset(value.utf8End)
  if (end < start || !isUtf8Boundary(leafText, start) || !isUtf8Boundary(leafText, end)) {
    fail('document_change_utf8_boundary_invalid')
  }
  if (value.kind !== 'insert' && end === start) fail('document_change_range_invalid')
  const normalizedText = value.kind === 'delete' ? '' : normalizeInsertedText(value.text)
  const marks = value.kind === 'insert' ? marksStrictlyInside(content, start) : {}
  const inserted = normalizedText ? [{ text: normalizedText, ...marks }] : []
  return {
    index,
    operation: value as DocumentChangeOperation,
    blockId,
    start,
    end,
    inserted,
    deleted: sliceRichRange(content, start, end)
  }
}

const buildSuggestions = (
  editId: string,
  operation: PreparedOperation,
  all: PreparedOperation[]
): DocumentSuggestion[] => {
  const finalStart = operation.start + all
    .filter(candidate => candidate.blockId === operation.blockId && candidate.start < operation.start)
    .reduce((total, candidate) => total + operationDelta(candidate), 0)
  const groupId = deterministicDocumentSuggestionGroupId(editId, operation.index)
  const base = { groupId, editId, blockId: operation.blockId, utf8Start: finalStart }
  const suggestions: DocumentSuggestion[] = []
  if (operation.operation.kind === 'delete' || operation.operation.kind === 'replace') {
    suggestions.push({
      ...base,
      id: deterministicDocumentSuggestionId(editId, operation.index, 'delete'),
      kind: 'delete',
      utf8End: finalStart,
      content: operation.deleted.map(cloneInline)
    })
  }
  if (operation.operation.kind === 'insert' || operation.operation.kind === 'replace') {
    suggestions.push({
      ...base,
      id: deterministicDocumentSuggestionId(editId, operation.index, 'insert'),
      kind: 'insert',
      utf8End: finalStart + richByteLength(operation.inserted),
      content: operation.inserted.map(cloneInline)
    })
  }
  return suggestions
}

const rejectSuggestionGroup = (
  inputBlocks: PlanningDocumentBlockV1[],
  inputSuggestions: DocumentSuggestion[],
  groupId: string
): { blocks: PlanningDocumentBlockV1[]; suggestions: DocumentSuggestion[] } => {
  const group = inputSuggestions.filter(suggestion => suggestion.groupId === groupId)
  if (group.length === 0) fail('document_suggestion_not_found')
  const insert = group.find(suggestion => suggestion.kind === 'insert')
  const deletion = group.find(suggestion => suggestion.kind === 'delete')
  const anchor = group[0].utf8Start
  const leafId = group[0].blockId
  let blocks = inputBlocks
  if (insert) {
    blocks = replaceLeafContent(blocks, leafId, content => {
      const actual = sliceRichRange(content, insert.utf8Start, insert.utf8End)
      if (contentText(actual) !== contentText(insert.content)) fail('document_suggestion_content_conflict')
      return replaceRichRange(content, insert.utf8Start, insert.utf8End, [])
    })
  }
  if (deletion) {
    blocks = replaceLeafContent(blocks, leafId, content => (
      replaceRichRange(content, anchor, anchor, deletion.content)
    ))
  }
  const delta = (deletion ? richByteLength(deletion.content) : 0) - (insert ? richByteLength(insert.content) : 0)
  const suggestions = inputSuggestions
    .filter(suggestion => suggestion.groupId !== groupId)
    .map(suggestion => suggestion.blockId === leafId && suggestion.utf8Start > anchor
      ? { ...cloneSuggestion(suggestion), utf8Start: suggestion.utf8Start + delta, utf8End: suggestion.utf8End + delta }
      : cloneSuggestion(suggestion))
  return { blocks, suggestions }
}

const finalizeDocument = (
  document: PlanningDocumentV1,
  blocks: PlanningDocumentBlockV1[],
  suggestions: DocumentSuggestion[]
): PlanningDocumentV1 => {
  const next = {
    version: 1 as const,
    blocks: blocks.map(cloneBlock),
    revision: document.revision + 1,
    suggestions: suggestions.map(cloneSuggestion)
  }
  return { ...next, digest: planningDocumentDigest(next) }
}

const assertOperationsDoNotOverlap = (operations: PreparedOperation[]): void => {
  for (let leftIndex = 0; leftIndex < operations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < operations.length; rightIndex += 1) {
      const left = operations[leftIndex]
      const right = operations[rightIndex]
      if (left.blockId !== right.blockId) continue
      const overlap = left.start === right.start || Math.max(left.start, right.start) < Math.min(left.end, right.end)
      const leftPointInsideRight = left.start === left.end && left.start > right.start && left.start < right.end
      const rightPointInsideLeft = right.start === right.end && right.start > left.start && right.start < left.end
      if (overlap || leftPointInsideRight || rightPointInsideLeft) fail('document_change_ranges_overlap')
    }
  }
}

const findLeafContent = (blocks: PlanningDocumentBlockV1[], leafId: string): PlanningInlineV1[] | null => {
  for (const block of blocks) {
    if ((block.type === 'paragraph' || block.type === 'blockquote' || block.type === 'heading') && block.id === leafId) {
      return block.content
    }
    if (block.type === 'bulletList' || block.type === 'orderedList' || block.type === 'checkList') {
      const item = block.items.find(candidate => candidate.id === leafId)
      if (item) return item.content
    }
    if (block.type === 'table') {
      for (const row of block.rows) {
        const cell = row.cells.find(candidate => candidate.id === leafId)
        if (cell) return cell.content
      }
    }
  }
  return null
}

const replaceLeafContent = (
  blocks: PlanningDocumentBlockV1[],
  leafId: string,
  update: (content: PlanningInlineV1[]) => PlanningInlineV1[]
): PlanningDocumentBlockV1[] => {
  let found = false
  const result = blocks.map(block => {
    if ((block.type === 'paragraph' || block.type === 'blockquote' || block.type === 'heading') && block.id === leafId) {
      found = true
      return { ...block, content: update(block.content) }
    }
    if (block.type === 'bulletList' || block.type === 'orderedList') {
      return { ...block, items: block.items.map(item => {
        if (item.id !== leafId) return { ...item, content: item.content.map(cloneInline) }
        found = true
        return { ...item, content: update(item.content) }
      }) }
    }
    if (block.type === 'checkList') {
      return { ...block, items: block.items.map(item => {
        if (item.id !== leafId) return { ...item, content: item.content.map(cloneInline) }
        found = true
        return { ...item, content: update(item.content) }
      }) }
    }
    if (block.type === 'table') {
      return { ...block, rows: block.rows.map(row => ({ ...row, cells: row.cells.map(cell => {
        if (cell.id !== leafId) return { ...cell, content: cell.content.map(cloneInline) }
        found = true
        return { ...cell, content: update(cell.content) }
      }) })) }
    }
    return cloneBlock(block)
  })
  if (!found) fail('document_change_leaf_not_found')
  return result
}

const replaceRichRange = (
  content: PlanningInlineV1[],
  start: number,
  end: number,
  inserted: PlanningInlineV1[]
): PlanningInlineV1[] => {
  const [beforeEnd, after] = splitRichContent(content, end)
  const [before] = splitRichContent(beforeEnd, start)
  return canonicalizeContent([...before, ...inserted.map(cloneInline), ...after])
}

const sliceRichRange = (content: PlanningInlineV1[], start: number, end: number): PlanningInlineV1[] => {
  if (start === end) return []
  const [beforeEnd] = splitRichContent(content, end)
  const [, selected] = splitRichContent(beforeEnd, start)
  return canonicalizeContent(selected)
}

const splitRichContent = (
  content: PlanningInlineV1[],
  offset: number
): [PlanningInlineV1[], PlanningInlineV1[]] => {
  const before: PlanningInlineV1[] = []
  const after: PlanningInlineV1[] = []
  let cursor = 0
  for (const inline of content) {
    const length = utf8Length(inline.text)
    if (offset <= cursor) {
      after.push(cloneInline(inline))
    } else if (offset >= cursor + length) {
      before.push(cloneInline(inline))
    } else {
      const localOffset = offset - cursor
      const index = utf8OffsetToStringIndex(inline.text, localOffset)
      before.push({ ...inline, text: inline.text.slice(0, index) })
      after.push({ ...inline, text: inline.text.slice(index) })
    }
    cursor += length
  }
  if (offset > cursor) fail('document_change_utf8_boundary_invalid')
  return [canonicalizeContent(before), canonicalizeContent(after)]
}

const canonicalizeContent = (content: PlanningInlineV1[]): PlanningInlineV1[] => {
  const canonical: PlanningInlineV1[] = []
  for (const candidate of content) {
    const text = candidate.text.normalize('NFC')
    if (!text) continue
    const inline: PlanningInlineV1 = { text }
    if (candidate.bold) inline.bold = true
    if (candidate.italic) inline.italic = true
    if (candidate.href) inline.href = candidate.href
    const previous = canonical[canonical.length - 1]
    if (previous && markSignature(previous) === markSignature(inline)) previous.text += inline.text
    else canonical.push(inline)
  }
  return canonical
}

const marksStrictlyInside = (content: PlanningInlineV1[], offset: number): Omit<PlanningInlineV1, 'text'> => {
  let cursor = 0
  for (const inline of content) {
    const end = cursor + utf8Length(inline.text)
    if (offset > cursor && offset < end) {
      return {
        ...(inline.bold ? { bold: true as const } : {}),
        ...(inline.italic ? { italic: true as const } : {}),
        ...(inline.href ? { href: inline.href } : {})
      }
    }
    cursor = end
  }
  return {}
}

const markSignature = (inline: PlanningInlineV1): string => JSON.stringify([
  inline.bold === true,
  inline.italic === true,
  inline.href || null
])

const contentText = (content: PlanningInlineV1[]): string => content.map(inline => inline.text).join('').normalize('NFC')
const richByteLength = (content: PlanningInlineV1[]): number => utf8Length(contentText(content))
const operationDelta = (operation: PreparedOperation): number => richByteLength(operation.inserted) - (operation.end - operation.start)

const utf8Length = (value: string): number => new TextEncoder().encode(value).length

const utf8Boundaries = (value: string): Set<number> => {
  const boundaries = new Set<number>([0])
  let bytes = 0
  for (const codePoint of value) {
    bytes += utf8Length(codePoint)
    boundaries.add(bytes)
  }
  return boundaries
}

const isUtf8Boundary = (value: string, offset: number): boolean => utf8Boundaries(value).has(offset)

const utf8OffsetToStringIndex = (value: string, target: number): number => {
  let bytes = 0
  let index = 0
  for (const codePoint of value) {
    if (bytes === target) return index
    bytes += utf8Length(codePoint)
    index += codePoint.length
  }
  if (bytes === target) return index
  fail('document_change_utf8_boundary_invalid')
}

const normalizeInsertedText = (value: unknown): string => {
  if (typeof value !== 'string') fail('document_change_text_invalid')
  const normalized = value.normalize('NFC')
  if (!normalized || /[\r\n]/u.test(normalized) || utf8Length(normalized) > MAX_DOCUMENT_CHANGE_TEXT_BYTES) {
    fail('document_change_text_invalid')
  }
  return normalized
}

const normalizeIdentity = (value: unknown): string => {
  if (typeof value !== 'string') fail('document_change_identity_invalid')
  const normalized = value.normalize('NFC')
  if (!normalized) fail('document_change_identity_invalid')
  return normalized
}

const normalizeOffset = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail('document_change_offset_invalid')
  return Number(value)
}

const normalizeOperationIndex = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) fail('document_suggestion_index_invalid')
  return value
}

const groupStart = (suggestions: DocumentSuggestion[], groupId: string): number => (
  suggestions.find(suggestion => suggestion.groupId === groupId)?.utf8Start || 0
)

const cloneInline = (inline: PlanningInlineV1): PlanningInlineV1 => ({ ...inline })
const cloneSuggestion = (suggestion: DocumentSuggestion): DocumentSuggestion => ({
  ...suggestion,
  content: suggestion.content.map(cloneInline)
})

const cloneBlock = (block: PlanningDocumentBlockV1): PlanningDocumentBlockV1 => {
  if (block.type === 'paragraph' || block.type === 'blockquote') return { ...block, content: block.content.map(cloneInline) }
  if (block.type === 'heading') return { ...block, content: block.content.map(cloneInline) }
  if (block.type === 'bulletList' || block.type === 'orderedList') {
    return { ...block, items: block.items.map(item => ({ ...item, content: item.content.map(cloneInline) })) }
  }
  if (block.type === 'checkList') {
    return { ...block, items: block.items.map(item => ({ ...item, content: item.content.map(cloneInline) })) }
  }
  if (block.type === 'table') {
    return {
      ...block,
      rows: block.rows.map(row => ({ ...row, cells: row.cells.map(cell => ({ ...cell, content: cell.content.map(cloneInline) })) }))
    }
  }
  return fail('planning_document_unreachable_clone')
}

const assertExactKeys = (value: Record<string, unknown>, allowed: string[], code: string): void => {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some(key => !allowedSet.has(key)) || allowed.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail(code)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

function fail(code: string): never {
  throw new Error(code)
}
