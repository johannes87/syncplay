// Sample-accurate playback of files of any length and (almost) any format.
//
// Mediabunny reads the file with HTTP Range requests and gives every decoded
// piece of audio its exact timestamp in the song. We decode ~10 s at a time
// and schedule each piece on the Web Audio clock at the moment the synced
// clock says it must be heard. Neighbouring pieces overlap by a few ms and are
// crossfaded, which hides the sub-millisecond corrections for clock drift that
// happen at each seam. Only a few pieces are in memory at any time.

import { ALL_FORMATS, AudioBufferSink, Input, UrlSource } from 'mediabunny';
import { findLag } from './align.ts';
import { audibleNow, ctxTimeFor, type Player, type Tuning } from './audio.ts';
import type { ClockSync } from './clock.ts';
import { registerDecoders } from './decoders.ts';

/** Seconds of audio per piece. */
export const CHUNK = 10;
/** Decoded before each piece and thrown away: decoders need a moment to warm up (MP3 needs ~0.1 s). */
export const PREROLL = 0.2;
/** Half the crossfade between pieces, seconds. */
const FADE = 0.005;
/** Schedule pieces this far ahead. */
const LOOKAHEAD_MS = 5000;
const PUMP_MS = 500;

interface Chunk {
    buffer: AudioBuffer;
    /** Song time of the buffer's first sample. */
    start: number;
}

interface Piece {
    src: AudioBufferSourceNode;
    gain: GainNode;
    /** AudioContext times the piece is audible. */
    start: number;
    end: number;
    /** Song position (not wrapped for loops) audible at `start`. */
    pos: number;
}

const CODEC_NAMES: Record<string, string> = { mp3: 'MP3', aac: 'AAC', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC' };

export class StreamPlayer implements Player {
    readonly mode = 'precise';
    // Pieces are placed exactly, so no speed correction. If the measured error exceeds
    // 2 ms anyway (e.g. the output timing changed after a piece was scheduled),
    // re-place everything with a crossfade.
    readonly tuning: Tuning = { hard: 0.002, dead: Infinity, maxRate: 0, alpha: 0.5, settleMs: 400, leadMs: 150 };
    readonly rate = 1;
    detail = '';
    duration = 0;
    onended?: () => void;
    onerror?: (error: Error) => void;
    readonly #ctx: AudioContext;
    readonly #out: AudioNode;
    readonly #clock: ClockSync;
    #input: Input | null = null;
    #sink: AudioBufferSink | null = null;
    readonly #chunks = new Map<number, Promise<Chunk>>();
    readonly #ready = new Map<number, Chunk>();
    #pieces: Piece[] = [];
    /** At reference time `global`, song position `pos` (unwrapped) is audible. */
    #anchor: { global: number; pos: number } | null = null;
    #loop = false;
    /** Unwrapped song position up to which pieces are scheduled. */
    #until = 0;
    #timer: ReturnType<typeof setInterval> | undefined;

    constructor(ctx: AudioContext, out: AudioNode, clock: ClockSync) {
        this.#ctx = ctx;
        this.#out = out;
        this.#clock = clock;
    }

    async load(url: string, signal: AbortSignal, onProgress: (p: number | null) => void) {
        onProgress(null);
        registerDecoders();
        const input = new Input({
            source: new UrlSource(url, {
                requestInit: { credentials: 'omit' },
                // Fail fast so we can fall back to basic mode (e.g. when CORS blocks us).
                getRetryDelay: (attempts) => (attempts < 3 ? 2 ** attempts / 2 : null),
            }),
            formats: ALL_FORMATS,
        });
        this.#input = input;
        signal.addEventListener('abort', () => input.dispose());
        const track = await input.getPrimaryAudioTrack();
        if (!track) throw new Error('The file has no audio');
        const codec = await track.getCodec();
        const name = codec ? (CODEC_NAMES[codec] ?? codec.toUpperCase()) : 'this';
        if (!(await track.canDecode())) throw new Error(`This browser can’t decode ${name} audio`);
        this.duration = (await track.getDurationFromMetadata()) ?? (await track.computeDuration());
        this.#sink = new AudioBufferSink(track);
        this.detail = `${name}, ${(await track.getSampleRate()) / 1000} kHz, streamed`;
    }

    /** Loads the piece around `pos`. For MP3 this can mean reading the file up to there. */
    async prepare(pos: number) {
        await this.#fetch(this.#chunkOf(this.#wrap(pos)));
    }

    schedule(global: number, pos: number, loop: boolean) {
        this.#loop = loop;
        const handover = ctxTimeFor(this.#ctx, this.#clock, global);
        // Crossfade from whatever is playing into the new timing.
        for (const p of this.#pieces) {
            if (p.start >= handover - FADE) {
                this.#discard(p);
            } else if (p.end > handover - FADE) {
                const from = Math.max(handover - FADE, this.#ctx.currentTime);
                p.gain.gain.cancelScheduledValues(from);
                p.gain.gain.setValueAtTime(p.gain.gain.value, from);
                p.gain.gain.linearRampToValueAtTime(0, handover + FADE);
                p.src.onended = null;
                p.src.stop(handover + FADE + 0.01);
            }
        }
        this.#pieces = this.#pieces.filter((p) => p.start < handover - FADE && p.end > this.#ctx.currentTime);
        this.#anchor = { global, pos };
        this.#until = pos;
        clearInterval(this.#timer);
        this.#timer = setInterval(() => this.#pump(), PUMP_MS);
        this.#pump();
    }

    sample() {
        const { ctxTime, global } = audibleNow(this.#ctx, this.#clock);
        const piece = this.#pieces.findLast((p) => p.start + 2 * FADE <= ctxTime && ctxTime < p.end);
        if (!piece) return null;
        return { global, pos: this.#wrap(piece.pos + (ctxTime - piece.start)) };
    }

    /** Decoded piece `k` (CHUNK seconds each), as it would be played. Used by the tests. */
    piece(k: number): Promise<{ buffer: AudioBuffer; start: number }> {
        return this.#fetch(k);
    }

    setRate() {
        // Not needed: every piece is placed exactly.
    }

    stop() {
        clearInterval(this.#timer);
        this.#anchor = null;
        for (const p of this.#pieces) this.#discard(p);
        this.#pieces = [];
        this.#chunks.clear();
        this.#ready.clear();
        void this.#input?.dispose();
    }

    #wrap(pos: number) {
        return this.#loop ? ((pos % this.duration) + this.duration) % this.duration : pos;
    }

    #chunkOf(songPos: number) {
        return Math.max(0, Math.floor(songPos / CHUNK));
    }

    #globalAt(pos: number) {
        return this.#anchor!.global + (pos - this.#anchor!.pos) * 1000;
    }

    /** Schedules pieces until LOOKAHEAD_MS ahead, loading them as needed. */
    #pump() {
        while (this.#anchor) {
            const pos = this.#until;
            if (!this.#loop && pos >= this.duration) return;
            if (this.#globalAt(pos) - this.#clock.now() > LOOKAHEAD_MS) return;
            const songPos = this.#wrap(pos);
            const k = this.#chunkOf(songPos);
            const chunk = this.#ready.get(k);
            if (!chunk) {
                this.#fetch(k).then(
                    () => this.#pump(),
                    (e: Error) => this.onerror?.(e),
                );
                return;
            }
            const end = pos + (Math.min((k + 1) * CHUNK, this.duration) - songPos);
            this.#play(chunk, pos, end);
            this.#until = end;
            this.#prefetch(k);
        }
    }

    /** Plays song positions [from, to) (unwrapped) from `chunk`, crossfading at both ends. */
    #play(chunk: Chunk, from: number, to: number) {
        const ctx = this.#ctx;
        const songFrom = this.#wrap(from);
        const whenFrom = ctxTimeFor(ctx, this.#clock, this.#globalAt(from));
        const bufferEnd = chunk.start + chunk.buffer.duration;
        let a = Math.max(songFrom - FADE, chunk.start, 0);
        const b = Math.min(songFrom + (to - from) + FADE, bufferEnd);
        let start = whenFrom + (a - songFrom);
        const earliest = ctx.currentTime + 0.02;
        if (start < earliest) {
            // Arrived late (slow network): join in at the right spot.
            a += earliest - start;
            start = earliest;
        }
        if (a >= b) return;
        const end = start + (b - a);
        const fade = Math.min(2 * FADE, (end - start) / 2);

        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        src.buffer = chunk.buffer;
        src.connect(gain).connect(this.#out);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(1, start + fade);
        gain.gain.setValueAtTime(1, end - fade);
        gain.gain.linearRampToValueAtTime(0, end);
        src.start(start, a - chunk.start, b - a);

        const piece: Piece = { src, gain, start, end, pos: from + (a - songFrom) };
        src.onended = () => {
            this.#pieces = this.#pieces.filter((p) => p !== piece);
            if (!this.#loop && to >= this.duration && this.#pieces.length === 0) this.onended?.();
        };
        this.#pieces.push(piece);
    }

    #discard(p: Piece) {
        p.src.onended = null;
        try {
            p.src.stop();
        } catch {
            // never started
        }
        p.src.disconnect();
    }

    #prefetch(k: number) {
        const count = Math.ceil(this.duration / CHUNK);
        const keep = new Set<number>();
        for (let i = 0; i < 3; i++) {
            const j = this.#loop ? (k + i) % count : k + i;
            if (j < count) keep.add(j);
        }
        for (const j of keep) void this.#fetch(j).catch(() => {});
        for (const j of this.#chunks.keys()) {
            if (!keep.has(j)) {
                this.#chunks.delete(j);
                this.#ready.delete(j);
            }
        }
    }

    #fetch(k: number): Promise<Chunk> {
        let chunk = this.#chunks.get(k);
        if (!chunk) {
            chunk = this.#decode(k);
            this.#chunks.set(k, chunk);
            chunk.then(
                (c) => this.#chunks.get(k) === chunk && this.#ready.set(k, c),
                () => this.#chunks.delete(k),
            );
        }
        return chunk;
    }

    /** Decodes song time [k * CHUNK - PREROLL, (k + 1) * CHUNK + margin) into one buffer. */
    async #decode(k: number): Promise<Chunk> {
        const to = Math.min((k + 1) * CHUNK, this.duration) + 2 * FADE + 0.05;
        const chunk = this.#assemble(await this.#collect(Math.max(0, k * CHUNK - PREROLL), to));
        return k === 0 ? this.#alignStart(chunk) : chunk;
    }

    /**
     * Decoding from the start of a stream can get the timing slightly wrong (in
     * every browser): Opus by its 312-sample pre-skip, Vorbis by one 1024-sample
     * block for decodes starting in the first ~2 s. Decodes starting further in
     * are right, so line the first piece up with one of those.
     */
    async #alignStart(chunk: Chunk): Promise<Chunk> {
        const rate = chunk.buffer.sampleRate;
        for (const at of [5, 6.5, 8]) {
            if (at + 0.5 > Math.min(CHUNK, this.duration)) break;
            const ref = this.#assemble(await this.#collect(at - PREROLL, at + 0.5));
            const t = at + 0.1; // past the reference's warm-up
            const i = Math.round((t - chunk.start) * rate);
            const j = Math.round((t - ref.start) * rate);
            // chunk[i] holds the same audio as ref[j + lag], whose timing is right.
            const lag = findLag(chunk.buffer.getChannelData(0), i, ref.buffer.getChannelData(0), j);
            if (lag != null) return { buffer: chunk.buffer, start: ref.start + (j + lag - i) / rate };
        }
        return chunk; // too quiet to tell
    }

    /** Puts decoded parts into one buffer, each at its timestamp. */
    #assemble(parts: { buffer: AudioBuffer; timestamp: number }[]): Chunk {
        if (!parts.length) throw new Error('No audio found in the file at this position');
        const { sampleRate, numberOfChannels } = parts[0].buffer;
        const start = parts[0].timestamp;
        const last = parts.at(-1)!;
        const buffer = this.#ctx.createBuffer(
            numberOfChannels,
            Math.round((last.timestamp - start) * sampleRate) + last.buffer.length,
            sampleRate,
        );
        for (const part of parts) {
            const at = Math.round((part.timestamp - start) * sampleRate);
            for (let c = 0; c < numberOfChannels; c++) {
                const data = part.buffer.getChannelData(Math.min(c, part.buffer.numberOfChannels - 1));
                buffer.copyToChannel(data.subarray(0, buffer.length - at), c, at);
            }
        }
        return { buffer, start };
    }

    async #collect(from: number, to: number) {
        const parts: { buffer: AudioBuffer; timestamp: number }[] = [];
        for await (const { buffer, timestamp } of this.#sink!.buffers(from, to)) parts.push({ buffer, timestamp });
        return parts;
    }
}
