import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { startPromptCardMcpHttpServer } from '../src/http.ts'
import { allowlistedEnvironment } from '../src/environment.ts'

const bridgeToken = 'bridge-mcp-test-token-that-is-longer-than-thirty-two-characters'
const httpToken = 'http-mcp-test-token-that-is-longer-than-thirty-two-characters'
const project = 'PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const context = 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const prompt = 'PLP-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const media = 'PLM-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const proposal = 'DVP-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const stagedAsset = 'AST-01ARZ3NDEKTSV4RRFFQ69G5FAV'
const stagePath = 'public/app-icon.png'
const stageContent = readFileSync(path.resolve(stagePath))
const stageRequest = {
  clientRequestId: 'asset-stage-001',
  cvcCode: context,
  workspaceRelativePath: stagePath,
  contentDigest: `sha256:${createHash('sha256').update(stageContent).digest('hex')}`,
  mediaType: 'image/png' as const,
  byteLength: stageContent.length,
}
const promptPreviewRequest = JSON.parse(readFileSync(
  path.resolve('contracts/promptcard-bridge/v3/fixtures/06-prompt-create-valid.json'),
  'utf8',
)).instance
const promptSearchFixture = {
  auditId: 'AUD-01ARZ3NDEKTSV4RRFFQ69G5FAV',
  degraded: false,
  queryDigest: `sha256:${'a'.repeat(64)}`,
  results: [{ referenceCode: prompt, title: 'Opening shot' }],
  staleRejectedCount: 0,
}
const assetFixture = {
  contentType: 'image/png',
  dataBase64: 'iVBORw0KGgo=',
  digest: `sha256:${'b'.repeat(64)}`,
  filename: 'opening-shot.png',
  referenceCode: media,
  size: 8,
}
const runtimeFixture = JSON.parse(readFileSync(
  path.resolve('contracts/promptcard-bridge/v3/fixtures/11-runtime-description-valid.json'),
  'utf8',
)).instance
let gateway: Server
let gatewayUrl: string
const previewDigests = new Map<string, string>()

before(async () => {
  gateway = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${bridgeToken}`)
    response.setHeader('content-type', 'application/json')
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname.endsWith('/runtime')) {
      response.end(JSON.stringify(runtimeFixture))
      return
    }
    if (url.pathname.endsWith('/workspace')) {
      response.end(JSON.stringify({ projectCode: project, cvcCode: context, objects: [] }))
      return
    }
    if (url.pathname.endsWith('/reference')) {
      response.end(JSON.stringify({ cvcCode: context, referenceCode: prompt, title: 'Opening shot' }))
      return
    }
    if (url.pathname.endsWith('/prompt-search')) {
      const body = JSON.parse(await requestBody(request))
      assert.deepEqual(body, {
        cvcCode: context,
        query: 'opening shot',
        types: ['cinematic'],
        categories: ['storyboard'],
        limit: 3,
      })
      response.end(JSON.stringify(promptSearchFixture))
      return
    }
    if (url.pathname.endsWith('/asset')) {
      response.end(JSON.stringify(assetFixture))
      return
    }
    if (url.pathname.endsWith('/assets/stage')) {
      assert.match(request.headers['content-type'] || '', /^multipart\/form-data; boundary=/)
      const body = await requestBodyBuffer(request)
      assert.ok(body.includes(Buffer.from(JSON.stringify(stageRequest))))
      assert.ok(body.includes(Buffer.from('filename="app-icon.png"')))
      response.end(JSON.stringify({
        state: 'staged',
        disposition: 'original',
        stagedAssetHandle: stagedAsset,
        contentDigest: stageRequest.contentDigest,
      }))
      return
    }
    if (url.pathname.endsWith('/delivery/preview')) {
      const body = JSON.parse(await requestBody(request))
      assert.equal(body.clientRequestId, promptPreviewRequest.clientRequestId)
      const previousDigest = previewDigests.get(body.clientRequestId)
      if (previousDigest && previousDigest !== body.normalizedRequestDigest) {
        response.statusCode = 409
        response.end(JSON.stringify({ detail: { code: 'idempotency_conflict' } }))
        return
      }
      previewDigests.set(body.clientRequestId, body.normalizedRequestDigest)
      response.end(JSON.stringify({
        proposalId: proposal,
        state: 'previewed',
        disposition: previousDigest ? 'replay' : 'original',
      }))
      return
    }
    if (url.pathname.endsWith('/delivery/commit')) {
      assert.deepEqual(JSON.parse(await requestBody(request)), {
        clientRequestId: promptPreviewRequest.clientRequestId,
        normalizedRequestDigest: promptPreviewRequest.normalizedRequestDigest,
        proposalId: proposal,
      })
      response.end(JSON.stringify({ proposalId: proposal, state: 'pending_review', disposition: 'original' }))
      return
    }
    if (url.pathname.endsWith('/delivery/status')) {
      assert.equal(url.searchParams.get('clientRequestId'), promptPreviewRequest.clientRequestId)
      response.end(JSON.stringify({ proposalId: proposal, state: 'pending_review', disposition: 'replay' }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ detail: { code: 'not_found' } }))
  })
  await listen(gateway)
  gatewayUrl = serverUrl(gateway)
})

after(async () => {
  await closeServer(gateway)
})

for (const era of ['legacy', 'modern'] as const) {
  test(`STDIO serves ${era} protocol with pure JSON-RPC output and exact tools`, async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--experimental-strip-types', path.resolve('promptcard-mcp/src/stdio.ts')],
      cwd: path.resolve('.'),
      stderr: 'pipe',
      env: childEnvironment(),
    })
    const client = mcpClient(era)
    await client.connect(transport)
    try {
      await verifyToolsAndRuntime(client)
      assert.ok(transport.pid)
    } finally {
      await client.close()
    }
    assert.equal(transport.pid, null)
  })

  test(`loopback Streamable HTTP serves ${era} protocol through the same Gateway`, async () => {
    const mcp = await startPromptCardMcpHttpServer(mcpEnvironment(), { port: 0 })
    const transport = new StreamableHTTPClientTransport(
      new URL('/mcp', serverUrl(mcp)),
      { requestInit: { headers: { Authorization: `Bearer ${httpToken}` } } },
    )
    const client = mcpClient(era)
    try {
      await client.connect(transport)
      await verifyToolsAndRuntime(client)
    } finally {
      await client.close()
      await closeServer(mcp)
    }
  })
}

test('HTTP rejects non-loopback Host, untrusted Origin, and missing Bearer before MCP', async () => {
  const mcp = await startPromptCardMcpHttpServer(mcpEnvironment(), { port: 0 })
  try {
    const target = new URL('/mcp', serverUrl(mcp))
    const missing = await fetch(target, { method: 'POST' })
    assert.equal(missing.status, 401)

    const origin = await fetch(target, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', Authorization: `Bearer ${httpToken}` },
    })
    assert.equal(origin.status, 403)

    assert.equal(await rawStatus(target, {
      Host: 'evil.example',
      Authorization: `Bearer ${httpToken}`,
    }), 403)
  } finally {
    await closeServer(mcp)
  }
})

test('Gateway outage stays a structured MCP Tool error without leaking environment', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-strip-types', path.resolve('promptcard-mcp/src/stdio.ts')],
    cwd: path.resolve('.'),
    stderr: 'pipe',
    env: childEnvironment({ PROMPTCARD_BRIDGE_URL: 'http://127.0.0.1:1' }),
  })
  const client = mcpClient('legacy')
  await client.connect(transport)
  try {
    const result = await client.callTool({ name: 'promptcard_runtime_describe', arguments: {} })
    assert.equal(result.isError, true)
    assert.deepEqual(JSON.parse(textResult(result)), {
      error: { code: 'bridge_offline' },
      ok: false,
    })
    assert.doesNotMatch(textResult(result), /PROMPTCARD|F:\\|token/i)
  } finally {
    await client.close()
  }
})

test('the production environment allowlist drops ambient secrets', () => {
  assert.deepEqual(allowlistedEnvironment({
    PATH: 'F:\\tools',
    PROMPTCARD_BRIDGE_URL: 'http://127.0.0.1:8000',
    PROMPTCARD_BRIDGE_TOKEN: bridgeToken,
    UNRELATED_PROVIDER_SECRET: 'must-not-survive',
  }), {
    PATH: 'F:\\tools',
    PROMPTCARD_BRIDGE_URL: 'http://127.0.0.1:8000',
    PROMPTCARD_BRIDGE_TOKEN: bridgeToken,
  })
})

async function verifyToolsAndRuntime(client: Client): Promise<void> {
  const listed = await client.listTools()
  assert.deepEqual(
    listed.tools.map(tool => tool.name),
    [
      'promptcard_runtime_describe',
      'promptcard_workspace_describe',
      'promptcard_skill_read',
      'promptcard_reference_resolve',
      'promptcard_prompt_search',
      'promptcard_asset_read',
      'promptcard_delivery_preview',
      'promptcard_delivery_commit',
      'promptcard_delivery_status',
      'promptcard_asset_stage',
    ],
  )
  for (const tool of listed.tools) {
    assert.ok((tool.description?.length || 0) < 8_000)
    assertClosedInputSchema(tool.inputSchema)
    assert.equal(tool.annotations?.readOnlyHint, ![
      'promptcard_delivery_preview',
      'promptcard_delivery_commit',
      'promptcard_asset_stage',
    ].includes(tool.name))
    assert.equal(tool.annotations?.idempotentHint, true)
    assert.equal(tool.annotations?.destructiveHint, false)
    assert.equal(tool.annotations?.openWorldHint, false)
  }
  const result = await client.callTool({ name: 'promptcard_runtime_describe', arguments: {} })
  assert.equal(result.isError, undefined)
  assert.deepEqual(JSON.parse(textResult(result)), runtimeFixture)

  const resolved = await client.callTool({
    name: 'promptcard_reference_resolve',
    arguments: { cvcCode: context, code: prompt },
  })
  assert.deepEqual(JSON.parse(textResult(resolved)), {
    cvcCode: context,
    referenceCode: prompt,
    title: 'Opening shot',
  })

  const searched = await client.callTool({
    name: 'promptcard_prompt_search',
    arguments: {
      cvcCode: context,
      query: 'opening shot',
      types: ['cinematic'],
      categories: ['storyboard'],
      limit: 3,
    },
  })
  assert.deepEqual(JSON.parse(textResult(searched)), promptSearchFixture)

  const asset = await client.callTool({
    name: 'promptcard_asset_read',
    arguments: { cvcCode: context, code: media },
  })
  assert.deepEqual(JSON.parse(textResult(asset)), assetFixture)

  const previewed = await client.callTool({
    name: 'promptcard_delivery_preview',
    arguments: promptPreviewRequest,
  })
  const previewedPayload = JSON.parse(textResult(previewed))
  assert.ok(['original', 'replay'].includes(previewedPayload.disposition))
  assert.equal(previewedPayload.proposalId, proposal)
  assert.equal(previewedPayload.state, 'previewed')

  const replayed = await client.callTool({
    name: 'promptcard_delivery_preview',
    arguments: promptPreviewRequest,
  })
  assert.deepEqual(JSON.parse(textResult(replayed)), {
    disposition: 'replay',
    proposalId: proposal,
    state: 'previewed',
  })

  const conflict = await client.callTool({
    name: 'promptcard_delivery_preview',
    arguments: {
      ...promptPreviewRequest,
      normalizedRequestDigest: `sha256:${'f'.repeat(64)}`,
    },
  })
  assert.equal(conflict.isError, true)
  assert.deepEqual(JSON.parse(textResult(conflict)), {
    error: { code: 'idempotency_conflict', status: 409 },
    ok: false,
  })

  const committed = await client.callTool({
    name: 'promptcard_delivery_commit',
    arguments: {
      clientRequestId: promptPreviewRequest.clientRequestId,
      normalizedRequestDigest: promptPreviewRequest.normalizedRequestDigest,
      proposalId: proposal,
    },
  })
  assert.deepEqual(JSON.parse(textResult(committed)), {
    disposition: 'original',
    proposalId: proposal,
    state: 'pending_review',
  })

  const status = await client.callTool({
    name: 'promptcard_delivery_status',
    arguments: { clientRequestId: promptPreviewRequest.clientRequestId },
  })
  assert.deepEqual(JSON.parse(textResult(status)), {
    disposition: 'replay',
    proposalId: proposal,
    state: 'pending_review',
  })

  const staged = await client.callTool({ name: 'promptcard_asset_stage', arguments: stageRequest })
  assert.deepEqual(JSON.parse(textResult(staged)), {
    contentDigest: stageRequest.contentDigest,
    disposition: 'original',
    stagedAssetHandle: stagedAsset,
    state: 'staged',
  })
}

function assertClosedInputSchema(schema: Record<string, unknown>): void {
  if (schema.additionalProperties === false) return
  const variants = schema.anyOf || schema.oneOf
  assert.ok(Array.isArray(variants) && variants.length > 0)
  for (const variant of variants) {
    assert.ok(variant && typeof variant === 'object')
    assert.equal((variant as Record<string, unknown>).additionalProperties, false)
  }
}

function textResult(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content[0]
  assert.ok(content && content.type === 'text')
  return content.text
}

function mcpClient(era: 'legacy' | 'modern'): Client {
  return new Client(
    { name: 'promptcard-mcp-test', version: '1.0.0' },
    {
      versionNegotiation: {
        mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' },
      },
    },
  )
}

function mcpEnvironment(): NodeJS.ProcessEnv {
  return {
    PROMPTCARD_BRIDGE_URL: gatewayUrl,
    PROMPTCARD_BRIDGE_TOKEN: bridgeToken,
    PROMPTCARD_MCP_HTTP_TOKEN: httpToken,
    PROMPTCARD_BRIDGE_WORKSPACE_ROOT: path.resolve('.'),
  }
}

function childEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  const required = Object.fromEntries(
    ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
      .map(name => [name, process.env[name]])
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return {
    ...required,
    PROMPTCARD_BRIDGE_URL: gatewayUrl,
    PROMPTCARD_BRIDGE_TOKEN: bridgeToken,
    PROMPTCARD_BRIDGE_WORKSPACE_ROOT: path.resolve('.'),
    ...overrides,
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function serverUrl(server: Server): string {
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

async function rawStatus(url: URL, headers: Record<string, string>): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode || 0))
    })
    request.once('error', reject)
    request.end()
  })
}

async function requestBody(request: import('node:http').IncomingMessage): Promise<string> {
  return (await requestBodyBuffer(request)).toString('utf8')
}

async function requestBodyBuffer(request: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
