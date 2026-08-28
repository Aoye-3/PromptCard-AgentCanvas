import { describe, expect, test } from 'vitest'
import type { PlanningDocumentBlockV1, PlanningInlineV1 } from '@/models/PromptHistory.model'
import {
  canonicalPlanningDocumentJson,
  clonePlanningDocumentV1,
  createPlanningDocumentV1,
  parsePlanningDocumentV1,
  planningDocumentDigest,
  planningDocumentEffectiveText,
  sha256Utf8
} from './planning-document'
import { applyDocumentChangeOperations } from './document-suggestions'

const richBlocks = (): PlanningDocumentBlockV1[] => [
  {
    id: 'heading-1',
    type: 'heading',
    level: 2,
    content: [{ text: 'Cafe\u0301', bold: true }]
  },
  {
    id: 'paragraph-1',
    type: 'paragraph',
    content: [
      { text: 'Read ' },
      { text: 'the brief', italic: true, href: 'https://example.com/brief' }
    ]
  },
  {
    id: 'quote-1',
    type: 'blockquote',
    content: [{ text: 'Keep the source private.' }]
  },
  {
    id: 'bullets-1',
    type: 'bulletList',
    items: [
      { id: 'bullet-1', content: [{ text: 'Character' }] },
      { id: 'bullet-2', content: [{ text: 'Location' }] }
    ]
  },
  {
    id: 'ordered-1',
    type: 'orderedList',
    items: [{ id: 'ordered-item-1', content: [{ text: 'Opening' }] }]
  },
  {
    id: 'checks-1',
    type: 'checkList',
    items: [{ id: 'check-1', checked: true, content: [{ text: 'Approved' }] }]
  },
  {
    id: 'table-1',
    type: 'table',
    rows: [
      {
        id: 'row-1',
        cells: [
          { id: 'cell-1', header: true, content: [{ text: 'Shot' }] },
          { id: 'cell-2', header: true, content: [{ text: 'Beat' }] }
        ]
      },
      {
        id: 'row-2',
        cells: [
          { id: 'cell-3', content: [{ text: '1' }] },
          { id: 'cell-4', content: [{ text: 'Arrival' }] }
        ]
      }
    ]
  }
]

describe('planning document domain', () => {
  test('matches standard synchronous SHA-256 vectors', () => {
    expect(sha256Utf8('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Utf8('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('matches a cross-language UTF-8 canonical JSON golden vector', () => {
    const blocks: PlanningDocumentBlockV1[] = [{
      type: 'paragraph',
      id: 'p1',
      content: [
        { text: 'Cafe\u0301', bold: true },
        { italic: true, href: 'https://example.com/a?b=1', text: '链接' }
      ]
    }]

    expect(canonicalPlanningDocumentJson({ version: 1, blocks, suggestions: [] })).toBe(
      '{"blocks":[{"content":[{"bold":true,"text":"Café"},{"href":"https://example.com/a?b=1","italic":true,"text":"链接"}],"id":"p1","type":"paragraph"}],"suggestions":[],"version":1}'
    )
    expect(planningDocumentDigest({ version: 1, blocks, suggestions: [] })).toBe(
      'sha256:2453813f507b228038dd165b701ab8822d05425d6d674c5dafd5975fceee664f'
    )
  })

  test('normalizes all inline text to NFC and derives effective text without persisting it', () => {
    const document = createPlanningDocumentV1(richBlocks(), 7)

    expect(document.blocks[0]).toMatchObject({ content: [{ text: 'Café' }] })
    expect(planningDocumentEffectiveText(document)).toBe([
      'Café',
      'Read the brief',
      'Keep the source private.',
      'Character\nLocation',
      'Opening',
      'Approved',
      'Shot\tBeat\n1\tArrival'
    ].join('\n'))
    expect(document).not.toHaveProperty('effectiveText')
    expect(document.digest).toBe(planningDocumentDigest(document))
  })

  test('accepts the complete restricted AST including explicit table headers', () => {
    const document = createPlanningDocumentV1(richBlocks(), 3)

    expect(parsePlanningDocumentV1(document)).toEqual({ ok: true, document })
  })

  test('rejects an empty document even when its persisted digest is correct', () => {
    const digestInput = { version: 1 as const, blocks: [], suggestions: [] }
    const persisted = { ...digestInput, revision: 0, digest: planningDocumentDigest(digestInput) }

    expect(() => createPlanningDocumentV1([])).toThrow('planning_document_invalid_blocks')
    expect(parsePlanningDocumentV1(persisted)).toEqual({
      ok: false,
      reason: 'planning_document_invalid_blocks'
    })
  })

  test.each([
    { id: 'bullets-empty', type: 'bulletList', items: [] },
    { id: 'ordered-empty', type: 'orderedList', items: [] },
    { id: 'checks-empty', type: 'checkList', items: [] }
  ] as PlanningDocumentBlockV1[])('rejects an empty $type even when its persisted digest is correct', block => {
    const digestInput = { version: 1 as const, blocks: [block], suggestions: [] }
    const persisted = { ...digestInput, revision: 0, digest: planningDocumentDigest(digestInput) }

    expect(() => createPlanningDocumentV1([block])).toThrow('planning_document_invalid_items')
    expect(parsePlanningDocumentV1(persisted)).toEqual({
      ok: false,
      reason: 'planning_document_invalid_items'
    })
  })

  test('keeps one empty paragraph as the valid renderable blank document', () => {
    const document = createPlanningDocumentV1([{ id: 'paragraph-empty', type: 'paragraph', content: [] }])

    expect(parsePlanningDocumentV1(document)).toEqual({ ok: true, document })
    expect(planningDocumentEffectiveText(document)).toBe('')
  })

  test('rejects a zero-length inline run while preserving an empty content array as the blank representation', () => {
    const blocks: PlanningDocumentBlockV1[] = [{
      id: 'paragraph-empty-run',
      type: 'paragraph',
      content: [{ text: '' }]
    }]
    const digestInput = { version: 1 as const, blocks, suggestions: [] }
    const persisted = { ...digestInput, revision: 0, digest: planningDocumentDigest(digestInput) }

    expect(() => createPlanningDocumentV1(blocks)).toThrow('planning_document_invalid_inline')
    expect(parsePlanningDocumentV1(persisted)).toEqual({
      ok: false,
      reason: 'planning_document_invalid_inline'
    })
    expect(parsePlanningDocumentV1(createPlanningDocumentV1([
      { id: 'paragraph-blank', type: 'paragraph', content: [] }
    ])).ok).toBe(true)
  })

  test.each([
    { label: 'plain', content: [{ text: 'A' }, { text: 'B' }] },
    { label: 'bold', content: [{ text: 'A', bold: true }, { text: 'B', bold: true }] },
    { label: 'italic', content: [{ text: 'A', italic: true }, { text: 'B', italic: true }] },
    {
      label: 'bold and italic',
      content: [{ text: 'A', bold: true, italic: true }, { text: 'B', bold: true, italic: true }]
    },
    {
      label: 'link',
      content: [{ text: 'A', href: 'https://example.com/same' }, { text: 'B', href: 'https://example.com/same' }]
    },
    {
      label: 'bold, italic, and link',
      content: [
        { text: 'A', bold: true, italic: true, href: 'mailto:author@example.com' },
        { text: 'B', bold: true, italic: true, href: 'mailto:author@example.com' }
      ]
    }
  ] as Array<{ label: string; content: PlanningInlineV1[] }>)('rejects adjacent $label runs with an identical mark signature', ({ content }) => {
    const blocks: PlanningDocumentBlockV1[] = [{ id: 'paragraph-adjacent', type: 'paragraph', content }]
    const digestInput = { version: 1 as const, blocks, suggestions: [] }
    const persisted = { ...digestInput, revision: 0, digest: planningDocumentDigest(digestInput) }

    expect(() => createPlanningDocumentV1(blocks)).toThrow('planning_document_noncanonical_inline')
    expect(parsePlanningDocumentV1(persisted)).toEqual({
      ok: false,
      reason: 'planning_document_noncanonical_inline'
    })
  })

  test('rejects duplicate structural and leaf IDs across the entire document', () => {
    const duplicate = richBlocks()
    const table = duplicate[6]
    if (table.type !== 'table') throw new Error('Expected table fixture')
    table.rows[1].cells[0].id = 'bullet-1'

    expect(() => createPlanningDocumentV1(duplicate)).toThrow('planning_document_duplicate_id')
  })

  test('NFC-normalizes structural IDs before storing and digesting equivalent AST forms', () => {
    const decomposedId = 'cafe\u0301-block'
    const composedId = 'café-block'
    const decomposedBlocks: PlanningDocumentBlockV1[] = [{
      id: decomposedId,
      type: 'paragraph',
      content: [{ text: 'Same body' }]
    }]
    const composedBlocks: PlanningDocumentBlockV1[] = [{
      id: composedId,
      type: 'paragraph',
      content: [{ text: 'Same body' }]
    }]
    const decomposedDocument = createPlanningDocumentV1(decomposedBlocks, 2)
    const composedDocument = createPlanningDocumentV1(composedBlocks, 2)
    const persistedInput = { version: 1 as const, blocks: decomposedBlocks, suggestions: [] }
    const persisted = { ...persistedInput, revision: 2, digest: planningDocumentDigest(persistedInput) }

    expect(decomposedDocument.blocks[0].id).toBe(composedId)
    expect(decomposedDocument).toEqual(composedDocument)
    expect(parsePlanningDocumentV1(persisted)).toEqual({ ok: true, document: composedDocument })
  })

  test.each([
    {
      label: 'block',
      blocks: [
        { id: 'café', type: 'paragraph', content: [] },
        { id: 'cafe\u0301', type: 'paragraph', content: [] }
      ]
    },
    {
      label: 'list item',
      blocks: [{
        id: 'list',
        type: 'bulletList',
        items: [
          { id: 'café', content: [] },
          { id: 'cafe\u0301', content: [] }
        ]
      }]
    },
    {
      label: 'table row',
      blocks: [{
        id: 'table',
        type: 'table',
        rows: [
          { id: 'café', cells: [{ id: 'cell-1', content: [] }] },
          { id: 'cafe\u0301', cells: [{ id: 'cell-2', content: [] }] }
        ]
      }]
    },
    {
      label: 'table cell',
      blocks: [{
        id: 'table',
        type: 'table',
        rows: [{
          id: 'row',
          cells: [
            { id: 'café', content: [] },
            { id: 'cafe\u0301', content: [] }
          ]
        }]
      }]
    }
  ] as Array<{ label: string; blocks: PlanningDocumentBlockV1[] }>)('rejects canonically duplicate $label IDs', ({ blocks }) => {
    const digestInput = { version: 1 as const, blocks, suggestions: [] }
    const persisted = { ...digestInput, revision: 0, digest: planningDocumentDigest(digestInput) }

    expect(() => createPlanningDocumentV1(blocks)).toThrow('planning_document_duplicate_id')
    expect(parsePlanningDocumentV1(persisted)).toEqual({
      ok: false,
      reason: 'planning_document_duplicate_id'
    })
  })

  test.each([
    'javascript:alert(1)',
    'data:text/html,unsafe',
    '/relative/path'
  ])('rejects unsafe or relative link %s', href => {
    const blocks = richBlocks()
    const paragraph = blocks[1]
    if (paragraph.type !== 'paragraph') throw new Error('Expected paragraph fixture')
    paragraph.content[1].href = href

    expect(() => createPlanningDocumentV1(blocks)).toThrow('planning_document_invalid_link')
  })

  test.each([
    { version: 2, blocks: [], revision: 0, digest: 'sha256:x', suggestions: [] },
    { version: 1, blocks: [], revision: 0, digest: 'sha256:x', suggestions: [{ id: 'malformed-task-7' }] },
    { version: 1, blocks: [{ id: 'x', type: 'codeBlock', content: [] }], revision: 0, digest: 'sha256:x', suggestions: [] }
  ])('rejects unsupported versions, malformed suggestions, and unknown blocks', value => {
    expect(parsePlanningDocumentV1(value)).toMatchObject({ ok: false })
  })

  test('strictly parses and deep-clones a valid persisted suggestion payload', () => {
    const original = createPlanningDocumentV1([{
      id: 'paragraph-1', type: 'paragraph', content: [{ text: 'Café' }]
    }], 2)
    const suggested = applyDocumentChangeOperations(original, 'edit-1', [{
      kind: 'insert',
      blockId: 'paragraph-1',
      utf8Offset: 5,
      text: '!',
      expectedTextDigest: `sha256:${sha256Utf8('Café')}`
    }])

    const parsed = parsePlanningDocumentV1(suggested)
    expect(parsed).toEqual({ ok: true, document: suggested })
    if (!parsed.ok) throw new Error('Expected valid suggested document')
    expect(parsed.document.suggestions).not.toBe(suggested.suggestions)
    expect(parsed.document.suggestions[0]).not.toBe(suggested.suggestions[0])
    expect(parsed.document.suggestions[0].content).not.toBe(suggested.suggestions[0].content)
  })

  test('rejects unknown attributes instead of silently dropping them', () => {
    const blocks = [{
      id: 'paragraph-1',
      type: 'paragraph',
      content: [{ text: 'Draft', strike: true }]
    }]

    expect(() => createPlanningDocumentV1(blocks as never)).toThrow('planning_document_unknown_attribute')
  })

  test('rejects a persisted digest that does not match canonical content', () => {
    const document = createPlanningDocumentV1(richBlocks(), 2)

    expect(parsePlanningDocumentV1({ ...document, digest: 'sha256:tampered' })).toEqual({
      ok: false,
      reason: 'planning_document_digest_mismatch'
    })
  })

  test('deep clones every nested block, inline, row, and cell', () => {
    const document = createPlanningDocumentV1(richBlocks(), 4)
    const cloned = clonePlanningDocumentV1(document)

    expect(cloned).toEqual(document)
    expect(cloned).not.toBe(document)
    expect(cloned.blocks).not.toBe(document.blocks)
    const originalTable = document.blocks[6]
    const clonedTable = cloned.blocks[6]
    if (originalTable.type !== 'table' || clonedTable.type !== 'table') throw new Error('Expected table fixture')
    expect(clonedTable.rows).not.toBe(originalTable.rows)
    expect(clonedTable.rows[0].cells).not.toBe(originalTable.rows[0].cells)
    expect(clonedTable.rows[0].cells[0].content).not.toBe(originalTable.rows[0].cells[0].content)
  })
})
