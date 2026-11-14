import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const SITE = { scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

const BAND = {
  plugin: 'session-stats',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 240, ...SITE },
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
    rateLimits: [
      { kind: 'five_hour', percentUsed: 20, resetsAt: new Date(T0 + 5 * HOUR).toISOString() },
      { kind: 'seven_day', percentUsed: world.week, resetsAt: RESET },
    ],
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
    } as never,
  }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('prompt.submit', (_, e) => e as never)
  on('turn.complete', (_, e) => ({ text: e.answer, usage: e.usage }))
  return { world, usage, toasts, now }
}

const step = async ($: Engine) => {
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
    expect((await ui.find({ type: 'Text', text: /\(\+/ }))?.text).toContain(surface === 'desktop' ? '(+2.0%)' : 'week 44% (+2.0%)')
    expect(await ui.find({ type: 'Text', text: /compacts ~/ })).toBeDefined()
    // The quiet 5-hour window: always on the graphical band, only from 50% on the text band
    const fiveHour = await ui.find({ type: 'Text', text: /resets 1h50/ })
    if (surface === 'desktop') {
      expect(fiveHour?.text).toContain('resets 1h50')
      // Each quota reads name, meter, percentage, in the band's own text
      expect(await ui.find({ type: 'Text', text: /^5h$/ })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /^20%/ }))?.text).toContain('resets 1h50')
    } else expect(fiveHour).toBeUndefined()
    // The graphical surfaces get meters and a sparkline; the terminal stays text
    const bandSvgs = await ui.findAll({ type: 'Svg' })
    if (surface === 'desktop') {
      // The live mark, the sparkline and the two limit meters
      expect(bandSvgs.length).toBe(4)
      // A healthy limit's meter is a quiet gray, not green
      expect(bandSvgs.some(el => String(el.props.source).includes('class="calm"'))).toBe(true)
      // Each drawing keeps its own small size rather than stretching to the slot
      expect(bandSvgs.every(el => Number(el.props.width) <= 60 && Number(el.props.height) <= 14)).toBe(true)
      // Hairlines part the groups: tokens | cache | cost | ctx | 5h | week | buttons
      expect((await ui.findAll({ type: 'Text', text: /^│$/ })).length).toBe(6)
    } else expect(bandSvgs.length).toBe(0)
    await ui.unmount()

    if (surface === 'desktop') {
      // A narrow column drops the extra words so the band stays on one line
      const narrow = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns: 60 } })
      expect(await narrow.find({ type: 'Text', text: /compacts/ })).toBeUndefined()
      // The 5-hour window stays however narrow, under 50% included
      expect(await narrow.find({ type: 'Text', text: /^5h$/ })).toBeDefined()
      expect((await narrow.find({ type: 'Text', text: /\(\+/ }))?.text).toContain('(+2.0%)')
      await narrow.unmount()
    }

    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /cache misses 1/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /System tools/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /other-project/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /my-app/ })).toBeDefined()
    const alts = (await pane.findAll({ type: 'Svg' })).map(el => String((el.props as { alt?: string }).alt ?? ''))
    if (surface === 'desktop') {
      expect(alts.some(a => a.startsWith('Prompt and output tokens of the last 2 turns, cache misses'))).toBe(true)
      expect(alts.some(a => a.startsWith('What fills the context: Messages 30k, System tools 15k'))).toBe(true)
      expect(alts.some(a => a.startsWith('week limit 44% used'))).toBe(true)
    } else expect(alts).toEqual([])
    await pane.unmount()
  }
  // Idle, the graphical band leaves the session totals to the sparkline's tooltip
  const idle = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await idle.find({ type: 'Text', text: / in · / })).toBeUndefined()
  const idleSvgs = await idle.findAll({ type: 'Svg' })
  // Between turns the mark sits dim and still
  expect(String(idleSvgs[0]?.props.alt)).toBe('Idle')
  expect(String(idleSvgs[0]?.props.source)).not.toContain('class="mk-lit')
  const sparkAlt = String(idleSvgs[1]?.props.alt)
  expect(sparkAlt).toContain('this session 128k in, 3.0k out')
  // A week on pace to fill early says when, in place of its reset
  expect((await idle.find({ type: 'Text', text: /\(\+/ }))?.text).toContain('→ 100% in')
  await idle.unmount()

  // While a turn runs, the band shows how long it has been going and its tokens so far
  await $.prompt.submit({ text: 'more' } as never)
  next = { read: 45_000, write: 500 }
  await step($)
  await clock.advance(42_000)
  const working = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: true } })
  expect((await working.find({ type: 'Text', text: /^turn / }))?.text).toBe('turn 0:42 · 46k in · 1.0k out')
  // While it runs, light passes through the mark
  const mark = (await working.findAll({ type: 'Svg' }))[0]
  expect(String(mark?.props.alt)).toBe('Claude is working')
  expect(String(mark?.props.source)).toContain('class="mk-lit')
  await working.unmount()
})
