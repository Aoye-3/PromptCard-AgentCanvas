import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDocumentAttachment, AgentMessage, AgentWorkspaceContext, AgentWorkspaceProposal } from '@/models/Agent.model'

const DOCUMENT_RESOURCE_A = 'a'.repeat(32)
const DOCUMENT_RESOURCE_B = 'b'.repeat(32)

const mocks = vi.hoisted(() => ({
  checkRuntime: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue({ proposals: [], canvasEdits: [] }),
  markProposalStatus: vi.fn(),
  init: vi.fn(),
  sessionError: undefined as string | undefined,
  retryRequest: undefined as undefined | {
    requestId: string
    content: string
    conversationId: string
    documentResourceIds: string[]
    explicitDocumentNodeIds: string[]
    documentAttachments: AgentDocumentAttachment[]
  },
  messages: [] as AgentMessage[],
  proposals: [] as AgentWorkspaceProposal[],
  storedMessages: [] as Array<Record<string, unknown>>,
  hydrateSession: vi.fn(),
  updateInteraction: vi.fn()
}))

vi.mock('@/stores/agent.store', () => ({
  useAgentStore: () => ({
    runtimeStatus: 'connected',
    authStatus: 'authenticated',
    runtimeError: null,
    getAgentSession: () => ({
      messages: mocks.messages,
      proposals: mocks.proposals,
      running: false,
      runtimeError: mocks.sessionError,
      retryRequest: mocks.retryRequest
    }),
    skills: [{ id: 'SKL-tone', name: 'Tone Helper', source: 'external', trustState: 'trusted', toolDependencies: [] }],
    models: [{
      key: 'connection-chat:doubao-seed-2-0-lite-260215',
      connectionId: 'connection-chat',
      providerId: 'volcengine-ark',
      modelId: 'doubao-seed-2-0-lite-260215',
      displayName: 'Doubao Seed 2.0 Lite',
      available: true,
      isDefault: true
    }],
    tools: [],
    checkRuntime: mocks.checkRuntime,
    sendMessage: mocks.sendMessage,
    markProposalStatus: mocks.markProposalStatus,
    hydrateSession: mocks.hydrateSession
  })
}))

vi.mock('@/components/agent/AgentConversationMenu', () => ({
  AgentConversationMenu: ({ onConversationChange }: { onConversationChange: (value: Record<string, unknown>) => void }) => (
    <button
      type="button"
      aria-label="加载实验会话"
      onClick={() => onConversationChange({
        id: 'conversation-experimental', projectId: 'project-a',
        entrypoint: 'workspace-chatbot-agent', mode: 'free-canvas-workspace', title: 'Experimental',
        status: 'active', createdAt: 1, updatedAt: 2,
        modelBinding: {
          connectionId: 'connection-chat', providerId: 'volcengine-ark', modelId: 'doubao-seed-2-0-lite-260215'
        },
        interactionMode: 'chat-experimental', boundSkillIds: ['SKL-tone'], revision: 4,
        messages: mocks.storedMessages, proposals: [], turns: []
      })}
    >Load</button>
  )
}))

vi.mock('@/storage/storage-service-client', () => ({
  storageServiceClient: {
    agentConversations: {
      updateProposal: vi.fn(),
      updateInteraction: mocks.updateInteraction
    }
  }
}))

vi.mock('@/stores/preset.store', () => ({
  usePresetStore: () => ({
    presets: [],
    initialized: true,
    init: mocks.init
  })
}))

import { AgentCollaborationPanel } from './AgentCollaborationPanel'
import { AgentDocumentAttachments } from './agent/AgentDocumentAttachments'
import { CanvasAgentComposer } from './agent/CanvasAgentComposer'

const workspaceContext: AgentWorkspaceContext = {
  contextId: 'canvas-context',
  mode: 'free-canvas-workspace',
  projectId: 'project-a',
  projectTitle: 'Project A',
  snapshot: {
    nodes: [
      { id: 'text-1', kind: 'text', title: 'TXT-ABC123', displayText: 'Secret full prompt', userText: 'Secret full prompt' },
      { id: 'text-2', kind: 'text', title: 'Reference node', displayText: 'Reference body', userText: 'Reference body' }
    ]
  }
}

describe('AgentCollaborationPanel dense embedded mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sessionError = undefined
    mocks.retryRequest = undefined
    mocks.messages = []
    mocks.proposals = []
    mocks.storedMessages = []
    mocks.hydrateSession.mockImplementation((_sessionKey, session) => {
      if (session.messages) mocks.messages = session.messages
    })
  })

  it('uses a compact context strip and inline composer without the full-width send bar', () => {
    const markup = renderToStaticMarkup(
      <AgentCollaborationPanel
        title="Free Canvas Agent"
        mode="free-canvas-workspace"
        workspaceContext={workspaceContext}
        contextLabel="已读取画布 · 1 个节点"
        onApplyWorkspaceProposal={vi.fn()}
        compact
        embedded
      />
    )

    expect(markup).toContain('已读取画布 · 1 个节点')
    expect(markup).toContain('可以直接修改当前画布')
    expect(markup).toContain('contenteditable="true"')
    expect(markup).toContain('aria-label="发送给 Agent"')
    expect(markup).toContain('Canvas Prompt Editor')
    expect(markup).toContain('Skill')
    expect(markup).toContain('Prompt库调取')
    expect(markup).toContain('aria-label="对话模型"')
    expect(markup).toContain('Doubao Seed 2.0 Lite')
    expect(markup).not.toContain('>发送给 Agent</button>')
  })

  it('hydrates the experimental mode and persistent Skill binding copy', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })

    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': 'Skill 选择' }).props.onClick())

    expect(renderer.root.findByProps({ 'aria-label': 'Agent 交互模式' }).props.value)
      .toBe('chat-experimental')
    expect(JSON.stringify(renderer.toJSON())).toContain('对话模式【测试中】')
    expect(JSON.stringify(renderer.toJSON())).toContain('本对话持续启用')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('仅作用于下一条消息')
    expect(mocks.hydrateSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        interactionMode: 'chat-experimental', boundSkillIds: ['SKL-tone'], revision: 4
      })
    )
  })

  it('does not expose a failed conversation retry after switching conversations', () => {
    mocks.sessionError = 'response lost'
    mocks.retryRequest = {
      requestId: 'request-a', content: 'continue A', conversationId: 'conversation-a',
      documentResourceIds: [], explicitDocumentNodeIds: [], documentAttachments: []
    }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })

    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())

    expect(JSON.stringify(renderer.toJSON())).not.toContain('使用原请求重试')
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('reuses the failed turn request ID and explicit Document identities', async () => {
    mocks.retryRequest = {
      requestId: 'request-document',
      content: 'Discuss the document',
      conversationId: 'conversation-experimental',
      documentResourceIds: [DOCUMENT_RESOURCE_A],
      explicitDocumentNodeIds: ['document-node-1'],
      documentAttachments: [{
        resourceId: DOCUMENT_RESOURCE_A, name: 'plan.md', contentType: 'text/markdown',
        size: 7, sha256: 'a'.repeat(64)
      }]
    }
    const documentContext: AgentWorkspaceContext = {
      ...workspaceContext,
      snapshot: {
        nodes: [{
          id: 'document-node-1', kind: 'document', title: 'Creative brief', revision: 4, digest: 'digest-1'
        }]
      }
    }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={documentContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '使用原请求重试' }).props.onClick()
    })

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Discuss the document',
      [],
      expect.objectContaining({
        requestId: 'request-document',
        documentResourceIds: [DOCUMENT_RESOURCE_A],
        explicitDocumentNodeIds: ['document-node-1']
      })
    )
  })

  it('renders assistant Markdown as semantic conversation content', () => {
    mocks.messages = [{
      id: 'assistant-markdown',
      role: 'assistant',
      content: '## 推荐方案\n\n- 第一镜头\n- 第二镜头\n\n```text\ncinematic lighting\n```\n\n**重点**',
      createdAt: 1
    }]

    const markup = renderToStaticMarkup(
      <AgentCollaborationPanel
        title="Free Canvas Agent"
        mode="free-canvas-workspace"
        workspaceContext={workspaceContext}
        onApplyWorkspaceProposal={vi.fn()}
        embedded
      />
    )

    expect(markup).toContain('<h2')
    expect(markup).toContain('<ul')
    expect(markup).toContain('<li>第一镜头</li>')
    expect(markup).toContain('<pre')
    expect(markup).toContain('<code')
    expect(markup).toContain('<strong>重点</strong>')
    expect(markup).not.toContain('## 推荐方案')
  })

  it('moves the third quick action behind the compact overflow control', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          contextLabel="已读取画布"
          onApplyWorkspaceProposal={vi.fn()}
          compact
          embedded
        />
      )
    })

    act(() => renderer.root.findByProps({ 'aria-label': '新增卡片' }).props.onClick())
    expect(renderer.root.findByProps({ contentEditable: true }).props['data-agent-composer']).toBe(true)
  })

  it('sends with Enter while preserving Shift+Enter for a new line', async () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })

    const composer = renderer.root.findByProps({ contentEditable: true })
    act(() => composer.props.onInput({ currentTarget: { textContent: '修改画布内容' } }))
    act(() => composer.props.onKeyDown({
      key: 'Enter',
      shiftKey: true,
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn()
    }))
    expect(mocks.sendMessage).not.toHaveBeenCalled()

    await act(async () => {
      composer.props.onKeyDown({
        key: 'Enter',
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn()
      })
    })
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '修改画布内容',
      [],
      expect.objectContaining({ mode: 'free-canvas-workspace' })
    )
  })

  it('attaches a completion target without injecting its full content into the composer', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          draftRequest={{
            id: 'complete-text-node-1',
            canvasNode: { nodeId: 'text-1', role: 'target', mode: 'complete' }
          }}
          embedded
        />
      )
    })

    const markup = JSON.stringify(renderer.toJSON())
    expect(markup).toContain('TXT-ABC123')
    expect(markup).not.toContain('Secret full prompt')
    expect(renderer.root.findByProps({ 'aria-label': 'Canvas Agent 编辑模式' }).props.value).toBe('complete')
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('attaches an image node as an Agent reference', () => {
    const imageContext: AgentWorkspaceContext = {
      ...workspaceContext,
      snapshot: {
        nodes: [{ id: 'image-1', kind: 'image', title: 'Yellow Crane Tower reference', assetId: 'asset-1' }]
      }
    }

    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={imageContext}
          onApplyWorkspaceProposal={vi.fn()}
          draftRequest={{ id: 'reference-image-1', canvasNode: { nodeId: 'image-1', role: 'reference' } }}
          embedded
        />
      )
    })

    expect(JSON.stringify(renderer.toJSON())).toContain('Yellow Crane Tower reference')
  })

  it('applies a returned Canvas edit immediately without rendering approval controls', async () => {
    const applyCanvasEdit = vi.fn().mockResolvedValue(true)
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [],
      canvasEdits: [{
        id: 'canvas-edit-1',
        kind: 'free_canvas_text_insertions',
        agentName: 'PromptCard Agent',
        nodeId: 'text-1',
        insertions: [{
          text: ' inserted',
          reason: 'Add detail',
          anchor: { type: 'segment', segmentId: 'segment-1', position: 'after' }
        }],
        baseNodeRevision: 2,
        templateDigest: 'sha256:template',
        baseSegmentsDigest: 'sha256:segments',
        rationale: 'Complete the prompt',
        createdAt: 1
      }]
    })
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          onApplyCanvasEdit={applyCanvasEdit}
          draftRequest={{ id: 'target-1', canvasNode: { nodeId: 'text-1', role: 'target', mode: 'complete' } }}
          embedded
        />
      )
    })
    const composer = renderer.root.findByProps({ contentEditable: true })
    act(() => composer.props.onInput({ currentTarget: { textContent: 'Complete it' } }))

    await act(async () => {
      composer.props.onKeyDown({
        key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn()
      })
    })

    expect(applyCanvasEdit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'free_canvas_text_insertions', nodeId: 'text-1'
    }))
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Apply')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Reject')
  })

  it('previews every interleaved canvas insertion with its anchor reason', () => {
    mocks.proposals = [{
      kind: 'free_canvas_text_insertions',
      id: 'insert-1',
      agentName: 'PromptCard Agent',
      nodeId: 'text-1',
      insertions: [{
        text: 'Inserted detail',
        reason: 'Clarifies the framing after the preset.',
        anchor: { type: 'segment', segmentId: 'preset-1', position: 'after' }
      }],
      baseNodeRevision: 2,
      templateDigest: 'sha256:template',
      baseSegmentsDigest: 'sha256:segments',
      rationale: 'Add a framing detail.',
      status: 'pending',
      createdAt: 1
    } as AgentWorkspaceProposal]
    const context: AgentWorkspaceContext = {
      ...workspaceContext,
      snapshot: {
        nodes: [{
          id: 'text-1', kind: 'text', title: 'TXT-ABC123', displayText: 'PresetUser', userText: 'User',
          segments: [
            { id: 'preset-1', source: 'preset', text: 'Preset', color: '#ef4423' },
            { id: 'user-1', source: 'user', text: 'User', color: '#111827' }
          ]
        }]
      }
    }

    const markup = renderToStaticMarkup(
      <AgentCollaborationPanel
        title="Free Canvas Agent"
        mode="free-canvas-workspace"
        workspaceContext={context}
        onApplyWorkspaceProposal={vi.fn()}
        embedded
      />
    )

    expect(markup).toContain('data-canvas-text-insertions-preview="true"')
    expect(markup).toContain('Preset')
    expect(markup).toContain('Inserted detail')
    expect(markup).toContain('User')
    expect(markup).toContain('Clarifies the framing after the preset.')
    expect(markup).toContain('#ef4423')
    expect(markup).toContain('#111827')
  })

  it('renders a scrollable chat history with user messages aligned right and Agent messages left', () => {
    mocks.messages = Array.from({ length: 12 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `content-${index}`,
      createdAt: index
    }))

    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })

    const history = renderer.root.findByProps({ 'aria-label': 'Agent 对话消息' })
    expect(history.props.className).toContain('overflow-y-auto')
    expect(renderer.root.findAllByProps({ 'data-agent-message-role': 'user' })[0].props.className).toContain('justify-end')
    expect(renderer.root.findAllByProps({ 'data-agent-message-role': 'assistant' })[0].props.className).toContain('justify-start')
    const markup = JSON.stringify(renderer.toJSON())
    expect(markup).toContain('content-0')
    expect(markup).toContain('content-11')
  })

  it('summarizes oversized Prompt Library validation errors instead of expanding raw request data', () => {
    mocks.sessionError = '{"detail":[{"type":"too_long","loc":["body","promptLibrary"],"msg":"List should have at most 200 items after validation, not 254","input":[{"content":"secret prompt body"}]}]}'

    const markup = renderToStaticMarkup(
      <AgentCollaborationPanel
        title="Free Canvas Agent"
        mode="free-canvas-workspace"
        workspaceContext={workspaceContext}
        onApplyWorkspaceProposal={vi.fn()}
        embedded
      />
    )

    expect(markup).toContain('Prompt Library 条目超过上限（254/200）')
    expect(markup).not.toContain('secret prompt body')
  })

  it('keeps a referenced node in the pool while the modification target starts empty', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          draftRequest={{ id: 'reference-1', canvasNode: { nodeId: 'text-2', role: 'reference' } }}
          embedded
        />
      )
    })

    expect(renderer.root.findByProps({ 'aria-label': '选择被修改对象' }).props['aria-expanded']).toBe(false)
    expect(JSON.stringify(renderer.toJSON())).toContain('尚未选择被修改对象')
    expect(JSON.stringify(renderer.toJSON())).toContain('Reference node')

    act(() => renderer.root.findByProps({ 'aria-label': '选择被修改对象' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '设为被修改对象 Reference node' }).props.onClick())

    expect(JSON.stringify(renderer.toJSON())).toContain('被修改对象')
    expect(renderer.root.findByProps({ 'aria-label': '清空被修改对象' })).toBeTruthy()

    act(() => renderer.root.findByProps({ 'aria-label': '清空被修改对象' }).props.onClick())
    expect(JSON.stringify(renderer.toJSON())).toContain('尚未选择被修改对象')
    expect(JSON.stringify(renderer.toJSON())).toContain('Reference node')
  })

  it('sends mounted references with a null modification target', async () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          draftRequest={{ id: 'reference-only', canvasNode: { nodeId: 'text-2', role: 'reference' } }}
          embedded
        />
      )
    })

    const composer = renderer.root.findByProps({ contentEditable: true })
    act(() => composer.props.onInput({ currentTarget: { textContent: '先讨论参考节点' } }))
    await act(async () => {
      composer.props.onKeyDown({
        key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn()
      })
    })

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '先讨论参考节点',
      [],
      expect.objectContaining({
        canvasNodeContext: expect.objectContaining({
          targetNodeId: null,
          referenceNodeIds: ['text-2']
        })
      })
    )
  })

  it('opens the mounted-node mention list when @ follows Chinese text without whitespace', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          draftRequest={{ id: 'mention-reference', canvasNode: { nodeId: 'text-2', role: 'reference' } }}
          embedded
        />
      )
    })

    const composer = renderer.root.findByProps({ contentEditable: true })
    act(() => composer.props.onInput({ currentTarget: { textContent: '请参考@' } }))

    expect(renderer.root.findByProps({ 'aria-label': '可引用的文字节点' })).toBeTruthy()
    expect(JSON.stringify(renderer.toJSON())).toContain('Reference node')
  })

  it('retains node labels when sending fails', async () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          draftRequest={{ id: 'target-1', canvasNode: { nodeId: 'text-1', role: 'target', mode: 'complete' } }}
          embedded
        />
      )
    })
    const composer = renderer.root.findByProps({ contentEditable: true })
    act(() => composer.props.onInput({ currentTarget: { textContent: '补全它' } }))
    mocks.sessionError = 'runtime failed'

    await act(async () => {
      composer.props.onKeyDown({
        key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn()
      })
    })

    expect(JSON.stringify(renderer.toJSON())).toContain('TXT-ABC123')
  })

  it('sends current document and explicit Document node IDs, clearing them only after success', async () => {
    const documentContext: AgentWorkspaceContext = {
      ...workspaceContext,
      snapshot: {
        nodes: [
          ...(workspaceContext.snapshot.nodes as Array<Record<string, unknown>>),
          { id: 'document-node-1', kind: 'document', title: 'Creative brief', revision: 4, digest: 'digest-1' }
        ]
      }
    }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={documentContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    const attachment = {
      resourceId: DOCUMENT_RESOURCE_A, name: 'plan.md', contentType: 'text/markdown' as const,
      size: 7, sha256: 'a'.repeat(64)
    }
    act(() => renderer.root.findByType(AgentDocumentAttachments).props.onChange([attachment]))

    await act(async () => {
      await renderer.root.findByType(CanvasAgentComposer).props.onSubmit(
        'Discuss @Creative brief',
        [{ nodeId: 'document-node-1', label: 'Creative brief' }]
      )
    })

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Discuss @Creative brief',
      [],
      expect.objectContaining({
        documentResourceIds: [DOCUMENT_RESOURCE_A],
        explicitDocumentNodeIds: ['document-node-1'],
        documentAttachments: [attachment]
      })
    )
    expect(renderer.root.findByType(AgentDocumentAttachments).props.attachments).toEqual([])
  })

  it('retains current document selection after a failed send', async () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    const attachment = {
      resourceId: DOCUMENT_RESOURCE_A, name: 'plan.md', contentType: 'text/markdown' as const,
      size: 7, sha256: 'a'.repeat(64)
    }
    act(() => renderer.root.findByType(AgentDocumentAttachments).props.onChange([attachment]))
    mocks.sessionError = 'runtime failed'

    await act(async () => {
      await renderer.root.findByType(CanvasAgentComposer).props.onSubmit('Discuss the plan', [])
    })

    expect(renderer.root.findByType(AgentDocumentAttachments).props.attachments).toEqual([attachment])
  })

  it('hydrates durable attachment audit as read-only history without preselecting it', () => {
    mocks.storedMessages = [{
      id: 'stored-user-message', role: 'user', text: 'Discuss the plan', createdAt: 1,
      documentAttachments: [{
        resourceId: DOCUMENT_RESOURCE_A, name: 'historic-plan.md', contentType: 'text/markdown', size: 7
      }]
    }]
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })

    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())

    expect(JSON.stringify(renderer.toJSON())).toContain('historic-plan.md')
    expect(renderer.root.findByType(AgentDocumentAttachments).props.attachments).toEqual([])
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('does not carry a current document selection into another project identity', () => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    act(() => renderer.root.findByType(AgentDocumentAttachments).props.onChange([{
      resourceId: DOCUMENT_RESOURCE_A, name: 'plan.md', contentType: 'text/markdown',
      size: 7, sha256: 'a'.repeat(64)
    }]))

    act(() => renderer.update(
      <AgentCollaborationPanel
        title="Free Canvas Agent"
        mode="free-canvas-workspace"
        workspaceContext={{ ...workspaceContext, projectId: 'project-b', projectTitle: 'Project B' }}
        onApplyWorkspaceProposal={vi.fn()}
        embedded
      />
    ))

    expect(renderer.root.findByType(AgentDocumentAttachments).props.attachments).toEqual([])
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    [1, 'single-file upload'],
    [3, 'batch upload']
  ] as const)('disables and guards send during a %i-file upload (%s)', async (uploadingCount, _label) => {
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    act(() => renderer.root.findByType(AgentDocumentAttachments).props.onUploadingChange(uploadingCount))

    expect(renderer.root.findByType(CanvasAgentComposer).props.disabled).toBe(true)
    await act(async () => {
      await renderer.root.findByType(CanvasAgentComposer).props.onSubmit('Do not send yet', [])
    })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('freezes an empty retry document snapshot instead of falling back to the current selection', async () => {
    mocks.sessionError = 'response lost'
    mocks.retryRequest = {
      requestId: 'request-empty-documents',
      content: 'Retry without documents',
      conversationId: 'conversation-experimental',
      documentResourceIds: [],
      explicitDocumentNodeIds: [],
      documentAttachments: []
    }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    act(() => renderer.root.findByType(AgentDocumentAttachments).props.onChange([{
      resourceId: DOCUMENT_RESOURCE_B, name: 'current.md', contentType: 'text/markdown',
      size: 8, sha256: 'b'.repeat(64)
    }]))

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '使用原请求重试' }).props.onClick()
    })

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Retry without documents',
      [],
      expect.objectContaining({
        requestId: 'request-empty-documents',
        documentResourceIds: [],
        explicitDocumentNodeIds: [],
        documentAttachments: []
      })
    )
  })

  it('deduplicates explicit Document mentions in first-use order and caps them at five', async () => {
    const documentNodes = Array.from({ length: 6 }, (_, index) => ({
      id: `document-node-${index + 1}`,
      kind: 'document',
      title: `Document ${index + 1}`,
      revision: 1,
      digest: `digest-${index + 1}`
    }))
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={{ ...workspaceContext, snapshot: { nodes: documentNodes } }}
          onApplyWorkspaceProposal={vi.fn()}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    const mentions = [
      documentNodes[0], documentNodes[0], documentNodes[1], documentNodes[2],
      documentNodes[3], documentNodes[4], documentNodes[5]
    ].map(node => ({ nodeId: node.id, label: node.title }))

    await act(async () => {
      await renderer.root.findByType(CanvasAgentComposer).props.onSubmit('Discuss documents', mentions)
    })

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Discuss documents',
      [],
      expect.objectContaining({
        explicitDocumentNodeIds: documentNodes.slice(0, 5).map(node => node.id)
      })
    )
  })

  it('shows a fixed post-send error without restoring attachments or runtime retry when Canvas apply throws', async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [],
      canvasEdits: [{ id: 'edit-1', kind: 'free_canvas_text_create' }]
    })
    const applyCanvasEdit = vi.fn().mockRejectedValue(new Error('apply failed'))
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          onApplyCanvasEdit={applyCanvasEdit}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())
    act(() => renderer.root.findByType(AgentDocumentAttachments).props.onChange([{
      resourceId: DOCUMENT_RESOURCE_A, name: 'plan.md', contentType: 'text/markdown',
      size: 7, sha256: 'a'.repeat(64)
    }]))
    const composer = renderer.root.findByProps({ 'data-agent-composer': true })
    act(() => composer.props.onInput({ currentTarget: { textContent: 'Apply edit' } }))

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
    })

    expect(renderer.root.findByType(AgentDocumentAttachments).props.attachments).toEqual([])
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.retryRequest).toBeUndefined()
    expect(JSON.stringify(renderer.toJSON())).not.toContain('使用原请求重试')
    expect(JSON.stringify(renderer.toJSON())).toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })

  it('shows the same fixed post-send error when automatic workspace apply throws', async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [{
        id: 'proposal-1', kind: 'workspace_card_update', agentName: 'PromptCard Agent',
        updates: [{ cardId: 'card-1', content: 'Updated' }], rationale: 'Apply update',
        status: 'pending', createdAt: 1
      }],
      canvasEdits: []
    })
    const applyWorkspaceProposal = vi.fn().mockRejectedValue(new Error('workspace apply failed'))
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={applyWorkspaceProposal}
          autoApplyWorkspaceChanges
          embedded
        />
      )
    })
    const composer = renderer.root.findByProps({ 'data-agent-composer': true })
    act(() => composer.props.onInput({ currentTarget: { textContent: 'Apply workspace proposal' } }))

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '发送给 Agent' }).props.onClick()
    })

    expect(applyWorkspaceProposal).toHaveBeenCalledOnce()
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.retryRequest).toBeUndefined()
    expect(JSON.stringify(renderer.toJSON())).not.toContain('使用原请求重试')
    expect(JSON.stringify(renderer.toJSON())).toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })

  it('contains a rejected post-send apply from the actual retry button without another runtime turn', async () => {
    mocks.retryRequest = {
      requestId: 'request-apply-retry', content: 'Retry and apply',
      conversationId: 'conversation-experimental', documentResourceIds: [],
      explicitDocumentNodeIds: [], documentAttachments: []
    }
    mocks.sendMessage.mockResolvedValueOnce({
      proposals: [],
      canvasEdits: [{ id: 'edit-retry', kind: 'free_canvas_text_create' }]
    })
    const applyCanvasEdit = vi.fn().mockRejectedValue(new Error('retry apply failed'))
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentCollaborationPanel
          title="Free Canvas Agent"
          mode="free-canvas-workspace"
          workspaceContext={workspaceContext}
          onApplyWorkspaceProposal={vi.fn()}
          onApplyCanvasEdit={applyCanvasEdit}
          embedded
        />
      )
    })
    act(() => renderer.root.findByProps({ 'aria-label': '加载实验会话' }).props.onClick())

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '使用原请求重试' }).props.onClick()
    })

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(renderer.toJSON())).toContain('消息已发送，但应用 Agent 修改失败。请检查当前工作区状态。')
  })
})
