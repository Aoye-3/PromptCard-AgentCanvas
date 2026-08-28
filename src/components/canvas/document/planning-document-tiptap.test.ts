import { describe, expect, test } from 'vitest'
import { getSchema, type JSONContent } from '@tiptap/core'
import { joinBackward, joinUp, lift, setBlockType, splitBlock, wrapIn } from '@tiptap/pm/commands'
import { liftListItem, wrapInList } from '@tiptap/pm/schema-list'
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
  planningDocumentToTiptapJson
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

  test.each([
    ['empty paragraph', [{ id: 'paragraph-empty', type: 'paragraph', content: [] }]],
    ['all inline marks', [{
      id: 'paragraph-marks',
      type: 'paragraph',
      content: [{ text: 'Bold', bold: true }, { text: 'Italic', italic: true }, { text: 'Link', href: 'https://example.com' }]
    }]],
    ['heading levels', [
      { id: 'heading-1', type: 'heading', level: 1, content: [] },
      { id: 'heading-2', type: 'heading', level: 2, content: [] },
      { id: 'heading-3', type: 'heading', level: 3, content: [] }
    ]],
    ['blockquote', [{ id: 'quote-empty', type: 'blockquote', content: [] }]],
    ['bullet list', [{ id: 'bullets', type: 'bulletList', items: [{ id: 'bullet-1', content: [] }] }]],
    ['ordered list', [{ id: 'ordered', type: 'orderedList', items: [{ id: 'ordered-1', content: [] }] }]],
    ['check list', [{ id: 'checks', type: 'checkList', items: [{ id: 'check-1', checked: false, content: [] }] }]],
    ['table headers and cells', [{
      id: 'table',
      type: 'table',
      rows: [
        { id: 'row-header', cells: [{ id: 'header', header: true, content: [] }] },
        { id: 'row-body', cells: [{ id: 'cell', content: [] }] }
      ]
    }]]
  ] as Array<[string, PlanningDocumentBlockV1[]]>)('round-trips the exact accepted neutral AST and digest through real Tiptap 3.30.3: %s', (_label, fixtureBlocks) => {
    const document = createPlanningDocumentV1(fixtureBlocks, 7)
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    const node = schema.nodeFromJSON(planningDocumentToTiptapJson(document))
    const canonical = node.toJSON() as JSONContent

    expect(() => node.check()).not.toThrow()
    expect(planningDocumentFromTiptapJson(canonical, 7)).toEqual(document)
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

  test('keeps an existing paragraph ID when a longer paragraph is inserted at the front', () => {
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    let state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(planningDocumentToTiptapJson(createPlanningDocumentV1([
        { id: 'p1', type: 'paragraph', content: [{ text: 'Old' }] }
      ]))),
      plugins: [createPlanningDocumentBlockIdPlugin(sequenceIds('inserted-long'))]
    })
    const inserted = schema.nodes.paragraph.create(
      { blockId: null },
      schema.text('A substantially longer paragraph inserted before the existing block')
    )

    state = state.apply(state.tr.insert(0, inserted))

    expect(state.doc.toJSON().content?.map((node: JSONContent) => node.attrs?.blockId))
      .toEqual(['inserted-long', 'p1'])
  })

  test('keeps every existing ID when a table is inserted before the first block', () => {
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    let state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(planningDocumentToTiptapJson(createPlanningDocumentV1([
        { id: 'p1', type: 'paragraph', content: [{ text: 'Old' }] }
      ]))),
      plugins: [createPlanningDocumentBlockIdPlugin(sequenceIds('unexpected'))]
    })
    const tableJson = planningDocumentToTiptapJson(createPlanningDocumentV1([{
      id: 'table-new',
      type: 'table',
      rows: [{
        id: 'row-new',
        cells: [
          { id: 'header-new', header: true, content: [{ text: 'Heading' }] },
          { id: 'cell-new', content: [{ text: 'Value' }] }
        ]
      }]
    }])).content?.[0]
    if (!tableJson) throw new Error('Expected table JSON')

    state = state.apply(state.tr.insert(0, schema.nodeFromJSON(tableJson)))

    const roundTripped = planningDocumentFromTiptapJson(state.doc.toJSON(), 1)
    expect(allNeutralIds(roundTripped.blocks)).toEqual(['table-new', 'row-new', 'header-new', 'cell-new', 'p1'])
  })

  test('does not let an identical inserted paragraph steal an existing paragraph ID', () => {
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    let state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(planningDocumentToTiptapJson(createPlanningDocumentV1([
        { id: 'p1', type: 'paragraph', content: [{ text: 'Same' }] }
      ]))),
      plugins: [createPlanningDocumentBlockIdPlugin(sequenceIds('inserted-same'))]
    })

    state = state.apply(state.tr.insert(
      0,
      schema.nodes.paragraph.create({ blockId: null }, schema.text('Same'))
    ))

    expect(state.doc.toJSON().content?.map((node: JSONContent) => node.attrs?.blockId))
      .toEqual(['inserted-same', 'p1'])
  })

  test('does not transfer a deleted block ID to an identical surviving paragraph', () => {
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    let state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(planningDocumentToTiptapJson(createPlanningDocumentV1([
        { id: 'p1', type: 'paragraph', content: [{ text: 'Same' }] },
        { id: 'p2', type: 'paragraph', content: [{ text: 'Same' }] }
      ]))),
      plugins: [createPlanningDocumentBlockIdPlugin(sequenceIds('unexpected'))]
    })
    const first = state.doc.firstChild
    if (!first) throw new Error('Expected first paragraph')

    state = state.apply(state.tr.delete(0, first.nodeSize))

    expect(state.doc.toJSON().content?.map((node: JSONContent) => node.attrs?.blockId)).toEqual(['p2'])
  })

  test.each([
    ['matching blockquote', createPlanningDocumentV1([
      { id: 'p1', type: 'blockquote', content: [{ text: 'Same' }] }
    ]), ['inserted-same', 'p1']],
    ['matching list leaf', createPlanningDocumentV1([{
      id: 'list-outer', type: 'bulletList', items: [{ id: 'p1', content: [{ text: 'Same' }] }]
    }]), ['inserted-same', 'list-outer', 'p1']]
  ] as const)('does not let an inserted paragraph steal an existing %s ID', (_label, source, expectedIds) => {
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    let state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(planningDocumentToTiptapJson(source)),
      plugins: [createPlanningDocumentBlockIdPlugin(sequenceIds('inserted-same', 'unexpected'))]
    })

    state = state.apply(state.tr.insert(
      0,
      schema.nodes.paragraph.create({ blockId: null }, schema.text('Same'))
    ))

    expect(allNeutralIds(planningDocumentFromTiptapJson(state.doc.toJSON(), 1).blocks)).toEqual(expectedIds)
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
    ['blockquote', (schema: ReturnType<typeof getSchema>) => [wrapIn(schema.nodes.blockquote), lift]],
    ['bullet list', (schema: ReturnType<typeof getSchema>) => [wrapInList(schema.nodes.bulletList), liftListItem(schema.nodes.listItem)]],
    ['ordered list', (schema: ReturnType<typeof getSchema>) => [wrapInList(schema.nodes.orderedList), liftListItem(schema.nodes.listItem)]],
    ['task list', (schema: ReturnType<typeof getSchema>) => [wrapInList(schema.nodes.taskList), liftListItem(schema.nodes.taskItem)]],
    ['normalized heading blockquote', (schema: ReturnType<typeof getSchema>) => [
      setBlockType(schema.nodes.paragraph), wrapIn(schema.nodes.blockquote), lift
    ]]
  ] as Array<[string, (schema: ReturnType<typeof getSchema>) => Command[]]>)('preserves the original leaf ID through real %s wrap and unwrap transactions', (label, commands) => {
    const source = createPlanningDocumentV1([label.startsWith('normalized heading')
      ? { id: 'p1', type: 'heading', level: 2, content: [{ text: 'Draft' }] }
      : { id: 'p1', type: 'paragraph', content: [{ text: 'Draft' }] }
    ])
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    let state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(planningDocumentToTiptapJson(source)),
      plugins: [createPlanningDocumentBlockIdPlugin(sequenceIds('container', 'fallback-1', 'fallback-2'))]
    })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)))

    commands(schema).forEach(command => {
      expect(command(state, transaction => { state = state.apply(transaction) })).toBe(true)
    })

    expect(planningDocumentFromTiptapJson(state.doc.toJSON(), 1).blocks[0]).toMatchObject({
      id: 'p1',
      type: 'paragraph',
      content: [{ text: 'Draft' }]
    })
  })

  test('keeps multi-item list IDs unique and stable when one item is unwrapped', () => {
    const source = createPlanningDocumentV1([
      { id: 'p1', type: 'paragraph', content: [{ text: 'First' }] },
      { id: 'p2', type: 'paragraph', content: [{ text: 'Second' }] }
    ])
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    let state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(planningDocumentToTiptapJson(source)),
      plugins: [createPlanningDocumentBlockIdPlugin(sequenceIds('list-outer', 'fallback-1', 'fallback-2'))]
    })
    for (const text of ['First', 'Second']) {
      let textPosition = 0
      state.doc.descendants((node, position) => {
        if (textPosition === 0 && node.isText && node.text === text) textPosition = position + 1
      })
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, textPosition)))
      expect(wrapInList(schema.nodes.bulletList)(state, transaction => { state = state.apply(transaction) })).toBe(true)
    }
    expect(joinUp(state, transaction => { state = state.apply(transaction) })).toBe(true)
    const wrapped = planningDocumentFromTiptapJson(state.doc.toJSON(), 1)
    expect(wrapped.blocks[0]).toMatchObject({ id: 'list-outer', items: [{ id: 'p1' }, { id: 'p2' }] })
    expect(new Set(allNeutralIds(wrapped.blocks)).size).toBe(allNeutralIds(wrapped.blocks).length)

    let firstTextPosition = 0
    state.doc.descendants((node, position) => {
      if (firstTextPosition === 0 && node.isText) firstTextPosition = position + 1
    })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, firstTextPosition)))
    expect(liftListItem(schema.nodes.listItem)(state, transaction => { state = state.apply(transaction) })).toBe(true)
    const unwrapped = planningDocumentFromTiptapJson(state.doc.toJSON(), 2)

    expect(unwrapped.blocks).toMatchObject([
      { id: 'p1', type: 'paragraph', content: [{ text: 'First' }] },
      { id: 'list-outer', type: 'bulletList', items: [{ id: 'p2', content: [{ text: 'Second' }] }] }
    ])
    expect(new Set(allNeutralIds(unwrapped.blocks)).size).toBe(allNeutralIds(unwrapped.blocks).length)
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

  test('keeps the survivor ID on a real merge and gives a real split a fresh ID', () => {
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    let state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(planningDocumentToTiptapJson(createPlanningDocumentV1([
        { id: 'paragraph-1', type: 'paragraph', content: [{ text: 'LeftRight' }] }
      ]))),
      plugins: [createPlanningDocumentBlockIdPlugin(sequenceIds('new-split-id'))]
    })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 5)))
    expect(splitBlock(state, transaction => { state = state.apply(transaction) })).toBe(true)
    expect(state.doc.toJSON().content?.map((node: JSONContent) => node.attrs?.blockId)).toEqual(['paragraph-1', 'new-split-id'])

    let secondTextPosition = 0
    let textCount = 0
    state.doc.descendants((node, position) => {
      if (node.isText && ++textCount === 2) secondTextPosition = position
    })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, secondTextPosition)))
    expect(joinBackward(state, transaction => { state = state.apply(transaction) })).toBe(true)
    expect(state.doc.toJSON().content?.map((node: JSONContent) => node.attrs?.blockId)).toEqual(['paragraph-1'])
  })

  test('regenerates a real inserted duplicate ID while preserving the existing ID', () => {
    const schema = getSchema(createPlanningDocumentTiptapExtensions())
    let state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(planningDocumentToTiptapJson(createPlanningDocumentV1([
        { id: 'heading-1', type: 'heading', level: 1, content: [{ text: 'Draft' }] }
      ]))),
      plugins: [createPlanningDocumentBlockIdPlugin(() => 'pasted-heading-1')]
    })
    const duplicate = state.doc.firstChild
    if (!duplicate) throw new Error('Expected source heading')

    state = state.apply(state.tr.insert(state.doc.content.size, duplicate))

    expect(state.doc.toJSON().content?.map((node: JSONContent) => node.attrs?.blockId)).toEqual(['heading-1', 'pasted-heading-1'])
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

const sequenceIds = (...ids: string[]) => () => ids.shift() || 'unexpected'
