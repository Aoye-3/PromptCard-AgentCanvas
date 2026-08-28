import { describe, expect, test } from 'vitest'
import { getSchema, type JSONContent } from '@tiptap/core'
import { setBlockType, wrapIn } from '@tiptap/pm/commands'
import { wrapInList } from '@tiptap/pm/schema-list'
import { EditorState, TextSelection, type Command } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { createPlanningDocumentV1, planningDocumentEffectiveText } from '@/domain/documents/planning-document'
import type { PlanningDocumentBlockV1 } from '@/models/PromptHistory.model'
import {
  createPlanningDocumentTiptapExtensions,
  createPlanningDocumentBlockIdPlugin,
  createPlanningDocumentEditorProps,
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

  test('accepts only real Tiptap 3.30.3 null defaults across every allowed node and mark', () => {
    const original = createPlanningDocumentV1(blocks(), 5)
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    const canonical = schema.nodeFromJSON(planningDocumentToTiptapJson(original)).toJSON() as JSONContent

    const orderedList = canonical.content?.find(node => node.type === 'orderedList')
    const table = canonical.content?.find(node => node.type === 'table')
    const firstCell = table?.content?.[0]?.content?.[0]
    const link = canonical.content?.[1]?.content?.[1]?.marks?.find(mark => mark.type === 'link')
    expect(orderedList?.attrs).toMatchObject({ start: 1, type: null })
    expect(firstCell?.attrs).toMatchObject({ colspan: 1, rowspan: 1, colwidth: null, align: null })
    expect(link?.attrs).toMatchObject({ href: 'mailto:author@example.com', title: null })
    expect(planningDocumentFromTiptapJson(canonical, 5)).toEqual(original)

    for (const mutate of [
      (json: JSONContent) => { json.content!.find(node => node.type === 'orderedList')!.attrs!.type = 'A' },
      (json: JSONContent) => { json.content!.find(node => node.type === 'table')!.content![0].content![0].attrs!.align = 'left' },
      (json: JSONContent) => { json.content![1].content![1].marks!.find(mark => mark.type === 'link')!.attrs!.title = 'unsafe' }
    ]) {
      const invalid = structuredClone(canonical)
      mutate(invalid)
      expect(() => planningDocumentFromTiptapJson(invalid, 5)).toThrow()
    }
  })

  test.each([
    ['paragraph to quote', (schema: ReturnType<typeof getSchema>) => [wrapIn(schema.nodes.blockquote)]],
    ['heading to quote', (schema: ReturnType<typeof getSchema>) => [
      setBlockType(schema.nodes.paragraph), wrapIn(schema.nodes.blockquote)
    ]],
    ['paragraph to bullet list', (schema: ReturnType<typeof getSchema>) => [wrapInList(schema.nodes.bulletList)]],
    ['paragraph to ordered list', (schema: ReturnType<typeof getSchema>) => [wrapInList(schema.nodes.orderedList)]],
    ['paragraph to task list', (schema: ReturnType<typeof getSchema>) => [wrapInList(schema.nodes.taskList)]]
  ] as Array<[string, (schema: ReturnType<typeof getSchema>) => Command[]]>)('canonicalizes real %s transactions without nested paragraph IDs', (label, commands) => {
    const source = createPlanningDocumentV1([label.startsWith('heading')
      ? { id: 'source-leaf', type: 'heading', level: 2, content: [{ text: 'Draft' }] }
      : { id: 'source-leaf', type: 'paragraph', content: [{ text: 'Draft' }] }
    ])
    const generated = ['outer-list', 'fallback-1', 'fallback-2']
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    let state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(planningDocumentToTiptapJson(source)),
      plugins: [createPlanningDocumentBlockIdPlugin(() => generated.shift() || 'unexpected')]
    })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)))

    commands(schema).forEach(command => {
      expect(command(state, transaction => { state = state.apply(transaction) })).toBe(true)
    })
    const canonical = state.doc.toJSON()
    const nestedParagraphs: JSONContent[] = []
    walkJson(canonical, (node, parent) => {
      if (node.type === 'paragraph' && parent?.type !== 'doc') nestedParagraphs.push(node)
    })
    expect(nestedParagraphs.length).toBeGreaterThan(0)
    expect(nestedParagraphs.map(node => node.attrs?.blockId ?? null)).toEqual(nestedParagraphs.map(() => null))
    const roundTripped = planningDocumentFromTiptapJson(canonical, 1)
    expect(allNeutralIds(roundTripped.blocks)).toContain('source-leaf')
    expect(new Set(allNeutralIds(roundTripped.blocks)).size).toBe(allNeutralIds(roundTripped.blocks).length)
  })

  test.each([
    ['paragraph', createPlanningDocumentV1([{ id: 'paragraph-1', type: 'paragraph', content: [{ text: 'Draft' }] }])],
    ['list item', createPlanningDocumentV1([{ id: 'list-1', type: 'bulletList', items: [{ id: 'item-1', content: [{ text: 'Draft' }] }] }])],
    ['task item', createPlanningDocumentV1([{ id: 'tasks-1', type: 'checkList', items: [{ id: 'task-1', checked: false, content: [{ text: 'Draft' }] }] }])],
    ['table cell', createPlanningDocumentV1([{ id: 'table-1', type: 'table', rows: [{ id: 'row-1', cells: [{ id: 'cell-1', content: [{ text: 'Draft' }] }] }] }])]
  ])('pastes text/plain into the selected %s without splitting its outer structure', (_label, document) => {
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    let state = EditorState.create({ schema, doc: schema.nodeFromJSON(planningDocumentToTiptapJson(document)) })
    let textPosition = 0
    state.doc.descendants((node, position) => {
      if (textPosition === 0 && node.isText) textPosition = position + 1
    })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, textPosition)))
    const initialTopType = state.doc.firstChild?.type.name
    const initialTopCount = state.doc.childCount
    const view = {
      get state() { return state },
      dispatch(transaction) { state = state.apply(transaction) }
    } as Pick<EditorView, 'state' | 'dispatch'> as EditorView
    const event = {
      clipboardData: { files: [], getData: (type: string) => type === 'text/plain' ? 'A\nB' : '<b>unsafe</b>' }
    } as unknown as ClipboardEvent

    expect(createPlanningDocumentEditorProps(() => 'paste-id').handlePaste?.(view, event, null as never)).toBe(true)
    expect(state.doc.childCount).toBe(initialTopCount)
    expect(state.doc.firstChild?.type.name).toBe(initialTopType)
    expect(planningDocumentEffectiveText(planningDocumentFromTiptapJson(state.doc.toJSON(), 1))).toContain('A\nB')
  })

  test.each([
    ['HTML-only content', { files: [], getData: (type: string) => type === 'text/html' ? '<b>unsafe</b>' : '' }],
    ['file content', { files: [{ name: 'unsafe.bin' }], getData: () => 'unsafe' }]
  ])('rejects %s without dispatching an editor transaction', (_label, clipboardData) => {
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    const state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(planningDocumentToTiptapJson(createPlanningDocumentV1([
        { id: 'paragraph-1', type: 'paragraph', content: [{ text: 'Before' }] }
      ])))
    })
    let dispatched = false
    const view = { state, dispatch: () => { dispatched = true } } as Pick<EditorView, 'state' | 'dispatch'> as EditorView
    const event = { clipboardData } as unknown as ClipboardEvent

    expect(createPlanningDocumentEditorProps().handlePaste?.(view, event, null as never)).toBe(true)
    expect(dispatched).toBe(false)
  })

  test('serializes a real link-removal transaction as persistable neutral text without href', () => {
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    const original = createPlanningDocumentV1([
      { id: 'paragraph-1', type: 'paragraph', content: [{ text: 'linked', href: 'https://example.test/path' }] }
    ])
    let state = EditorState.create({ schema, doc: schema.nodeFromJSON(planningDocumentToTiptapJson(original)) })

    state = state.apply(state.tr.removeMark(1, 7, schema.marks.link))
    const neutral = planningDocumentFromTiptapJson(state.doc.toJSON(), 1)

    expect(neutral.blocks[0]).toMatchObject({
      id: 'paragraph-1',
      content: [{ text: 'linked' }]
    })
    expect(planningDocumentFromTiptapJson(planningDocumentToTiptapJson(neutral), 1)).toEqual(neutral)
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

const walkJson = (
  node: JSONContent,
  visit: (node: JSONContent, parent: JSONContent | null) => void,
  parent: JSONContent | null = null
) => {
  visit(node, parent)
  node.content?.forEach(child => walkJson(child, visit, node))
}

const allNeutralIds = (blocks: PlanningDocumentBlockV1[]): string[] => blocks.flatMap(block => {
  if (block.type === 'bulletList' || block.type === 'orderedList' || block.type === 'checkList') {
    return [block.id, ...block.items.map(item => item.id)]
  }
  if (block.type === 'table') {
    return [block.id, ...block.rows.flatMap(row => [row.id, ...row.cells.map(cell => cell.id)])]
  }
  return [block.id]
})
