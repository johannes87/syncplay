/**
 * How many samples `signal` is shifted relative to `reference` around the given
 * positions: the lag L (within ±range) for which signal[at + j] best matches
 * reference[refAt + j + L]. Returns null if the stretch is too quiet to tell or
 * nothing matches well (e.g. the two aren't the same audio).
 */
export function findLag(
    signal: Float32Array,
    at: number,
    reference: Float32Array,
    refAt: number,
    { length = 4096, range = 4096, minEnergy = 1e-3, maxError = 0.01 } = {},
): number | null {
    if (at < 0 || at + length > signal.length) return null;
    let energy = 0;
    for (let j = 0; j < length; j++) energy += signal[at + j] ** 2;
    if (energy / length < minEnergy ** 2) return null;

    let best = { lag: 0, error: Infinity };
    for (let lag = -range; lag <= range; lag++) {
        const from = refAt + lag;
        if (from < 0 || from + length > reference.length) continue;
        let error = 0;
        for (let j = 0; j < length && error < best.error; j++) error += (signal[at + j] - reference[from + j]) ** 2;
        if (error < best.error) best = { lag, error };
    }
    return Math.sqrt(best.error / energy) <= maxError ? best.lag : null;
}
