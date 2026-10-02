import { promises as dns } from 'node:dns';
import { Connector, ConnectorOutput, emptyOutput, TransformInput } from './connector.types';
import { httpJson } from './http';

const COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

/** Tier E — offline identifier parser: phone numbering plan, email domain, URL host. */
export class IdentifierParserConnector implements Connector {
  readonly def = {
    key: 'local.identifier-parser',
    name: 'Identifier Parser (offline)',
    owner: 'Platform',
    category: 'Normalization',
    tier: 'E' as const,
    accessMethod: 'LOCAL_COMPUTATION',
    legalBasis: 'Derives facts only from identifiers already supplied to the case; no external access.',
    authMode: 'INTERNAL' as const,
    rateLimitPerMin: 600,
    allowedFields: ['e164', 'country_code', 'line_type', 'domain', 'local_part'],
    inputTypes: ['PHONE', 'EMAIL', 'URL', 'SOCIAL_ACCOUNT'] as any,
    outputTypes: ['LOCATION', 'DOMAIN', 'USERNAME'] as any,
    retentionDays: 3650,
    defaultPolicy: 'APPROVED' as const,
    autoRun: true,
    description:
      'Parses phone numbers (libphonenumber numbering-plan metadata), email addresses and URLs into derived identifiers. WhatsApp is recorded as an identifier namespace only.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const raw = { input: { type: input.type, value: input.value }, derived: {} as Record<string, unknown> };
    out.observations.push({ ref: 'obs', raw: '', contentType: 'application/json', title: `Parsed ${input.type}` });
    if (input.type === 'PHONE') {
      const cc = input.properties.country_code as string | undefined;
      raw.derived = { ...input.properties };
      if (cc) {
        out.entities.push({ ref: 'country', type: 'LOCATION', value: COUNTRY_NAMES.of(cc) ?? cc, properties: { country_code: cc, level: 'country' }, confidence: 0.9, obsRef: 'obs' });
        out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: 'country', confidence: 0.9, label: 'numbering plan country', obsRef: 'obs' });
      }
      out.attributes!.push({ entityRef: 'input', key: 'line_type', value: String(input.properties.line_type ?? 'UNKNOWN'), obsRef: 'obs' });
    } else if (input.type === 'EMAIL') {
      const [local, domain] = input.value.split('@');
      raw.derived = { local, domain, free_provider: input.properties.free_provider, generic_mailbox: input.properties.generic_mailbox };
      out.entities.push({ ref: 'domain', type: 'DOMAIN', value: domain, confidence: 1, obsRef: 'obs' });
      out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: 'domain', confidence: 1, label: 'email domain', obsRef: 'obs' });
      if (!input.properties.generic_mailbox && local.split('+')[0].length >= 4) {
        out.entities.push({ ref: 'alias', type: 'USERNAME', value: local.split('+')[0], confidence: 0.3, obsRef: 'obs' });
        out.relationships.push({ from: 'input', type: 'USES_ALIAS', to: 'alias', confidence: 0.3, label: 'local-part as possible handle (weak)', obsRef: 'obs' });
      }
    } else if (input.type === 'URL' || input.type === 'SOCIAL_ACCOUNT') {
      const url = (input.properties.url ?? input.properties.profile_url ?? input.value) as string;
      try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        raw.derived = { host };
        out.entities.push({ ref: 'domain', type: 'DOMAIN', value: host, confidence: 1, obsRef: 'obs' });
        out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: 'domain', confidence: 1, label: 'hosted on', obsRef: 'obs' });
      } catch {
        out.notes = ['Not a parseable URL'];
      }
    }
    out.observations[0].raw = JSON.stringify(raw, null, 2);
    return out;
  }
}

/** Tier A — public DNS resolution. */
export class DnsConnector implements Connector {
  readonly def = {
    key: 'dns.resolve',
    name: 'Public DNS Resolver',
    owner: 'Internet DNS',
    category: 'Infrastructure',
    tier: 'A' as const,
    accessMethod: 'DNS_PROTOCOL',
    legalBasis: 'Public DNS records published by the domain operator.',
    authMode: 'NONE' as const,
    rateLimitPerMin: 120,
    allowedFields: ['A', 'MX', 'NS', 'TXT(spf/verification)'],
    inputTypes: ['DOMAIN'] as any,
    outputTypes: ['IP_ADDRESS', 'DOMAIN'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED' as const,
    autoRun: true,
    description: 'Resolves A, MX, NS and TXT records for a domain.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const d = input.value;
    const [a, mx, ns, txt] = await Promise.allSettled([dns.resolve4(d), dns.resolveMx(d), dns.resolveNs(d), dns.resolveTxt(d)]);
    const val = <T>(r: PromiseSettledResult<T>): T | [] => (r.status === 'fulfilled' ? r.value : []);
    const record = { domain: d, A: val(a), MX: val(mx), NS: val(ns), TXT: (val(txt) as string[][]).map((t) => t.join('')) };
    out.observations.push({ ref: 'obs', raw: JSON.stringify(record, null, 2), contentType: 'application/json', title: `DNS records for ${d}` });
    (record.A as string[]).slice(0, 10).forEach((ip, i) => {
      out.entities.push({ ref: `ip${i}`, type: 'IP_ADDRESS', value: ip, confidence: 1, obsRef: 'obs' });
      out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: `ip${i}`, confidence: 1, label: 'A record', obsRef: 'obs' });
    });
    (record.MX as { exchange: string }[]).slice(0, 5).forEach((m, i) => {
      out.entities.push({ ref: `mx${i}`, type: 'DOMAIN', value: m.exchange.toLowerCase(), confidence: 1, obsRef: 'obs' });
      out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: `mx${i}`, confidence: 1, label: 'MX record', obsRef: 'obs' });
    });
    (record.NS as string[]).slice(0, 4).forEach((n, i) => {
      out.entities.push({ ref: `ns${i}`, type: 'DOMAIN', value: n.toLowerCase(), confidence: 1, obsRef: 'obs' });
      out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: `ns${i}`, confidence: 1, label: 'NS record', obsRef: 'obs' });
    });
    const spf = record.TXT.find((t) => t.startsWith('v=spf1'));
    if (spf) out.attributes!.push({ entityRef: 'input', key: 'spf', value: spf.slice(0, 300), obsRef: 'obs' });
    return out;
  }
}

/** Tier A — RDAP (the IETF successor of WHOIS) via the IANA bootstrap redirector. */
export class RdapConnector implements Connector {
  readonly def = {
    key: 'rdap.domain',
    name: 'RDAP Domain Registration',
    owner: 'Registries via rdap.org',
    category: 'Infrastructure',
    tier: 'A' as const,
    accessMethod: 'OFFICIAL_API',
    baseUrl: 'https://rdap.org/domain/',
    legalBasis: 'Public registration data service (RFC 9083); redacted personal data is not recovered.',
    authMode: 'NONE' as const,
    rateLimitPerMin: 10,
    allowedFields: ['registrar', 'events', 'nameservers', 'registrant organization (if published)'],
    inputTypes: ['DOMAIN'] as any,
    outputTypes: ['ORGANIZATION', 'DOMAIN', 'LOCATION'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED' as const,
    autoRun: true,
    description: 'Registrar, registration/expiry dates, nameservers and published registrant organisation.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const res = await httpJson<any>(`https://rdap.org/domain/${encodeURIComponent(input.value)}`, { allow404: true });
    if (!res.data) {
      out.notes = ['No RDAP record'];
      return out;
    }
    out.observations.push({ ref: 'obs', url: res.url, raw: res.raw, contentType: 'application/rdap+json', title: `RDAP ${input.value}` });
    const vcardValue = (ent: any, field: string) =>
      (ent?.vcardArray?.[1] ?? []).find((f: any[]) => f[0] === field)?.[3] as string | undefined;
    const entities: any[] = res.data.entities ?? [];
    let i = 0;
    for (const ent of entities) {
      const roles: string[] = ent.roles ?? [];
      const org = vcardValue(ent, 'org') ?? vcardValue(ent, 'fn');
      if (!org || /redacted|privacy|withheld|data protected/i.test(org)) continue;
      const role = roles.includes('registrar') ? 'registrar' : roles.includes('registrant') ? 'registrant' : roles[0];
      if (!['registrar', 'registrant'].includes(role)) continue;
      const ref = `org${i++}`;
      out.entities.push({ ref, type: 'ORGANIZATION', value: String(org), confidence: 0.9, obsRef: 'obs', properties: { rdap_role: role } });
      out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: ref, confidence: 0.9, label: `RDAP ${role}`, obsRef: 'obs' });
      const country = (ent?.vcardArray?.[1] ?? []).find((f: any[]) => f[0] === 'adr')?.[1]?.cc;
      if (role === 'registrant' && country) {
        out.entities.push({ ref: `${ref}loc`, type: 'LOCATION', value: String(country), confidence: 0.7, obsRef: 'obs' });
        out.relationships.push({ from: ref, type: 'ASSOCIATED_WITH', to: `${ref}loc`, confidence: 0.7, label: 'registrant country', obsRef: 'obs' });
      }
    }
    for (const ev of res.data.events ?? []) {
      if (['registration', 'expiration', 'last changed'].includes(ev.eventAction)) {
        out.attributes!.push({ entityRef: 'input', key: `rdap_${ev.eventAction.replace(' ', '_')}`, value: ev.eventDate, obsRef: 'obs' });
      }
    }
    (res.data.nameservers ?? []).slice(0, 4).forEach((ns: any, k: number) => {
      out.entities.push({ ref: `ns${k}`, type: 'DOMAIN', value: String(ns.ldhName).toLowerCase(), confidence: 1, obsRef: 'obs' });
      out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: `ns${k}`, confidence: 1, label: 'RDAP nameserver', obsRef: 'obs' });
    });
    return out;
  }
}

/** Tier A — Wikidata structured knowledge base (official MediaWiki API). */
export class WikidataConnector implements Connector {
  readonly def = {
    key: 'wikidata.entity',
    name: 'Wikidata Knowledge Base',
    owner: 'Wikimedia Foundation',
    category: 'Reference data',
    tier: 'A' as const,
    accessMethod: 'OFFICIAL_API',
    baseUrl: 'https://www.wikidata.org/w/api.php',
    legalBasis: 'CC0 public knowledge base, official API, Wikimedia User-Agent policy.',
    authMode: 'NONE' as const,
    rateLimitPerMin: 30,
    allowedFields: ['label', 'description', 'employer', 'member of', 'party', 'citizenship', 'position', 'occupation', 'official website', 'public social handles'],
    inputTypes: ['PERSON', 'ORGANIZATION'] as any,
    outputTypes: ['PERSON', 'ORGANIZATION', 'LOCATION', 'URL', 'SOCIAL_ACCOUNT'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED' as const,
    autoRun: true,
    description: 'Finds candidate identities for a name and their sourced affiliations. Name matches are candidates only.',
  };

  private static readonly SOCIAL: Record<string, { platform: string; url: (h: string) => string }> = {
    P2002: { platform: 'x', url: (h) => `https://x.com/${h}` },
    P2003: { platform: 'instagram', url: (h) => `https://www.instagram.com/${h}` },
    P2013: { platform: 'facebook', url: (h) => `https://www.facebook.com/${h}` },
    P2037: { platform: 'github', url: (h) => `https://github.com/${h}` },
    P6634: { platform: 'linkedin', url: (h) => `https://www.linkedin.com/in/${h}` },
    P7085: { platform: 'tiktok', url: (h) => `https://www.tiktok.com/@${h}` },
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const api = 'https://www.wikidata.org/w/api.php';
    const search = await httpJson<any>(
      `${api}?action=wbsearchentities&format=json&language=id&uselang=en&type=item&limit=7&search=${encodeURIComponent(input.value)}`,
    );
    const ids: string[] = (search.data?.search ?? []).map((s: any) => s.id);
    out.observations.push({ ref: 'search', url: search.url, raw: search.raw, contentType: 'application/json', title: `Wikidata search "${input.value}"` });
    if (!ids.length) return out;
    const full = await httpJson<any>(
      `${api}?action=wbgetentities&format=json&props=labels|descriptions|claims|sitelinks/urls&languages=en|id&ids=${ids.join('|')}`,
    );
    const items = Object.values<any>(full.data?.entities ?? {});
    const claimIds = (it: any, p: string): string[] =>
      (it.claims?.[p] ?? []).map((c: any) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
    const claimStrings = (it: any, p: string): string[] =>
      (it.claims?.[p] ?? []).map((c: any) => c.mainsnak?.datavalue?.value).filter((v: any) => typeof v === 'string');
    const wantPerson = input.type === 'PERSON';
    const selected = items.filter((it) => claimIds(it, 'P31').includes('Q5') === wantPerson).slice(0, 5);
    if (!selected.length) return out;
    // Resolve labels of referenced items (employers, parties, countries…).
    const refProps = ['P108', 'P463', 'P102', 'P27', 'P39', 'P106', 'P159', 'P17', 'P749', 'P127'];
    const refIds = [...new Set(selected.flatMap((it) => refProps.flatMap((p) => claimIds(it, p))))].slice(0, 50);
    const labels: Record<string, string> = {};
    if (refIds.length) {
      const lab = await httpJson<any>(`${api}?action=wbgetentities&format=json&props=labels&languages=en|id&ids=${refIds.join('|')}`);
      for (const [id, e] of Object.entries<any>(lab.data?.entities ?? {})) labels[id] = e.labels?.en?.value ?? e.labels?.id?.value ?? id;
    }
    selected.forEach((it, idx) => {
      const qid = it.id as string;
      const name = it.labels?.en?.value ?? it.labels?.id?.value ?? qid;
      const desc = it.descriptions?.en?.value ?? it.descriptions?.id?.value ?? '';
      const obs = `item${idx}`;
      const url = `https://www.wikidata.org/wiki/${qid}`;
      out.observations.push({ ref: obs, url, raw: JSON.stringify(it), contentType: 'application/json', title: `${name} (${qid})`, text: `${name}. ${desc}` });
      const ref = `cand${idx}`;
      out.entities.push({
        ref,
        type: input.type,
        value: name,
        hints: { discriminator: `wikidata:${qid}` },
        properties: { wikidata_qid: qid, description: desc, source_url: url, occupation: claimIds(it, 'P106').map((q) => labels[q] ?? q) },
        confidence: 0.4,
        obsRef: obs,
      });
      out.relationships.push({ from: 'input', type: 'ASSOCIATED_WITH', to: ref, confidence: 0.3, label: 'name-match candidate (Wikidata)', obsRef: obs });
      const link = (p: string, rel: 'WORKS_FOR' | 'MEMBER_OF' | 'ASSOCIATED_WITH', type: 'ORGANIZATION' | 'LOCATION', label?: string) =>
        claimIds(it, p).slice(0, 5).forEach((q, k) => {
          const r = `${ref}-${p}-${k}`;
          out.entities.push({ ref: r, type, value: labels[q] ?? q, hints: { discriminator: `wikidata:${q}` }, properties: { wikidata_qid: q }, confidence: 0.8, obsRef: obs });
          out.relationships.push({ from: ref, type: rel, to: r, confidence: 0.8, label, obsRef: obs });
        });
      link('P108', 'WORKS_FOR', 'ORGANIZATION');
      link('P463', 'MEMBER_OF', 'ORGANIZATION');
      link('P102', 'MEMBER_OF', 'ORGANIZATION', 'political party');
      link('P27', 'ASSOCIATED_WITH', 'LOCATION', 'citizenship');
      link('P159', 'ASSOCIATED_WITH', 'LOCATION', 'headquarters');
      link('P17', 'ASSOCIATED_WITH', 'LOCATION', 'country');
      link('P749', 'MEMBER_OF', 'ORGANIZATION', 'parent organization');
      const positions = claimIds(it, 'P39').map((q) => labels[q] ?? q);
      if (positions.length) out.attributes!.push({ entityRef: ref, key: 'positions', value: positions.slice(0, 5).join('; '), obsRef: obs });
      claimStrings(it, 'P856').slice(0, 2).forEach((w, k) => {
        out.entities.push({ ref: `${ref}-web${k}`, type: 'URL', value: w, confidence: 0.9, obsRef: obs });
        out.relationships.push({ from: ref, type: 'ASSOCIATED_WITH', to: `${ref}-web${k}`, confidence: 0.9, label: 'official website', obsRef: obs });
      });
      for (const [p, s] of Object.entries(WikidataConnector.SOCIAL)) {
        claimStrings(it, p).slice(0, 2).forEach((h, k) => {
          const r = `${ref}-${p}-${k}`;
          out.entities.push({ ref: r, type: 'SOCIAL_ACCOUNT', value: `${s.platform}:${h.toLowerCase()}`, properties: { platform: s.platform, handle: h, profile_url: s.url(h) }, confidence: 0.85, obsRef: obs });
          out.relationships.push({ from: ref, type: 'HAS_ACCOUNT', to: r, confidence: 0.85, obsRef: obs });
        });
      }
      const birth = (it.claims?.P569?.[0]?.mainsnak?.datavalue?.value?.time as string | undefined)?.slice(1, 5);
      if (birth && wantPerson) out.attributes!.push({ entityRef: ref, key: 'birth_year', value: birth, obsRef: obs });
    });
    return out;
  }
}

/** Tier A — Wikipedia (official MediaWiki API), Indonesian + English editions. */
export class WikipediaConnector implements Connector {
  readonly def = {
    key: 'wikipedia.search',
    name: 'Wikipedia (id/en)',
    owner: 'Wikimedia Foundation',
    category: 'Reference data',
    tier: 'A' as const,
    accessMethod: 'OFFICIAL_API',
    baseUrl: 'https://{lang}.wikipedia.org/w/api.php',
    legalBasis: 'CC BY-SA content via official API; attribution retained in evidence.',
    authMode: 'NONE' as const,
    rateLimitPerMin: 30,
    allowedFields: ['title', 'plain-text extract', 'url'],
    inputTypes: ['PERSON', 'ORGANIZATION', 'EVENT', 'NARRATIVE'] as any,
    outputTypes: ['ARTICLE'] as any,
    retentionDays: 365,
    defaultPolicy: 'APPROVED' as const,
    autoRun: true,
    description: 'Retrieves encyclopedia articles mentioning the exact phrase; text is passed to entity extraction.',
  };

  async run(input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    for (const lang of ['id', 'en']) {
      const api = `https://${lang}.wikipedia.org/w/api.php`;
      const s = await httpJson<any>(`${api}?action=query&list=search&format=json&srlimit=3&srsearch=${encodeURIComponent(`"${input.value}"`)}`);
      const ids: number[] = (s.data?.query?.search ?? []).map((x: any) => x.pageid);
      if (!ids.length) continue;
      const pages = await httpJson<any>(
        `${api}?action=query&format=json&prop=extracts|info|revisions&rvprop=timestamp&explaintext=1&exlimit=max&inprop=url&pageids=${ids.join('|')}`,
      );
      for (const p of Object.values<any>(pages.data?.query?.pages ?? {})) {
        const text = String(p.extract ?? '').slice(0, 20000);
        if (!text) continue;
        const ref = `${lang}${p.pageid}`;
        out.observations.push({
          ref,
          url: p.fullurl,
          title: `${p.title} — Wikipedia (${lang})`,
          text,
          author: `${lang}.wikipedia.org`,
          publishedAt: p.revisions?.[0]?.timestamp ?? null,
          raw: JSON.stringify(p),
          contentType: 'application/json',
          extract: true,
          entityRef: `art-${ref}`,
        });
        out.entities.push({ ref: `art-${ref}`, type: 'ARTICLE', value: p.fullurl, properties: { title: p.title, publisher: `${lang}.wikipedia.org`, url: p.fullurl }, confidence: 1, obsRef: ref });
        const exact = text.toLowerCase().includes(input.value.toLowerCase());
        if (exact) {
          out.relationships.push({ from: 'input', type: 'MENTIONED_IN', to: `art-${ref}`, confidence: 0.5, label: 'exact-phrase mention', obsRef: ref });
        }
      }
    }
    return out;
  }
}

/** Tier E — registry entries for internal, analyst-driven inputs (not runnable as transforms). */
export class InternalSourceConnector implements Connector {
  constructor(readonly def: any) {}
  async run(): Promise<ConnectorOutput> {
    throw new Error(`${this.def.key} is not an executable transform`);
  }
}

export const internalSources = () => [
  new InternalSourceConnector({
    key: 'local.analyst-intake',
    name: 'Analyst Intake',
    owner: 'Case analyst',
    category: 'Internal authorized',
    tier: 'E',
    accessMethod: 'ANALYST_INTAKE',
    legalBasis: 'Identifiers lawfully held by the requesting organisation and supplied under the documented case purpose.',
    authMode: 'INTERNAL',
    rateLimitPerMin: 600,
    allowedFields: ['seed identifiers'],
    inputTypes: [],
    outputTypes: [],
    retentionDays: 3650,
    defaultPolicy: 'APPROVED',
    autoRun: false,
    description: 'Evidence record of seeds and secondary identifiers entered by an analyst.',
  }),
  new InternalSourceConnector({
    key: 'local.document-upload',
    name: 'Internal Document Upload',
    owner: 'Case analyst',
    category: 'Internal authorized',
    tier: 'E',
    accessMethod: 'INTERNAL_DOCUMENT',
    legalBasis: 'Documents the organisation is authorised to process; RBAC and case ACL apply.',
    authMode: 'INTERNAL',
    rateLimitPerMin: 600,
    allowedFields: ['document text'],
    inputTypes: [],
    outputTypes: ['DOCUMENT'],
    retentionDays: 3650,
    defaultPolicy: 'APPROVED',
    autoRun: false,
    description: 'Text, Markdown, CSV, JSON or HTML documents uploaded into a case and passed to entity extraction.',
  }),
];
