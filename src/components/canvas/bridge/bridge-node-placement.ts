interface CanvasPlacementNode {
  position: { x: number; y: number }
  width: number
  height: number
}

const SLOT_WIDTH = 720
const SLOT_HEIGHT = 520
const SLOT_COLUMNS = 3
const NODE_WIDTH = 680
const NODE_HEIGHT = 480
const NODE_GAP = 40
const MAX_SLOTS = 256

export const findBridgeNodePosition = (
  nodes: readonly CanvasPlacementNode[],
  origin: { x: number; y: number }
): { x: number; y: number } => {
  for (let index = 0; index < MAX_SLOTS; index += 1) {
    const candidate = {
      x: origin.x + (index % SLOT_COLUMNS) * SLOT_WIDTH,
      y: origin.y + Math.floor(index / SLOT_COLUMNS) * SLOT_HEIGHT
    }
    if (!nodes.some(node => overlaps(node, candidate))) return candidate
  }
  return {
    x: origin.x,
    y: origin.y + Math.ceil(MAX_SLOTS / SLOT_COLUMNS) * SLOT_HEIGHT
  }
}

const overlaps = (
  node: CanvasPlacementNode,
  candidate: { x: number; y: number }
): boolean => !(
  candidate.x + NODE_WIDTH + NODE_GAP <= node.position.x
  || node.position.x + node.width + NODE_GAP <= candidate.x
  || candidate.y + NODE_HEIGHT + NODE_GAP <= node.position.y
  || node.position.y + node.height + NODE_GAP <= candidate.y
)
