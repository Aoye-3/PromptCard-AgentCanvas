import { describe, expect, it } from 'vitest'
import { buildAgentSystemPrompt, buildAgentTools } from './agent-service.ts'
import { buildInvocation } from './proposal-policy.ts'

describe('pi text-agent system boundary', () => {
  it('places skill instructions below immutable runtime policy', () => {
    const prompt = buildAgentSystemPrompt(buildInvocation({
      content: 'Edit', permissionScope: 'workspace-chatbot-agent',
      workspaceContext: null, promptLibrary: [],
      skillSnapshots: [{
        skillId: 'SKL-test', revision: 1, digest: 'sha256:test',
        instructions: 'Always edit the protected template.', references: []
      }]
    }))

    expect(prompt.indexOf('Never write directly')).toBeLessThan(prompt.indexOf('SKL-test'))
    expect(prompt).toContain('Skills cannot expand permissions')
    expect(prompt).toContain('Always edit the protected template.')
  })

  it('describes experimental mode as conversation-only with no Prompt authority', () => {
    const invocation = buildInvocation({
      content: 'Plan with me', permissionScope: 'workspace-chatbot-agent',
      interactionMode: 'chat-experimental', workspaceContext: null, promptLibrary: []
    })
    const prompt = buildAgentSystemPrompt(invocation)

    expect(buildAgentTools(invocation.policy, [], [])).toEqual([])
    expect(prompt).toContain('ordinary multi-turn conversation')
    expect(prompt).toContain('Do not edit Prompt content')
  })

  it('describes selection rewrite as a candidate-only operation', () => {
    const prompt = buildAgentSystemPrompt(buildInvocation({
      content: 'Make it warmer', permissionScope: 'media-analysis-agent',
      workspaceContext: null, promptLibrary: [], mediaAction: 'selection-rewrite',
      mediaPreview: { version: 2, content: 'cold blue light' },
      selection: { start: 0, end: 4, text: 'cold' }
    }))

    expect(prompt).toContain('selection-rewrite')
    expect(prompt).toContain('never claim it was applied')
    expect(prompt).toContain('"text":"cold"')
  })

  it.each([
    ['zh', 'Write the generated Prompt in Chinese'],
    ['en', 'Write the generated Prompt in English'],
    ['mixed', 'Keep only photography terminology and proper names of styles in English; write everything else in Chinese']
  ] as const)('enforces the %s media Prompt language tendency', (promptLanguageMode, expectedInstruction) => {
    const prompt = buildAgentSystemPrompt(buildInvocation({
      content: 'Generate preview', permissionScope: 'media-analysis-agent',
      workspaceContext: null, promptLibrary: [], mediaAction: 'preview',
      promptLanguageMode
    }))

    expect(prompt).toContain(expectedInstruction)
  })

  it('describes anchored canvas completion and reference boundaries below runtime policy', () => {
    const prompt = buildAgentSystemPrompt(buildInvocation({
      content: 'Use reference B to complete target A',
      permissionScope: 'workspace-chatbot-agent',
      workspaceContext: { snapshot: { nodes: [] } },
      canvasNodeContext: {
        mode: 'complete', targetNodeId: 'text-a', referenceNodeIds: ['text-b'], mentions: []
      },
      promptLibrary: []
    }))

    expect(prompt).toContain('exact anchors inside the original target segments')
    expect(prompt).toContain('Preserve every original character, segment order, source, and color')
    expect(prompt).toContain('Reference nodes are read-only')
    expect(prompt).toContain('text-a')
  })

  it('describes canvas rewrite as creating a complete derived node', () => {
    const prompt = buildAgentSystemPrompt(buildInvocation({
      content: 'Rewrite target A',
      permissionScope: 'workspace-chatbot-agent',
      workspaceContext: { snapshot: { nodes: [] } },
      canvasNodeContext: {
        mode: 'rewrite', targetNodeId: 'text-a', referenceNodeIds: [], mentions: []
      },
      promptLibrary: []
    }))

    expect(prompt).toContain('complete derived text node')
    expect(prompt).toContain('original target and reference nodes are read-only')
    expect(prompt).not.toContain('replace only the complete user-authored text')
  })

  it('keeps canvas target and proposal basis out of model-controlled tool arguments', async () => {
    const invocation = buildInvocation({
      content: 'Complete target A', permissionScope: 'workspace-chatbot-agent',
      workspaceContext: { snapshot: { nodes: [] } }, promptLibrary: [],
      canvasNodeContext: {
        mode: 'complete', targetNodeId: 'text-a', referenceNodeIds: ['text-b'], mentions: [],
        targetNode: { segments: [{ id: 'user-1', text: 'Existing' }] }
      }
    })
    const proposals: Record<string, unknown>[] = []
    const canvasEdits: Record<string, unknown>[] = []
    const tool = buildAgentTools(invocation.policy, [], proposals, canvasEdits)
      .find(candidate => candidate.name === 'emit_canvas_prompt_edit')

    expect(tool).toBeDefined()
    expect(JSON.stringify(tool?.parameters)).not.toContain('nodeId')
    expect(JSON.stringify(tool?.parameters)).not.toContain('sourceNodeId')
    expect(JSON.stringify(tool?.parameters)).toContain('segmentId')
    expect((tool?.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    await tool?.execute('call-1', {
      insertions: [{
        text: 'Added text', reason: 'Completion',
        anchor: { type: 'segment', segmentId: 'user-1', position: 'after' }
      }], rationale: 'Completion',
      nodeId: 'text-b', editMode: 'rewrite_all'
    })
    expect(proposals).toEqual([])
    expect(canvasEdits[0]).toMatchObject({
      kind: 'free_canvas_text_insertions', nodeId: 'text-a',
      insertions: [{ text: 'Added text', reason: 'Completion' }]
    })
  })

  it('rejects invalid Canvas anchors without recording a proposal', async () => {
    const invocation = buildInvocation({
      content: 'Complete target A', permissionScope: 'workspace-chatbot-agent',
      workspaceContext: { snapshot: { nodes: [] } }, promptLibrary: [],
      canvasNodeContext: {
        mode: 'complete', targetNodeId: 'text-a', referenceNodeIds: [], mentions: [],
        targetNode: {
          segments: [
            { id: 'segment-1', text: 'Repeated anchor and Repeated anchor' },
            { id: 'segment-2', text: 'Other text' }
          ]
        }
      }
    })
    const proposals: Record<string, unknown>[] = []
    const canvasEdits: Record<string, unknown>[] = []
    const tool = buildAgentTools(invocation.policy, [], proposals, canvasEdits)
      .find(candidate => candidate.name === 'emit_canvas_prompt_edit')

    const missing = await tool?.execute('call-missing', {
      insertions: [{
        text: 'Added text', reason: 'Completion',
        anchor: { type: 'segment', segmentId: 'missing', position: 'after' }
      }], rationale: 'Completion'
    })
    const ambiguous = await tool?.execute('call-ambiguous', {
      insertions: [{
        text: 'Added text', reason: 'Completion',
        anchor: { type: 'text', segmentId: 'segment-1', text: 'Repeated anchor', position: 'after' }
      }], rationale: 'Completion'
    })
    const invalidPosition = await tool?.execute('call-position', {
      insertions: [{
        text: 'Added text', reason: 'Completion',
        anchor: { type: 'segment', segmentId: 'segment-2', position: 'inside' }
      }], rationale: 'Completion'
    })

    expect(proposals).toEqual([])
    expect(canvasEdits).toEqual([])
    expect(JSON.stringify(missing)).toContain('not found')
    expect(JSON.stringify(ambiguous)).toContain('exactly once')
    expect(JSON.stringify(invalidPosition)).toContain('before or after')
  })

  it('does not construct a canvas update tool without an explicit target', () => {
    const invocation = buildInvocation({
      content: 'Discuss reference B', permissionScope: 'workspace-chatbot-agent',
      workspaceContext: { snapshot: { nodes: [] } }, promptLibrary: [],
      canvasNodeContext: {
        mode: 'rewrite', targetNodeId: null, referenceNodeIds: ['text-b'], mentions: []
      }
    })

    expect(buildAgentTools(invocation.policy, [], []))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'emit_canvas_prompt_edit' })]))
  })

  it('uses the same edit tool to emit a rewrite as a direct derived-node result', async () => {
    const invocation = buildInvocation({
      content: 'Rewrite target', permissionScope: 'workspace-chatbot-agent',
      workspaceContext: { snapshot: { nodes: [] } }, promptLibrary: [],
      canvasNodeContext: {
        mode: 'rewrite', targetNodeId: 'text-a', referenceNodeIds: [], mentions: []
      }
    })
    const proposals: Record<string, unknown>[] = []
    const canvasEdits: Record<string, unknown>[] = []
    const tool = buildAgentTools(invocation.policy, [], proposals, canvasEdits)
      .find(candidate => candidate.name === 'emit_canvas_prompt_edit')

    await tool?.execute('call-1', { userText: 'Rewritten prompt', rationale: 'Clarity' })

    expect(proposals).toEqual([])
    expect(canvasEdits[0]).toMatchObject({
      kind: 'free_canvas_text_create', sourceNodeId: 'text-a', userText: 'Rewritten prompt'
    })
  })

  it('does not expose Prompt Library search during ordinary Canvas editing', () => {
    const invocation = buildInvocation({
      content: 'Complete target', permissionScope: 'workspace-chatbot-agent',
      workspaceContext: { snapshot: { nodes: [] } },
      promptLibrary: [{ label: 'Architecture', content: 'brutalist concrete' }],
      canvasNodeContext: {
        mode: 'complete', targetNodeId: 'text-a', referenceNodeIds: [], mentions: []
      }
    })

    expect(invocation.promptLibrary).toEqual([])
    expect(buildAgentTools(invocation.policy, invocation.promptLibrary, []).map(tool => tool.name))
      .not.toContain('search_prompt_library')
  })

  it('exposes read-only Prompt Library search with linked media in retrieval mode', async () => {
    const invocation = buildInvocation({
      content: 'Find architecture prompts', permissionScope: 'workspace-chatbot-agent',
      workspaceContext: { snapshot: { nodes: [] } },
      promptLibrary: [{
        label: 'Architecture', content: 'brutalist concrete',
        meta: { media: [{ id: 'media-1', title: 'Concrete reference' }] }
      }],
      canvasNodeContext: {
        mode: 'prompt-library', targetNodeId: null, referenceNodeIds: [], mentions: []
      }
    })
    const tools = buildAgentTools(invocation.policy, invocation.promptLibrary, [])
    const search = tools.find(tool => tool.name === 'search_prompt_library')

    expect(invocation.policy.allowedProposalKinds).toEqual([])
    expect(search).toBeDefined()
    expect(JSON.stringify(await search?.execute('call-1', { query: 'concrete' }))).toContain('media-1')
  })

  it('exposes a closed editor-neutral document create schema and injects resource context', async () => {
    const invocation = documentCreateInvocation()
    const canvasEdits: Record<string, unknown>[] = []
    const tool = buildAgentTools(invocation.policy, invocation.promptLibrary, [], canvasEdits)
      .find(candidate => candidate.name === 'emit_document_create')
    const schema = JSON.stringify(tool?.parameters)

    expect(tool).toBeDefined()
    expect((tool?.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    expect(schema).toContain('paragraph')
    expect(schema).toContain('checkList')
    expect(schema).toContain('table')
    expect(schema).not.toContain('projectId')
    expect(schema).not.toContain('conversationId')
    expect(schema).not.toContain('requestId')
    expect(schema).not.toContain('nodeId')
    expect(schema).not.toContain('baseRevision')
    expect(schema).not.toContain('baseDigest')
    expect(schema).not.toContain('linkedDocumentResourceIds')
    expect(schema).not.toContain('tiptap')
    expect(schema).not.toContain('patch')

    const result = await tool?.execute('call-create', {
      title: '  Story Caf\u0065\u0301  ',
      blocks: [{ id: 'paragraph-a', type: 'paragraph', content: [{ text: 'Caf\u0065\u0301' }] }],
      rationale: '  Establish a working draft.  '
    })

    expect(result?.terminate).toBe(true)
    expect(canvasEdits).toEqual([{
      kind: 'document_create',
      payload: {
        title: 'Story Caf\u00e9',
        blocks: [{ id: 'paragraph-a', type: 'paragraph', content: [{ text: 'Caf\u00e9' }] }],
        linkedDocumentResourceIds: ['resource-a']
      },
      rationale: 'Establish a working draft.'
    }])
  })

  it.each([
    ['Tiptap JSON', {
      title: 'Bad', blocks: [{ type: 'doc', content: [{ type: 'paragraph' }] }], rationale: 'No'
    }],
    ['JSON Patch', {
      title: 'Bad', blocks: [{ op: 'replace', path: '/blocks/0', value: 'x' }], rationale: 'No'
    }],
    ['Prompt target', {
      title: 'Bad', blocks: [{ id: 'p', type: 'paragraph', content: [{ text: 'x' }] }],
      rationale: 'No', nodeId: 'prompt-a'
    }],
    ['wrapper content', {
      title: 'Bad', blocks: [{
        id: 'list-a', type: 'bulletList', content: [{ text: 'not-items' }], items: []
      }], rationale: 'No'
    }]
  ])('rejects %s document create arguments without consuming the write slot', async (_label, invalid) => {
    const invocation = documentCreateInvocation()
    const canvasEdits: Record<string, unknown>[] = []
    const tool = buildAgentTools(invocation.policy, [], [], canvasEdits)
      .find(candidate => candidate.name === 'emit_document_create')

    const rejected = await tool?.execute('call-invalid', invalid)
    const accepted = await tool?.execute('call-valid', {
      title: 'Valid',
      blocks: [{ id: 'p', type: 'paragraph', content: [{ text: 'Valid' }] }],
      rationale: 'Create it'
    })

    expect(rejected?.terminate).toBe(false)
    expect(JSON.stringify(rejected)).toContain('document_')
    expect(accepted?.terminate).toBe(true)
    expect(canvasEdits).toHaveLength(1)
  })

  it('rejects oversized create text and block counts', async () => {
    const invocation = documentCreateInvocation()
    const canvasEdits: Record<string, unknown>[] = []
    const tool = buildAgentTools(invocation.policy, [], [], canvasEdits)
      .find(candidate => candidate.name === 'emit_document_create')
    const tooManyBlocks = Array.from({ length: 129 }, (_, index) => ({
      id: `p-${index}`, type: 'paragraph', content: [{ text: 'x' }]
    }))

    const blocks = await tool?.execute('call-blocks', {
      title: 'Too many', blocks: tooManyBlocks, rationale: 'No'
    })
    const text = await tool?.execute('call-text', {
      title: 'Too large',
      blocks: [{ id: 'p', type: 'paragraph', content: [{ text: 'x'.repeat(100_001) }] }],
      rationale: 'No'
    })

    expect(JSON.stringify(blocks)).toContain('document_block_budget_exceeded')
    expect(JSON.stringify(text)).toContain('document_text_budget_exceeded')
    expect(canvasEdits).toEqual([])
  })

  it('injects the bound Document/base/digests and validates NFC UTF-8 byte anchors', async () => {
    const invocation = documentChangesInvocation()
    const canvasEdits: Record<string, unknown>[] = []
    const tool = buildAgentTools(invocation.policy, [], [], canvasEdits)
      .find(candidate => candidate.name === 'emit_document_changes')
    const schema = JSON.stringify(tool?.parameters)

    expect(tool).toBeDefined()
    expect((tool?.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    expect(schema).not.toContain('nodeId')
    expect(schema).not.toContain('baseRevision')
    expect(schema).not.toContain('baseDigest')
    expect(schema).not.toContain('expectedTextDigest')
    expect(schema).not.toContain('projectId')

    await tool?.execute('call-changes', {
      operations: [
        { kind: 'insert', blockId: 'paragraph-a', utf8Offset: 5, text: ' noir' },
        { kind: 'replace', blockId: 'paragraph-b', utf8Start: 0, utf8End: 4, text: 'New' }
      ],
      rationale: 'Tighten both blocks'
    })

    expect(canvasEdits).toEqual([{
      kind: 'document_changes',
      payload: {
        nodeId: 'document-a',
        baseRevision: 7,
        baseDigest: 'sha256:document-a',
        operations: [
          {
            kind: 'insert', blockId: 'paragraph-a', utf8Offset: 5, text: ' noir',
            expectedTextDigest: 'sha256:paragraph-a'
          },
          {
            kind: 'replace', blockId: 'paragraph-b', utf8Start: 0, utf8End: 4, text: 'New',
            expectedTextDigest: 'sha256:paragraph-b'
          }
        ]
      },
      rationale: 'Tighten both blocks'
    }])
  })

  it.each([
    ['inside a UTF-8 code point', { kind: 'insert', blockId: 'paragraph-a', utf8Offset: 4, text: 'x' }],
    ['outside the block', { kind: 'delete', blockId: 'paragraph-a', utf8Start: 0, utf8End: 99 }],
    ['a missing block', { kind: 'insert', blockId: 'missing', utf8Offset: 0, text: 'x' }],
    ['a wrapper block', { kind: 'insert', blockId: 'list-wrapper', utf8Offset: 0, text: 'x' }],
    ['a cross-block range', {
      kind: 'delete', blockId: 'paragraph-a', endBlockId: 'paragraph-b', utf8Start: 0, utf8End: 1
    }],
    ['a Prompt target', {
      kind: 'insert', blockId: 'paragraph-a', utf8Offset: 0, text: 'x', nodeId: 'prompt-a'
    }],
    ['a model-reported stale base', {
      kind: 'insert', blockId: 'paragraph-a', utf8Offset: 0, text: 'x',
      baseRevision: 6, baseDigest: 'sha256:stale', expectedTextDigest: 'sha256:forged'
    }],
    ['a lone surrogate', {
      kind: 'insert', blockId: 'paragraph-a', utf8Offset: 0, text: '\ud800'
    }]
  ])('rejects changes with %s without consuming the write slot', async (_label, operation) => {
    const invocation = documentChangesInvocation()
    const canvasEdits: Record<string, unknown>[] = []
    const tool = buildAgentTools(invocation.policy, [], [], canvasEdits)
      .find(candidate => candidate.name === 'emit_document_changes')

    const rejected = await tool?.execute('call-invalid', { operations: [operation], rationale: 'Invalid' })
    const accepted = await tool?.execute('call-valid', {
      operations: [{ kind: 'insert', blockId: 'paragraph-a', utf8Offset: 5, text: '!' }],
      rationale: 'Valid'
    })

    expect(rejected?.terminate).toBe(false)
    expect(JSON.stringify(rejected)).toContain('document_')
    expect(accepted?.terminate).toBe(true)
    expect(canvasEdits).toHaveLength(1)
  })

  it('rejects oversized operation counts and inserted text', async () => {
    const invocation = documentChangesInvocation()
    const canvasEdits: Record<string, unknown>[] = []
    const tool = buildAgentTools(invocation.policy, [], [], canvasEdits)
      .find(candidate => candidate.name === 'emit_document_changes')
    const operations = Array.from({ length: 65 }, () => ({
      kind: 'insert', blockId: 'paragraph-a', utf8Offset: 0, text: 'x'
    }))

    const count = await tool?.execute('call-count', { operations, rationale: 'Too many' })
    const text = await tool?.execute('call-text', {
      operations: [{
        kind: 'insert', blockId: 'paragraph-a', utf8Offset: 0, text: 'x'.repeat(100_001)
      }], rationale: 'Too much'
    })

    expect(JSON.stringify(count)).toContain('document_operation_budget_exceeded')
    expect(JSON.stringify(text)).toContain('document_text_budget_exceeded')
    expect(canvasEdits).toEqual([])
  })

  it('allows at most one successful write tool call per turn', async () => {
    const invocation = documentChangesInvocation()
    const canvasEdits: Record<string, unknown>[] = []
    const tool = buildAgentTools(invocation.policy, [], [], canvasEdits)
      .find(candidate => candidate.name === 'emit_document_changes')
    const params = {
      operations: [{ kind: 'insert', blockId: 'paragraph-a', utf8Offset: 5, text: '!' }],
      rationale: 'One edit'
    }

    const first = await tool?.execute('call-first', params)
    const second = await tool?.execute('call-second', params)

    expect(first?.terminate).toBe(true)
    expect(second?.terminate).toBe(false)
    expect(JSON.stringify(second)).toContain('write_tool_already_used')
    expect(canvasEdits).toHaveLength(1)
  })

  it('shares the write-once guard across different emit tools', async () => {
    const invocation = documentCreateInvocation()
    const policy = {
      ...invocation.policy,
      allowedCanvasEditKinds: ['document_create', 'free_canvas_text_create'],
      selectedTextNodeId: 'text-a'
    }
    const canvasEdits: Record<string, unknown>[] = []
    const tools = buildAgentTools(policy, [], [], canvasEdits)
    const documentTool = tools.find(candidate => candidate.name === 'emit_document_create')
    const promptTool = tools.find(candidate => candidate.name === 'emit_canvas_prompt_edit')

    const first = await documentTool?.execute('call-document', {
      title: 'Valid',
      blocks: [{ id: 'p', type: 'paragraph', content: [{ text: 'Valid' }] }],
      rationale: 'Create it'
    })
    const second = await promptTool?.execute('call-prompt', {
      userText: 'Must not be emitted', rationale: 'Second write'
    })

    expect(first?.terminate).toBe(true)
    expect(second?.terminate).toBe(false)
    expect(JSON.stringify(second)).toContain('write_tool_already_used')
    expect(canvasEdits).toHaveLength(1)
    expect(canvasEdits[0]).toMatchObject({ kind: 'document_create' })
  })

  it('uses effective block text supplied by Gateway instead of visual deleted text', () => {
    const invocation = documentChangesInvocation()
    const prompt = buildAgentSystemPrompt(invocation)

    expect(prompt).toContain('Current effective Document blocks')
    expect(prompt).toContain('Caf\u00e9')
    expect(prompt).not.toContain('visually-deleted-old-text')
    expect(prompt).toContain('emit_document_changes exactly once')
    expect(prompt).not.toContain('Prompt Library snapshot: [{')
  })
})

const documentCreateInvocation = () => buildInvocation({
  content: 'Create a document',
  permissionScope: 'workspace-chatbot-agent',
  interactionMode: 'chat-experimental',
  workspaceContext: null,
  promptLibrary: [{ label: 'Prompt', content: 'must remain unavailable' }],
  documentWriteContext: {
    operationKind: 'document_create',
    linkedDocumentResourceIds: ['resource-a']
  }
})

const documentChangesInvocation = () => buildInvocation({
  content: 'Revise the document',
  permissionScope: 'workspace-chatbot-agent',
  interactionMode: 'chat-experimental',
  workspaceContext: null,
  promptLibrary: [{ label: 'Prompt', content: 'must remain unavailable' }],
  documentWriteContext: {
    operationKind: 'document_changes',
    nodeId: 'document-a',
    baseRevision: 7,
    baseDigest: 'sha256:document-a',
    blocks: [
      { blockId: 'paragraph-a', text: 'Caf\u00e9', expectedTextDigest: 'sha256:paragraph-a' },
      { blockId: 'paragraph-b', text: 'Old text', expectedTextDigest: 'sha256:paragraph-b' }
    ],
    wrapperBlockIds: ['list-wrapper']
  }
})
