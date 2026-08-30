import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const repoRoot = path.resolve(__dirname, '..')
const scriptPath = path.join(repoRoot, 'scripts', 'start-dev-with-agent.ps1')
const devPortRuntimePath = path.join(repoRoot, 'scripts', 'dev-port-runtime.ps1')
const agentCheckScriptPath = path.join(repoRoot, 'scripts', 'check-agent-runtime.ps1')
const agentStartScriptPath = path.join(repoRoot, 'scripts', 'start-agent-runtime.ps1')
const storagePythonPath = path.join(repoRoot, 'agent-runtime', 'backend', '.venv', 'Scripts', 'python.exe')
const viteConfigPath = path.join(repoRoot, 'vite.config.ts')
const powershell = 'powershell'
const servers: Server[] = []
const tempDirs: string[] = []
const runtimeProcesses: Array<ReturnType<typeof spawn>> = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(runtimeProcesses.splice(0).map(stopProcessTree))
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
    )
  )
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function stopProcessTree(child: ReturnType<typeof spawn>) {
  if (!child.pid) return
  await stopProcessIds([child.pid])
}

async function stopProcessIds(processIds: number[]) {
  for (const processId of [...processIds].reverse()) {
    try {
      process.kill(processId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const running = await Promise.all(processIds.map(isProcessRunning))
    if (running.every(value => !value)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Could not stop agent runtime process tree ${processIds.join(', ')}`)
}

function getListeningProcessId(port: number) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Could not inspect listener on port ${port}: ${stderr}`))
        return
      }
      const match = stdout.split(/\r?\n/).find(line => {
        const columns = line.trim().split(/\s+/)
        if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') return false
        const localAddress = columns[1]
        return Number(localAddress.slice(localAddress.lastIndexOf(':') + 1)) === port
          && columns[3].toUpperCase() === 'LISTENING'
      })
      resolve(match ? Number(match.trim().split(/\s+/).at(-1)) : null)
    })
  })
}

async function waitForPortClosed(port: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!(await isPortListening(port))) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Runtime port ${port} remained reachable after cleanup`)
}

function isPortListening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (listening: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(250)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

function isProcessRunning(pid: number) {
  return new Promise<boolean>((resolve) => {
    const child = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(stdout.includes(`"${pid}"`)))
  })
}

function startHealthyServer(schemaVersion = 18) {
  const server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      ok: true,
      serviceVersion: '2.0.0',
      schemaVersion,
      capabilities: {
        assets: true,
        sqlite: true,
        projectResources: true,
        agentConversations: true,
        skillHub: true
      }
    }))
  })

  return new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Expected a TCP server address')
      }
      resolve(`http://127.0.0.1:${address.port}/health`)
    })
  })
}

async function getCurrentStorageSchemaVersion() {
  const { stdout } = await execFileAsync(storagePythonPath, [
    '-c',
    'from promptcard_storage.store import SCHEMA_VERSION; print(SCHEMA_VERSION)'
  ], {
    cwd: repoRoot,
    windowsHide: true,
    env: { ...process.env, PYTHONPATH: repoRoot }
  })
  const schemaVersion = Number(stdout.trim())
  if (!Number.isInteger(schemaVersion)) throw new Error(`Storage schema was not an integer: ${stdout}`)
  return schemaVersion
}

function startHealthyFrontendServer() {
  const server = createServer((request, response) => {
    if (request.url === '/src/main.tsx') {
      response.writeHead(200, { 'content-type': 'application/javascript' })
      response.end('import React from "/node_modules/.vite/deps/react.js?v=test"')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<title>PromptCard-Agent</title><script type="module" src="/src/main.tsx"></script>')
  })

  return new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected a TCP server address')
      resolve(`http://127.0.0.1:${address.port}/`)
    })
  })
}

function startForeignFrontendServer() {
  const server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<title>FacetWrite</title><script type="module" src="/src/main.tsx"></script>')
  })

  return new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected a TCP server address')
      resolve(`http://127.0.0.1:${address.port}/`)
    })
  })
}

function startPortBlocker(port: number) {
  const server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('occupied')
  })

  return new Promise<boolean>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve(false)
        return
      }
      reject(error)
    })
    server.listen(port, '127.0.0.1', () => {
      servers.push(server)
      resolve(true)
    })
  })
}

async function makeRuntimeManifestPath(name: string) {
  const root = path.join(repoRoot, 'logs')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(path.join(root, 'startup-test-'))
  tempDirs.push(dir)
  return path.join(dir, name)
}

async function makeMarkerCommand(markerName: string) {
  const dir = path.dirname(await makeRuntimeManifestPath(`${markerName}.runtime.json`))
  const markerPath = path.join(dir, markerName)
  const escapedMarkerPath = markerPath.replace(/'/g, "''")

  return {
    markerPath,
    command: `Set-Content -LiteralPath '${escapedMarkerPath}' -Value 'started'`
  }
}

async function makeIsolatedStartScriptFixture(name: string) {
  const runtimeManifestPath = await makeRuntimeManifestPath(`${name}.runtime.json`)
  const fixtureRoot = path.dirname(runtimeManifestPath)
  const fixtureScripts = path.join(fixtureRoot, 'scripts')
  await mkdir(fixtureScripts, { recursive: true })
  await Promise.all([
    copyFile(scriptPath, path.join(fixtureScripts, 'start-dev-with-agent.ps1')),
    copyFile(devPortRuntimePath, path.join(fixtureScripts, 'dev-port-runtime.ps1')),
    ...['start-storage-service.ps1', 'start-agent-runtime.ps1', 'start-text-agent-runtime.ps1'].map(file => (
      writeFile(path.join(fixtureScripts, file), 'exit 23\r\n')
    ))
  ])
  return {
    runtimeManifestPath,
    scriptPath: path.join(fixtureScripts, 'start-dev-with-agent.ps1')
  }
}

async function runServicesOnlyWithStorageSchema(name: string, schemaVersion: number) {
  const fixture = await makeIsolatedStartScriptFixture(name)
  const [storageUrl, agentUrl, textAgentUrl] = await Promise.all([
    startHealthyServer(schemaVersion),
    startHealthyServer(),
    startHealthyTextAgentServer()
  ])
  return runPowerShell([
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    fixture.scriptPath,
    '-StorageHealthUrl',
    storageUrl,
    '-AgentHealthUrl',
    agentUrl,
    '-TextAgentHealthUrl',
    textAgentUrl,
    '-RuntimeManifestPath',
    fixture.runtimeManifestPath,
    '-HealthTimeoutSeconds',
    '2',
    '-ServicesOnly'
  ])
}

function startHealthyTextAgentServer() {
  const server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"status":"healthy","service":"promptcard-pi-text-agent","orchestrator":"pi"}')
  })

  return new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected a TCP server address')
      resolve(`http://127.0.0.1:${address.port}/health`)
    })
  })
}

async function getAvailablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address')
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function waitForHealthyRuntime(
  child: ReturnType<typeof spawn>,
  url: string,
  output: () => string,
  timeoutMs = 30_000
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Agent runtime exited before health: ${output()}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return response
    } catch {
      // Runtime is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Agent runtime did not become healthy: ${output()}`)
}

async function makeFakeUv(name: string) {
  const dir = path.dirname(await makeRuntimeManifestPath(`${name}.runtime.json`))
  const logPath = path.join(dir, `${name}.log`)
  const uvPath = path.join(dir, 'uv.cmd')
  await writeFile(uvPath, [
    '@echo off',
    `>> "${logPath}" echo ARGS=%*`,
    `>> "${logPath}" echo UV_CACHE_DIR=%UV_CACHE_DIR%`,
    `>> "${logPath}" echo UV_PYTHON_INSTALL_DIR=%UV_PYTHON_INSTALL_DIR%`,
    `>> "${logPath}" echo UV_PROJECT_ENVIRONMENT=%UV_PROJECT_ENVIRONMENT%`,
    `>> "${logPath}" echo PROMPTCARD_RUNTIME_STATE_DIR=%PROMPTCARD_RUNTIME_STATE_DIR%`,
    `>> "${logPath}" echo PROMPTCARD_LIBRARY_FILE=%PROMPTCARD_LIBRARY_FILE%`,
    `>> "${logPath}" echo PYTHONPATH=%PYTHONPATH%`,
    'if "%1 %2"=="python install" (',
    '  mkdir "%UV_PYTHON_INSTALL_DIR%\\cpython-3.12.12-windows-x86_64-none" 2>nul',
    '  type nul > "%UV_PYTHON_INSTALL_DIR%\\cpython-3.12.12-windows-x86_64-none\\python.exe"',
    '  exit /b 0',
    ')',
    'exit /b 23'
  ].join('\r\n'))
  return { dir, logPath }
}

function runPowerShell(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(powershell, args, { cwd: repoRoot, windowsHide: true, env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ stdout, stderr, code })
    })
  })
}

async function expectScriptSupportsTestParameters() {
  const script = await readFile(scriptPath, 'utf8')
  expect(script).toContain('param(')
  expect(script).toContain('$StorageHealthUrl')
  expect(script).toContain('$AgentHealthUrl')
  expect(script).toContain('$TextAgentHealthUrl')
  expect(script).toContain('$FrontendUrl')
  expect(script).toContain('$RuntimeManifestPath')
  expect(script).toContain('$FrontendCommand')
  expect(script).toContain('New-PromptCardDevRuntime')
    expect(script).toContain('PROMPTCARD_DEV_RUNTIME_MANIFEST')
    expect(script).toContain('PROMPTCARD_IMAGE_GENERATION_NODE_V1')
    expect(script).toContain('$payload.capabilities.sqlite')
    expect(script).toContain('$payload.capabilities.projectResources')
    expect(script).toContain('unoptimized CommonJS React modules')
    expect(script).toContain('Stop-StalePromptCardServiceProcesses')
    expect(script).toContain('Stopping stale PromptCard service process')
    expect(script).toContain('storage-service.err.log')
    expect(script).toContain('agent-runtime.err.log')
}

describe('start-dev-with-agent.ps1', () => {
  test('starts a healthy agent runtime without model-key environment variables', async () => {
    const port = await getAvailablePort()
    let runtimeProcessId: number | null = null
    let stdout = ''
    let stderr = ''
    const credentialFreeEnv = { ...process.env }
    for (const key of ['DEEPSEEK_API_KEY', 'ARK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) {
      delete credentialFreeEnv[key]
    }
    const child = spawn(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', agentStartScriptPath
    ], {
      cwd: repoRoot,
      windowsHide: true,
      env: {
        ...credentialFreeEnv,
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(port)
      }
    })
    runtimeProcesses.push(child)
    child.stdout?.on('data', chunk => { stdout += chunk.toString() })
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })

    try {
      const response = await waitForHealthyRuntime(
        child,
        `http://127.0.0.1:${port}/health`,
        () => `${stdout}\n${stderr}`
      )
      runtimeProcessId = await getListeningProcessId(port)
      expect(runtimeProcessId).not.toBeNull()
      await expect(response.json()).resolves.toMatchObject({ status: 'healthy' })
      expect(child.exitCode).toBeNull()
    } finally {
      if (runtimeProcessId) await stopProcessIds([runtimeProcessId])
      await stopProcessTree(child)
      await waitForPortClosed(port)
    }
  }, 45_000)

  test('overrides hostile uv paths and provisions only the workspace-local Python', async () => {
    for (const [name, runtimeScript] of [['start', agentStartScriptPath]] as const) {
      const fakeUv = await makeFakeUv(`fake-uv-${name}`)
      const fixtureScripts = path.join(fakeUv.dir, 'scripts')
      const fixtureScript = path.join(fixtureScripts, path.basename(runtimeScript))
      await mkdir(fixtureScripts, { recursive: true })
      await copyFile(runtimeScript, fixtureScript)
      const poisonedVenv = path.join(fakeUv.dir, 'agent-runtime', 'backend', '.venv')
      await mkdir(path.join(poisonedVenv, 'Scripts'), { recursive: true })
      await writeFile(path.join(poisonedVenv, 'Scripts', 'python.exe'), 'must not execute')
      await writeFile(path.join(poisonedVenv, 'pyvenv.cfg'), 'home = C:\\hostile\\python\r\n')
      const expectedCache = path.join(fakeUv.dir, '.uv-cache')
      const expectedPythonInstall = path.join(fakeUv.dir, 'agent-runtime', 'backend', '.python')
      const expectedEnvironment = path.join(fakeUv.dir, 'agent-runtime', 'backend', '.venv')
      const expectedBackend = path.join(fakeUv.dir, 'agent-runtime', 'backend')
      const expectedPython = path.join(expectedPythonInstall, 'cpython-3.12.12-windows-x86_64-none', 'python.exe')
      const expectedRuntimeState = path.join(fakeUv.dir, 'logs', 'agent-runtime-state')
      const result = await runPowerShell([
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript
      ], {
        PATH: `${fakeUv.dir}${path.delimiter}${process.env.PATH || process.env.Path || ''}`,
        UV_CACHE_DIR: 'C:\\hostile\\cache',
        UV_PYTHON_INSTALL_DIR: 'C:\\hostile\\python',
        UV_PROJECT_ENVIRONMENT: 'C:\\hostile\\venv',
        PROMPTCARD_RUNTIME_STATE_DIR: 'C:\\',
        PROMPTCARD_LIBRARY_FILE: 'C:\\hostile\\prompt-library.json',
        PYTHONPATH: 'C:\\hostile\\pythonpath'
      })

      expect(result.code).not.toBe(0)
      const log = await readFile(fakeUv.logPath, 'utf8')
      expect(log).toContain('ARGS=python install 3.12.12')
      expect(log).toContain(`ARGS=sync --project ${expectedBackend} --python ${expectedPython}`)
      expect(log).toContain(`UV_CACHE_DIR=${expectedCache}`)
      expect(log).toContain(`UV_PYTHON_INSTALL_DIR=${expectedPythonInstall}`)
      expect(log).toContain(`UV_PROJECT_ENVIRONMENT=${expectedEnvironment}`)
      expect(log).toContain(`PROMPTCARD_RUNTIME_STATE_DIR=${expectedRuntimeState}`)
      expect(log).toContain(`PROMPTCARD_LIBRARY_FILE=${path.join(fakeUv.dir, 'data', 'prompt-library-presets.json')}`)
      expect(log).toContain(`PYTHONPATH=${expectedBackend}`)
      expect(log).not.toContain('C:\\')
    }
  }, 45_000)

  test('preserves workspace-local desktop profile paths when starting the agent runtime', async () => {
    const fakeUv = await makeFakeUv('fake-uv-desktop-profile')
    const fixtureScripts = path.join(fakeUv.dir, 'scripts')
    const fixtureScript = path.join(fixtureScripts, path.basename(agentStartScriptPath))
    await mkdir(fixtureScripts, { recursive: true })
    await copyFile(agentStartScriptPath, fixtureScript)

    const profileRoot = path.join(fakeUv.dir, 'logs', 'desktop-profile')
    const expectedRuntimeState = path.join(profileRoot, 'agent-runtime', '.promptcard-runtime')
    const expectedLibraryFile = path.join(profileRoot, 'data', 'prompt-library-presets.json')
    const result = await runPowerShell([
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript
    ], {
      PATH: `${fakeUv.dir}${path.delimiter}${process.env.PATH || process.env.Path || ''}`,
      PROMPTCARD_RUNTIME_STATE_DIR: expectedRuntimeState,
      PROMPTCARD_LIBRARY_FILE: expectedLibraryFile
    })

    expect(result.code).not.toBe(0)
    const log = await readFile(fakeUv.logPath, 'utf8')
    expect(log).toContain(`PROMPTCARD_RUNTIME_STATE_DIR=${expectedRuntimeState}`)
    expect(log).toContain(`PROMPTCARD_LIBRARY_FILE=${expectedLibraryFile}`)
  }, 45_000)

  test('starts and checks the agent runtime without importing a plaintext model key', async () => {
    const sources = await Promise.all([readFile(agentCheckScriptPath, 'utf8'), readFile(agentStartScriptPath, 'utf8')])

    for (const source of sources) {
      expect(source).not.toContain('API-Key.txt')
      expect(source).not.toContain('PROMPTCARD_AGENT_API_KEY_FILE')
      expect(source).not.toContain('DEEPSEEK_API_KEY')
      expect(source).not.toContain('sk-')
      expect(source).not.toMatch(/C:\\(?:Users|Program Files)/)
    }
  })

  test('checks secure image runtime dependencies with a workspace-local repair command', async () => {
    const source = await readFile(agentCheckScriptPath, 'utf8')

    expect(source).toContain('import keyring')
    expect(source).toContain('from volcenginesdkarkruntime import Ark')
    expect(source).toContain('uv sync --project')
    expect(source).toContain('UV_CACHE_DIR')
    expect(source).toContain('UV_PYTHON_INSTALL_DIR')
    expect(source).toContain('$RuntimeEnvironment')
    expect(source).toContain("'model_credentials': 'configured at invocation'")
    expect(source).not.toContain('from app.gateway.app import create_app')
    expect(source).not.toContain('get_app_config')
  })

  test('parses as valid PowerShell', async () => {
    const command = [
      '$errors = $null',
      `[System.Management.Automation.PSParser]::Tokenize((Get-Content -LiteralPath '${scriptPath.replace(/'/g, "''")}' -Raw), [ref]$errors) | Out-Null`,
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }'
    ].join('; ')

    const result = await runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command])

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stderr).toBe('')
  })

  test('accepts the schema exported by the current Storage runtime', async () => {
    const currentSchemaVersion = await getCurrentStorageSchemaVersion()
    const result = await runServicesOnlyWithStorageSchema('current-storage-schema', currentSchemaVersion)

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('PromptCard storage service is already healthy')
    expect(result.stdout).toContain('PromptCard local services are healthy')
  }, 15_000)

  test('rejects a legacy Storage schema even when its health response is otherwise valid', async () => {
    const currentSchemaVersion = await getCurrentStorageSchemaVersion()
    expect(currentSchemaVersion).toBeGreaterThan(9)
    const result = await runServicesOnlyWithStorageSchema('legacy-storage-schema', 9)

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain('incompatible storage version')
    expect(`${result.stdout}\n${result.stderr}`).toContain('did not become healthy within 2 seconds')
  }, 15_000)

  test('exits without running frontend command when all services are healthy', async () => {
    await expectScriptSupportsTestParameters()
    const [storageUrl, agentUrl, textAgentUrl, frontendUrl] = await Promise.all([
      startHealthyServer(),
      startHealthyServer(),
      startHealthyTextAgentServer(),
      startHealthyFrontendServer()
    ])
    const marker = await makeMarkerCommand('frontend-started.txt')
    const runtimeManifestPath = await makeRuntimeManifestPath('all-healthy-runtime.json')

    const result = await runPowerShell([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-StorageHealthUrl',
      storageUrl,
      '-AgentHealthUrl',
      agentUrl,
      '-TextAgentHealthUrl',
      textAgentUrl,
      '-FrontendUrl',
      frontendUrl,
      '-RuntimeManifestPath',
      runtimeManifestPath,
      '-FrontendCommand',
      marker.command,
      '-HealthTimeoutSeconds',
      '2'
    ])

    await expect(readFile(marker.markerPath, 'utf8')).rejects.toThrow()
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('Vite frontend is already healthy')
  })

  test('runs frontend command when storage and agent are healthy but frontend is unavailable', async () => {
    await expectScriptSupportsTestParameters()
    const [storageUrl, agentUrl, textAgentUrl] = await Promise.all([startHealthyServer(), startHealthyServer(), startHealthyTextAgentServer()])
    const marker = await makeMarkerCommand('frontend-started.txt')
    const runtimeManifestPath = await makeRuntimeManifestPath('frontend-missing-runtime.json')

    const result = await runPowerShell([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-StorageHealthUrl',
      storageUrl,
      '-AgentHealthUrl',
      agentUrl,
      '-TextAgentHealthUrl',
      textAgentUrl,
      '-FrontendUrl',
      'http://127.0.0.1:1/',
      '-RuntimeManifestPath',
      runtimeManifestPath,
      '-FrontendCommand',
      marker.command,
      '-HealthTimeoutSeconds',
      '2'
    ])

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
    await expect(readFile(marker.markerPath, 'utf8')).resolves.toBe('started\r\n')
  }, 15_000)

  test('does not treat another Vite app as a healthy frontend', async () => {
    await expectScriptSupportsTestParameters()
    const [storageUrl, agentUrl, textAgentUrl, frontendUrl] = await Promise.all([
      startHealthyServer(),
      startHealthyServer(),
      startHealthyTextAgentServer(),
      startForeignFrontendServer()
    ])
    const marker = await makeMarkerCommand('foreign-frontend-started.txt')
    const runtimeManifestPath = await makeRuntimeManifestPath('foreign-frontend-runtime.json')

    const result = await runPowerShell([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-StorageHealthUrl',
      storageUrl,
      '-AgentHealthUrl',
      agentUrl,
      '-TextAgentHealthUrl',
      textAgentUrl,
      '-FrontendUrl',
      frontendUrl,
      '-RuntimeManifestPath',
      runtimeManifestPath,
      '-FrontendCommand',
      marker.command,
      '-HealthTimeoutSeconds',
      '2'
    ])

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
    await expect(readFile(marker.markerPath, 'utf8')).resolves.toBe('started\r\n')
  }, 15_000)

  test('falls forward from the preferred frontend port when it is already occupied', async () => {
    await startPortBlocker(3000)
    const [storageUrl, agentUrl, textAgentUrl] = await Promise.all([startHealthyServer(), startHealthyServer(), startHealthyTextAgentServer()])
    const marker = await makeMarkerCommand('frontend-started.txt')
    const runtimeManifestPath = await makeRuntimeManifestPath('frontend-fallback-runtime.json')

    const result = await runPowerShell([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-StorageHealthUrl',
      storageUrl,
      '-AgentHealthUrl',
      agentUrl,
      '-TextAgentHealthUrl',
      textAgentUrl,
      '-RuntimeManifestPath',
      runtimeManifestPath,
      '-FrontendCommand',
      marker.command,
      '-HealthTimeoutSeconds',
      '2'
    ])

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
    const runtime = JSON.parse(await readFile(runtimeManifestPath, 'utf8'))
    expect(runtime.frontendUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(runtime.ports.frontend).not.toBe(3000)
    await expect(readFile(marker.markerPath, 'utf8')).resolves.toBe('started\r\n')
  }, 15_000)

  test('fails clearly when an explicit frontend port is occupied', async () => {
    const occupiedFrontendUrl = await startHealthyFrontendServer()
    const occupiedPort = new URL(occupiedFrontendUrl).port
    const [storageUrl, agentUrl, textAgentUrl] = await Promise.all([startHealthyServer(), startHealthyServer(), startHealthyTextAgentServer()])
    const marker = await makeMarkerCommand('frontend-started.txt')
    const runtimeManifestPath = await makeRuntimeManifestPath('explicit-occupied-runtime.json')

    const result = await runPowerShell([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-StorageHealthUrl',
      storageUrl,
      '-AgentHealthUrl',
      agentUrl,
      '-TextAgentHealthUrl',
      textAgentUrl,
      '-RuntimeManifestPath',
      runtimeManifestPath,
      '-FrontendCommand',
      marker.command,
      '-HealthTimeoutSeconds',
      '2'
    ], {
      PROMPTCARD_FRONTEND_PORT: occupiedPort
    })

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(`Frontend port ${occupiedPort} is occupied`)
    await expect(readFile(marker.markerPath, 'utf8')).rejects.toThrow()
  }, 15_000)

  test('configures Vite proxy targets from runtime environment variables', async () => {
    const config = await readFile(viteConfigPath, 'utf8')

    expect(config).toContain('PROMPTCARD_FRONTEND_PORT')
    expect(config).toContain('PROMPTCARD_AGENT_URL')
    expect(config).toContain('PROMPTCARD_STORAGE_URL')
    expect(config).toContain('target: `${agentUrl}/api`')
    expect(config).toContain('target: `${storageUrl}/api`')
  })
})
