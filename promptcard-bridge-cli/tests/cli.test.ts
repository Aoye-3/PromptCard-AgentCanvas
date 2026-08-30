import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import path from 'node:path'

const token = 'bridge-cli-test-token-that-is-longer-than-thirty-two-characters'
const project = 'PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const context = 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAV'
let server: Server
let baseUrl: string

before(async () => {
  server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    response.setHeader('content-type', 'application/json')
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname.endsWith('/runtime')) {
      response.end(JSON.stringify({ serverName: 'promptcard-bridge', contractVersion: '3.0.0' }))
      return
    }
    if (url.pathname.endsWith('/workspace')) {
      assert.equal(url.searchParams.get('projectCode'), project)
      assert.equal(url.searchParams.get('cvcCode'), context)
      response.end(JSON.stringify({ projectCode: project, cvcCode: context, objects: [] }))
      return
    }
    if (url.pathname.endsWith('/prompt-search')) {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        assert.deepEqual(JSON.parse(body), {
          cvcCode: context,
          query: 'neon city',
          types: [],
          categories: [],
          limit: 5,
        })
        response.end(JSON.stringify({ queryDigest: `sha256:${'a'.repeat(64)}`, results: [], degraded: false }))
      })
      return
    }
    if (url.searchParams.get('code')?.startsWith('CVD-')) {
      response.statusCode = 404
      response.end(JSON.stringify({ detail: { code: 'unknown_code', path: 'F:/private' } }))
      return
    }
    response.statusCode = 500
    response.end('not-json')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

test('runtime emits one deterministic Gateway-equivalent JSON line', async () => {
  const result = await runCli(['runtime'])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.split('\n').filter(Boolean).length, 1)
  assert.deepEqual(JSON.parse(result.stdout), {
    contractVersion: '3.0.0',
    serverName: 'promptcard-bridge',
  })
})

test('workspace maps exact arguments without adding authority fields', async () => {
  const result = await runCli(['workspace', '--project', project, '--context', context])
  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout), { projectCode: project, cvcCode: context, objects: [] })
})

test('search remains discovery-only and maps through the same Gateway', async () => {
  const result = await runCli(['search', '--context', context, '--query', 'neon city', '--limit', '5'])
  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout).results, [])
})

test('structured remote errors are redacted and use stable lifecycle exit code', async () => {
  const result = await runCli(['resolve', '--context', context, '--code', 'CVD-01ARZ3NDEKTSV4RRFFQ69G5FAV'])
  assert.equal(result.code, 4)
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { code: 'unknown_code', status: 404 } })
  assert.doesNotMatch(result.stdout + result.stderr, /private|F:\//)
})

test('usage and non-loopback URL fail before a request', async () => {
  const usage = await runCli(['workspace', '--project', project])
  assert.equal(usage.code, 2)
  assert.equal(JSON.parse(usage.stdout).error.code, 'usage_invalid')

  const remote = await runCli(['runtime'], { PROMPTCARD_BRIDGE_URL: 'https://example.com' })
  assert.equal(remote.code, 2)
  assert.equal(JSON.parse(remote.stdout).error.code, 'bridge_url_not_loopback')
})

test('offline and invalid JSON responses use stable exits and keep stdout pure', async () => {
  const offline = await runCli(['runtime'], { PROMPTCARD_BRIDGE_URL: 'http://127.0.0.1:1' })
  assert.equal(offline.code, 5)
  assert.equal(JSON.parse(offline.stdout).error.code, 'bridge_offline')

  const invalid = await runCli(['skill', '--skill', 'SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV', '--revision', '1', '--digest', `sha256:${'a'.repeat(64)}`])
  assert.equal(invalid.code, 6)
  assert.equal(JSON.parse(invalid.stdout).error.code, 'bridge_response_invalid')
})

function runCli(args: string[], environment: Record<string, string> = {}) {
  const entry = path.resolve('promptcard-bridge-cli/src/cli.ts')
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', entry, ...args], {
      cwd: path.resolve('.'),
      windowsHide: true,
      env: {
        ...process.env,
        PROMPTCARD_BRIDGE_URL: baseUrl,
        PROMPTCARD_BRIDGE_TOKEN: token,
        ...environment,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}
