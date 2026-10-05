import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Limit, Pending, Resumed } from '../types'

const pending = atom({ plugin: 'no-limit', key: 'pending' } as const, null)
const lastResume = atom({ plugin: 'no-limit', key: 'lastResume' } as const, null)
const history = atom({ plugin: 'no-limit', key: 'history' } as const, [])
const limits = atom({ plugin: 'no-limit', key: 'limits' } as const, [])
const enabled = atom({ plugin: 'no-limit', key: 'enabled' } as const, true)
const message = atom({ plugin: 'no-limit', key: 'message' } as const, null)
const animate = atom({ plugin: 'no-limit', key: 'animate' } as const, true)
const frame = atom({ plugin: 'no-limit', key: 'frame' } as const, 0)
const cheerUntil = atom({ plugin: 'no-limit', key: 'cheerUntil' } as const, 0)
const hasGivenUp = atom({ plugin: 'no-limit', key: 'hasGivenUp' } as const, false)

const PANE = 'no-limit'
const MINUTE = 60_000
// How often the countdown checks the clock: polling, not one long timer,
// so a laptop that slept through the reset still resumes once it wakes
const TICK_MS = 30_000
const FRAME_MS = 400
// Wait this long past the reported reset so the first request isn't refused
const BUFFER_MS = 1 * MINUTE
// A limit hit this soon after a resume counts as that resume failing
const RETRY_WINDOW_MS = 10 * MINUTE
const MAX_ATTEMPTS = 5
// When the API reports no reset time: 15m, 30m, 60m, 60m, ...
const FALLBACK_MS = 15 * MINUTE
const FALLBACK_MAX_MS = 60 * MINUTE
const HISTORY_SIZE = 10
// Frames the footer cheers for after a resume, about five seconds
const CHEER_FRAMES = 12

const DEFAULT_MESSAGE =
  'The usage limit has reset. Carry on with the task you were working on when the limit stopped you. If it was already finished, say so in one line.'

const HELP = [
  '/no-limit            open the dashboard',
  '/no-limit status     print what is pending',
  '/no-limit now        resume right away',
  '/no-limit cancel     drop the pending resume',
  '/no-limit off | on   stop or start resuming automatically',
  '/no-limit anim off | on   still or animated footer indicator',
  '/no-limit message …  set the resume prompt (no text: back to the default)',
  '/no-limit test [m]   pretend the limit was hit, resuming in m minutes (default 1)',
].join('\n')

// The footer indicator's frames: a soft sweep while watching, a snooze
// through the wait, a cheer on waking
const SWEEP = ['●∙∙∙∙', '∙●∙∙∙', '∙∙●∙∙', '∙∙∙●∙', '∙∙∙∙●', '∙∙∙●∙', '∙∙●∙∙', '∙●∙∙∙']
const SNOOZE = ['(-.-)    ', '(-.-) z  ', '(-.-) zZ ', '(-_-) zZz', '(-_-)  Zz', '(-.-)   z']
const CHEER = ['\\(^o^)/', '\\(^_^)/', '\\(^o^)/', '(^_^)b ']

let frames: Timer | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'no-limit',
      description: 'Auto-resume after a usage limit: open the dashboard, or status, now, cancel, off, on, anim, message, test',
      argumentHint: '[status|now|cancel|off|on|anim on|anim off|message <text>|test [minutes]]',
    })
    // The engine draws a status line as a warning; this mod draws in the footer instead
    $.ui.status(undefined)
    await load($)
    // A reload drops the old timers; the pending resume itself lives in $.state
    $.clock.every(TICK_MS, () => void tick($))
    await tick($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, limits, () => e.rateLimits.map(w => ({ ...w })))
      await refresh($)
    }

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit' && (await read($, enabled))) {
      await arm($)
    }

    return next(e)
  })

  // The person typing at the prompt means they're back: their prompt wins
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && (await read($, pending)) !== null) {
      await clear($)
    }

    return next(e)
  })

  on('command.run', { command: 'no-limit' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const text = e.args.trim().slice(verb.length).trim()

    switch (verb.toLowerCase()) {
      case '':
      case 'dashboard': {
        const opened = await $.ui.open({ id: PANE, title: 'no-limit' })
        return { text: opened.isPlaced ? 'Opened the no-limit dashboard.' : await describeStatus($) }
      }
      case 'status':
        return { text: await describeStatus($) }
      case 'now': {
        const p = await read($, pending)
        if (p === null) return { text: 'Nothing is pending.' }
        // A prompt submitted from this hook would wait on the turn the hook holds
        $.clock.after(0, () => void resumeNow($))
        return { text: 'Resuming now.' }
      }
      case 'cancel':
        await clear($)
        return { text: 'Pending resume cancelled.' }
      case 'off':
        await setEnabled($, false)
        return { text: 'Auto-resume is off. /no-limit on turns it back on.' }
      case 'on':
        await setEnabled($, true)
        return { text: 'Auto-resume is on.' }
      case 'anim':
      case 'animation': {
        const isOn = rest[0]?.toLowerCase() !== 'off'
        await setAnimated($, isOn)
        return { text: isOn ? 'Status line animation on.' : 'Status line animation off.' }
      }
      case 'message':
        await setMessage($, text)
        return { text: text === '' ? `Resume prompt reset to the default:\n${DEFAULT_MESSAGE}` : `Resume prompt set to:\n${text}` }
      case 'test': {
        const minutes = Number(rest[0] ?? 1)
        if (!Number.isFinite(minutes) || minutes <= 0) return { text: 'Usage: /no-limit test [minutes]' }
        await pretend($, minutes)
        return { text: `Pretending the limit was hit. Resuming in ${until(minutes * MINUTE)}.` }
      }
      default:
        return { text: HELP }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, pending)
    if (p === null || e.props.hasSurvey) {
      return next(e)
    }

    const now = await $.clock.now()
    const retry = p.attempts > 0 ? ` · retry ${p.attempts}/${MAX_ATTEMPTS - 1}` : ''
    const [done, left] = bar(progress(p, now), clamp(e.props.bodyColumns - 75, 6, 16))
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1}>
        <Text color="yellow">(-.-) zZ</Text>
        <Text bold>{label(p.window)}</Text>
        <Box flexDirection="row">
          <Text color="yellow">{done}</Text>
          <Text dimColor>{left}</Text>
        </Box>
        <Text>
          resuming in <Text bold>{until(p.resumeAt - now)}</Text>
          <Text dimColor>{retry}</Text>
        </Text>
        <Button key="now" label="Resume now" variant="primary" onPress={() => resumeNow($)} />
        <Button key="cancel" label="Cancel" onPress={() => clear($)} />
        <Button key="details" label="Details" onPress={() => $.ui.open({ id: PANE, title: 'no-limit' })} />
      </Box>
    )
  })

  // The dim labels at the right of the prompt footer: the engine's own modes,
  // then this mod's indicator, calm colors only
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const look = await indicator($)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')} · </Text>}
        {look.color === null ? <Text dimColor>{look.glyph}</Text> : <Text color={look.color}>{look.glyph}</Text>}
        <Text dimColor> {look.text}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const p = await read($, pending)
    const windows = await read($, limits)
    const isOn = await read($, enabled)
    const prompt = await read($, message)
    const resumes = await read($, history)
    const now = await $.clock.now()
    const width = clamp(e.props.bodyColumns - 36, 10, 40)
    const { Box, Button, Text } = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? null : $.ui.resolve(e).Input

    const badge =
      p !== null
        ? { text: '(-.-) zZ  WAITING FOR RESET', color: 'yellow' }
        : isOn
          ? { text: '(o.o)  WATCHING', color: 'green' }
          : { text: '(-_-)  OFF', color: 'gray' }
    const shownWindows = windows.filter(w => w.kind === 'five_hour' || w.kind === 'seven_day')

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={badge.color}>
            {badge.text}
          </Text>
          <Text dimColor>auto-resume {isOn ? 'on' : 'off'}</Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>Usage</Text>
          {shownWindows.length === 0 && <Text dimColor>No readings yet: they arrive with the next reply.</Text>}
          {shownWindows.map(w => {
            const [used, free] = bar(w.percentUsed / 100, width)
            const resetsIn = w.resetsAt === undefined ? '' : `resets in ${until(Date.parse(w.resetsAt) - now)}`
            return (
              <Box key={`limit-${w.kind}`} flexDirection="row" gap={1}>
                <Text>{(w.kind === 'five_hour' ? '5-hour' : 'Weekly').padEnd(6)}</Text>
                <Box flexDirection="row">
                  <Text color={heat(w.percentUsed)}>{used}</Text>
                  <Text dimColor>{free}</Text>
                </Box>
                <Text bold color={heat(w.percentUsed)}>
                  {`${Math.round(w.percentUsed)}%`.padStart(4)}
                </Text>
                <Text dimColor>{resetsIn}</Text>
              </Box>
            )
          })}
        </Box>

        {p !== null && (
          <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text color="yellow" bold>
              {label(p.window)} hit. Napping until it resets.
            </Text>
            <Box flexDirection="row" gap={1}>
              <Box flexDirection="row">
                <Text color="yellow">{bar(progress(p, now), width)[0]}</Text>
                <Text dimColor>{bar(progress(p, now), width)[1]}</Text>
              </Box>
              <Text>
                resuming in <Text bold>{until(p.resumeAt - now)}</Text>
              </Text>
            </Box>
            {p.attempts > 0 && (
              <Text dimColor>
                Retry {p.attempts} of {MAX_ATTEMPTS - 1}: the last resume hit the limit again.
              </Text>
            )}
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>Resume prompt{prompt === null ? ' (default)' : ''}</Text>
          <Text dimColor wrap="wrap">
            {prompt ?? DEFAULT_MESSAGE}
          </Text>
          {Input !== null && (
            <Input
              key="message"
              placeholder="Type a new resume prompt, Enter to save (empty: default)"
              submitLabel="Save"
              onSubmit={value => setMessage($, value.trim())}
            />
          )}
        </Box>

        <Box flexDirection="column">
          <Text bold>History</Text>
          {resumes.length === 0 && <Text dimColor>No resumes yet.</Text>}
          {resumes
            .slice()
            .reverse()
            .slice(0, 5)
            .map(r => (
              <Text>
                <Text color="green">✓</Text> {ago(now - r.at).padEnd(8)} after the {label(r.window).toLowerCase()}
                <Text dimColor>, waited {until(r.waitedMs)}</Text>
              </Text>
            ))}
        </Box>

        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {p !== null && <Button key="now" label="Resume now" hotkey="r" variant="primary" onPress={() => resumeNow($)} />}
          {p !== null && <Button key="cancel" label="Cancel" hotkey="c" onPress={() => clear($)} />}
          <Button key="toggle" label={isOn ? 'Turn off' : 'Turn on'} hotkey="o" onPress={() => setEnabled($, !isOn)} />
          <Button key="test" label="Test (1 min)" hotkey="t" onPress={() => pretend($, 1)} />
        </Box>
      </Box>
    )
  })
}

// Seed the session's values from what earlier sessions kept
async function load($: EngineInterface) {
  const kept = {
    enabled: await $.store.get('enabled'),
    message: await $.store.get('message'),
    animate: await $.store.get('animate'),
    history: await $.store.get('history'),
  }
  await update($, enabled, () => kept.enabled !== false)
  await update($, animate, () => kept.animate !== false)
  await update($, message, () => (typeof kept.message === 'string' && kept.message !== '' ? kept.message : null))
  await update($, history, list => (list.length === 0 && Array.isArray(kept.history) ? (kept.history as Resumed[]) : list))

  const { rateLimits } = await $.session.usage()
  if (rateLimits.length > 0) {
    await update($, limits, () => rateLimits.map(w => ({ ...w })))
  }
}

async function arm($: EngineInterface) {
  const now = await $.clock.now()
  const last = await read($, lastResume)
  const attempts = last !== null && now - last.at < RETRY_WINDOW_MS ? last.attempts + 1 : 0

  if (attempts >= MAX_ATTEMPTS) {
    await clear($)
    await update($, hasGivenUp, () => true)
    await refresh($)
    $.ui.toast(`no-limit: still limited after ${MAX_ATTEMPTS - 1} resumes, giving up. /no-limit test 1 to try again.`)
    return
  }

  const reset = await findReset($, now)
  const p: Pending =
    reset !== null
      ? { resumeAt: reset.at + BUFFER_MS, armedAt: now, window: reset.window, attempts }
      : { resumeAt: now + Math.min(FALLBACK_MS * 2 ** attempts, FALLBACK_MAX_MS), armedAt: now, window: 'unknown', attempts }

  await update($, hasGivenUp, () => false)
  await update($, pending, () => p)
  $.ui.toast(`${label(p.window)} hit. Resuming automatically in ${until(p.resumeAt - now)}.`)
  await tick($)
}

async function pretend($: EngineInterface, minutes: number) {
  const now = await $.clock.now()
  await update($, hasGivenUp, () => false)
  await refresh($)
  await update($, pending, () => ({ resumeAt: now + minutes * MINUTE, armedAt: now, window: 'test', attempts: 0 }))
  await tick($)
}

// The latest future reset among the windows that are full; failing that the
// 5-hour window's, since that's the one a busy session usually runs out of
async function findReset($: EngineInterface, now: number) {
  const { rateLimits } = await $.session.usage()
  const future = rateLimits
    .map(w => ({ window: w.kind, at: w.resetsAt === undefined ? NaN : Date.parse(w.resetsAt), percentUsed: w.percentUsed }))
    .filter(w => Number.isFinite(w.at) && w.at > now)
  const full = future.filter(w => w.percentUsed >= 100)
  const candidates = full.length > 0 ? full : future.filter(w => w.window === 'five_hour')

  return candidates.reduce<{ window: string; at: number } | null>(
    (latest, w) => (latest === null || w.at > latest.at ? { window: w.window, at: w.at } : latest),
    null,
  )
}

async function tick($: EngineInterface) {
  const p = await read($, pending)
  if (p !== null && (await $.clock.now()) >= p.resumeAt) {
    await resume($, p)
    return
  }

  await refresh($)
  $.ui.invalidate('ui.render')
}

async function resume($: EngineInterface, p: Pending) {
  const now = await $.clock.now()
  const entry: Resumed = { at: now, window: p.window, waitedMs: now - p.armedAt }
  await update($, pending, () => null)
  await update($, lastResume, () => ({ at: now, attempts: p.attempts }))
  await update($, history, list => [...list, entry].slice(-HISTORY_SIZE))
  await $.store.set('history', await read($, history))
  if (await read($, animate)) {
    const at = await read($, frame)
    await update($, cheerUntil, () => at + CHEER_FRAMES)
  }
  await refresh($)
  $.ui.toast('Usage limit reset: resuming the session')

  const text = (await read($, message)) ?? DEFAULT_MESSAGE
  void $.prompt.submit({ text })
}

async function resumeNow($: EngineInterface) {
  const p = await read($, pending)
  if (p !== null) {
    await resume($, p)
  }
}

async function clear($: EngineInterface) {
  await update($, pending, () => null)
  await refresh($)
}

async function setEnabled($: EngineInterface, isOn: boolean) {
  await $.store.set('enabled', isOn)
  await update($, enabled, () => isOn)
  if (!isOn) {
    await update($, pending, () => null)
  }
  await refresh($)
}

async function setAnimated($: EngineInterface, isOn: boolean) {
  await $.store.set('animate', isOn)
  await update($, animate, () => isOn)
  await refresh($)
}

async function setMessage($: EngineInterface, text: string) {
  if (text === '') {
    await $.store.delete('message')
    await update($, message, () => null)
  } else {
    await $.store.set('message', text)
    await update($, message, () => text)
  }
}

// Start or stop the frame timer; the footer reads the state itself, so a
// still indicator (animation off, auto-resume off, given up) needs no timer
async function refresh($: EngineInterface) {
  const isMoving = (await read($, animate)) && (await read($, enabled)) && !(await read($, hasGivenUp))
  if (isMoving && frames === undefined) {
    frames = $.clock.every(FRAME_MS, () => void update($, frame, n => n + 1))
  } else if (!isMoving && frames !== undefined) {
    frames.cancel()
    frames = undefined
  }
}

async function indicator($: EngineInterface): Promise<{ glyph: string; color: string | null; text: string }> {
  const n = (await read($, animate)) ? await read($, frame) : 0
  const p = await read($, pending)

  if (n < (await read($, cheerUntil))) {
    return { glyph: CHEER[n % CHEER.length] ?? '', color: 'green', text: 'back to work' }
  }
  if (!(await read($, enabled))) {
    return { glyph: '○', color: null, text: 'no-limit off' }
  }
  if (await read($, hasGivenUp)) {
    return { glyph: '(-_-)', color: null, text: 'no-limit stopped retrying · /no-limit test' }
  }
  if (p !== null) {
    const now = await $.clock.now()
    return { glyph: SNOOZE[n % SNOOZE.length] ?? '', color: 'cyan', text: `resets in ${until(p.resumeAt - now)}` }
  }

  const five = (await read($, limits)).find(w => w.kind === 'five_hour')
  const usage = five === undefined ? '' : ` · 5h ${Math.round(five.percentUsed)}%`
  return { glyph: SWEEP[n % SWEEP.length] ?? '', color: 'green', text: `no-limit${usage}` }
}

async function describeStatus($: EngineInterface) {
  const isOn = await read($, enabled)
  const p = await read($, pending)
  const head = isOn ? 'Auto-resume is on.' : 'Auto-resume is off.'
  if (p === null) return `${head} Nothing is pending.\n\n${HELP}`

  const now = await $.clock.now()
  return `${head} ${label(p.window)} hit; resuming in ${until(p.resumeAt - now)}.\n\n${HELP}`
}

function label(window: string) {
  switch (window) {
    case 'five_hour':
      return '5-hour limit'
    case 'seven_day':
      return 'Weekly limit'
    case 'test':
      return 'Test limit'
    default:
      return 'Usage limit'
  }
}

function progress(p: Pending, now: number) {
  const span = p.resumeAt - p.armedAt
  return span <= 0 ? 1 : (now - p.armedAt) / span
}

// A bar's filled and empty halves, drawn in two colors by the caller
function bar(fraction: number, width: number): [string, string] {
  const filled = Math.round(clamp(fraction, 0, 1) * width)
  return ['█'.repeat(filled), '░'.repeat(width - filled)]
}

function heat(percent: number) {
  return percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : 'green'
}

function clamp(n: number, low: number, high: number) {
  return Math.min(high, Math.max(low, n))
}

function until(ms: number) {
  const minutes = Math.max(0, Math.ceil(ms / MINUTE))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60

  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

function ago(ms: number) {
  const minutes = Math.floor(ms / MINUTE)
  return minutes < 1 ? 'just now' : `${until(ms)} ago`
}
