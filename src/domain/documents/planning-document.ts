import type {
  DocumentSuggestion,
  PlanningDocumentBlockV1,
  PlanningDocumentV1,
  PlanningInlineV1
} from '@/models/PromptHistory.model'

type PlanningDocumentDigestInput = Pick<PlanningDocumentV1, 'version' | 'blocks' | 'suggestions'>

export type PlanningDocumentParseResult =
  | { ok: true; document: PlanningDocumentV1 }
  | { ok: false; reason: string }

const SHA256_INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
])

const SHA256_ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

export const sha256Utf8 = (value: string): string => {
  const source = new TextEncoder().encode(value)
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(source)
  padded[source.length] = 0x80
  const bitLength = source.length * 8
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  const hash = new Uint32Array(SHA256_INITIAL)
  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false)
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]
      const right = words[index - 2]
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3)
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10)
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }

    let a = hash[0]
    let b = hash[1]
    let c = hash[2]
    let d = hash[3]
    let e = hash[4]
    let f = hash[5]
    let g = hash[6]
    let h = hash[7]
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choose + SHA256_ROUND[index] + words[index]) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    hash[0] = (hash[0] + a) >>> 0
    hash[1] = (hash[1] + b) >>> 0
    hash[2] = (hash[2] + c) >>> 0
    hash[3] = (hash[3] + d) >>> 0
    hash[4] = (hash[4] + e) >>> 0
    hash[5] = (hash[5] + f) >>> 0
    hash[6] = (hash[6] + g) >>> 0
    hash[7] = (hash[7] + h) >>> 0
  }

  return Array.from(hash, word => word.toString(16).padStart(8, '0')).join('')
}

export const canonicalPlanningDocumentJson = (input: PlanningDocumentDigestInput): string => canonicalJson({
  version: input.version,
  blocks: input.blocks,
  suggestions: input.suggestions
})

export const planningDocumentDigest = (input: PlanningDocumentDigestInput): string => (
  `sha256:${sha256Utf8(canonicalPlanningDocumentJson(input))}`
)

export const planningDocumentEffectiveText = (
  document: Pick<PlanningDocumentV1, 'blocks'>
): string => document.blocks.map(blockText).join('\n').normalize('NFC')

export const createPlanningDocumentV1 = (
  blocks: PlanningDocumentBlockV1[],
  revision = 0
): PlanningDocumentV1 => {
  if (!Number.isSafeInteger(revision) || revision < 0) fail('planning_document_invalid_revision')
  const normalizedBlocks = normalizeBlocks(blocks)
  const base = { version: 1 as const, blocks: normalizedBlocks, suggestions: [] as DocumentSuggestion[] }
  return { ...base, revision, digest: planningDocumentDigest(base) }
}

export const parsePlanningDocumentV1 = (value: unknown): PlanningDocumentParseResult => {
  try {
    if (!isRecord(value)) fail('planning_document_invalid')
    assertExactKeys(value, ['version', 'blocks', 'revision', 'digest', 'suggestions'])
    if (value.version !== 1) fail('planning_document_unsupported_version')
    if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) fail('planning_document_invalid_revision')
    if (typeof value.digest !== 'string') fail('planning_document_invalid_digest')
    if (!Array.isArray(value.suggestions) || value.suggestions.length !== 0) fail('planning_document_suggestions_unsupported')
    const blocks = normalizeBlocks(value.blocks)
    const document: PlanningDocumentV1 = {
      version: 1,
      blocks,
      revision: Number(value.revision),
      digest: value.digest,
      suggestions: []
    }
    if (document.digest !== planningDocumentDigest(document)) fail('planning_document_digest_mismatch')
    return { ok: true, document }
  } catch (error) {
    return { ok: false, reason: errorCode(error) }
  }
}

export const clonePlanningDocumentV1 = (document: PlanningDocumentV1): PlanningDocumentV1 => ({
  version: 1,
  blocks: document.blocks.map(cloneBlock),
  revision: document.revision,
  digest: document.digest,
  suggestions: document.suggestions.map(suggestion => deepCloneJson(suggestion))
})

const normalizeBlocks = (value: unknown): PlanningDocumentBlockV1[] => {
  if (!Array.isArray(value) || value.length === 0) fail('planning_document_invalid_blocks')
  const ids = new Set<string>()
  return value.map(item => normalizeBlock(item, ids))
}

const normalizeBlock = (value: unknown, ids: Set<string>): PlanningDocumentBlockV1 => {
  if (!isRecord(value) || typeof value.type !== 'string') fail('planning_document_invalid_block')
  const id = normalizeId(value.id, ids)
  if (value.type === 'paragraph' || value.type === 'blockquote') {
    assertExactKeys(value, ['id', 'type', 'content'])
    return { id, type: value.type, content: normalizeInlineContent(value.content) }
  }
  if (value.type === 'heading') {
    assertExactKeys(value, ['id', 'type', 'level', 'content'])
    if (value.level !== 1 && value.level !== 2 && value.level !== 3) fail('planning_document_invalid_heading_level')
    return { id, type: 'heading', level: value.level, content: normalizeInlineContent(value.content) }
  }
  if (value.type === 'bulletList' || value.type === 'orderedList') {
    assertExactKeys(value, ['id', 'type', 'items'])
    if (!Array.isArray(value.items) || value.items.length === 0) fail('planning_document_invalid_items')
    return {
      id,
      type: value.type,
      items: value.items.map(item => normalizeListItem(item, ids, false))
    }
  }
  if (value.type === 'checkList') {
    assertExactKeys(value, ['id', 'type', 'items'])
    if (!Array.isArray(value.items) || value.items.length === 0) fail('planning_document_invalid_items')
    return {
      id,
      type: 'checkList',
      items: value.items.map(item => normalizeListItem(item, ids, true))
    }
  }
  if (value.type === 'table') {
    assertExactKeys(value, ['id', 'type', 'rows'])
    if (!Array.isArray(value.rows) || value.rows.length === 0) fail('planning_document_invalid_table')
    const rows = value.rows.map(row => normalizeTableRow(row, ids))
    const columnCount = rows[0].cells.length
    if (columnCount === 0 || rows.some(row => row.cells.length !== columnCount)) fail('planning_document_invalid_table')
    return { id, type: 'table', rows }
  }
  fail('planning_document_unknown_block')
}

function normalizeListItem(
  value: unknown,
  ids: Set<string>,
  checked: false
): { id: string; content: PlanningInlineV1[] }
function normalizeListItem(
  value: unknown,
  ids: Set<string>,
  checked: true
): { id: string; checked: boolean; content: PlanningInlineV1[] }
function normalizeListItem(
  value: unknown,
  ids: Set<string>,
  checked: boolean
): { id: string; checked: boolean; content: PlanningInlineV1[] } | { id: string; content: PlanningInlineV1[] } {
  if (!isRecord(value)) fail('planning_document_invalid_item')
  assertExactKeys(value, checked ? ['id', 'checked', 'content'] : ['id', 'content'])
  const id = normalizeId(value.id, ids)
  const content = normalizeInlineContent(value.content)
  if (!checked) return { id, content }
  if (typeof value.checked !== 'boolean') fail('planning_document_invalid_check_state')
  return { id, checked: value.checked, content }
}

const normalizeTableRow = (
  value: unknown,
  ids: Set<string>
): Extract<PlanningDocumentBlockV1, { type: 'table' }>['rows'][number] => {
  if (!isRecord(value)) fail('planning_document_invalid_table')
  assertExactKeys(value, ['id', 'cells'])
  const id = normalizeId(value.id, ids)
  if (!Array.isArray(value.cells)) fail('planning_document_invalid_table')
  return { id, cells: value.cells.map(cell => normalizeTableCell(cell, ids)) }
}

const normalizeTableCell = (
  value: unknown,
  ids: Set<string>
): Extract<PlanningDocumentBlockV1, { type: 'table' }>['rows'][number]['cells'][number] => {
  if (!isRecord(value)) fail('planning_document_invalid_table')
  assertExactKeys(value, value.header === undefined ? ['id', 'content'] : ['id', 'header', 'content'])
  if (value.header !== undefined && value.header !== true) fail('planning_document_invalid_table_header')
  const cell = {
    id: normalizeId(value.id, ids),
    content: normalizeInlineContent(value.content)
  }
  return value.header === true ? { ...cell, header: true } : cell
}

const normalizeInlineContent = (value: unknown): PlanningInlineV1[] => {
  if (!Array.isArray(value)) fail('planning_document_invalid_inline_content')
  let previousMarkSignature: string | null = null
  return value.map(inline => {
    if (!isRecord(inline)) fail('planning_document_invalid_inline')
    const allowed = ['text']
    if (inline.bold !== undefined) allowed.push('bold')
    if (inline.italic !== undefined) allowed.push('italic')
    if (inline.href !== undefined) allowed.push('href')
    assertExactKeys(inline, allowed)
    if (typeof inline.text !== 'string') fail('planning_document_invalid_inline')
    if (inline.bold !== undefined && inline.bold !== true) fail('planning_document_invalid_mark')
    if (inline.italic !== undefined && inline.italic !== true) fail('planning_document_invalid_mark')
    if (inline.href !== undefined && (typeof inline.href !== 'string' || !isSafeLink(inline.href))) {
      fail('planning_document_invalid_link')
    }
    const normalizedText = inline.text.normalize('NFC')
    if (normalizedText.length === 0) fail('planning_document_invalid_inline')
    const normalized: PlanningInlineV1 = { text: normalizedText }
    if (inline.bold === true) normalized.bold = true
    if (inline.italic === true) normalized.italic = true
    if (typeof inline.href === 'string') normalized.href = inline.href.normalize('NFC')
    const markSignature = `${normalized.bold === true ? 'b' : ''}|${normalized.italic === true ? 'i' : ''}|${normalized.href || ''}`
    if (markSignature === previousMarkSignature) fail('planning_document_noncanonical_inline')
    previousMarkSignature = markSignature
    return normalized
  })
}

const blockText = (block: PlanningDocumentBlockV1): string => {
  if (block.type === 'paragraph' || block.type === 'blockquote' || block.type === 'heading') {
    return inlineText(block.content)
  }
  if (block.type === 'bulletList' || block.type === 'orderedList' || block.type === 'checkList') {
    return block.items.map(item => inlineText(item.content)).join('\n')
  }
  if (block.type === 'table') {
    return block.rows.map(row => row.cells.map(cell => inlineText(cell.content)).join('\t')).join('\n')
  }
  return fail('planning_document_unreachable_block')
}

const inlineText = (content: PlanningInlineV1[]): string => content.map(inline => inline.text).join('')

const cloneBlock = (block: PlanningDocumentBlockV1): PlanningDocumentBlockV1 => {
  if (block.type === 'paragraph' || block.type === 'blockquote') {
    return { id: block.id, type: block.type, content: block.content.map(cloneInline) }
  }
  if (block.type === 'heading') {
    return { id: block.id, type: 'heading', level: block.level, content: block.content.map(cloneInline) }
  }
  if (block.type === 'bulletList' || block.type === 'orderedList') {
    return {
      id: block.id,
      type: block.type,
      items: block.items.map(item => ({ id: item.id, content: item.content.map(cloneInline) }))
    }
  }
  if (block.type === 'checkList') {
    return {
      id: block.id,
      type: 'checkList',
      items: block.items.map(item => ({ id: item.id, checked: item.checked, content: item.content.map(cloneInline) }))
    }
  }
  if (block.type === 'table') {
    return {
      id: block.id,
      type: 'table',
      rows: block.rows.map(row => ({
        id: row.id,
        cells: row.cells.map(cell => ({
          id: cell.id,
          ...(cell.header === true ? { header: true as const } : {}),
          content: cell.content.map(cloneInline)
        }))
      }))
    }
  }
  return fail('planning_document_unreachable_clone')
}

const cloneInline = (inline: PlanningInlineV1): PlanningInlineV1 => ({ ...inline })

const normalizeId = (value: unknown, ids: Set<string>): string => {
  if (typeof value !== 'string' || value.length === 0) fail('planning_document_invalid_id')
  if (ids.has(value)) fail('planning_document_duplicate_id')
  ids.add(value)
  return value
}

const isSafeLink = (href: string): boolean => {
  try {
    const url = new URL(href)
    if (url.protocol === 'mailto:') return url.pathname.length > 0
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

const assertExactKeys = (value: Record<string, unknown>, allowed: readonly string[]): void => {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some(key => !allowedSet.has(key))) fail('planning_document_unknown_attribute')
  if (allowed.some(key => !Object.prototype.hasOwnProperty.call(value, key))) fail('planning_document_missing_attribute')
}

const canonicalJson = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('planning_document_non_finite_number')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean' || value === null) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  fail('planning_document_non_json_value')
}

const deepCloneJson = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(item => deepCloneJson(item)) as T
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepCloneJson(item)])) as T
  }
  return value
}

const rotateRight = (value: number, amount: number): number => (
  (value >>> amount) | (value << (32 - amount))
)

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

function fail(code: string): never {
  throw new Error(code)
}

const errorCode = (error: unknown): string => (
  error instanceof Error ? error.message : 'planning_document_invalid'
)
