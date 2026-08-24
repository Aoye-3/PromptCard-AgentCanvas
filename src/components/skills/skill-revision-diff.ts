import type { SkillPackageEntry, SkillRevision } from '@/storage/storage-service-client'

export interface SkillRevisionEntryChange {
  path: string
  status: 'added' | 'removed' | 'modified' | 'unchanged'
  before: SkillPackageEntry | null
  after: SkillPackageEntry | null
}

export function diffSkillRevisions(
  newer: SkillRevision,
  older: SkillRevision
): SkillRevisionEntryChange[] {
  const beforeByPath = new Map(older.entries.map(entry => [entry.path, entry]))
  const afterByPath = new Map(newer.entries.map(entry => [entry.path, entry]))
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort((a, b) => a.localeCompare(b))

  return paths.map(path => {
    const before = beforeByPath.get(path) || null
    const after = afterByPath.get(path) || null
    const status = !before
      ? 'added'
      : !after
        ? 'removed'
        : before.digest === after.digest
          ? 'unchanged'
          : 'modified'
    return { path, status, before, after }
  })
}
