import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

export interface CodexJsonEvent {
  type: string
  thread_id?: string
  item?: {
    id: string
    type: string
    server?: string
    tool?: string
    arguments?: Record<string, unknown>
    result?: { content?: Array<{ type: string; text?: string }> } | null
    error?: unknown
    status?: string
    text?: string
  }
}

export interface RealCodexRun {
  events: CodexJsonEvent[]
  stderr: string
}

export interface MaterializedCodexImage {
  absoluteWorkspacePath: string
  workspaceRelativePath: string
  filename: string
  contentDigest: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  byteLength: number
}

export const runRealCodexPrompt = async (
  prompt: string,
  timeoutMs = 180_000
): Promise<RealCodexRun> => {
  const repositoryRoot = process.cwd()
  const executable = process.env.PROMPTCARD_REAL_CODEX_CLI || 'codex.exe'
  const requiredEnvironment = [
    'PROMPTCARD_BRIDGE_URL',
    'PROMPTCARD_BRIDGE_TOKEN',
    'PROMPTCARD_BRIDGE_WORKSPACE_ROOT'
  ]
  for (const name of requiredEnvironment) {
    if (!process.env[name]) throw new Error(`Real Codex acceptance requires ${name}.`)
  }
  const args = [
    '-a', 'never',
    '--disable', 'plugins',
    '--disable', 'apps',
    '--disable', 'browser_use',
    '--disable', 'browser_use_external',
    '--disable', 'computer_use',
    '--disable', 'shell_tool',
    '--disable', 'skill_search',
    '--disable', 'multi_agent',
    '--enable', 'image_generation',
    '-c', 'mcp_servers.promptcard.command="npm.cmd"',
    '-c', 'mcp_servers.promptcard.args=["run","mcp:stdio"]',
    '-c', `mcp_servers.promptcard.cwd=${JSON.stringify(repositoryRoot)}`,
    '-c', 'mcp_servers.promptcard.env_vars=["PROMPTCARD_BRIDGE_URL","PROMPTCARD_BRIDGE_TOKEN","PROMPTCARD_BRIDGE_WORKSPACE_ROOT"]',
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox', 'read-only',
    '--json',
    '-C', repositoryRoot,
    prompt
  ]

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let finished = false
    const timeout = setTimeout(() => {
      if (finished) return
      child.kill()
      reject(new Error(`Real Codex acceptance exceeded ${timeoutMs} ms.`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', code => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`Real Codex exited with ${code}. stderr=${stderr.slice(-4_000)}`))
        return
      }
      const events = stdout.split(/\r?\n/).flatMap(line => {
        try {
          return line.trim().startsWith('{') ? [JSON.parse(line) as CodexJsonEvent] : []
        } catch {
          return []
        }
      })
      resolve({ events, stderr })
    })
    child.stdin.end()
  })
}

export const materializeManagedCodexImage = async (
  run: RealCodexRun,
  workspaceRelativePath: string
): Promise<MaterializedCodexImage> => {
  const sourceCandidate = generatedImageArtifactPath(run)
  const codexRoot = process.env.CODEX_HOME || join(homedir(), '.codex')
  const managedRootCandidate = process.env.PROMPTCARD_REAL_CODEX_GENERATED_IMAGES_ROOT
    || join(codexRoot, 'generated_images')
  const workspaceRootCandidate = process.env.PROMPTCARD_BRIDGE_WORKSPACE_ROOT
  if (!workspaceRootCandidate) throw new Error('Real Codex image acceptance requires PROMPTCARD_BRIDGE_WORKSPACE_ROOT.')

  const [managedRoot, sourcePath, workspaceRoot] = await Promise.all([
    realpath(managedRootCandidate),
    realpath(sourceCandidate),
    realpath(workspaceRootCandidate)
  ])
  assertContainedPath(managedRoot, sourcePath, 'Codex image artifact escaped the managed generated-images root.')
  const sourceStat = await stat(sourcePath)
  if (!sourceStat.isFile() || sourceStat.size < 1 || sourceStat.size > 30 * 1024 * 1024) {
    throw new Error('Codex image artifact is not one bounded regular file.')
  }

  const normalizedRelativePath = workspaceRelativePath.replaceAll('\\', '/')
  if (
    !normalizedRelativePath
    || isAbsolute(normalizedRelativePath)
    || normalizedRelativePath.split('/').some(part => part === '' || part === '.' || part === '..')
    || normalizedRelativePath.includes(':')
  ) {
    throw new Error('Codex image workspace path is not a safe relative path.')
  }
  const absoluteWorkspacePath = resolve(workspaceRoot, normalizedRelativePath)
  assertContainedPath(workspaceRoot, absoluteWorkspacePath, 'Codex image workspace path escaped the configured root.')

  const content = await readFile(sourcePath)
  const mediaType = rasterMediaType(content)
  const expectedExtension = mediaType === 'image/png'
    ? '.png'
    : mediaType === 'image/jpeg' ? '.jpg' : '.webp'
  const sourceExtension = extname(sourcePath).toLowerCase()
  const destinationExtension = extname(absoluteWorkspacePath).toLowerCase()
  if (
    (mediaType === 'image/jpeg' ? !['.jpg', '.jpeg'].includes(sourceExtension) : sourceExtension !== expectedExtension)
    || (mediaType === 'image/jpeg' ? !['.jpg', '.jpeg'].includes(destinationExtension) : destinationExtension !== expectedExtension)
  ) {
    throw new Error('Codex image artifact extension does not match its raster bytes.')
  }

  await mkdir(dirname(absoluteWorkspacePath), { recursive: true })
  await copyFile(sourcePath, absoluteWorkspacePath)
  const copied = await readFile(absoluteWorkspacePath)
  if (!copied.equals(content)) throw new Error('Codex image artifact changed while entering the workspace.')
  return {
    absoluteWorkspacePath,
    workspaceRelativePath: normalizedRelativePath,
    filename: basename(absoluteWorkspacePath),
    contentDigest: `sha256:${createHash('sha256').update(copied).digest('hex')}`,
    mediaType,
    byteLength: copied.length
  }
}

const generatedImageArtifactPath = (run: RealCodexRun): string => {
  const messages = run.events.flatMap(event => (
    event.type === 'item.completed'
    && event.item?.type === 'agent_message'
    && typeof event.item.text === 'string'
      ? [event.item.text]
      : []
  ))
  for (const message of messages.reverse()) {
    for (const line of message.split(/\r?\n/).reverse()) {
      const candidate = line.trim().replace(/^([`"])(.*)\1$/, '$2')
      if (isAbsolute(candidate) && /\.(?:png|jpe?g|webp)$/i.test(candidate)) return candidate
    }
  }
  throw new Error('Real Codex did not return one absolute generated-image artifact path.')
}

const assertContainedPath = (root: string, candidate: string, message: string) => {
  const child = relative(root, candidate)
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error(message)
}

const rasterMediaType = (content: Buffer): MaterializedCodexImage['mediaType'] => {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png'
  }
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return 'image/jpeg'
  }
  if (content.length >= 12 && content.subarray(0, 4).toString('ascii') === 'RIFF'
    && content.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  throw new Error('Codex image artifact is not a supported raster image.')
}

export const completedPromptCardCalls = (run: RealCodexRun): CodexJsonEvent['item'][] => (
  run.events.flatMap(event => (
    event.type === 'item.completed'
    && event.item?.type === 'mcp_tool_call'
    && event.item.server === 'promptcard'
      ? [event.item]
      : []
  ))
)
