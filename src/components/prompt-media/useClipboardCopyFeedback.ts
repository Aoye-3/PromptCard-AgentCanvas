import { useCallback, useEffect, useRef, useState } from 'react'

type ClipboardFeedback = { target: string; status: 'success' | 'error' } | null

export const useClipboardCopyFeedback = (scopeKey: string) => {
  const [feedback, setFeedback] = useState<ClipboardFeedback>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const clearFeedback = useCallback(() => {
    clearTimer()
    setFeedback(null)
  }, [clearTimer])

  useEffect(() => {
    clearFeedback()
    return clearTimer
  }, [clearFeedback, clearTimer, scopeKey])

  const copyText = useCallback(async (text: string, target: string) => {
    clearTimer()
    try {
      await navigator.clipboard.writeText(text)
      setFeedback({ target, status: 'success' })
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setFeedback(current => current?.target === target && current.status === 'success' ? null : current)
      }, 1200)
    } catch {
      setFeedback({ target, status: 'error' })
    }
  }, [clearTimer])

  return {
    copyText,
    isCopied: (target: string) => feedback?.target === target && feedback.status === 'success',
    copyFailed: (target: string) => feedback?.target === target && feedback.status === 'error'
  }
}
