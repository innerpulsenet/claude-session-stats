export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  // API requests these counts sum
  requests: number
}

export type TurnRecord = Tokens & {
  at: number
  seconds: number
  model: string
  // a request of this turn re-sent its prefix uncached
  isMiss: boolean
}

export type Miss = { at: number; tokens: number; idleMinutes: number }

export type Totals = {
  // `$.session.usage().startedAt` these totals count from; a change means /clear
  startedAt: number
  main: Tokens
  sub: Tokens
  mainTurns: number
  subRuns: number
  byModel: Record<string, Tokens>
  // the last turns of the main thread, oldest first
  turns: TurnRecord[]
  // the running turn's requests so far; null between turns
  live: Tokens | null
  // whether the running turn has had a miss yet
  isLiveMiss: boolean
  // when the main thread's last response arrived, to tell an expired cache
  lastStepAt: number | null
  misses: number
  missTokens: number
  // the latest miss, shown until a turn goes by without one
  lastMiss: Miss | null
  // context tokens after each main turn, oldest first
  contextHistory: number[]
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Category = { name: string; tokens: number }

export type Measure = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  autoCompactAt?: number
  categories: Category[]
  costUsd?: number
  limits: Limit[]
  // first reading of each window this session, the fallback for its share
  baseline: Record<string, number>
}

// What this session keeps in the store under its own key, for the others to read
export type Ledger = {
  label: string
  startedAt: number
  updatedAt: number
  // [time, the session's cost so far]
  cost: [number, number][]
  // [time, window kind, percent used] as this session read them
  readings: [number, string, number][]
  // the rise in each window this session's cost accounts for, by window kind
  share: Record<string, number>
}

export type Peer = { id: string; label: string; updatedAt: number; cost7d: number; weekShare: number; isSelf: boolean }

// The account's pace in one window, from every session's readings
export type Pace = { kind: string; perHour: number; atReset?: number; fullAt?: number }

declare module 'claude-code' {
  interface PluginState {
    'session-stats': {
      totals: Shaped<Totals | null>
      measure: Shaped<Measure | null>
      peers: Peer[]
      paces: Pace[]
      isHidden: boolean
    }
  }
}
