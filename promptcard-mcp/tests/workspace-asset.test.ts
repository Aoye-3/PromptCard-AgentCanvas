import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import path from 'node:path'

import type { AssetStageRequest } from '../../promptcard-bridge-cli/src/client.ts'
import { resolveWorkspaceAsset, WorkspaceAssetError } from '../src/workspace-asset.ts'

const root = path.resolve('.')
const relativePath = 'public/app-icon.png'
const content = readFileSync(path.resolve(relativePath))
const validRequest: AssetStageRequest = {
  clientRequestId: 'asset-stage-workspace-test',
  cvcCode: 'CVC-01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workspaceRelativePath: relativePath,
  contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  mediaType: 'image/png' as const,
  byteLength: content.length,
}

test('resolves one exact image beneath the configured workspace root', async () => {
  const resolved = await resolveWorkspaceAsset(validRequest, {
    PROMPTCARD_BRIDGE_WORKSPACE_ROOT: root,
  })
  assert.equal(resolved.filename, 'app-icon.png')
  assert.deepEqual(Buffer.from(resolved.content), content)
})

test('rejects traversal, missing roots, digest changes, and media spoofing before Gateway I/O', async () => {
  await rejectsCode({ ...validRequest, workspaceRelativePath: '../outside.png' }, {}, 'workspace_root_missing')
  await rejectsCode(
    { ...validRequest, workspaceRelativePath: '../outside.png' },
    { PROMPTCARD_BRIDGE_WORKSPACE_ROOT: root },
    'workspace_path_invalid',
  )
  await rejectsCode(
    { ...validRequest, contentDigest: `sha256:${'0'.repeat(64)}` },
    { PROMPTCARD_BRIDGE_WORKSPACE_ROOT: root },
    'asset_digest_mismatch',
  )
  await rejectsCode(
    { ...validRequest, mediaType: 'image/webp' },
    { PROMPTCARD_BRIDGE_WORKSPACE_ROOT: root },
    'asset_media_type_mismatch',
  )
})

test('rejects a junction that resolves outside the configured workspace root', async (t) => {
  const testRoot = path.resolve('test-output/task26-mcp-workspace-escape')
  const allowedRoot = path.join(testRoot, 'allowed')
  const outsideRoot = path.join(testRoot, 'outside')
  const linkPath = path.join(allowedRoot, 'linked')
  await rm(testRoot, { recursive: true, force: true })
  await mkdir(allowedRoot, { recursive: true })
  await mkdir(outsideRoot, { recursive: true })
  await writeFile(path.join(outsideRoot, 'image.png'), content)
  try {
    await symlink(outsideRoot, linkPath, 'junction')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Junction creation is unavailable for this Windows account.')
      await rm(testRoot, { recursive: true, force: true })
      return
    }
    throw error
  }
  try {
    await rejectsCode(
      { ...validRequest, workspaceRelativePath: 'linked/image.png' },
      { PROMPTCARD_BRIDGE_WORKSPACE_ROOT: allowedRoot },
      'workspace_path_escape',
    )
  } finally {
    await rm(testRoot, { recursive: true, force: true })
  }
})

async function rejectsCode(
  request: AssetStageRequest,
  environment: NodeJS.ProcessEnv,
  code: string,
): Promise<void> {
  await assert.rejects(
    resolveWorkspaceAsset(request, environment),
    error => error instanceof WorkspaceAssetError && error.code === code,
  )
}
