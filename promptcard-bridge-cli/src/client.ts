export type BridgeCliCommand =
  | { kind: 'runtime' }
  | { kind: 'workspace'; projectCode: string; cvcCode: string }
  | { kind: 'reference'; cvcCode: string; code: string }
  | { kind: 'skill'; skillCode: string; revision: number; digest: string }

export type BridgeCliFailure = {
  ok: false
  error: {
    code: string
    status?: number
  }
}

export class BridgeCliError extends Error {
  readonly exitCode: number
  readonly result: BridgeCliFailure

  constructor(
    exitCode: number,
    result: BridgeCliFailure,
    message: string,
  ) {
    super(message)
    this.exitCode = exitCode
    this.result = result
  }
}

export function parseCommand(argv: string[]): BridgeCliCommand {
  const [name, ...rest] = argv
  const options = parseOptions(rest)
  if (name === 'runtime' && options.size === 0) return { kind: 'runtime' }
  if (name === 'workspace' && hasOnly(options, ['project', 'context'])) {
    return {
      kind: 'workspace',
      projectCode: required(options, 'project'),
      cvcCode: required(options, 'context'),
    }
  }
  if (name === 'resolve' && hasOnly(options, ['context', 'code'])) {
    return {
      kind: 'reference',
      cvcCode: required(options, 'context'),
      code: required(options, 'code'),
    }
  }
  if (name === 'skill' && hasOnly(options, ['skill', 'revision', 'digest'])) {
    const revisionText = required(options, 'revision')
    const revision = Number(revisionText)
    if (!Number.isSafeInteger(revision) || revision < 1) usage('revision_invalid')
    return {
      kind: 'skill',
      skillCode: required(options, 'skill'),
      revision,
      digest: required(options, 'digest'),
    }
  }
  usage('usage_invalid')
}

export async function invokeBridge(
  command: BridgeCliCommand,
  environment: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const token = environment.PROMPTCARD_BRIDGE_TOKEN
  if (typeof token !== 'string' || token.length < 32) {
    throw new BridgeCliError(2, failure('bridge_token_missing'), 'Bridge token is missing or invalid.')
  }
  const baseUrl = loopbackBaseUrl(environment.PROMPTCARD_BRIDGE_URL)
  const endpoint = endpointFor(command, baseUrl)
  let response: Response
  try {
    response = await fetcher(endpoint, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new BridgeCliError(5, failure('bridge_offline'), 'PromptCard Bridge is unavailable.')
  }
  const payload = await readJson(response)
  if (!response.ok) {
    const code = errorCode(payload, response.status)
    throw new BridgeCliError(exitCodeForStatus(response.status), failure(code, response.status), `Bridge request failed (${response.status}, ${code}).`)
  }
  return payload
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function endpointFor(command: BridgeCliCommand, baseUrl: URL): URL {
  const url = new URL('/api/promptcard/bridge/v3/runtime', baseUrl)
  if (command.kind === 'workspace') {
    url.pathname = '/api/promptcard/bridge/v3/workspace'
    url.searchParams.set('projectCode', command.projectCode)
    url.searchParams.set('cvcCode', command.cvcCode)
  } else if (command.kind === 'reference') {
    url.pathname = '/api/promptcard/bridge/v3/reference'
    url.searchParams.set('cvcCode', command.cvcCode)
    url.searchParams.set('code', command.code)
  } else if (command.kind === 'skill') {
    url.pathname = '/api/promptcard/bridge/v3/skill'
    url.searchParams.set('skillCode', command.skillCode)
    url.searchParams.set('revision', String(command.revision))
    url.searchParams.set('digest', command.digest)
  }
  return url
}

function loopbackBaseUrl(value: string | undefined): URL {
  let url: URL
  try {
    url = new URL(value || '')
  } catch {
    throw new BridgeCliError(2, failure('bridge_url_invalid'), 'Bridge URL is invalid.')
  }
  const hostname = url.hostname.toLowerCase()
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new BridgeCliError(2, failure('bridge_url_not_loopback'), 'Bridge URL must be loopback HTTP.')
  }
  return url
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new BridgeCliError(6, failure('bridge_response_invalid', response.status), 'Bridge returned invalid JSON.')
  }
}

function errorCode(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    const detail = (payload as { detail?: unknown }).detail
    if (detail && typeof detail === 'object' && 'code' in detail) {
      const code = (detail as { code?: unknown }).code
      if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(code)) return code
    }
    if (typeof detail === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(detail)) return detail
  }
  return `bridge_http_${status}`
}

function exitCodeForStatus(status: number): number {
  if (status === 401 || status === 403) return 3
  if (status === 404 || status === 409 || status === 410) return 4
  return 6
}

function failure(code: string, status?: number): BridgeCliFailure {
  return { ok: false, error: { code, ...(status === undefined ? {} : { status }) } }
}

function parseOptions(values: string[]): Map<string, string> {
  if (values.length % 2 !== 0) usage('usage_invalid')
  const result = new Map<string, string>()
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index]
    const value = values[index + 1]
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) usage('usage_invalid')
    const name = flag.slice(2)
    if (result.has(name)) usage('duplicate_option')
    result.set(name, value)
  }
  return result
}

function hasOnly(options: Map<string, string>, names: string[]): boolean {
  return options.size === names.length && names.every(name => options.has(name))
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name)
  if (!value) usage('usage_invalid')
  return value
}

function usage(code: string): never {
  throw new BridgeCliError(2, failure(code), 'Usage: runtime | workspace --project PRJ --context CVC | resolve --context CVC --code REF | skill --skill SKL --revision N --digest sha256:...')
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    )
  }
  return value
}
