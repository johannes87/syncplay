// Plays a track so that it lines up with a shared timeline (see session.ts).
//
// Two ways to play:
//  - precise: download + decode with Web Audio and schedule sample-accurately
//    against the moment the audio actually leaves the speaker. Needs the file
//    to be fetchable (same origin, or CORS enabled on its server).
//  - basic: an <audio> element. Works with any playable URL, but the browser
//    only tells us roughly where it is, so expect ~10-30 ms of wobble.
//
// Both are kept on time by a control loop that measures the real playback
// error and corrects it with tiny playbackRate changes (inaudible), or with a
// jump when the error is too large.

import type { ClockSync } from './clock.ts'
import { type Session, sessionKey, timelinePosition } from './session.ts'
import { LATENCY_KEY, load, save } from './storage.ts'

const MAX_PRECISE_BYTES = 40 * 1024 * 1024 // decoded audio needs ~10x this in RAM

export type EngineState = 'idle' | 'loading' | 'waiting' | 'playing' | 'ended' | 'error'
export type PlayMode = 'precise' | 'basic'

export interface EngineSnapshot {
  state: EngineState
  /** Download progress 0..1, or null if unknown. */
  progress: number | null
  error: string | null
  mode: PlayMode | null
  fallbackReason: string | null
  latencyMs: number
  duration: number | null
}

interface Tuning {
  /** Jump instead of speed-correcting above this error, seconds. */
  hard: number
  /** Ignore errors below this, seconds. */
  dead: number
  /** Maximum speed deviation, e.g. 0.004 = ±0.4 %. */
  maxRate: number
  /** Smoothing factor for the measured error. */
  alpha: number
  /** Ignore measurements for this long after a jump. */
  settleMs: number
  /** How far ahead to schedule a jump. */
  leadMs: number
}

interface Player {
  readonly mode: PlayMode
  readonly tuning: Tuning
  readonly duration: number
  readonly rate: number
  onended?: () => void
  load(url: string, signal: AbortSignal, onProgress: (p: number | null) => void): Promise<void>
  /** Make song position `pos` audible at reference time `global`. */
  schedule(global: number, pos: number, loop: boolean): void
  /** Which song position is audible, and at what reference time. */
  sample(): { global: number; pos: number } | null
  setRate(rate: number): void
  stop(): void
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

function outputLatency(ctx: AudioContext): number {
  return (ctx.baseLatency || 0) + (ctx.outputLatency || 0)
}

function silentWavUrl(seconds = 0.5, rate = 8000): string {
  const n = Math.round(seconds * rate)
  const view = new DataView(new ArrayBuffer(44 + n))
  const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  view.setUint32(4, 36 + n, true)
  str(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  str(36, 'data')
  view.setUint32(40, n, true)
  new Uint8Array(view.buffer, 44).fill(128)
  return URL.createObjectURL(new Blob([view.buffer], { type: 'audio/wav' }))
}

class PrecisePlayer implements Player {
  readonly mode = 'precise'
  readonly tuning: Tuning = { hard: 0.03, dead: 0.0015, maxRate: 0.004, alpha: 0.35, settleMs: 400, leadMs: 150 }
  onended?: () => void
  #ctx: AudioContext
  #out: AudioNode
  #clock: ClockSync
  #buffer: AudioBuffer | null = null
  #src: AudioBufferSourceNode | null = null
  #gain: GainNode | null = null
  #anchor: { t: number; pos: number; rate: number } | null = null

  constructor(ctx: AudioContext, out: AudioNode, clock: ClockSync) {
    this.#ctx = ctx
    this.#out = out
    this.#clock = clock
  }

  async load(url: string, signal: AbortSignal, onProgress: (p: number | null) => void) {
    const res = await fetch(url, { signal, credentials: 'omit' })
    if (!res.ok) throw new Error(`The file’s server answered ${res.status}`)
    const total = Number(res.headers.get('content-length')) || 0
    if (total > MAX_PRECISE_BYTES) throw new Error('The file is too large to decode in memory')

    let data: ArrayBuffer
    if (!res.body) {
      data = await res.arrayBuffer()
    } else {
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        if (received > MAX_PRECISE_BYTES) {
          void reader.cancel()
          throw new Error('The file is too large to decode in memory')
        }
        onProgress(total ? Math.min(received / total, 0.99) : null)
      }
      const bytes = new Uint8Array(received)
      let at = 0
      for (const c of chunks) {
        bytes.set(c, at)
        at += c.length
      }
      data = bytes.buffer
    }
    onProgress(1)
    this.#buffer = await this.#ctx.decodeAudioData(data)
  }

  get duration() {
    return this.#buffer?.duration ?? 0
  }

  get rate() {
    return this.#anchor?.rate ?? 1
  }

  /** AudioContext time at which a sample must be scheduled to be heard at reference time `global`. */
  #ctxTime(global: number): number {
    const ts = this.#ctx.getOutputTimestamp?.()
    if (ts?.performanceTime && ts.contextTime != null) {
      return ts.contextTime + (this.#clock.toPerf(global) - ts.performanceTime) / 1000
    }
    return this.#ctx.currentTime + (global - this.#clock.now()) / 1000 - outputLatency(this.#ctx)
  }

  schedule(global: number, pos: number, loop: boolean) {
    const ctx = this.#ctx
    let when = this.#ctxTime(global)
    const earliest = ctx.currentTime + 0.02
    if (when < earliest) {
      pos += earliest - when
      when = earliest
    }
    const fade = 0.008
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = this.#buffer
    src.loop = loop
    src.connect(gain).connect(this.#out)
    if (this.#src && this.#gain) {
      // Crossfade from the old source to avoid a click when re-syncing.
      this.#gain.gain.setValueAtTime(1, when)
      this.#gain.gain.linearRampToValueAtTime(0, when + fade)
      this.#src.onended = null
      this.#src.stop(when + fade + 0.01)
      gain.gain.setValueAtTime(0, when)
      gain.gain.linearRampToValueAtTime(1, when + fade)
    }
    src.onended = () => {
      if (this.#src === src) this.onended?.()
    }
    src.start(when, loop ? pos % this.duration : Math.min(pos, this.duration))
    this.#src = src
    this.#gain = gain
    this.#anchor = { t: when, pos, rate: 1 }
  }

  #unwrapped(c: number): number {
    const a = this.#anchor!
    return a.pos + (c - a.t) * a.rate
  }

  sample() {
    if (!this.#anchor || !this.#src) return null
    const ts = this.#ctx.getOutputTimestamp?.()
    let c: number
    let global: number
    if (ts?.performanceTime && ts.contextTime != null) {
      c = ts.contextTime
      global = this.#clock.fromPerf(ts.performanceTime)
    } else {
      c = this.#ctx.currentTime
      global = this.#clock.now() + outputLatency(this.#ctx) * 1000
    }
    if (c < this.#anchor.t + 0.05) return null
    let pos = this.#unwrapped(c)
    if (this.#src.loop) pos %= this.duration
    return { global, pos }
  }

  setRate(rate: number) {
    const c = this.#ctx.currentTime
    if (!this.#anchor || !this.#src || c < this.#anchor.t) return
    if (Math.abs(rate - this.#anchor.rate) < 0.00005) return
    this.#anchor = { t: c, pos: this.#unwrapped(c), rate }
    this.#src.playbackRate.setValueAtTime(rate, c)
  }

  stop() {
    if (this.#src) {
      this.#src.onended = null
      try {
        this.#src.stop()
      } catch {
        // never started
      }
      this.#src.disconnect()
    }
    this.#src = null
    this.#anchor = null
  }
}

class BasicPlayer implements Player {
  readonly mode = 'basic'
  readonly tuning: Tuning = { hard: 0.12, dead: 0.008, maxRate: 0.02, alpha: 0.2, settleMs: 1500, leadMs: 0 }
  onended?: () => void
  rate = 1
  #el: HTMLAudioElement
  #ctx: AudioContext
  #clock: ClockSync
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(el: HTMLAudioElement, ctx: AudioContext, clock: ClockSync) {
    this.#el = el
    this.#ctx = ctx
    this.#clock = clock
  }

  load(url: string, signal: AbortSignal, onProgress: (p: number | null) => void) {
    const el = this.#el
    onProgress(null)
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        el.removeEventListener('canplay', ok)
        el.removeEventListener('error', fail)
        signal.removeEventListener('abort', abort)
      }
      const ok = () => {
        cleanup()
        if (Number.isFinite(el.duration)) resolve()
        else reject(new Error('This looks like a live stream, which can’t be synced'))
      }
      const fail = () => {
        cleanup()
        reject(new Error('The browser can’t play this link'))
      }
      const abort = () => {
        cleanup()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      el.addEventListener('canplay', ok)
      el.addEventListener('error', fail)
      signal.addEventListener('abort', abort)
      el.pause()
      el.loop = false
      el.preload = 'auto'
      el.src = url
      el.load()
    })
  }

  get duration() {
    return this.#el.duration
  }

  #latencyMs() {
    return outputLatency(this.#ctx) * 1000
  }

  schedule(global: number, pos: number, loop: boolean) {
    const el = this.#el
    clearTimeout(this.#timer)
    el.loop = loop
    el.playbackRate = this.rate = 1
    el.onended = () => this.onended?.()
    const wait = global - this.#latencyMs() - this.#clock.now()
    if (wait > 30) {
      el.pause()
      el.currentTime = pos
      this.#timer = setTimeout(() => void el.play().catch(() => {}), wait)
    } else {
      el.currentTime = Math.max(0, pos - wait / 1000)
      void el.play().catch(() => {})
    }
  }

  sample() {
    const el = this.#el
    if (el.paused || el.seeking || el.readyState < 3) return null
    return { global: this.#clock.now() + this.#latencyMs(), pos: el.currentTime }
  }

  setRate(rate: number) {
    if (Math.abs(rate - this.rate) < 0.0005) return
    this.#el.playbackRate = this.rate = rate
  }

  stop() {
    clearTimeout(this.#timer)
    this.#el.onended = null
    this.#el.pause()
  }
}

export class SyncEngine {
  readonly clock: ClockSync
  ctx: AudioContext | null = null
  analyser: AnalyserNode | null = null
  session: Session | null = null
  /** Latest measured playback error in seconds (> 0: ahead). */
  syncError: number | null = null
  #master: GainNode | null = null
  #el: HTMLAudioElement | null = null
  #silence: string | null = null
  #player: Player | null = null
  #abort: AbortController | null = null
  #armTimer: ReturnType<typeof setTimeout> | undefined
  #loop: ReturnType<typeof setInterval> | undefined
  #smoothed: number | null = null
  #settleUntil = 0
  #snapshot: EngineSnapshot
  #listeners = new Set<() => void>()

  constructor(clock: ClockSync) {
    this.clock = clock
    this.#snapshot = {
      state: 'idle',
      progress: null,
      error: null,
      mode: null,
      fallbackReason: null,
      latencyMs: Number(load(LATENCY_KEY)) || 0,
      duration: null,
    }
  }

  // For React's useSyncExternalStore.
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  get sessionKey() {
    return sessionKey(this.session)
  }

  get rate() {
    return this.#player?.rate ?? 1
  }

  get outputLatencyMs() {
    return this.ctx ? outputLatency(this.ctx) * 1000 : null
  }

  /**
   * Call synchronously inside a tap/click handler: browsers only allow audio
   * that was started by a user gesture.
   */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = (this.ctx = new AC())
      this.#master = ctx.createGain()
      this.analyser = ctx.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.smoothingTimeConstant = 0.5
      this.#master.connect(this.analyser).connect(ctx.destination)
      this.#el = new Audio()
      this.#el.setAttribute('playsinline', '')
      this.#silence = silentWavUrl()
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        void ctx.resume()
        if (this.#snapshot.state === 'playing') this.resync()
      })
    }
    void this.ctx.resume()
    try {
      // iOS: play Web Audio even when the ring/silent switch is on silent.
      const session = (navigator as { audioSession?: { type: string } }).audioSession
      if (session) session.type = 'playback'
    } catch {
      // not supported
    }
    // iOS unlocks each media element separately, so play it once now.
    this.#el!.src = this.#silence!
    void this.#el!.play().catch(() => {})
  }

  async join(session: Session) {
    this.leave()
    if (!this.ctx) throw new Error('Call unlock() from a user gesture before join()')
    this.session = session
    const abort = (this.#abort = new AbortController())
    this.#update({ state: 'loading', progress: null, error: null, fallbackReason: null })
    const onProgress = (progress: number | null) => this.#update({ progress })

    let player: Player = new PrecisePlayer(this.ctx, this.#master!, this.clock)
    try {
      await player.load(session.url, abort.signal, onProgress)
    } catch (e) {
      if (abort.signal.aborted) return
      console.warn('Precise mode unavailable, falling back to basic:', e)
      const fallbackReason =
        e instanceof TypeError
          ? 'The file’s server doesn’t allow cross-origin access (CORS)'
          : (e as Error).message
      this.#update({ fallbackReason })
      player = new BasicPlayer(this.#el!, this.ctx, this.clock)
      try {
        await player.load(session.url, abort.signal, onProgress)
      } catch (e2) {
        if (abort.signal.aborted) return
        this.#update({ state: 'error', error: (e2 as Error).message })
        return
      }
    }

    this.#player = player
    player.onended = () => {
      this.#stopLoop()
      this.#update({ state: 'ended' })
    }
    if (player.mode === 'precise') {
      // Keep a silent media element running: keeps iOS in "playback" audio mode.
      this.#el!.loop = true
      void this.#el!.play().catch(() => {})
    }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: session.title, artist: 'SyncPlay' })
    }
    this.#update({ mode: player.mode, duration: player.duration })
    this.#arm()
  }

  leave() {
    this.#abort?.abort()
    clearTimeout(this.#armTimer)
    this.#stopLoop()
    this.#player?.stop()
    this.#player = null
    this.session = null
    this.syncError = null
    if (this.#el) {
      this.#el.pause()
      this.#el.loop = false
    }
    this.#update({ state: 'idle', progress: null, error: null, mode: null, fallbackReason: null, duration: null })
  }

  setLatency(latencyMs: number) {
    save(LATENCY_KEY, String(latencyMs))
    this.#update({ latencyMs })
    if (this.#snapshot.state === 'playing') this.resync()
  }

  /** Jump straight to the right position (instead of gently catching up). */
  resync() {
    const player = this.#player
    if (!player || !this.session || !this.#loop) return
    const global = this.clock.now() + player.tuning.leadMs
    if (global < this.session.start - this.#snapshot.latencyMs) return this.#arm()
    const pos = this.#expected(global)
    if (pos == null) return
    player.schedule(global, pos, this.session.loop)
    this.#resetControl()
  }

  #expected(global: number) {
    return timelinePosition(this.session!, global, this.#player!.duration, this.#snapshot.latencyMs)
  }

  #arm() {
    clearTimeout(this.#armTimer)
    const session = this.session!
    const now = this.clock.now()
    const startAt = session.start - this.#snapshot.latencyMs
    if (startAt - now > 6000) {
      // Schedule close to the start, so clock drift can't creep in meanwhile.
      this.#update({ state: 'waiting' })
      this.#armTimer = setTimeout(() => this.#arm(), startAt - now - 4000)
      return
    }
    const global = Math.max(now + 250, startAt)
    const pos = this.#expected(global)
    if (pos == null) return this.#update({ state: 'ended' })
    this.#player!.schedule(global, pos, session.loop)
    this.#resetControl()
    this.#update({ state: now >= session.start ? 'playing' : 'waiting' })
    this.#stopLoop()
    this.#loop = setInterval(() => this.#tick(), 200)
  }

  #resetControl() {
    this.#smoothed = null
    this.#settleUntil = performance.now() + this.#player!.tuning.settleMs
  }

  #tick() {
    const player = this.#player!
    const session = this.session!
    if (this.#snapshot.state === 'waiting' && this.clock.now() >= session.start) {
      this.#update({ state: 'playing' })
    }
    const m = player.sample()
    if (!m) return
    const expected = this.#expected(m.global)
    if (expected == null) return
    const d = player.duration
    let err = m.pos - expected
    if (session.loop) err = ((err + 1.5 * d) % d) - d / 2
    this.syncError = err
    if (performance.now() < this.#settleUntil) return

    const t = player.tuning
    this.#smoothed = this.#smoothed == null ? err : this.#smoothed + t.alpha * (err - this.#smoothed)
    if (Math.abs(this.#smoothed) > t.hard && Math.abs(err) > t.hard) return this.resync()
    // Close the gap over ~2 s: e.g. 5 ms ahead -> play at 0.9975x speed.
    const rate = Math.abs(this.#smoothed) < t.dead ? 1 : 1 - clamp(this.#smoothed / 2, -t.maxRate, t.maxRate)
    player.setRate(rate)
  }

  #stopLoop() {
    clearInterval(this.#loop)
    this.#loop = undefined
  }

  #update(patch: Partial<EngineSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch }
    for (const l of this.#listeners) l()
  }
}
