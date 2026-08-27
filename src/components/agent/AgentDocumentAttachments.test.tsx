import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  upload: vi.fn()
}))

vi.mock('@/storage/storage-service-client', () => ({
  storageServiceClient: {
    projectDocumentResources: { upload: mocks.upload }
  }
}))

import { AgentDocumentAttachments } from './AgentDocumentAttachments'

const uploadedResource = (overrides: Record<string, unknown> = {}) => ({
  id: 'document-resource-1',
  projectId: 'project-1',
  originalFilename: 'plan.md',
  contentType: 'text/markdown',
  size: 7,
  sha256: 'a'.repeat(64),
  extractionKind: 'utf-8',
  extractionStatus: 'complete',
  normalizedTextDigest: 'b'.repeat(64),
  revision: 1,
  lifecycleStatus: 'active',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('AgentDocumentAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.upload.mockResolvedValue(uploadedResource())
  })

  it.each([
    ['notes.txt', 'text/plain'],
    ['plan.md', 'text/markdown'],
    ['brief.pdf', 'application/pdf'],
    ['draft.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
  ])('persists %s before exposing its resource identity', async (name, contentType) => {
    const onChange = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentDocumentAttachments
          projectId="project-1"
          attachments={[]}
          onChange={onChange}
        />
      )
    })
    const file = new File(['content'], name, { type: contentType })

    await act(async () => {
      await renderer.root.findByProps({ 'aria-label': '添加项目文档' }).props.onChange({
        currentTarget: { files: [file], value: 'selected' }
      })
    })

    expect(mocks.upload).toHaveBeenCalledWith('project-1', file)
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({
      resourceId: 'document-resource-1',
      name: 'plan.md',
      sha256: 'a'.repeat(64)
    })])
  })

  it('accepts drag and drop, reports upload state, and removes only the message selection', async () => {
    let resolveUpload!: (value: ReturnType<typeof uploadedResource>) => void
    mocks.upload.mockReturnValue(new Promise(resolve => { resolveUpload = resolve }))
    const onChange = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentDocumentAttachments projectId="project-1" attachments={[]} onChange={onChange} />
      )
    })
    const file = new File(['content'], 'plan.md', { type: 'text/markdown' })
    const preventDefault = vi.fn()
    let uploadPromise!: Promise<void>

    act(() => {
      uploadPromise = renderer.root.findByProps({ 'data-agent-document-dropzone': true }).props.onDrop({
        preventDefault,
        dataTransfer: { files: [file] }
      })
    })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
    expect(renderer.root.findByProps({ role: 'status' })).toBeTruthy()
    expect(JSON.stringify(renderer.toJSON())).toContain('正在保存 ')

    await act(async () => {
      resolveUpload(uploadedResource())
      await uploadPromise
    })
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ resourceId: 'document-resource-1' })])

    act(() => renderer.update(
      <AgentDocumentAttachments
        projectId="project-1"
        attachments={[{
          resourceId: 'document-resource-1', name: 'plan.md', contentType: 'text/markdown',
          size: 7, sha256: 'a'.repeat(64)
        }]}
        onChange={onChange}
      />
    ))
    act(() => renderer.root.findByProps({ 'aria-label': '移除文档 plan.md' }).props.onClick())
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('reports per-file progress while persisting a batch', async () => {
    let resolveSecond!: (value: ReturnType<typeof uploadedResource>) => void
    mocks.upload
      .mockResolvedValueOnce(uploadedResource({ id: 'document-resource-1', originalFilename: 'one.md' }))
      .mockReturnValueOnce(new Promise(resolve => { resolveSecond = resolve }))
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentDocumentAttachments projectId="project-1" attachments={[]} onChange={vi.fn()} />
      )
    })
    let uploadPromise!: Promise<void>

    await act(async () => {
      uploadPromise = renderer.root.findByProps({ 'data-agent-document-dropzone': true }).props.onDrop({
        preventDefault: vi.fn(),
        dataTransfer: {
          files: [
            new File(['one'], 'one.md', { type: 'text/markdown' }),
            new File(['two'], 'two.md', { type: 'text/markdown' })
          ]
        }
      })
      await Promise.resolve()
    })

    expect(renderer.root.findByProps({ role: 'status' }).children.filter(
      child => typeof child === 'string'
    ).join('')).toContain('1/2')

    await act(async () => {
      resolveSecond(uploadedResource({ id: 'document-resource-2', originalFilename: 'two.md' }))
      await uploadPromise
    })
  })

  it('ignores an upload that finishes after the project identity changes', async () => {
    let resolveUpload!: (value: ReturnType<typeof uploadedResource>) => void
    mocks.upload.mockReturnValueOnce(new Promise(resolve => { resolveUpload = resolve }))
    const onChange = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentDocumentAttachments projectId="project-1" attachments={[]} onChange={onChange} />
      )
    })
    let uploadPromise!: Promise<void>
    act(() => {
      uploadPromise = renderer.root.findByProps({ 'data-agent-document-dropzone': true }).props.onDrop({
        preventDefault: vi.fn(),
        dataTransfer: { files: [new File(['one'], 'one.md', { type: 'text/markdown' })] }
      })
    })

    act(() => renderer.update(
      <AgentDocumentAttachments projectId="project-2" attachments={[]} onChange={onChange} />
    ))
    await act(async () => {
      resolveUpload(uploadedResource())
      await uploadPromise
    })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('rejects more than five documents and an aggregate over 100 MiB before upload', async () => {
    const attachments = Array.from({ length: 5 }, (_, index) => ({
      resourceId: `resource-${index}`,
      name: `file-${index}.pdf`,
      contentType: 'application/pdf' as const,
      size: 20 * 1024 * 1024,
      sha256: String(index).repeat(64)
    }))
    const onChange = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentDocumentAttachments projectId="project-1" attachments={attachments} onChange={onChange} />
      )
    })

    await act(async () => {
      await renderer.root.findByProps({ 'data-agent-document-dropzone': true }).props.onDrop({
        preventDefault: vi.fn(),
        dataTransfer: { files: [new File(['x'], 'extra.txt', { type: 'text/plain' })] }
      })
    })

    expect(mocks.upload).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).toContain('每条消息最多添加 5 个文档')
  })

  it('rejects an aggregate over 100 MiB before upload', async () => {
    const attachments = Array.from({ length: 4 }, (_, index) => ({
      resourceId: `resource-${index}`,
      name: `file-${index}.pdf`,
      contentType: 'application/pdf' as const,
      size: 20 * 1024 * 1024,
      sha256: String(index).repeat(64)
    }))
    const file = new File(['x'], 'extra.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'size', { value: 21 * 1024 * 1024 })
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentDocumentAttachments projectId="project-1" attachments={attachments} onChange={vi.fn()} />
      )
    })

    await act(async () => {
      await renderer.root.findByProps({ 'data-agent-document-dropzone': true }).props.onDrop({
        preventDefault: vi.fn(), dataTransfer: { files: [file] }
      })
    })

    expect(mocks.upload).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).toContain('文档总大小不能超过 100 MiB')
  })

  it('shows a safe upload error without creating a selected attachment', async () => {
    mocks.upload.mockRejectedValueOnce(new Error('文档格式无效'))
    const onChange = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <AgentDocumentAttachments projectId="project-1" attachments={[]} onChange={onChange} />
      )
    })

    await act(async () => {
      await renderer.root.findByProps({ 'data-agent-document-dropzone': true }).props.onDrop({
        preventDefault: vi.fn(),
        dataTransfer: { files: [new File(['x'], 'plan.md', { type: 'text/markdown' })] }
      })
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(renderer.root.findByProps({ role: 'alert' }).children).toContain('文档格式无效')
  })
})
