import { config } from '../../config';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FetchResult {
  status: number;
  url: string;
  contentType: string;
  body: Buffer;
  text: string;
}

const MAX_BYTES = 3 * 1024 * 1024;

/** Outbound HTTP with timeout, size cap and identifying User-Agent. */
export async function httpGet(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; allow404?: boolean } = {},
): Promise<FetchResult> {
  const res = await fetch(url, {
    headers: { 'User-Agent': config.httpUserAgent, Accept: '*/*', ...(opts.headers ?? {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
  });
  if (!res.ok && !(opts.allow404 && res.status === 404)) {
    const snippet = (await res.text().catch(() => '')).slice(0, 200);
    throw new HttpError(res.status, `GET ${url} → HTTP ${res.status} ${snippet}`);
  }
  const reader = res.body?.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
    }
  }
  const body = Buffer.concat(chunks);
  return {
    status: res.status,
    url: res.url || url,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    body,
    text: body.toString('utf8'),
  };
}

export async function httpJson<T = any>(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; allow404?: boolean } = {},
): Promise<{ data: T | null; raw: string; status: number; url: string }> {
  const r = await httpGet(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers ?? {}) } });
  if (r.status === 404) return { data: null, raw: r.text, status: 404, url: r.url };
  try {
    return { data: JSON.parse(r.text) as T, raw: r.text, status: r.status, url: r.url };
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${r.text.slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------- robots.txt
const robotsCache = new Map<string, { at: number; rules: { allow: string[]; disallow: string[] } }>();

function parseRobots(txt: string): { allow: string[]; disallow: string[] } {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let cur: { agents: string[]; allow: string[]; disallow: string[] } | null = null;
  let lastWasAgent = false;
  for (const line of txt.split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, '').trim();
    const m = clean.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], allow: [], disallow: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (field === 'allow' && value) cur.allow.push(value);
    if (field === 'disallow' && value) cur.disallow.push(value);
  }
  const ours = groups.find((g) => g.agents.some((a) => a !== '*' && config.httpUserAgent.toLowerCase().includes(a)));
  const star = groups.find((g) => g.agents.includes('*'));
  const g = ours ?? star;
  return { allow: g?.allow ?? [], disallow: g?.disallow ?? [] };
}

const ruleMatches = (rule: string, path: string) => {
  const re = new RegExp(
    '^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'),
  );
  return re.test(path);
};

/** Honors robots.txt (longest matching rule wins; allow wins ties). Missing robots.txt = allowed. */
export async function robotsAllowed(target: string): Promise<boolean> {
  const u = new URL(target);
  const origin = u.origin;
  let entry = robotsCache.get(origin);
  if (!entry || Date.now() - entry.at > 3600_000) {
    let rules = { allow: [] as string[], disallow: [] as string[] };
    try {
      const r = await httpGet(`${origin}/robots.txt`, { timeoutMs: 8000, allow404: true });
      if (r.status === 200) rules = parseRobots(r.text);
    } catch (e) {
      if (e instanceof HttpError && e.status >= 500) {
        // Server error on robots.txt: be conservative and treat as disallowed.
        rules = { allow: [], disallow: ['/'] };
      }
    }
    entry = { at: Date.now(), rules };
    robotsCache.set(origin, entry);
  }
  const path = u.pathname + u.search;
  const bestAllow = Math.max(-1, ...entry.rules.allow.filter((r) => ruleMatches(r, path)).map((r) => r.length));
  const bestDis = Math.max(-1, ...entry.rules.disallow.filter((r) => ruleMatches(r, path)).map((r) => r.length));
  return bestDis < 0 || bestAllow >= bestDis;
}
