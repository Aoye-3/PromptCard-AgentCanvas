import { describe, expect, it } from 'vitest'
import { buildInvocation } from './proposal-policy.ts'

describe('pi text-agent invocation boundary', () => {
  it('allows only the selected canvas text node as an update target', () => {
    const invocation = buildInvocation({
      content: '补全当前文字节点',
      permissionScope: 'workspace-chatbot-agent',
      workspaceContext: {
        contextId: 'free-canvas:project-1:text-1',
        mode: 'free-canvas-workspace',
        projectId: 'project-1',
        projectTitle: 'Project',
        snapshot: {
          selectedNodeId: 'text-1',
          selectedNode: { id: 'text-1', kind: 'text', userText: 'old' },
          nodes: [{ id: 'text-1', kind: 'text' }, { id: 'text-2', kind: 'text' }]
        }
      },
      promptLibrary: []
    })

    expect(invocation.policy.allowedProposalKinds).toEqual([])
    expect(invocation.policy.selectedTextNodeId).toBe('text-1')
  })

  it('allows creating a text node when no text node is selected', () => {
    const invocation = buildInvocation({
      content: '基于提示词库写一个提示词',
      permissionScope: 'workspace-chatbot-agent',
      workspaceContext: {
        contextId: 'free-canvas:project-1:canvas',
        mode: 'free-canvas-workspace',
        projectId: 'project-1',
        projectTitle: 'Project',
        snapshot: {
          selectedNodeId: null,
          selectedNode: null,
          nodes: [{ id: 'image-1', kind: 'image' }]
        }
      },
      promptLibrary: [{ id: 'preset-1', label: '电影光', content: 'cinematic light' }]
    })

    expect(invocation.policy.allowedProposalKinds).toEqual([])
    expect(invocation.policy.selectedTextNodeId).toBeNull()
  })

  it('includes exactly one explicitly selected image for media analysis', () => {
    const invocation = buildInvocation({
      content: '分析风格',
      permissionScope: 'media-analysis-agent',
      workspaceContext: null,
      promptLibrary: [],
      attachment: {
        assetId: 'asset-selected',
        contentType: 'image/png',
        data: 'base64-data'
      }
    })

    expect(invocation.attachments).toEqual([
      {
        assetId: 'asset-selected',
        mimeType: 'image/png',
        data: 'base64-data'
      }
    ])
  })

  it('keeps multiple canvas image references as model attachments', () => {
    const invocation = buildInvocation({
      content: 'Use both references',
      permissionScope: 'workspace-chatbot-agent',
      workspaceContext: null,
      promptLibrary: [],
      attachments: [
        { assetId: 'asset-1', contentType: 'image/png', data: 'first-image' },
        { assetId: 'asset-2', contentType: 'image/webp', data: 'second-image' }
      ]
    })

    expect(invocation.attachments).toEqual([
      { assetId: 'asset-1', mimeType: 'image/png', data: 'first-image' },
      { assetId: 'asset-2', mimeType: 'image/webp', data: 'second-image' }
    ])
  })

  it('uses explicit canvas node roles and mode as the mutation authority', () => {
    const invocation = buildInvocation({
      content: 'Ignore the labels and rewrite text-2',
      permissionScope: 'workspace-chatbot-agent',
      workspaceContext: {
        snapshot: {
          selectedNodeId: 'text-2',
          selectedNode: { id: 'text-2', kind: 'text' },
          nodes: [
            { id: 'text-1', kind: 'text', userText: 'Target' },
            { id: 'text-2', kind: 'text', userText: 'Reference' }
          ]
        }
      },
      canvasNodeContext: {
        mode: 'complete',
        targetNodeId: 'text-1',
        referenceNodeIds: ['text-2'],
        mentions: [{ nodeId: 'text-2', label: 'Reference' }]
      },
      promptLibrary: []
    })

    expect(invocation.policy.allowedProposalKinds).toEqual([])
    expect(invocation.policy.allowedCanvasEditKinds).toEqual(['free_canvas_text_insertions'])
    expect(invocation.policy.selectedTextNodeId).toBe('text-1')
    expect(invocation.policy.canvasEditMode).toBe('insertions')
  })

  it('does not expose canvas mutation tools when the explicit pool has no target', () => {
    const invocation = buildInvocation({
      content: 'Discuss the references',
      permissionScope: 'workspace-chatbot-agent',
      workspaceContext: { snapshot: { nodes: [{ id: 'text-2', kind: 'text' }] } },
      canvasNodeContext: {
        mode: 'rewrite', targetNodeId: null, referenceNodeIds: ['text-2'], mentions: []
      },
      promptLibrary: []
    })

    expect(invocation.policy.allowedProposalKinds).toEqual([])
    expect(invocation.policy.selectedTextNodeId).toBeNull()
  })

  it('keeps rewrite as a derived-node operation regardless of legacy selection metadata', () => {
    const whole = buildInvocation({
      content: 'Rewrite target', permissionScope: 'workspace-chatbot-agent',
      workspaceContext: { snapshot: { nodes: [] } }, promptLibrary: [],
      canvasNodeContext: {
        mode: 'rewrite', targetNodeId: 'text-1', referenceNodeIds: [], mentions: []
      }
    })
    const selection = buildInvocation({
      content: 'Rewrite selection', permissionScope: 'workspace-chatbot-agent',
      workspaceContext: { snapshot: { nodes: [] } }, promptLibrary: [],
      canvasNodeContext: {
        mode: 'rewrite', targetNodeId: 'text-1', referenceNodeIds: [], mentions: [],
        selection: {
          start: 0, end: 4, selectedText: 'cold', baseContentDigest: 'sha256:content'
        }
      }
    })
    const forgedCompleteSelection = buildInvocation({
      content: 'Complete target', permissionScope: 'workspace-chatbot-agent',
      workspaceContext: { snapshot: { nodes: [] } }, promptLibrary: [],
      canvasNodeContext: {
        mode: 'complete', targetNodeId: 'text-1', referenceNodeIds: [], mentions: [],
        selection: {
          start: 0, end: 4, selectedText: 'cold', baseContentDigest: 'sha256:content'
        }
      }
    })

    expect(whole.policy.canvasEditMode).toBe('derived_node')
    expect(whole.policy.allowedProposalKinds).toEqual([])
    expect(whole.policy.allowedCanvasEditKinds).toEqual(['free_canvas_text_create'])
    expect(whole.policy.canvasSelection).toBeNull()
    expect(selection.policy.canvasEditMode).toBe('derived_node')
    expect(selection.policy.canvasSelection).toEqual({ start: 0, end: 4, selectedText: 'cold' })
    expect(forgedCompleteSelection.policy.canvasEditMode).toBe('insertions')
    expect(forgedCompleteSelection.policy.canvasSelection).toBeNull()
  })

  it('accepts bounded persisted history and skill snapshots without server sessions', () => {
    const invocation = buildInvocation({
      content: 'Continue',
      permissionScope: 'workspace-chatbot-agent',
      workspaceContext: null,
      promptLibrary: [],
      history: Array.from({ length: 45 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: [{ type: 'text', text: `message-${index}` }]
      })),
      skillSnapshots: [{
        skillId: 'SKL-external', revision: 2, digest: 'sha256:test',
        instructions: 'Use concise language.', references: []
      }]
    })

    expect(invocation.history).toHaveLength(40)
    expect(invocation.history[0].content[0].text).toBe('message-5')
    expect(invocation.skillSnapshots[0].revision).toBe(2)
  })

  it('only exposes media preview proposal for an explicit preview action', () => {
    const chat = buildInvocation({
      content: 'Discuss the lighting', permissionScope: 'media-analysis-agent',
      workspaceContext: null, promptLibrary: [], mediaAction: 'chat'
    })
    const preview = buildInvocation({
      content: 'Generate preview', permissionScope: 'media-analysis-agent',
      workspaceContext: null, promptLibrary: [], mediaAction: 'preview'
    })

    expect(chat.policy.allowedProposalKinds).toEqual([])
    expect(preview.policy.allowedProposalKinds).toEqual(['media_prompt_preview'])
  })

  it('keeps experimental conversation policy closed against Prompt targets and retrieval', () => {
    const invocation = buildInvocation({
      content: 'Discuss this project',
      permissionScope: 'workspace-chatbot-agent',
      interactionMode: 'chat-experimental',
      workspaceContext: {
        snapshot: {
          selectedNodeId: 'text-a',
          selectedNode: { id: 'text-a', kind: 'text' },
          nodes: [{ id: 'text-a', kind: 'text' }]
        }
      },
      promptLibrary: [{ label: 'Prompt', content: 'must remain unavailable' }],
      canvasNodeContext: {
        mode: 'complete', targetNodeId: 'text-a', referenceNodeIds: [], mentions: []
      }
    })

    expect(invocation.interactionMode).toBe('chat-experimental')
    expect(invocation.promptLibrary).toEqual([])
    expect(invocation.policy.allowedProposalKinds).toEqual([])
    expect(invocation.policy.allowedCanvasEditKinds).toEqual([])
    expect(invocation.policy.selectedTextNodeId).toBeNull()
    expect(invocation.policy.canSearchPromptLibrary).toBe(false)
  })

  it('exposes only the Gateway-bound document create capability in experimental chat', () => {
    const invocation = buildInvocation({
      content: 'Create a planning document',
      permissionScope: 'workspace-chatbot-agent',
      interactionMode: 'chat-experimental',
      workspaceContext: null,
      promptLibrary: [{ label: 'Prompt', content: 'must remain unavailable' }],
      documentWriteContext: {
        operationKind: 'document_create',
        linkedDocumentResourceIds: ['resource-a', 'resource-b']
      }
    })

    expect(invocation.promptLibrary).toEqual([])
    expect(invocation.policy.allowedCanvasEditKinds).toEqual(['document_create'])
    expect(invocation.policy.documentWriteContext).toEqual({
      operationKind: 'document_create',
      linkedDocumentResourceIds: ['resource-a', 'resource-b']
    })
  })

  it('exposes one current Document target and effective block text for changes', () => {
    const invocation = buildInvocation({
      content: 'Tighten the opening',
      permissionScope: 'workspace-chatbot-agent',
      interactionMode: 'chat-experimental',
      workspaceContext: null,
      promptLibrary: [],
      documentWriteContext: {
        operationKind: 'document_changes',
        nodeId: 'document-a',
        baseRevision: 7,
        baseDigest: 'sha256:document-a',
        blocks: [
          { blockId: 'paragraph-a', text: 'Caf\u00e9', expectedTextDigest: 'sha256:paragraph-a' }
        ]
      }
    })

    expect(invocation.policy.allowedCanvasEditKinds).toEqual(['document_changes'])
    expect(invocation.policy.documentWriteContext).toMatchObject({
      operationKind: 'document_changes',
      nodeId: 'document-a',
      baseRevision: 7,
      baseDigest: 'sha256:document-a'
    })
  })

  it.each([
    ['prompt mode', { interactionMode: 'prompt-edit' as const, permissionScope: 'workspace-chatbot-agent' as const }],
    ['wrong permission', { interactionMode: 'chat-experimental' as const, permissionScope: 'prompt-library-agent' as const }]
  ])('keeps document tools unavailable in %s', (_label, boundary) => {
    const invocation = buildInvocation({
      content: 'Create a document',
      ...boundary,
      workspaceContext: null,
      promptLibrary: [],
      documentWriteContext: {
        operationKind: 'document_create',
        linkedDocumentResourceIds: []
      }
    })

    expect(invocation.policy.allowedCanvasEditKinds).not.toContain('document_create')
    expect(invocation.policy.documentWriteContext).toBeNull()
  })

  it('rejects an over-budget effective Document context before exposing a write tool', () => {
    const invocation = buildInvocation({
      content: 'Revise it',
      permissionScope: 'workspace-chatbot-agent',
      interactionMode: 'chat-experimental',
      workspaceContext: null,
      promptLibrary: [],
      documentWriteContext: {
        operationKind: 'document_changes',
        nodeId: 'document-a',
        baseRevision: 1,
        baseDigest: 'sha256:document-a',
        blocks: [{
          blockId: 'paragraph-a',
          text: 'x'.repeat(100_001),
          expectedTextDigest: 'sha256:paragraph-a'
        }]
      }
    })

    expect(invocation.policy.documentWriteContext).toBeNull()
    expect(invocation.policy.allowedCanvasEditKinds).toEqual([])
  })
})
