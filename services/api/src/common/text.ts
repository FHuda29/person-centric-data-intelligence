import { createHash } from 'node:crypto';

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export const stripDiacritics = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '');

export const normalizeName = (s: string) =>
  stripDiacritics(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Token-sorted form so "Santoso, Budi" and "Budi Santoso" compare equal. */
export const nameKey = (s: string) => normalizeName(s).split(' ').filter(Boolean).sort().join(' ');

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aM = new Array<boolean>(a.length).fill(false);
  const bM = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bM[j] || a[i] !== b[j]) continue;
      aM[i] = bM[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aM[i]) continue;
    while (!bM[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export const jaccard = <T>(a: Set<T>, b: Set<T>) => {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

export const truncate = (s: string | null | undefined, n: number) =>
  !s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s;

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export const escapeHtml = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** PII masking for list views (paper §13). */
export function maskValue(type: string, value: string): string {
  if (type === 'EMAIL') {
    const [local, domain] = value.split('@');
    if (!domain) return '***';
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (type === 'PHONE') {
    if (value.length <= 6) return '***';
    return `${value.slice(0, 4)}****${value.slice(-3)}`;
  }
  return value;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
