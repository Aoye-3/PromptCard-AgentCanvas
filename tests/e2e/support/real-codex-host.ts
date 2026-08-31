import { spawn } from 'node:child_process'

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

export const completedPromptCardCalls = (run: RealCodexRun): CodexJsonEvent['item'][] => (
  run.events.flatMap(event => (
    event.type === 'item.completed'
    && event.item?.type === 'mcp_tool_call'
    && event.item.server === 'promptcard'
      ? [event.item]
      : []
  ))
)
