import { startPromptCardMcpHttpServer } from './http.ts'
import { sanitizeCurrentProcessEnvironment } from './environment.ts'

try {
  await startPromptCardMcpHttpServer(sanitizeCurrentProcessEnvironment(), {
    onerror: error => {
      process.stderr.write(`PromptCard MCP HTTP error: ${error.name}\n`)
    },
  })
} catch (error) {
  process.stderr.write(
    `PromptCard MCP HTTP failed: ${error instanceof Error ? error.message : 'internal'}\n`,
  )
  process.exitCode = 1
}
