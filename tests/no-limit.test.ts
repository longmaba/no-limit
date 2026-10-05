import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const T0 = Date.parse('2026-10-05T10:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SCROLL = { offset: 0, bodyRows: 30 }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: SCROLL, view: {} }
const PANE_PROPS = { title: 'no-limit', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: SCROLL, view: {} }
// Tests that move the clock by hours keep the status line still, so the
// 400 ms frame timer doesn't run thousands of times
const STILL = { animate: false }

// The engine beneath the mod: a clock and store in memory, the rate-limit
// windows the last response reported, and a record of every prompt
// submitted, the status line as last set, and the toasts and panes shown
async function start($: Engine, on: On, rateLimits: SessionRateLimit[], stored: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, stored)
  const prompts: string[] = []
  const seen = { status: undefined as string | undefined, toasts: [] as string[], panes: [] as string[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('classic.StopFailure', () => ({}))
  on('ui.status', (_$, e) => {
    seen.status = e.text
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    seen.panes.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', () => null as never)
  on('session.usage', () => ({ value: { startedAt: T0, context: { window: 200_000 }, rateLimits } }))
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const run = async (args: string) =>
    (await $.command.run({ command: 'no-limit', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text

  return { clock, prompts, seen, run }
}

// The footer indicator as the terminal draws it, its Texts joined
async function footer($: Engine, modes: string[] = []) {
  const ui = await $.ui.mount({ plugin: 'no-limit', surface: 'terminal', component: 'SessionMode', props: { modes } })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map(t => t.text).join('')
}

test('a 5-hour limit resumes a minute after the window resets', async ($, on) => {
  const { clock, prompts, seen } = await start(
    $,
    on,
    [
      { kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + 2 * HOUR).toISOString() },
      { kind: 'seven_day', percentUsed: 40, resetsAt: new Date(T0 + 72 * HOUR).toISOString() },
    ],
    STILL,
  )
  expect(await footer($)).toBe('●∙∙∙∙ no-limit · 5h 100%')

  await $.classic.StopFailure({ error: 'rate_limit' })
  expect(await footer($)).toBe('(-.-)     resets in 2h 1m')
  expect(seen.toasts.at(-1)).toContain('5-hour limit hit')

  await clock.advance(2 * HOUR)
  expect(prompts).toEqual([])
  expect(await footer($)).toContain('resets in 1m')

  await clock.advance(2 * MINUTE)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('usage limit has reset')
  expect(await footer($)).toContain('no-limit')
  // Nothing goes to the engine's status line, which it draws as a warning
  expect(seen.status).toBe(undefined)
})

test('a full weekly window waits for the weekly reset', async ($, on) => {
  const { clock, prompts, run } = await start(
    $,
    on,
    [
      { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(T0 + HOUR).toISOString() },
      { kind: 'seven_day', percentUsed: 100, resetsAt: new Date(T0 + 30 * HOUR).toISOString() },
    ],
    STILL,
  )

  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(2 * HOUR)
  expect(prompts).toEqual([])
  expect(await run('status')).toContain('Weekly limit hit; resuming in 1d 4h')
})

test('with no reset time it backs off, and gives up after repeated failures', async ($, on) => {
  const { clock, prompts, seen } = await start($, on, [], STILL)

  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(15 * MINUTE)
  expect(prompts.length).toBe(1)

  // The resume hit the limit again: the next wait doubles
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(15 * MINUTE)
  expect(prompts.length).toBe(1)
  await clock.advance(15 * MINUTE)
  expect(prompts.length).toBe(2)

  for (let i = 2; i < 5; i++) {
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(60 * MINUTE)
  }
  expect(prompts.length).toBe(5)

  await $.classic.StopFailure({ error: 'rate_limit' })
  expect(seen.toasts.at(-1)).toContain('giving up')
  expect(await footer($)).toContain('stopped retrying')
  await clock.advance(5 * HOUR)
  expect(prompts.length).toBe(5)
})

test('other API errors are left alone', async ($, on) => {
  const { run } = await start($, on, [], STILL)
  await $.classic.StopFailure({ error: 'authentication_failed' })
  expect(await run('status')).toContain('Nothing is pending')
})

test('typing at the prompt cancels the pending resume', async ($, on) => {
  const { clock, prompts } = await start($, on, [], STILL)
  await $.classic.StopFailure({ error: 'rate_limit' })

  await $.prompt.submit({ text: 'never mind', wait: false, origin: { kind: 'composer' } })
  await clock.advance(HOUR)
  expect(prompts).toEqual(['never mind'])
})

test('/no-limit off stops it, and message sets the prompt', async ($, on) => {
  const { clock, prompts, run, seen } = await start($, on, [], STILL)

  await run('off')
  expect(await footer($)).toBe('○ no-limit off')
  await $.classic.StopFailure({ error: 'rate_limit' })
  expect(await run('status')).toContain('Auto-resume is off. Nothing is pending')

  await run('on')
  await run('message keep going')
  await run('test 2')
  await clock.advance(2 * MINUTE)
  expect(prompts).toEqual(['keep going'])
})

test('the footer sweeps while watching and snoozes while waiting', async ($, on) => {
  const { clock, run } = await start($, on, [{ kind: 'five_hour', percentUsed: 62 }])
  expect(await footer($)).toBe('●∙∙∙∙ no-limit · 5h 62%')
  expect(await footer($, ['focus'])).toBe('focus · ●∙∙∙∙ no-limit · 5h 62%')

  await clock.advance(400)
  expect(await footer($)).toBe('∙●∙∙∙ no-limit · 5h 62%')
  await clock.advance(400)
  expect(await footer($)).toBe('∙∙●∙∙ no-limit · 5h 62%')

  await run('test 10')
  expect(await footer($)).toMatch(/^\(-[._]-\).* resets in 10m$/)
  const snoozing = await footer($)
  await clock.advance(400)
  expect(await footer($)).not.toBe(snoozing)

  await run('now')
  await clock.settle()
  expect(await footer($)).toMatch(/\^\S?\) ?\S* +back to work$/)
  await clock.advance(6000)
  expect(await footer($)).toContain('no-limit · 5h 62%')

  await run('anim off')
  const still = await footer($)
  await clock.advance(2000)
  expect(await footer($)).toBe(still)
})

test('the band counts down, and Resume now resumes at once', async ($, on) => {
  const { prompts, seen } = await start(
    $,
    on,
    [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + 90 * MINUTE).toISOString() }],
    STILL,
  )
  await $.classic.StopFailure({ error: 'rate_limit' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'no-limit', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect((await ui.find({ key: 'now' }))?.text).toBe('Resume now')
    expect((await ui.find({ type: 'Text', text: /resuming in/ }))?.text).toContain('1h 31m')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'no-limit', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'details' })
  expect(seen.panes).toEqual(['no-limit'])
  await ui.press({ key: 'now' })
  expect(prompts.length).toBe(1)
})

test('the dashboard shows usage, takes a new prompt, and starts a test', async ($, on) => {
  const { run, seen, clock, prompts } = await start(
    $,
    on,
    [
      { kind: 'five_hour', percentUsed: 62, resetsAt: new Date(T0 + 2 * HOUR).toISOString() },
      { kind: 'seven_day', percentUsed: 18, resetsAt: new Date(T0 + 99 * HOUR).toISOString() },
    ],
    STILL,
  )
  expect(await run('')).toBe('Opened the no-limit dashboard.')
  expect(seen.panes).toEqual(['no-limit'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'no-limit', surface, component: 'Pane', requestId: 'no-limit', props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: /WATCHING/ }))).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'resets in 4d 3h' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'no-limit', surface: 'terminal', component: 'Pane', requestId: 'no-limit', props: PANE_PROPS })
  await ui.input({ key: 'message', text: 'pick it back up' })
  expect(await ui.find({ type: 'Text', text: 'pick it back up' })).toBeDefined()

  await ui.press({ key: 'test' })
  expect((await ui.find({ type: 'Text', text: /WAITING FOR RESET/ }))).toBeDefined()
  await clock.advance(MINUTE)
  expect(prompts).toEqual(['pick it back up'])
  expect(await ui.find({ type: 'Text', text: /after the test limit/ })).toBeDefined()
})
