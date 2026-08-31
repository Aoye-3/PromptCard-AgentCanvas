export interface AgentRunProvenance {
  model: {
    connectionId: string
    providerId: string
    modelId: string
    displayName?: string
    capabilities?: Record<string, unknown>
  }
  skills: Array<{ skillId: string; revision: number; digest: string }>
}
