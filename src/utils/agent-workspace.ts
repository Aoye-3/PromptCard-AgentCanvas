import type { ICard } from '@/models/Card.model'
import type { AgentWorkspaceContext } from '@/models/Agent.model'
import type { IFreeCanvasNode, IFreeCanvasProject, IFreeCanvasTextNode, IPromptProject, IStoryboardProject, IThreeStageProject } from '@/models/PromptHistory.model'
import type { IPage } from '@/stores/card-initial-state'
import {
  getSelectedThreeStageFormContext,
  normalizeThreeStagePages,
  syncThreeStageLegacyFields
} from '@/domain/three-stage/three-stage-pages'
import { freeCanvasPresetText, freeCanvasTextDisplay, freeCanvasUserText } from '@/domain/free-canvas/free-canvas-project'
import { planningDocumentEffectiveText } from '@/domain/documents/planning-document'

const MAX_TEXT_LENGTH = 1200
const MAX_CARDS = 60
const MAX_ROWS = 40
const MAX_DOCUMENT_EXCERPT_LENGTH = 240

const compactText = (value: string | undefined) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}...` : text
}

const compactCard = (card: ICard) => ({
  id: card.id,
  type: card.type,
  title: compactText(card.title),
  content: compactText(card.content)
})

export function buildCardWorkspaceContext({
  activeProject,
  pages,
  currentPage,
  currentPrompt,
  selectedCardIds
}: {
  activeProject: IPromptProject
  pages: IPage[]
  currentPage: number
  currentPrompt: string
  selectedCardIds: string[]
}): AgentWorkspaceContext {
  const flattenedCards = pages.flatMap((page, pageIndex) =>
    page.cards.map(card => ({ pageIndex, ...compactCard(card) }))
  )
  const selectedCards = flattenedCards.filter(card => selectedCardIds.includes(card.id))

  return {
    contextId: `card:${activeProject.id}:${currentPage}`,
    mode: 'card-workspace',
    projectId: activeProject.id,
    projectTitle: activeProject.title,
    snapshot: {
      projectType: activeProject.type,
      currentPage,
      pageCount: pages.length,
      selectedCardIds,
      selectedCards,
      cards: flattenedCards.slice(0, MAX_CARDS),
      assembledPrompt: compactText(currentPrompt)
    }
  }
}

export function buildStoryboardWorkspaceContext({
  activeProject,
  storyboard
}: {
  activeProject: IPromptProject
  storyboard: IStoryboardProject
}): AgentWorkspaceContext {
  const activeSequence = storyboard.sequences.find(sequence => sequence.id === storyboard.selectedSequenceId) || storyboard.sequences[0]
  const selectedRow = activeSequence?.rows.find(row => row.id === storyboard.selectedRowId) || activeSequence?.rows[0] || null
  const rows = storyboard.sequences.flatMap(sequence =>
    sequence.rows.map(row => ({
      sequenceId: sequence.id,
      id: row.id,
      cutLabel: compactText(row.cutLabel),
      timeRange: compactText(row.timeRange),
      subject: compactText(row.subject),
      action: compactText(row.action),
      scene: compactText(row.scene),
      camera: compactText(row.camera),
      lighting: compactText(row.lighting),
      audio: compactText(row.audio),
      duration: compactText(row.duration)
    }))
  )

  return {
    contextId: `storyboard:${activeProject.id}:${storyboard.selectedSequenceId || 'sequence'}:${storyboard.selectedRowId || 'row'}`,
    mode: 'storyboard-workspace',
    projectId: activeProject.id,
    projectTitle: activeProject.title,
    snapshot: {
      projectType: activeProject.type,
      aspectRatio: storyboard.aspectRatio,
      selectedSequenceId: storyboard.selectedSequenceId,
      selectedRowId: storyboard.selectedRowId,
      activeSequence: activeSequence ? {
        id: activeSequence.id,
        name: compactText(activeSequence.name),
        description: compactText(activeSequence.description),
        style: compactText(activeSequence.style),
        constraints: compactText(activeSequence.constraints)
      } : null,
      selectedRow: selectedRow ? {
        id: selectedRow.id,
        cutLabel: compactText(selectedRow.cutLabel),
        timeRange: compactText(selectedRow.timeRange),
        subject: compactText(selectedRow.subject),
        action: compactText(selectedRow.action),
        scene: compactText(selectedRow.scene),
        camera: compactText(selectedRow.camera),
        lighting: compactText(selectedRow.lighting),
        audio: compactText(selectedRow.audio),
        duration: compactText(selectedRow.duration)
      } : null,
      sequences: storyboard.sequences.map(sequence => ({
        id: sequence.id,
        name: compactText(sequence.name),
        description: compactText(sequence.description),
        style: compactText(sequence.style),
        constraints: compactText(sequence.constraints),
        rowCount: sequence.rows.length
      })),
      rows: rows.slice(0, MAX_ROWS)
    }
  }
}

export function buildThreeStageWorkspaceContext({
  activeProject,
  threeStage,
  selectedOutput,
  freeCanvas
}: {
  activeProject: IPromptProject
  threeStage: IThreeStageProject
  selectedOutput: string
  freeCanvas?: {
    selectedNodeId?: string | null
    selectedNodeType?: string | null
    selectedMediaAssetId?: string | null
    selectedEdgeId?: string | null
    selectedChainNodeIds?: string[]
    nodes?: Array<{
      id: string
      kind: string
      title?: string
      formId?: string
      mediaAssetId?: string | null
    }>
    selectedChainNodes?: Array<{
      id: string
      kind: string
      title?: string
      formId?: string
      formType?: string
      mediaAssetId?: string | null
      text?: string
      output?: string
    }>
    selectedChainEdges?: Array<{
      id: string
      source: string
      target: string
      label?: string | null
    }>
  }
}): AgentWorkspaceContext {
  const syncedThreeStage = syncThreeStageLegacyFields(threeStage)
  const selectedStage = syncedThreeStage.selectedStage
  const selectedFieldId = syncedThreeStage.selectedFieldId
  const pages = normalizeThreeStagePages(syncedThreeStage)
  const selectedContext = getSelectedThreeStageFormContext(syncedThreeStage)

  return {
    contextId: `three-stage:${activeProject.id}:${selectedContext.page.id}:${selectedContext.form.id}:${selectedFieldId}`,
    mode: 'three-stage-workspace',
    projectId: activeProject.id,
    projectTitle: activeProject.title,
    snapshot: {
      projectType: activeProject.type,
      selectedStage,
      selectedFieldId,
      selectedPageId: selectedContext.page.id,
      selectedItemId: selectedContext.item.id,
      selectedFormId: selectedContext.form.id,
      selectedPairId: null,
      selectedFormType: selectedContext.form.type,
      selectedFormTitle: selectedContext.form.title,
      selectedOutput: compactText(selectedOutput),
      sections: {
        character: compactThreeStageSection(syncedThreeStage.character),
        storyboard: compactThreeStageSection(syncedThreeStage.storyboard),
        videoPrompt: compactThreeStageSection(syncedThreeStage.videoPrompt)
      },
      pages: pages.map(page => ({
        id: page.id,
        title: compactText(page.title),
        selectedItemId: page.selectedItemId,
        items: page.items.map(item => ({
          id: item.id,
          kind: 'form',
          formId: item.form.id,
          formType: item.form.type,
          title: item.form.title,
          number: item.form.number
        }))
      })),
      freeCanvas: freeCanvas ? {
        selectedNodeId: freeCanvas.selectedNodeId || null,
        selectedNodeType: freeCanvas.selectedNodeType || null,
        selectedMediaAssetId: freeCanvas.selectedMediaAssetId || null,
        selectedEdgeId: freeCanvas.selectedEdgeId || null,
        selectedChainNodeIds: (freeCanvas.selectedChainNodeIds || []).slice(0, MAX_CARDS),
        nodes: (freeCanvas.nodes || []).slice(0, MAX_CARDS).map(node => ({
          id: node.id,
          kind: node.kind,
          title: compactText(node.title),
          formId: node.formId,
          mediaAssetId: node.mediaAssetId || null
        })),
        selectedChainNodes: (freeCanvas.selectedChainNodes || []).slice(0, MAX_CARDS).map(node => ({
          id: node.id,
          kind: node.kind,
          title: compactText(node.title),
          formId: node.formId,
          formType: node.formType,
          mediaAssetId: node.mediaAssetId || null,
          text: compactText(node.text),
          output: compactText(node.output)
        })),
        selectedChainEdges: (freeCanvas.selectedChainEdges || []).slice(0, MAX_CARDS).map(edge => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: compactText(edge.label || undefined)
        }))
      } : undefined
    }
  }
}

export function buildFreeCanvasWorkspaceContext({
  activeProject,
  freeCanvas
}: {
  activeProject: IPromptProject
  freeCanvas: IFreeCanvasProject
}): AgentWorkspaceContext {
  const workspaceNodes = freeCanvas.nodes.filter(isWorkspaceFreeCanvasNode)
  const snapshotNodes = workspaceNodes.slice(0, MAX_CARDS)
  const snapshotNodeIds = new Set(snapshotNodes.map(node => node.id))
  const selectedNode = workspaceNodes.find(node => node.id === freeCanvas.selectedNodeId) || null

  return {
    contextId: `free-canvas:${activeProject.id}:${selectedNode?.id || 'canvas'}`,
    mode: 'free-canvas-workspace',
    projectId: activeProject.id,
    projectTitle: activeProject.title,
    snapshot: {
      projectType: activeProject.type,
      selectedNodeId: selectedNode?.id || null,
      selectedNode: selectedNode ? compactFreeCanvasNode(selectedNode) : null,
      nodes: snapshotNodes.map(compactFreeCanvasNode),
      edges: freeCanvas.edges
        .filter(edge => snapshotNodeIds.has(edge.source) && snapshotNodeIds.has(edge.target))
        .slice(0, MAX_CARDS).map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: compactText(edge.label)
      }))
    }
  }
}

function compactThreeStageSection(section: IThreeStageSectionLike) {
  return {
    focusedFieldId: section.focusedFieldId,
    fields: Object.fromEntries(
      Object.entries(section.fields).map(([key, value]) => [key, compactText(String(value))])
    )
  }
}

type IThreeStageSectionLike = IThreeStageProject['character']

type IWorkspaceFreeCanvasNode = Exclude<IFreeCanvasNode, { kind: 'unsupported' }>

function isWorkspaceFreeCanvasNode(node: IFreeCanvasNode): node is IWorkspaceFreeCanvasNode {
  if (node.kind === 'text') return true
  if (node.kind === 'image') return true
  if (node.kind === 'arrow') return true
  if (node.kind === 'image-generator') return true
  if (node.kind === 'document') return true
  if (node.kind === 'storyboard') return true
  if (node.kind === 'unsupported') return false
  const exhaustiveNode: never = node
  return exhaustiveNode
}

function compactFreeCanvasNode(node: IWorkspaceFreeCanvasNode) {
  if (node.kind === 'text') {
    return compactFreeCanvasTextNode(node)
  }
  const identity = {
    id: node.id,
    kind: node.kind,
    title: compactText(node.title)
  }
  if (node.kind === 'image') {
    return { ...identity, assetId: node.assetId || null }
  }
  if (node.kind === 'arrow') {
    return { ...identity, text: compactText(node.text) }
  }
  if (node.kind === 'document') {
    return {
      ...identity,
      revision: node.document.revision,
      digest: node.document.digest,
      excerpt: planningDocumentEffectiveText(node.document).slice(0, MAX_DOCUMENT_EXCERPT_LENGTH)
    }
  }
  if (node.kind === 'storyboard') return identity
  if (node.kind === 'image-generator') return identity
  const exhaustiveNode: never = node
  return exhaustiveNode
}

function compactFreeCanvasTextNode(node: IFreeCanvasTextNode) {
  return {
    id: node.id,
    kind: node.kind,
    title: compactText(node.title),
    displayText: freeCanvasTextDisplay(node),
    presetText: freeCanvasPresetText(node),
    userText: freeCanvasUserText(node),
    revision: Math.max(0, ...node.segments.map(segment => segment.updatedAt)),
    segments: node.segments.map(segment => ({
      id: segment.id,
      source: segment.source,
      text: segment.text,
      color: segment.color
    }))
  }
}
