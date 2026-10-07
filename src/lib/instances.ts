import { ClockSync } from '@/lib/clock.ts';
import { SyncEngine } from '@/lib/player.ts';

// One shared clock and audio engine for the whole app.
export const clock = new ClockSync();
export const engine = new SyncEngine(clock);
