/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createRuntime } from './runtime.mjs';

const live = process.env.NIGHTCORD_REALTIME_LIVE === '1';
const turnTransport = process.env.NIGHTCORD_REALTIME_TRANSPORT || '';
assert.ok(['', 'tcp', 'tls'].includes(turnTransport));
const relayOnly = process.env.NIGHTCORD_REALTIME_RELAY === '1' || !!turnTransport;
const failEarly = process.env.NIGHTCORD_VOICE_FAIL_EARLY === '1';
// This is a local protocol fixture with real browser RTP, not a Cloudflare
// connectivity test unless NIGHTCORD_REALTIME_LIVE=1 explicitly enables it.
test('two browsers carry audio, keep DTX subscriptions across mute, and clean up on room change', { timeout: 180000 }, async () => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const artifacts = join(root, '.qa-artifacts', (live ? relayOnly ? 'voice-cloudflare-turn' : 'voice-cloudflare' : 'voice') + (turnTransport ? `-${turnTransport}` : '') + (failEarly ? '-fallback' : ''));
  const secrets = live ? Object.fromEntries((await readFile(join(root, 'backend/.dev.vars'), 'utf8')).split(/\r?\n/).map(line => /^(REALTIME_[A-Z_]+)=(.*)$/.exec(line)).filter(Boolean).map(match => [match[1], match[2]])) : {};
  const cloudSessions = new Map(), turnUsers = new Set();
  const temp = await mkdtemp(join(tmpdir(), 'nightcord-voice-'));
  const wav = Buffer.alloc(44 + 48000 * 2 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 96000; i++) wav.writeInt16LE(Math.round(9000 * Math.sin(i * 2 * Math.PI * 440 / 48000)), 44 + 2 * i);
  const tonePath = join(temp, 'tone.wav'); await writeFile(tonePath, wav);
  const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/relay') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Local media relay</title>'); return; }
      const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/\/$/, '/index.html'));
      if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream'); res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  let runtime, browser;
  const pages = [], calls = [];
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.NIGHTCORD_TEST_CHROMIUM || undefined, args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${tonePath.replaceAll('\\', '/')}`, '--autoplay-policy=no-user-gesture-required',
    ] });
    const relay = await browser.newPage(); await relay.goto(`${origin}/relay`);
    await relay.evaluate(() => {
      window.sessions = new Map();
      window.sfu = async ({ path, body }) => {
        const gather = pc => pc.iceGatheringState === 'complete' ? Promise.resolve() : new Promise(resolve => pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); }));
        if (path.endsWith('/sessions/new')) {
          const sessionId = crypto.randomUUID(), pc = new RTCPeerConnection({ iceServers: [] });
          const session = { pc, tracks: [], received: null };
          session.ready = new Promise(resolve => pc.addEventListener('track', event => {
            // Pull remote samples through Web Audio; an unconsumed remote audio
            // track need not be decoded by a headless browser.
            session.audioContext = new AudioContext();
            const stream = new MediaStream([event.track]);
            session.sink = document.createElement('audio'); session.sink.srcObject = stream; session.sink.volume = 0;
            document.body.append(session.sink); void session.sink.play();
            session.source = session.audioContext.createMediaStreamSource(stream);
            const output = session.audioContext.createMediaStreamDestination();
            session.source.connect(output); session.received = output.stream.getAudioTracks()[0];
            void session.audioContext.resume().then(resolve);
          }, { once: true }));
          window.sessions.set(sessionId, session); return { sessionId };
        }
        const [, id, operation] = /\/sessions\/([^/]+)(.*)/.exec(path);
        const session = window.sessions.get(id), pc = session.pc;
        if (!operation) return { tracks: session.tracks };
        if (operation === '/tracks/new') {
          const remote = body.tracks[0].location === 'remote';
          if (remote) {
            for (const track of body.tracks) {
              const source = window.sessions.get(track.sessionId); await source.ready;
              const transceiver = pc.addTransceiver(source.received, { direction: 'sendonly' });
              session.tracks.push({ ...track, transceiver, status: 'active' });
            }
            await pc.setLocalDescription(await pc.createOffer());
            session.tracks.forEach(track => { track.mid = track.transceiver.mid; });
          } else {
            await pc.setRemoteDescription(body.sessionDescription);
            session.tracks = body.tracks.map(track => ({ ...track, status: 'active' }));
            await pc.setLocalDescription(await pc.createAnswer());
          }
          await gather(pc);
          return { sessionDescription: pc.localDescription.toJSON(), tracks: session.tracks.map(({ transceiver, ...track }) => track), requiresImmediateRenegotiation: remote };
        }
        if (operation === '/renegotiate') { await pc.setRemoteDescription(body.sessionDescription); return {}; }
        if (operation === '/tracks/close') {
          pc.close(); void session.audioContext?.close(); session.sink?.remove(); session.tracks.forEach(track => { track.status = 'inactive'; }); return { tracks: body.tracks };
        }
        throw new Error(`Unknown fixture operation: ${path}`);
      };
    });
    runtime = createRuntime({}, {
      origin, identities: { 'Bearer voice-one': 'voice-one', 'Bearer voice-two': 'voice-two' },
      bindings: { VOICE_MODE: 'on', VOICE_ALLOWED_ROOMS: 'nightcord-test', VOICE_REQUIRE_PASS: 'false', REALTIME_SFU_APP_ID: 'fixture', REALTIME_SFU_APP_SECRET: 'fixture', REALTIME_TURN_KEY_ID: 'fixture', REALTIME_TURN_API_TOKEN: 'fixture', ...secrets },
      outboundService: async request => {
        const path = new URL(request.url).pathname;
        calls.push(path);
        if (live) {
          const body = request.method === 'GET' ? undefined : await request.arrayBuffer();
          const upstream = await fetch(request.url, { method: request.method, headers: request.headers, body, signal: request.signal });
          // Node fetch decompresses upstream bodies; drop the original encoding
          // and length headers before passing the response back into workerd.
          const bytes = await upstream.arrayBuffer(), headers = new Headers(upstream.headers);
          headers.delete('content-encoding'); headers.delete('content-length');
          const response = new Response(upstream.status === 204 ? null : bytes, { status: upstream.status, headers });
          const data = await response.clone().json().catch(() => ({}));
          calls.push({ status: response.status, errorCode: data.errorCode, operation: path.split('/').slice(-2).join('/') });
          if (path.endsWith('/sessions/new') && data.sessionId) cloudSessions.set(data.sessionId, new Set());
          const session = /\/sessions\/([^/]+)\//.exec(path)?.[1];
          const inspected = /\/sessions\/([^/]+)$/.exec(path)?.[1];
          if (inspected && [404, 410].includes(response.status)) cloudSessions.get(inspected)?.clear();
          if (session && path.endsWith('/tracks/new')) for (const track of data.tracks || []) if (track.mid) cloudSessions.get(session)?.add(track.mid);
          if (session && path.endsWith('/tracks/close') && response.ok && !data.errorCode) for (const track of data.tracks || []) if (!track.errorCode) cloudSessions.get(session)?.delete(track.mid);
          for (const server of data.iceServers || []) if (server.username) turnUsers.add(server.username);
          return response;
        }
        if (path.endsWith('/generate-ice-servers')) return Response.json({ iceServers: [] });
        if (path.endsWith('/revoke')) return new Response(null, { status: 204 });
        const body = await request.json().catch(() => ({}));
        return Response.json(await relay.evaluate(input => window.sfu(input), { path, body }));
      },
    });
    const apiBase = String(await runtime.ready).replace(/\/$/, ''), wsBase = apiBase.replace(/^http/, 'ws');
    const errors = [];
    async function pageFor(identity, viewport, { joinVoice = true } = {}) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...(viewport.width < 768 ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36' } : {}) });
      await context.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith(apiBase) ? route.continue() : route.abort());
      await context.addInitScript(({ apiBase, wsBase, identity }) => {
        const nativeFetch = window.fetch.bind(window), NativeWebSocket = window.WebSocket;
        window.fetch = (url, options) => nativeFetch(String(url).replace('https://chat.nightcord.de5.net', apiBase), options);
        window.WebSocket = class extends NativeWebSocket { constructor(url, protocols) { super(String(url).replace('wss://chat.nightcord.de5.net', wsBase), protocols); } };
        localStorage.setItem('nightcord-username', 'Voice guest');
        if (identity) {
          localStorage.setItem('sekai_pass_access_token', identity);
          localStorage.setItem('sekai_pass_expires_at', String(Date.now() + 3600000));
          localStorage.setItem('sekai_pass_user', JSON.stringify({ sub: identity, name: 'Voice fixture' }));
        }
      }, { apiBase, wsBase, identity });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      pages.push(page);
      await page.goto(`${origin}/?test`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => nightcord.chatRoom.wsManager.ready && nightcord.voice.state.available);
      await page.evaluate(({ relayOnly, turnTransport, failEarly }) => {
        const manager = nightcord.voice;
        if (relayOnly) manager.peerFactory = config => {
          if (turnTransport) config = { ...config, iceServers: config.iceServers.flatMap(server => {
            const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url => turnTransport === 'tls' ? url.startsWith('turns:') : url.startsWith('turn:') && url.includes('transport=tcp'));
            return urls.length ? [{ ...server, urls }] : [];
          }) };
          return new RTCPeerConnection({ ...config, iceTransportPolicy: 'relay' });
        };
        window.gathering = []; window.connectionFaults = [];
        const originalGather = manager.gather, originalConnected = manager.connected;
        const injected = new Set();
        manager.gather = async function (pc, timeout, options) {
          const start = Date.now(), role = this.publisher === pc ? 'publisher' : 'receiver';
          const early = await originalGather.call(this, pc, timeout, options);
          window.gathering.push({ role, full: options?.full === true, early, ms: Date.now() - start });
          return failEarly && !options?.full ? true : early;
        };
        manager.connected = async function (pc) {
          const role = this.publisher === pc ? 'publisher' : 'receiver';
          if (failEarly && !injected.has(role)) { injected.add(role); window.connectionFaults.push(role); throw this.error('connection_failed'); }
          return originalConnected.call(this, pc);
        };
      }, { relayOnly, turnTransport, failEarly });
      await page.evaluate(() => { window.voiceStates = []; window.voiceErrors = []; const handle = nightcord.voice.handleError.bind(nightcord.voice); nightcord.voice.handleError = error => { window.voiceErrors.push({ code: error.code, name: error.name }); handle(error); }; nightcord.eventBus.on('voice:changed', state => window.voiceStates.push({ message: state.message, count: state.members.length, receiver: nightcord.voice.receiver?.connectionState, signature: nightcord.voice.receiverSignature })); });
      if (joinVoice) {
        await page.locator('[data-voice-toggle]').click();
        await page.locator('[data-voice-join]').click();
        await page.waitForFunction(() => nightcord.voice.state.joined);
        await page.waitForFunction(() => !nightcord.voice.state.busy);
        assert.equal(await page.locator('#voice-panel').isVisible(), true, 'joining voice keeps the panel open');
        assert.equal(await page.locator('[data-voice-mic]').evaluate(node => node === document.activeElement), true, 'joining moves focus to the microphone control');
        await page.locator('.voice-close').click();
        await page.waitForFunction(() => !document.querySelector('#voice-panel').matches(':popover-open'));
      }
      return page;
    }
    async function openVoice(page) {
      if (!await page.locator('#voice-panel').isVisible()) await page.locator('[data-voice-toggle]').click();
      await page.waitForFunction(() => document.querySelector('[data-voice-toggle]').getAttribute('aria-expanded') === 'true');
      await page.waitForFunction(() => !document.querySelector('#voice-panel').getAnimations().some(animation => animation.playState === 'running'));
    }
    const one = await pageFor(null, { width: 1280, height: 900 });
    const two = await pageFor('voice-two', { width: 320, height: 740 });
    const observer = await pageFor('voice-one', { width: 1280, height: 900 }, { joinVoice: false });
    assert.equal(await observer.locator('#voice-users .voice-user').count(), 2, 'late text-only observer receives the initial voice roster');
    assert.equal(await observer.locator('#online-users .voice-user').count(), 1);
    assert.equal(await observer.locator('#voice-users [data-user-id="sekai:voice-two"] .member-presence').getAttribute('data-presence'), 'mobile');
    assert.equal(await observer.locator('#voice-users .member-microphone[data-microphone="false"]').count(), 2);
    assert.equal(await one.evaluate(() => nightcord.chatRoom.currentUser.authenticated), false, 'guest can join voice using their signed cookie');
    assert.equal(await one.evaluate(() => nightcord.voice.capture == null), true, 'joining does not request a microphone');
    assert.equal(await observer.locator('#voice-panel').isVisible(), false, 'voice controls stay out of the conversation by default');
    const messageBounds = await observer.locator('#messages').boundingBox();
    await openVoice(observer);
    assert.deepEqual(await observer.locator('#messages').boundingBox(), messageBounds, 'opening voice does not resize or move messages');
    await observer.keyboard.press('Escape');
    await observer.waitForFunction(() => document.querySelector('[data-voice-toggle]').getAttribute('aria-expanded') === 'false');
    assert.equal(await observer.locator('[data-voice-toggle]').evaluate(node => node === document.activeElement), true, 'Escape returns focus to the voice entry');
    await openVoice(observer);
    await observer.locator('#messageInput').focus();
    assert.equal(await observer.locator('#voice-panel').isVisible(), false, 'returning keyboard focus to chat dismisses voice');
    assert.equal(await observer.locator('#messageInput').evaluate(node => node === document.activeElement), true);
    const firstMicrophoneAt = Date.now();
    await one.locator('[data-voice-quick-mic]').click();
    await one.waitForFunction(() => nightcord.voice.state.microphone || window.voiceErrors.length, null, { timeout: live ? 45000 : 20000 });
    assert.ok(await one.evaluate(() => nightcord.voice.state.microphone), JSON.stringify(await one.evaluate(() => window.voiceErrors)));
    const microphoneReadyMs = Date.now() - firstMicrophoneAt;
    await observer.waitForFunction(() => document.querySelector('#voice-users [data-user-id^="guest:"] .member-microphone')?.dataset.microphone === 'true');
    await two.waitForFunction(() => nightcord.voice.receiver?.connectionState === 'connected', null, { timeout: live ? 45000 : 25000 });
    let audio;
    for (let attempt = 0; attempt < 100; attempt++) {
      audio = await two.evaluate(async () => {
        const receiver = nightcord.voice.receiver;
        if (!receiver || receiver.connectionState !== 'connected') return {};
        const stats = await receiver.getStats();
        const inbound = [...stats.values()].find(stat => stat.type === 'inbound-rtp' && stat.kind === 'audio');
        const player = [...nightcord.voice.playbacks.values()][0]?.audio;
        return { bytesReceived: inbound?.bytesReceived, totalAudioEnergy: inbound?.totalAudioEnergy, playing: player && !player.paused, time: player?.currentTime };
      });
      if (audio.bytesReceived > 1000 && audio.totalAudioEnergy > 0.0001 && audio.playing && audio.time > 0) break;
      await delay(100);
    }
    assert.ok(audio.bytesReceived > 1000 && audio.totalAudioEnergy > 0.0001 && audio.playing && audio.time > 0, JSON.stringify(audio));
    const firstAudioMs = Date.now() - firstMicrophoneAt;
    if (failEarly) {
      assert.deepEqual(await one.evaluate(() => window.connectionFaults), ['publisher']);
      assert.deepEqual(await two.evaluate(() => window.connectionFaults), ['receiver']);
      assert.equal(await one.evaluate(() => window.gathering.some(value => value.role === 'publisher' && value.full)), true);
      assert.equal(await two.evaluate(() => window.gathering.some(value => value.role === 'receiver' && value.full)), true);
    }
    const connection = await two.evaluate(async () => {
      const stats = await nightcord.voice.receiver.getStats();
      const transport = [...stats.values()].find(stat => stat.type === 'transport' && stat.selectedCandidatePairId);
      const pair = stats.get(transport?.selectedCandidatePairId), local = stats.get(pair?.localCandidateId);
      return { candidateType: local?.candidateType, protocol: local?.protocol, relayProtocol: local?.relayProtocol };
    });
    if (relayOnly) assert.equal(connection.candidateType, 'relay');
    if (turnTransport) assert.equal(connection.relayProtocol, turnTransport);
    await mkdir(artifacts, { recursive: true });
    await one.screenshot({ path: join(artifacts, 'desktop-collapsed.png') }); await two.screenshot({ path: join(artifacts, 'mobile-collapsed.png') });
    await openVoice(one); await openVoice(two);
    const reminder = await two.evaluate(() => {
      const manager = nightcord.voice, node = document.querySelector('[data-voice-usage-reminder]');
      const focus = document.activeElement, receiver = manager.receiver, playback = [...manager.playbacks.values()][0].audio;
      const daily = { usedMinutes: 120, reservedMinutes: 1, limitMinutes: 240, resetsAt: Date.now() + 3600000 };
      // Exercise daily totals returned after joins/heartbeats without consuming hours or altering media state.
      const render = (value, overrides = {}) => nightcord.eventBus.emit('voice:changed', {
        ...manager.state, memberId: manager.membership.memberId, usage: value ? { daily: value } : null, ...overrides,
      });
      render({ ...daily, usedMinutes: 119.9 });
      const below = node.hidden;
      render(daily);
      const reached = !node.hidden && !node.parentElement.hidden;
      const text = node.textContent, textNode = node.firstChild;
      render({ ...daily, usedMinutes: 121 });
      const stable = node.firstChild === textNode;
      const uninterrupted = manager.state.joined && manager.receiver === receiver && receiver.connectionState === 'connected'
        && [...manager.playbacks.values()][0].audio === playback && !playback.paused && document.activeElement === focus;
      render({ ...daily, limitMinutes: 300 });
      const configured = node.textContent.includes('5 小时');
      render({ ...daily, resetsAt: Date.now() - 1 });
      const expired = node.hidden;
      render({ ...daily, usedMinutes: 0, resetsAt: daily.resetsAt + 86400000 });
      const nextDay = node.hidden;
      render(null);
      const missing = node.hidden;
      render(daily, { joined: false });
      const left = node.hidden;
      render(daily);
      return { below, reached, text, stable, uninterrupted, configured, expired, nextDay, missing, left,
        toolbar: document.querySelector('[data-voice-label]').textContent,
        fits: node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().bottom <= document.querySelector('.voice-display').getBoundingClientRect().bottom };
    });
    assert.deepEqual(reminder, {
      below: true, reached: true, text: '今天已累计使用语音 2 小时；每日上限 4 小时，到时将自动结束。',
      stable: true, uninterrupted: true, configured: true, expired: true, nextDay: true, missing: true, left: true,
      toolbar: '时长提醒', fits: true,
    }, 'the two-hour reminder uses actual daily minutes, survives updates, and leaves audio and focus alone');
    await two.screenshot({ path: join(artifacts, 'mobile-usage-reminder.png') });
    await two.locator('.voice-close').click();
    assert.equal(await two.locator('[data-voice-label]').textContent(), '时长提醒', 'the closed panel keeps its time reminder visible in the voice entry');
    await two.evaluate(() => nightcord.voice.emit());
    await openVoice(two);
    await one.locator('.voice-member-line:not(button)').click();
    assert.equal(await one.locator('#voice-panel').isVisible(), true, 'clicking your own participant row keeps the voice panel open');
    const memberListBounds = await one.locator('[data-voice-members]').boundingBox();
    await one.locator('[data-voice-members]').click({ position: { x: 10, y: memberListBounds.height - 4 } });
    assert.equal(await one.locator('#voice-panel').isVisible(), true, 'clicking the participant list background keeps the voice panel open');
    await one.locator('[data-voice-settings]').click();
    assert.equal(await one.locator('[data-voice-layer="call"]').evaluate(node => node.inert), true, 'covered call controls cannot receive input');
    assert.equal(await one.locator('[data-voice-layer="menu"]').evaluate(node => node.inert), false, 'the upper page receives input');
    assert.equal(await one.locator('[data-voice-menu-status]').isVisible(), false, 'input settings omit the call connection status');
    assert.equal(await one.locator('[data-voice-device]').evaluate(node => node === document.activeElement), false, 'pointer navigation does not autofocus the microphone selector');
    await one.locator('[data-voice-device]').click();
    assert.equal(await one.locator('#voice-panel').isVisible(), true, 'opening the native microphone list does not dismiss voice');
    assert.equal(await one.locator('[data-voice-device]').evaluate(node => node === document.activeElement), true, 'the microphone list keeps its own focus');
    await one.keyboard.press('Escape');
    assert.equal(await one.locator('[data-voice-view="device"]').isVisible(), true, 'Escape first dismisses the native device list');
    await one.locator('[data-voice-back]').click();
    await one.locator('[data-voice-member]').click();
    assert.equal(await one.locator('[data-voice-volume]').evaluate(node => node === document.activeElement), false, 'pointer navigation does not autofocus the member volume');
    await one.locator('[data-voice-volume]').click({ position: { x: 80, y: 22 } });
    assert.equal(await one.locator('#voice-panel').isVisible(), true, 'adjusting a volume slider keeps the voice panel open');
    assert.equal(await one.locator('[data-voice-volume]').evaluate(node => node === document.activeElement), true);
    await one.keyboard.press('Escape');
    assert.equal(await one.locator('[data-voice-view="call"]').isVisible(), true);
    assert.equal(await one.locator('[data-voice-layer="menu"]').evaluate(node => node.inert), true, 'the outgoing page stops receiving input immediately');
    assert.equal(await one.locator('[data-voice-member]').evaluate(node => node === document.activeElement), true, 'keyboard back navigation restores the participant trigger');
    await one.keyboard.press('Enter');
    assert.equal(await one.locator('[data-voice-volume]').evaluate(node => node === document.activeElement), true, 'keyboard navigation focuses the volume control');
    await one.keyboard.press('ArrowRight');
    await one.keyboard.press('Escape');
    await one.locator('[data-voice-settings]').focus();
    await one.keyboard.press('Enter');
    assert.equal(await one.locator('[data-voice-device]').evaluate(node => node === document.activeElement), true, 'keyboard navigation focuses the microphone selector');
    await one.keyboard.press('Escape');
    assert.equal(await one.locator('[data-voice-settings]').evaluate(node => node === document.activeElement), true, 'keyboard back navigation restores the device trigger');
    await one.locator('#messageInput').click();
    assert.equal(await one.locator('#voice-panel').isVisible(), false, 'clicking outside still dismisses the voice panel');
    assert.equal(await one.locator('#messageInput').evaluate(node => node === document.activeElement), true);
    await openVoice(one);
    assert.equal(await two.locator('[data-voice-volume]').isVisible(), false, 'the call display shows participants without permanent volume sliders');
    const callKeys = await two.locator('.voice-controls').boundingBox();
    await two.locator('[data-voice-settings]').click();
    assert.deepEqual(await two.locator('.voice-controls').boundingBox(), callKeys, 'input selection keeps the call keys in place');
    assert.ok(await two.locator('#voice-panel').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return node.scrollWidth <= node.clientWidth && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    }), 'expanded voice panel and device settings fit 320px');
    await one.screenshot({ path: join(artifacts, 'desktop.png') }); await two.screenshot({ path: join(artifacts, 'mobile.png') });
    await observer.screenshot({ path: join(artifacts, 'sidebar-desktop.png') });
    await two.getByRole('button', { name: '切换成员列表' }).click();
    await two.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().left === 0);
    await two.screenshot({ path: join(artifacts, 'sidebar-mobile.png') });
    assert.ok(await two.locator('.sidebar-content').evaluate(node => node.scrollWidth <= node.clientWidth), 'member groups fit the mobile drawer');
    await two.mouse.click(305, 400);
    await two.waitForFunction(() => !document.querySelector('.sidebar').classList.contains('show'));
    await openVoice(two);
    await two.locator('[data-voice-member]').click();
    assert.deepEqual(await two.locator('.voice-controls').boundingBox(), callKeys, 'member volume keeps the call keys in place');
    await two.locator('.voice-volume input').fill('0.25');
    assert.equal(await two.evaluate(() => [...nightcord.voice.playbacks.values()][0].audio.volume), 0.25);
    assert.equal(await two.locator('.voice-volume output').textContent(), '25%', 'volume readout reflects the actual playback volume');
    assert.equal(await two.locator('.voice-volume input').getAttribute('aria-valuetext'), '25%');
    await two.keyboard.press('Escape');
    assert.equal(await two.locator('#voice-panel').isVisible(), true, 'Escape returns from a display menu before closing the terminal');
    assert.equal(await two.locator('[data-voice-view="call"]').isVisible(), true);
    await two.locator('[data-voice-member]').click();
    assert.equal(await two.locator('.voice-volume input').inputValue(), '0.25', 'the member display restores the selected listening volume');
    await one.evaluate(() => { window.originalTrack = nightcord.voice.capture.getAudioTracks()[0]; window.originalPublisher = nightcord.voice.publisher; });
    await two.evaluate(() => { window.originalReceiver = nightcord.voice.receiver; window.originalAudio = [...nightcord.voice.playbacks.values()][0].audio; });
    const originalVersion = await two.evaluate(() => nightcord.voice.state.members.find(member => member.memberId !== nightcord.voice.membership.memberId).publicationVersion);
    const allocations = calls.filter(call => typeof call === 'string' && call.endsWith('/sessions/new')).length;
    await openVoice(one);
    await one.locator('[data-voice-mic]').click();
    assert.equal(await one.evaluate(() => window.originalTrack.readyState), 'ended');
    assert.equal(await one.locator('[data-voice-mic] .voice-mic-off').isVisible(), true, 'microphone icons survive status updates');
    await two.waitForFunction(() => nightcord.voice.state.members.some(member => member.memberId !== nightcord.voice.membership.memberId && member.publishing && member.microphone === false));
    await observer.waitForFunction(() => document.querySelector('#voice-users [data-user-id^="guest:"] .member-microphone')?.dataset.microphone === 'false');
    assert.equal(await one.evaluate(() => nightcord.voice.capture), null, 'muting releases microphone capture');
    assert.equal(await one.evaluate(() => nightcord.voice.publisher === window.originalPublisher), true);
    assert.equal(await two.evaluate(() => nightcord.voice.receiver === window.originalReceiver && [...nightcord.voice.playbacks.values()][0].audio === window.originalAudio), true, 'mute preserves the receiver and its playback element');
    async function mediaStats(page, direction) {
      return page.evaluate(async direction => {
        const pc = direction === 'outbound-rtp' ? nightcord.voice.publisher : nightcord.voice.receiver;
        const report = await pc.getStats(), stats = [...report.values()].find(stat => stat.type === direction && stat.kind === 'audio');
        return { at: Date.now(), packets: stats.packetsSent ?? stats.packetsReceived, bytes: stats.bytesSent ?? stats.bytesReceived, headerBytes: stats.headerBytesSent ?? stats.headerBytesReceived, energy: stats.totalAudioEnergy || 0 };
      }, direction);
    }
    await delay(live ? 3000 : 1000);
    const quietStart = { publisher: await mediaStats(one, 'outbound-rtp'), receiver: await mediaStats(two, 'inbound-rtp') };
    await delay(live ? 35000 : 3000);
    const quietEnd = { publisher: await mediaStats(one, 'outbound-rtp'), receiver: await mediaStats(two, 'inbound-rtp') };
    const rate = (start, end) => (end.packets - start.packets) * 1000 / (end.at - start.at);
    const muted = { seconds: (quietEnd.publisher.at - quietStart.publisher.at) / 1000,
      publisherPacketsPerSecond: rate(quietStart.publisher, quietEnd.publisher), receiverPacketsPerSecond: rate(quietStart.receiver, quietEnd.receiver) };
    assert.ok(muted.publisherPacketsPerSecond > 0 && muted.publisherPacketsPerSecond < 15, `DTX must reduce silent publishing packets: ${JSON.stringify(muted)}`);
    if (live) assert.ok(muted.receiverPacketsPerSecond > 0 && muted.receiverPacketsPerSecond < 15, `SFU must preserve the packet savings: ${JSON.stringify(muted)}`);
    assert.ok(quietEnd.receiver.energy - quietStart.receiver.energy < 0.0001, 'muting must stop real audio energy');
    const resumeAt = Date.now();
    await one.locator('[data-voice-mic]').click();
    await one.waitForFunction(() => nightcord.voice.state.microphone);
    let resumed;
    for (let retry = 0; retry < 100; retry++) {
      resumed = await mediaStats(two, 'inbound-rtp');
      if (resumed.energy > quietEnd.receiver.energy + 0.0001) break;
      await delay(50);
    }
    assert.ok(resumed.energy > quietEnd.receiver.energy + 0.0001, 'real audio must resume on the existing subscription');
    const resumeMs = resumed.at - resumeAt;
    assert.ok(resumeMs < 5000, `warm unmute must avoid ICE and publication setup: ${resumeMs} ms`);
    assert.equal(await one.evaluate(() => nightcord.voice.publisher === window.originalPublisher), true);
    assert.equal(await two.evaluate(() => nightcord.voice.receiver === window.originalReceiver && [...nightcord.voice.playbacks.values()][0].audio === window.originalAudio), true);
    assert.equal(await two.evaluate(() => nightcord.voice.state.members.find(member => member.memberId !== nightcord.voice.membership.memberId).publicationVersion), originalVersion);
    assert.equal(calls.filter(call => typeof call === 'string' && call.endsWith('/sessions/new')).length, allocations, 'mute and reopen allocate no new SFU sessions');
    assert.equal(await two.evaluate(() => [...nightcord.voice.playbacks.values()][0].audio.volume), 0.25, 'warm unmute preserves the chosen volume');
    await one.evaluate(() => { window.lastTrack = nightcord.voice.capture.getAudioTracks()[0]; nightcord.joinRoom('voice-other'); });
    assert.equal(await one.evaluate(() => window.lastTrack.readyState), 'ended');
    await two.waitForFunction(() => nightcord.voice.state.members.length === 1 && nightcord.voice.playbacks.size === 0);
    assert.equal(await two.locator('[data-voice-view="call"]').isVisible(), true, 'a departing member returns the terminal to the call display');
    await openVoice(two);
    await two.locator('[data-voice-leave]').click();
    await two.waitForFunction(() => !nightcord.voice.state.joined);
    await observer.waitForFunction(() => !document.querySelector('#voice-users .voice-user') && document.querySelectorAll('#online-users .voice-user').length === 2);
    await two.evaluate(() => nightcord.chatRoom.leave());
    await observer.waitForFunction(() => document.querySelector('#offline-users [data-user-id="sekai:voice-two"]'));
    await observer.screenshot({ path: join(artifacts, 'sidebar-offline.png') });
    if (!live) await relay.waitForFunction(() => [...window.sessions.values()].every(session => session.pc.connectionState === 'closed'));
    else {
      for (let i = 0; i < 100 && [...cloudSessions.values()].some(mids => mids.size); i++) await delay(100);
      assert.ok([...cloudSessions.values()].every(mids => !mids.size), 'backend must confirm Cloudflare forwarding cleanup');
    }
    assert.deepEqual(errors, []);
    const gathering = await Promise.all([one, two].map(page => page.evaluate(() => window.gathering)));
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ fixture: live ? 'Cloudflare SFU/TURN with local application/auth fixture' : 'local native WebRTC relay; no Cloudflare media connection', relayOnly, turnTransport, failEarly, ...connection, ...audio, microphoneReadyMs, firstAudioMs, gathering, muted, resumeMs }, null, 2));
  } catch (error) {
    await mkdir(artifacts, { recursive: true });
    const diagnostics = await Promise.all(pages.map(page => page.evaluate(async () => ({ states: window.voiceStates, errors: window.voiceErrors, publisher: nightcord.voice.publisher?.connectionState, receiver: nightcord.voice.receiver?.connectionState, stats: await Promise.all([nightcord.voice.publisher, nightcord.voice.receiver].filter(Boolean).map(async pc => [...(await pc.getStats()).values()].filter(stat => ['inbound-rtp', 'outbound-rtp', 'media-source'].includes(stat.type)))) })).catch(() => ({}))));
    await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ diagnostics, calls }, null, 2));
    throw error;
  } finally {
    await browser?.close(); await runtime?.dispose();
    try { if (live) {
      for (const [id, mids] of cloudSessions) if (mids.size) {
        const response = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${secrets.REALTIME_SFU_APP_ID}/sessions/${id}/tracks/close`, { method: 'PUT', headers: { Authorization: `Bearer ${secrets.REALTIME_SFU_APP_SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true, tracks: [...mids].map(mid => ({ mid })) }), signal: AbortSignal.timeout(15000) });
        assert.ok(response.ok || [404, 410].includes(response.status), `Live test media cleanup failed: ${response.status}`);
      }
      for (const username of turnUsers) await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${secrets.REALTIME_TURN_KEY_ID}/credentials/${encodeURIComponent(username)}/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${secrets.REALTIME_TURN_API_TOKEN}` }, signal: AbortSignal.timeout(15000) });
    } } finally {
    await new Promise(done => server.close(done));
    assert.ok(resolve(temp).startsWith(resolve(tmpdir(), 'nightcord-voice-')));
    await rm(temp, { recursive: true, force: true });
    }
  }
});
