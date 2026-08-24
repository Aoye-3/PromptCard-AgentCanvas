import { describe, expect, it } from 'vitest'
import type { SkillRevision } from '@/storage/storage-service-client'
import { diffSkillRevisions } from './skill-revision-diff'

const revision = (revisionNumber: number, entries: SkillRevision['entries']): SkillRevision => ({
  revision: revisionNumber,
  digest: `sha256:${revisionNumber}`,
  instructions: '',
  references: [],
  createdAt: revisionNumber,
  provenance: {},
  declaredCapabilities: {},
  entries,
  trustReview: null
})

const item = (path: string, digest: string) => ({
  type: 'reference' as const,
  path,
  contentType: 'text/markdown',
  size: 10,
  digest
})

describe('diffSkillRevisions', () => {
  it('returns stable added, removed, modified, and unchanged entry changes', () => {
    const newer = revision(2, [
      item('same.md', 'same'),
      item('changed.md', 'new'),
      item('added.md', 'added')
    ])
    const older = revision(1, [
      item('same.md', 'same'),
      item('changed.md', 'old'),
      item('removed.md', 'removed')
    ])

    expect(diffSkillRevisions(newer, older)).toEqual([
      { path: 'added.md', status: 'added', before: null, after: newer.entries[2] },
      { path: 'changed.md', status: 'modified', before: older.entries[1], after: newer.entries[1] },
      { path: 'removed.md', status: 'removed', before: older.entries[2], after: null },
      { path: 'same.md', status: 'unchanged', before: older.entries[0], after: newer.entries[0] }
    ])
  })
})
