import { ClockSync } from './clock.js';
import { SyncEngine } from './player.js';

const $ = (id) => document.getElementById(id);

const clock = new ClockSync();
const engine = new SyncEngine(clock);
clock.start();

// ---------- helpers ----------

function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function fmtMs(ms) {
    const abs = Math.abs(ms);
    return abs >= 1000 ? `${(abs / 1000).toFixed(2)} s` : `${abs.toFixed(abs < 10 ? 1 : 0)} ms`;
}

function parsePosition(text) {
    const parts = String(text).trim().split(':').map(Number);
    if (!text.trim() || parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function titleFromUrl(url) {
    try {
        const u = new URL(url);
        const file = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
        return file.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_+]+/g, ' ').trim() || u.hostname;
    } catch {
        return url;
    }
}

function hostFromUrl(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

// ---------- session links ----------
// Everything a device needs is in the link: #u=<song url>&t=<start, ms since epoch>[&p=<seconds>][&l=1]

function parseSession(hash) {
    const q = new URLSearchParams(hash.replace(/^#/, ''));
    const url = q.get('u');
    const start = Number(q.get('t'));
    if (!url || !Number.isFinite(start) || start <= 0) return null;
    return { url, start, pos: Number(q.get('p')) || 0, loop: q.get('l') === '1', title: titleFromUrl(url) };
}

function sessionLink(s) {
    const q = new URLSearchParams({ u: s.url, t: String(Math.round(s.start)) });
    if (s.pos) q.set('p', String(s.pos));
    if (s.loop) q.set('l', '1');
    return `${location.origin}${location.pathname}#${q}`;
}

const sessionKey = (s) => (s ? `${s.url}|${s.start}|${s.pos}|${s.loop}` : '');

// ---------- routing ----------

let session = null;
let probedDuration = null;
let countdownFrom = null;

function navigate(s, { autoJoin = false } = {}) {
    history.pushState(null, '', s ? sessionLink(s) : location.pathname);
    route({ autoJoin });
}

function route({ autoJoin = false } = {}) {
    const next = parseSession(location.hash);
    if (sessionKey(next) !== sessionKey(session)) {
        engine.leave();
        session = next;
        if (session) enterSession();
    }
    $('setupView').hidden = !!session;
    $('sessionView').hidden = !session;
    if (!session) {
        document.title = 'SyncPlay';
        releaseWakeLock();
    }
    if (session && autoJoin) engine.join(session);
    render();
    window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => route());
window.addEventListener('hashchange', () => route());

// ---------- setup view ----------

let delay = 30;
let checkToken = null;

function selectDelay(value) {
    delay = value;
    for (const chip of $('delayChips').children) {
        chip.setAttribute('aria-checked', String(Number(chip.dataset.delay) === value));
    }
}

$('delayChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) selectDelay(Number(chip.dataset.delay));
});
selectDelay(delay);

function setUrlStatus(state, text) {
    const el = $('urlStatus');
    el.dataset.state = state;
    el.textContent = text;
}

// Check that the browser can play the link, and whether precise mode will work.
function checkUrl() {
    const url = $('urlInput').value.trim();
    const token = (checkToken = {});
    if (!url) return setUrlStatus('', '');
    if (!/^https?:\/\/\S+$/i.test(url)) return setUrlStatus('bad', 'Paste a full link, starting with https://');
    setUrlStatus('', 'Checking the link…');

    const audio = new Audio();
    const meta = new Promise((resolve, reject) => {
        audio.onloadedmetadata = () => resolve(audio.duration);
        audio.onerror = reject;
        setTimeout(reject, 15000);
    });
    audio.preload = 'metadata';
    audio.src = url;
    const cors = fetch(url, { method: 'HEAD', credentials: 'omit' }).then(
        () => true,
        () => false
    );

    Promise.allSettled([meta, cors]).then(([m, c]) => {
        audio.removeAttribute('src');
        audio.load();
        if (checkToken !== token) return;
        if (m.status === 'rejected') {
            setUrlStatus('bad', 'Your browser can’t play this link. Is it a direct link to an audio file?');
        } else if (!Number.isFinite(m.value)) {
            setUrlStatus('bad', 'This looks like a live stream. SyncPlay needs a file with a fixed length.');
        } else if (c.value) {
            setUrlStatus('ok', `✓ Playable · ${fmtTime(m.value)} · precise sync`);
        } else {
            setUrlStatus(
                'warn',
                `✓ Playable · ${fmtTime(m.value)} · basic sync only: the file’s server doesn’t allow ` +
                    `precise mode (CORS). Beats may be a few ms apart.`
            );
        }
    });
}

let checkTimer;
$('urlInput').addEventListener('input', () => {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(checkUrl, 400);
});

$('setupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('urlInput').value.trim();
    if (!url) {
        $('urlInput').focus();
        return setUrlStatus('bad', 'Paste a link to a song first.');
    }
    if (!/^https?:\/\//i.test(url)) return setUrlStatus('bad', 'Paste a full link, starting with https://');
    localStorage.setItem('syncplay.lastUrl', url);
    // Round to a full second so the start time reads nicely.
    const start = Math.ceil((clock.now() + delay * 1000) / 1000) * 1000;
    engine.unlock(); // we're inside the tap, so audio is allowed now
    navigate(
        { url, start, pos: parsePosition($('posInput').value), loop: $('loopInput').checked },
        { autoJoin: true }
    );
});

// ---------- session view ----------

function enterSession() {
    probedDuration = null;
    countdownFrom = Math.max(0, session.start - clock.now());
    document.title = `${session.title} · SyncPlay`;
    $('trackTitle').textContent = session.title;
    $('trackSub').textContent =
        `${hostFromUrl(session.url)} · starts ${new Date(session.start).toLocaleTimeString()}` +
        (session.loop ? ' · looping' : '');

    const link = sessionLink(session);
    $('shareUrl').value = link;
    $('shareBtn').hidden = !navigator.share;
    const qr = $('qr');
    qr.replaceChildren();
    const drawQr = () => {
        try {
            new window.QRCode(qr, {
                text: link,
                width: 360,
                height: 360,
                colorDark: '#0b0b0f',
                colorLight: '#ffffff',
                correctLevel: window.QRCode.CorrectLevel.L,
            });
        } catch (e) {
            console.warn('Could not draw QR code:', e); // e.g. an extremely long link
            qr.replaceChildren();
        }
    };
    if (window.QRCode) drawQr();
    else window.addEventListener('load', () => window.QRCode && drawQr(), { once: true });

    // Learn the duration before joining, to show "finished" and progress.
    const probe = new Audio();
    const key = sessionKey(session);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
        if (sessionKey(session) === key && Number.isFinite(probe.duration)) probedDuration = probe.duration;
        probe.removeAttribute('src');
        probe.load();
        render();
    };
    probe.src = session.url;
}

$('joinBtn').addEventListener('click', () => {
    engine.unlock();
    engine.join(session);
});

$('leaveBtn').addEventListener('click', () => engine.leave());

$('replayBtn').addEventListener('click', () => {
    engine.unlock();
    const start = Math.ceil((clock.now() + 30_000) / 1000) * 1000;
    navigate({ ...session, start }, { autoJoin: true });
});

$('newSong').addEventListener('click', (e) => {
    e.preventDefault();
    $('urlInput').value = session?.url || '';
    navigate(null);
    checkUrl();
});

$('brand').addEventListener('click', (e) => {
    e.preventDefault();
    navigate(null);
});

$('copyBtn').addEventListener('click', async () => {
    const btn = $('copyBtn');
    try {
        await navigator.clipboard.writeText($('shareUrl').value);
        btn.textContent = 'Copied!';
    } catch {
        $('shareUrl').select();
        btn.textContent = 'Press ⌘C';
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1800);
});

$('shareUrl').addEventListener('focus', (e) => e.target.select());

$('shareBtn').addEventListener('click', () => {
    navigator
        .share({ title: `SyncPlay: ${session.title}`, text: 'Join and play this in sync with us', url: sessionLink(session) })
        .catch(() => {});
});

$('clockPill').addEventListener('click', () => {
    if (!session) return;
    const diag = $('diag');
    diag.open = true;
    diag.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// Latency nudge: tap to step 10 ms, hold to keep going.
let pendingLatency = engine.latencyMs;
let latencyTimer;
function stepLatency(step) {
    pendingLatency += step;
    renderLatency();
    clearTimeout(latencyTimer);
    latencyTimer = setTimeout(() => engine.setLatency(pendingLatency), 300);
}
function renderLatency() {
    const v = pendingLatency;
    $('latencyOut').textContent = v === 0 ? 'In sync' : `${Math.abs(v)} ms ${v > 0 ? 'earlier' : 'later'}`;
}
for (const btn of document.querySelectorAll('[data-step]')) {
    let hold;
    const stop = () => clearInterval(hold);
    btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const step = Number(btn.dataset.step);
        stepLatency(step);
        let n = 0;
        hold = setInterval(() => ++n > 4 && stepLatency(step), 90);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            stepLatency(Number(btn.dataset.step));
        }
    });
}
renderLatency();

// ---------- keep the screen on while playing ----------

let wakeLock = null;
async function holdWakeLock() {
    if (wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
    } catch {}
}
function releaseWakeLock() {
    wakeLock?.release();
    wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
    if (['waiting', 'playing'].includes(engine.state)) holdWakeLock();
});

// ---------- rendering ----------

function duration() {
    return engine.duration ?? probedDuration;
}

// Is the song over for everyone (and not looping)?
function isOver() {
    const d = duration();
    return !!(session && !session.loop && d && (clock.now() - session.start) / 1000 + session.pos >= d);
}

function render() {
    renderClock();
    if (!session) return;
    const state = engine.state;
    const over = state === 'ended' || (state === 'idle' && isOver());
    const started = clock.now() >= session.start;

    $('stage').dataset.state = over ? 'ended' : state;
    $('joinBtn').hidden = over || !['idle', 'error'].includes(state);
    $('joinBtn').textContent = state === 'error' ? 'Try again' : started ? 'Tap to join now' : 'Tap to join';
    $('replayBtn').hidden = !over;
    $('leaveBtn').hidden = !['loading', 'waiting', 'playing'].includes(state);
    $('tune').hidden = !['waiting', 'playing'].includes(state);

    const loading = state === 'loading';
    $('loadBar').hidden = !loading;
    $('loadBar').classList.toggle('indeterminate', loading && engine.progress == null);
    $('loadFill').style.width = loading && engine.progress != null ? `${engine.progress * 100}%` : '';

    const mode = engine.player?.mode;
    const badge = mode
        ? `<span class="badge ${mode}" title="${mode === 'basic' ? escapeHtml(engine.fallbackReason || '') : ''}">${mode === 'precise' ? 'Precise sync' : 'Basic sync'}</span>`
        : '';
    const status = {
        idle: over
            ? 'This song has finished. Start it again and share the new invite.'
            : started
              ? 'It’s already playing. Join and you’ll drop in at exactly the right spot.'
              : 'Tap join so your device is ready. It starts on its own.',
        loading:
            engine.progress == null
                ? 'Loading the song…'
                : engine.progress >= 1
                  ? 'Preparing audio…'
                  : `Loading the song… ${Math.round(engine.progress * 100)}%`,
        waiting: `You’re in. Starting in sync… ${badge}`,
        playing: `Playing in sync ${badge}`,
        ended: 'That’s the end of the song.',
        error: `<span class="error">${escapeHtml(engine.error || 'Something went wrong.')}</span>`,
    }[state];
    $('statusLine').innerHTML = status;

    if (['waiting', 'playing'].includes(state)) holdWakeLock();
    else releaseWakeLock();
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderClock() {
    const pill = $('clockPill');
    pill.dataset.state = clock.state;
    const precision = Math.max(1, Math.round((clock.spread ?? 0) / 2));
    $('clockText').textContent = {
        idle: 'Syncing clock…',
        syncing: 'Syncing clock…',
        synced: `Clock synced ±${precision} ms`,
        failed: 'Time server unreachable',
    }[clock.state];
    pill.title =
        clock.state === 'failed'
            ? 'Could not reach a time server, so this device’s own clock is used.'
            : 'This device’s clock is measured against a shared internet time server.';
}

function renderDiag() {
    const rows = [];
    const off = clock.offset;
    rows.push(['Time server', clock.source.name]);
    if (clock.rtt != null) {
        rows.push(['This device’s clock', `${fmtMs(off)} ${off > 0 ? 'behind' : 'ahead'} (corrected)`]);
        rows.push(['Network round trip', `${clock.rtt.toFixed(1)} ms · ${clock.samples.length} samples`]);
    }
    const p = engine.player;
    if (p) {
        rows.push([
            'Audio mode',
            p.mode === 'precise'
                ? 'Precise: Web Audio, sample-accurate'
                : `Basic: media element. ${engine.fallbackReason || ''}`,
        ]);
    }
    if (engine.ctx) {
        const lat = ((engine.ctx.baseLatency || 0) + (engine.ctx.outputLatency || 0)) * 1000;
        rows.push(['Output latency', `${lat.toFixed(0)} ms (compensated)`]);
    }
    if (engine.syncError != null && engine.state === 'playing') {
        rows.push([
            'Playback offset',
            `${(engine.syncError * 1000).toFixed(1)} ms · speed ×${p.rate.toFixed(4)}`,
        ]);
    }
    if (engine.latencyMs) rows.push(['Manual nudge', `${engine.latencyMs} ms`]);
    $('diagList').innerHTML = rows
        .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
        .join('');
}

clock.addEventListener('change', () => (session ? render() : renderClock()));
engine.addEventListener('change', render);

// Per-frame: countdown / position, progress ring, beat glow.
const freq = new Uint8Array(512);
let pulse = 0;
let lastSecond = null;
let lastDiag = 0;

function frame(t) {
    requestAnimationFrame(frame);
    if (!session) return;
    const now = clock.now();
    const d = duration();
    let big, label, progress;

    if (now < session.start) {
        const remaining = session.start - now;
        big = fmtTime(Math.ceil(remaining / 1000));
        label = 'until start';
        progress = countdownFrom ? 1 - remaining / countdownFrom : 0;
    } else if (isOver() || engine.state === 'ended') {
        big = d ? fmtTime(d) : '–';
        label = 'finished';
        progress = 1;
    } else {
        let pos = (now - session.start) / 1000 + session.pos;
        if (session.loop && d) pos %= d;
        big = fmtTime(pos);
        label = d ? `of ${fmtTime(d)}` : 'playing now';
        progress = d ? pos / d : 0;
    }
    $('bigTime').textContent = big;
    $('bigLabel').textContent = label;
    $('ringFg').style.strokeDashoffset = String(1 - Math.min(1, Math.max(0, progress)));

    // Beat glow from the low end of the spectrum (precise mode only).
    let target = 0;
    if (engine.state === 'playing' && engine.player?.mode === 'precise') {
        engine.analyser.getByteFrequencyData(freq);
        target = Math.max(0, ((freq[1] + freq[2] + freq[3] + freq[4]) / 4 / 255 - 0.45) / 0.55);
    }
    pulse += (target - pulse) * (target > pulse ? 0.6 : 0.15);
    $('stage').style.setProperty('--pulse', pulse.toFixed(3));

    // Re-render when crossing the start or end so buttons/status update.
    const second = Math.floor(now / 1000);
    if (second !== lastSecond) {
        const crossed = lastSecond != null && (lastSecond * 1000 < session.start) !== (now < session.start);
        lastSecond = second;
        if (crossed || engine.state === 'idle') render();
    }
    if (t - lastDiag > 250 && $('diag').open) {
        lastDiag = t;
        renderDiag();
    }
}

// ---------- start ----------

$('urlInput').value = localStorage.getItem('syncplay.lastUrl') || '';
if ($('urlInput').value) checkUrl();
route();
requestAnimationFrame(frame);
$('diag').addEventListener('toggle', renderDiag);
