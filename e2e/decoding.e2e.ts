// Every device must turn the same file into the same samples at the same
// timestamps. These tests catch a browser or library update changing how a
// format is decoded (e.g. Safari drops MP3's 529-sample decoder delay, which is
// why MP3 uses our own WebAssembly decoder; see src/lib/decoders.ts).

import { bestLag, fromBase64 } from './analysis.ts';
import { FORMATS, reference, sampleRate } from './fixtures.ts';
import { expect, fileUrl, test } from './test.ts';

test.describe.configure({ mode: 'parallel' });

for (const { file, offset } of FORMATS) {
    test(`${file}: decodes to the expected timestamps`, async ({ harness }) => {
        const t = 23.4567;
        const result = await harness.decode(fileUrl(file), t, 1);
        expect(result.rate).toBe(sampleRate(file));
        const samples = fromBase64(result.samples);
        const ref = reference(file, result.rate);
        // Skip the decoder's warm-up at the start.
        const from = Math.round(0.25 * result.rate);
        const match = bestLag(samples, ref, Math.round(result.first * result.rate), 3000, from, 8192);
        expect(match.lag, 'offset from ffmpeg’s decode, samples').toBe(offset);
        expect(match.error).toBeLessThan(0.05);
    });

    test(`${file}: the player's pieces match the file sample for sample`, async ({ harness }) => {
        // The first piece is decoded from the start of the stream, where some decoders get
        // the timing wrong (Opus, Vorbis) and the player corrects it; later pieces start
        // mid-stream. Any misplaced part or glitch shows up as a deviating stretch.
        for (const [from, seconds] of [
            [0.25, 9.7],
            [10.05, 9.9],
        ]) {
            const piece = await harness.pieceAudio(fileUrl(file), from, seconds);
            const samples = fromBase64(piece.samples);
            const ref = reference(file, piece.rate);
            const base = Math.round((piece.first + offset / sampleRate(file)) * piece.rate);
            const deviating: string[] = [];
            for (let b = 0; b + 512 <= samples.length; b += 512) {
                let error = 0;
                let energy = 0;
                for (let j = b; j < b + 512; j++) {
                    error += (samples[j] - ref[base + j]) ** 2;
                    energy += ref[base + j] ** 2;
                }
                if (error > 1e-3 && error > 0.01 * energy)
                    deviating.push(`${(piece.first + b / piece.rate).toFixed(2)} s`);
            }
            expect(deviating, `stretches that differ from the file between ${from} and ${from + seconds} s`).toEqual(
                [],
            );
        }
    });

    test(`${file}: decodes the same samples wherever decoding starts`, async ({ harness }) => {
        // The player decodes each piece from PREROLL seconds early and throws that part
        // away; after it, decoding must be exact no matter where it started.
        const preroll = await harness.PREROLL;
        const t = 30;
        const early = await harness.decode(fileUrl(file), t - 2, 3);
        const late = await harness.decode(fileUrl(file), t - preroll, 1.5);
        const a = fromBase64(early.samples);
        const b = fromBase64(late.samples);
        const atA = Math.round((t - early.first) * early.rate);
        const atB = Math.round((t - late.first) * late.rate);
        let error = 0;
        let energy = 0;
        for (let j = 0; j < early.rate; j++) {
            error += (a[atA + j] - b[atB + j]) ** 2;
            energy += a[atA + j] ** 2;
        }
        expect(Math.sqrt(error / energy)).toBeLessThan(1e-3);
    });
}
