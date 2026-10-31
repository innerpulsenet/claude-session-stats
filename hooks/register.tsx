import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionRateLimit } from 'claude-code'

import type { Category, Ledger, Limit, Measure, Pace, Peer, Tokens, Totals, TurnRecord } from '../types'

// Change a tag when that value's fields change: it declines what an earlier version stored
const totalsAtom = atom({ plugin: 'session-stats', key: 'totals' } as const, null, { shape: 'totals-2' })
const measureAtom = atom({ plugin: 'session-stats', key: 'measure' } as const, null, { shape: 'measure-2' })
const peersAtom = atom({ plugin: 'session-stats', key: 'peers' } as const, [])
const pacesAtom = atom({ plugin: 'session-stats', key: 'paces' } as const, [])
const isHiddenAtom = atom({ plugin: 'session-stats', key: 'isHidden' } as const, false)

const PANE = 'session-stats'
const HOUR = 3_600_000
const DAY = 24 * HOUR
const LEDGER = 'ledger:'
// A request this big that the cache served less than half of re-sent its prefix
const MISS_MIN_TOKENS = 20_000
const TURNS_KEPT = 30

const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }
// How far back the pace of each window looks
const PACE_SPAN: Record<string, number> = { five_hour: HOUR, seven_day: DAY }

// --- counting ---

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 })

const add = (t: Tokens, u: ModelUsage): Tokens => ({
  input: t.input + u.input_tokens,
  output: t.output + u.output_tokens,
  cacheRead: t.cacheRead + u.cache_read_input_tokens,
  cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
  requests: t.requests + 1,
})

const sum = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  requests: a.requests + b.requests,
})

const promptOf = (t: Tokens) => t.input + t.cacheRead + t.cacheWrite

const fresh = (startedAt: number): Totals => ({
  startedAt,
  main: zero(),
  sub: zero(),
  mainTurns: 0,
  subRuns: 0,
  byModel: {},
  turns: [],
  live: null,
  isLiveMiss: false,
  lastStepAt: null,
  misses: 0,
  missTokens: 0,
  lastMiss: null,
  contextHistory: [],
})

// Share of all prompt tokens the cache served
const hitRate = (t: Tokens): number | undefined => {
  const prompt = promptOf(t)
  return prompt === 0 ? undefined : (t.cacheRead / prompt) * 100
}

// --- formatting ---

const fmt = (n: number): string => {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

const pct = (n: number | undefined): string => (n === undefined ? '–' : `${n.toFixed(n < 10 ? 1 : 0)}%`)

const usd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 1)}`

const span = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins < 60) return `${mins}m`
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`
  const hours = Math.round(mins / 60)
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const bar = (value: number, max: number, width: number) => {
  const n = max <= 0 ? 0 : Math.max(0, Math.min(width, Math.round((value / max) * width)))
  return '█'.repeat(n) + '░'.repeat(width - n)
}

const limitName = (kind: string) => LIMIT_NAMES[kind] ?? kind

const levelColor = (n: number | undefined, warn: number, bad: number) =>
  n === undefined ? undefined : n >= bad ? 'red' : n >= warn ? 'yellow' : undefined

// --- context ---

// Turns until auto-compaction, from how much the context grew over the last turns
const turnsToCompact = (t: Totals, m: Measure | null): number | undefined => {
  if (!m?.autoCompactAt || m.contextTokens === undefined) return undefined
  const steps = t.contextHistory.slice(-6)
  const growth: number[] = []
  for (let i = 1; i < steps.length; i++) {
    const d = steps[i]! - steps[i - 1]!
    if (d > 0) growth.push(d)
  }
  if (growth.length === 0) return undefined
  const avg = growth.reduce((a, b) => a + b, 0) / growth.length
  const left = m.autoCompactAt - m.contextTokens
  return left <= 0 ? 0 : Math.ceil(left / avg)
}

const toMeasure = (
  prev: Measure | null,
  m: { context: { tokens?: number; window: number; percent?: number }; rateLimits: SessionRateLimit[]; cost?: { usd: number } },
): Measure => {
  const baseline = { ...(prev?.baseline ?? {}) }
  for (const l of m.rateLimits) {
    const base = baseline[l.kind]
    // A window that reset mid-session counts this session's share from the reset
    if (base === undefined) baseline[l.kind] = l.percentUsed
    else if (l.percentUsed < base) baseline[l.kind] = 0
  }
  return {
    contextTokens: m.context.tokens,
    contextWindow: m.context.window,
    contextPercent: m.context.percent,
    autoCompactAt: prev?.autoCompactAt,
    categories: prev?.categories ?? [],
    costUsd: m.cost?.usd,
    limits: m.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    baseline,
  }
}

// --- the ledger every session keeps in the store ---

// A ledger's cost at `t`: its last entry at or before then, else its first
const costAt = (l: Ledger, t: number): number => {
  let value = l.cost[0]?.[1] ?? 0
  for (const [at, c] of l.cost) {
    if (at > t) break
    value = c
  }
  return value
}

const readLedgers = async ($: EngineInterface): Promise<Record<string, Ledger>> => {
  const out: Record<string, Ledger> = {}
  for (const key of await $.store.keys()) {
    if (!key.startsWith(LEDGER)) continue
    const value = (await $.store.get(key)) as Ledger | undefined
    if (value && Array.isArray(value.cost) && Array.isArray(value.readings)) out[key.slice(LEDGER.length)] = value
  }
  return out
}

// The account's pace in each window, from every session's readings since the window last reset
const pacesOf = (ledgers: Ledger[], limits: Limit[], now: number): Pace[] =>
  limits.flatMap(l => {
    const all = ledgers
      .flatMap(g => g.readings.filter(r => r[1] === l.kind))
      .sort((a, b) => a[0] - b[0])
    // Readings before the last drop belong to an earlier window
    let start = 0
    for (let i = 1; i < all.length; i++) if (all[i]![2] < all[i - 1]![2] - 1) start = i
    const window = all.slice(start)
    if (window.length === 0) return []
    const from = Math.max(now - (PACE_SPAN[l.kind] ?? DAY), window[0]![0])
    if (now - from < 15 * 60_000) return []
    let then = window[0]![2]
    for (const r of window) if (r[0] <= from) then = r[2]
    const perHour = Math.max(0, (l.percentUsed - then) / ((now - from) / HOUR))
    const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : undefined
    const atReset = resetsAt === undefined ? undefined : l.percentUsed + perHour * ((resetsAt - now) / HOUR)
    const fullAt =
      perHour > 0 && (atReset === undefined || atReset >= 100)
        ? now + ((100 - l.percentUsed) / perHour) * HOUR
        : undefined
    return [{ kind: l.kind, perHour, atReset, fullAt }]
  })

// This session, as the ledger names it; set at session.start
const current: { id: string; label: string; ledger: Ledger | null } = { id: '', label: 'session', ledger: null }

// Writes this session's spend and readings, attributes each window's rise across the
// sessions that spent during it, and refreshes the peers and paces drawn from them
async function syncLedger($: EngineInterface, cost?: number, limits?: Limit[]) {
  if (!current.id) return
  const now = await $.clock.now()
  const ledgers = await readLedgers($)
  if (!current.ledger) current.ledger = ledgers[current.id] ?? { label: current.label, startedAt: now, updatedAt: now, cost: [], readings: [], share: {} }
  const self = current.ledger
  self.label = current.label
  self.updatedAt = now

  if (cost !== undefined && self.cost[self.cost.length - 1]?.[1] !== cost) self.cost.push([now, cost])

  for (const l of limits ?? []) {
    const last = self.readings.filter(r => r[1] === l.kind).pop()
    if (last && last[2] === l.percentUsed) continue
    if (last && l.percentUsed < last[2] - 1) {
      self.share[l.kind] = 0
    } else if (last && l.percentUsed > last[2]) {
      const spent = (g: Ledger) => Math.max(0, costAt(g, now) - costAt(g, last[0]))
      const others = Object.entries(ledgers).filter(([id]) => id !== current.id).map(([, g]) => g)
      const total = spent(self) + others.reduce((a, g) => a + spent(g), 0)
      if (total > 0) self.share[l.kind] = (self.share[l.kind] ?? 0) + ((l.percentUsed - last[2]) * spent(self)) / total
    }
    self.readings.push([now, l.kind, l.percentUsed])
  }

  // Keep eight days, and always the latest entry
  const keep = <T extends [number, ...unknown[]]>(rows: T[]) =>
    rows.filter((r, i) => r[0] >= now - 8 * DAY || i === rows.length - 1).slice(-2000)
  self.cost = keep(self.cost)
  self.readings = keep(self.readings)
  await $.store.set(LEDGER + current.id, self)
  ledgers[current.id] = self

  const peers: Peer[] = []
  for (const [id, g] of Object.entries(ledgers)) {
    if (g.updatedAt < now - 8 * DAY) {
      await $.store.delete(LEDGER + id)
      continue
    }
    if (g.updatedAt < now - 7 * DAY) continue
    peers.push({
      id,
      label: g.label,
      updatedAt: g.updatedAt,
      cost7d: costAt(g, now) - costAt(g, now - 7 * DAY),
      weekShare: g.share['seven_day'] ?? 0,
      isSelf: id === current.id,
    })
  }
  peers.sort((a, b) => b.cost7d - a.cost7d)
  await update($, peersAtom, () => peers)

  const measure = await read($, measureAtom)
  await update($, pacesAtom, () => pacesOf(Object.values(ledgers), measure?.limits ?? [], now))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'session-stats', description: 'Open the session stats panel and show the band' })
    current.id = await $.session.id()
    current.label = e.cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'session'
    const usage = await $.session.usage()
    await update($, measureAtom, prev => toMeasure(prev, usage))
    await update($, totalsAtom, prev => (prev && prev.startedAt === usage.startedAt ? prev : fresh(usage.startedAt)))
    await syncLedger($, usage.cost?.usd, usage.rateLimits)
    // Other sessions' spend and readings arrive through the store
    $.clock.every(2 * 60_000, () => void syncLedger($))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, measureAtom, prev => toMeasure(prev, e))
    await syncLedger($, e.cost?.usd, e.rateLimits)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, totalsAtom, t => (t ? { ...t, live: zero(), isLiveMiss: false } : t))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    if (!usage) return result
    const now = await $.clock.now()
    const isSub = typeof e.agentId === 'string'

    const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    let missed: { tokens: number; idleMinutes: number } | null = null

    await update($, totalsAtom, prev => {
      const t = prev ?? fresh(startedAt)
      const isMiss =
        !isSub && t.lastStepAt !== null && prompt >= MISS_MIN_TOKENS && usage.cache_read_input_tokens < prompt / 2
      if (isMiss) {
        missed = {
          tokens: usage.input_tokens + usage.cache_creation_input_tokens,
          idleMinutes: Math.round((startedAt - (t.lastStepAt ?? startedAt)) / 60_000),
        }
      }
      return {
        ...t,
        main: isSub ? t.main : add(t.main, usage),
        sub: isSub ? add(t.sub, usage) : t.sub,
        byModel: { ...t.byModel, [usage.model]: add(t.byModel[usage.model] ?? zero(), usage) },
        live: isSub ? t.live : add(t.live ?? zero(), usage),
        isLiveMiss: t.isLiveMiss || isMiss,
        lastStepAt: isSub ? t.lastStepAt : now,
        misses: t.misses + (missed ? 1 : 0),
        missTokens: t.missTokens + (missed?.tokens ?? 0),
        lastMiss: missed ? { at: now, ...missed } : t.lastMiss,
      }
    })

    const miss = missed as { tokens: number; idleMinutes: number } | null
    if (miss) {
      const idle = miss.idleMinutes >= 5 ? ` after ${span(miss.idleMinutes * 60_000)} idle` : ''
      $.ui.toast(`Cache miss: ${fmt(miss.tokens)} tokens re-sent uncached${idle}`)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isSub = 'agentId' in e && typeof e.agentId === 'string'
    const usage = await $.session.usage(isSub ? undefined : { breakdown: 'summary' })
    const now = await $.clock.now()

    await update($, totalsAtom, prev => {
      // /clear starts the session's figures over
      const t = prev && prev.startedAt === usage.startedAt ? prev : fresh(usage.startedAt)
      if (isSub) return { ...t, subRuns: t.subRuns + 1 }
      const live = t.live ?? zero()
      const turn: TurnRecord = {
        ...live,
        at: now,
        seconds: Math.round(e.durationMs / 1000),
        model: e.usage?.model ?? '',
        isMiss: t.isLiveMiss,
      }
      return {
        ...t,
        mainTurns: t.mainTurns + 1,
        turns: live.requests > 0 ? [...t.turns, turn].slice(-TURNS_KEPT) : t.turns,
        live: null,
        isLiveMiss: false,
        lastMiss: t.isLiveMiss ? t.lastMiss : null,
        contextHistory:
          usage.context.tokens === undefined
            ? t.contextHistory
            : [...t.contextHistory, usage.context.tokens].slice(-TURNS_KEPT),
      }
    })

    const breakdown = usage.context.breakdown
    if (breakdown) {
      const categories: Category[] = breakdown.categories
        .filter(c => c.tokens > 0 && c.kind !== 'buffer')
        .map(c => ({ name: c.name, tokens: c.tokens }))
      await update($, measureAtom, prev => ({
        ...toMeasure(prev, usage),
        autoCompactAt: breakdown.isAutoCompactEnabled ? breakdown.autoCompactThreshold : undefined,
        categories,
      }))
    }
    await syncLedger($, usage.cost?.usd)
    return result
  })

  on('command.run', { command: 'session-stats' }, async $ => {
    await update($, isHiddenAtom, () => false)
    await $.ui.open({ id: PANE, title: 'Session stats' })
    return { text: 'Session stats panel opened.' }
  })

  // --- the band ---

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHiddenAtom))) return next(e)

    const totals = await read($, totalsAtom)
    const measure = await read($, measureAtom)
    if (!totals && !measure) return next(e)

    const peers = await read($, peersAtom)
    const paces = await read($, pacesAtom)
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)

    const t = totals ?? fresh(now)
    const all = sum(t.main, t.sub)
    const hit = hitRate(all)
    const ctx = measure?.contextPercent
    const compactIn = turnsToCompact(t, measure)
    const self = peers.find(p => p.isSelf)
    const live = e.props.isWorking ? t.live : null

    const limitParts = (measure?.limits ?? []).flatMap(l => {
      const pace = paces.find(p => p.kind === l.kind)
      const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : undefined
      const isEarly = pace?.fullAt !== undefined && (resetsAt === undefined || pace.fullAt < resetsAt)
      if (l.kind === 'five_hour' && l.percentUsed < 50 && !isEarly) return []

      let text = `${limitName(l.kind)} ${pct(l.percentUsed)}`
      if (l.kind === 'seven_day') {
        const base = measure?.baseline[l.kind]
        const share = self && self.weekShare > 0 ? self.weekShare : base === undefined ? 0 : l.percentUsed - base
        text += ` (+${pct(Math.max(0, share))})`
      }
      if (isEarly && pace?.fullAt !== undefined) text += ` → 100% in ${span(pace.fullAt - now)}`
      else if (pace?.atReset !== undefined && l.kind === 'seven_day') text += ` → ${pct(Math.min(pace.atReset, 100))} at reset`
      return [{ kind: l.kind, text, color: isEarly ? 'red' : levelColor(l.percentUsed, 75, 90) }]
    })

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {live ? (
          <Text bold color={t.isLiveMiss ? 'red' : undefined}>
            turn in {fmt(promptOf(live))} out {fmt(live.output)} ·
          </Text>
        ) : null}
        <Text>
          in {fmt(promptOf(all))} out {fmt(all.output)}
        </Text>
        <Text dimColor>·</Text>
        <Text color={t.lastMiss ? 'red' : levelColor(hit === undefined ? undefined : 100 - hit, 20, 50) ?? 'green'}>
          cache {pct(hit)}
          {t.lastMiss ? ' ⚠ miss' : ''}
        </Text>
        <Text dimColor>·</Text>
        <Text color={compactIn !== undefined && compactIn <= 3 ? 'red' : levelColor(ctx, 60, 80)}>
          ctx {pct(ctx)}
          {compactIn !== undefined && compactIn <= 15 ? ` (compacts ~${compactIn} turns)` : ''}
        </Text>
        {measure?.costUsd !== undefined ? <Text dimColor>· {usd(measure.costUsd)}</Text> : null}
        {limitParts.map(p => (
          <Text key={`lim-${p.kind}`} color={p.color}>
            · {p.text}
          </Text>
        ))}
        <Button key="details" label="Details" dimColor onPress={() => void $.ui.open({ id: PANE, title: 'Session stats' })} />
        <Button key="hide" label="Hide" dimColor onPress={() => update($, isHiddenAtom, () => true)} />
      </Box>
    )
  })

  // --- the details panel ---

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const totals = await read($, totalsAtom)
    const measure = await read($, measureAtom)
    const peers = await read($, peersAtom)
    const paces = await read($, pacesAtom)
    const now = await $.clock.now()

    const t = totals ?? fresh(now)
    const all = sum(t.main, t.sub)
    const hours = Math.max((now - t.startedAt) / HOUR, 1 / 60)
    const width = Math.max(8, Math.min(24, e.props.bodyColumns - 36))
    const compactIn = turnsToCompact(t, measure)
    const self = peers.find(p => p.isSelf)

    const Head = ({ title }: { title: string }) => (
      <Box marginTop={1}>
        <Text bold>{title}</Text>
      </Box>
    )

    const recent = t.turns.slice(-12)
    const maxTurn = Math.max(1, ...recent.map(promptOf))
    const categories = [...(measure?.categories ?? [])].sort((a, b) => b.tokens - a.tokens)
    const maxCat = Math.max(1, ...categories.map(c => c.tokens))

    return (
      <Box flexDirection="column">
        <Text bold>Tokens</Text>
        <Text>
          in {fmt(promptOf(all))} · out {fmt(all.output)} · {all.requests} requests over {span(now - t.startedAt)}
        </Text>
        <Text dimColor>
          uncached {fmt(all.input)} · cache read {fmt(all.cacheRead)} · cache written {fmt(all.cacheWrite)}
        </Text>
        <Text dimColor>
          main {t.mainTurns} turns, cache {pct(hitRate(t.main))} · subagents {t.subRuns} runs, {fmt(promptOf(t.sub))} in,{' '}
          {fmt(t.sub.output)} out
        </Text>
        <Text color={t.misses > 0 ? 'yellow' : undefined}>
          cache misses {t.misses}
          {t.misses > 0 ? ` · ${fmt(t.missTokens)} tokens re-sent` : ''}
          {t.lastMiss ? ` · last ${span(now - t.lastMiss.at)} ago` : ''}
        </Text>
        {measure?.costUsd !== undefined ? (
          <Text>
            cost {usd(measure.costUsd)} · {usd(measure.costUsd / hours)}/h
          </Text>
        ) : null}

        <Head title="Limits" />
        {(measure?.limits ?? []).length === 0 ? <Text dimColor>No rate-limit reading yet.</Text> : null}
        {(measure?.limits ?? []).map(l => {
          const pace = paces.find(p => p.kind === l.kind)
          const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : undefined
          const isEarly = pace?.fullAt !== undefined && (resetsAt === undefined || pace.fullAt < resetsAt)
          const base = measure?.baseline[l.kind]
          const share =
            l.kind === 'seven_day' && self && self.weekShare > 0
              ? self.weekShare
              : base === undefined
                ? 0
                : Math.max(0, l.percentUsed - base)
          return (
            <Box key={`limit-${l.kind}`} flexDirection="column">
              <Text color={isEarly ? 'red' : levelColor(l.percentUsed, 75, 90)}>
                {limitName(l.kind)} {bar(l.percentUsed, 100, width)} {pct(l.percentUsed)}
                {resetsAt !== undefined ? ` · resets in ${span(resetsAt - now)}` : ''}
              </Text>
              <Text dimColor>
                {'  '}this session ≈{pct(share)}
                {pace ? ` · pace ${pct(pace.perHour)}/h` : ''}
                {isEarly && pace?.fullAt !== undefined
                  ? ` · full in ${span(pace.fullAt - now)}, before the reset`
                  : pace?.atReset !== undefined
                    ? ` · on pace for ${pct(Math.min(pace.atReset, 100))} at reset`
                    : ''}
              </Text>
            </Box>
          )
        })}

        <Head title="Context" />
        <Text color={levelColor(measure?.contextPercent, 60, 80)}>
          {fmt(measure?.contextTokens ?? 0)} of {fmt(measure?.contextWindow ?? 0)} ({pct(measure?.contextPercent)})
          {measure?.autoCompactAt ? ` · compacts at ${fmt(measure.autoCompactAt)}` : ''}
          {compactIn !== undefined ? ` · ~${compactIn} turns left` : ''}
        </Text>
        {categories.map(c => (
          <Text key={`cat-${c.name}`} dimColor>
            {bar(c.tokens, maxCat, width)} {fmt(c.tokens).padStart(5)} {c.name}
          </Text>
        ))}

        <Head title="Recent turns" />
        {recent.length === 0 ? <Text dimColor>No turns yet.</Text> : null}
        {recent.map((r, i) => (
          <Text key={`turn-${r.at}`} color={r.isMiss ? 'red' : undefined} dimColor={!r.isMiss}>
            {String(t.mainTurns - recent.length + i + 1).padStart(3)} {bar(promptOf(r), maxTurn, width)}{' '}
            {fmt(promptOf(r)).padStart(5)} in {fmt(r.output).padStart(5)} out · {pct(hitRate(r))} cache · {r.seconds}s
            {r.isMiss ? ' ⚠ miss' : ''}
          </Text>
        ))}

        <Head title="By model" />
        {Object.entries(t.byModel).map(([model, m]) => (
          <Text key={`model-${model}`} dimColor>
            {model}: {m.requests} requests · {fmt(promptOf(m))} in · {fmt(m.output)} out · cache {pct(hitRate(m))}
          </Text>
        ))}

        <Head title="Sessions this week" />
        {peers.slice(0, 8).map(p => (
          <Text key={`peer-${p.id}`} bold={p.isSelf} dimColor={!p.isSelf}>
            {p.isSelf ? '▸ ' : '  '}
            {p.label.slice(0, 24).padEnd(24)} {usd(p.cost7d).padStart(7)} · week +{pct(p.weekShare)} ·{' '}
            {now - p.updatedAt < 5 * 60_000 ? 'active' : `${span(now - p.updatedAt)} ago`}
          </Text>
        ))}
        <Text dimColor>
          A session's week share splits each rise in the weekly limit by what each session spent while it rose.
          Sessions show up here once this mod has run in them.
        </Text>
      </Box>
    )
  })
}
