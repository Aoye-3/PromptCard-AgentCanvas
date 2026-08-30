import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import type { AssetStageRequest } from '../../promptcard-bridge-cli/src/client.ts'

const MAX_STAGE_BYTES = 30 * 1024 * 1024

export class WorkspaceAssetError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}

export async function resolveWorkspaceAsset(
  request: AssetStageRequest,
  environment: NodeJS.ProcessEnv,
): Promise<{ filename: string; content: Uint8Array }> {
  const configuredRoot = environment.PROMPTCARD_BRIDGE_WORKSPACE_ROOT
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    throw new WorkspaceAssetError('workspace_root_missing')
  }
  const relativePath = request.workspaceRelativePath
  if (!isSafeRelativePath(relativePath)) {
    throw new WorkspaceAssetError('workspace_path_invalid')
  }

  let root: string
  let candidate: string
  try {
    root = await realpath(configuredRoot)
    candidate = await realpath(path.resolve(root, relativePath.replace(/[\\/]/g, path.sep)))
  } catch {
    throw new WorkspaceAssetError('asset_file_unavailable')
  }
  const containment = path.relative(root, candidate)
  if (!containment || containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
    throw new WorkspaceAssetError('workspace_path_escape')
  }

  let fileStat
  try {
    fileStat = await stat(candidate)
  } catch {
    throw new WorkspaceAssetError('asset_file_unavailable')
  }
  if (!fileStat.isFile()) throw new WorkspaceAssetError('asset_file_invalid')
  if (fileStat.size < 1 || fileStat.size > MAX_STAGE_BYTES) {
    throw new WorkspaceAssetError('asset_size_invalid')
  }
  if (fileStat.size !== request.byteLength) throw new WorkspaceAssetError('asset_size_mismatch')

  const content = await readFile(candidate)
  if (!hasExpectedSignature(content, request.mediaType)) {
    throw new WorkspaceAssetError('asset_media_type_mismatch')
  }
  const contentDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`
  if (contentDigest !== request.contentDigest) throw new WorkspaceAssetError('asset_digest_mismatch')
  return { filename: path.basename(candidate), content }
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.length > 1024 || value.includes('\0') || value.includes(':') || /^[\\/]/.test(value)) return false
  const parts = value.replace(/\\/g, '/').split('/')
  return parts.every(part => part !== '' && part !== '.' && part !== '..')
}

function hasExpectedSignature(content: Uint8Array, mediaType: AssetStageRequest['mediaType']): boolean {
  if (mediaType === 'image/png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    return signature.every((byte, index) => content[index] === byte)
  }
  if (mediaType === 'image/jpeg') {
    return content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
  }
  return content.length >= 12
    && Buffer.from(content.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(content.subarray(8, 12)).toString('ascii') === 'WEBP'
}
