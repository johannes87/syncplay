# SyncPlay

Play one song on many devices at exactly the same moment, even when their clocks disagree.

1. Paste a link to an audio file and tap **Start & get invite link**.
2. Share the link or QR code.
3. Everyone opens it and taps **join**. Late joiners drop in at the right position.

## Develop

React 19 + TypeScript 7, built with Vite 8. Needs Node.js 22 or newer.

```sh
npm install
npm run dev       # local dev server with hot reload
npm test          # unit tests (Vitest)
npm run lint      # oxlint
npm run build     # type-check and build into dist/
npm run preview   # serve the production build locally
npm run test:e2e  # end-to-end tests in Chrome, WebKit and Firefox (~2 min)
```

### End-to-end tests

`npm run test:e2e` needs Google Chrome and ffmpeg (`brew install ffmpeg`) and, once,
`npx playwright install webkit firefox`. The first run generates test audio into `e2e/.fixtures` (~1 min).
Nothing plays through the speakers.

- `sync.e2e.ts`: records what the player really outputs and checks it against the shared
  timeline: across piece boundaries, a nudge, a loop and a delayed start. Real time, so these run
  one per browser at a time, after the other suites.
- `decoding.e2e.ts`: every format (MP3 CBR/VBR, AAC, Opus, Vorbis, FLAC, WAV) decodes to the same
  samples at the same timestamps in every browser, and the player's pieces match the file sample for sample.
- `clock.e2e.ts`: the client-side NTP with a wrong device clock, a congested network and failing time servers.
- `network.e2e.ts`: how much a device downloads before it can join.
- `ui.e2e.ts`: host and guest flows on the production build, including the basic-mode fallback.

## Deploy

`npm run build`, then copy the contents of `dist/` into any folder on any web server (e.g. Apache).
It is a static single-page app with relative paths, so no server-side code or rewrite rules are needed.

`npm run deploy` does both steps with rsync. It reads the target from `deploy.local` (ignored by git)
or the `DEPLOY_TARGET` environment variable:

```sh
echo 'DEPLOY_TARGET=example.com:www/syncplay/' > deploy.local
npm run deploy
```

## Code map

- `src/lib/clock.ts`: client-side NTP (framework-independent)
- `src/lib/player.ts`: the engine: picks precise or basic mode and keeps playback on the timeline
- `src/lib/stream-player.ts`, `audio.ts`, `decoders.ts`: precise mode (framework-independent)
- `src/lib/session.ts`: invite links and the shared timeline
- `src/hooks/`: React bindings (`useSyncExternalStore` over the clock and engine, URL hash, wake lock)
- `src/components/`: UI

## How the sync works

- **Clock (`clock.ts`)**: NTP over HTTPS against `time.akamai.com` (fallback: timeapi.io). Each request
  gives `offset = serverTime − (sent + received) / 2`. Send and receive times come from the Resource Timing API,
  so TLS setup and download time are excluded. The fastest third of samples from the last 3 minutes is kept,
  and their median is the offset. It re-syncs every 15 s and after the device wakes up.
- **Timeline**: the invite link holds the song URL and the start time (ms since epoch, reference clock).
  Every device computes where the song should be from that alone. No server or signaling is needed.
- **Audio**:
  - *Precise mode* (`stream-player.ts`): [Mediabunny](https://mediabunny.dev) reads the file with HTTP
    Range requests and gives every decoded piece of audio its exact timestamp. About 10 s is decoded at a
    time and scheduled on the Web Audio clock at the moment the synced clock says it must be heard, with
    5 ms crossfades at the seams. Works with files of any length; only a few pieces are in memory.
  - *Basic mode*: falls back to an `<audio>` element, kept on time by a control loop that measures the
    playback error and corrects it with small speed changes, or a jump if the error is large.
  - Every device must decode a file into the same samples at the same timestamps. Browsers disagree for
    MP3 (Safari removes the 529-sample decoder delay, Chrome doesn't), Safari can't decode FLAC and
    Firefox outputs nothing for Vorbis, so those use the same WebAssembly decoder everywhere
    (`decoders.ts`). AAC, Opus and PCM decode identically in every browser and use the browser's decoder.
  - When sound actually leaves the speaker comes from `AudioContext.getOutputTimestamp()`, smoothed over
    two seconds because Safari's readings jitter (`audio.ts`). Playback starts only once those readings
    have settled, and anything that still drifts more than 2 ms is re-placed with a crossfade.
  - Decoding from the very start of a file is slightly off for some formats (Opus by 6.5 ms, Vorbis
    by 23 ms), so the first piece is lined up with a decode that starts further in (`align.ts`).
- **Nudge**: Bluetooth speakers add delay the browser can't see. Each device can shift itself
  earlier or later in 1 ms steps (10 ms while holding the button), and the setting is remembered per device.

## Precise vs. basic mode

Precise mode supports MP3 (constant and variable bitrate), AAC/M4A, Opus, Vorbis, FLAC and WAV.
It needs the browser to be allowed to download the file, so the file must be either:

- on the **same server** as the app, or
- served with a CORS header. For Apache, in the music folder's config or `.htaccess`:
  `Header set Access-Control-Allow-Origin "*"`

The server should support HTTP Range requests (Apache and nginx do). Otherwise SyncPlay uses basic mode,
which is usually within a few ms but can wobble more.

Measured in headless Chrome and WebKit (Safari's engine) by recording the actual audio output: precise
mode stays within ±0.1 ms (Chrome) and ±1.7 ms (WebKit) of the shared timeline, across seams, loops and
nudges. Real speakers add their own latency, which only the nudge buttons can correct.

**Known limitation:** MP3 files have no index, so to know exactly which frame is which, Mediabunny reads
an MP3 from the start. Joining late into a long MP3 therefore downloads the file up to that point
(about 100 MB at minute 40 of a 320 kbit/s mix). Other formats can seek directly.
