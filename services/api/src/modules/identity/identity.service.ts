import { BadRequestException, Body, Controller, Injectable, Post } from '@nestjs/common';
import { parsePhoneNumberFromString, CountryCode } from 'libphonenumber-js/max';
import { config } from '../../config';
import { EntityType, ENTITY_TYPES } from '../../common/types';
import { nameKey, normalizeName } from '../../common/text';

export interface Normalized {
  type: EntityType;
  raw: string;
  canonicalKey: string;
  label: string;
  properties: Record<string, unknown>;
}

const FREE_MAIL = new Set([
  'gmail.com', 'yahoo.com', 'yahoo.co.id', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com',
  'proton.me', 'protonmail.com', 'aol.com', 'mail.com', 'gmx.com', 'ymail.com', 'zoho.com',
]);
const GENERIC_MAILBOX = new Set([
  'info', 'admin', 'contact', 'kontak', 'support', 'sales', 'office', 'hello', 'halo', 'cs', 'hr',
  'marketing', 'humas', 'redaksi', 'noreply', 'no-reply', 'webmaster', 'team', 'mail', 'secretariat', 'sekretariat',
]);

/** Identity normalisation (paper §3 step 2): canonical identifiers for every seed/entity type. */
@Injectable()
export class IdentityService {
  classify(value: string): EntityType {
    const v = value.trim();
    if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return 'EMAIL';
    if (/^https?:\/\//i.test(v)) return 'URL';
    if (/^@?[a-z0-9_.]{2,30}$/i.test(v) && v.startsWith('@')) return 'USERNAME';
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return 'IP_ADDRESS';
    if (/^\+?[\d\s().-]{7,20}$/.test(v) && v.replace(/\D/g, '').length >= 8) return 'PHONE';
    if (/^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.[a-z]{2,}$/i.test(v) && !v.includes(' ')) return 'DOMAIN';
    if (/^[a-z0-9_.]{3,30}$/i.test(v) && /[\d_.]/.test(v)) return 'USERNAME';
    return 'PERSON';
  }

  normalize(type: string, raw: string, hints: Record<string, unknown> = {}): Normalized {
    const t = type.toUpperCase() as EntityType;
    if (!ENTITY_TYPES.includes(t)) throw new BadRequestException(`Unsupported entity type ${type}`);
    const v = (raw ?? '').trim();
    if (!v) throw new BadRequestException('Value is required');
    switch (t) {
      case 'PHONE': {
        const p = parsePhoneNumberFromString(v, (hints.region as CountryCode) ?? (config.defaultPhoneRegion as CountryCode));
        if (!p || !p.isPossible()) throw new BadRequestException(`"${v}" is not a valid phone number`);
        const e164 = p.number;
        return {
          type: t,
          raw: v,
          canonicalKey: e164,
          label: e164,
          properties: {
            e164,
            country_code: p.country ?? null,
            calling_code: `+${p.countryCallingCode}`,
            national: p.formatNational(),
            international: p.formatInternational(),
            line_type: p.getType() ?? 'UNKNOWN',
            valid: p.isValid(),
            // WhatsApp is modelled only as an identifier namespace — no message/contact access (paper §3.2).
            whatsapp_namespace: `wa:${e164.replace('+', '')}`,
          },
        };
      }
      case 'EMAIL': {
        const email = v.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) throw new BadRequestException(`"${v}" is not a valid email`);
        const [local, domain] = email.split('@');
        const baseLocal = local.split('+')[0];
        return {
          type: t,
          raw: v,
          canonicalKey: email,
          label: email,
          properties: {
            address: email,
            local_part: baseLocal,
            domain,
            free_provider: FREE_MAIL.has(domain),
            generic_mailbox: GENERIC_MAILBOX.has(baseLocal),
            verification_state: 'UNVERIFIED',
          },
        };
      }
      case 'USERNAME': {
        const u = v.replace(/^@/, '').toLowerCase();
        return { type: t, raw: v, canonicalKey: u, label: `@${u}`, properties: { handle: u } };
      }
      case 'DOMAIN': {
        const d = v.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
        return { type: t, raw: v, canonicalKey: d, label: d, properties: { domain: d, tld: d.split('.').pop() } };
      }
      case 'URL': {
        let u: URL;
        try {
          u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
        } catch {
          throw new BadRequestException(`"${v}" is not a valid URL`);
        }
        u.hash = '';
        for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(p)) u.searchParams.delete(p);
        const canon = u.toString().replace(/\/$/, '');
        return {
          type: t,
          raw: v,
          canonicalKey: canon,
          label: canon,
          properties: { url: canon, domain: u.hostname.replace(/^www\./, '') },
        };
      }
      case 'PERSON': {
        const normalized = normalizeName(v);
        if (normalized.length < 3) throw new BadRequestException('Name too short');
        const discriminator = (hints.discriminator as string) ?? 'seed';
        return {
          type: t,
          raw: v,
          // Name alone is never an identity key: each source/candidate keeps its own discriminator.
          canonicalKey: `${nameKey(v)}|${discriminator}`,
          label: v.replace(/\s+/g, ' ').trim(),
          properties: { full_name: v.trim(), normalized_name: normalized, aliases: [] },
        };
      }
      case 'ARTICLE': {
        const n = this.normalize('URL', v);
        const title = typeof hints.title === 'string' && hints.title.trim() ? hints.title.trim().slice(0, 140) : n.label;
        return { ...n, type: t, label: title };
      }
      case 'DOCUMENT': {
        const key = typeof hints.hash === 'string' ? hints.hash : v.toLowerCase();
        return { type: t, raw: v, canonicalKey: key, label: v, properties: { title: v } };
      }
      case 'ORGANIZATION':
      case 'LOCATION':
      case 'EVENT':
      case 'NARRATIVE': {
        const discriminator = hints.discriminator as string | undefined;
        const key = normalizeName(v) + (discriminator ? `|${discriminator}` : '');
        return { type: t, raw: v, canonicalKey: key, label: v.trim(), properties: { name: v.trim() } };
      }
      default:
        return { type: t, raw: v, canonicalKey: v.toLowerCase(), label: v, properties: {} };
    }
  }

  /** Search expansion (paper §3.1): derived queries — never treated as the same target automatically. */
  expand(
    type: string,
    label: string,
    ctx: { organizations?: string[]; cities?: string[]; verifiedPhones?: string[]; verifiedEmails?: string[] } = {},
  ): string[] {
    const q = `"${label.replace(/"/g, '')}"`;
    const out = [q];
    if (type === 'PERSON' || type === 'ORGANIZATION') {
      for (const o of (ctx.organizations ?? []).slice(0, 3)) out.push(`${q} "${o}"`);
      for (const c of (ctx.cities ?? []).slice(0, 2)) out.push(`${q} ${c}`);
      out.push(`${q} filetype:pdf`);
      out.push(`${q} site:linkedin.com`);
      for (const p of (ctx.verifiedPhones ?? []).slice(0, 2)) out.push(`${q} "${p}"`);
      for (const e of (ctx.verifiedEmails ?? []).slice(0, 2)) out.push(`${q} "${e}"`);
    } else if (type === 'PHONE') {
      const digits = label.replace(/\D/g, '');
      out.push(`"${digits}"`);
      if (digits.startsWith('62')) out.push(`"0${digits.slice(2)}"`);
    } else if (type === 'EMAIL' || type === 'USERNAME') {
      out.push(`${q} -site:${type === 'EMAIL' ? label.split('@')[1] : 'example.invalid'}`);
    }
    return [...new Set(out)];
  }
}

@Controller('identity')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  /** Universal search input classification: detects the identifier type and returns its canonical form. */
  @Post('classify')
  classify(@Body() body: { value: string; type?: string }) {
    const type = body.type ?? this.identity.classify(body.value ?? '');
    const n = this.identity.normalize(type, body.value);
    return { ...n, queries: this.identity.expand(n.type, n.label) };
  }
}
