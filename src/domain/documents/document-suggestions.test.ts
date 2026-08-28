import { describe, expect, test } from 'vitest'
import {
  acceptAllDocumentSuggestions,
  acceptDocumentSuggestion,
  applyDocumentChangeOperations,
  deterministicDocumentSuggestionGroupId,
  deterministicDocumentSuggestionId,
  rejectAllDocumentSuggestions,
  rejectDocumentSuggestion,
  type DocumentChangeOperation
} from './document-suggestions'
import {
  createPlanningDocumentV1,
  planningDocumentEffectiveText,
  sha256Utf8
} from './planning-document'

const textDigest = (value: string): string => `sha256:${sha256Utf8(value.normalize('NFC'))}`

const createRichDocument = () => createPlanningDocumentV1([
  {
    id: 'paragraph-1',
    type: 'paragraph',
    content: [
      { text: 'Café ' },
      { text: 'bold', bold: true },
      { text: ' end' }
    ]
  },
  {
    id: 'list-1',
    type: 'bulletList',
    items: [{ id: 'item-1', content: [{ text: 'Second leaf' }] }]
  }
], 4)

describe('tracked planning document suggestions', () => {
  test('uses NFC canonical deterministic identities with a Python-compatible golden vector', () => {
    expect(deterministicDocumentSuggestionGroupId('edit-cafe\u0301', 0)).toBe(
      'docsg-89461aaa186255dda701fc5e8f63a2bb6f1684351476b8d341ddb18d2c482134'
    )
    expect(deterministicDocumentSuggestionId('edit-cafe\u0301', 0, 'insert')).toBe(
      'docs-6f7a0cf9ec9334bd45b3b3c22cce441f89c29134e34d87c9f15247514c4a3429'
    )
    expect(deterministicDocumentSuggestionId('edit-café', 0, 'insert')).toBe(
      deterministicDocumentSuggestionId('edit-cafe\u0301', 0, 'insert')
    )
  })

  test('applies an NFC insertion at a UTF-8 byte boundary and inherits marks only strictly inside one span', () => {
    const document = createRichDocument()
    const updated = applyDocumentChangeOperations(document, 'edit-insert', [{
      kind: 'insert', blockId: 'paragraph-1', utf8Offset: 8, text: 'X',
      expectedTextDigest: textDigest('Café bold end')
    }])

    expect(updated.revision).toBe(5)
    expect(planningDocumentEffectiveText(updated)).toBe('Café boXld end\nSecond leaf')
    expect(updated.suggestions).toEqual([
      expect.objectContaining({
        id: deterministicDocumentSuggestionId('edit-insert', 0, 'insert'),
        groupId: deterministicDocumentSuggestionGroupId('edit-insert', 0),
        editId: 'edit-insert', kind: 'insert', blockId: 'paragraph-1',
        utf8Start: 8, utf8End: 9,
        content: [{ text: 'X', bold: true }]
      })
    ])
  })

  test('keeps boundary insertions and replacement text unmarked while preserving untouched marks', () => {
    const document = createRichDocument()
    const boundaryInserted = applyDocumentChangeOperations(document, 'edit-boundary', [{
      kind: 'insert', blockId: 'paragraph-1', utf8Offset: 6, text: 'plain',
      expectedTextDigest: textDigest('Café bold end')
    }])
    expect(boundaryInserted.suggestions[0]).toMatchObject({ content: [{ text: 'plain' }] })

    const replaced = applyDocumentChangeOperations(document, 'edit-replace', [{
      kind: 'replace', blockId: 'paragraph-1', utf8Start: 6, utf8End: 10, text: 'plain',
      expectedTextDigest: textDigest('Café bold end')
    }])
    expect(planningDocumentEffectiveText(replaced)).toContain('Café plain end')
    expect(replaced.suggestions).toHaveLength(2)
    expect(replaced.suggestions[0]).toMatchObject({ kind: 'delete', content: [{ text: 'bold', bold: true }] })
    expect(replaced.suggestions[1]).toMatchObject({ kind: 'insert', content: [{ text: 'plain' }] })
    expect(replaced.suggestions[0].groupId).toBe(replaced.suggestions[1].groupId)
  })

  test('keeps deleted rich text as a red-decoration payload but excludes it from effective text', () => {
    const document = createRichDocument()
    const updated = applyDocumentChangeOperations(document, 'edit-delete', [{
      kind: 'delete', blockId: 'paragraph-1', utf8Start: 3, utf8End: 10,
      expectedTextDigest: textDigest('Café bold end')
    }])

    expect(planningDocumentEffectiveText(updated)).toBe('Caf end\nSecond leaf')
    expect(updated.suggestions).toEqual([
      expect.objectContaining({
        kind: 'delete', utf8Start: 3, utf8End: 3,
        content: [{ text: 'é ' }, { text: 'bold', bold: true }]
      })
    ])
  })

  test('accepts or rejects one linked group atomically and increments revision once per action', () => {
    const document = createRichDocument()
    const proposed = applyDocumentChangeOperations(document, 'edit-replace', [{
      kind: 'replace', blockId: 'paragraph-1', utf8Start: 6, utf8End: 10, text: 'plain',
      expectedTextDigest: textDigest('Café bold end')
    }])

    const accepted = acceptDocumentSuggestion(proposed, proposed.suggestions[0].id)
    expect(accepted.revision).toBe(6)
    expect(accepted.suggestions).toEqual([])
    expect(planningDocumentEffectiveText(accepted)).toContain('Café plain end')

    const rejected = rejectDocumentSuggestion(proposed, proposed.suggestions[1].id)
    expect(rejected.revision).toBe(6)
    expect(rejected.suggestions).toEqual([])
    expect(rejected.blocks).toEqual(document.blocks)
  })

  test('accepts and rejects all pending changes in one revision each', () => {
    const document = createRichDocument()
    const proposed = applyDocumentChangeOperations(document, 'edit-two-leaves', [
      { kind: 'insert', blockId: 'paragraph-1', utf8Offset: 0, text: 'First: ', expectedTextDigest: textDigest('Café bold end') },
      { kind: 'delete', blockId: 'item-1', utf8Start: 0, utf8End: 7, expectedTextDigest: textDigest('Second leaf') }
    ])

    const accepted = acceptAllDocumentSuggestions(proposed)
    expect(accepted.revision).toBe(6)
    expect(accepted.suggestions).toEqual([])
    expect(planningDocumentEffectiveText(accepted)).toBe('First: Café bold end\nleaf')

    const rejected = rejectAllDocumentSuggestions(proposed)
    expect(rejected.revision).toBe(6)
    expect(rejected.suggestions).toEqual([])
    expect(rejected.blocks).toEqual(document.blocks)
  })

  test.each([
    { label: 'inside a multibyte code point', operations: [{ kind: 'insert', blockId: 'paragraph-1', utf8Offset: 4, text: 'x', expectedTextDigest: textDigest('Café bold end') }] },
    { label: 'wrapper rather than text leaf', operations: [{ kind: 'insert', blockId: 'list-1', utf8Offset: 0, text: 'x', expectedTextDigest: textDigest('Second leaf') }] },
    { label: 'stale leaf digest', operations: [{ kind: 'delete', blockId: 'paragraph-1', utf8Start: 0, utf8End: 1, expectedTextDigest: textDigest('stale') }] },
    { label: 'overlapping same-base ranges', operations: [
      { kind: 'delete', blockId: 'paragraph-1', utf8Start: 0, utf8End: 6, expectedTextDigest: textDigest('Café bold end') },
      { kind: 'replace', blockId: 'paragraph-1', utf8Start: 3, utf8End: 10, text: 'x', expectedTextDigest: textDigest('Café bold end') }
    ] }
  ] as Array<{ label: string; operations: DocumentChangeOperation[] }>)('rejects $label atomically', ({ operations }) => {
    const document = createRichDocument()
    expect(() => applyDocumentChangeOperations(document, 'edit-invalid', operations)).toThrow()
    expect(document).toEqual(createRichDocument())
  })

  test('rejects cross-block text and an operation on a leaf with an unresolved suggestion', () => {
    const document = createRichDocument()
    expect(() => applyDocumentChangeOperations(document, 'edit-cross-block', [{
      kind: 'delete', blockId: 'paragraph-1', utf8Start: 0, utf8End: 1,
      expectedTextDigest: textDigest('Café bold end'), endBlockId: 'item-1'
    } as DocumentChangeOperation])).toThrow('document_change_unknown_attribute')

    const pending = applyDocumentChangeOperations(document, 'edit-first', [{
      kind: 'insert', blockId: 'paragraph-1', utf8Offset: 0, text: 'x', expectedTextDigest: textDigest('Café bold end')
    }])
    expect(() => applyDocumentChangeOperations(pending, 'edit-second', [{
      kind: 'insert', blockId: 'paragraph-1', utf8Offset: 0, text: 'y', expectedTextDigest: textDigest('xCafé bold end')
    }])).toThrow('document_change_pending_leaf')
  })
})
