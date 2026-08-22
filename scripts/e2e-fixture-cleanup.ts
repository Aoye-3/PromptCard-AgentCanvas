export interface AcquiredFixtureHandles {
  projectId: string | null
  assetId: string | null
}

interface FixtureCleanupOperations {
  deleteProject: (id: string) => Promise<void>
  deleteAsset: (id: string) => Promise<void>
}

export const cleanupAcquiredFixtures = async (
  handles: AcquiredFixtureHandles,
  operations: FixtureCleanupOperations
): Promise<void> => {
  const cleanups: Promise<void>[] = []
  if (handles.projectId) cleanups.push(operations.deleteProject(handles.projectId))
  if (handles.assetId) cleanups.push(operations.deleteAsset(handles.assetId))

  const errors = (await Promise.allSettled(cleanups)).flatMap(result => (
    result.status === 'rejected' ? [result.reason] : []
  ))
  if (errors.length > 0) throw new AggregateError(errors, 'Fixture cleanup failed')
}
