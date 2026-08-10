
export type CardType =
  | 'subject'
  | 'action'
  | 'scene'
  | 'style'
  | 'camera'
  | 'lighting'
  | 'timing'
  | 'audio'
  | 'constraint'
  | 'custom'

export const PROMPT_LIBRARY_CARD_TYPES: CardType[] = [
  'subject',
  'action',
  'scene',
  'style',
  'camera',
  'lighting',
  'timing',
  'audio',
  'constraint',
  'custom'
]

export interface ICard {
  id: string
  type: CardType
  title: string
  content: string
  mode: 'view' | 'edit'
  color: string
  createdAt: number
  updatedAt: number
  meta: Record<string, any>
}

// 预制内容类型
export interface IPreset {
  id: string
  type: CardType
  revision?: number
  category: string
  label: string
  content: string
  usageCount: number
  meta: Record<string, any>
  createdAt?: number
  updatedAt?: number
}

// 学习案例类型
export interface IExample {
  id: string
  type: CardType
  poorExample: string
  goodExample: string
  learningPoints: string[]
  steps: {
    title: string
    score: string
    content: string
  }[]
  meta: Record<string, any>
}
