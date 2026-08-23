import type { IPromptProject } from '@/models/PromptHistory.model'
import { sortProjects } from './project-normalization'
import { validatePublicReferenceCode } from '@/domain/reference-codes/reference-code'
import { clearCanvasNodeReferencePending } from '@/domain/reference-codes/canvas-node-reference-lifecycle'

export interface MergeStoredProjectOptions {
  includeTitle?: boolean
  savedAt?: number
  includeCanvasResponseProjections?: boolean
}

export const mergeStoredProjectMetadata = (
  projects: IPromptProject[],
  storedProject: IPromptProject,
  options: MergeStoredProjectOptions = {}
): IPromptProject[] => {
  let didFindProject = false

  const mergedProjects = projects.map(project => {
    if (project.id !== storedProject.id) return project
    didFindProject = true

    const projectWithProjections = options.includeCanvasResponseProjections
      ? mergeStoredCanvasResponseProjections(project, storedProject)
      : project
    return {
      ...projectWithProjections,
      title: options.includeTitle ? storedProject.title : project.title,
      revision: storedProject.revision,
      updatedAt: Math.max(
        project.updatedAt || 0,
        storedProject.updatedAt || 0,
        options.savedAt || 0
      ),
      lastOpenedAt: Math.max(
        project.lastOpenedAt || 0,
        storedProject.lastOpenedAt || 0,
        options.savedAt || 0
      )
    }
  })

  return didFindProject ? sortProjects(mergedProjects) : projects
}

export const mergeStoredCanvasResponseProjections = (
  localProject: IPromptProject,
  storedProject: IPromptProject
): IPromptProject => {
  if (!localProject.freeCanvas || !storedProject.freeCanvas) return localProject
  const storedNodes = new Map(storedProject.freeCanvas.nodes.map(node => [node.id, node]))
  let changed = false
  const nodes = localProject.freeCanvas.nodes.map(localNode => {
    const storedNode = storedNodes.get(localNode.id)
    if (!storedNode || storedNode.kind !== localNode.kind) return localNode
    const prefix = localNode.kind === 'text' ? 'CVT' : localNode.kind === 'image' ? 'CVM' : null
    const referenceCode = prefix ? validatePublicReferenceCode(storedNode.referenceCode, prefix) : null
    if (!referenceCode) return localNode
    const withCode = localNode.referenceCode === referenceCode
      ? localNode
      : { ...localNode, referenceCode }
    const merged = clearCanvasNodeReferencePending(withCode)
    if (merged !== localNode) changed = true
    return merged
  })
  if (!changed) return localProject
  return { ...localProject, freeCanvas: { ...localProject.freeCanvas, nodes } }
}
