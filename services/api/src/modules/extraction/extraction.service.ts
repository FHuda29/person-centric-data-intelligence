import { Injectable } from '@nestjs/common';
import nlp from 'compromise';
import { findPhoneNumbersInText, CountryCode } from 'libphonenumber-js/max';
import { config } from '../../config';
import { EntityType } from '../../common/types';

export interface Mention {
  type: EntityType;
  value: string;
  confidence: number;
  method: 'regex' | 'ner' | 'known-entity' | 'phone-parser';
  /** Set when the mention matched an entity already in the case. */
  entityId?: string;
}

export interface ExtractionResult {
  mentions: Mention[];
  hashtags: string[];
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;
const HANDLE_RE = /(?:^|[\s(])@([A-Za-z0-9_]{3,30})\b/g;
const HASHTAG_RE = /#([\p{L}\p{N}_]{3,40})/gu;

/** Entity extraction (paper §3 step 5): identifiers by regex/parsers, names by NER, plus known-entity matching. */
@Injectable()
export class ExtractionService {
  extract(text: string, known: { id: string; type: string; label: string }[] = []): ExtractionResult {
    const t = (text ?? '').slice(0, 30000);
    const mentions: Mention[] = [];
    const seen = new Set<string>();
    const push = (m: Mention) => {
      const k = `${m.type}|${m.value.toLowerCase()}`;
      if (seen.has(k)) return;
      seen.add(k);
      mentions.push(m);
    };

    for (const m of t.matchAll(EMAIL_RE)) push({ type: 'EMAIL', value: m[0].toLowerCase(), confidence: 0.9, method: 'regex' });
    try {
      for (const f of findPhoneNumbersInText(t, config.defaultPhoneRegion as CountryCode)) {
        if (f.number.isValid()) push({ type: 'PHONE', value: f.number.number, confidence: 0.8, method: 'phone-parser' });
      }
    } catch {
      /* phone parser is best-effort */
    }
    let urls = 0;
    for (const m of t.matchAll(URL_RE)) {
      if (urls++ >= 15) break;
      push({ type: 'URL', value: m[0].replace(/[.,;:!?]+$/, ''), confidence: 0.9, method: 'regex' });
    }
    // HANDLE_RE requires whitespace/"(" before "@", so email addresses never match here.
    for (const m of t.matchAll(HANDLE_RE)) push({ type: 'USERNAME', value: m[1].toLowerCase(), confidence: 0.6, method: 'regex' });
    const hashtags = [...new Set([...t.matchAll(HASHTAG_RE)].map((m) => m[1].toLowerCase()))];

    // Known-entity matching: labels already in the case (persons, organisations, locations…).
    const lower = t.toLowerCase();
    for (const k of known) {
      if (k.label.length < 5 || !['PERSON', 'ORGANIZATION', 'LOCATION', 'EVENT'].includes(k.type)) continue;
      const idx = lower.indexOf(k.label.toLowerCase());
      if (idx < 0) continue;
      const before = idx === 0 ? ' ' : lower[idx - 1];
      const after = lower[idx + k.label.length] ?? ' ';
      if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) continue;
      push({ type: k.type as EntityType, value: k.label, confidence: 0.7, method: 'known-entity', entityId: k.id });
    }

    // Statistical NER (English-centric; Indonesian names are partly caught via capitalisation).
    const doc = nlp(t.slice(0, 15000));
    const clean = (s: string) => s.replace(/[’'`]s$/i, '').replace(/[^\p{L}\p{N}\s.&-]/gu, '').replace(/\s+/g, ' ').trim();
    for (const p of doc.people().out('array') as string[]) {
      const v = clean(p);
      if (v.split(' ').length >= 2 && v.length <= 60 && /^\p{Lu}/u.test(v)) push({ type: 'PERSON', value: v, confidence: 0.4, method: 'ner' });
    }
    for (const o of doc.organizations().out('array') as string[]) {
      const v = clean(o);
      if (v.length >= 3 && v.length <= 80 && /^\p{Lu}/u.test(v)) push({ type: 'ORGANIZATION', value: v, confidence: 0.4, method: 'ner' });
    }
    for (const pl of doc.places().out('array') as string[]) {
      const v = clean(pl);
      if (v.length >= 3 && v.length <= 60 && /^\p{Lu}/u.test(v)) push({ type: 'LOCATION', value: v, confidence: 0.35, method: 'ner' });
    }
    return { mentions: mentions.slice(0, 80), hashtags };
  }
}
