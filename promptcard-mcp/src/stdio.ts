import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { sanitizeCurrentProcessEnvironment } from './environment.ts'
import { createPromptCardMcpServer } from './server.ts'

const environment = sanitizeCurrentProcessEnvironment()

serveStdio(() => createPromptCardMcpServer(environment), {
  onerror: error => {
    process.stderr.write(`PromptCard MCP stdio error: ${safeMessage(error)}\n`)
  },
})

function safeMessage(error: Error): string {
  return error.name === 'Error' ? 'transport failure' : error.name
}
