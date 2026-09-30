// Plays a track so that it lines up with a shared timeline.
//
// A session is { url, start, pos, loop }: at reference time `start` (ms since
// the epoch, see clock.js) the track is at `pos` seconds. Every device derives
// "where should the song be right now" from that alone, so late joiners
// simply jump in at the right spot.
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

const MAX_PRECISE_BYTES = 40 * 1024 * 1024; // decoded audio needs ~10x this in RAM
const LATENCY_KEY = 'syncplay.latencyMs';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function outputLatency(ctx) {
    return (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
}

function silentWavUrl(seconds = 0.5, rate = 8000) {
    const n = Math.round(seconds * rate);
    const view = new DataView(new ArrayBuffer(44 + n));
    const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
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

class PrecisePlayer {
    mode = 'precise';
    tuning = { hard: 0.03, dead: 0.0015, maxRate: 0.004, alpha: 0.35, settleMs: 400, leadMs: 150 };

    constructor(engine) {
        this.ctx = engine.ctx;
        this.out = engine.master;
    }

    async load(url, signal, onProgress) {
        const res = await fetch(url, { signal, credentials: 'omit' });
        if (!res.ok) throw new Error(`The file's server answered ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        if (total > MAX_PRECISE_BYTES) throw new Error('The file is too large to decode in memory');

        let data;
        if (!res.body) {
            data = await res.arrayBuffer();
        } else {
            const reader = res.body.getReader();
            const chunks = [];
            let received = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                if (received > MAX_PRECISE_BYTES) {
                    reader.cancel();
                    throw new Error('The file is too large to decode in memory');
                }
                onProgress(total ? Math.min(received / total, 0.99) : null);
            }
            data = new Uint8Array(received);
            let at = 0;
            for (const c of chunks) {
                data.set(c, at);
                at += c.length;
            }
            data = data.buffer;
        }
        onProgress(1);
        this.buffer = await this.ctx.decodeAudioData(data);
    }

    get duration() {
        return this.buffer.duration;
    }

    // AudioContext time at which a sample must be scheduled to be heard at
    // reference time `global`.
    #ctxTime(global, clock) {
        const ts = this.ctx.getOutputTimestamp?.();
        if (ts && ts.performanceTime > 0) {
            return ts.contextTime + (clock.toPerf(global) - ts.performanceTime) / 1000;
        }
        return this.ctx.currentTime + (global - clock.now()) / 1000 - outputLatency(this.ctx);
    }

    schedule(global, pos, loop, clock) {
        const ctx = this.ctx;
        let when = this.#ctxTime(global, clock);
        const earliest = ctx.currentTime + 0.02;
        if (when < earliest) {
            pos += earliest - when;
            when = earliest;
        }
        const fade = 0.008;
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        src.buffer = this.buffer;
        src.loop = loop;
        src.connect(gain).connect(this.out);
        if (this.src) {
            // Crossfade from the old source to avoid a click when re-syncing.
            this.gain.gain.setValueAtTime(1, when);
            this.gain.gain.linearRampToValueAtTime(0, when + fade);
            this.src.onended = null;
            this.src.stop(when + fade + 0.01);
            gain.gain.setValueAtTime(0, when);
            gain.gain.linearRampToValueAtTime(1, when + fade);
        }
        src.onended = () => this.src === src && this.onended?.();
        src.start(when, loop ? pos % this.duration : Math.min(pos, this.duration));
        this.src = src;
        this.gain = gain;
        this.anchor = { t: when, pos, rate: 1 };
    }

    #unwrapped(c) {
        const a = this.anchor;
        return a.pos + (c - a.t) * a.rate;
    }

    // Which song position is coming out of the speaker, and at what reference time.
    sample(clock) {
        if (!this.anchor) return null;
        const ts = this.ctx.getOutputTimestamp?.();
        let c, global;
        if (ts && ts.performanceTime > 0) {
            c = ts.contextTime;
            global = clock.fromPerf(ts.performanceTime);
        } else {
            c = this.ctx.currentTime;
            global = clock.now() + outputLatency(this.ctx) * 1000;
        }
        if (c < this.anchor.t + 0.05) return null;
        let pos = this.#unwrapped(c);
        if (this.src.loop) pos %= this.duration;
        return { global, pos };
    }

    setRate(rate) {
        const c = this.ctx.currentTime;
        if (!this.anchor || c < this.anchor.t || Math.abs(rate - this.anchor.rate) < 0.00005) return;
        this.anchor = { t: c, pos: this.#unwrapped(c), rate };
        this.src.playbackRate.setValueAtTime(rate, c);
    }

    get rate() {
        return this.anchor?.rate ?? 1;
    }

    stop() {
        if (this.src) {
            this.src.onended = null;
            try {
                this.src.stop();
            } catch {}
            this.src.disconnect();
        }
        this.src = this.anchor = null;
    }
}

class BasicPlayer {
    mode = 'basic';
    tuning = { hard: 0.12, dead: 0.008, maxRate: 0.02, alpha: 0.2, settleMs: 1500, leadMs: 0 };

    constructor(engine) {
        this.el = engine.el;
        this.ctx = engine.ctx;
        this.rate = 1;
    }

    load(url, signal, onProgress) {
        const el = this.el;
        onProgress(null);
        return new Promise((resolve, reject) => {
            const done = (fn, arg) => {
                el.removeEventListener('canplaythrough', ok);
                el.removeEventListener('canplay', ok);
                el.removeEventListener('error', fail);
                fn(arg);
            };
            const ok = () =>
                Number.isFinite(el.duration)
                    ? done(resolve)
                    : done(reject, new Error('This looks like a live stream, which can’t be synced'));
            const fail = () => done(reject, new Error('The browser can’t play this link'));
            el.addEventListener('canplaythrough', ok);
            el.addEventListener('canplay', ok);
            el.addEventListener('error', fail);
            signal.addEventListener('abort', () => done(reject, new DOMException('Aborted', 'AbortError')));
            el.pause();
            el.loop = false;
            el.preload = 'auto';
            el.src = url;
            el.load();
        });
    }

    get duration() {
        return this.el.duration;
    }

    #latencyMs() {
        return outputLatency(this.ctx) * 1000;
    }

    schedule(global, pos, loop, clock) {
        const el = this.el;
        clearTimeout(this.timer);
        el.loop = loop;
        el.playbackRate = this.rate = 1;
        el.onended = () => this.onended?.();
        const wait = global - this.#latencyMs() - clock.now();
        if (wait > 30) {
            el.pause();
            el.currentTime = pos;
            this.timer = setTimeout(() => el.play().catch(() => {}), wait);
        } else {
            el.currentTime = Math.max(0, pos - wait / 1000);
            el.play().catch(() => {});
        }
    }

    sample(clock) {
        const el = this.el;
        if (el.paused || el.seeking || el.readyState < 3) return null;
        return { global: clock.now() + this.#latencyMs(), pos: el.currentTime };
    }

    setRate(rate) {
        if (Math.abs(rate - this.rate) < 0.0005) return;
        this.el.playbackRate = this.rate = rate;
    }

    stop() {
        clearTimeout(this.timer);
        this.el.onended = null;
        this.el.pause();
    }
}

class SyncEngine extends EventTarget {
    constructor(clock) {
        super();
        this.clock = clock;
        this.state = 'idle'; // idle | loading | waiting | playing | ended | error
        this.progress = null;
        this.error = null;
        this.player = null;
        this.fallbackReason = null;
        this.syncError = null; // latest measured playback error, seconds
        this.latencyMs = Number(localStorage.getItem(LATENCY_KEY)) || 0;
    }

    // Call synchronously inside a tap/click handler: browsers only allow audio
    // that was started by a user gesture.
    unlock() {
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AC();
            this.master = this.ctx.createGain();
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 1024;
            this.analyser.smoothingTimeConstant = 0.5;
            this.master.connect(this.analyser).connect(this.ctx.destination);
            this.el = new Audio();
            this.el.playsInline = true;
            this.silence = silentWavUrl();
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState !== 'visible') return;
                this.ctx.resume();
                if (this.state === 'playing') this.resync();
            });
        }
        this.ctx.resume();
        try {
            // iOS: play Web Audio even when the ring/silent switch is on silent.
            if (navigator.audioSession) navigator.audioSession.type = 'playback';
        } catch {}
        // iOS unlocks each media element separately, so play it once now.
        this.el.src = this.silence;
        this.el.play().catch(() => {});
    }

    async join(session) {
        this.leave();
        this.session = session;
        this.error = null;
        this.fallbackReason = null;
        const abort = (this.abort = new AbortController());
        this.#setState('loading');
        const onProgress = (p) => {
            this.progress = p;
            this.#emit();
        };
        let player;
        try {
            player = new PrecisePlayer(this);
            await player.load(session.url, abort.signal, onProgress);
        } catch (e) {
            if (abort.signal.aborted) return;
            console.warn('Precise mode unavailable, falling back to basic:', e);
            this.fallbackReason =
                e instanceof TypeError
                    ? 'The file’s server doesn’t allow cross-origin access (CORS)'
                    : e.message;
            try {
                player = new BasicPlayer(this);
                await player.load(session.url, abort.signal, onProgress);
            } catch (e2) {
                if (abort.signal.aborted) return;
                this.error = e2.message;
                this.#setState('error');
                return;
            }
        }
        this.player = player;
        player.onended = () => {
            this.#stopLoop();
            this.#setState('ended');
        };
        if (player.mode === 'precise') {
            // Keep a silent media element running: keeps iOS in "playback" audio mode.
            this.el.loop = true;
            this.el.play().catch(() => {});
        }
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({ title: session.title, artist: 'SyncPlay' });
        }
        this.#arm();
    }

    get duration() {
        return this.player?.duration ?? null;
    }

    // Song position that should be audible at reference time `global`, or null if over.
    expected(global) {
        const s = this.session;
        const d = this.duration;
        const p = (global + this.latencyMs - s.start) / 1000 + s.pos;
        if (s.loop) return ((p % d) + d) % d;
        return p >= d ? null : p;
    }

    #arm() {
        clearTimeout(this.armTimer);
        const now = this.clock.now();
        const startAt = this.session.start - this.latencyMs;
        if (startAt - now > 6000) {
            // Schedule close to the start, so clock drift can't creep in meanwhile.
            this.#setState('waiting');
            this.armTimer = setTimeout(() => this.#arm(), startAt - now - 4000);
            return;
        }
        const global = Math.max(now + 250, startAt);
        const pos = this.expected(global);
        if (pos == null) return this.#setState('ended');
        this.player.schedule(global, pos, this.session.loop, this.clock);
        this.#resetControl();
        this.#setState(now >= this.session.start ? 'playing' : 'waiting');
        this.#stopLoop();
        this.loop = setInterval(() => this.#tick(), 200);
    }

    resync() {
        if (!this.player || !this.loop) return;
        const global = this.clock.now() + this.player.tuning.leadMs;
        if (global < this.session.start - this.latencyMs) return this.#arm();
        const pos = this.expected(global);
        if (pos == null) return;
        this.player.schedule(global, pos, this.session.loop, this.clock);
        this.#resetControl();
    }

    #resetControl() {
        this.smoothed = null;
        this.settleUntil = performance.now() + this.player.tuning.settleMs;
    }

    #tick() {
        if (this.state === 'waiting' && this.clock.now() >= this.session.start) this.#setState('playing');
        const m = this.player.sample(this.clock);
        if (!m) return;
        const expected = this.expected(m.global);
        if (expected == null) return;
        const d = this.duration;
        let err = m.pos - expected; // > 0: we're ahead
        if (this.session.loop) err = ((err + 1.5 * d) % d) - d / 2;
        this.syncError = err;
        if (performance.now() < this.settleUntil) return;

        const t = this.player.tuning;
        this.smoothed = this.smoothed == null ? err : this.smoothed + t.alpha * (err - this.smoothed);
        if (Math.abs(this.smoothed) > t.hard && Math.abs(err) > t.hard) return this.resync();
        // Close the gap over ~2 s: e.g. 5 ms ahead -> play at 0.9975x speed.
        const rate =
            Math.abs(this.smoothed) < t.dead ? 1 : 1 - clamp(this.smoothed / 2, -t.maxRate, t.maxRate);
        this.player.setRate(rate);
    }

    setLatency(ms) {
        this.latencyMs = ms;
        localStorage.setItem(LATENCY_KEY, String(ms));
        if (this.state === 'playing') this.resync();
        this.#emit();
    }

    leave() {
        this.abort?.abort();
        clearTimeout(this.armTimer);
        this.#stopLoop();
        this.player?.stop();
        this.player = null;
        this.syncError = null;
        if (this.el) {
            this.el.pause();
            this.el.loop = false;
        }
        this.#setState('idle');
    }

    #stopLoop() {
        clearInterval(this.loop);
        this.loop = null;
    }

    #setState(state) {
        this.state = state;
        this.progress = state === 'loading' ? this.progress : null;
        this.#emit();
    }

    #emit() {
        this.dispatchEvent(new Event('change'));
    }
}
