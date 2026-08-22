import { describe, expect, it } from 'vitest'
import {
  getPromptMediaReferenceCode,
  getPromptReferenceCode,
  validatePublicReferenceCode
} from './reference-code'

const validUlid = '01M0N7FTG1PKB2AV2P8S62N6H8'

describe('reference code validation', () => {
  it('accepts only uppercase canonical Prompt and media codes in their matching namespaces', () => {
    expect(getPromptReferenceCode(`PLP-${validUlid}`)).toBe(`PLP-${validUlid}`)
    expect(getPromptMediaReferenceCode(`PLM-${validUlid}`)).toBe(`PLM-${validUlid}`)
    expect(getPromptReferenceCode(`PLM-${validUlid}`)).toBeNull()
    expect(getPromptMediaReferenceCode(`PLP-${validUlid}`)).toBeNull()
  })

  it.each([
    `plp-${validUlid}`,
    `PLP-8${validUlid.slice(1)}`,
    `PLP-${validUlid.slice(0, -1)}I`,
    `PLP-${validUlid.slice(0, -1)}U`,
    `PLP-${validUlid}0`,
    'internal-preset-id',
    42,
    { referenceCode: `PLP-${validUlid}` }
  ])('rejects malformed unknown values %o', (value) => {
    expect(getPromptReferenceCode(value)).toBeNull()
    expect(getPromptMediaReferenceCode(value)).toBeNull()
  })

  it.each([
    ['PRJ', `PRJ-${validUlid}`],
    ['CVT', `CVT-${validUlid}`],
    ['CVM', `CVM-${validUlid}`]
  ] as const)('validates the canonical %s response projection', (prefix, code) => {
    expect(validatePublicReferenceCode(code, prefix)).toBe(code)
    expect(validatePublicReferenceCode(code.toLowerCase(), prefix)).toBeNull()
    expect(validatePublicReferenceCode(code, prefix === 'PRJ' ? 'CVT' : 'PRJ')).toBeNull()
  })
})
