// How much a device downloads before it can join. Matters on mobile data.

import { LONG_FILES } from './fixtures.ts';
import { bytesSent, expect, fileUrl, test, type HarnessApi } from './test.ts';

const MB = 1024 * 1024;
// Measured: 4.5-6.5 MB to join near the start or an AAC file late (Mediabunny
// reads ahead in large chunks). Joining an MP3 late currently needs ~46 MB.
const LIMIT_MB = 10;

// Downloading works the same in every browser.
test.skip(({ browserName }) => browserName !== 'chromium', 'Only measured in Chrome');

async function join(harness: HarnessApi, file: string, pos: number) {
    const tag = `${file}-${pos}-${Date.now()}`;
    const result = await harness.joinLate(fileUrl(file, { tag }), pos);
    expect(result.mode, result.error ?? '').toBe('precise');
    expect(result.audibleMs).not.toBeNull();
    // Let cancelled requests wind down before counting.
    await new Promise((r) => setTimeout(r, 1000));
    const bytes = await bytesSent(tag);
    test.info().annotations.push({ type: 'downloaded', description: `${(bytes / MB).toFixed(1)} MB` });
    return { ...result, bytes };
}

test('joining a long MP3 near the start downloads little', async ({ harness }) => {
    const { bytes } = await join(harness, LONG_FILES.mp3, 5);
    expect(bytes / MB).toBeLessThan(LIMIT_MB);
});

test('joining a long AAC file late downloads little', async ({ harness }) => {
    const { bytes } = await join(harness, LONG_FILES.aac, 15 * 60);
    expect(bytes / MB).toBeLessThan(LIMIT_MB);
});

test('joining a long MP3 late downloads little', async ({ harness }) => {
    // Known limitation (see README): MP3 has no index, so Mediabunny reads it from the
    // start to know exactly which frame is which. Remove this line once that is fixed.
    test.fail();
    const { bytes } = await join(harness, LONG_FILES.mp3, 15 * 60);
    expect(bytes / MB).toBeLessThan(LIMIT_MB);
});
