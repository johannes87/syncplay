// Page-side helpers for the end-to-end tests, served by the Vite dev server at
// /e2e/harness.html. They drive the real clock and engine; everything that would
// reach the speakers is muted. Not part of the app.

import { ALL_FORMATS, AudioBufferSink, Input, UrlSource } from 'mediabunny';
import { outputOffsetReading } from '@/lib/audio.ts';
import { registerDecoders } from '@/lib/decoders.ts';
import { clock, engine } from '@/lib/instances.ts';
import { makeSession } from '@/lib/session.ts';
import { PREROLL, StreamPlayer } from '@/lib/stream-player.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toBase64(samples: Float32Array): string {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

let clockStarted = false;

/** Starts the clock like the app does (for the clock tests). */
async function synced() {
    if (!clockStarted) {
        clockStarted = true;
        clock.start();
    }
    for (;;) {
        const { state } = clock.getSnapshot();
        if (state === 'synced') return;
        if (state === 'failed') throw new Error('Clock sync failed');
        await sleep(50);
    }
}

/**
 * One complete sync, and no re-syncing afterwards: the audio tests measure playback
 * against the app's clock, so it mustn't move under them (clock.e2e.ts tests the clock).
 */
async function syncedAndFrozen() {
    await clock.burst(10);
    if (clock.getSnapshot().state !== 'synced') throw new Error('Clock sync failed');
}

// Records what the engine outputs: 8192-sample blocks with the AudioContext time of their first sample.
const TAP = `class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(8192); this.n = 0; this.t = 0 }
  process(inputs) {
    const ch = inputs[0][0]
    if (!ch) return true
    if (this.n === 0) this.t = currentTime
    this.buf.set(ch, this.n)
    this.n += ch.length
    if (this.n >= this.buf.length) { this.port.postMessage({ t: this.t, data: this.buf.slice() }); this.n = 0 }
    return true
  }
}
registerProcessor('tap', Tap)`;

let tap: AudioWorkletNode | null = null;

/** Unlocks audio with the output muted and a recording tap attached. */
async function unlockMuted() {
    engine.unlock();
    const ctx = engine.ctx!;
    if (!tap) {
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' })));
        tap = new AudioWorkletNode(ctx, 'tap');
        const mute = ctx.createGain();
        mute.gain.value = 0;
        engine.analyser!.disconnect();
        engine.analyser!.connect(tap).connect(mute).connect(ctx.destination);
    }
    engine.setLatency(0);
    return { ctx, tap };
}

export interface PlayOptions {
    url: string;
    /** Song position at the start, seconds. */
    pos: number;
    /** Start time relative to now, ms (negative: started in the past). */
    startInMs: number;
    loop: boolean;
    /** Nudge this device by `nudgeMs` after this many ms. */
    nudgeAfterMs?: number;
    nudgeMs?: number;
    captureMs: number;
}

/** Plays a session and records the engine's output. */
async function play(o: PlayOptions) {
    await syncedAndFrozen();
    const { ctx, tap } = await unlockMuted();
    const blocks: { t: number; data: Float32Array }[] = [];
    tap.port.onmessage = (e) => blocks.push(e.data);
    // Relation between AudioContext time and reference time (median: single readings jitter).
    const relation: number[] = [];
    const timer = setInterval(() => {
        const offset = outputOffsetReading(ctx);
        if (offset != null) relation.push(clock.fromPerf(offset));
    }, 100);
    const states: { state: string; at: number }[] = [];
    const unsubscribe = engine.subscribe(() => {
        const { state } = engine.getSnapshot();
        if (states.at(-1)?.state !== state) states.push({ state, at: clock.now() });
    });

    const session = makeSession({ url: o.url, start: Math.round(clock.now() + o.startInMs), pos: o.pos, loop: o.loop });
    void engine.join(session);
    let nudgeAt: number | null = null;
    if (o.nudgeAfterMs != null) {
        await sleep(o.nudgeAfterMs);
        nudgeAt = clock.now();
        engine.setLatency(o.nudgeMs ?? 30);
    }
    await sleep(o.captureMs - (o.nudgeAfterMs ?? 0));

    clearInterval(timer);
    unsubscribe();
    tap.port.onmessage = null;
    const snapshot = engine.getSnapshot();
    engine.leave();
    engine.setLatency(0);
    return {
        rate: ctx.sampleRate,
        relation: median(relation),
        session,
        nudgeAt,
        nudgeMs: o.nudgeMs ?? 30,
        states,
        mode: snapshot.mode,
        detail: snapshot.detail,
        error: snapshot.error,
        duration: snapshot.duration,
        blocks: blocks.map((b) => ({ t: b.t, data: toBase64(b.data) })),
    };
}

/** Decodes `seconds` of audio from `from` like the player does; first channel only. */
async function decode(url: string, from: number, seconds: number) {
    registerDecoders();
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
    try {
        const track = (await input.getPrimaryAudioTrack())!;
        const parts: Float32Array[] = [];
        let first: number | null = null;
        let rate = 0;
        for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers(from, from + seconds)) {
            first ??= timestamp;
            rate = buffer.sampleRate;
            parts.push(buffer.getChannelData(0).slice());
        }
        const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) {
            samples.set(p, at);
            at += p.length;
        }
        return { codec: await track.getCodec(), rate, first: first!, samples: toBase64(samples) };
    } finally {
        input.dispose();
    }
}

/**
 * `seconds` of audio from song time `from`, taken from the player's own decoded
 * piece (including its alignment of the first piece); first channel only.
 */
async function pieceAudio(url: string, from: number, seconds: number) {
    const { ctx } = await unlockMuted();
    const player = new StreamPlayer(ctx, ctx.createGain(), clock);
    try {
        await player.load(url, new AbortController().signal, () => {});
        const piece = await player.piece(Math.floor(from / 10));
        const rate = piece.buffer.sampleRate;
        const at = Math.round((from - piece.start) * rate);
        const samples = piece.buffer.getChannelData(0).slice(at, at + Math.round(seconds * rate));
        return { rate, first: piece.start + at / rate, samples: toBase64(samples) };
    } finally {
        player.stop();
    }
}

/** Joins a session that started `pos` seconds ago; resolves once audio is coming out. */
async function joinLate(url: string, pos: number) {
    await syncedAndFrozen();
    await unlockMuted();
    const t0 = performance.now();
    void engine.join(makeSession({ url, start: Math.round(clock.now() - pos * 1000), pos: 0, loop: false }));
    let audibleMs: number | null = null;
    while (performance.now() - t0 < 60_000) {
        await sleep(50);
        if (engine.syncError != null) {
            audibleMs = performance.now() - t0;
            break;
        }
        if (engine.getSnapshot().state === 'error') break;
    }
    const { state, mode, error } = engine.getSnapshot();
    engine.leave();
    return { audibleMs, state, mode, error };
}

async function clockAfterSync() {
    await synced();
    // Let the first burst finish, so the estimate uses all its samples.
    await sleep(1500);
    return { ...clock.getSnapshot(), deviceToReference: clock.now() - Date.now() };
}

async function clockState(waitMs: number) {
    void synced().catch(() => {});
    await sleep(waitMs);
    return clock.getSnapshot();
}

const harness = { play, decode, pieceAudio, joinLate, clockAfterSync, clockState, PREROLL };
export type Harness = typeof harness;
(window as unknown as { harness: Harness }).harness = harness;
