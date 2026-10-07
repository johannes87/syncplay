import { describe, expect, it } from 'vitest';
import { estimate, TIME_SOURCES } from './clock.ts';

const sample = (offset: number, rtt: number) => ({ offset, rtt, at: 0 });

describe('estimate', () => {
    it('returns null without samples', () => {
        expect(estimate([])).toBeNull();
    });

    it('ignores slow (queued) round trips', () => {
        const est = estimate([
            sample(10, 20),
            sample(11, 22),
            sample(9, 21),
            sample(80, 300), // stuck in a queue: skewed midpoint
            sample(-50, 250),
            sample(60, 200),
            sample(40, 180),
            sample(30, 150),
            sample(25, 120),
        ]);
        expect(est).toEqual({ offset: 10, rtt: 20, spread: 2 });
    });

    it('averages the middle two when keeping an even count', () => {
        // 12 samples -> keeps the fastest 4
        const slow = Array.from({ length: 8 }, () => sample(1000, 100));
        expect(estimate([sample(1, 5), sample(3, 5), sample(5, 5), sample(7, 5), ...slow])?.offset).toBe(4);
    });
});

describe('time sources', () => {
    it('parses Akamai seconds with milliseconds', () => {
        expect(TIME_SOURCES[0].parse('1790806668.777')).toBeCloseTo(1790806668777, 0);
    });

    it('parses timeapi.io UTC timestamps', () => {
        const body = JSON.stringify({ dateTime: '2026-09-30T22:17:22.8580287' });
        expect(TIME_SOURCES[1].parse(body)).toBe(Date.UTC(2026, 8, 30, 22, 17, 22, 858));
    });
});
