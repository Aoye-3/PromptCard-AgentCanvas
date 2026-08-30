import { BridgeCliError, invokeBridge, parseCommand, stableJson } from './client.ts'

async function main(): Promise<void> {
  try {
    const command = parseCommand(process.argv.slice(2))
    const result = await invokeBridge(command, process.env)
    process.stdout.write(`${stableJson(result)}\n`)
  } catch (error) {
    if (error instanceof BridgeCliError) {
      process.stdout.write(`${stableJson(error.result)}\n`)
      process.stderr.write(`${error.message}\n`)
      process.exitCode = error.exitCode
      return
    }
    process.stdout.write(`${stableJson({ ok: false, error: { code: 'bridge_cli_internal' } })}\n`)
    process.stderr.write('PromptCard Bridge CLI failed.\n')
    process.exitCode = 6
  }
}

await main()
