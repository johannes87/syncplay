// Test audio files, generated with ffmpeg into e2e/.fixtures (not committed).
//
// The signal is random noise bursts every 30-120 ms and nothing else: noise
// matches itself at exactly one alignment, so comparing recorded output with
// the reference can't lock onto the wrong one (a steady tone could).

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const FIXTURES = path.join(import.meta.dirname, '.fixtures')
const VERSION = '2' // bump to regenerate after changing anything below

export interface Format {
  file: string
  ffmpegArgs: string[]
  /**
   * Where the app's timeline sits relative to ffmpeg's decode of the file, in
   * samples at the file's rate (measured; same in Chrome and Safari).
   * MP3: ffmpeg skips the LAME encoder delay (576) + decoder delay (529), our timeline keeps them.
   * Opus: 312-sample pre-skip. Vorbis: one 1024-sample block.
   */
  offset: number
}

export const FORMATS: Format[] = [
  { file: 'cbr.mp3', ffmpegArgs: ['-c:a', 'libmp3lame', '-b:a', '320k'], offset: -1105 },
  { file: 'vbr.mp3', ffmpegArgs: ['-c:a', 'libmp3lame', '-q:a', '0'], offset: -1105 },
  // No PNS: for noise-like sound AAC can store just "noise here", and each decoder
  // synthesizes it with its own random numbers, so samples wouldn't be comparable.
  { file: 'aac.m4a', ffmpegArgs: ['-c:a', 'aac', '-aac_pns', '0', '-b:a', '192k'], offset: 0 },
  { file: 'opus.ogg', ffmpegArgs: ['-c:a', 'libopus', '-b:a', '128k'], offset: 312 },
  { file: 'vorbis.ogg', ffmpegArgs: ['-c:a', 'vorbis', '-strict', '-2', '-q:a', '5'], offset: 1024 },
  { file: 'flac.flac', ffmpegArgs: ['-c:a', 'flac'], offset: 0 },
  { file: 'wav.wav', ffmpegArgs: ['-c:a', 'pcm_s16le'], offset: 0 },
]

export const format = (file: string) => FORMATS.find((f) => f.file === file)!

/** 20-minute files for measuring how much a late join downloads. */
export const LONG_FILES = { mp3: 'long-cbr.mp3', aac: 'long-aac.m4a' }
/** Near-silent MP3 for tests that let the app play through the speakers. */
export const QUIET_FILE = 'quiet.mp3'

const RATE = 44100
const SECONDS = 60

function ffmpeg(...args: string[]) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { cwd: FIXTURES })
}

/** Small seeded PRNG, so the signal is identical on every run. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function writeSignal(file: string, gain: number) {
  const random = mulberry32(11)
  const n = RATE * SECONDS
  const pcm = new Float32Array(2 * n)
  for (let t = random() * 2000; t < n - RATE; t += 1300 + random() * 4000) {
    const length = 400 + random() * 900
    const amplitude = 0.2 + random() * 0.4
    for (let i = 0; i < length; i++) {
      const envelope = amplitude * Math.exp(-i / (length / 4)) * gain
      const at = 2 * (Math.floor(t) + i)
      pcm[at] += envelope * (random() * 2 - 1)
      pcm[at + 1] += envelope * (random() * 2 - 1)
    }
  }
  fs.writeFileSync(path.join(FIXTURES, file), Buffer.from(pcm.buffer))
}

const RAW = ['-f', 'f32le', '-ar', String(RATE), '-ac', '2']

export function ensureFixtures() {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    throw new Error('The end-to-end tests need ffmpeg on the PATH (e.g. `brew install ffmpeg`).')
  }
  const stamp = path.join(FIXTURES, 'version')
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === VERSION) return
  fs.rmSync(FIXTURES, { recursive: true, force: true })
  fs.mkdirSync(FIXTURES, { recursive: true })

  writeSignal('signal.f32', 1)
  for (const f of FORMATS) ffmpeg(...RAW, '-i', 'signal.f32', ...f.ffmpegArgs, f.file)
  const loop = ['-stream_loop', '19', ...RAW, '-i', 'signal.f32']
  ffmpeg(...loop, '-c:a', 'libmp3lame', '-b:a', '320k', LONG_FILES.mp3)
  ffmpeg(...loop, '-c:a', 'aac', '-aac_pns', '0', '-b:a', '192k', LONG_FILES.aac)
  writeSignal('quiet.f32', 0.001)
  ffmpeg(...RAW, '-i', 'quiet.f32', '-c:a', 'libmp3lame', '-b:a', '128k', QUIET_FILE)
  fs.writeFileSync(stamp, VERSION)
}

/** First channel of ffmpeg's decode of `file`, resampled to `rate` (cached). */
export function reference(file: string, rate: number): Float32Array {
  const cached = path.join(FIXTURES, `${file}.${rate}.ref.f32`)
  if (!fs.existsSync(cached)) {
    ffmpeg('-i', file, '-af', 'pan=mono|c0=c0', '-ar', String(rate), '-f', 'f32le', cached)
  }
  const bytes = fs.readFileSync(cached)
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
}

/** The file's sample rate. */
export function sampleRate(file: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', file],
    { cwd: FIXTURES },
  )
  return Number(out.toString())
}
