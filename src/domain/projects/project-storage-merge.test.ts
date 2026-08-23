import { describe, expect, test } from 'vitest'
import type { IPromptProject } from '@/models/PromptHistory.model'
import { mergeStoredProjectMetadata } from './project-storage-merge'

const createProject = (overrides: Partial<IPromptProject> = {}): IPromptProject => ({
  id: 'project-1',
  title: 'Local title',
  type: 'three-stage',
  revision: 1,
  pages: [],
  currentPage: 0,
  storyboard: {
    aspectRatio: '16:9',
    sequences: [],
    selectedSequenceId: null,
    selectedRowId: null,
    meta: {}
  },
  threeStage: {
    character: { fields: { notes: 'local character' }, focusedFieldId: null, updatedAt: 100, meta: {} },
    storyboard: { fields: { theme: 'local story' }, focusedFieldId: null, updatedAt: 100, meta: {} },
    videoPrompt: { fields: { prompt: 'local prompt' }, focusedFieldId: null, updatedAt: 100, meta: {} },
    selectedStage: 'character',
    selectedFieldId: 'notes',
    pages: [],
    selectedPageId: null,
    selectedFormId: null,
    selectedPairId: null,
    meta: {}
  },
  createdAt: 1,
  updatedAt: 100,
  lastOpenedAt: 100,
  meta: {},
  ...overrides
})

describe('project storage merge', () => {
  test('preserves local editable content when a stale save response returns later', () => {
    const localProject = createProject({
      threeStage: {
        ...createProject().threeStage!,
        storyboard: { fields: { theme: 'new user edit' }, focusedFieldId: null, updatedAt: 200, meta: {} }
      },
      updatedAt: 200
    })
    const staleStoredProject = createProject({
      revision: 2,
      threeStage: {
        ...createProject().threeStage!,
        storyboard: { fields: { theme: 'old saved value' }, focusedFieldId: null, updatedAt: 100, meta: {} }
      },
      updatedAt: 150,
      lastOpenedAt: 150
    })

    const [merged] = mergeStoredProjectMetadata([localProject], staleStoredProject)

    expect(merged.revision).toBe(2)
    expect(merged.updatedAt).toBe(200)
    expect(merged.lastOpenedAt).toBe(150)
    expect(merged.threeStage?.storyboard.fields.theme).toBe('new user edit')
  })

  test('can apply title-only metadata without replacing card pages', () => {
    const localProject = createProject({
      type: 'card',
      pages: [{ id: 'page-1', cards: [{ id: 'card-1', type: 'subject', title: 'Subject', content: 'local content', mode: 'edit', color: '#fff', createdAt: 1, updatedAt: 2, meta: {} }] }],
      currentPage: 0
    })
    const renamedStoredProject = createProject({
      title: 'Remote title',
      revision: 3,
      pages: [{ id: 'page-1', cards: [{ id: 'card-1', type: 'subject', title: 'Subject', content: 'old content', mode: 'edit', color: '#fff', createdAt: 1, updatedAt: 2, meta: {} }] }]
    })

    const [merged] = mergeStoredProjectMetadata([localProject], renamedStoredProject, { includeTitle: true })

    expect(merged.title).toBe('Remote title')
    expect(merged.revision).toBe(3)
    expect(merged.pages[0].cards[0].content).toBe('local content')
  })

  test('merges only Storage-owned Canvas codes by node id from a late auto-save response', () => {
    const originalCode = 'CVM-01ARZ3NDEKTSV4RRFFQ69G5FAX'
    const copyCode = 'CVM-01ARZ3NDEKTSV4RRFFQ69G5FAY'
    const localProject = createProject({
      type: 'free-canvas',
      freeCanvas: {
        nodes: [
          {
            id: 'original', kind: 'image', title: 'Original', referenceCode: originalCode,
            position: { x: 10, y: 20 }, width: 320, height: 240, annotations: [], meta: {}
          },
          {
            id: 'copy', kind: 'image', title: 'User renamed after save started',
            position: { x: 900, y: 700 }, width: 480, height: 360, annotations: [],
            meta: { duplicatedFromNodeId: 'original', userEdit: 'newer' }
          }
        ],
        edges: [], meta: {}
      },
      updatedAt: 300
    })
    const storedProject = createProject({
      type: 'free-canvas', revision: 2,
      freeCanvas: {
        nodes: [
          {
            id: 'original', kind: 'image', title: 'Original', referenceCode: originalCode,
            position: { x: 10, y: 20 }, width: 320, height: 240, annotations: [], meta: {}
          },
          {
            id: 'copy', kind: 'image', title: 'Old copy title', referenceCode: copyCode,
            position: { x: 38, y: 48 }, width: 320, height: 240, annotations: [],
            meta: { duplicatedFromNodeId: 'original' }
          }
        ],
        edges: [], meta: {}
      },
      updatedAt: 200
    })

    const [merged] = mergeStoredProjectMetadata([localProject], storedProject, {
      includeCanvasResponseProjections: true
    })
    const copy = merged.freeCanvas?.nodes.find(node => node.id === 'copy')

    expect(merged.freeCanvas?.nodes.map(node => node.referenceCode)).toEqual([originalCode, copyCode])
    expect(copy).toMatchObject({
      title: 'User renamed after save started',
      position: { x: 900, y: 700 },
      width: 480,
      height: 360,
      meta: { duplicatedFromNodeId: 'original', userEdit: 'newer' }
    })
  })
})
