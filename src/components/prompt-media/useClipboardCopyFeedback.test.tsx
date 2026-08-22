import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useClipboardCopyFeedback } from './useClipboardCopyFeedback'

type Deferred = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

const deferred = (): Deferred => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const ClipboardFeedbackHarness = ({ scopeKey }: { scopeKey: string }) => {
  const { copyFailed, copyText, isCopied } = useClipboardCopyFeedback(scopeKey)
  const feedback = isCopied('first')
    ? 'success:first'
    : isCopied('second')
      ? 'success:second'
      : copyFailed('first')
        ? 'error:first'
        : copyFailed('second')
          ? 'error:second'
          : 'none'

  return (
    <div data-feedback={feedback}>
      <button type="button" onClick={() => void copyText('first-code', 'first')}>first</button>
      <button type="button" onClick={() => void copyText('second-code', 'second')}>second</button>
    </div>
  )
}

describe('useClipboardCopyFeedback', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('ignores a stale first operation after a newer operation succeeds', async () => {
    vi.useFakeTimers()
    const first = deferred()
    const second = deferred()
    const writeText = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<ClipboardFeedbackHarness scopeKey="preset-a" />)
    })

    await act(async () => {
      renderer.root.findAllByType('button')[0].props.onClick()
      renderer.root.findAllByType('button')[1].props.onClick()
    })
    await act(async () => {
      second.resolve()
      await second.promise
    })
    await act(async () => {
      first.reject(new Error('stale failure'))
      await first.promise.catch(() => undefined)
    })

    expect(renderer.root.findByType('div').props['data-feedback']).toBe('success:second')
    expect(vi.getTimerCount()).toBe(1)
  })

  it('does not apply a pending operation after its copy scope changes', async () => {
    vi.useFakeTimers()
    const pending = deferred()
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockReturnValue(pending.promise) } })
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<ClipboardFeedbackHarness scopeKey="preset-a" />)
    })

    await act(async () => {
      renderer.root.findAllByType('button')[0].props.onClick()
      renderer.update(<ClipboardFeedbackHarness scopeKey="preset-b" />)
    })
    await act(async () => {
      pending.resolve()
      await pending.promise
    })

    expect(renderer.root.findByType('div').props['data-feedback']).toBe('none')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not schedule feedback after unmount when a pending operation settles', async () => {
    vi.useFakeTimers()
    const pending = deferred()
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockReturnValue(pending.promise) } })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<ClipboardFeedbackHarness scopeKey="preset-a" />)
    })
    await act(async () => {
      renderer.root.findAllByType('button')[0].props.onClick()
      renderer.unmount()
    })
    await act(async () => {
      pending.resolve()
      await pending.promise
    })

    expect(vi.getTimerCount()).toBe(0)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('clears a failure immediately when a deferred retry succeeds', async () => {
    const failed = deferred()
    const retried = deferred()
    const writeText = vi.fn()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retried.promise)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<ClipboardFeedbackHarness scopeKey="preset-a" />)
    })

    await act(async () => {
      renderer.root.findAllByType('button')[0].props.onClick()
      failed.reject(new Error('clipboard denied'))
      await failed.promise.catch(() => undefined)
    })
    expect(renderer.root.findByType('div').props['data-feedback']).toBe('error:first')

    await act(async () => {
      renderer.root.findAllByType('button')[0].props.onClick()
      retried.resolve()
      await retried.promise
    })
    expect(renderer.root.findByType('div').props['data-feedback']).toBe('success:first')
  })
})
