import { createHash } from 'node:crypto';
import { config } from '../../config';
import { htmlToText, sleep } from '../../common/text';
import { Connector, ConnectorOutput, emptyOutput, TransformInput } from './connector.types';
import { httpGet, httpJson, robotsAllowed } from './http';
import { nameMatches } from './social.connectors';

const SOCIAL_PATTERNS: { platform: string; re: RegExp; url: (h: string) => string }[] = [
  { platform: 'x', re: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{2,15})(?:[/?#]|$)/g, url: (h) => `https://x.com/${h}` },
  { platform: 'instagram', re: /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})(?:[/?#]|$)/g, url: (h) => `https://www.instagram.com/${h}` },
  { platform: 'facebook', re: /https?:\/\/(?:www\.)?facebook\.com\/([A-Za-z0-9.]{3,50})(?:[/?#]|$)/g, url: (h) => `https://www.facebook.com/${h}` },
  { platform: 'linkedin', re: /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company)\/([A-Za-z0-9_-]{2,100})(?:[/?#]|$)/g, url: (h) => `https://www.linkedin.com/in/${h}` },
  { platform: 'github', re: /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})(?:[/?#]|$)/g, url: (h) => `https://github.com/${h}` },
  { platform: 'youtube', re: /https?:\/\/(?:www\.)?youtube\.com\/@([A-Za-z0-9_.-]{3,30})(?:[/?#]|$)/g, url: (h) => `https://www.youtube.com/@${h}` },
  { platform: 'tiktok', re: /https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]{2,24})(?:[/?#]|$)/g, url: (h) => `https://www.tiktok.com/@${h}` },
];
const SOCIAL_STOPWORDS = new Set(['share', 'sharer', 'intent', 'home', 'login', 'signup', 'hashtag', 'search', 'explore', 'p', 'watch', 'pages', 'groups', 'tr', 'dialog', 'about', 'privacy', 'legal', 'orgs', 'features', 'topics', 'events']);

export function socialLinks(html: string) {
  const found = new Map<string, { platform: string; handle: string; url: string }>();
  for (const p of SOCIAL_PATTERNS) {
    for (const m of html.matchAll(p.re)) {
      const handle = m[1];
      if (SOCIAL_STOPWORDS.has(handle.toLowerCase())) continue;
      found.set(`${p.platform}:${handle.toLowerCase()}`, { platform: p.platform, handle, url: p.url(handle) });
    }
  }
  return [...found.values()].slice(0, 25);
}

const meta = (html: string, names: string[]) => {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*content=["']([^"']+)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["']${n}["']`, 'i');
    const m = html.match(re) ?? html.match(re2);
    if (m) return m[1].trim();
  }
  return null;
};

/** Tier D — permitted public web collection (robots.txt honoured, size/time capped). */
export class WebPageConnector implements Connector {
  readonly def = {
    key: 'web.page',
    name: 'Public Web Page Collector',
    owner: 'Platform crawler',
    category: 'Web collection',
    tier: 'D' as const,
    accessMethod: 'PUBLIC_WEB_COLLECTION',
    legalBasis: 'Publicly accessible pages only; robots.txt honoured; no login/paywall bypass; per-site terms apply.',
    authMode: 'NONE' as const,
    rateLimitPerMin: 20,
    allowedFields: ['title', 'visible text', 'meta (author, published time)', 'outbound social links', 'published contact identifiers'],
    inputTypes: ['URL', 'ARTICLE'] as any,
    outputTypes: ['ARTICLE', 'SOCIAL_ACCOUNT', 'DOMAIN'] as any,
    retentionDays: 180,
    defaultPolicy: 'APPROVED' as const,
    autoRun: false,
    description: 'Fetches a public page, stores the raw HTML as evidence and extracts entities, contacts and social profile links.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const url = String(input.properties.url ?? input.value);
    if (!/^https?:\/\//i.test(url)) throw new Error(`Not an http(s) URL: ${url}`);
    if (!(await robotsAllowed(url))) {
      out.notes = [`robots.txt disallows ${url} — not collected`];
      return out;
    }
    const r = await httpGet(url, { headers: { Accept: 'text/html,application/xhtml+xml,text/plain' } });
    if (!/text\/html|text\/plain|application\/xhtml/.test(r.contentType)) {
      out.notes = [`Unsupported content type ${r.contentType}`];
      return out;
    }
    const html = r.text;
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? meta(html, ['og:title']) ?? url).trim().slice(0, 300);
    const text = htmlToText(html).slice(0, 60000);
    const published = meta(html, ['article:published_time', 'datePublished', 'pubdate', 'date', 'dc.date']);
    const author = meta(html, ['author', 'article:author', 'twitter:creator']);
    const host = new URL(r.url).hostname.replace(/^www\./, '');
    out.observations.push({
      ref: 'page',
      url: r.url,
      title,
      text,
      author: author ?? host,
      publishedAt: published && !isNaN(Date.parse(published)) ? published : null,
      raw: r.body,
      contentType: r.contentType.split(';')[0],
      extract: true,
      entityRef: 'input',
    });
    out.attributes!.push({ entityRef: 'input', key: 'title', value: title, obsRef: 'page' });
    out.entities.push({ ref: 'host', type: 'DOMAIN', value: host, confidence: 1, obsRef: 'page' });
    out.relationships.push({ from: 'host', type: 'PUBLISHED', to: 'input', confidence: 0.9, obsRef: 'page' });
    socialLinks(html).forEach((s, i) => {
      out.entities.push({ ref: `soc${i}`, type: 'SOCIAL_ACCOUNT', value: `${s.platform}:${s.handle.toLowerCase()}`, properties: { platform: s.platform, handle: s.handle, profile_url: s.url }, confidence: 0.7, obsRef: 'page' });
      out.relationships.push({ from: `soc${i}`, type: 'MENTIONED_IN', to: 'input', confidence: 0.7, label: 'linked from page', obsRef: 'page' });
    });
    return out;
  }
}

/** Tier C — GDELT DOC 2.0 global news index (discovery of news coverage). */
export class GdeltConnector implements Connector {
  readonly def = {
    key: 'gdelt.news',
    name: 'GDELT Global News Index',
    owner: 'The GDELT Project',
    category: 'News / search index',
    tier: 'C' as const,
    accessMethod: 'SEARCH_INDEX_API',
    baseUrl: 'https://api.gdeltproject.org/api/v2/doc/doc',
    legalBasis: 'Open news metadata index (headline, URL, date, outlet). Article bodies are collected only via web.page.',
    authMode: 'NONE' as const,
    rateLimitPerMin: 10,
    allowedFields: ['headline', 'url', 'seen date', 'outlet domain', 'language', 'source country'],
    inputTypes: ['PERSON', 'ORGANIZATION', 'EVENT', 'NARRATIVE', 'PHONE'] as any,
    outputTypes: ['ARTICLE', 'DOMAIN'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED' as const,
    autoRun: true,
    description: 'Discovers news articles (last 3 months) containing the exact phrase; feeds timeline and narrative analysis.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const phrase = input.value.replace(/"/g, '');
    if (phrase.length < 4) {
      out.notes = ['Phrase too short for GDELT'];
      return out;
    }
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${phrase}"`)}&mode=artlist&maxrecords=50&format=json&sort=datedesc&timespan=3months`;
    const r = await httpGet(url, { timeoutMs: 30000 });
    let data: any = null;
    try {
      data = JSON.parse(r.text);
    } catch {
      out.notes = [`GDELT returned no JSON: ${r.text.slice(0, 120)}`];
      return out;
    }
    out.observations.push({ ref: 'resp', url, raw: r.body, contentType: 'application/json', title: `GDELT "${phrase}"` });
    const toIso = (s: string) => (s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z` : null);
    (data?.articles ?? []).slice(0, 50).forEach((a: any, i: number) => {
      const ref = `a${i}`;
      const published = toIso(a.seendate);
      out.observations.push({
        ref,
        url: a.url,
        title: a.title,
        text: a.title,
        author: a.domain,
        publishedAt: published,
        raw: JSON.stringify(a),
        contentType: 'application/json',
        extract: true,
        entityRef: `art${i}`,
      });
      out.entities.push({
        ref: `art${i}`,
        type: 'ARTICLE',
        value: a.url,
        properties: { title: a.title, url: a.url, publisher: a.domain, language: a.language, source_country: a.sourcecountry, published_at: published },
        confidence: 1,
        obsRef: ref,
      });
      out.entities.push({ ref: `pub${i}`, type: 'DOMAIN', value: String(a.domain).toLowerCase(), confidence: 1, obsRef: ref });
      out.relationships.push({ from: `pub${i}`, type: 'PUBLISHED', to: `art${i}`, confidence: 1, obsRef: ref });
      out.relationships.push({ from: 'input', type: 'MENTIONED_IN', to: `art${i}`, confidence: 0.5, label: 'phrase match (GDELT)', obsRef: ref });
    });
    return out;
  }
}

/** Tier A — GitHub REST API: public user profile. */
export class GithubConnector implements Connector {
  readonly def = {
    key: 'github.user',
    name: 'GitHub Public Profile',
    owner: 'GitHub',
    category: 'Developer platform',
    tier: 'A' as const,
    accessMethod: 'OFFICIAL_API',
    baseUrl: 'https://api.github.com/users/',
    legalBasis: 'Official REST API; only fields the user chose to publish on the public profile.',
    authMode: 'TOKEN' as const,
    rateLimitPerMin: 20,
    allowedFields: ['login', 'name', 'company', 'blog', 'location', 'public email', 'twitter_username', 'created_at'],
    inputTypes: ['USERNAME', 'SOCIAL_ACCOUNT'] as any,
    outputTypes: ['SOCIAL_ACCOUNT', 'PERSON', 'ORGANIZATION', 'URL', 'LOCATION', 'EMAIL'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED' as const,
    autoRun: true,
    description: 'Looks up a handle on GitHub and maps self-declared profile fields (treated as source claims).',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    if (input.type === 'SOCIAL_ACCOUNT' && input.properties.platform && input.properties.platform !== 'github') {
      out.notes = ['Not a GitHub account'];
      return out;
    }
    const handle = String(input.properties.handle ?? input.value).replace(/^@/, '').replace(/^github:/, '');
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
    const r = await httpJson<any>(`https://api.github.com/users/${encodeURIComponent(handle)}`, { headers, allow404: true });
    if (!r.data) {
      out.notes = [`No GitHub user "${handle}"`];
      return out;
    }
    const u = r.data;
    out.observations.push({ ref: 'obs', url: u.html_url, raw: r.raw, contentType: 'application/json', title: `GitHub ${u.login}`, text: [u.name, u.bio, u.company, u.location].filter(Boolean).join('. '), author: 'github.com', publishedAt: u.created_at });
    const acct = input.type === 'SOCIAL_ACCOUNT' ? 'input' : 'acct';
    if (acct === 'acct') {
      out.entities.push({ ref: 'acct', type: 'SOCIAL_ACCOUNT', value: `github:${u.login.toLowerCase()}`, properties: { platform: 'github', handle: u.login, profile_url: u.html_url, public_id: String(u.id), created_at: u.created_at, followers: u.followers }, confidence: 1, obsRef: 'obs' });
      out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: 'acct', confidence: 0.5, label: 'same handle on GitHub (may be a different person)', obsRef: 'obs' });
    }
    if (u.name) {
      out.entities.push({ ref: 'person', type: 'PERSON', value: u.name, hints: { discriminator: `github:${u.login.toLowerCase()}` }, properties: { self_declared: true }, confidence: 0.6, obsRef: 'obs' });
      out.relationships.push({ from: 'person', type: 'HAS_ACCOUNT', to: acct, confidence: 0.7, label: 'profile display name', obsRef: 'obs' });
      const owner = 'person';
      if (u.company) {
        out.entities.push({ ref: 'org', type: 'ORGANIZATION', value: String(u.company).replace(/^@/, ''), confidence: 0.5, obsRef: 'obs' });
        out.relationships.push({ from: owner, type: 'WORKS_FOR', to: 'org', confidence: 0.4, label: 'self-declared (source claim)', obsRef: 'obs' });
      }
      if (u.location) {
        out.entities.push({ ref: 'loc', type: 'LOCATION', value: u.location, confidence: 0.5, obsRef: 'obs' });
        out.relationships.push({ from: owner, type: 'ASSOCIATED_WITH', to: 'loc', confidence: 0.4, label: 'self-declared location', obsRef: 'obs' });
      }
      if (u.email) {
        out.entities.push({ ref: 'email', type: 'EMAIL', value: u.email, confidence: 0.8, obsRef: 'obs' });
        out.relationships.push({ from: owner, type: 'HAS_EMAIL', to: 'email', confidence: 0.7, label: 'public profile email', obsRef: 'obs' });
      }
    }
    if (u.blog) {
      const blog = /^https?:\/\//.test(u.blog) ? u.blog : `https://${u.blog}`;
      out.entities.push({ ref: 'blog', type: 'URL', value: blog, confidence: 0.8, obsRef: 'obs' });
      out.relationships.push({ from: acct, type: 'ASSOCIATED_WITH', to: 'blog', confidence: 0.8, label: 'profile website', obsRef: 'obs' });
    }
    if (u.twitter_username) {
      out.entities.push({ ref: 'tw', type: 'SOCIAL_ACCOUNT', value: `x:${u.twitter_username.toLowerCase()}`, properties: { platform: 'x', handle: u.twitter_username, profile_url: `https://x.com/${u.twitter_username}` }, confidence: 0.8, obsRef: 'obs' });
      out.relationships.push({ from: acct, type: 'ASSOCIATED_WITH', to: 'tw', confidence: 0.8, label: 'linked X account', obsRef: 'obs' });
    }
    return out;
  }
}

/** Tier A — handle presence on platforms exposing official public APIs (no scraping). */
export class UsernamePresenceConnector implements Connector {
  readonly def = {
    key: 'username.presence',
    name: 'Handle Presence (GitLab, Keybase, Hacker News, DEV)',
    owner: 'Multiple platforms',
    category: 'Developer / community platforms',
    tier: 'A' as const,
    accessMethod: 'OFFICIAL_API',
    legalBasis: 'Official public APIs only; platforms that prohibit automated access are not queried.',
    authMode: 'NONE' as const,
    rateLimitPerMin: 20,
    allowedFields: ['handle exists', 'profile url', 'public display name', 'public proofs'],
    inputTypes: ['USERNAME'] as any,
    outputTypes: ['SOCIAL_ACCOUNT', 'PERSON'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED' as const,
    autoRun: true,
    description: 'Checks whether the handle exists on platforms with official APIs. Handle reuse by different people is common — results are candidates.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const h = input.value.replace(/^@/, '');
    const found: { platform: string; url: string; name?: string; raw: string; extra?: Record<string, unknown>; proofs?: any[] }[] = [];
    const checks: Promise<void>[] = [
      httpJson<any[]>(`https://gitlab.com/api/v4/users?username=${encodeURIComponent(h)}`).then((r) => {
        const u = r.data?.[0];
        if (u) found.push({ platform: 'gitlab', url: u.web_url, name: u.name, raw: r.raw });
      }),
      httpJson<any>(`https://keybase.io/_/api/1.0/user/lookup.json?usernames=${encodeURIComponent(h)}&fields=basics,profile,proofs_summary`).then((r) => {
        const u = r.data?.them?.[0];
        if (u) found.push({ platform: 'keybase', url: `https://keybase.io/${u.basics?.username}`, name: u.profile?.full_name, raw: r.raw, proofs: u.proofs_summary?.all ?? [] });
      }),
      httpJson<any>(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(h)}.json`).then((r) => {
        if (r.data?.id) found.push({ platform: 'hackernews', url: `https://news.ycombinator.com/user?id=${r.data.id}`, raw: r.raw, extra: { karma: r.data.karma, created: r.data.created } });
      }),
      httpJson<any>(`https://dev.to/api/users/by_username?url=${encodeURIComponent(h)}`, { allow404: true }).then((r) => {
        if (r.data?.username) found.push({ platform: 'dev.to', url: `https://dev.to/${r.data.username}`, name: r.data.name, raw: r.raw, extra: { location: r.data.location } });
      }),
    ].map((p) => p.catch(() => undefined));
    await Promise.all(checks);
    out.observations.push({ ref: 'summary', raw: JSON.stringify({ handle: h, found: found.map((f) => f.platform) }), contentType: 'application/json', title: `Handle presence @${h}` });
    found.forEach((f, i) => {
      const obs = `o${i}`;
      out.observations.push({ ref: obs, url: f.url, raw: f.raw, contentType: 'application/json', title: `${f.platform} @${h}` });
      out.entities.push({ ref: `acct${i}`, type: 'SOCIAL_ACCOUNT', value: `${f.platform}:${h.toLowerCase()}`, properties: { platform: f.platform, handle: h, profile_url: f.url, display_name: f.name ?? null, ...(f.extra ?? {}) }, confidence: 0.9, obsRef: obs });
      out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: `acct${i}`, confidence: 0.5, label: `same handle on ${f.platform}`, obsRef: obs });
      if (f.name) {
        out.entities.push({ ref: `p${i}`, type: 'PERSON', value: f.name, hints: { discriminator: `${f.platform}:${h.toLowerCase()}` }, properties: { self_declared: true }, confidence: 0.5, obsRef: obs });
        out.relationships.push({ from: `p${i}`, type: 'HAS_ACCOUNT', to: `acct${i}`, confidence: 0.6, label: 'profile display name', obsRef: obs });
      }
      (f.proofs ?? []).slice(0, 10).forEach((p: any, k: number) => {
        const r = `proof${i}-${k}`;
        out.entities.push({ ref: r, type: 'SOCIAL_ACCOUNT', value: `${p.proof_type}:${String(p.nametag).toLowerCase()}`, properties: { platform: p.proof_type, handle: p.nametag, profile_url: p.service_url }, confidence: 0.9, obsRef: obs });
        out.relationships.push({ from: `acct${i}`, type: 'ASSOCIATED_WITH', to: r, confidence: 0.9, label: 'cryptographic Keybase proof', obsRef: obs });
      });
    });
    return out;
  }
}

/** Tier A — Gravatar public profile keyed by the SHA-256 of the email address. */
export class GravatarConnector implements Connector {
  readonly def = {
    key: 'gravatar.profile',
    name: 'Gravatar Public Profile',
    owner: 'Automattic',
    category: 'Identity profile',
    tier: 'A' as const,
    accessMethod: 'OFFICIAL_API',
    baseUrl: 'https://api.gravatar.com/v3/profiles/',
    legalBasis: 'Official API; returns only profiles the email owner made public.',
    authMode: 'NONE' as const,
    rateLimitPerMin: 20,
    allowedFields: ['display name', 'profile url', 'location', 'job title', 'company', 'verified accounts'],
    inputTypes: ['EMAIL'] as any,
    outputTypes: ['PERSON', 'SOCIAL_ACCOUNT', 'ORGANIZATION', 'LOCATION'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED' as const,
    autoRun: true,
    description: 'Checks whether the email owner published a Gravatar profile and maps its verified accounts.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const hash = createHash('sha256').update(input.value.trim().toLowerCase()).digest('hex');
    const r = await httpJson<any>(`https://api.gravatar.com/v3/profiles/${hash}`, { allow404: true });
    if (!r.data) {
      out.notes = ['No public Gravatar profile'];
      return out;
    }
    const p = r.data;
    out.observations.push({ ref: 'obs', url: p.profile_url, raw: r.raw, contentType: 'application/json', title: `Gravatar ${p.display_name ?? hash.slice(0, 8)}`, text: [p.display_name, p.job_title, p.company, p.location, p.description].filter(Boolean).join('. ') });
    if (p.display_name) {
      out.entities.push({ ref: 'person', type: 'PERSON', value: p.display_name, hints: { discriminator: `gravatar:${hash.slice(0, 16)}` }, properties: { self_declared: true, profile_url: p.profile_url }, confidence: 0.7, obsRef: 'obs' });
      out.relationships.push({ from: 'person', type: 'HAS_EMAIL', to: 'input', confidence: 0.8, label: 'Gravatar profile bound to email', obsRef: 'obs' });
      if (p.company) {
        out.entities.push({ ref: 'org', type: 'ORGANIZATION', value: p.company, confidence: 0.5, obsRef: 'obs' });
        out.relationships.push({ from: 'person', type: 'WORKS_FOR', to: 'org', confidence: 0.4, label: 'self-declared (source claim)', obsRef: 'obs' });
      }
      if (p.location) {
        out.entities.push({ ref: 'loc', type: 'LOCATION', value: p.location, confidence: 0.5, obsRef: 'obs' });
        out.relationships.push({ from: 'person', type: 'ASSOCIATED_WITH', to: 'loc', confidence: 0.4, label: 'self-declared location', obsRef: 'obs' });
      }
      (p.verified_accounts ?? []).slice(0, 10).forEach((a: any, i: number) => {
        const handle = String(a.url ?? '').split('/').filter(Boolean).pop() ?? a.service_label;
        out.entities.push({ ref: `va${i}`, type: 'SOCIAL_ACCOUNT', value: `${a.service_type}:${String(handle).toLowerCase()}`, properties: { platform: a.service_type, handle, profile_url: a.url }, confidence: 0.85, obsRef: 'obs' });
        out.relationships.push({ from: 'person', type: 'HAS_ACCOUNT', to: `va${i}`, confidence: 0.8, label: 'Gravatar verified account', obsRef: 'obs' });
      });
    }
    return out;
  }
}

/** Tier C — Brave Search API for discovery using search-expansion queries (requires API key). */
export class BraveSearchConnector implements Connector {
  constructor(private readonly expand: (type: string, label: string, ctx: TransformInput['context']) => string[]) {}

  readonly def = {
    key: 'brave.search',
    name: 'Brave Web Search API',
    owner: 'Brave Software',
    category: 'Search index',
    tier: 'C' as const,
    accessMethod: 'SEARCH_INDEX_API',
    baseUrl: 'https://api.search.brave.com/res/v1/web/search',
    legalBasis: 'Licensed search API under subscription terms; results are discovery leads, not facts.',
    authMode: 'API_KEY' as const,
    rateLimitPerMin: 15,
    allowedFields: ['result url', 'title', 'snippet', 'page age'],
    inputTypes: ['PERSON', 'ORGANIZATION', 'PHONE', 'EMAIL', 'USERNAME'] as any,
    outputTypes: ['URL'] as any,
    retentionDays: 180,
    defaultPolicy: 'PENDING' as const,
    autoRun: true,
    description: 'Runs the search-expansion query set (exact phrase, + organisation, filetype:pdf, …) and records candidate URLs.',
    requiresCredential: () => !config.braveApiKey,
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    if (!config.braveApiKey) throw new Error('BRAVE_API_KEY is not configured');
    const queries = this.expand(input.type, input.value, input.context).slice(0, 4);
    let n = 0;
    const phrase = input.value.replace(/^@/, '').replace(/"/g, '');
    let dropped = 0;
    for (const [qi, q] of queries.entries()) {
      if (qi) await sleep(1100); // Brave free plan: 1 request per second
      const r = await httpJson<any>(`${this.def.baseUrl}?count=10&q=${encodeURIComponent(q)}`, {
        headers: { 'X-Subscription-Token': config.braveApiKey },
      });
      out.observations.push({ ref: `q${qi}`, url: `brave:${q}`, raw: r.raw, contentType: 'application/json', title: `Brave search: ${q}` });
      const all: any[] = r.data?.web?.results ?? [];
      // same relevance rule as the SearXNG connectors: every token of the searched value must appear
      const keep = all.filter((res) => nameMatches(phrase, `${res.title} ${String(res.description ?? '').replace(/<[^>]+>/g, '')} ${res.url}`));
      dropped += all.length - keep.length;
      for (const res of keep) {
        const ref = `r${n++}`;
        out.observations.push({ ref: `${ref}o`, url: res.url, title: res.title, text: `${res.title}. ${String(res.description ?? '').replace(/<[^>]+>/g, '')}`, author: new URL(res.url).hostname, publishedAt: res.page_age ?? null, raw: JSON.stringify(res), contentType: 'application/json', extract: true, entityRef: ref });
        out.entities.push({ ref, type: 'URL', value: res.url, properties: { title: res.title, query: q }, confidence: 0.6, obsRef: `${ref}o` });
        out.relationships.push({ from: 'input', type: 'MENTIONED_IN', to: ref, confidence: 0.35, label: `search result for ${q}`, obsRef: `${ref}o` });
      }
    }
    out.notes = [`${n} result(s) from ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}; ${dropped} without every search token ignored`];
    return out;
  }
}

const COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

/** Tier B — numverify / APILayer phone-number validation (licensed commercial API). */
export class NumverifyConnector implements Connector {
  readonly def = {
    key: 'numverify.validate',
    name: 'numverify Phone Validation',
    owner: 'APILayer',
    category: 'Phone intelligence',
    tier: 'B' as const,
    accessMethod: 'OFFICIAL_API',
    baseUrl: config.numverifyBaseUrl,
    legalBasis:
      'Licensed carrier/numbering-plan lookup under APILayer subscription terms; returns line metadata for a number already held by the case, no subscriber identity.',
    authMode: 'API_KEY' as const,
    rateLimitPerMin: 10,
    allowedFields: ['valid', 'carrier', 'line_type', 'country_code', 'country_name', 'location', 'international_format'],
    inputTypes: ['PHONE'] as any,
    outputTypes: ['ORGANIZATION', 'LOCATION'] as any,
    retentionDays: 365,
    defaultPolicy: 'PENDING' as const,
    autoRun: true,
    description:
      'Validates a phone number and records its carrier, line type and numbering-plan country. Consumes paid API quota; approve in the Source Registry before use.',
    requiresCredential: () => !config.numverifyApiKey,
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    if (!config.numverifyApiKey) throw new Error('NUMVERIFY_API_KEY is not configured');
    const number = (input.properties.e164 ?? input.value).toString().replace(/[^\d+]/g, '');
    const cc = (input.properties.country_code as string | undefined) ?? config.defaultPhoneRegion;
    const url =
      `${config.numverifyBaseUrl}?access_key=${config.numverifyApiKey}` +
      `&number=${encodeURIComponent(number)}&country_code=${encodeURIComponent(cc ?? '')}&format=1`;
    const r = await httpJson<any>(url);
    // numverify reports auth/quota failures in the body with HTTP 200.
    if (r.data && r.data.success === false) {
      const info = r.data.error?.info ?? `error ${r.data.error?.code}`;
      throw new Error(`numverify: ${info}`);
    }
    // Never persist the access_key inside evidence.
    const safeRaw = r.raw.replaceAll(config.numverifyApiKey, '***');
    out.observations.push({
      ref: 'obs',
      url: `numverify:${number}`,
      raw: safeRaw,
      contentType: 'application/json',
      title: `numverify ${number}`,
    });
    const d = r.data ?? {};
    if (!d.valid) {
      out.attributes!.push({ entityRef: 'input', key: 'numverify_valid', value: 'false', obsRef: 'obs' });
      out.notes = ['numverify reports the number as not valid'];
      return out;
    }
    out.attributes!.push({ entityRef: 'input', key: 'numverify_valid', value: 'true', obsRef: 'obs' });
    if (d.line_type) out.attributes!.push({ entityRef: 'input', key: 'line_type', value: String(d.line_type), obsRef: 'obs' });
    if (d.international_format)
      out.attributes!.push({ entityRef: 'input', key: 'international_format', value: String(d.international_format), obsRef: 'obs' });
    if (d.carrier) {
      out.entities.push({ ref: 'carrier', type: 'ORGANIZATION', value: String(d.carrier), properties: { role: 'telecom carrier' }, confidence: 0.85, obsRef: 'obs' });
      out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: 'carrier', confidence: 0.85, label: 'phone carrier', obsRef: 'obs' });
    }
    const countryValue = d.country_name ?? (d.country_code ? COUNTRY_NAMES.of(d.country_code) ?? d.country_code : undefined);
    if (countryValue) {
      out.entities.push({ ref: 'country', type: 'LOCATION', value: String(countryValue), properties: { country_code: d.country_code ?? null, level: 'country' }, confidence: 0.9, obsRef: 'obs' });
      out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: 'country', confidence: 0.9, label: 'numbering plan country', obsRef: 'obs' });
    }
    if (d.location && String(d.location).trim()) {
      out.entities.push({ ref: 'area', type: 'LOCATION', value: String(d.location), properties: { level: 'area', country_code: d.country_code ?? null }, confidence: 0.5, obsRef: 'obs' });
      out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: 'area', confidence: 0.5, label: 'numbering plan area (approximate)', obsRef: 'obs' });
    }
    return out;
  }
}
