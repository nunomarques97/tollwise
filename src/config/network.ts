// Address helpers shared by the schema (provider URLs) and the loader (the listening host).
// Kept separate so that schema.ts and load.ts do not import each other.

import { isIPv4, isIPv6 } from 'node:net';

/**
 * True for addresses that only reach this machine: `localhost`, 127.0.0.0/8 and ::1.
 * Accepts bracketed IPv6 (`[::1]`, as in URL hostnames). Anything else, including 0.0.0.0, `::`,
 * IPv4-mapped IPv6 and trailing-dot names, is treated as reachable from other machines.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (bare === 'localhost') return true;
  if (isIPv4(bare)) return bare.startsWith('127.');
  if (isIPv6(bare)) return bare === '::1' || bare === '0:0:0:0:0:0:0:1';
  return false;
}

/** True for addresses that listen on every interface (0.0.0.0, ::); accepts bracketed IPv6. */
export function isWildcardAddress(host: string): boolean {
  const bare = host
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
  if (isIPv4(bare)) return bare === '0.0.0.0';
  if (isIPv6(bare)) return /^[0:]+$/.test(bare);
  return false;
}

/** ASCII control characters (C0 and DEL) must never reach a terminal unescaped. */
function isControlCode(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

/** True when `text` contains an ASCII control character (including tab and newline). */
export function hasControlChars(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isControlCode(text.charCodeAt(index))) return true;
  }
  return false;
}

/** Replaces control characters with visible `\uXXXX` escapes so text is safe to print. */
export function escapeControlChars(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    out += isControlCode(code) ? `\\u${code.toString(16).padStart(4, '0')}` : text[index];
  }
  return out;
}
