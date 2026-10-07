// Client-side NTP: the shared clock must be right even when the device clock isn't.
// The time server is simulated locally (see e2e/test.ts).

import { expect, test } from '@e2e/test.ts';

test.describe('device clock 89 s behind', () => {
    test.use({ timeServer: { offsetMs: 89_000 } });

    test('measures the offset to within a few ms', async ({ harness }) => {
        const clock = await harness.clockAfterSync();
        expect(clock.source).toBe('time.akamai.com');
        expect(Math.abs(clock.offset - 89_000)).toBeLessThan(10);
        expect(Math.abs(clock.deviceToReference - 89_000)).toBeLessThan(10);
    });
});

test.describe('congested network', () => {
    // Every second answer is held back 50-200 ms after its timestamp was taken, which
    // skews those samples by 25-100 ms. The estimate must not be fooled.
    let answers = 0;
    const delays = [50, 120, 200, 80, 160];
    test.use({ timeServer: { delayMs: () => (answers++ % 2 ? delays[answers % delays.length] : 0) } });

    test('ignores slow answers', async ({ harness }) => {
        const clock = await harness.clockAfterSync();
        expect(Math.abs(clock.offset)).toBeLessThan(10);
    });
});

test.describe('first time server down', () => {
    test.use({ timeServer: { offsetMs: 1234, akamaiDown: true } });

    test('falls back to the second', async ({ harness }) => {
        const clock = await harness.clockAfterSync();
        expect(clock.source).toBe('timeapi.io');
        expect(Math.abs(clock.offset - 1234)).toBeLessThan(10);
    });
});

test.describe('no time server reachable', () => {
    test.use({ timeServer: { akamaiDown: true, timeapiDown: true } });

    test('says so', async ({ harness }) => {
        const clock = await harness.clockState(3000);
        expect(clock.state).toBe('failed');
    });
});
