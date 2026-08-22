import { useCallback, useEffect, useRef, useState } from 'react'

type ClipboardFeedback = { target: string; status: 'success' | 'error' } | null

export const useClipboardCopyFeedback = (scopeKey: string) => {
  const [feedback, setFeedback] = useState<ClipboardFeedback>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generationRef = useRef(0)
  const mountedRef = useRef(false)

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const invalidateFeedback = useCallback(() => {
    generationRef.current += 1
    clearTimer()
    setFeedback(null)
  }, [clearTimer])

  useEffect(() => {
    mountedRef.current = true
    invalidateFeedback()
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      clearTimer()
    }
  }, [clearTimer, invalidateFeedback, scopeKey])

  const copyText = useCallback(async (text: string, target: string) => {
    const operation = generationRef.current + 1
    generationRef.current = operation
    clearTimer()
    setFeedback(null)
    try {
      await navigator.clipboard.writeText(text)
      if (!mountedRef.current || generationRef.current !== operation) return
      setFeedback({ target, status: 'success' })
      timerRef.current = setTimeout(() => {
        if (!mountedRef.current || generationRef.current !== operation) return
        timerRef.current = null
        setFeedback(current => current?.target === target && current.status === 'success' ? null : current)
      }, 1200)
    } catch {
      if (!mountedRef.current || generationRef.current !== operation) return
      setFeedback({ target, status: 'error' })
    }
  }, [clearTimer])

  return {
    copyText,
    isCopied: (target: string) => feedback?.target === target && feedback.status === 'success',
    copyFailed: (target: string) => feedback?.target === target && feedback.status === 'error'
  }
}
