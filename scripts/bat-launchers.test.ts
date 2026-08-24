import { describe, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const launchers = ['start.bat', 'start-desktop.bat']

describe.each(launchers)('%s', (launcher) => {
  test('checks npm install failures at execution time inside the dependency block', async () => {
    const source = await readFile(path.resolve(__dirname, '..', launcher), 'utf8')

    expect(source).toContain('if errorlevel 1 (')
    expect(source).not.toContain('if %errorlevel% neq 0 (')
  })
})

test('agent runtime diagnostics verify schema v9, Ark SDK, and the chat whitelist catalog', async () => {
  const source = await readFile(path.resolve(__dirname, 'check-agent-runtime.ps1'), 'utf8')

  expect(source).toContain('SCHEMA_VERSION == 15')
  expect(source).toContain('agent_chat_catalog')
  expect(source).toContain('volcenginesdkarkruntime import Ark')
})

test('development and desktop startup accept the current storage schema', async () => {
  const source = await readFile(path.resolve(__dirname, 'start-dev-with-agent.ps1'), 'utf8')

  expect(source).toContain('$payload.schemaVersion -ne 9')
  expect(source).not.toContain('$payload.schemaVersion -ne 8')
})
