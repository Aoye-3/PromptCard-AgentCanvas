const ALLOWED_ENVIRONMENT_KEYS = new Set([
  'PROMPTCARD_BRIDGE_URL',
  'PROMPTCARD_BRIDGE_TOKEN',
  'PROMPTCARD_BRIDGE_WORKSPACE_ROOT',
  'PROMPTCARD_MCP_HTTP_TOKEN',
  'PROMPTCARD_MCP_PORT',
  'PATH',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
])

export function allowlistedEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => (
      typeof value === 'string' && ALLOWED_ENVIRONMENT_KEYS.has(key.toUpperCase())
    )),
  )
}

export function sanitizeCurrentProcessEnvironment(): NodeJS.ProcessEnv {
  const allowed = allowlistedEnvironment(process.env)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, allowed)
  return allowed
}
