export interface AcquiredFixtureHandles {
  projectId: string | null
  assetId: string | null
}

interface FixtureCleanupOperations {
  deleteProject: (id: string) => Promise<void>
  deleteAsset: (id: string) => Promise<void>
}

export interface AcquiredFixtureGraph {
  projectIds: Array<string | null>
  assetIds: Array<string | null>
}

export const cleanupAcquiredFixtures = async (
  handles: AcquiredFixtureHandles,
  operations: FixtureCleanupOperations
): Promise<void> => cleanupAcquiredFixtureGraph({
  projectIds: [handles.projectId],
  assetIds: [handles.assetId]
}, operations)

export const cleanupAcquiredFixtureGraph = async (
  handles: AcquiredFixtureGraph,
  operations: FixtureCleanupOperations
): Promise<void> => {
  const projectIds = uniqueHandles(handles.projectIds)
  const assetIds = uniqueHandles(handles.assetIds)
  const projectErrors = rejectedReasons(await Promise.allSettled(
    projectIds.map(id => operations.deleteProject(id))
  ))
  if (projectErrors.length > 0) {
    throw new AggregateError(projectErrors, 'Fixture project cleanup failed; referenced assets were retained')
  }

  const assetErrors = rejectedReasons(await Promise.allSettled(
    assetIds.map(id => operations.deleteAsset(id))
  ))
  if (assetErrors.length > 0) throw new AggregateError(assetErrors, 'Fixture asset cleanup failed')
}

const uniqueHandles = (handles: Array<string | null>): string[] => (
  [...new Set(handles.filter((id): id is string => Boolean(id)))]
)

const rejectedReasons = (results: PromiseSettledResult<void>[]): unknown[] => (
  results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
)
