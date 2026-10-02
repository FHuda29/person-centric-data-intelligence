import { config } from '../../config';
import { Connector, ConnectorOutput, emptyOutput, SourceDefinition, TransformInput } from './connector.types';
import { httpGet, httpJson } from './http';

// ------------------------------------------------------------------ helpers

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** True when every token (≥2 chars) of the searched name appears in the candidate text — keeps fuzzy API matches honest. */
export function nameMatches(query: string, candidate: string): boolean {
  const c = fold(candidate).replace(/[^a-z0-9]+/g, ' ');
  const squashed = c.replace(/ /g, '');
  const tokens = fold(query).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length >= 2);
  if (!tokens.length) return false;
  return tokens.every((t) => c.split(' ').includes(t)) || squashed.includes(tokens.join(''));
}

const stripTags = (s: unknown) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^(www|m|mobile|[a-z]{2}(-[a-z]{2})?)\./, '');
  } catch {
    return '';
  }
};

const isoOrNull = (v: unknown) => {
  if (!v) return null;
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

/** The search phrase for a transform input: names are quoted, handles stripped of '@'. */
const phraseOf = (input: TransformInput) => input.value.replace(/^@/, '').replace(/"/g, '').trim();

// ------------------------------------------------------------------ social URL classification

export interface SocialRef {
  platform: string;
  handle: string | null;
  kind: 'profile' | 'post' | 'page';
  profileUrl: string | null;
}

const RESERVED = new Set([
  'public', 'people', 'groups', 'pages', 'watch', 'photo', 'photos', 'photo.php', 'story.php', 'permalink.php', 'events', 'share', 'sharer',
  'hashtag', 'search', 'explore', 'p', 'reel', 'reels', 'tv', 'stories', 'login', 'signup', 'home', 'intent', 'i', 'status', 'video',
  'videos', 'marketplace', 'help', 'about', 'legal', 'privacy', 'tag', 'discover', 'music', 'results', 'feed', 'posts', 'pulse', 'jobs',
  'school', 'showcase', 'dir', 'directory', 'profile.php', 'watch?v', 'shorts', 'playlist', 'channel', 'c', 'user', 'notes',
]);

const SOCIAL_HOSTS: { platform: string; re: RegExp; parse: (parts: string[], u: URL) => { handle: string | null; post: boolean } }[] = [
  {
    platform: 'facebook',
    re: /(^|\.)facebook\.com$|(^|\.)fb\.com$/,
    parse: (p, u) => {
      if (p[0] === 'profile.php') return { handle: u.searchParams.get('id'), post: false };
      if (p[0] === 'public' && p[1]) return { handle: null, post: false };
      if (p[0] === 'people' && p[2]) return { handle: p[2], post: false };
      return { handle: p[0] && !RESERVED.has(p[0].toLowerCase()) ? p[0] : null, post: p.length > 1 };
    },
  },
  {
    platform: 'instagram',
    re: /(^|\.)instagram\.com$/,
    parse: (p) => ({ handle: p[0] && !RESERVED.has(p[0].toLowerCase()) ? p[0] : null, post: p.length > 1 || ['p', 'reel'].includes(p[0]) }),
  },
  {
    platform: 'linkedin',
    re: /(^|\.)linkedin\.com$/,
    parse: (p) => ({ handle: ['in', 'company'].includes(p[0]) && p[1] ? p[1] : null, post: ['posts', 'pulse', 'feed'].includes(p[0]) }),
  },
  {
    platform: 'tiktok',
    re: /(^|\.)tiktok\.com$/,
    parse: (p) => ({ handle: p[0]?.startsWith('@') ? p[0].slice(1) : null, post: p.length > 1 }),
  },
  {
    platform: 'x',
    re: /(^|\.)(twitter|x)\.com$/,
    parse: (p) => ({ handle: p[0] && !RESERVED.has(p[0].toLowerCase()) ? p[0] : null, post: p[1] === 'status' }),
  },
  {
    platform: 'youtube',
    re: /(^|\.)youtube\.com$|(^|\.)youtu\.be$/,
    parse: (p) => ({
      handle: p[0]?.startsWith('@') ? p[0].slice(1) : ['c', 'user', 'channel'].includes(p[0]) && p[1] ? p[1] : null,
      post: ['watch', 'shorts'].includes(p[0]) || p.length > 1,
    }),
  },
  {
    platform: 'threads',
    re: /(^|\.)threads\.(net|com)$/,
    parse: (p) => ({ handle: p[0]?.startsWith('@') ? p[0].slice(1) : null, post: p.length > 1 }),
  },
];

const PROFILE_URL: Record<string, (h: string) => string> = {
  facebook: (h) => (/^\d+$/.test(h) ? `https://www.facebook.com/profile.php?id=${h}` : `https://www.facebook.com/${h}`),
  instagram: (h) => `https://www.instagram.com/${h}`,
  linkedin: (h) => `https://www.linkedin.com/in/${h}`,
  tiktok: (h) => `https://www.tiktok.com/@${h}`,
  x: (h) => `https://x.com/${h}`,
  youtube: (h) => `https://www.youtube.com/@${h}`,
  threads: (h) => `https://www.threads.net/@${h}`,
};

/** Maps a search-result URL to a social platform + account handle, when it is one. */
export function classifySocialUrl(url: string): SocialRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web|[a-z]{2}(-[a-z]{2})?)\./, '');
  const def = SOCIAL_HOSTS.find((d) => d.re.test(host));
  if (!def) return null;
  const parts = u.pathname.split('/').filter(Boolean).map(safeDecode);
  const { handle, post } = def.parse(parts, u);
  const clean = handle ? handle.replace(/[^\p{L}\p{N}._-]/gu, '') : null;
  return {
    platform: def.platform,
    handle: clean || null,
    kind: post ? 'post' : clean ? 'profile' : 'page',
    profileUrl: clean ? PROFILE_URL[def.platform](clean) : null,
  };
}

// ------------------------------------------------------------------ SearXNG (self-hosted metasearch)

/**
 * Several engines ignore quotes and site: operators, so a query for "A B" returns pages about just "B".
 * Only results that contain every token of the searched value are mapped; the full response stays in evidence.
 */
const relevant = (input: TransformInput, results: SearxResult[]) =>
  results.filter((r) => nameMatches(phraseOf(input), `${stripTags(r.title)} ${stripTags(r.content)} ${safeDecode(r.url ?? '')}`));

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

interface SearxResult {
  url: string;
  title: string;
  content?: string;
  engine?: string;
  engines?: string[];
  publishedDate?: string | null;
}

async function searx(q: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams({ q, format: 'json', safesearch: '0', ...params });
  const url = `${config.searxngUrl.replace(/\/$/, '')}/search?${qs}`;
  const r = await httpJson<{ results: SearxResult[]; unresponsive_engines?: [string, string][] }>(url, { timeoutMs: 40000 });
  return { url, raw: r.raw, results: r.data?.results ?? [], unresponsive: r.data?.unresponsive_engines ?? [] };
}

const SEARX_BASE = {
  owner: 'Self-hosted SearXNG (queries public search engines)',
  tier: 'C' as const,
  accessMethod: 'SEARCH_INDEX_API',
  authMode: 'INTERNAL' as const,
  retentionDays: 180,
  defaultPolicy: 'APPROVED' as const,
  autoRun: true,
  legalBasis:
    'Search-engine index results only (URL, title, snippet). Platforms themselves are not logged into or scraped; results are unverified discovery leads.',
  requiresCredential: () => !config.searxngUrl,
};

/** Maps SearXNG results into observations/entities; social URLs become account candidates, others URL/ARTICLE leads. */
function mapSearxResults(out: ConnectorOutput, input: TransformInput, results: SearxResult[], opts: { query: string; asArticle: boolean; offset: number }) {
  let n = opts.offset;
  const phrase = phraseOf(input);
  for (const res of results) {
    if (!res.url || !/^https?:\/\//.test(res.url)) continue;
    const i = n++;
    const obs = `r${i}`;
    const title = stripTags(res.title).slice(0, 300);
    const snippet = stripTags(res.content).slice(0, 1000);
    const social = classifySocialUrl(res.url);
    const nameHit = nameMatches(phrase, `${title} ${snippet} ${res.url}`);
    out.observations.push({
      ref: obs,
      url: res.url,
      title,
      text: `${title}. ${snippet}`,
      author: social ? `${social.platform}${social.handle ? ':' + social.handle : ''}` : hostOf(res.url),
      publishedAt: isoOrNull(res.publishedDate),
      raw: JSON.stringify({ query: opts.query, ...res }),
      contentType: 'application/json',
      extract: !social,
      entityRef: `c${i}`,
    });
    const conf = nameHit ? 0.4 : 0.2;
    if (social?.handle) {
      const acct = `acct${i}`;
      out.entities.push({
        ref: acct,
        type: 'SOCIAL_ACCOUNT',
        value: `${social.platform}:${social.handle.toLowerCase()}`,
        properties: { platform: social.platform, handle: social.handle, profile_url: social.profileUrl, seen_in_search: res.url, search_title: title },
        confidence: 0.6,
        obsRef: obs,
      });
      out.relationships.push({
        from: 'input',
        type: 'ASSOCIATED_WITH',
        to: acct,
        confidence: conf,
        label: nameHit ? `name appears in ${social.platform} search result (unverified)` : `${social.platform} result for query (weak)`,
        obsRef: obs,
      });
    }
    const contentType = opts.asArticle || social?.kind === 'post' ? 'ARTICLE' : 'URL';
    out.entities.push({
      ref: `c${i}`,
      type: contentType,
      value: res.url,
      properties: { title, url: res.url, snippet: snippet.slice(0, 300), publisher: hostOf(res.url), query: opts.query, engines: res.engines ?? [res.engine], published_at: isoOrNull(res.publishedDate) },
      confidence: 0.6,
      obsRef: obs,
    });
    out.relationships.push({ from: 'input', type: 'MENTIONED_IN', to: `c${i}`, confidence: conf, label: `search result: ${opts.query}`, obsRef: obs });
    if (social?.handle && social.kind === 'post') {
      out.relationships.push({ from: `acct${i}`, type: 'PUBLISHED', to: `c${i}`, confidence: 0.8, obsRef: obs });
    } else if (!social) {
      const host = hostOf(res.url);
      if (host) {
        out.entities.push({ ref: `d${i}`, type: 'DOMAIN', value: host, confidence: 1, obsRef: obs });
        out.relationships.push({ from: `d${i}`, type: 'PUBLISHED', to: `c${i}`, confidence: 1, obsRef: obs });
      }
    }
  }
  return n;
}

/** Tier C — general web search (search-expansion query set) through the self-hosted SearXNG. */
export class SearxWebConnector implements Connector {
  constructor(private readonly expand: (type: string, label: string, ctx: TransformInput['context']) => string[]) {}

  readonly def: SourceDefinition = {
    ...SEARX_BASE,
    key: 'searxng.web',
    name: 'Web Search (SearXNG metasearch)',
    category: 'Search index',
    baseUrl: config.searxngUrl,
    rateLimitPerMin: 20,
    allowedFields: ['result url', 'title', 'snippet', 'engine', 'published date'],
    inputTypes: ['PERSON', 'ORGANIZATION', 'EMAIL', 'PHONE', 'USERNAME', 'DOMAIN'] as any,
    outputTypes: ['URL', 'ARTICLE', 'DOMAIN', 'SOCIAL_ACCOUNT'] as any,
    description: 'Runs the search-expansion queries (exact phrase, + organisation/city, filetype:pdf) across public search engines and records candidate pages.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const queries = this.expand(input.type, phraseOf(input), input.context).filter((q) => !q.includes('site:linkedin.com')).slice(0, 3);
    let n = 0;
    let dropped = 0;
    const notes: string[] = [];
    for (const [qi, q] of queries.entries()) {
      const r = await searx(q);
      out.observations.push({ ref: `q${qi}`, url: r.url, raw: r.raw, contentType: 'application/json', title: `Web search: ${q}` });
      const keep = relevant(input, r.results);
      dropped += r.results.length - keep.length;
      n = mapSearxResults(out, input, keep.slice(0, 20), { query: q, asArticle: false, offset: n });
      if (r.unresponsive.length) notes.push(`${q}: unresponsive engines ${r.unresponsive.map((e) => e[0]).join(', ')}`);
    }
    out.notes = [`${n} web result(s) from ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}; ${dropped} without every search token ignored`, ...notes];
    return out;
  }
}

const SOCIAL_SITE_GROUPS = [
  ['facebook.com', 'instagram.com', 'threads.net'],
  ['linkedin.com', 'x.com', 'twitter.com'],
  ['tiktok.com', 'youtube.com'],
];

/** Tier C — public social-media profiles & posts as indexed by search engines (no platform login, no scraping). */
export class SearxSocialConnector implements Connector {
  readonly def: SourceDefinition = {
    ...SEARX_BASE,
    key: 'searxng.social',
    name: 'Social Media Discovery (search-index)',
    category: 'Social media',
    baseUrl: config.searxngUrl,
    rateLimitPerMin: 20,
    allowedFields: ['public profile/post url', 'title', 'snippet as indexed by search engines'],
    inputTypes: ['PERSON', 'ORGANIZATION', 'USERNAME', 'EMAIL', 'PHONE'] as any,
    outputTypes: ['SOCIAL_ACCOUNT', 'ARTICLE', 'URL'] as any,
    description:
      'Finds public Facebook, Instagram, Threads, LinkedIn, X, TikTok and YouTube profiles/posts through search-engine site: queries. Name matches are candidates — never proof of identity.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const phrase = phraseOf(input);
    let n = 0;
    let dropped = 0;
    const perPlatform: Record<string, number> = {};
    for (const [gi, sites] of SOCIAL_SITE_GROUPS.entries()) {
      const q = `"${phrase}" (${sites.map((s) => `site:${s}`).join(' OR ')})`;
      const r = await searx(q);
      out.observations.push({ ref: `q${gi}`, url: r.url, raw: r.raw, contentType: 'application/json', title: `Social search: ${q}` });
      // search engines ignore site: for some engines — keep only results that really are on the platforms asked for
      const onSite = r.results.filter((x) => sites.some((s) => hostOf(x.url).endsWith(s.replace(/^www\./, ''))));
      const onPlatform = relevant(input, onSite);
      dropped += onSite.length - onPlatform.length;
      for (const x of onPlatform) {
        const p = classifySocialUrl(x.url)?.platform ?? hostOf(x.url);
        perPlatform[p] = (perPlatform[p] ?? 0) + 1;
      }
      n = mapSearxResults(out, input, onPlatform.slice(0, 25), { query: q, asArticle: false, offset: n });
    }
    out.notes = [`${n} social result(s): ${Object.entries(perPlatform).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; ${dropped} partial-name match(es) ignored`];
    return out;
  }
}

/** Tier C — news coverage via the SearXNG news category (national and regional portals). */
export class SearxNewsConnector implements Connector {
  readonly def: SourceDefinition = {
    ...SEARX_BASE,
    key: 'searxng.news',
    name: 'News Portals (SearXNG news search)',
    category: 'News / search index',
    baseUrl: config.searxngUrl,
    rateLimitPerMin: 20,
    allowedFields: ['headline', 'article url', 'snippet', 'published date', 'outlet'],
    inputTypes: ['PERSON', 'ORGANIZATION', 'EVENT', 'NARRATIVE'] as any,
    outputTypes: ['ARTICLE', 'DOMAIN'] as any,
    description: 'Searches news engines for the exact phrase; results feed the timeline and narrative analysis.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const q = `"${phraseOf(input)}"`;
    const r = await searx(q, { categories: 'news' });
    out.observations.push({ ref: 'q', url: r.url, raw: r.raw, contentType: 'application/json', title: `News search: ${q}` });
    const keep = relevant(input, r.results);
    const n = mapSearxResults(out, input, keep.slice(0, 30), { query: q, asArticle: true, offset: 0 });
    out.notes = [`${n} news result(s); ${r.results.length - keep.length} without every search token ignored`];
    return out;
  }
}

// ------------------------------------------------------------------ Google News RSS (Indonesian portals)

const xmlDecode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

/** Tier C — Google News RSS search feed (headline, outlet, date, link) for the configured region. */
export class GoogleNewsRssConnector implements Connector {
  readonly def: SourceDefinition = {
    key: 'gnews.rss',
    name: 'Google News (RSS search feed)',
    owner: 'Google News',
    category: 'News / search index',
    tier: 'C',
    accessMethod: 'RSS_FEED',
    baseUrl: 'https://news.google.com/rss/search',
    legalBasis: 'Public RSS feed of headlines and links; article bodies are only collected via web.page.',
    authMode: 'NONE',
    rateLimitPerMin: 10,
    allowedFields: ['headline', 'outlet', 'published date', 'link'],
    inputTypes: ['PERSON', 'ORGANIZATION', 'EVENT', 'NARRATIVE'] as any,
    outputTypes: ['ARTICLE', 'ORGANIZATION'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED',
    autoRun: true,
    description: `Headlines from national and regional news portals (region ${config.newsRegion}) mentioning the exact phrase.`,
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const [lang, region] = config.newsRegion.split('-');
    const q = `"${phraseOf(input)}"`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${lang}&gl=${region}&ceid=${region}:${lang}`;
    const r = await httpGet(url, { headers: { Accept: 'application/rss+xml,application/xml' } });
    out.observations.push({ ref: 'feed', url, raw: r.body, contentType: 'application/rss+xml', title: `Google News ${q}` });
    const items = [...r.text.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 40);
    items.forEach((m, i) => {
      const block = m[1];
      const tag = (t: string) => xmlDecode(block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? '');
      const outlet = tag('source');
      const outletUrl = block.match(/<source url="([^"]+)"/)?.[1] ?? '';
      const title = tag('title').replace(new RegExp(`\\s+-\\s+${outlet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
      const link = tag('link');
      const published = isoOrNull(tag('pubDate'));
      const obs = `a${i}`;
      out.observations.push({ ref: obs, url: link, title, text: `${title}. ${stripTags(tag('description'))}`, author: outlet, publishedAt: published, raw: block, contentType: 'application/xml', extract: true, entityRef: `art${i}` });
      out.entities.push({ ref: `art${i}`, type: 'ARTICLE', value: link, properties: { title, url: link, publisher: outlet, publisher_url: outletUrl, published_at: published }, confidence: 1, obsRef: obs });
      if (outlet) {
        out.entities.push({ ref: `pub${i}`, type: 'ORGANIZATION', value: outlet, properties: { kind: 'news outlet', url: outletUrl }, confidence: 0.9, obsRef: obs });
        out.relationships.push({ from: `pub${i}`, type: 'PUBLISHED', to: `art${i}`, confidence: 1, obsRef: obs });
      }
      out.relationships.push({ from: 'input', type: 'MENTIONED_IN', to: `art${i}`, confidence: 0.5, label: 'exact phrase in headline index', obsRef: obs });
    });
    out.notes = [`${items.length} headline(s)`];
    return out;
  }
}

// ------------------------------------------------------------------ official public APIs (no key)

type AccountHit = { platform: string; handle: string; url: string; name?: string | null; bio?: string | null; raw: unknown; extra?: Record<string, unknown> };

/** Shared mapping for "account search" APIs: candidate accounts related to the input by a weak name match. */
function mapAccounts(out: ConnectorOutput, hits: AccountHit[], matchLabel: string) {
  hits.forEach((h, i) => {
    const obs = `o${i}`;
    out.observations.push({ ref: obs, url: h.url, title: `${h.platform} @${h.handle}${h.name ? ` (${h.name})` : ''}`, text: [h.name, h.bio].filter(Boolean).join('. ') || null, author: `${h.platform}:${h.handle}`, raw: JSON.stringify(h.raw), contentType: 'application/json' });
    out.entities.push({ ref: `acct${i}`, type: 'SOCIAL_ACCOUNT', value: `${h.platform}:${h.handle.toLowerCase()}`, properties: { platform: h.platform, handle: h.handle, profile_url: h.url, display_name: h.name ?? null, bio: h.bio?.slice(0, 300) ?? null, ...(h.extra ?? {}) }, confidence: 0.9, obsRef: obs });
    out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: `acct${i}`, confidence: 0.35, label: matchLabel, obsRef: obs });
    if (h.name) {
      out.entities.push({ ref: `p${i}`, type: 'PERSON', value: h.name, hints: { discriminator: `${h.platform}:${h.handle.toLowerCase()}` }, properties: { self_declared: true }, confidence: 0.5, obsRef: obs });
      out.relationships.push({ from: `p${i}`, type: 'HAS_ACCOUNT', to: `acct${i}`, confidence: 0.6, label: 'profile display name', obsRef: obs });
    }
  });
}

const accountFilter = (input: TransformInput) => {
  const phrase = phraseOf(input);
  return (h: AccountHit) =>
    input.type === 'USERNAME' ? fold(h.handle).includes(fold(phrase)) : nameMatches(phrase, `${h.name ?? ''} ${h.handle}`);
};

/** Tier A — Bluesky public AppView: actor (account) search. */
export class BlueskyActorsConnector implements Connector {
  readonly def: SourceDefinition = {
    key: 'bluesky.actors',
    name: 'Bluesky Account Search',
    owner: 'Bluesky Social PBC',
    category: 'Social media',
    tier: 'A',
    accessMethod: 'OFFICIAL_API',
    baseUrl: 'https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors',
    legalBasis: 'Official public AT Protocol API; public profile fields only.',
    authMode: 'NONE',
    rateLimitPerMin: 30,
    allowedFields: ['handle', 'display name', 'bio', 'did'],
    inputTypes: ['PERSON', 'ORGANIZATION', 'USERNAME'] as any,
    outputTypes: ['SOCIAL_ACCOUNT', 'PERSON'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED',
    autoRun: true,
    description: 'Searches Bluesky accounts whose name or handle matches; only accounts containing every name token are kept.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const r = await httpJson<any>(`${this.def.baseUrl}?q=${encodeURIComponent(phraseOf(input))}&limit=25`);
    const hits: AccountHit[] = (r.data?.actors ?? []).map((a: any) => ({ platform: 'bluesky', handle: a.handle, url: `https://bsky.app/profile/${a.handle}`, name: a.displayName ?? null, bio: a.description ?? null, raw: a, extra: { did: a.did, created_at: a.createdAt ?? null } }));
    const kept = hits.filter(accountFilter(input)).slice(0, 15);
    out.observations.push({ ref: 'resp', url: `${this.def.baseUrl}?q=${encodeURIComponent(phraseOf(input))}`, raw: r.raw, contentType: 'application/json', title: `Bluesky account search "${phraseOf(input)}"` });
    mapAccounts(out, kept, 'name/handle match on Bluesky (candidate)');
    out.notes = [`${kept.length} of ${hits.length} Bluesky account(s) match every name token`];
    return out;
  }
}

/** Tier A — Mastodon / Fediverse account search (federated results include Threads accounts). */
export class MastodonAccountsConnector implements Connector {
  readonly def: SourceDefinition = {
    key: 'mastodon.accounts',
    name: 'Fediverse Account Search (Mastodon, Threads)',
    owner: 'Mastodon gGmbH (mastodon.social)',
    category: 'Social media',
    tier: 'A',
    accessMethod: 'OFFICIAL_API',
    baseUrl: `https://${config.mastodonInstance}/api/v2/search`,
    legalBasis: 'Official Mastodon REST API (unauthenticated account search); public profile fields only.',
    authMode: 'NONE',
    rateLimitPerMin: 20,
    allowedFields: ['acct', 'display name', 'bio', 'profile url', 'created at'],
    inputTypes: ['PERSON', 'ORGANIZATION', 'USERNAME'] as any,
    outputTypes: ['SOCIAL_ACCOUNT', 'PERSON'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED',
    autoRun: true,
    description: 'Searches federated accounts known to the instance, including Threads profiles that federate; only full name matches are kept.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const url = `${this.def.baseUrl}?q=${encodeURIComponent(phraseOf(input))}&type=accounts&limit=40&resolve=false`;
    const r = await httpJson<any>(url);
    const hits: AccountHit[] = (r.data?.accounts ?? []).map((a: any) => {
      const domain = String(a.acct).includes('@') ? String(a.acct).split('@')[1] : config.mastodonInstance;
      const platform = /threads\.(net|com)$/.test(domain) ? 'threads' : 'mastodon';
      return { platform, handle: platform === 'threads' ? a.username : a.acct, url: a.url, name: a.display_name || null, bio: stripTags(a.note) || null, raw: a, extra: { instance: domain, created_at: a.created_at, followers: a.followers_count } };
    });
    const kept = hits.filter(accountFilter(input)).slice(0, 15);
    out.observations.push({ ref: 'resp', url, raw: r.raw, contentType: 'application/json', title: `Fediverse account search "${phraseOf(input)}"` });
    mapAccounts(out, kept, 'name/handle match on the Fediverse (candidate)');
    out.notes = [`${kept.length} of ${hits.length} Fediverse account(s) match every name token`];
    return out;
  }
}

/** Tier A — Stack Exchange users by display name (Stack Overflow). */
export class StackExchangeUsersConnector implements Connector {
  readonly def: SourceDefinition = {
    key: 'stackexchange.users',
    name: 'Stack Overflow User Search',
    owner: 'Stack Exchange Inc.',
    category: 'Developer / community platforms',
    tier: 'A',
    accessMethod: 'OFFICIAL_API',
    baseUrl: 'https://api.stackexchange.com/2.3/users',
    legalBasis: 'Official Stack Exchange API; public profile fields only.',
    authMode: 'NONE',
    rateLimitPerMin: 20,
    allowedFields: ['display name', 'profile url', 'location', 'website', 'reputation'],
    inputTypes: ['PERSON', 'USERNAME'] as any,
    outputTypes: ['SOCIAL_ACCOUNT', 'PERSON', 'LOCATION', 'URL'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED',
    autoRun: true,
    description: 'Finds Stack Overflow users whose display name matches the searched name.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const url = `${this.def.baseUrl}?inname=${encodeURIComponent(phraseOf(input))}&site=stackoverflow&pagesize=20&order=desc&sort=reputation`;
    const r = await httpJson<any>(url);
    const hits: AccountHit[] = (r.data?.items ?? []).map((u: any) => ({ platform: 'stackoverflow', handle: String(u.user_id), url: u.link, name: stripTags(u.display_name), bio: [u.location, u.website_url].filter(Boolean).join(' · ') || null, raw: u, extra: { reputation: u.reputation, location: u.location ?? null, website: u.website_url || null } }));
    const kept = hits.filter((h) => nameMatches(phraseOf(input), h.name ?? '')).slice(0, 10);
    out.observations.push({ ref: 'resp', url, raw: r.raw, contentType: 'application/json', title: `Stack Overflow user search "${phraseOf(input)}"` });
    mapAccounts(out, kept, 'display-name match on Stack Overflow (candidate)');
    out.notes = [`${kept.length} Stack Overflow user(s)`];
    return out;
  }
}

/** Tier A — GitHub user search by full name (then profile lookup to confirm the public name). */
export class GithubUserSearchConnector implements Connector {
  readonly def: SourceDefinition = {
    key: 'github.search',
    name: 'GitHub User Search (by name)',
    owner: 'GitHub',
    category: 'Developer platform',
    tier: 'A',
    accessMethod: 'OFFICIAL_API',
    baseUrl: 'https://api.github.com/search/users',
    legalBasis: 'Official REST API; public profile fields only.',
    authMode: 'TOKEN',
    rateLimitPerMin: 10,
    allowedFields: ['login', 'public name', 'profile url', 'location', 'company', 'blog'],
    inputTypes: ['PERSON'] as any,
    outputTypes: ['SOCIAL_ACCOUNT', 'PERSON'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED',
    autoRun: true,
    description: 'Searches GitHub users by public name and keeps accounts whose profile name matches every name token.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
    const phrase = phraseOf(input);
    const url = `${this.def.baseUrl}?q=${encodeURIComponent(`"${phrase}" in:name`)}&per_page=10`;
    const r = await httpJson<any>(url, { headers });
    out.observations.push({ ref: 'resp', url, raw: r.raw, contentType: 'application/json', title: `GitHub user search "${phrase}"` });
    const hits: AccountHit[] = [];
    for (const u of (r.data?.items ?? []).slice(0, 6)) {
      const p = await httpJson<any>(`https://api.github.com/users/${encodeURIComponent(u.login)}`, { headers, allow404: true }).catch(() => null);
      const d = p?.data;
      if (!d) continue;
      hits.push({ platform: 'github', handle: d.login, url: d.html_url, name: d.name, bio: [d.bio, d.company, d.location].filter(Boolean).join(' · ') || null, raw: d, extra: { location: d.location ?? null, company: d.company ?? null, blog: d.blog || null, created_at: d.created_at } });
    }
    const kept = hits.filter((h) => nameMatches(phrase, h.name ?? ''));
    mapAccounts(out, kept, 'public-name match on GitHub (candidate)');
    out.notes = [`${kept.length} GitHub account(s) with matching public name`];
    return out;
  }
}

/** Tier A — Hacker News full-text search (Algolia HN API): stories and comments mentioning the phrase. */
export class HackerNewsSearchConnector implements Connector {
  readonly def: SourceDefinition = {
    key: 'hn.search',
    name: 'Hacker News Search',
    owner: 'Y Combinator (Algolia HN API)',
    category: 'Forums / community',
    tier: 'A',
    accessMethod: 'OFFICIAL_API',
    baseUrl: 'https://hn.algolia.com/api/v1/search',
    legalBasis: 'Official public search API over public posts.',
    authMode: 'NONE',
    rateLimitPerMin: 30,
    allowedFields: ['post title/text', 'author', 'date', 'url'],
    inputTypes: ['PERSON', 'ORGANIZATION', 'DOMAIN'] as any,
    outputTypes: ['ARTICLE', 'SOCIAL_ACCOUNT'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED',
    autoRun: true,
    description: 'Finds Hacker News stories and comments containing the exact phrase.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const url = `${this.def.baseUrl}?query=${encodeURIComponent(`"${phraseOf(input)}"`)}&tags=(story,comment)&hitsPerPage=25`;
    const r = await httpJson<any>(url);
    out.observations.push({ ref: 'resp', url, raw: r.raw, contentType: 'application/json', title: `Hacker News search "${phraseOf(input)}"` });
    (r.data?.hits ?? []).forEach((h: any, i: number) => {
      const link = `https://news.ycombinator.com/item?id=${h.objectID}`;
      const title = stripTags(h.title ?? h.story_title ?? 'HN comment').slice(0, 300);
      const text = stripTags(h.comment_text ?? h.story_text ?? '');
      const obs = `h${i}`;
      out.observations.push({ ref: obs, url: link, title, text: `${title}. ${text}`.slice(0, 5000), author: `hackernews:${h.author}`, publishedAt: isoOrNull(h.created_at), raw: JSON.stringify(h), contentType: 'application/json', extract: true, entityRef: `post${i}` });
      out.entities.push({ ref: `post${i}`, type: 'ARTICLE', value: link, properties: { title, url: link, platform: 'hackernews', published_at: isoOrNull(h.created_at) }, confidence: 1, obsRef: obs });
      out.entities.push({ ref: `au${i}`, type: 'SOCIAL_ACCOUNT', value: `hackernews:${String(h.author).toLowerCase()}`, properties: { platform: 'hackernews', handle: h.author, profile_url: `https://news.ycombinator.com/user?id=${h.author}` }, confidence: 1, obsRef: obs });
      out.relationships.push({ from: `au${i}`, type: 'PUBLISHED', to: `post${i}`, confidence: 1, obsRef: obs });
      out.relationships.push({ from: 'input', type: 'MENTIONED_IN', to: `post${i}`, confidence: 0.5, label: 'exact phrase in post', obsRef: obs });
    });
    out.notes = [`${r.data?.hits?.length ?? 0} Hacker News post(s)`];
    return out;
  }
}

// ------------------------------------------------------------------ official APIs that need credentials

/** Shared mapping for post search APIs. */
function mapPosts(
  out: ConnectorOutput,
  posts: { platform: string; url: string; title: string; text: string; author: string; authorName?: string | null; authorUrl: string; publishedAt: string | null; raw: unknown }[],
) {
  posts.forEach((p, i) => {
    const obs = `p${i}`;
    out.observations.push({ ref: obs, url: p.url, title: p.title.slice(0, 300), text: p.text.slice(0, 8000), author: `${p.platform}:${p.author}`, publishedAt: p.publishedAt, raw: JSON.stringify(p.raw), contentType: 'application/json', extract: true, entityRef: `post${i}` });
    out.entities.push({ ref: `post${i}`, type: 'ARTICLE', value: p.url, properties: { title: p.title.slice(0, 300), url: p.url, platform: p.platform, published_at: p.publishedAt }, confidence: 1, obsRef: obs });
    out.entities.push({ ref: `au${i}`, type: 'SOCIAL_ACCOUNT', value: `${p.platform}:${p.author.toLowerCase()}`, properties: { platform: p.platform, handle: p.author, display_name: p.authorName ?? null, profile_url: p.authorUrl }, confidence: 1, obsRef: obs });
    out.relationships.push({ from: `au${i}`, type: 'PUBLISHED', to: `post${i}`, confidence: 1, obsRef: obs });
    out.relationships.push({ from: 'input', type: 'MENTIONED_IN', to: `post${i}`, confidence: 0.5, label: 'phrase appears in post', obsRef: obs });
  });
}

const POST_BASE = {
  tier: 'A' as const,
  accessMethod: 'OFFICIAL_API',
  retentionDays: 180,
  defaultPolicy: 'APPROVED' as const,
  autoRun: true,
  inputTypes: ['PERSON', 'ORGANIZATION', 'USERNAME', 'EVENT', 'NARRATIVE'] as any,
  outputTypes: ['ARTICLE', 'SOCIAL_ACCOUNT'] as any,
  category: 'Social media',
};

/** Tier A — Reddit search via the official OAuth API (app-only). */
export class RedditSearchConnector implements Connector {
  readonly def: SourceDefinition = {
    ...POST_BASE,
    key: 'reddit.search',
    name: 'Reddit Search (official API)',
    owner: 'Reddit Inc.',
    baseUrl: 'https://oauth.reddit.com/search',
    legalBasis: 'Official Reddit Data API under its developer terms (app-only OAuth); public posts only.',
    authMode: 'API_KEY',
    rateLimitPerMin: 30,
    allowedFields: ['post title/text', 'subreddit', 'author', 'date', 'permalink'],
    description: 'Searches public Reddit posts for the exact phrase. Requires REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET.',
    requiresCredential: () => !(config.redditClientId && config.redditClientSecret),
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const tok = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.redditClientId}:${config.redditClientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': config.httpUserAgent,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20000),
    }).then((x) => x.json() as Promise<any>);
    if (!tok?.access_token) throw new Error(`Reddit OAuth failed: ${JSON.stringify(tok).slice(0, 200)}`);
    const url = `${this.def.baseUrl}?q=${encodeURIComponent(`"${phraseOf(input)}"`)}&limit=50&sort=new&type=link`;
    const r = await httpJson<any>(url, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    out.observations.push({ ref: 'resp', url, raw: r.raw, contentType: 'application/json', title: `Reddit search "${phraseOf(input)}"` });
    const posts = (r.data?.data?.children ?? []).map((c: any) => c.data).map((d: any) => ({
      platform: 'reddit',
      url: `https://www.reddit.com${d.permalink}`,
      title: `r/${d.subreddit}: ${d.title}`,
      text: `${d.title}. ${d.selftext ?? ''}`,
      author: d.author,
      authorUrl: `https://www.reddit.com/user/${d.author}`,
      publishedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
      raw: d,
    }));
    mapPosts(out, posts);
    out.notes = [`${posts.length} Reddit post(s)`];
    return out;
  }
}

/** Tier A — YouTube Data API v3: videos and channels matching the phrase. */
export class YoutubeSearchConnector implements Connector {
  readonly def: SourceDefinition = {
    ...POST_BASE,
    key: 'youtube.search',
    name: 'YouTube Search (Data API v3)',
    owner: 'Google (YouTube)',
    baseUrl: 'https://www.googleapis.com/youtube/v3/search',
    legalBasis: 'Official YouTube Data API under the YouTube API Services terms; public videos/channels only.',
    authMode: 'API_KEY',
    rateLimitPerMin: 20,
    allowedFields: ['video/channel title', 'description', 'channel', 'published date', 'url'],
    description: 'Finds public YouTube videos and channels mentioning the phrase. Requires YOUTUBE_API_KEY.',
    requiresCredential: () => !config.youtubeApiKey,
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const url = `${this.def.baseUrl}?part=snippet&maxResults=25&type=video,channel&q=${encodeURIComponent(`"${phraseOf(input)}"`)}&key=${config.youtubeApiKey}`;
    const r = await httpJson<any>(url);
    out.observations.push({ ref: 'resp', url: url.replace(config.youtubeApiKey, '***'), raw: r.raw, contentType: 'application/json', title: `YouTube search "${phraseOf(input)}"` });
    const posts = (r.data?.items ?? []).map((it: any) => {
      const s = it.snippet ?? {};
      const isChannel = it.id?.kind === 'youtube#channel';
      return {
        platform: 'youtube',
        url: isChannel ? `https://www.youtube.com/channel/${it.id.channelId}` : `https://www.youtube.com/watch?v=${it.id.videoId}`,
        // the API returns HTML-escaped snippet text (&#39;, &amp;)
        title: stripTags(s.title),
        text: `${stripTags(s.title)}. ${stripTags(s.description)}`,
        author: s.channelId,
        authorName: stripTags(s.channelTitle),
        authorUrl: `https://www.youtube.com/channel/${s.channelId}`,
        publishedAt: isoOrNull(s.publishedAt),
        raw: it,
      };
    });
    // YouTube search ignores quotes ("Fakhul Huda" also returns "Fathul Huda"): keep items naming every token
    const phrase = phraseOf(input);
    const kept = posts.filter((p: any) => nameMatches(phrase, `${p.text} ${p.authorName ?? ''}`));
    mapPosts(out, kept);
    out.notes = [`${kept.length} of ${posts.length} YouTube item(s) contain every search token`];
    return out;
  }
}

/** Tier A — X (Twitter) API v2 recent search (last 7 days). */
export class XRecentSearchConnector implements Connector {
  readonly def: SourceDefinition = {
    ...POST_BASE,
    key: 'x.search',
    name: 'X Recent Search (API v2)',
    owner: 'X Corp.',
    baseUrl: 'https://api.x.com/2/tweets/search/recent',
    legalBasis: 'Official X API v2 under the X developer agreement; public posts only.',
    authMode: 'TOKEN',
    rateLimitPerMin: 5,
    allowedFields: ['post text', 'author handle/name', 'created at', 'url'],
    description: 'Searches public X posts from the last 7 days. Requires X_BEARER_TOKEN (paid API tier).',
    requiresCredential: () => !config.xBearerToken,
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const query = `"${phraseOf(input)}" -is:retweet`;
    const url = `${this.def.baseUrl}?query=${encodeURIComponent(query)}&max_results=50&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username,name`;
    const r = await httpJson<any>(url, { headers: { Authorization: `Bearer ${config.xBearerToken}` } });
    out.observations.push({ ref: 'resp', url, raw: r.raw, contentType: 'application/json', title: `X search ${query}` });
    const users = new Map<string, any>((r.data?.includes?.users ?? []).map((u: any) => [u.id, u]));
    const posts = (r.data?.data ?? []).map((t: any) => {
      const u = users.get(t.author_id) ?? { username: t.author_id, name: null };
      return { platform: 'x', url: `https://x.com/${u.username}/status/${t.id}`, title: `@${u.username}: ${t.text.slice(0, 120)}`, text: t.text, author: u.username, authorName: u.name, authorUrl: `https://x.com/${u.username}`, publishedAt: isoOrNull(t.created_at), raw: t };
    });
    mapPosts(out, posts);
    out.notes = [`${posts.length} X post(s)`];
    return out;
  }
}

/** Tier A — Bluesky post search (authenticated with an app password). */
export class BlueskyPostsConnector implements Connector {
  readonly def: SourceDefinition = {
    ...POST_BASE,
    key: 'bluesky.posts',
    name: 'Bluesky Post Search',
    owner: 'Bluesky Social PBC',
    baseUrl: 'https://bsky.social/xrpc/app.bsky.feed.searchPosts',
    legalBasis: 'Official AT Protocol API with an app password; public posts only.',
    authMode: 'TOKEN',
    rateLimitPerMin: 20,
    allowedFields: ['post text', 'author handle/name', 'created at', 'url'],
    description: 'Searches public Bluesky posts for the exact phrase. Requires BLUESKY_HANDLE / BLUESKY_APP_PASSWORD.',
    requiresCredential: () => !(config.blueskyHandle && config.blueskyAppPassword),
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const session = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': config.httpUserAgent },
      body: JSON.stringify({ identifier: config.blueskyHandle, password: config.blueskyAppPassword }),
      signal: AbortSignal.timeout(20000),
    }).then((x) => x.json() as Promise<any>);
    if (!session?.accessJwt) throw new Error(`Bluesky login failed: ${session?.message ?? 'no token'}`);
    const url = `${this.def.baseUrl}?q=${encodeURIComponent(`"${phraseOf(input)}"`)}&limit=50&sort=latest`;
    const r = await httpJson<any>(url, { headers: { Authorization: `Bearer ${session.accessJwt}` } });
    out.observations.push({ ref: 'resp', url, raw: r.raw, contentType: 'application/json', title: `Bluesky post search "${phraseOf(input)}"` });
    const posts = (r.data?.posts ?? []).map((p: any) => {
      const rkey = String(p.uri).split('/').pop();
      const text = p.record?.text ?? '';
      return { platform: 'bluesky', url: `https://bsky.app/profile/${p.author.handle}/post/${rkey}`, title: `@${p.author.handle}: ${text.slice(0, 120)}`, text, author: p.author.handle, authorName: p.author.displayName, authorUrl: `https://bsky.app/profile/${p.author.handle}`, publishedAt: isoOrNull(p.record?.createdAt ?? p.indexedAt), raw: p };
    });
    mapPosts(out, posts);
    out.notes = [`${posts.length} Bluesky post(s)`];
    return out;
  }
}

/** Tier B — Reddit post search through RedditAPIs (redditapis.com, third party, $0.002 per read). */
export class RedditapisSearchConnector implements Connector {
  readonly def: SourceDefinition = {
    ...POST_BASE,
    tier: 'B',
    accessMethod: 'LICENSED_PROVIDER_API',
    // paid per call: an administrator approves it in the Transform Hub
    defaultPolicy: 'PENDING',
    key: 'redditapis.search',
    name: 'Reddit Search (RedditAPIs)',
    owner: 'RedditAPIs (third party, not affiliated with Reddit Inc.)',
    baseUrl: 'https://api.redditapis.com/api/reddit/search',
    legalBasis: 'Paid third-party read API over public Reddit posts, under the provider terms; no private content.',
    authMode: 'API_KEY',
    rateLimitPerMin: 30,
    allowedFields: ['post title/text', 'subreddit', 'author', 'date', 'permalink', 'score'],
    description: 'Searches public Reddit posts for the exact phrase (1 call, ~$0.002). Requires REDDITAPIS_TOKEN.',
    requiresCredential: () => !config.redditapisToken,
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const phrase = phraseOf(input);
    const url = `${this.def.baseUrl}?q=${encodeURIComponent(`"${phrase}"`)}&sort=new&t=all&limit=50`;
    const r = await httpJson<any>(url, { headers: { Authorization: `Bearer ${config.redditapisToken}` }, timeoutMs: 45000 });
    out.observations.push({ ref: 'resp', url, raw: r.raw, contentType: 'application/json', title: `Reddit search "${phrase}" (RedditAPIs)` });
    const all = (r.data?.posts ?? []).map((d: any) => ({
      platform: 'reddit',
      url: d.url?.startsWith('https://') ? d.url : `https://www.reddit.com${d.permalink}`,
      title: `r/${d.subreddit}: ${d.title}`,
      text: `${d.title}. ${d.text ?? ''}`,
      author: d.author,
      authorUrl: `https://www.reddit.com/user/${d.author}`,
      publishedAt: d.created ? isoOrNull(d.created) : d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
      raw: d,
    }));
    // keep posts that really contain every token of the phrase (search engines are fuzzy)
    const posts = all.filter((p: any) => p.author && nameMatches(phrase, p.text));
    mapPosts(out, posts);
    out.notes = [`${posts.length} of ${all.length} Reddit post(s) contain every search token`];
    return out;
  }
}

// ------------------------------------------------------------------ SandBase (licensed data provider)

/** Calls one SandBase data model through the unified run API (sync mode) and returns the business payload. */
async function sandbaseRun(model: string, params: Record<string, unknown>) {
  const res = await fetch('https://api.sandbase.ai/v1/run', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.sandbaseApiKey}`, 'Content-Type': 'application/json', 'User-Agent': config.httpUserAgent },
    body: JSON.stringify({ model, ...params }),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`SandBase ${model} → HTTP ${res.status} ${raw.slice(0, 200)}`);
  const body = JSON.parse(raw);
  if (body.status && body.status !== 'completed') throw new Error(`SandBase ${model} status ${body.status}: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
  const first = body.outputs?.[0];
  return { raw, data: first?.data ?? first ?? body.data ?? body };
}

/** Depth-first walk over a payload whose shape differs per upstream platform/version. */
function walk(node: unknown, visit: (o: Record<string, any>) => void, depth = 0) {
  if (depth > 14 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) walk(x, visit, depth + 1);
    return;
  }
  visit(node as Record<string, any>);
  for (const v of Object.values(node)) walk(v, visit, depth + 1);
}

const SANDBASE_BASE = {
  owner: 'SandBase (licensed data provider)',
  category: 'Social media',
  tier: 'B' as const,
  accessMethod: 'LICENSED_PROVIDER_API',
  authMode: 'API_KEY' as const,
  retentionDays: 180,
  // paid per call: an administrator approves it in the Transform Hub before sweeps use it
  defaultPolicy: 'PENDING' as const,
  autoRun: true,
  legalBasis: 'Licensed third-party provider of public profile/post data under its terms; no private accounts, no login on the target platform.',
  requiresCredential: () => !config.sandbaseApiKey,
};

/** Tier B — public X posts and accounts through SandBase (`twitter/web/search-timeline`, $0.001 per call). */
export class SandbaseXSearchConnector implements Connector {
  readonly def: SourceDefinition = {
    ...SANDBASE_BASE,
    key: 'sandbase.x',
    name: 'X / Twitter Search (SandBase)',
    baseUrl: 'https://api.sandbase.ai/v1/run · twitter/web/search-timeline',
    rateLimitPerMin: 20,
    allowedFields: ['post text', 'author handle/name', 'created at', 'url', 'public account profile'],
    inputTypes: ['PERSON', 'ORGANIZATION', 'USERNAME', 'EVENT', 'NARRATIVE'] as any,
    outputTypes: ['ARTICLE', 'SOCIAL_ACCOUNT', 'PERSON'] as any,
    description: 'Searches latest public X posts with the exact phrase and X accounts matching the name (2 calls, ~$0.002). Requires SANDBASE_API_KEY.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const phrase = phraseOf(input);
    const posts = await sandbaseRun('twitter/web/search-timeline', { keyword: `"${phrase}"`, search_type: 'Latest' });
    out.observations.push({ ref: 'posts', url: 'sandbase:twitter/web/search-timeline', raw: posts.raw, contentType: 'application/json', title: `X search "${phrase}" (SandBase)` });
    const people = await sandbaseRun('twitter/web/search-timeline', { keyword: phrase, search_type: 'People' });
    out.observations.push({ ref: 'people', url: 'sandbase:twitter/web/search-timeline#people', raw: people.raw, contentType: 'application/json', title: `X people search "${phrase}" (SandBase)` });

    // tweets: objects with text + a numeric id, whose author carries a screen name
    const tweets = new Map<string, Parameters<typeof mapPosts>[1][number]>();
    walk(posts.data, (o) => {
      const text = o.full_text ?? o.text ?? o.legacy?.full_text;
      const id = String(o.tweet_id ?? o.rest_id ?? o.id_str ?? o.legacy?.id_str ?? o.id ?? '');
      const user = o.user ?? o.core?.user_results?.result ?? o.user_info ?? (typeof o.author === 'object' ? o.author : null);
      const handle = String(user?.screen_name ?? user?.legacy?.screen_name ?? user?.core?.screen_name ?? user?.username ?? (typeof o.author === 'string' ? o.author : '') ?? '').replace(/^@/, '');
      if (typeof text !== 'string' || !/^\d{5,}$/.test(id) || !handle || tweets.has(id)) return;
      tweets.set(id, {
        platform: 'x',
        url: `https://x.com/${handle}/status/${id}`,
        title: `@${handle}: ${text.slice(0, 120)}`,
        text,
        author: handle,
        authorName: user?.name ?? user?.legacy?.name ?? user?.core?.name ?? null,
        authorUrl: `https://x.com/${handle}`,
        publishedAt: isoOrNull(o.created_at ?? o.legacy?.created_at),
        raw: o,
      });
    });
    mapPosts(out, [...tweets.values()].slice(0, 50));

    // accounts: objects with a screen name and a display name; kept only on a full name match
    const accounts = new Map<string, AccountHit>();
    walk(people.data, (o) => {
      const handle = String(o.screen_name ?? o.legacy?.screen_name ?? o.core?.screen_name ?? '').replace(/^@/, '');
      const name = o.name ?? o.legacy?.name ?? o.core?.name ?? null;
      if (!handle || !name || accounts.has(handle.toLowerCase())) return;
      accounts.set(handle.toLowerCase(), { platform: 'x', handle, url: `https://x.com/${handle}`, name, bio: o.description ?? o.legacy?.description ?? null, raw: o, extra: { followers: o.followers_count ?? o.legacy?.followers_count ?? null } });
    });
    const kept = [...accounts.values()].filter(accountFilter(input)).slice(0, 15);
    mapAccounts(out, kept, 'name/handle match on X (candidate)');
    out.notes = [`${tweets.size} X post(s); ${kept.length} of ${accounts.size} X account(s) match every name token`];
    return out;
  }
}

/** Tier B — public Instagram accounts through SandBase (`instagram/v3/search-users`, $0.008 per call). */
export class SandbaseInstagramUsersConnector implements Connector {
  readonly def: SourceDefinition = {
    ...SANDBASE_BASE,
    key: 'sandbase.instagram',
    name: 'Instagram Account Search (SandBase)',
    baseUrl: 'https://api.sandbase.ai/v1/run · instagram/v3/search-users',
    rateLimitPerMin: 20,
    allowedFields: ['username', 'full name', 'verified flag', 'profile url'],
    inputTypes: ['PERSON', 'ORGANIZATION', 'USERNAME'] as any,
    outputTypes: ['SOCIAL_ACCOUNT', 'PERSON'] as any,
    description: 'Finds public Instagram accounts whose name or username matches (1 call, ~$0.008). Private accounts are never accessed. Requires SANDBASE_API_KEY.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const phrase = phraseOf(input);
    const r = await sandbaseRun('instagram/v3/search-users', { query: phrase });
    out.observations.push({ ref: 'resp', url: 'sandbase:instagram/v3/search-users', raw: r.raw, contentType: 'application/json', title: `Instagram account search "${phrase}" (SandBase)` });
    const hits = new Map<string, AccountHit>();
    walk(r.data, (o) => {
      const u = typeof o.username === 'string' ? o : o.user && typeof o.user.username === 'string' ? o.user : null;
      if (!u || hits.has(u.username.toLowerCase())) return;
      hits.set(u.username.toLowerCase(), {
        platform: 'instagram',
        handle: u.username,
        url: `https://www.instagram.com/${u.username}`,
        name: u.full_name ?? null,
        bio: u.biography ?? null,
        raw: u,
        extra: { verified: u.is_verified ?? null, private: u.is_private ?? null, instagram_id: String(u.pk ?? u.id ?? '') || null },
      });
    });
    const kept = [...hits.values()].filter(accountFilter(input)).slice(0, 15);
    mapAccounts(out, kept, 'name/username match on Instagram (candidate)');
    out.notes = [`${kept.length} of ${hits.size} Instagram account(s) match every name token`];
    return out;
  }
}
