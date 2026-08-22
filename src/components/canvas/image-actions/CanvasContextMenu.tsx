import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import {
  getCanvasContextMenuLayout,
  type ContextMenuPosition
} from './image-action-ui'

interface CanvasContextMenuProps {
  position: ContextMenuPosition
  ariaLabel: string
  estimatedHeight: number
  onClose: () => void
  children: ReactNode
}

interface CanvasContextMenuItemProps {
  icon: ReactNode
  label: string
  shortcut?: string
  disabled?: boolean
  title?: string
  onSelect: () => void
}

const menuWidth = 224

export const CanvasContextMenu = ({
  position,
  ariaLabel,
  estimatedHeight,
  onClose,
  children
}: CanvasContextMenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null)
  const layout = getCanvasContextMenuLayout(
    position,
    typeof window === 'undefined'
      ? { width: 1440, height: 900 }
      : { width: window.innerWidth, height: window.innerHeight },
    { width: menuWidth, height: estimatedHeight }
  )

  useEffect(() => {
    const menu = menuRef.current
    const firstEnabled = menu?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    if (firstEnabled) firstEnabled.focus()
    else menu?.focus()
  }, [])

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label={ariaLabel}
      className="fixed z-[75] w-56 overflow-y-auto rounded-xl border border-gray-200 bg-white p-1 text-gray-900 shadow-[0_18px_50px_rgba(15,23,42,0.18)]"
      style={{ left: layout.x, top: layout.y, maxHeight: layout.maxHeight }}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => handleMenuKey(event, onClose)}
    >
      {children}
    </div>
  )
}

export const CanvasContextMenuItem = ({
  icon,
  label,
  shortcut,
  disabled = false,
  title,
  onSelect
}: CanvasContextMenuItemProps) => (
  <button
    type="button"
    role="menuitem"
    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium leading-5 text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300"
    disabled={disabled}
    title={title || label}
    onClick={onSelect}
  >
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
    <span>{label}</span>
    {shortcut && <kbd className="ml-auto text-[11px] font-medium text-gray-400">{shortcut}</kbd>}
  </button>
)

const handleMenuKey = (
  event: KeyboardEvent<HTMLDivElement>,
  onClose: () => void
) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    onClose()
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
  if (buttons.length === 0) return
  event.preventDefault()
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? buttons.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
