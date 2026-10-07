// Plays a track so that it lines up with a shared timeline (see session.ts).
//
// Two ways to play:
//  - precise (stream-player.ts): decode with Web Audio and schedule
//    sample-accurately against the moment the audio leaves the speaker. Needs
//    the file to be fetchable (same origin, or CORS enabled on its server).
//  - basic: an <audio> element. Works with any playable URL, but the browser
//    only tells us roughly where it is, so expect ~10-30 ms of wobble. Kept on
//    time by a control loop that nudges playbackRate, or jumps when far off.

import { FIREFOX, outputClock, outputLatency, type Player, type Tuning } from '@/lib/audio.ts';
import type { ClockSync } from '@/lib/clock.ts';
import { sessionKey, timelinePosition, type Session } from '@/lib/session.ts';
import { LATENCY_KEY, load, save } from '@/lib/storage.ts';

export type { PlayMode } from '@/lib/audio.ts';

export type EngineState = 'idle' | 'loading' | 'waiting' | 'playing' | 'ended' | 'error';
export interface EngineSnapshot {
    state: EngineState;
    /** Download progress 0..1, or null if unknown. */
    progress: number | null;
    error: string | null;
    mode: Player['mode'] | null;
    /** What exactly is playing, for the sync details. */
    detail: string | null;
    fallbackReason: string | null;
    latencyMs: number;
    duration: number | null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function describeLoadError(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e);
    // Browsers only say "Failed to fetch" (or similar) when CORS blocks a request.
    if (e instanceof TypeError || /fetch|cors|network|load failed/i.test(message)) {
        return 'The file’s server doesn’t allow cross-origin access (CORS).';
    }
    return /[.!?]$/.test(message) ? message : `${message}.`;
}

function silentWavUrl(seconds = 0.5, rate = 8000): string {
    const n = Math.round(seconds * rate);
    const view = new DataView(new ArrayBuffer(44 + n));
    const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    view.setUint32(4, 36 + n, true);
    str(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    str(36, 'data');
    view.setUint32(40, n, true);
    new Uint8Array(view.buffer, 44).fill(128);
    return URL.createObjectURL(new Blob([view.buffer], { type: 'audio/wav' }));
}

class BasicPlayer implements Player {
    readonly mode = 'basic';
    readonly tuning: Tuning = { hard: 0.12, dead: 0.008, maxRate: 0.02, alpha: 0.2, settleMs: 1500, leadMs: 0 };
    readonly detail = 'Media element';
    onended?: () => void;
    onerror?: (error: Error) => void;
    rate = 1;
    #el: HTMLAudioElement;
    #ctx: AudioContext;
    #clock: ClockSync;
    #timer: ReturnType<typeof setTimeout> | undefined;

    constructor(el: HTMLAudioElement, ctx: AudioContext, clock: ClockSync) {
        this.#el = el;
        this.#ctx = ctx;
        this.#clock = clock;
    }

    load(url: string, signal: AbortSignal, onProgress: (p: number | null) => void) {
        const el = this.#el;
        onProgress(null);
        return new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                el.removeEventListener('canplay', ok);
                el.removeEventListener('error', fail);
                signal.removeEventListener('abort', abort);
            };
            const ok = () => {
                cleanup();
                if (Number.isFinite(el.duration)) resolve();
                else reject(new Error('This looks like a live stream, which can’t be synced'));
            };
            const fail = () => {
                cleanup();
                reject(new Error('The browser can’t play this link'));
            };
            const abort = () => {
                cleanup();
                reject(new DOMException('Aborted', 'AbortError'));
            };
            el.addEventListener('canplay', ok);
            el.addEventListener('error', fail);
            signal.addEventListener('abort', abort);
            el.pause();
            el.loop = false;
            el.preload = 'auto';
            el.src = url;
            el.load();
        });
    }

    get duration() {
        return this.#el.duration;
    }

    #latencyMs() {
        return outputLatency(this.#ctx) * 1000;
    }

    schedule(global: number, pos: number, loop: boolean) {
        const el = this.#el;
        clearTimeout(this.#timer);
        el.loop = loop;
        el.playbackRate = this.rate = 1;
        el.onended = () => this.onended?.();
        const wait = global - this.#latencyMs() - this.#clock.now();
        if (wait > 30) {
            el.pause();
            el.currentTime = pos;
            this.#timer = setTimeout(() => void el.play().catch(() => {}), wait);
        } else {
            el.currentTime = Math.max(0, pos - wait / 1000);
            void el.play().catch(() => {});
        }
    }

    sample() {
        const el = this.#el;
        if (el.paused || el.seeking || el.readyState < 3) return null;
        return { global: this.#clock.now() + this.#latencyMs(), pos: el.currentTime };
    }

    setRate(rate: number) {
        if (Math.abs(rate - this.rate) < 0.0005) return;
        this.#el.playbackRate = this.rate = rate;
    }

    stop() {
        clearTimeout(this.#timer);
        this.#el.onended = null;
        this.#el.pause();
    }
}

export class SyncEngine {
    readonly clock: ClockSync;
    ctx: AudioContext | null = null;
    analyser: AnalyserNode | null = null;
    session: Session | null = null;
    /** Latest measured playback error in seconds (> 0: ahead). */
    syncError: number | null = null;
    #master: GainNode | null = null;
    #el: HTMLAudioElement | null = null;
    #silence: string | null = null;
    #player: Player | null = null;
    #abort: AbortController | null = null;
    #armTimer: ReturnType<typeof setTimeout> | undefined;
    #loop: ReturnType<typeof setInterval> | undefined;
    #smoothed: number | null = null;
    #settleUntil = 0;
    #snapshot: EngineSnapshot;
    #listeners = new Set<() => void>();

    constructor(clock: ClockSync) {
        this.clock = clock;
        this.#snapshot = {
            state: 'idle',
            progress: null,
            error: null,
            mode: null,
            detail: null,
            fallbackReason: null,
            latencyMs: Number(load(LATENCY_KEY)) || 0,
            duration: null,
        };
    }

    // For React's useSyncExternalStore.
    subscribe = (listener: () => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    getSnapshot = () => this.#snapshot;

    get sessionKey() {
        return sessionKey(this.session);
    }

    get rate() {
        return this.#player?.rate ?? 1;
    }

    get outputLatencyMs() {
        return this.ctx ? outputLatency(this.ctx) * 1000 : null;
    }

    /**
     * Call synchronously inside a tap/click handler: browsers only allow audio
     * that was started by a user gesture.
     */
    unlock() {
        if (!this.ctx) {
            const AC =
                window.AudioContext ??
                (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            const ctx = (this.ctx = new AC());
            this.#master = ctx.createGain();
            this.analyser = ctx.createAnalyser();
            this.analyser.fftSize = 1024;
            this.analyser.smoothingTimeConstant = 0.5;
            this.#master.connect(this.analyser).connect(ctx.destination);
            outputClock(ctx); // start measuring output timing right away
            this.#el = new Audio();
            this.#el.setAttribute('playsinline', '');
            this.#silence = silentWavUrl();
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState !== 'visible') return;
                void ctx.resume();
                if (this.#snapshot.state === 'playing') this.resync();
            });
        }
        void this.ctx.resume();
        try {
            // iOS: play Web Audio even when the ring/silent switch is on silent.
            const session = (navigator as { audioSession?: { type: string } }).audioSession;
            if (session) session.type = 'playback';
        } catch {
            // not supported
        }
        // iOS unlocks each media element separately, so play it once now. Not in Firefox: it
        // needs no unlocking, and a sound ending while the AudioContext starts can freeze the tab.
        if (!FIREFOX) {
            this.#el!.src = this.#silence!;
            void this.#el!.play().catch(() => {});
        }
    }

    async join(session: Session) {
        this.leave();
        if (!this.ctx) throw new Error('Call unlock() from a user gesture before join()');
        this.session = session;
        const abort = (this.#abort = new AbortController());
        this.#update({ state: 'loading', progress: null, error: null, fallbackReason: null });
        const onProgress = (progress: number | null) => this.#update({ progress });

        // Try precise first, fall back to basic.
        const candidates: (() => Promise<Player>)[] = [
            async () => {
                // Loaded on demand: it brings the media library along.
                const { StreamPlayer } = await import('@/lib/stream-player.ts');
                return new StreamPlayer(this.ctx!, this.#master!, this.clock);
            },
            async () => new BasicPlayer(this.#el!, this.ctx!, this.clock),
        ];
        const reasons: string[] = [];
        let player: Player | null = null;
        for (const create of candidates) {
            const candidate = await create();
            if (abort.signal.aborted) return;
            try {
                await candidate.load(session.url, abort.signal, onProgress);
                await candidate.prepare?.(this.#readyPosition(session, candidate.duration, this.clock.now() + 2000));
                player = candidate;
                break;
            } catch (e) {
                candidate.stop();
                if (abort.signal.aborted) return;
                console.warn(`${candidate.mode} mode unavailable:`, e);
                reasons.push(describeLoadError(e));
            }
        }
        if (!player) {
            this.#update({ state: 'error', error: reasons.at(-1) ?? 'Can’t play this link' });
            return;
        }
        if (player.mode === 'basic') this.#update({ fallbackReason: reasons.join(' ') });

        this.#player = player;
        player.onended = () => {
            this.#stopLoop();
            this.#update({ state: 'ended' });
        };
        player.onerror = (e) => {
            this.#player?.stop();
            this.#stopLoop();
            this.#update({ state: 'error', error: describeLoadError(e) });
        };
        if (player.mode === 'precise') {
            // Keep a silent media element running: keeps iOS in "playback" audio mode.
            this.#el!.loop = true;
            void this.#el!.play().catch(() => {});
        }
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({ title: session.title, artist: 'SyncPlay' });
        }
        // Place the first piece only once the output's timing is known precisely.
        await outputClock(this.ctx).settled();
        if (abort.signal.aborted) return;
        this.#update({ mode: player.mode, detail: player.detail, duration: player.duration });
        this.#arm();
    }

    leave() {
        this.#abort?.abort();
        clearTimeout(this.#armTimer);
        this.#stopLoop();
        this.#player?.stop();
        this.#player = null;
        this.session = null;
        this.syncError = null;
        if (this.#el) {
            this.#el.pause();
            this.#el.loop = false;
        }
        this.#update({
            state: 'idle',
            progress: null,
            error: null,
            mode: null,
            detail: null,
            fallbackReason: null,
            duration: null,
        });
    }

    setLatency(latencyMs: number) {
        save(LATENCY_KEY, String(latencyMs));
        this.#update({ latencyMs });
        if (this.#snapshot.state === 'playing') this.resync();
    }

    /** Jump straight to the right position (instead of gently catching up). */
    resync() {
        const player = this.#player;
        if (!player || !this.session || !this.#loop) return;
        const global = this.clock.now() + player.tuning.leadMs;
        if (global < this.session.start - this.#snapshot.latencyMs) return this.#arm();
        const pos = this.#expected(global);
        if (pos == null) return;
        player.schedule(global, pos, this.session.loop);
        this.#resetControl();
    }

    #expected(global: number) {
        return timelinePosition(this.session!, global, this.#player!.duration, this.#snapshot.latencyMs);
    }

    /** Where to get ready to play from: the position shortly after `global`, or the start position. */
    #readyPosition(session: Session, duration: number, global: number) {
        const at = Math.max(global, session.start - this.#snapshot.latencyMs);
        return timelinePosition(session, at, duration, this.#snapshot.latencyMs) ?? 0;
    }

    #arm() {
        clearTimeout(this.#armTimer);
        const session = this.session!;
        const now = this.clock.now();
        const startAt = session.start - this.#snapshot.latencyMs;
        if (startAt - now > 6000) {
            // Schedule close to the start, so clock drift can't creep in meanwhile.
            this.#update({ state: 'waiting' });
            this.#armTimer = setTimeout(() => this.#arm(), startAt - now - 4000);
            return;
        }
        const global = Math.max(now + 250, startAt);
        const pos = this.#expected(global);
        if (pos == null) return this.#update({ state: 'ended' });
        this.#player!.schedule(global, pos, session.loop);
        this.#resetControl();
        this.#update({ state: now >= session.start ? 'playing' : 'waiting' });
        this.#stopLoop();
        this.#loop = setInterval(() => this.#tick(), 200);
    }

    #resetControl() {
        this.#smoothed = null;
        this.#settleUntil = performance.now() + this.#player!.tuning.settleMs;
    }

    #tick() {
        const player = this.#player!;
        const session = this.session!;
        if (this.#snapshot.state === 'waiting' && this.clock.now() >= session.start) {
            this.#update({ state: 'playing' });
        }
        const m = player.sample();
        if (!m) return;
        const expected = this.#expected(m.global);
        if (expected == null) return;
        const d = player.duration;
        let err = m.pos - expected;
        if (session.loop) err = ((err + 1.5 * d) % d) - d / 2;
        this.syncError = err;
        if (performance.now() < this.#settleUntil) return;

        const t = player.tuning;
        this.#smoothed = this.#smoothed == null ? err : this.#smoothed + t.alpha * (err - this.#smoothed);
        if (Math.abs(this.#smoothed) > t.hard && Math.abs(err) > t.hard) return this.resync();
        // Close the gap over ~2 s: e.g. 5 ms ahead -> play at 0.9975x speed.
        const rate = Math.abs(this.#smoothed) < t.dead ? 1 : 1 - clamp(this.#smoothed / 2, -t.maxRate, t.maxRate);
        player.setRate(rate);
    }

    #stopLoop() {
        clearInterval(this.#loop);
        this.#loop = undefined;
    }

    #update(patch: Partial<EngineSnapshot>) {
        this.#snapshot = { ...this.#snapshot, ...patch };
        for (const l of this.#listeners) l();
    }
}
