import type {
  IFreeCanvasEdge,
  IFreeCanvasImageAnnotation,
  IFreeCanvasImageNode,
  IFreeCanvasNode,
  IFreeCanvasProject,
  PlanningDocumentV1
} from '@/models/PromptHistory.model'
import { markCanvasNodeReferencePending } from '@/domain/reference-codes/canvas-node-reference-lifecycle'
import { clonePlanningDocumentV1 } from '@/domain/documents/planning-document'

export type CanvasFlipAxis = 'horizontal' | 'vertical'

type IndexedNode = { index: number; node: IFreeCanvasNode }
type IndexedEdge = { index: number; edge: IFreeCanvasEdge }

export type CanvasLocalCommand =
  | { kind: 'reorder-node'; nodeId: string; toIndex: number }
  | { kind: 'flip-image'; nodeId: string; axis: CanvasFlipAxis }
  | { kind: 'delete-nodes'; nodeIds: string[] }
  | {
      kind: 'restore-nodes'
      nodes: IndexedNode[]
      edges: IndexedEdge[]
      selectedNodeId: string | null
    }
  | { kind: 'insert-node'; node: IFreeCanvasNode; index: number }
  | {
      kind: 'update-document'
      nodeId: string
      document: PlanningDocumentV1
    }

export interface CanvasCommandApplication {
  project: IFreeCanvasProject
  inverse: CanvasLocalCommand
}

export interface CanvasCommandHistoryEntry {
  undo: CanvasLocalCommand
  redo: CanvasLocalCommand
}

export interface CanvasCommandHistory {
  past: CanvasCommandHistoryEntry[]
  future: CanvasCommandHistoryEntry[]
}

export const createCanvasCommandHistory = (): CanvasCommandHistory => ({
  past: [],
  future: []
})

export const applyCanvasLocalCommand = (
  project: IFreeCanvasProject,
  command: CanvasLocalCommand
): CanvasCommandApplication => {
  if (command.kind === 'reorder-node') {
    const fromIndex = project.nodes.findIndex(node => node.id === command.nodeId)
    if (fromIndex < 0) return { project, inverse: command }
    const toIndex = clampIndex(command.toIndex, project.nodes.length)
    const nodes = [...project.nodes]
    const [node] = nodes.splice(fromIndex, 1)
    nodes.splice(toIndex, 0, node)
    return {
      project: { ...project, nodes },
      inverse: { kind: 'reorder-node', nodeId: command.nodeId, toIndex: fromIndex }
    }
  }

  if (command.kind === 'flip-image') {
    const current = project.nodes.find(node => node.id === command.nodeId)
    if (!current || current.kind !== 'image') return { project, inverse: command }
    const presentation = imagePresentation(current)
    const nextPresentation = command.axis === 'horizontal'
      ? { ...presentation, flipX: !presentation.flipX }
      : { ...presentation, flipY: !presentation.flipY }
    return {
      project: {
        ...project,
        nodes: project.nodes.map(node => node.id === command.nodeId
          ? { ...node, meta: { ...node.meta, presentation: nextPresentation } }
          : node)
      },
      inverse: command
    }
  }

  if (command.kind === 'delete-nodes') {
    const requested = new Set(command.nodeIds)
    const removable = new Set(project.nodes
      .filter(node => requested.has(node.id) && node.meta?.generationState !== 'running')
      .map(node => node.id))
    const removedNodes = project.nodes.flatMap((node, index) => (
      removable.has(node.id) ? [{ index, node: cloneNode(node) }] : []
    ))
    const removedEdges = project.edges.flatMap((edge, index) => (
      removable.has(edge.source) || removable.has(edge.target)
        ? [{ index, edge: { ...edge } }]
        : []
    ))
    return {
      project: {
        ...project,
        nodes: project.nodes.filter(node => !removable.has(node.id)),
        edges: project.edges.filter(edge => !removable.has(edge.source) && !removable.has(edge.target)),
        selectedNodeId: project.selectedNodeId && removable.has(project.selectedNodeId)
          ? null
          : project.selectedNodeId
      },
      inverse: {
        kind: 'restore-nodes',
        nodes: removedNodes,
        edges: removedEdges,
        selectedNodeId: project.selectedNodeId || null
      }
    }
  }

  if (command.kind === 'restore-nodes') {
    const nodes = insertIndexed(project.nodes, command.nodes)
    const edges = insertIndexed(project.edges, command.edges)
    return {
      project: {
        ...project,
        nodes,
        edges,
        selectedNodeId: command.selectedNodeId
      },
      inverse: {
        kind: 'delete-nodes',
        nodeIds: command.nodes.map(item => item.node.id)
      }
    }
  }

  if (command.kind === 'update-document') {
    const current = project.nodes.find(node => node.id === command.nodeId)
    if (!current || current.kind !== 'document') return { project, inverse: command }
    const document = clonePlanningDocumentV1(command.document)
    return {
      project: {
        ...project,
        nodes: project.nodes.map(node => node.id === command.nodeId ? { ...node, document } : node)
      },
      inverse: {
        kind: 'update-document',
        nodeId: command.nodeId,
        document: clonePlanningDocumentV1(current.document)
      }
    }
  }

  const index = clampInsertionIndex(command.index, project.nodes.length)
  const nodes = [...project.nodes]
  nodes.splice(index, 0, cloneNode(command.node))
  return {
    project: {
      ...project,
      nodes,
      selectedNodeId: command.node.id
    },
    inverse: { kind: 'delete-nodes', nodeIds: [command.node.id] }
  }
}

export const executeCanvasLocalCommand = (
  history: CanvasCommandHistory,
  project: IFreeCanvasProject,
  command: CanvasLocalCommand
): { history: CanvasCommandHistory; project: IFreeCanvasProject } => {
  const applied = applyCanvasLocalCommand(project, command)
  if (applied.project === project) return { history, project }
  return {
    project: applied.project,
    history: {
      past: [...history.past, { undo: applied.inverse, redo: cloneCommand(command) }],
      future: []
    }
  }
}

export const undoCanvasLocalCommand = (
  history: CanvasCommandHistory,
  project: IFreeCanvasProject
): { history: CanvasCommandHistory; project: IFreeCanvasProject } => {
  const entry = history.past[history.past.length - 1]
  if (!entry) return { history, project }
  const applied = applyCanvasLocalCommand(project, entry.undo)
  return {
    project: applied.project,
    history: {
      past: history.past.slice(0, -1),
      future: [entry, ...history.future]
    }
  }
}

export const redoCanvasLocalCommand = (
  history: CanvasCommandHistory,
  project: IFreeCanvasProject
): { history: CanvasCommandHistory; project: IFreeCanvasProject } => {
  const entry = history.future[0]
  if (!entry) return { history, project }
  const applied = applyCanvasLocalCommand(project, entry.redo)
  return {
    project: applied.project,
    history: {
      past: [...history.past, entry],
      future: history.future.slice(1)
    }
  }
}

export const duplicateCanvasImageNode = (
  source: IFreeCanvasImageNode,
  id: string,
  offset = 28
): IFreeCanvasImageNode => markCanvasNodeReferencePending({
  ...source,
  id,
  title: `${source.title} 副本`,
  position: {
    x: source.position.x + offset,
    y: source.position.y + offset
  },
  crop: source.crop ? { ...source.crop } : null,
  annotations: source.annotations.map((annotation, index) => cloneAnnotation(annotation, `${id}-annotation-${index + 1}`)),
  meta: {
    ...source.meta,
    duplicatedFromNodeId: source.id
  }
})

const imagePresentation = (node: IFreeCanvasImageNode): { flipX: boolean; flipY: boolean } => {
  const value = node.meta.presentation
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    flipX: record.flipX === true,
    flipY: record.flipY === true
  }
}

const cloneNode = (node: IFreeCanvasNode): IFreeCanvasNode => {
  if (node.kind === 'document') {
    return {
      ...node,
      position: { ...node.position },
      document: clonePlanningDocumentV1(node.document),
      linkedDocumentResourceIds: [...node.linkedDocumentResourceIds],
      ...(node.provenance ? { provenance: structuredClone(node.provenance) } : {}),
      meta: { ...node.meta }
    }
  }
  if (node.kind !== 'image') return { ...node, meta: { ...node.meta } } as IFreeCanvasNode
  return {
    ...node,
    position: { ...node.position },
    crop: node.crop ? { ...node.crop } : null,
    annotations: node.annotations.map(annotation => cloneAnnotation(annotation, annotation.id)),
    meta: { ...node.meta }
  }
}

const cloneCommand = (command: CanvasLocalCommand): CanvasLocalCommand => (
  command.kind === 'update-document'
    ? { ...command, document: clonePlanningDocumentV1(command.document) }
    : command
)

const cloneAnnotation = (
  annotation: IFreeCanvasImageAnnotation,
  id: string
): IFreeCanvasImageAnnotation => ({
  ...annotation,
  id,
  points: annotation.points?.map(point => ({ ...point })),
  meta: { ...annotation.meta }
})

const insertIndexed = <T>(
  current: readonly T[],
  additions: readonly { index: number; [key: string]: unknown }[]
): T[] => {
  const result = [...current]
  additions
    .slice()
    .sort((left, right) => left.index - right.index)
    .forEach(item => {
      const value = ('node' in item ? item.node : item.edge) as T
      result.splice(clampInsertionIndex(item.index, result.length), 0, value)
    })
  return result
}

const clampIndex = (index: number, length: number): number => (
  Math.max(0, Math.min(Math.max(0, length - 1), Math.trunc(index)))
)

const clampInsertionIndex = (index: number, length: number): number => (
  Math.max(0, Math.min(length, Math.trunc(index)))
)
