import { describe, expect, it, vi } from 'vitest'
import { create, act } from 'react-test-renderer'
import { StoryboardNode } from './StoryboardNode'
import type { IFreeCanvasStoryboardNode } from '@/models/PromptHistory.model'

const node: IFreeCanvasStoryboardNode = {
  id: 'storyboard-1', kind: 'storyboard', title: 'Opening shots', position: { x: 0, y: 0 }, width: 680, height: 440,
  sequence: { id: 'sequence-1', name: 'Opening', description: '', style: 'ink', constraints: '', rows: [{ id: 'row-1', cutLabel: '1', timeRange: '0-3s', subject: 'Mara', action: 'enters', scene: 'hall', camera: 'wide', lighting: '', audio: '', duration: '3s', createdAt: 1, updatedAt: 1 }], createdAt: 1, updatedAt: 1, meta: {} },
  source: { documentNodeId: 'document-1', documentRevision: 7, documentDigest: `sha256:${'a'.repeat(64)}`, documentResourceDigests: [], model: { connectionId: 'c', providerId: 'p', modelId: 'm', displayName: 'Model', capabilities: {} }, skills: [] },
  pendingFieldChanges: [{ id: 'change-1', editId: 'edit-1', scope: 'row', rowId: 'row-1', field: 'camera', previousValue: 'wide', newValue: 'close-up' }],
  revision: 1, digest: `sha256:${'b'.repeat(64)}`, meta: {}
}

describe('StoryboardNode', () => {
  it('renders provenance and per-field old/new review controls', () => {
    const onResolve = vi.fn()
    const onRequestRevision = vi.fn()
    const renderer = create(<StoryboardNode node={node} selected onResolve={onResolve} onRequestRevision={onRequestRevision} />)
    const text = JSON.stringify(renderer.toJSON())
    expect(text).toContain('wide')
    expect(text).toContain('close-up')
    expect(text).toContain('Document r7')

    act(() => renderer.root.findByProps({ 'aria-label': '接受 camera 修改' }).props.onClick())
    expect(onResolve).toHaveBeenCalledWith(['change-1'], 'accept')
    act(() => renderer.root.findByProps({ 'aria-label': '拒绝全部分镜修改' }).props.onClick())
    expect(onResolve).toHaveBeenCalledWith('all', 'reject')
    act(() => renderer.root.findByProps({ 'aria-label': '让 Agent 修订分镜表 Opening shots' }).props.onClick())
    expect(onRequestRevision).toHaveBeenCalledOnce()
  })

  it('disables review controls while saved-edit reconciliation owns the node', () => {
    const renderer = create(<StoryboardNode node={node} selected={false} locked onResolve={vi.fn()} onPromptHandoff={vi.fn()} />)

    expect(renderer.root.findByProps({ 'aria-label': '接受 camera 修改' }).props.disabled).toBe(true)
    expect(renderer.root.findByProps({ 'aria-label': '拒绝全部分镜修改' }).props.disabled).toBe(true)
    expect(renderer.root.findByProps({ 'aria-label': '镜头转为 Prompt 提案' }).props.disabled).toBe(true)
  })
})
