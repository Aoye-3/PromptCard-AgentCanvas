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
})
