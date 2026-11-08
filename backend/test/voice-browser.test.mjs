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
const relayOnly = process.env.NIGHTCORD_REALTIME_RELAY === '1';
// This is a local protocol fixture with real browser RTP, not a Cloudflare
// connectivity test unless NIGHTCORD_REALTIME_LIVE=1 explicitly enables it.
test('two browsers carry audio through signaling, mute/reopen, and clean up on room change', { timeout: 120000 }, async () => {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const artifacts = join(root, '.qa-artifacts', live ? relayOnly ? 'voice-cloudflare-turn' : 'voice-cloudflare' : 'voice');
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
    async function pageFor(identity, viewport) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
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
      if (relayOnly) await page.evaluate(() => { nightcord.voice.peerFactory = config => new RTCPeerConnection({ ...config, iceTransportPolicy: 'relay' }); });
      await page.evaluate(() => { window.voiceStates = []; window.voiceErrors = []; const handle = nightcord.voice.handleError.bind(nightcord.voice); nightcord.voice.handleError = error => { window.voiceErrors.push({ code: error.code, name: error.name }); handle(error); }; nightcord.eventBus.on('voice:changed', state => window.voiceStates.push({ message: state.message, count: state.members.length, receiver: nightcord.voice.receiver?.connectionState, signature: nightcord.voice.receiverSignature })); });
      await page.locator('[data-voice-join]').click();
      await page.waitForFunction(() => nightcord.voice.state.joined);
      return page;
    }
    const one = await pageFor(null, { width: 1280, height: 900 });
    const two = await pageFor('voice-two', { width: 320, height: 740 });
    assert.equal(await one.evaluate(() => nightcord.chatRoom.currentUser.authenticated), false, 'guest can join voice using their signed cookie');
    assert.equal(await one.evaluate(() => nightcord.voice.capture == null), true, 'joining does not request a microphone');
    await one.locator('[data-voice-mic]').click();
    await one.waitForFunction(() => nightcord.voice.state.microphone || window.voiceErrors.length, null, { timeout: live ? 45000 : 20000 });
    assert.ok(await one.evaluate(() => nightcord.voice.state.microphone), JSON.stringify(await one.evaluate(() => window.voiceErrors)));
    await two.waitForFunction(() => nightcord.voice.receiver?.connectionState === 'connected', null, { timeout: live ? 45000 : 25000 });
    let audio;
    for (let attempt = 0; attempt < 100; attempt++) {
      audio = await two.evaluate(async () => {
        const stats = await nightcord.voice.receiver.getStats();
        const inbound = [...stats.values()].find(stat => stat.type === 'inbound-rtp' && stat.kind === 'audio');
        const player = [...nightcord.voice.playbacks.values()][0]?.audio;
        return { bytesReceived: inbound?.bytesReceived, totalAudioEnergy: inbound?.totalAudioEnergy, playing: player && !player.paused, time: player?.currentTime };
      });
      if (audio.bytesReceived > 1000 && audio.totalAudioEnergy > 0.0001 && audio.playing && audio.time > 0) break;
      await delay(100);
    }
    assert.ok(audio.bytesReceived > 1000 && audio.totalAudioEnergy > 0.0001 && audio.playing && audio.time > 0, JSON.stringify(audio));
    const connection = await two.evaluate(async () => {
      const stats = await nightcord.voice.receiver.getStats();
      const transport = [...stats.values()].find(stat => stat.type === 'transport' && stat.selectedCandidatePairId);
      const pair = stats.get(transport?.selectedCandidatePairId), local = stats.get(pair?.localCandidateId);
      return { candidateType: local?.candidateType, protocol: local?.protocol, relayProtocol: local?.relayProtocol };
    });
    if (relayOnly) assert.equal(connection.candidateType, 'relay');
    await one.locator('#voice-panel details').evaluate(node => { node.open = true; });
    await two.locator('#voice-panel details').evaluate(node => { node.open = true; });
    assert.ok(await two.locator('#voice-panel').evaluate(node => node.scrollWidth <= node.clientWidth), 'voice panel fits 320px');
    await mkdir(artifacts, { recursive: true });
    await one.screenshot({ path: join(artifacts, 'desktop.png') }); await two.screenshot({ path: join(artifacts, 'mobile.png') });
    await two.locator('.voice-volume input').fill('0.25');
    assert.equal(await two.evaluate(() => [...nightcord.voice.playbacks.values()][0].audio.volume), 0.25);
    await one.evaluate(() => { window.originalTrack = nightcord.voice.capture.getAudioTracks()[0]; });
    await one.locator('[data-voice-mic]').click();
    assert.equal(await one.evaluate(() => window.originalTrack.readyState), 'ended');
    await two.waitForFunction(() => nightcord.voice.playbacks.size === 0);
    await one.locator('[data-voice-mic]').click();
    await one.waitForFunction(() => nightcord.voice.state.microphone);
    await two.waitForFunction(() => nightcord.voice.receiver?.connectionState === 'connected');
    assert.equal(await two.evaluate(() => [...nightcord.voice.playbacks.values()][0].audio.volume), 0.25, 'receiver replacement preserves the chosen volume');
    await one.evaluate(() => { window.lastTrack = nightcord.voice.capture.getAudioTracks()[0]; nightcord.joinRoom('voice-other'); });
    assert.equal(await one.evaluate(() => window.lastTrack.readyState), 'ended');
    await two.waitForFunction(() => nightcord.voice.state.members.length === 1 && nightcord.voice.playbacks.size === 0);
    await two.locator('[data-voice-leave]').click();
    await two.waitForFunction(() => !nightcord.voice.state.joined);
    if (!live) await relay.waitForFunction(() => [...window.sessions.values()].every(session => session.pc.connectionState === 'closed'));
    else {
      for (let i = 0; i < 100 && [...cloudSessions.values()].some(mids => mids.size); i++) await delay(100);
      assert.ok([...cloudSessions.values()].every(mids => !mids.size), 'backend must confirm Cloudflare forwarding cleanup');
    }
    assert.deepEqual(errors, []);
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({ fixture: live ? 'Cloudflare SFU/TURN with local application/auth fixture' : 'local native WebRTC relay; no Cloudflare media connection', relayOnly, ...connection, ...audio }, null, 2));
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
