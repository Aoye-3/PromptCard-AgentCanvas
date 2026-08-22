type ReferenceCodePrefix = 'PLP' | 'PLM'

const CANONICAL_ULID = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/

const getReferenceCode = (value: unknown, prefix: ReferenceCodePrefix): string | null => {
  if (typeof value !== 'string') return null
  const namespace = `${prefix}-`
  if (!value.startsWith(namespace)) return null
  return CANONICAL_ULID.test(value.slice(namespace.length)) ? value : null
}

export const getPromptReferenceCode = (value: unknown): string | null => getReferenceCode(value, 'PLP')

export const getPromptMediaReferenceCode = (value: unknown): string | null => getReferenceCode(value, 'PLM')
