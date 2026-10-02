import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — compatible with common authenticator apps.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** Verifies a 6-digit code allowing ±1 time step of clock drift. */
export function verifyTotp(secretB32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code ?? '')) return false;
  const secret = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 30000);
  for (const drift of [-1, 0, 1]) {
    const expected = Buffer.from(hotp(secret, step + drift));
    if (timingSafeEqual(expected, Buffer.from(code))) return true;
  }
  return false;
}

export const otpauthUrl = (secret: string, account: string) =>
  `otpauth://totp/PCDI:${encodeURIComponent(account)}?secret=${secret}&issuer=PCDI&algorithm=SHA1&digits=6&period=30`;
