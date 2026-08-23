import { describe, expect, it, vi } from 'vitest'
import { cleanupAcquiredFixtureGraph, cleanupAcquiredFixtures } from './e2e-fixture-cleanup'

describe('cleanupAcquiredFixtures', () => {
  it('cleans an uploaded asset when project acquisition failed', async () => {
    const deleteProject = vi.fn()
    const deleteAsset = vi.fn().mockResolvedValue(undefined)

    await cleanupAcquiredFixtures(
      { projectId: null, assetId: 'asset-created' },
      { deleteProject, deleteAsset }
    )

    expect(deleteProject).not.toHaveBeenCalled()
    expect(deleteAsset).toHaveBeenCalledWith('asset-created')
  })

  it('tries every project but safely skips referenced assets when one project cleanup fails', async () => {
    const projectError = new Error('project cleanup failed')
    const deleteProject = vi.fn()
      .mockRejectedValueOnce(projectError)
      .mockResolvedValueOnce(undefined)
    const deleteAsset = vi.fn().mockResolvedValue(undefined)

    await expect(cleanupAcquiredFixtureGraph(
      { projectIds: ['project-first', 'project-second'], assetIds: ['asset-created'] },
      { deleteProject, deleteAsset }
    )).rejects.toMatchObject({ errors: [projectError] })

    expect(deleteProject.mock.calls).toEqual([['project-first'], ['project-second']])
    expect(deleteAsset).not.toHaveBeenCalled()
  })

  it('deletes assets only after every acquired project has been cleaned', async () => {
    const order: string[] = []
    const deleteProject = vi.fn(async (id: string) => { order.push(`project:${id}`) })
    const deleteAsset = vi.fn(async (id: string) => { order.push(`asset:${id}`) })

    await cleanupAcquiredFixtureGraph(
      { projectIds: ['project-first', 'project-second'], assetIds: ['asset-created'] },
      { deleteProject, deleteAsset }
    )

    expect(order.slice(0, 2).sort()).toEqual(['project:project-first', 'project:project-second'])
    expect(order[2]).toBe('asset:asset-created')
  })
})
