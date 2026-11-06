/* SPDX-License-Identifier: AGPL-3.0-only */

// Cloudflare injects Web Analytics, Rocket Loader and JavaScript Detections
// after Pages Functions run. JSD copies the nonce from the CSP response header:
// https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-you-have-a-content-security-policy-csp
// Never add this nonce to arbitrary HTML scripts: application scripts use src,
// and injected markup must not receive authorization to execute.
/** @param {Parameters<PagesFunction>[0]} context */
export async function onRequest(context) {
  // A 304 could pair a fresh CSP nonce with a previously injected JSD script.
  // Static asset routes bypass this middleware through _routes.json.
  const request = new Request(context.request);
  request.headers.delete('If-None-Match');
  request.headers.delete('If-Modified-Since');
  const response = await context.next(request);
  if (!/^text\/html(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '')) {
    return response;
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...bytes));
  const scripts = `script-src 'self' https://static.cloudflareinsights.com https://ajax.cloudflare.com 'nonce-${nonce}'`;
  const restrictions = "script-src-attr 'none'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
  const reports = 'report-uri /csp-report; report-to csp';
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', `${scripts}; ${restrictions}; ${reports}`);
  // Images, media and connections remain observational: SEKAI messages may
  // contain arbitrary external media. Do not silently break those messages.
  headers.set('Content-Security-Policy-Report-Only', [
    "default-src 'self'",
    scripts,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://r2.nightcord.de5.net https://sticker.nightcord.de5.net https://emojis.nightcord.de5.net",
    "media-src 'self' blob: https://r2.nightcord.de5.net",
    "connect-src 'self' wss: https://chat.nightcord.de5.net https://api.nightcord.de5.net https://id.nightcord.de5.net https://nako.nightcord.de5.net https://storage.nightcord.de5.net https://upload.nightcord.de5.net https://r2.nightcord.de5.net https://sticker.nightcord.de5.net",
    restrictions,
    reports,
  ].join('; '));
  const endpoint = new URL('/csp-report', request.url).href;
  headers.set('Reporting-Endpoints', `csp="${endpoint}"`);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.delete('ETag');
  headers.delete('Last-Modified');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
