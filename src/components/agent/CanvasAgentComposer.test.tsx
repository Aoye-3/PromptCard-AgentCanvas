import { renderToStaticMarkup } from 'react-dom/server'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { CanvasAgentComposer } from './CanvasAgentComposer'

const baseProps = {
  nodes: [],
  attachments: [],
  editMode: 'complete' as const,
  running: false,
  disabled: false,
  resetKey: 0,
  onEditModeChange: vi.fn(),
  onRemoveNode: vi.fn(),
  onSetTarget: vi.fn(),
  onClearTarget: vi.fn(),
  onSubmit: vi.fn(),
  onModelChange: vi.fn()
}

describe('CanvasAgentComposer model and edit controls', () => {
  it('renders the conversation model selector beside the three edit modes', () => {
    const markup = renderToStaticMarkup(
      <CanvasAgentComposer
        {...baseProps}
        selectedModelKey="connection-1::doubao-seed-2-0-lite-260215"
        modelOptions={[
          {
            key: 'connection-1::doubao-seed-2-0-lite-260215',
            displayName: 'Doubao Seed 2.0 Lite',
            available: true
          },
          {
            key: 'connection-1::doubao-seed-2-0-pro-260215',
            displayName: 'Doubao Seed 2.0 Pro',
            available: false,
            unavailableReason: '连接测试失败'
          }
        ]}
      />
    )

    expect(markup).toContain('aria-label="对话模型"')
    expect(markup).toContain('Doubao Seed 2.0 Lite')
    expect(markup).toContain('Doubao Seed 2.0 Pro · 连接测试失败')
    expect(markup).toContain('分析原文并穿插补充')
    expect(markup).toContain('Prompt库调取')
  })

  it('describes rewrite as creating a new node without changing the source', () => {
    const markup = renderToStaticMarkup(
      <CanvasAgentComposer
        {...baseProps}
        editMode="rewrite"
        selectedModelKey="connection-1::model"
        modelOptions={[{ key: 'connection-1::model', displayName: 'Model', available: true }]}
      />
    )

    expect(markup).toContain('生成新文本节点，原节点不变')
  })

  it('pastes conversation text as plain text without carrying invisible source colors', () => {
    const execCommand = vi.fn().mockReturnValue(true)
    const preventDefault = vi.fn()
    const getData = vi.fn((type: string) => type === 'text/plain'
      ? '帮我补全提示词'
      : '<span style="color: white">帮我补全提示词</span>')
    let renderer!: ReturnType<typeof create>

    act(() => {
      renderer = create(<CanvasAgentComposer {...baseProps} />)
    })
    const editor = renderer.root.findByProps({ 'data-agent-composer': true })

    act(() => editor.props.onPaste({
      clipboardData: { getData },
      currentTarget: { ownerDocument: { execCommand } },
      preventDefault
    }))

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(getData).toHaveBeenCalledWith('text/plain')
    expect(execCommand).toHaveBeenCalledWith('insertText', false, '帮我补全提示词')
  })

  it('offers compact Document identities as explicit mention candidates', () => {
    let renderer!: ReturnType<typeof create>
    act(() => {
      renderer = create(
        <CanvasAgentComposer
          {...baseProps}
          documentNodes={[{
            id: 'document-node-1',
            title: 'Creative brief',
            displayText: '',
            userText: '',
            kind: 'document'
          }]}
        />
      )
    })

    act(() => renderer.root.findByProps({ 'data-agent-composer': true }).props.onInput({
      currentTarget: { textContent: '@Creative' }
    }))

    expect(renderer.root.findByProps({ 'aria-label': '可引用的文字节点' })).toBeTruthy()
    expect(JSON.stringify(renderer.toJSON())).toContain('Creative brief')
    expect(JSON.stringify(renderer.toJSON())).toContain('文档')
  })
})
