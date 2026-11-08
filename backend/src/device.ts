/* SPDX-License-Identifier: AGPL-3.0-only */
export function isMobileRequest(request: Request): boolean {
  return request.headers.get('Sec-CH-UA-Mobile') === '?1'
    || /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini|BlackBerry|webOS|Kindle|Silk|Dalvik|HarmonyOS/i.test(request.headers.get('User-Agent') || '');
}
