// Compares what the engine played with where the song should have been.

import { expect } from '@playwright/test';
import { format, reference, sampleRate } from '@e2e/fixtures.ts';
import type { Harness } from '@e2e/harness.ts';

export type PlayResult = Awaited<ReturnType<Harness['play']>>;

export function fromBase64(data: string): Float32Array {
    const bytes = Buffer.from(data, 'base64');
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
}

/**
 * Lag (in samples) at which `signal` best matches `ref` starting at `base`,
 * searched within ±range, and the relative error of that match.
 */
export function bestLag(
    signal: Float32Array,
    ref: Float32Array,
    base: number,
    range: number,
    from = 0,
    length = signal.length,
) {
    let energy = 0;
    for (let j = from; j < from + length; j++) energy += signal[j] ** 2;
    let best = { lag: 0, error: Infinity };
    for (let lag = -range; lag <= range; lag++) {
        let e = 0;
        for (let j = from; j < from + length; j++) {
            const d = signal[j] - (ref[base + j + lag] ?? 0);
            e += d * d;
            if (e > best.error) break;
        }
        if (e < best.error) best = { lag, error: e };
    }
    return { lag: best.lag, error: Math.sqrt(best.error / energy), energy };
}

export interface Window {
    /** Song position the window should contain, seconds. */
    songPos: number;
    /** How far the played audio is from where it should be, ms (> 0: late). */
    offsetMs: number;
    afterNudge: boolean;
}

/**
 * Checks each recorded block against the reference: where in the song should
 * this block be, and where is it really?
 */
export function analyse(result: PlayResult, file: string): Window[] {
    const ref = reference(file, result.rate);
    const fileOffset = format(file).offset / sampleRate(file);
    const { session, nudgeAt, nudgeMs, rate } = result;
    const range = Math.round(0.01 * rate);
    const windows: Window[] = [];
    for (const block of result.blocks) {
        // Reference time at which this block is heard.
        const heard = block.t * 1000 + result.relation;
        if (heard < session.start + 50) continue;
        // The nudge takes effect ~150 ms after it is set, with a 10 ms crossfade: skip that moment.
        if (nudgeAt != null && heard > nudgeAt - 50 && heard < nudgeAt + 400) continue;
        const afterNudge = nudgeAt != null && heard >= nudgeAt;
        let songPos = (heard + (afterNudge ? nudgeMs : 0) - session.start) / 1000 + session.pos;
        if (session.loop) songPos %= result.duration!;

        const data = fromBase64(block.data);
        const base = Math.round((songPos + fileOffset) * rate);
        let match = bestLag(data, ref, base, range);
        if (match.energy < 1e-2) continue; // quiet: between noise bursts
        if (match.error > 0.7) {
            // Nothing within ±10 ms: search wider, so a badly placed piece shows up as a
            // large offset instead of disappearing from the statistics.
            const wide = bestLag(data, ref, base, Math.round(0.06 * rate));
            if (wide.energy < 1e-2 || wide.error > 0.7) {
                windows.push({ songPos, offsetMs: NaN, afterNudge });
                continue;
            }
            match = wide;
        }
        windows.push({ songPos, offsetMs: (match.lag / rate) * 1000, afterNudge });
    }
    return windows;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/**
 * Tolerances, ms. Safari's timing moves in steps of one render quantum (128 frames,
 * 1.33 ms at 96 kHz); real bugs found so far were 4 ms and more.
 */
export const TOLERANCE = {
    chromium: { median: 0.3, p95: 0.5 },
    webkit: { median: 1.5, p95: 3 },
};

export function expectInSync(windows: Window[], browser: string, minWindows = 25) {
    const tolerance = TOLERANCE[browser as keyof typeof TOLERANCE];
    const unmatched = windows.filter((w) => Number.isNaN(w.offsetMs));
    const offsets = windows
        .filter((w) => !Number.isNaN(w.offsetMs))
        .map((w) => w.offsetMs)
        .sort((a, b) => a - b);
    const summary = `${windows.length} windows; offsets 5th/50th/95th percentile: ${[0.05, 0.5, 0.95]
        .map((p) => percentile(offsets, p)?.toFixed(2))
        .join(
            ' / ',
        )} ms${unmatched.length ? `; ${unmatched.length} unmatched (e.g. at ${unmatched[0].songPos.toFixed(2)} s)` : ''}`;
    if (process.env.SYNC_DEBUG) {
        console.log(windows.map((w) => `${w.songPos.toFixed(1)}:${w.offsetMs.toFixed(1)}`).join(' '));
    }
    expect(windows.length, summary).toBeGreaterThanOrEqual(minWindows);
    expect(unmatched.length, summary).toBeLessThanOrEqual(windows.length * 0.05);
    expect(Math.abs(percentile(offsets, 0.5)), summary).toBeLessThanOrEqual(tolerance.median);
    expect(Math.abs(percentile(offsets, 0.05)), summary).toBeLessThanOrEqual(tolerance.p95);
    expect(Math.abs(percentile(offsets, 0.95)), summary).toBeLessThanOrEqual(tolerance.p95);
    return summary;
}
