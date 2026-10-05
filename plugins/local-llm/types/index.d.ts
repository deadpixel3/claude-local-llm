/** What scripts/llm.py writes to its --live file while a reply streams in. */
export type LlmRun = {
  state: 'running' | 'done' | 'error'
  phase: 'prompt' | 'thinking' | 'writing' | 'done' | 'error'
  model: string
  server: string
  url: string
  startedAt: number
  promptTokens: number
  promptExact: boolean
  outputTokens: number
  reasoningTokens: number
  ctx: number | null
  tps: number
  ttft: number | null
  elapsed: number
  draftAccepted: number | null
  draftTotal: number | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'local-llm': { run: LlmRun | null; frame: number; isHidden: boolean }
  }
}
