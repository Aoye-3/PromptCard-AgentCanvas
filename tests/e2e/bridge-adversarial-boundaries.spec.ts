import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'

const storageUrl = 'http://127.0.0.1:38102'
const gatewayUrl = 'http://127.0.0.1:38101/api/promptcard/bridge/v3'
const bridgeToken = process.env.PROMPTCARD_E2E_BRIDGE_TOKEN || ''

test('real Gateway keeps Bridge authority explicit across project, context, and profile attacks', async ({ request }) => {
  test.setTimeout(90_000)
  expect(bridgeToken).not.toBe('')

  let first: ProjectFixture | null = null
  let second: ProjectFixture | null = null
  let cvcCode: string | null = null
  try {
    first = await createProjectFixture(request, 'first')
    second = await createProjectFixture(request, 'second')
    cvcCode = await createContextPack(request, first)

    await expectSafeBridgeError(
      await request.get(`${gatewayUrl}/runtime`),
      401,
      'bridge_credential_required'
    )

    const forgedRuntime = await request.get(`${gatewayUrl}/runtime`, {
      headers: bridgeHeaders(),
      params: { profileId: 'forged-admin', scopes: 'bridge:deliver:image' }
    })
    expect(forgedRuntime.status()).toBe(422)
    expect(await forgedRuntime.text()).not.toContain('forged-admin')

    await expectSafeBridgeError(
      await request.get(`${gatewayUrl}/workspace`, {
        headers: bridgeHeaders(),
        params: { projectCode: second.projectCode, cvcCode }
      }),
      409,
      'context_project_mismatch'
    )

    await expectSafeBridgeError(
      await request.get(`${gatewayUrl}/reference`, {
        headers: bridgeHeaders(),
        params: { cvcCode, code: second.nodeCode }
      }),
      403,
      'reference_outside_context'
    )

    const forgedDelivery = await request.post(`${gatewayUrl}/delivery/preview`, {
      headers: bridgeHeaders(),
      data: {
        clientRequestId: `task27-forged-${Date.now()}`,
        normalizedRequestDigest: `sha256:${'1'.repeat(64)}`,
        kind: 'prompt.create',
        target: { cvcCode },
        sourceCodes: [first.nodeCode],
        skillPins: [],
        rationale: 'This request must be rejected before Storage.',
        provenance: 'promptcard-bridge',
        payload: { title: 'Forbidden prompt', userText: 'Must not be created.' },
        profileId: 'forged-admin',
        scopes: ['bridge:deliver:prompt', 'bridge:deliver:image']
      }
    })
    expect(forgedDelivery.status()).toBe(422)
    expect((await listDeliveries(request, cvcCode)).deliveries).toEqual([])

    const revoked = await request.post(`${storageUrl}/api/context-packs/${cvcCode}/revoke`, {
      data: { actor: 'promptcard-ui', reason: 'user-revoked' }
    })
    expect(revoked.ok(), await revoked.text()).toBe(true)
    await expectSafeBridgeError(
      await request.get(`${gatewayUrl}/workspace`, {
        headers: bridgeHeaders(),
        params: { projectCode: first.projectCode, cvcCode }
      }),
      410,
      'context_revoked'
    )
  } finally {
    if (cvcCode) await revokeContext(request, cvcCode)
    if (first) await deleteProjectFixture(request, first.id)
    if (second) await deleteProjectFixture(request, second.id)
  }
})

interface ProjectFixture {
  id: string
  projectCode: string
  revision: number
  nodeCode: string
}

const bridgeHeaders = () => ({ authorization: `Bearer ${bridgeToken}` })

async function createProjectFixture(
  request: APIRequestContext,
  label: string
): Promise<ProjectFixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const id = `bridge-adversarial-${label}-${suffix}`
  const response = await request.post(`${storageUrl}/api/projects`, {
    data: {
      id,
      title: `Bridge adversarial ${label} ${suffix}`,
      type: 'free-canvas',
      pages: [],
      currentPage: 0,
      meta: {},
      freeCanvas: {
        nodes: [{
          id: `${label}-source`,
          kind: 'text',
          title: `${label} source`,
          position: { x: 120, y: 120 },
          width: 420,
          height: 180,
          fontSize: 'large',
          segments: [{
            id: `${label}-segment`,
            source: 'user',
            text: `${label} project private source`,
            color: '#111827',
            createdAt: 1,
            updatedAt: 1
          }],
          meta: {}
        }],
        edges: [],
        selectedNodeId: `${label}-source`,
        viewport: { x: 0, y: 0, zoom: 1 },
        meta: {}
      }
    }
  })
  expect(response.ok(), await response.text()).toBe(true)
  const stored = await response.json()
  return {
    id,
    projectCode: stored.referenceCode,
    revision: stored.revision,
    nodeCode: stored.freeCanvas.nodes[0].referenceCode
  }
}

async function createContextPack(request: APIRequestContext, fixture: ProjectFixture) {
  const response = await request.post(`${storageUrl}/api/context-packs`, {
    data: {
      projectCode: fixture.projectCode,
      projectRevision: fixture.revision,
      nodeCodes: [fixture.nodeCode],
      placementHint: { mode: 'after-selection', anchorNodeCodes: [fixture.nodeCode] },
      creator: 'promptcard-ui'
    }
  })
  expect(response.ok(), await response.text()).toBe(true)
  const stored = await response.json()
  expect(stored.cvcCode).toMatch(/^CVC-/)
  return stored.cvcCode as string
}

async function listDeliveries(request: APIRequestContext, cvcCode: string) {
  const response = await request.get(
    `${storageUrl}/api/context-packs/${cvcCode}/bridge-deliveries?state=pending_review`
  )
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}

async function expectSafeBridgeError(
  response: APIResponse,
  status: number,
  code: string
) {
  expect(response.status()).toBe(status)
  const text = await response.text()
  const payload = JSON.parse(text)
  const actualCode = typeof payload.detail === 'string' ? payload.detail : payload.detail?.code
  expect(actualCode).toBe(code)
  expect(text).not.toContain(bridgeToken)
  expect(text).not.toMatch(/[A-Z]:[\\/]|file:\/\/|promptcard\.sqlite3|node-secret/i)
}

async function revokeContext(request: APIRequestContext, cvcCode: string) {
  const response = await request.post(`${storageUrl}/api/context-packs/${cvcCode}/revoke`, {
    data: { actor: 'promptcard-ui', reason: 'user-revoked' }
  })
  expect(response.ok(), await response.text()).toBe(true)
}

async function deleteProjectFixture(request: APIRequestContext, id: string) {
  const trash = await request.post(`${storageUrl}/api/projects/trash`, {
    data: { ids: [id], deletedBy: 'user', deleteReason: 'bridge-adversarial-cleanup' }
  })
  expect(trash.ok(), await trash.text()).toBe(true)
  const removed = await request.delete(`${storageUrl}/api/projects/trash`, {
    data: { ids: [id] }
  })
  expect(removed.ok(), await removed.text()).toBe(true)
}
