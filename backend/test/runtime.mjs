/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Fixtures exist only in the local test process, never in the deployed Worker.
export function createRuntime(state = {}, options = {}) {
  return new Miniflare(convertV4MiniflareOptions({
    ...(options.inspectDurableObjects ? { unsafeInspectDurableObjects: true } : {}),
    ...(options.persistencePath ? { resourcePersistencePath: options.persistencePath } : {}),
    workers: [{
      name: 'nightcord-chat', modules: true, scriptPath: 'dist/chat.js',
      compatibilityDate: '2026-11-04', compatibilityFlags: ['nodejs_compat'],
      bindings: {
        GUEST_SIGNING_KEY: 'ab'.repeat(32),
        CHAT_ALLOWED_ORIGINS: options.origin || 'https://nightcord.de5.net',
        ...options.bindings,
      },
      durableObjects: {
        ROOMS: { className: 'ChatRoom', useSQLite: true },
        LIMITERS: { className: 'RateLimiter', useSQLite: true },
        VOICE_ROOMS: { className: 'VoiceRoom', useSQLite: true },
        VOICE_QUOTAS: { className: 'VoiceQuota', useSQLite: true },
      },
      ...(options.outboundService ? { outboundService: options.outboundService } : {}),
      serviceBindings: { SEKAI_PASS: async request => {
        assert.equal(new URL(request.url).pathname, '/oauth/userinfo');
        const identity = options.identities?.[request.headers.get('Authorization')];
        if ((!identity && request.headers.get('Authorization') !== 'Bearer local-test-token') || state.revoked) {
          return Response.json({ error: 'invalid_token' }, { status: 401 });
        }
        return Response.json({
          sub: identity || 'stable-subject', preferred_username: 'unique-handle',
          name: state.name || 'Shared name', picture: 'https://example.com/avatar.png',
          bio: '<img onerror=alert(1)> signature',
        });
      } },
    }],
  }));
}
