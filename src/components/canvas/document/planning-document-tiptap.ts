import {
  Extension,
  type EditorOptions,
  type Extensions,
  type JSONContent
} from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import {
  BulletList,
  ListItem,
  OrderedList,
  TaskItem,
  TaskList
} from '@tiptap/extension-list'
import {
  Table,
  TableCell,
  TableHeader,
  TableRow
} from '@tiptap/extension-table'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { createPlanningDocumentV1 } from '@/domain/documents/planning-document'
import type {
  PlanningDocumentBlockV1,
  PlanningDocumentV1,
  PlanningInlineV1
} from '@/models/PromptHistory.model'

type IdFactory = () => string

const canonicalIdNodes = new Set([
  'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
  'table', 'tableRow', 'tableHeader', 'tableCell'
])

const PlanningListItem = ListItem.extend({ content: 'paragraph' })
const PlanningTaskItem = TaskItem.extend({ content: 'paragraph' })
const PlanningTableCell = TableCell.extend({ content: 'paragraph' })
const PlanningTableHeader = TableHeader.extend({ content: 'paragraph' })

let generatedIdCounter = 0

export const createPlanningDocumentTiptapExtensions = (
  idFactory: IdFactory = generatePlanningDocumentBlockId
): Extensions => [
  StarterKit.configure({
    bulletList: false,
    code: false,
    codeBlock: false,
    hardBreak: false,
    heading: { levels: [1, 2, 3] },
    horizontalRule: false,
    link: false,
    listItem: false,
    orderedList: false,
    strike: false,
    underline: false
  }),
  BulletList,
  OrderedList,
  PlanningListItem,
  TaskList,
  PlanningTaskItem.configure({ nested: false }),
  Link.configure({
    openOnClick: false,
    autolink: false,
    linkOnPaste: false,
    protocols: ['http', 'https', 'mailto'],
    HTMLAttributes: { target: null, rel: null, class: null }
  }),
  Table.configure({ resizable: false, allowTableNodeSelection: false }),
  TableRow,
  PlanningTableHeader,
  PlanningTableCell,
  planningDocumentBlockIdExtension(idFactory)
]

export const createPlanningDocumentEditorProps = (
  idFactory: IdFactory = generatePlanningDocumentBlockId
): NonNullable<EditorOptions['editorProps']> => ({
  attributes: {
    class: 'planning-document-editor',
    spellcheck: 'true'
  },
  transformPastedHTML: () => '',
  handlePaste: (view, event) => {
    if (event.clipboardData?.files.length) return true
    const text = event.clipboardData?.getData('text/plain')
    if (typeof text !== 'string' || text.length === 0) return true
    const normalized = text.replace(/\r\n?/g, '\n').normalize('NFC')
    const { $from, $to } = view.state.selection
    if ($from.sameParent($to) && $from.parent.type.name === 'paragraph') {
      view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.text(normalized)))
      return true
    }
    const nodes = planningDocumentPlainTextPasteJson(normalized, idFactory)
      .map(node => view.state.schema.nodeFromJSON(node))
    view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0)))
    return true
  },
  handleDrop: () => true
})

export const planningDocumentToTiptapJson = (
  document: Pick<PlanningDocumentV1, 'blocks'>
): JSONContent => ({
  type: 'doc',
  content: document.blocks.map(blockToJson)
})

export const planningDocumentFromTiptapJson = (
  json: JSONContent,
  revision: number
): PlanningDocumentV1 => {
  assertJsonKeys(json, ['type', 'content'])
  if (json.type !== 'doc' || !Array.isArray(json.content)) throw new Error('planning_document_tiptap_invalid_root')
  return createPlanningDocumentV1(json.content.map(blockFromJson), revision)
}

export const planningDocumentPlainTextPasteJson = (
  text: string,
  idFactory: IdFactory = generatePlanningDocumentBlockId
): JSONContent[] => text.replace(/\r\n?/g, '\n').split('\n').map(line => ({
  type: 'paragraph',
  attrs: { blockId: uniqueGeneratedId(new Set(), idFactory) },
  ...(line.length > 0 ? { content: [{ type: 'text', text: line.normalize('NFC') }] } : {})
}))

const planningDocumentBlockIdExtension = (idFactory: IdFactory): Extension => Extension.create({
  name: 'planningDocumentBlockId',
  addGlobalAttributes() {
    return [{
      types: [
        'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem',
        'taskList', 'taskItem', 'table', 'tableRow', 'tableHeader', 'tableCell'
      ],
      attributes: {
        blockId: {
          default: null,
          parseHTML: element => element.getAttribute('data-block-id'),
          renderHTML: attributes => attributes.blockId
            ? { 'data-block-id': String(attributes.blockId) }
            : {}
        }
      }
    }]
  },
  addProseMirrorPlugins() {
    return [createPlanningDocumentBlockIdPlugin(idFactory)]
  }
})

export const createPlanningDocumentBlockIdPlugin = (
  idFactory: IdFactory = generatePlanningDocumentBlockId
): Plugin => new Plugin({
  key: new PluginKey('planningDocumentBlockId'),
  appendTransaction: (transactions, oldState, state) => {
    if (!transactions.some(transaction => transaction.docChanged)) return null
    const seen = new Set<string>()
    const updates: Array<{ position: number; attrs: Record<string, unknown> }> = []
    state.doc.descendants((node, position, parent) => {
      if (node.type.name === 'paragraph' && parent?.type.name !== 'doc') {
        if (node.attrs.blockId !== null && node.attrs.blockId !== undefined) {
          updates.push({ position, attrs: { ...node.attrs, blockId: null } })
        }
        return
      }
      if (!nodeNeedsCanonicalId(node.type.name, parent?.type.name || null)) return
      const current = typeof node.attrs.blockId === 'string' && node.attrs.blockId.length > 0
        ? node.attrs.blockId
        : null
      const inherited = inheritedNestedParagraphId(node.toJSON())
      const previous = previousTextBlockId(oldState.doc.nodeAt(position), node)
      const preferred = current || inherited || previous
      if (preferred && !seen.has(preferred)) {
        seen.add(preferred)
        if (!current) updates.push({ position, attrs: { ...node.attrs, blockId: preferred } })
        return
      }
      const blockId = uniqueGeneratedId(seen, idFactory)
      seen.add(blockId)
      updates.push({ position, attrs: { ...node.attrs, blockId } })
    })
    if (updates.length === 0) return null
    const transaction = state.tr
    updates.forEach(update => transaction.setNodeMarkup(update.position, undefined, update.attrs))
    return transaction
  }
})

const blockToJson = (block: PlanningDocumentBlockV1): JSONContent => {
  if (block.type === 'paragraph' || block.type === 'heading') {
    return {
      type: block.type,
      attrs: {
        blockId: block.id,
        ...(block.type === 'heading' ? { level: block.level } : {})
      },
      ...jsonInlineContent(block.content)
    }
  }
  if (block.type === 'blockquote') {
    return {
      type: 'blockquote',
      attrs: { blockId: block.id },
      content: [{ type: 'paragraph', ...jsonInlineContent(block.content) }]
    }
  }
  if (block.type === 'bulletList' || block.type === 'orderedList') {
    return {
      type: block.type,
      attrs: {
        blockId: block.id,
        ...(block.type === 'orderedList' ? { start: 1 } : {})
      },
      content: block.items.map(item => ({
        type: 'listItem',
        attrs: { blockId: item.id },
        content: [{ type: 'paragraph', ...jsonInlineContent(item.content) }]
      }))
    }
  }
  if (block.type === 'checkList') {
    return {
      type: 'taskList',
      attrs: { blockId: block.id },
      content: block.items.map(item => ({
        type: 'taskItem',
        attrs: { blockId: item.id, checked: item.checked },
        content: [{ type: 'paragraph', ...jsonInlineContent(item.content) }]
      }))
    }
  }
  if (block.type === 'table') {
    return {
      type: 'table',
      attrs: { blockId: block.id },
      content: block.rows.map(row => ({
        type: 'tableRow',
        attrs: { blockId: row.id },
        content: row.cells.map(cell => ({
          type: cell.header === true ? 'tableHeader' : 'tableCell',
          attrs: { blockId: cell.id, colspan: 1, rowspan: 1, colwidth: null },
          content: [{ type: 'paragraph', ...jsonInlineContent(cell.content) }]
        }))
      }))
    }
  }
  throw new Error('planning_document_tiptap_unreachable_block')
}

const blockFromJson = (json: JSONContent): PlanningDocumentBlockV1 => {
  if (json.type === 'paragraph') {
    assertJsonKeys(json, ['type', 'attrs', 'content'])
    return { id: blockId(json), type: 'paragraph', content: inlineContentFromJson(json.content) }
  }
  if (json.type === 'heading') {
    assertJsonKeys(json, ['type', 'attrs', 'content'])
    assertAttrs(json, ['blockId', 'level'])
    if (json.attrs?.level !== 1 && json.attrs?.level !== 2 && json.attrs?.level !== 3) throw new Error('planning_document_tiptap_heading')
    return { id: blockId(json), type: 'heading', level: json.attrs.level, content: inlineContentFromJson(json.content) }
  }
  if (json.type === 'blockquote') {
    assertJsonKeys(json, ['type', 'attrs', 'content'])
    const paragraph = onlyParagraph(json.content)
    return { id: blockId(json), type: 'blockquote', content: inlineContentFromJson(paragraph.content) }
  }
  if (json.type === 'bulletList' || json.type === 'orderedList') {
    assertJsonKeys(json, ['type', 'attrs', 'content'])
    assertAttrs(json, json.type === 'orderedList' ? ['blockId', 'start', 'type'] : ['blockId'])
    if (json.type === 'orderedList' && json.attrs?.start !== undefined && json.attrs.start !== 1) {
      throw new Error('planning_document_tiptap_ordered_start')
    }
    if (json.type === 'orderedList' && json.attrs?.type !== undefined && json.attrs.type !== null) {
      throw new Error('planning_document_tiptap_ordered_type')
    }
    const items = requireContent(json).map(item => {
      if (item.type !== 'listItem') throw new Error('planning_document_tiptap_list_item')
      assertJsonKeys(item, ['type', 'attrs', 'content'])
      const paragraph = onlyParagraph(item.content)
      return { id: blockId(item), content: inlineContentFromJson(paragraph.content) }
    })
    return { id: blockId(json), type: json.type, items }
  }
  if (json.type === 'taskList') {
    assertJsonKeys(json, ['type', 'attrs', 'content'])
    const items = requireContent(json).map(item => {
      if (item.type !== 'taskItem') throw new Error('planning_document_tiptap_task_item')
      assertJsonKeys(item, ['type', 'attrs', 'content'])
      assertAttrs(item, ['blockId', 'checked'])
      if (typeof item.attrs?.checked !== 'boolean') throw new Error('planning_document_tiptap_task_checked')
      const paragraph = onlyParagraph(item.content)
      return { id: blockId(item), checked: item.attrs.checked, content: inlineContentFromJson(paragraph.content) }
    })
    return { id: blockId(json), type: 'checkList', items }
  }
  if (json.type === 'table') {
    assertJsonKeys(json, ['type', 'attrs', 'content'])
    assertAttrs(json, ['blockId', 'style'])
    if (json.attrs?.style !== undefined && json.attrs.style !== null) throw new Error('planning_document_tiptap_table_style')
    const rows = requireContent(json).map(row => {
      if (row.type !== 'tableRow') throw new Error('planning_document_tiptap_table_row')
      assertJsonKeys(row, ['type', 'attrs', 'content'])
      const cells = requireContent(row).map(cell => {
        if (cell.type !== 'tableHeader' && cell.type !== 'tableCell') throw new Error('planning_document_tiptap_table_cell')
        assertJsonKeys(cell, ['type', 'attrs', 'content'])
        assertAttrs(cell, ['blockId', 'colspan', 'rowspan', 'colwidth', 'align'])
        const attrs = cell.attrs || {}
        if ((attrs.colspan ?? 1) !== 1 || (attrs.rowspan ?? 1) !== 1 || (attrs.colwidth ?? null) !== null) {
          throw new Error('planning_document_tiptap_merged_cell')
        }
        if (attrs.align !== undefined && attrs.align !== null) throw new Error('planning_document_tiptap_cell_align')
        const paragraph = onlyParagraph(cell.content)
        return {
          id: blockId(cell),
          ...(cell.type === 'tableHeader' ? { header: true as const } : {}),
          content: inlineContentFromJson(paragraph.content)
        }
      })
      return { id: blockId(row), cells }
    })
    return { id: blockId(json), type: 'table', rows }
  }
  throw new Error('planning_document_tiptap_unknown_node')
}

const jsonInlineContent = (content: PlanningInlineV1[]): Pick<JSONContent, 'content'> => (
  content.length === 0
    ? {}
    : { content: content.map(inlineToJson) }
)

const inlineToJson = (inline: PlanningInlineV1): JSONContent => {
  const marks: Array<{ type: string; attrs?: Record<string, unknown> }> = []
  if (inline.bold === true) marks.push({ type: 'bold' })
  if (inline.italic === true) marks.push({ type: 'italic' })
  if (inline.href) marks.push({ type: 'link', attrs: { href: inline.href, target: null, rel: null, class: null } })
  return { type: 'text', text: inline.text, ...(marks.length > 0 ? { marks } : {}) }
}

const inlineContentFromJson = (content: JSONContent[] | undefined): PlanningInlineV1[] => (
  (content || []).map(node => {
    assertJsonKeys(node, ['type', 'text', 'marks'])
    if (node.type !== 'text' || typeof node.text !== 'string') throw new Error('planning_document_tiptap_inline')
    const inline: PlanningInlineV1 = { text: node.text.normalize('NFC') }
    const seen = new Set<string>()
    ;(node.marks || []).forEach(mark => {
      if (!mark.type || seen.has(mark.type)) throw new Error('planning_document_tiptap_duplicate_mark')
      seen.add(mark.type)
      if (mark.type === 'bold' || mark.type === 'italic') {
        assertJsonKeys(mark, ['type', 'attrs'])
        if (mark.attrs && Object.keys(mark.attrs).length > 0) throw new Error('planning_document_tiptap_mark_attrs')
        inline[mark.type] = true
        return
      }
      if (mark.type === 'link') {
        assertJsonKeys(mark, ['type', 'attrs'])
        assertAttrs(mark, ['href', 'target', 'rel', 'class', 'title'])
        if (typeof mark.attrs?.href !== 'string') throw new Error('planning_document_tiptap_link')
        if ([mark.attrs.target, mark.attrs.rel, mark.attrs.class, mark.attrs.title].some(value => value !== undefined && value !== null)) {
          throw new Error('planning_document_tiptap_link_attrs')
        }
        inline.href = mark.attrs.href.normalize('NFC')
        return
      }
      throw new Error('planning_document_tiptap_unknown_mark')
    })
    return inline
  })
)

const blockId = (json: JSONContent): string => {
  assertAttrs(json, json.type === 'heading' ? ['blockId', 'level'] : permittedAttrs(json.type))
  if (typeof json.attrs?.blockId !== 'string' || json.attrs.blockId.length === 0) {
    throw new Error('planning_document_tiptap_block_id')
  }
  return json.attrs.blockId
}

const permittedAttrs = (type: string | undefined): string[] => {
  if (type === 'orderedList') return ['blockId', 'start', 'type']
  if (type === 'taskItem') return ['blockId', 'checked']
  if (type === 'table') return ['blockId', 'style']
  if (type === 'tableCell' || type === 'tableHeader') return ['blockId', 'colspan', 'rowspan', 'colwidth', 'align']
  return ['blockId']
}

const onlyParagraph = (content: JSONContent[] | undefined): JSONContent => {
  if (!Array.isArray(content) || content.length !== 1 || content[0].type !== 'paragraph') {
    throw new Error('planning_document_tiptap_nested_block')
  }
  assertJsonKeys(content[0], ['type', 'attrs', 'content'])
  if (content[0].attrs && Object.values(content[0].attrs).some(value => value !== null && value !== undefined)) {
    throw new Error('planning_document_tiptap_nested_block_id')
  }
  return content[0]
}

const requireContent = (json: JSONContent): JSONContent[] => {
  if (!Array.isArray(json.content) || json.content.length === 0) throw new Error('planning_document_tiptap_empty_structure')
  return json.content
}

const assertJsonKeys = (json: JSONContent, allowed: string[]): void => {
  const allowedSet = new Set(allowed)
  if (Object.keys(json).some(key => !allowedSet.has(key))) throw new Error('planning_document_tiptap_unknown_attribute')
}

const assertAttrs = (json: JSONContent, allowed: string[]): void => {
  const attrs = json.attrs || {}
  const allowedSet = new Set(allowed)
  if (Object.keys(attrs).some(key => !allowedSet.has(key))) throw new Error('planning_document_tiptap_unknown_attribute')
}

const nodeNeedsCanonicalId = (type: string | undefined, parentType: string | null): boolean => (
  type === 'paragraph' ? parentType === 'doc' : Boolean(type && canonicalIdNodes.has(type))
)

const inheritedNestedParagraphId = (node: JSONContent): string | null => {
  if (node.type !== 'blockquote' && node.type !== 'listItem' && node.type !== 'taskItem') return null
  const paragraph = node.content?.[0]
  const id = paragraph?.type === 'paragraph' ? paragraph.attrs?.blockId : null
  return typeof id === 'string' && id.length > 0 ? id : null
}

const previousTextBlockId = (
  previous: ProseMirrorNode | null,
  current: ProseMirrorNode
): string | null => {
  if (!previous || !current.isTextblock) return null
  if (previous.isTextblock && previous.textContent === current.textContent) {
    const id = previous.attrs.blockId
    return typeof id === 'string' && id.length > 0 ? id : null
  }
  let matched: string | null = null
  const matchLeafContainer = (node: ProseMirrorNode) => {
    if (matched || !previousLeafContainerNodes.has(node.type.name) || node.textContent !== current.textContent) return
    const id = node.attrs.blockId
    if (typeof id === 'string' && id.length > 0) matched = id
  }
  matchLeafContainer(previous)
  previous.descendants(node => {
    matchLeafContainer(node)
    return matched === null
  })
  return matched
}

const previousLeafContainerNodes = new Set(['blockquote', 'listItem', 'taskItem'])

const uniqueGeneratedId = (seen: Set<string>, idFactory: IdFactory): string => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = idFactory()
    if (typeof candidate === 'string' && candidate.length > 0 && !seen.has(candidate)) return candidate
  }
  throw new Error('planning_document_tiptap_id_factory_exhausted')
}

const generatePlanningDocumentBlockId = (): string => {
  generatedIdCounter += 1
  const randomId = globalThis.crypto?.randomUUID?.()
  return randomId ? `document-block-${randomId}` : `document-block-${Date.now()}-${generatedIdCounter}`
}
