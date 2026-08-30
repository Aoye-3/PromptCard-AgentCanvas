import { timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'

import { createPromptCardMcpServer } from './server.ts'

const LOOPBACK_HOST = '127.0.0.1'

export type PromptCardMcpHttpOptions = {
  port?: number
  onerror?: (error: Error) => void
}

export async function startPromptCardMcpHttpServer(
  environment: NodeJS.ProcessEnv,
  options: PromptCardMcpHttpOptions = {},
): Promise<Server> {
  const token = requiredToken(environment.PROMPTCARD_MCP_HTTP_TOKEN)
  const port = options.port ?? configuredPort(environment.PROMPTCARD_MCP_PORT)
  const report = options.onerror ?? (() => undefined)
  const handler = createMcpHandler(() => createPromptCardMcpServer(environment))
  const nodeHandler = toNodeHandler(handler, { onerror: report })
  const validateHost = localhostHostValidation()
  const validateOrigin = localhostOriginValidation()
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname
    if (pathname !== '/mcp') {
      response.writeHead(404).end('Not found.')
      return
    }
    if (!validateHost(request, response) || !validateOrigin(request, response)) return
    if (!authorized(request.headers.authorization, token)) {
      response.setHeader('WWW-Authenticate', 'Bearer')
      response.writeHead(401).end('Unauthorized.')
      return
    }
    await nodeHandler(request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}

function requiredToken(value: string | undefined): string {
  if (typeof value !== 'string' || value.length < 32) {
    throw new Error('mcp_http_token_missing')
  }
  return value
}

function configuredPort(value: string | undefined): number {
  const port = Number(value ?? '8142')
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('mcp_http_port_invalid')
  }
  return port
}

function authorized(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
