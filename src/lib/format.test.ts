import { describe, expect, it } from 'vitest';
import { fmtMs, fmtTime, parsePosition, titleFromUrl } from '@/lib/format.ts';

describe('format', () => {
    it('formats times', () => {
        expect(fmtTime(0)).toBe('0:00');
        expect(fmtTime(83.9)).toBe('1:23');
        expect(fmtTime(3723)).toBe('1:02:03');
        expect(fmtTime(-5)).toBe('0:00');
    });

    it('formats milliseconds', () => {
        expect(fmtMs(2.345)).toBe('2.3 ms');
        expect(fmtMs(-43.2)).toBe('43 ms');
        expect(fmtMs(1234)).toBe('1.23 s');
    });

    it('parses start positions', () => {
        expect(parsePosition('1:30')).toBe(90);
        expect(parsePosition(' 45 ')).toBe(45);
        expect(parsePosition('1:02:03')).toBe(3723);
        expect(parsePosition('')).toBe(0);
        expect(parsePosition('abc')).toBe(0);
    });

    it('derives a title from the file name', () => {
        expect(titleFromUrl('https://x.org/music/My_Track%20(Extended).mp3')).toBe('My Track (Extended)');
        expect(titleFromUrl('https://x.org/')).toBe('x.org');
    });
});
