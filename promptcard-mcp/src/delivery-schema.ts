import { z } from 'zod'

const publicReference = z.string().regex(/^(?:PRJ|PLP|PLM|CVT|CVM|CVC|SKL|CVD|CVS)-[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
const cvcCode = z.string().regex(/^CVC-[0-7][0-9A-HJKMNP-TV-Z]{25}$/i)
const documentCode = z.string().regex(/^CVD-[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
const storyboardCode = z.string().regex(/^CVS-[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
const skillCode = z.string().regex(/^SKL-[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const clientRequestId = z.string().min(1).max(128)
const text = z.string().max(10_000)

const skillPin = z.strictObject({
  skillCode,
  revision: z.number().int().min(1),
  digest,
  projectionHealth: z.enum(['healthy', 'stale', 'missing', 'untrusted', 'archived']),
})

const deliveryCommon = {
  clientRequestId,
  normalizedRequestDigest: digest,
  sourceCodes: z.array(publicReference).max(32).refine(items => new Set(items).size === items.length),
  skillPins: z.array(skillPin).max(8),
  rationale: z.string().min(1).max(4_000),
  provenance: z.literal('promptcard-bridge'),
}

const inline = z.strictObject({
  text,
  bold: z.literal(true).optional(),
  italic: z.literal(true).optional(),
  href: z.string().min(1).max(2_048).optional(),
})
const blockCommon = { id: z.string().min(1).max(128), content: z.array(inline).max(200) }
const documentBlock = z.discriminatedUnion('type', [
  z.strictObject({ ...blockCommon, type: z.literal('paragraph') }),
  z.strictObject({ ...blockCommon, type: z.literal('blockquote') }),
  z.strictObject({ ...blockCommon, type: z.literal('heading'), level: z.number().int().min(1).max(3) }),
])

const insertOperation = z.strictObject({
  kind: z.literal('insert'),
  blockId: z.string().min(1).max(128),
  utf8Offset: z.number().int().min(0),
  text: z.string().min(1).max(10_000),
  expectedTextDigest: digest,
})
const deleteOperation = z.strictObject({
  kind: z.literal('delete'),
  blockId: z.string().min(1).max(128),
  utf8Start: z.number().int().min(0),
  utf8End: z.number().int().min(0),
  expectedTextDigest: digest,
})
const replaceOperation = z.strictObject({
  kind: z.literal('replace'),
  blockId: z.string().min(1).max(128),
  utf8Start: z.number().int().min(0),
  utf8End: z.number().int().min(0),
  text: z.string().min(1).max(10_000),
  expectedTextDigest: digest,
})
const documentOperation = z.discriminatedUnion('kind', [insertOperation, deleteOperation, replaceOperation])

const storyboardRowFields = {
  cutLabel: text,
  timeRange: text,
  subject: text,
  action: text,
  scene: text,
  camera: text,
  lighting: text,
  audio: text,
  duration: text,
}
const storyboardSequence = z.strictObject({
  name: z.string().min(1).max(10_000),
  description: text,
  style: text,
  constraints: text,
  rows: z.array(z.strictObject(storyboardRowFields)).min(1).max(200),
})
const storyboardChange = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('sequence'),
    field: z.enum(['name', 'description', 'style', 'constraints']),
    value: text,
  }),
  z.strictObject({
    scope: z.literal('row'),
    rowOrdinal: z.number().int().min(0).max(199),
    field: z.enum(['cutLabel', 'timeRange', 'subject', 'action', 'scene', 'camera', 'lighting', 'audio', 'duration']),
    value: text,
  }),
])

const createTarget = z.strictObject({ cvcCode })
const documentTarget = z.strictObject({
  cvcCode,
  documentCode,
  baseRevision: z.number().int().min(0),
  baseDigest: digest,
})
const storyboardTarget = z.strictObject({
  cvcCode,
  storyboardCode,
  baseRevision: z.number().int().min(0),
  baseDigest: digest,
})
const imageTarget = z.strictObject({
  cvcCode,
  storyboardCode: storyboardCode.optional(),
  baseRevision: z.number().int().min(0).optional(),
  baseDigest: digest.optional(),
  shotOrdinal: z.number().int().min(0).max(199).optional(),
})

export const deliveryPreviewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...deliveryCommon,
    kind: z.literal('document.create'),
    target: createTarget,
    payload: z.strictObject({
      title: z.string().min(1).max(500),
      blocks: z.array(documentBlock).min(1).max(500),
    }),
  }),
  z.strictObject({
    ...deliveryCommon,
    kind: z.literal('document.change'),
    target: documentTarget,
    payload: z.strictObject({ operations: z.array(documentOperation).min(1).max(32) }),
  }),
  z.strictObject({
    ...deliveryCommon,
    kind: z.literal('storyboard.create'),
    target: createTarget,
    payload: z.strictObject({
      title: z.string().min(1).max(500),
      sourceDocumentCode: documentCode,
      sourceDocumentRevision: z.number().int().min(0),
      sourceDocumentDigest: digest,
      sequence: storyboardSequence,
    }),
  }),
  z.strictObject({
    ...deliveryCommon,
    kind: z.literal('storyboard.change'),
    target: storyboardTarget,
    payload: z.strictObject({ changes: z.array(storyboardChange).min(1).max(32) }),
  }),
  z.strictObject({
    ...deliveryCommon,
    kind: z.literal('prompt.create'),
    target: createTarget,
    payload: z.strictObject({
      title: z.string().min(1).max(500),
      userText: z.string().min(1).max(100_000),
    }),
  }),
  z.strictObject({
    ...deliveryCommon,
    kind: z.literal('image.place'),
    target: imageTarget,
    payload: z.strictObject({
      stagedAssetHandle: z.string().regex(/^AST-[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
      altText: z.string().max(1_000).optional(),
    }),
  }),
])

export const deliveryCommitSchema = z.strictObject({
  clientRequestId,
  normalizedRequestDigest: digest,
  proposalId: z.string().regex(/^DVP-[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
})

export const deliveryStatusSchema = z.strictObject({ clientRequestId })

export const assetStageSchema = z.strictObject({
  clientRequestId,
  cvcCode,
  workspaceRelativePath: z.string().min(1).max(1_024).regex(/^(?![\\/])(?!.*[\\/]$)(?!.*[\\/]{2})(?!.*(?:^|[\\/])\.{1,2}(?:[\\/]|$))(?!.*:)[^\0]+$/),
  contentDigest: digest,
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  byteLength: z.number().int().min(1).max(30 * 1024 * 1024),
})
