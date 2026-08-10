import { useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { Camera, CheckCircle2, ClipboardPaste, Clock3, Download, ExternalLink, Film, GripHorizontal, ImagePlus, Mic, PlaySquare, ShieldCheck, Video, Wand2, X } from 'lucide-react'
import type { CaptureToolbarStatus } from './capture-toolbar-window'

export type ClipboardCaptureStatus = 'idle' | 'reading' | 'saving' | 'saved' | 'error'

interface CaptureBarScreenProps {
  status: CaptureToolbarStatus
  errorMessage?: string
  onOpenToolbar: () => void
  onCloseToolbar: () => void
  clipboardStatus?: ClipboardCaptureStatus
  clipboardMessage?: string
  onReadClipboard?: () => void
  onPasteClipboard?: (event: React.ClipboardEvent<HTMLElement>) => void
  onDropBrowserImage?: (event: ReactDragEvent<HTMLElement>) => void
  onOpenRecentCaptures?: () => void
}

const statusCopy: Record<CaptureToolbarStatus, { label: string; description: string; tone: string }> = {
  closed: {
    label: '未启动',
    description: '程序启动时不会默认创建捕获栏窗口，需要时手动打开。',
    tone: 'bg-gray-100 text-gray-600'
  },
  opening: {
    label: '启动中',
    description: '正在创建浮动捕获栏窗口。',
    tone: 'bg-amber-50 text-amber-700'
  },
  running: {
    label: '运行中',
    description: '捕获栏已开启，可从浮动工具条快速截图。',
    tone: 'bg-emerald-50 text-emerald-700'
  },
  closing: {
    label: '关闭中',
    description: '正在关闭捕获栏窗口。',
    tone: 'bg-amber-50 text-amber-700'
  },
  error: {
    label: '错误',
    description: '捕获栏操作失败，请确认当前运行在桌面壳中。',
    tone: 'bg-red-50 text-red-600'
  }
}

const moduleItems = [
  { title: '截图捕获', description: '拖选区域并保存到 Recent Captures。', status: '可用', icon: Camera, active: true },
  { title: '录屏', description: '录制选区视频素材。', status: '计划中', icon: Video },
  { title: '音频捕获', description: '为录屏补充音频输入。', status: '计划中', icon: Mic },
  { title: 'GIF 导出', description: '为短静音片段生成 GIF。', status: '计划中', icon: Download },
  { title: '视频画布节点', description: '把录屏作为可播放节点放入自由画布。', status: '计划中', icon: PlaySquare },
  { title: '时间轴抽帧', description: '从视频中提取可追溯的关键帧。', status: '计划中', icon: Film },
  { title: 'Storyboard 推断', description: '根据关键帧生成可审核分镜草稿。', status: '计划中', icon: ImagePlus },
  { title: '视觉 Agent 分析', description: '仅分析用户选中的捕获素材。', status: '计划中', icon: Wand2 }
] as const

const settings = [
  '启动时自动开启：关闭',
  '截图默认保存到 Recent Captures',
  '截图完成后跳转到媒体页',
  '录屏模块：计划中'
]

export const CaptureBarScreen = ({
  status,
  errorMessage,
  onOpenToolbar,
  onCloseToolbar,
  clipboardStatus = 'idle',
  clipboardMessage = '',
  onReadClipboard = () => undefined,
  onPasteClipboard = () => undefined,
  onDropBrowserImage = () => undefined,
  onOpenRecentCaptures = () => undefined
}: CaptureBarScreenProps) => {
  const statusState = statusCopy[status]
  const isOpening = status === 'opening'
  const isClosing = status === 'closing'
  const isRunning = status === 'running'
  const dragDepth = useRef(0)
  const [isBrowserImageDragging, setIsBrowserImageDragging] = useState(false)

  const handleDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepth.current += 1
    setIsBrowserImageDragging(true)
  }

  const handleDragOver = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsBrowserImageDragging(false)
  }

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current = 0
    setIsBrowserImageDragging(false)
    onDropBrowserImage(event)
  }

  return (
    <section
      className="min-h-screen bg-[#f7f7f5] px-8 py-8"
      data-capture-bar-screen
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isBrowserImageDragging && (
        <div
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-amber-50/95 p-8 backdrop-blur-sm"
          data-browser-image-drop-overlay
        >
          <div className="flex max-w-lg flex-col items-center rounded-2xl border-2 border-dashed border-amber-400 bg-white px-10 py-12 text-center shadow-2xl">
            <ImagePlus className="h-12 w-12 text-amber-500" />
            <div className="mt-4 text-2xl font-black text-gray-950">松开以保存图片</div>
            <div className="mt-2 text-sm font-semibold text-gray-500">图片会进入近期捕获，并停留在当前页面。</div>
          </div>
        </div>
      )}
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
        <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-black text-gray-500">
              <Camera className="h-4 w-4 text-amber-500" />
              快速捕获参考
            </div>
            <h1 className="text-4xl font-black tracking-tight text-gray-950">捕获栏</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
              控制浮动捕获工具条的启动、关闭和后续模块。捕获结果仍进入媒体页的 Recent Captures 收件箱。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="inline-flex h-12 items-center gap-2 rounded-lg bg-gray-950 px-5 text-sm font-black text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
              disabled={isOpening || isRunning || isClosing}
              onClick={onOpenToolbar}
            >
              <Camera className="h-4 w-4" />
              启动捕获栏
            </button>
            <button
              type="button"
              className="inline-flex h-12 items-center gap-2 rounded-lg border border-gray-200 bg-white px-5 text-sm font-black text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
              disabled={isOpening || isClosing || !isRunning}
              onClick={onCloseToolbar}
            >
              <X className="h-4 w-4" />
              关闭捕获栏
            </button>
          </div>
        </header>

        <section
          data-clipboard-capture
          tabIndex={0}
          onPaste={onPasteClipboard}
          className="rounded-lg border-2 border-dashed border-amber-200 bg-amber-50/60 p-5 outline-none transition focus:border-amber-400 focus:ring-4 focus:ring-amber-100"
        >
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
            <div className="flex items-start gap-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-white text-amber-500 shadow-sm">
                <ClipboardPaste className="h-6 w-6" />
              </span>
              <div>
                <h2 className="text-lg font-black text-gray-950">粘贴剪贴板截图</h2>
                <p className="mt-1 text-sm leading-6 text-gray-600">支持从浏览器拖入当前图片，也支持微信、QQ 等截图工具复制的 PNG、JPEG、WebP。点击读取，或聚焦此区域后按 Ctrl+V。</p>
                {clipboardMessage && (
                  <p className={`mt-2 text-sm font-bold ${clipboardStatus === 'error' ? 'text-red-600' : 'text-emerald-700'}`} role="status">
                    {clipboardMessage}
                  </p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                disabled={clipboardStatus === 'reading' || clipboardStatus === 'saving'}
                onClick={onReadClipboard}
                className="inline-flex h-11 items-center gap-2 rounded-lg bg-amber-500 px-4 text-sm font-black text-gray-950 transition hover:bg-amber-400 disabled:cursor-wait disabled:bg-amber-200"
              >
                <ClipboardPaste className="h-4 w-4" />
                {clipboardStatus === 'reading' ? '读取中...' : clipboardStatus === 'saving' ? '保存中...' : '读取剪贴板'}
              </button>
              <button
                type="button"
                onClick={onOpenRecentCaptures}
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 text-sm font-black text-gray-700 hover:bg-gray-50"
              >
                <ExternalLink className="h-4 w-4" />
                查看近期捕获
              </button>
            </div>
          </div>
        </section>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_420px]">
          <div className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-black text-gray-950">默认预览</h2>
                <p className="mt-1 text-sm font-medium text-gray-400">实际浮动窗口会保持小尺寸、置顶、无任务栏占位。</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-black ${statusState.tone}`}>{statusState.label}</span>
            </div>

            <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50">
              <div className="flex h-12 items-center gap-1 rounded-lg border border-gray-200 bg-white/95 px-2 shadow-[0_6px_18px_rgba(15,23,42,0.08)]">
                <PreviewButton label="拖动" icon={<GripHorizontal className="h-4 w-4" />} muted />
                <PreviewButton label="截图" icon={<Camera className="h-4 w-4" />} active />
                <PreviewButton label="录屏计划中" icon={<Video className="h-4 w-4" />} disabled />
                <PreviewButton label="关闭" icon={<X className="h-4 w-4" />} muted />
              </div>
            </div>
          </div>

          <aside className="flex flex-col gap-5">
            <div className="rounded-lg border border-gray-200 bg-white p-5">
              <h2 className="text-lg font-black text-gray-950">捕获栏状态</h2>
              <p className="mt-2 text-sm leading-6 text-gray-500">{errorMessage || statusState.description}</p>
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-3 text-xs font-bold text-gray-500">
                <ShieldCheck className="h-4 w-4 text-emerald-500" />
                原始捕获不会默认进入 Agent 上下文。
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-5">
              <h2 className="text-lg font-black text-gray-950">当前设置</h2>
              <div className="mt-4 space-y-3">
                {settings.map(setting => (
                  <div key={setting} className="flex items-center gap-3 text-sm font-bold text-gray-600">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    {setting}
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>

        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black text-gray-950">模块菜单</h2>
              <p className="mt-1 text-sm font-medium text-gray-400">先服务快速截图，后续模块按计划逐步打开。</p>
            </div>
            <Clock3 className="h-5 w-5 text-gray-300" />
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {moduleItems.map(item => (
              <ModuleCard key={item.title} {...item} />
            ))}
          </div>
        </section>
      </div>
    </section>
  )
}

const PreviewButton = ({
  label,
  icon,
  active = false,
  disabled = false,
  muted = false
}: {
  label: string
  icon: JSX.Element
  active?: boolean
  disabled?: boolean
  muted?: boolean
}) => (
  <div
    className={`flex h-9 w-9 items-center justify-center rounded-md ${
      active
        ? 'bg-gray-950 text-white'
        : disabled
          ? 'bg-gray-100 text-gray-300'
          : muted
            ? 'text-gray-400'
            : 'text-gray-700'
    }`}
    aria-label={label}
    title={label}
  >
    {icon}
  </div>
)

const ModuleCard = ({
  title,
  description,
  status,
  icon: Icon,
  active = false
}: {
  title: string
  description: string
  status: string
  icon: typeof Camera
  active?: boolean
}) => (
  <div className="rounded-lg border border-gray-200 bg-white p-4">
    <div className="flex items-start justify-between gap-3">
      <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${active ? 'bg-amber-50 text-amber-500' : 'bg-gray-50 text-gray-400'}`}>
        <Icon className="h-5 w-5" />
      </span>
      <span className={`rounded-full px-2 py-1 text-[11px] font-black ${active ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>
        {status}
      </span>
    </div>
    <h3 className="mt-4 text-sm font-black text-gray-950">{title}</h3>
    <p className="mt-2 text-xs font-medium leading-5 text-gray-400">{description}</p>
  </div>
)
