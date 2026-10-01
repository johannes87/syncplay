import type { ClockSync } from './clock.ts'

export type PlayMode = 'precise' | 'basic'

/** How a player's playback error is corrected (see SyncEngine). */
export interface Tuning {
  /** Jump instead of speed-correcting above this error, seconds. */
  hard: number
  /** Ignore errors below this, seconds. */
  dead: number
  /** Maximum speed deviation, e.g. 0.02 = ±2 %. */
  maxRate: number
  /** Smoothing factor for the measured error. */
  alpha: number
  /** Ignore measurements for this long after a jump. */
  settleMs: number
  /** How far ahead to schedule a jump. */
  leadMs: number
}

export interface Player {
  readonly mode: PlayMode
  readonly tuning: Tuning
  /** Song length in seconds. */
  readonly duration: number
  readonly rate: number
  /** Human-readable description for the sync details. */
  readonly detail: string
  onended?: () => void
  onerror?: (error: Error) => void
  load(url: string, signal: AbortSignal, onProgress: (p: number | null) => void): Promise<void>
  /** Optionally get ready to play from song position `pos` (seconds). */
  prepare?(pos: number): Promise<void>
  /** Make song position `pos` audible at reference time `global`. */
  schedule(global: number, pos: number, loop: boolean): void
  /** Which song position is audible, and at what reference time. */
  sample(): { global: number; pos: number } | null
  setRate(rate: number): void
  stop(): void
}

/** Seconds between the audio context rendering a sample and it leaving the speaker. */
export function outputLatency(ctx: AudioContext): number {
  return (ctx.baseLatency || 0) + (ctx.outputLatency || 0)
}

/**
 * When is a given AudioContext time heard, on the performance clock?
 *
 * getOutputTimestamp() answers that, but single readings jitter by about a ms
 * in Safari. The relation between the two clocks changes only very slowly, so
 * we sample it continuously and use the median of the last two seconds.
 * It does jump, by a few ms when the output starts and more when the device
 * changes (e.g. Bluetooth headphones); then we start over from the new level.
 */
class OutputClock {
  readonly #ctx: AudioContext
  /** Recent readings of performanceTime - contextTime, ms. */
  readonly #offsets: number[] = []
  /** Readings that disagree with the median: a jump, if they persist. */
  readonly #jump: number[] = []

  constructor(ctx: AudioContext) {
    this.#ctx = ctx
    setInterval(() => this.#read(), 50)
  }

  #read() {
    const ts = this.#ctx.getOutputTimestamp?.()
    if (!ts?.performanceTime || ts.contextTime == null) return
    const offset = ts.performanceTime - ts.contextTime * 1000
    const median = this.#median()
    if (median != null && Math.abs(offset - median) > 2) {
      this.#jump.push(offset)
      if (this.#jump.length >= 3) this.#offsets.splice(0, Infinity, ...this.#jump.splice(0))
      return
    }
    this.#jump.length = 0
    this.#offsets.push(offset)
    if (this.#offsets.length > 40) this.#offsets.shift()
  }

  #median(): number | null {
    if (!this.#offsets.length) return null
    const sorted = [...this.#offsets].sort((a, b) => a - b)
    return sorted[sorted.length >> 1]
  }

  /**
   * Resolves once the readings agree (the output takes a moment to start, and
   * early readings are a few ms off), or after `maxMs`.
   */
  async settled(maxMs = 2000): Promise<void> {
    const until = performance.now() + maxMs
    while (performance.now() < until) {
      const recent = this.#offsets.slice(-6)
      if (recent.length === 6 && Math.max(...recent) - Math.min(...recent) < 1.5) return
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /** performance.now() - contextTime * 1000 for audio being heard, or null if unknown. */
  offset(): number | null {
    if (!this.#offsets.length) this.#read()
    return this.#median()
  }
}

const outputClocks = new WeakMap<AudioContext, OutputClock>()

/** The OutputClock of `ctx`; creating it early (e.g. on unlock) gives it time to collect readings. */
export function outputClock(ctx: AudioContext): OutputClock {
  let oc = outputClocks.get(ctx)
  if (!oc) {
    oc = new OutputClock(ctx)
    outputClocks.set(ctx, oc)
  }
  return oc
}

/** AudioContext time at which a sample must be scheduled to be heard at reference time `global`. */
export function ctxTimeFor(ctx: AudioContext, clock: ClockSync, global: number): number {
  const offset = outputClock(ctx).offset()
  if (offset != null) return (clock.toPerf(global) - offset) / 1000
  return ctx.currentTime + (global - clock.now()) / 1000 - outputLatency(ctx)
}

/** The AudioContext time being heard right now, and its reference time. */
export function audibleNow(ctx: AudioContext, clock: ClockSync): { ctxTime: number; global: number } {
  const offset = outputClock(ctx).offset()
  if (offset != null) return { ctxTime: (performance.now() - offset) / 1000, global: clock.now() }
  return { ctxTime: ctx.currentTime, global: clock.now() + outputLatency(ctx) * 1000 }
}
