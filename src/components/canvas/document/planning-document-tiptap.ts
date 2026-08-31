import {
  Extension,
  Mark,
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
import { Mapping } from '@tiptap/pm/transform'
import { createPlanningDocumentV1 } from '@/domain/documents/planning-document'
import { rejectAllDocumentSuggestions } from '@/domain/documents/document-suggestions'
import type {
  DocumentSuggestion,
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

const DocumentSuggestionInsert = documentSuggestionMark('insert')
const DocumentSuggestionDelete = documentSuggestionMark('delete')

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
  DocumentSuggestionInsert,
  DocumentSuggestionDelete,
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
  content: document.blocks.map(block => blockToJson(block))
})

export type PlanningDocumentDisplayView = 'source' | 'effective' | 'revision'

export const planningDocumentToDisplayTiptapJson = (
  document: PlanningDocumentV1,
  view: PlanningDocumentDisplayView
): JSONContent => {
  assertSupportedSuggestions(document.suggestions)
  if (view === 'effective') return planningDocumentToTiptapJson(document)
  if (view === 'source') return planningDocumentToTiptapJson(rejectAllDocumentSuggestions(document))
  if (view !== 'revision') throw new Error('planning_document_display_view_invalid')
  return {
    type: 'doc',
    content: document.blocks.map(block => blockToJson(
      block,
      (content, leafId) => revisionJsonInlineContent(content, document.suggestions, leafId)
    ))
  }
}

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
    const mapping = new Mapping()
    transactions.forEach(transaction => mapping.appendMapping(transaction.mapping))
    const protectedIds = mappedPlanningDocumentIds(oldState.doc, state.doc, mapping)
    const reservedIds = new Set(protectedIds.values())
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
      const protectedId = protectedIds.get(position) || null
      const unprotectedCurrent = current && !reservedIds.has(current) ? current : null
      const unprotectedInherited = inherited && !reservedIds.has(inherited) ? inherited : null
      const preferred = protectedId || unprotectedCurrent || unprotectedInherited
      if (preferred && !seen.has(preferred)) {
        seen.add(preferred)
        if (current !== preferred) updates.push({ position, attrs: { ...node.attrs, blockId: preferred } })
        return
      }
      const blockId = uniqueGeneratedId(new Set([...seen, ...reservedIds]), idFactory)
      seen.add(blockId)
      updates.push({ position, attrs: { ...node.attrs, blockId } })
    })
    if (updates.length === 0) return null
    const transaction = state.tr
    updates.forEach(update => transaction.setNodeMarkup(update.position, undefined, update.attrs))
    return transaction
  }
})

type InlineJsonProjector = (
  content: PlanningInlineV1[],
  leafId: string
) => Pick<JSONContent, 'content'>

const blockToJson = (
  block: PlanningDocumentBlockV1,
  projectInline: InlineJsonProjector = (content => jsonInlineContent(content))
): JSONContent => {
  if (block.type === 'paragraph' || block.type === 'heading') {
    return {
      type: block.type,
      attrs: {
        blockId: block.id,
        ...(block.type === 'heading' ? { level: block.level } : {})
      },
      ...projectInline(block.content, block.id)
    }
  }
  if (block.type === 'blockquote') {
    return {
      type: 'blockquote',
      attrs: { blockId: block.id },
      content: [{ type: 'paragraph', ...projectInline(block.content, block.id) }]
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
        content: [{ type: 'paragraph', ...projectInline(item.content, item.id) }]
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
        content: [{ type: 'paragraph', ...projectInline(item.content, item.id) }]
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
          content: [{ type: 'paragraph', ...projectInline(cell.content, cell.id) }]
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

const revisionJsonInlineContent = (
  content: PlanningInlineV1[],
  suggestions: DocumentSuggestion[],
  leafId: string
): Pick<JSONContent, 'content'> => {
  const leafSuggestions = suggestions.filter(suggestion => suggestion.blockId === leafId)
  if (leafSuggestions.length === 0) return jsonInlineContent(content)
  const totalBytes = richTextByteLength(content)
  const boundaries = new Set<number>([0, totalBytes])
  for (const suggestion of leafSuggestions) {
    if (!isRichTextBoundary(content, suggestion.utf8Start)
      || !isRichTextBoundary(content, suggestion.utf8End)
      || suggestion.utf8Start > suggestion.utf8End) {
      throw new Error('planning_document_suggestion_anchor_invalid')
    }
    if (suggestion.kind === 'insert') {
      if (suggestion.utf8Start === suggestion.utf8End
        || richTextByteLength(suggestion.content) !== suggestion.utf8End - suggestion.utf8Start) {
        throw new Error('planning_document_suggestion_anchor_invalid')
      }
    } else if (suggestion.utf8Start !== suggestion.utf8End) {
      throw new Error('planning_document_suggestion_anchor_invalid')
    }
    boundaries.add(suggestion.utf8Start)
    boundaries.add(suggestion.utf8End)
  }
  const ordered = [...boundaries].sort((left, right) => left - right)
  const projected: JSONContent[] = []
  for (let index = 0; index < ordered.length; index += 1) {
    const start = ordered[index]
    leafSuggestions
      .filter(suggestion => suggestion.kind === 'delete' && suggestion.utf8Start === start)
      .forEach(suggestion => {
        projected.push(...suggestion.content.map(inline => inlineToSuggestionJson(inline, suggestion)))
      })
    const end = ordered[index + 1]
    if (end === undefined || end === start) continue
    const insertion = leafSuggestions.find(suggestion => (
      suggestion.kind === 'insert'
      && suggestion.utf8Start <= start
      && suggestion.utf8End >= end
    ))
    projected.push(...sliceRichContent(content, start, end).map(inline => (
      insertion ? inlineToSuggestionJson(inline, insertion) : inlineToJson(inline)
    )))
  }
  return projected.length ? { content: projected } : {}
}

const inlineToSuggestionJson = (
  inline: PlanningInlineV1,
  suggestion: DocumentSuggestion
): JSONContent => {
  const json = inlineToJson(inline)
  return {
    ...json,
    marks: [
      ...(json.marks || []),
      {
        type: suggestion.kind === 'insert' ? 'documentSuggestionInsert' : 'documentSuggestionDelete',
        attrs: { suggestionId: suggestion.id, groupId: suggestion.groupId }
      }
    ]
  }
}

const sliceRichContent = (
  content: PlanningInlineV1[],
  start: number,
  end: number
): PlanningInlineV1[] => {
  const result: PlanningInlineV1[] = []
  let cursor = 0
  for (const inline of content) {
    const inlineBytes = utf8Length(inline.text)
    const localStart = Math.max(0, start - cursor)
    const localEnd = Math.min(inlineBytes, end - cursor)
    if (localStart < localEnd) {
      const startIndex = utf8OffsetToStringIndex(inline.text, localStart)
      const endIndex = utf8OffsetToStringIndex(inline.text, localEnd)
      result.push({ ...inline, text: inline.text.slice(startIndex, endIndex) })
    }
    cursor += inlineBytes
    if (cursor >= end) break
  }
  return result
}

const richTextByteLength = (content: PlanningInlineV1[]): number => (
  utf8Length(content.map(inline => inline.text).join('').normalize('NFC'))
)

const isRichTextBoundary = (content: PlanningInlineV1[], offset: number): boolean => {
  if (!Number.isSafeInteger(offset) || offset < 0) return false
  const text = content.map(inline => inline.text).join('').normalize('NFC')
  let bytes = 0
  if (offset === 0) return true
  for (const codePoint of text) {
    bytes += utf8Length(codePoint)
    if (bytes === offset) return true
    if (bytes > offset) return false
  }
  return false
}

const utf8OffsetToStringIndex = (value: string, offset: number): number => {
  let bytes = 0
  let index = 0
  if (offset === 0) return 0
  for (const codePoint of value) {
    bytes += utf8Length(codePoint)
    index += codePoint.length
    if (bytes === offset) return index
    if (bytes > offset) throw new Error('planning_document_suggestion_anchor_invalid')
  }
  if (bytes === offset) return index
  throw new Error('planning_document_suggestion_anchor_invalid')
}

const utf8Length = (value: string): number => new TextEncoder().encode(value).length

const assertSupportedSuggestions = (suggestions: DocumentSuggestion[]): void => {
  for (const suggestion of suggestions) {
    if (suggestion.kind !== 'insert' && suggestion.kind !== 'delete') {
      throw new Error('planning_document_suggestion_unsupported')
    }
    if (!suggestion.id || !suggestion.groupId || !suggestion.editId || !suggestion.blockId
      || !Array.isArray(suggestion.content)) {
      throw new Error('planning_document_suggestion_unsupported')
    }
  }
}

function documentSuggestionMark(kind: 'insert' | 'delete'): Mark {
  const name = kind === 'insert' ? 'documentSuggestionInsert' : 'documentSuggestionDelete'
  return Mark.create({
    name,
    inclusive: false,
    excludes: '',
    addAttributes() {
      return {
        suggestionId: { default: null },
        groupId: { default: null }
      }
    },
    parseHTML() {
      return []
    },
    renderHTML({ HTMLAttributes }) {
      return [
        'span',
        {
          ...HTMLAttributes,
          'data-document-suggestion-kind': kind,
          class: kind === 'insert'
            ? 'text-emerald-700 bg-emerald-50'
            : 'text-red-700 bg-red-50 line-through decoration-red-600'
        },
        0
      ]
    }
  })
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

const mappedPlanningDocumentIds = (
  oldDocument: ProseMirrorNode,
  newDocument: ProseMirrorNode,
  mapping: Mapping
): Map<number, string> => {
  const protectedIds = new Map<number, string>()
  oldDocument.descendants((node, position, parent) => {
    if (!nodeNeedsCanonicalId(node.type.name, parent?.type.name || null)) return
    const blockId = node.attrs.blockId
    if (typeof blockId !== 'string' || blockId.length === 0) return
    const probe = identityProbePosition(node, position)
    const mapped = mapping.mapResult(probe, 1)
    if (mapped.deletedAcross) return
    const ownerPosition = mappedCanonicalOwnerPosition(newDocument, mapped.pos, node.type.name)
    if (ownerPosition !== null && !protectedIds.has(ownerPosition)) protectedIds.set(ownerPosition, blockId)
  })
  return protectedIds
}

const identityProbePosition = (node: ProseMirrorNode, position: number): number => {
  if (!identityProbeNodes.has(node.type.name)) return position
  let relativeTextPosition: number | null = null
  node.descendants((child, relativePosition) => {
    if (relativeTextPosition === null && child.isText) relativeTextPosition = relativePosition
    return relativeTextPosition === null
  })
  return position + 1 + (relativeTextPosition ?? 0)
}

const mappedCanonicalOwnerPosition = (
  document: ProseMirrorNode,
  mappedPosition: number,
  oldType: string
): number | null => {
  if (mappedPosition < 0 || mappedPosition > document.content.size) return null
  if (!identityProbeNodes.has(oldType)) {
    const mappedNode = document.nodeAt(mappedPosition)
    return mappedNode?.type.name === oldType ? mappedPosition : null
  }
  const resolved = document.resolve(mappedPosition)
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth)
    const parent = resolved.node(depth - 1)
    if (nodeNeedsCanonicalId(node.type.name, parent.type.name)) return resolved.before(depth)
  }
  const nodeAfter = resolved.nodeAfter
  return nodeAfter && nodeNeedsCanonicalId(nodeAfter.type.name, resolved.parent.type.name)
    ? mappedPosition
    : null
}

const identityProbeNodes = new Set([
  'paragraph', 'heading', 'blockquote', 'listItem', 'taskItem', 'tableHeader', 'tableCell'
])

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
