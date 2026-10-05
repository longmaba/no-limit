/** A resume waiting for the usage limit to reset. */
export type Pending = {
  /** When to resume, in `$.clock.now()` milliseconds. */
  resumeAt: number
  /** When the limit was hit, so the wait can be drawn as progress. */
  armedAt: number
  /** Which window stopped the session (`five_hour`, `seven_day`), or `unknown`. */
  window: string
  /** How many resumes in a row have hit the limit again. */
  attempts: number
}

/** The last resume this mod sent, so a limit hit right after it counts as a retry. */
export type LastResume = { at: number; attempts: number }

/** One resume, for the dashboard's history. */
export type Resumed = { at: number; window: string; waitedMs: number }

/** One rate-limit window as the last API response reported it. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'no-limit': {
      pending: Pending | null
      lastResume: LastResume | null
      history: Resumed[]
      limits: Limit[]
      enabled: boolean
      message: string | null
      animate: boolean
      /** The footer indicator's animation frame, counted up while it moves. */
      frame: number
      /** The frame the after-resume cheer lasts until. */
      cheerUntil: number
      hasGivenUp: boolean
    }
  }
}
