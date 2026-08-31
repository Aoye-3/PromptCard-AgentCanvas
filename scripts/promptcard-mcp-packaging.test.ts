import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(__dirname, '..')
const launcher = path.join(repoRoot, 'scripts', 'start-promptcard-mcp.ps1')
const diagnostics = path.join(repoRoot, 'scripts', 'diagnose-promptcard-bridge.ps1')
const configRoot = path.join(repoRoot, 'config', 'promptcard-bridge')
const token = 'task28-read-only-token-that-must-never-appear-in-output'

describe('PromptCard optional MCP package', () => {
  test('ships least-authority and full-review Gateway profile examples', async () => {
    const readOnly = JSON.parse(await readFile(
      path.join(configRoot, 'profiles.read-only.example.json'), 'utf8'
    ))
    const fullReview = JSON.parse(await readFile(
      path.join(configRoot, 'profiles.full-review.example.json'), 'utf8'
    ))

    expect(readOnly['codex-read-only'].scopes).toEqual(['bridge:read'])
    expect(fullReview['codex-full-review'].scopes).toEqual([
      'bridge:read',
      'bridge:deliver:document',
      'bridge:deliver:storyboard',
      'bridge:deliver:prompt',
      'bridge:deliver:image',
      'bridge:status'
    ])
    expect(JSON.stringify({ readOnly, fullReview })).not.toContain(token)
  })

  test('keeps Codex verified and TRAE candidate templates on the same stdio launcher', async () => {
    const codex = await readFile(path.join(configRoot, 'codex-stdio.example.toml'), 'utf8')
    const trae = JSON.parse(await readFile(
      path.join(configRoot, 'trae-stdio.candidate.json'), 'utf8'
    ))

    expect(codex).toContain('[mcp_servers.promptcard]')
    expect(codex).toContain('start-promptcard-mcp.ps1')
    expect(codex).toContain('PROMPTCARD_BRIDGE_TOKEN')
    expect(codex).toContain('promptcard_runtime_describe')
    expect(codex).not.toContain('promptcard_delivery_commit')
    expect(trae.mcpServers.promptcard.args.some(
      (argument: string) => argument.endsWith('scripts\\start-promptcard-mcp.ps1')
    )).toBe(true)
    expect(trae.mcpServers.promptcard.env.PROMPTCARD_BRIDGE_TOKEN).toBe('replace-with-local-bridge-token')
  })

  test('validates a stdio launch without downloads or credential echo', async () => {
    const { stdout, stderr } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher,
      '-Transport', 'stdio', '-Check'
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PROMPTCARD_BRIDGE_URL: 'http://127.0.0.1:38101',
        PROMPTCARD_BRIDGE_TOKEN: token
      },
      windowsHide: true
    })

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      transport: 'stdio',
      bridgeOrigin: 'http://127.0.0.1:38101',
      credentialConfigured: true,
      downloadsAtLaunch: false
    })
    expect(`${stdout}${stderr}`).not.toContain(token)
  })

  test('fails an incomplete HTTP launch without leaking the Bridge credential', async () => {
    await expect(execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher,
      '-Transport', 'http', '-Check'
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PROMPTCARD_BRIDGE_URL: 'http://127.0.0.1:38101',
        PROMPTCARD_BRIDGE_TOKEN: token,
        PROMPTCARD_MCP_HTTP_TOKEN: ''
      },
      windowsHide: true
    })).rejects.toMatchObject({
      stdout: expect.not.stringContaining(token),
      stderr: expect.not.stringContaining(token)
    })
  })

  test('reports an offline-safe packaging diagnosis without credential echo', async () => {
    const { stdout, stderr } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', diagnostics,
      '-Transport', 'stdio', '-SkipGateway'
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PROMPTCARD_BRIDGE_URL: 'http://127.0.0.1:38101',
        PROMPTCARD_BRIDGE_TOKEN: token
      },
      windowsHide: true
    })

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      packaging: { ok: true, downloadsAtLaunch: false },
      gateway: { checked: false }
    })
    expect(`${stdout}${stderr}`).not.toContain(token)
  })

  test('links the launch guide from maintained documentation', async () => {
    const operationsIndex = await readFile(path.join(repoRoot, 'docs', 'operations', 'README.md'), 'utf8')
    const projectReadme = await readFile(path.join(repoRoot, 'README.md'), 'utf8')
    const guide = await readFile(path.join(repoRoot, 'docs', 'operations', 'local-agent-bridge.md'), 'utf8')

    expect(operationsIndex).toContain('./local-agent-bridge.md')
    expect(projectReadme).toContain('./docs/operations/local-agent-bridge.md')
    expect(guide).toContain('https://developers.openai.com/codex/mcp/')
    expect(guide).toContain('TRAE')
    expect(guide).toContain('候选')
  })
})
