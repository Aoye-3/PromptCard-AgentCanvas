import { describe, expect, it } from 'vitest'
import { findBridgeNodePosition } from './bridge-node-placement'

interface Box {
  position: { x: number; y: number }
  width: number
  height: number
}

const overlaps = (left: Box, right: Box) => !(
  left.position.x + left.width + 40 <= right.position.x
  || right.position.x + right.width + 40 <= left.position.x
  || left.position.y + left.height + 40 <= right.position.y
  || right.position.y + right.height + 40 <= left.position.y
)

describe('Bridge canvas node placement', () => {
  it('places a mixed external-Agent writeback sequence into non-overlapping slots', () => {
    const nodes: Box[] = [{ position: { x: 100, y: 100 }, width: 420, height: 180 }]
    const sizes = [
      { width: 560, height: 420 },
      { width: 640, height: 480 },
      { width: 360, height: 220 },
      { width: 360, height: 203 }
    ]

    for (const size of sizes) {
      const position = findBridgeNodePosition(nodes, { x: 100, y: 100 })
      const placed = { position, ...size }
      expect(nodes.some(node => overlaps(node, placed))).toBe(false)
      nodes.push(placed)
    }

    expect(new Set(nodes.slice(1).map(node => `${node.position.x}:${node.position.y}`)).size).toBe(4)
  })
})
