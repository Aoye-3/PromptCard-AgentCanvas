import { describe, expect, test } from 'vitest'
import { getSchema, type JSONContent } from '@tiptap/core'
import { createPlanningDocumentV1 } from '@/domain/documents/planning-document'
import type { PlanningDocumentBlockV1 } from '@/models/PromptHistory.model'
import {
  createPlanningDocumentTiptapExtensions,
  planningDocumentFromTiptapJson,
  planningDocumentPlainTextPasteJson,
  planningDocumentToTiptapJson,
  repairPlanningDocumentTiptapIds
} from './planning-document-tiptap'

const blocks = (): PlanningDocumentBlockV1[] => [
  { id: 'heading-1', type: 'heading', level: 1, content: [{ text: 'Draft', bold: true }] },
  { id: 'paragraph-1', type: 'paragraph', content: [{ text: 'Opening ', italic: true }, { text: 'link', href: 'mailto:author@example.com' }] },
  { id: 'quote-1', type: 'blockquote', content: [{ text: 'A private plan' }] },
  { id: 'bullet-list-1', type: 'bulletList', items: [{ id: 'bullet-1', content: [{ text: 'Character' }] }] },
  { id: 'ordered-list-1', type: 'orderedList', items: [{ id: 'ordered-1', content: [{ text: 'Scene' }] }] },
  { id: 'check-list-1', type: 'checkList', items: [{ id: 'check-1', checked: true, content: [{ text: 'Reviewed' }] }] },
  {
    id: 'table-1',
    type: 'table',
    rows: [
      { id: 'row-1', cells: [{ id: 'cell-1', header: true, content: [{ text: 'Shot' }] }] },
      { id: 'row-2', cells: [{ id: 'cell-2', content: [{ text: '1' }] }] }
    ]
  }
]

describe('planning document Tiptap adapter', () => {
  test('round-trips every neutral block and mark without regenerating stable IDs', () => {
    const original = createPlanningDocumentV1(blocks(), 5)

    const json = planningDocumentToTiptapJson(original)
    const roundTripped = planningDocumentFromTiptapJson(json, 5)

    expect(roundTripped).toEqual(original)
    expect(JSON.stringify(json)).not.toContain('suggestion')
  })

  test('builds only the restricted schema', () => {
    const schema = getSchema(createPlanningDocumentTiptapExtensions())

    expect(Object.keys(schema.nodes)).toEqual(expect.arrayContaining([
      'doc', 'text', 'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem',
      'taskList', 'taskItem', 'table', 'tableRow', 'tableHeader', 'tableCell'
    ]))
    expect(Object.keys(schema.nodes)).not.toEqual(expect.arrayContaining([
      'codeBlock', 'hardBreak', 'horizontalRule'
    ]))
    expect(Object.keys(schema.marks)).toEqual(expect.arrayContaining(['bold', 'italic', 'link']))
    expect(Object.keys(schema.marks)).not.toEqual(expect.arrayContaining(['code', 'strike', 'underline']))
  })

  test.each([
    ['unknown node', { type: 'doc', content: [{ type: 'codeBlock', attrs: { blockId: 'code-1' } }] }],
    ['unknown mark', { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text: 'x', marks: [{ type: 'strike' }] }] }] }],
    ['unknown attribute', { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'p1', align: 'center' }, content: [] }] }],
    ['nested list', {
      type: 'doc',
      content: [{
        type: 'bulletList', attrs: { blockId: 'list-1' }, content: [{
          type: 'listItem', attrs: { blockId: 'item-1' }, content: [
            { type: 'paragraph', content: [] },
            { type: 'bulletList', attrs: { blockId: 'nested-list' }, content: [] }
          ]
        }]
      }]
    }],
    ['merged table cell', {
      type: 'doc',
      content: [{
        type: 'table', attrs: { blockId: 'table-1' }, content: [{
          type: 'tableRow', attrs: { blockId: 'row-1' }, content: [{
            type: 'tableCell', attrs: { blockId: 'cell-1', colspan: 2, rowspan: 1, colwidth: null }, content: [{ type: 'paragraph' }]
          }]
        }]
      }]
    }],
    ['unsafe link', { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] }]
  ] as Array<[string, JSONContent]>)('rejects %s instead of weakening the neutral contract', (_label, json) => {
    expect(() => planningDocumentFromTiptapJson(json, 0)).toThrow()
  })

  test('keeps the survivor ID on merge and gives a split duplicate a fresh ID', () => {
    const nextIds = ['new-split-id']
    const splitJson: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { blockId: 'paragraph-1' }, content: [{ type: 'text', text: 'Left' }] },
        { type: 'paragraph', attrs: { blockId: 'paragraph-1' }, content: [{ type: 'text', text: 'Right' }] }
      ]
    }

    const repaired = repairPlanningDocumentTiptapIds(splitJson, () => nextIds.shift() || 'unexpected')
    const survivor = repaired.content?.[0]
    if (!survivor) throw new Error('Expected repaired paragraph')
    const merged: JSONContent = { type: 'doc', content: [survivor] }

    expect(repaired.content?.map(node => node.attrs?.blockId)).toEqual(['paragraph-1', 'new-split-id'])
    expect(repairPlanningDocumentTiptapIds(merged, () => 'unused').content?.[0].attrs?.blockId).toBe('paragraph-1')
  })

  test('regenerates pasted duplicate IDs while preserving every existing ID', () => {
    const json = planningDocumentToTiptapJson(createPlanningDocumentV1(blocks()))
    const source = json.content?.[0]
    if (!source) throw new Error('Expected source heading')
    const duplicate = structuredClone(source)
    json.content?.push(duplicate)

    const repaired = repairPlanningDocumentTiptapIds(json, () => 'pasted-heading-1')

    expect(repaired.content?.[0].attrs?.blockId).toBe('heading-1')
    expect(repaired.content?.[repaired.content.length - 1]?.attrs?.blockId).toBe('pasted-heading-1')
  })

  test('turns text/plain paste into NFC paragraphs with fresh IDs and no marks', () => {
    const ids = ['paste-1', 'paste-2']

    expect(planningDocumentPlainTextPasteJson('Cafe\u0301\r\nSecond', () => ids.shift() || 'unexpected')).toEqual([
      { type: 'paragraph', attrs: { blockId: 'paste-1' }, content: [{ type: 'text', text: 'Café' }] },
      { type: 'paragraph', attrs: { blockId: 'paste-2' }, content: [{ type: 'text', text: 'Second' }] }
    ])
  })
})
