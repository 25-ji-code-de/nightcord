/* SPDX-License-Identifier: AGPL-3.0-only */

const MAX_BYTES = 16384;
const MAX_REPORTS = 20;

/** @param {number} status @param {string | null} [message] */
function reply(status, message = null) {
  return new Response(message, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(status === 405 ? { Allow: 'POST' } : {}),
    },
  });
}

/** @param {Request} request @returns {Promise<unknown>} */
async function readReport(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new RangeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

// OAuth callbacks can contain codes/tokens. Keep only origin + path, never
// original-policy (which contains the nonce), referrer, samples or URL queries.
/** @param {unknown} value */
function safeUrl(value) {
  if (typeof value !== 'string') return '';
  if (['inline', 'eval', 'wasm-eval'].includes(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return (url.origin + url.pathname).slice(0, 512);
    }
    return url.protocol;
  } catch {
    return '';
  }
}

/** @param {Parameters<PagesFunction>[0]} context */
export async function onRequest(context) {
  const request = context.request;
  if (request.method !== 'POST') return reply(405);
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!['application/csp-report', 'application/reports+json', 'application/json'].includes(contentType)) {
    return reply(415, 'Unsupported report type');
  }
  let payload;
  try {
    payload = await readReport(request);
  } catch (error) {
    return reply(error instanceof RangeError ? 413 : 400, 'Invalid report');
  }
  /** @type {unknown[]} */
  const reports = Array.isArray(payload) ? payload : [{
    type: 'csp-violation',
    body: payload && typeof payload === 'object' && 'csp-report' in payload ? payload['csp-report'] : null,
  }];
  if (reports.length > MAX_REPORTS) return reply(413, 'Too many reports');
  const origin = new URL(request.url).origin;
  for (const report of reports) {
    if (!report || typeof report !== 'object' || !('type' in report) || report.type !== 'csp-violation') continue;
    if (!('body' in report) || !report.body || typeof report.body !== 'object') continue;
    const body = /** @type {Record<string, unknown>} */ (report.body);
    const documentUrl = safeUrl(body.documentURL ?? body['document-uri']);
    if (!/^https?:\/\//.test(documentUrl) || new URL(documentUrl).origin !== origin) continue;
    const directive = body.effectiveDirective ?? body['effective-directive'];
    if (typeof directive !== 'string' || !/^[a-z-]{1,64}$/.test(directive)) continue;
    console.warn(JSON.stringify({
      event: 'csp-violation',
      documentUrl,
      directive,
      blockedUrl: safeUrl(body.blockedURL ?? body['blocked-uri']),
      disposition: body.disposition === 'enforce' ? 'enforce' : 'report',
    }));
  }
  return reply(204);
}
