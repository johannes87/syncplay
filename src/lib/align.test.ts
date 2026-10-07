import { describe, expect, it } from 'vitest';
import { findLag } from '@/lib/align.ts';

function noise(n: number) {
    let seed = 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        out[i] = seed / 2 ** 30 - 1;
    }
    return out;
}

describe('findLag', () => {
    const reference = noise(40_000);

    it('finds how far a copy is shifted', () => {
        const shifted = new Float32Array(40_000);
        shifted.set(reference.subarray(1024), 0); // shifted[i] = reference[i + 1024]
        expect(findLag(shifted, 10_000, reference, 10_000)).toBe(1024);
        expect(findLag(reference, 10_000, shifted, 10_000)).toBe(-1024);
    });

    it('finds no shift in identical audio', () => {
        expect(findLag(reference, 5000, reference, 5000)).toBe(0);
    });

    it('gives up on silence', () => {
        expect(findLag(new Float32Array(40_000), 10_000, reference, 10_000)).toBeNull();
    });

    it('gives up on different audio', () => {
        expect(findLag(reference.slice().reverse(), 10_000, reference, 10_000)).toBeNull();
    });

    it('gives up near the edges', () => {
        expect(findLag(reference, 39_000, reference, 10_000)).toBeNull();
    });
});
