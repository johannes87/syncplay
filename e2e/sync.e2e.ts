// The core promise: what comes out of the speaker is where the shared timeline
// says the song should be. Records the engine's real output and compares it
// with ffmpeg's decode of the same file, every ~85 ms.
//
// These run in real time, one at a time (see playwright.config.ts). Scheduling works
// the same for every format, so a few representative ones suffice: MP3 (our
// WebAssembly decoder), AAC (the browser's decoder) and Vorbis (needs its first piece
// realigned). decoding.e2e.ts checks every format's decoded audio sample for sample.

import { analyse, expectInSync, fromBase64 } from './analysis.ts';
import { expect, fileUrl, test } from './test.ts';

for (const file of ['vbr.mp3', 'aac.m4a', 'vorbis.ogg']) {
    test(`${file}: in sync across piece boundaries and a nudge`, async ({ harness, browserName }, testInfo) => {
        // Starts in the first piece (decoded from the stream start), crosses the seam
        // to the second piece at 10 s, and gets nudged at ~12 s.
        const result = await harness.play({
            url: fileUrl(file),
            pos: 7.5,
            startInMs: 1000,
            loop: false,
            nudgeAfterMs: 5000, // the nudge hands over to new timing mid-piece
            captureMs: 9000,
        });
        expect(result.mode, result.error ?? '').toBe('precise');
        const windows = analyse(result, file);
        testInfo.annotations.push({ type: 'sync', description: expectInSync(windows, browserName) });
        expect(windows.some((w) => w.songPos < 10)).toBe(true);
        expect(windows.some((w) => w.songPos > 10 && !w.afterNudge)).toBe(true);
        expect(windows.filter((w) => w.afterNudge).length).toBeGreaterThanOrEqual(8);
    });
}

for (const file of ['cbr.mp3', 'opus.ogg']) {
    test(`${file}: in sync when looping back to the start`, async ({ harness, browserName }, testInfo) => {
        const result = await harness.play({
            url: fileUrl(file),
            pos: 56.5,
            startInMs: 1000,
            loop: true,
            captureMs: 7000,
        });
        expect(result.mode, result.error ?? '').toBe('precise');
        const windows = analyse(result, file);
        testInfo.annotations.push({ type: 'sync', description: expectInSync(windows, browserName) });
        expect(windows.some((w) => w.songPos > 57)).toBe(true);
        expect(windows.some((w) => w.songPos < 3)).toBe(true);
    });
}

test('waits silently, then starts exactly on time', async ({ harness, browserName }, testInfo) => {
    const file = 'vbr.mp3';
    const result = await harness.play({ url: fileUrl(file), pos: 3, startInMs: 2500, loop: false, captureMs: 5500 });
    expect(result.states.map((s) => s.state)).toEqual(expect.arrayContaining(['loading', 'waiting', 'playing']));

    // Nothing comes out before the start.
    for (const block of result.blocks) {
        const heard = block.t * 1000 + result.relation;
        const blockEnd = heard + (8192 / result.rate) * 1000;
        if (blockEnd < result.session.start - 20) {
            expect(
                Math.max(...fromBase64(block.data).map(Math.abs)),
                `audio before the start (at ${heard - result.session.start} ms)`,
            ).toBeLessThan(1e-4);
        }
    }
    const windows = analyse(result, file);
    testInfo.annotations.push({ type: 'sync', description: expectInSync(windows, browserName) });
    expect(windows[0].songPos).toBeLessThan(3.5);
});
