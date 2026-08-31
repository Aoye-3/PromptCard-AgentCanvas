import { Check, Copy, RotateCcw } from 'lucide-react'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { useClipboardCopyFeedback } from '@/components/prompt-media/useClipboardCopyFeedback'
import {
  validatePublicReferenceCode,
  type PublicReferenceCodePrefix
} from '@/domain/reference-codes/reference-code'
import type { IFreeCanvasNode, IPromptProject } from '@/models/PromptHistory.model'
import { isCanvasNodeReferencePending } from '@/domain/reference-codes/canvas-node-reference-lifecycle'

interface ReferenceCodeCopyActionProps {
  referenceCode: unknown
  expectedPrefix: PublicReferenceCodePrefix | null
  scopeKey: string
  label: '复制项目代码' | '复制节点代码'
  contextLabel: string
  unavailableReason: string
  surface: 'header' | 'menu'
}

export const CanvasProjectReferenceCodeAction = ({ project }: { project: IPromptProject }) => {
  const code = validatePublicReferenceCode(project.referenceCode, 'PRJ')
  return (
    <ReferenceCodeCopyAction
      referenceCode={project.referenceCode}
      expectedPrefix="PRJ"
      scopeKey={`canvas-project:${project.id}:${code || ''}`}
      label="复制项目代码"
      contextLabel={project.title || '当前项目'}
      unavailableReason={project.referenceCode ? '项目代码格式无效，无法复制' : '项目代码暂不可用'}
      surface="header"
    />
  )
}

export const CanvasNodeReferenceCodeAction = ({ node }: { node: IFreeCanvasNode }) => {
  const state = nodeReferenceState(node)
  return (
    <ReferenceCodeCopyAction
      referenceCode={state.code}
      expectedPrefix={state.expectedPrefix}
      scopeKey={`canvas-node:${node.id}:${state.code || ''}`}
      label="复制节点代码"
      contextLabel={`${state.kindLabel}「${node.title || node.id}」`}
      unavailableReason={state.unavailableReason}
      surface="menu"
    />
  )
}

const ReferenceCodeCopyAction = ({
  referenceCode,
  expectedPrefix,
  scopeKey,
  label,
  contextLabel,
  unavailableReason,
  surface
}: ReferenceCodeCopyActionProps) => {
  const code = expectedPrefix ? validatePublicReferenceCode(referenceCode, expectedPrefix) : null
  const target = `${label}:${scopeKey}`
  const { copyFailed, copyText, isCopied } = useClipboardCopyFeedback(scopeKey)
  const suffix = code?.slice(-6)
  const accessibleLabel = suffix ? `${label}：${contextLabel} · ${suffix}` : `${label}：${contextLabel}`
  const handleActivationKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    if (code) void copyText(code, target)
  }
  const stopActivationKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
  }
  const stopPointer = (event: PointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
  }
  const copy = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (code) void copyText(code, target)
  }
  const copied = isCopied(target)
  const failed = copyFailed(target)

  if (surface === 'header') {
    return (
      <div className="min-w-0">
        <button
          type="button"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-bold text-gray-600 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300"
          aria-label={accessibleLabel}
          title={code ? label : unavailableReason}
          disabled={!code}
          onPointerDown={stopPointer}
          onMouseDown={stopPointer}
          onKeyDown={handleActivationKeyDown}
          onKeyUp={stopActivationKeyUp}
          onClick={copy}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          <span className="hidden whitespace-nowrap sm:inline">{copied ? '项目代码已复制' : label}</span>
        </button>
        {!code && <span className="sr-only">{unavailableReason}</span>}
        {copied && <span role="status" aria-live="polite" className="sr-only">项目代码已复制</span>}
        {failed && code && (
          <span role="alert" className="flex max-w-48 flex-wrap items-center gap-1 text-[11px] text-red-700">
            复制项目代码失败
            <button
              type="button"
              className="rounded-full bg-red-50 px-2 py-1 font-semibold"
              aria-label={`重试${accessibleLabel}`}
              onPointerDown={stopPointer}
              onMouseDown={stopPointer}
              onKeyDown={handleActivationKeyDown}
              onKeyUp={stopActivationKeyUp}
              onClick={copy}
            >重试</button>
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="min-w-0 border-b border-gray-100 pb-1">
      <button
        type="button"
        role="menuitem"
        className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium leading-5 text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300"
        aria-label={accessibleLabel}
        title={code ? label : unavailableReason}
        disabled={!code}
        onPointerDown={stopPointer}
        onMouseDown={stopPointer}
        onKeyDown={handleActivationKeyDown}
        onKeyUp={stopActivationKeyUp}
        onClick={copy}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </span>
        <span className="min-w-0 break-words">{copied ? '节点代码已复制' : label}</span>
        {suffix && <code className="ml-auto shrink-0 text-[10px] text-gray-400">…{suffix}</code>}
      </button>
      {!code && (
        <p role="status" className="break-words px-2.5 pb-1 text-[11px] leading-4 text-gray-500">
          {unavailableReason}
        </p>
      )}
      {copied && <span role="status" aria-live="polite" className="sr-only">节点代码已复制</span>}
      {failed && code && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-1 px-2.5 pb-1 text-[11px] text-red-700">
          <span>复制节点代码失败，请重试。</span>
          <button
            type="button"
            role="menuitem"
            className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-1 font-semibold"
            aria-label={`重试${accessibleLabel}`}
            onPointerDown={stopPointer}
            onMouseDown={stopPointer}
            onKeyDown={handleActivationKeyDown}
            onKeyUp={stopActivationKeyUp}
            onClick={copy}
          >
            <RotateCcw className="h-3 w-3" />重试
          </button>
        </div>
      )}
    </div>
  )
}

const nodeReferenceState = (node: IFreeCanvasNode): {
  expectedPrefix: 'CVT' | 'CVM' | null
  code: string | null
  kindLabel: string
  unavailableReason: string
} => {
  if (node.kind === 'arrow') {
    return { expectedPrefix: null, code: null, kindLabel: '箭头节点', unavailableReason: '箭头节点不支持节点代码' }
  }
  if (node.kind === 'image-generator') {
    return { expectedPrefix: null, code: null, kindLabel: '图片生成器节点', unavailableReason: '图片生成器节点不支持节点代码' }
  }
  if (node.kind === 'document') {
    return { expectedPrefix: null, code: null, kindLabel: '文档节点', unavailableReason: '文档节点不支持节点代码' }
  }
  if (node.kind === 'storyboard') {
    return { expectedPrefix: null, code: null, kindLabel: '分镜节点', unavailableReason: '分镜节点不支持节点代码' }
  }
  if (node.kind === 'unsupported') {
    const kindLabel = `${node.originalKind} 节点`
    return { expectedPrefix: null, code: null, kindLabel, unavailableReason: `${kindLabel}不支持节点代码` }
  }
  if (node.kind !== 'text' && node.kind !== 'image') {
    return { expectedPrefix: null, code: null, kindLabel: '未知节点', unavailableReason: '未知节点不支持节点代码' }
  }
  // ADR-020: reference-code dispatch is closed; planning/future kinds never fall through to CVM.
  const expectedPrefix = node.kind === 'text' ? 'CVT' : 'CVM'
  const kindLabel = node.kind === 'text' ? '文字节点' : '图片节点'
  if (isCanvasNodeReferencePending(node)) {
    return { expectedPrefix, code: null, kindLabel, unavailableReason: '节点正在等待 Storage 分配新代码' }
  }
  if (node.kind === 'image' && node.meta.generationState === 'running') {
    return { expectedPrefix, code: null, kindLabel, unavailableReason: '图片节点仍在生成，节点代码暂不可用' }
  }
  if (node.kind === 'image' && node.meta.generationState === 'failed') {
    return { expectedPrefix, code: null, kindLabel, unavailableReason: '图片生成失败，节点代码不可用' }
  }
  if (node.kind === 'image' && node.transient === true) {
    return { expectedPrefix, code: null, kindLabel, unavailableReason: '临时图片节点没有节点代码' }
  }
  const code = validatePublicReferenceCode(node.referenceCode, expectedPrefix)
  if (code) return { expectedPrefix, code, kindLabel, unavailableReason: '' }
  return {
    expectedPrefix,
    code: null,
    kindLabel,
    unavailableReason: node.referenceCode ? '节点代码格式无效，无法复制' : '该节点尚无可复制的节点代码'
  }
}
