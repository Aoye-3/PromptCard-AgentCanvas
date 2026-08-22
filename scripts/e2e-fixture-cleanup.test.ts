import { describe, expect, it, vi } from 'vitest'
import { cleanupAcquiredFixtures } from './e2e-fixture-cleanup'

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

  it('still attempts asset cleanup and reports the error when project cleanup fails', async () => {
    const projectError = new Error('project cleanup failed')
    const deleteProject = vi.fn().mockRejectedValue(projectError)
    const deleteAsset = vi.fn().mockResolvedValue(undefined)

    await expect(cleanupAcquiredFixtures(
      { projectId: 'project-created', assetId: 'asset-created' },
      { deleteProject, deleteAsset }
    )).rejects.toMatchObject({ errors: [projectError] })

    expect(deleteProject).toHaveBeenCalledWith('project-created')
    expect(deleteAsset).toHaveBeenCalledWith('asset-created')
  })
})
