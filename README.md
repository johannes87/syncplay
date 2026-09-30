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
```

## Deploy

`npm run build`, then copy the contents of `dist/` into any folder on any web server (e.g. Apache).
It is a static single-page app with relative paths, so no server-side code or rewrite rules are needed.

## Code map

- `src/lib/clock.ts`: client-side NTP (framework-independent)
- `src/lib/player.ts`: audio scheduling and drift correction (framework-independent)
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
- **Audio (`player.ts`)**:
  - *Precise mode*: the file is decoded with Web Audio and scheduled against
    `AudioContext.getOutputTimestamp()`, which is when the sound actually leaves the speaker.
  - *Basic mode*: falls back to an `<audio>` element.
  - In both modes, a 5 Hz control loop measures the real playback error and corrects it with
    ±0.4 % speed changes (inaudible), or with a jump if the error is large.
- **Nudge**: Bluetooth speakers add delay the browser can't see. Each device can shift itself
  earlier or later in 10 ms steps, and the setting is remembered per device.

## Precise vs. basic mode

Precise mode needs the browser to be allowed to download the audio file, so it must be either:

- on the **same server** as the app, or
- served with a CORS header. For Apache, in the music folder's config or `.htaccess`:
  `Header set Access-Control-Allow-Origin "*"`

Otherwise SyncPlay uses basic mode, which is usually within a few ms but can wobble more. Files over
40 MB also use basic mode, because decoding them needs a lot of memory on phones. Basic mode needs
the server to support HTTP Range requests (Apache and nginx do).
