import type { AgentPromptHandoffBasis } from '@/models/Agent.model'
import type { PlanningDocumentBlockV1, PlanningDocumentV1 } from '@/models/PromptHistory.model'
import { sha256Utf8 } from './planning-document'

const MAX_PROMPT_HANDOFF_BYTES = 100_000

export function createDocumentPromptHandoffBasis(
  document: PlanningDocumentV1,
  nodeId: string,
  blockId: string,
  utf16Start: number,
  utf16End: number
): Extract<AgentPromptHandoffBasis, { kind: 'document-selection' }> | null {
  const text = documentLeafText(document.blocks, blockId)
  if (text === null
    || !Number.isSafeInteger(utf16Start) || !Number.isSafeInteger(utf16End)
    || utf16Start < 0 || utf16End <= utf16Start || utf16End > text.length) return null
  const selectedText = text.slice(utf16Start, utf16End)
  if (!selectedText || selectedText !== selectedText.normalize('NFC')) return null
  const utf8Start = new TextEncoder().encode(text.slice(0, utf16Start)).length
  const utf8End = new TextEncoder().encode(text.slice(0, utf16End)).length
  if (utf8End - utf8Start > MAX_PROMPT_HANDOFF_BYTES) return null
  return {
    kind: 'document-selection', nodeId, documentRevision: document.revision,
    documentDigest: document.digest, blockId, utf8Start, utf8End, selectedText,
    selectedTextDigest: `sha256:${sha256Utf8(selectedText)}`
  }
}

export function matchesDocumentPromptHandoffBasis(
  document: PlanningDocumentV1,
  basis: Extract<AgentPromptHandoffBasis, { kind: 'document-selection' }>
): boolean {
  if (basis.documentRevision !== document.revision || basis.documentDigest !== document.digest) return false
  const text = documentLeafText(document.blocks, basis.blockId)
  if (text === null) return false
  const bytes = new TextEncoder().encode(text)
  if (basis.utf8Start < 0 || basis.utf8End <= basis.utf8Start || basis.utf8End > bytes.length) return false
  try {
    const selectedText = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(basis.utf8Start, basis.utf8End))
    return selectedText === basis.selectedText
      && `sha256:${sha256Utf8(selectedText)}` === basis.selectedTextDigest
  } catch {
    return false
  }
}

function documentLeafText(blocks: PlanningDocumentBlockV1[], blockId: string): string | null {
  for (const block of blocks) {
    if ((block.type === 'paragraph' || block.type === 'heading' || block.type === 'blockquote') && block.id === blockId) {
      return block.content.map(item => item.text).join('').normalize('NFC')
    }
    if (block.type === 'bulletList' || block.type === 'orderedList' || block.type === 'checkList') {
      const item = block.items.find(candidate => candidate.id === blockId)
      if (item) return item.content.map(inline => inline.text).join('').normalize('NFC')
    }
    if (block.type === 'table') {
      for (const row of block.rows) {
        const cell = row.cells.find(candidate => candidate.id === blockId)
        if (cell) return cell.content.map(inline => inline.text).join('').normalize('NFC')
      }
    }
  }
  return null
}
