import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

const SITE = { scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

const BAND = {
  plugin: 'session-stats',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 200, ...SITE },
} as const

const PANE = {
  plugin: 'session-stats',
  component: 'Pane',
  requestId: 'session-stats',
  props: { title: 'Session stats', isFocused: false, bodyColumns: 80, placement: 'dock', ...SITE },
} as const

const HOUR = 3_600_000
const T0 = Date.parse('2026-10-26T00:00:00Z')
const RESET = new Date(T0 + 7 * 24 * HOUR).toISOString()

// The engine beneath the plugin: usage figures the test moves, and the step and turn chains' ends
const engine = (on: On, now: () => number) => {
  const world = { week: 40, cost: 0, context: 50_000 }
  const usage = () => ({
    startedAt: T0,
    context: { tokens: world.context, window: 200_000, percent: (world.context / 200_000) * 100 },
    rateLimits: [{ kind: 'seven_day', percentUsed: world.week, resetsAt: RESET }],
    cost: { usd: world.cost },
  })
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'session-stats' } }))
  on('session.id', () => ({ value: 'me' }))
  on('session.usage', (_, e) => ({
    value: {
      ...usage(),
      context: {
        ...usage().context,
        ...(e.breakdown
          ? {
              breakdown: {
                categories: [
                  { name: 'Messages', tokens: 30_000, color: 'x', isDeferred: false, kind: 'used' },
                  { name: 'System tools', tokens: 15_000, color: 'x', isDeferred: false, kind: 'used' },
                ],
                isAutoCompactEnabled: true,
                autoCompactThreshold: 160_000,
              },
            }
          : {}),
      },
    },
  }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('prompt.submit', (_, e) => e as never)
  on('turn.complete', (_, e) => ({ text: e.answer, usage: e.usage }))
  return { world, usage, toasts, now }
}

const step = async ($: EngineInterface) => {
  const s = $.turn.step({ turnId: "t", index: 0, model: "claude-opus-5-5", messageCount: 3 })
  for await (const _ of s);
  return s.result
}

test('steps add up, a cold cache is caught, and the band shows the week share', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + HOUR })
  mock.store(on, {
    // Another session that spent as much as this one while the week rose
    'ledger:other': {
      label: 'other-project',
      startedAt: T0,
      updatedAt: T0 + HOUR,
      cost: [
        [T0, 0],
        [T0 + 3 * HOUR, 2],
      ],
      readings: [],
      share: {},
    },
  })
  const w = engine(on, clock.now)
  let next = { read: 0, write: 40_000 }
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      messageCount: e.messageCount,
      usage: {
        model: e.model,
        input_tokens: 500,
        output_tokens: 1000,
        cache_read_input_tokens: next.read,
        cache_creation_input_tokens: next.write,
      },
    } as never
  })

  await $.session.start({ cwd: 'C:/code/my-app', surface: 'desktop', isInteractive: true })

  // First request writes the cache: no miss
  await $.prompt.submit({ text: 'hi' } as never)
  await step($)
  // A warm follow-up
  next = { read: 40_000, write: 1000 }
  await step($)
  w.world.context = 60_000
  await $.turn.complete({ answer: 'a', durationMs: 4000, isAborted: false, turnId: 't', reason: 'answer' } as never)
  expect(w.toasts).toEqual([])

  // Idle ten minutes: the cache expired, the prefix goes again
  await clock.advance(10 * 60_000)
  await $.prompt.submit({ text: 'again' } as never)
  next = { read: 0, write: 45_000 }
  await step($)
  w.world.context = 70_000
  await $.turn.complete({ answer: 'b', durationMs: 4000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  expect(w.toasts[0]).toContain('Cache miss: 46k tokens re-sent uncached after 10m idle')

  // The week rose 4 points while both sessions spent $2 each: half is this session's
  await clock.advance(2 * HOUR)
  w.world.cost = 2
  w.world.week = 44
  await $.session.measure({ ...w.usage(), changed: ['rateLimits', 'cost'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /cache/ }))?.text).toContain('⚠ miss')
    expect((await ui.find({ type: 'Text', text: /week/ }))?.text).toContain('week 44% (+2.0%)')
    expect((await ui.find({ type: 'Text', text: /ctx/ }))?.text).toContain('compacts ~')
    await ui.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /cache misses 1/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /System tools/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /other-project/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /my-app/ })).toBeDefined()
    await pane.unmount()
  }
})
