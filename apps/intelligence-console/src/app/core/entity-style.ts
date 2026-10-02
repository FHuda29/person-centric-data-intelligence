/** Visual language for entity types (graph nodes, chips, legends). */
export const ENTITY_TYPES = [
  'PERSON', 'PHONE', 'EMAIL', 'USERNAME', 'SOCIAL_ACCOUNT', 'ORGANIZATION', 'DOMAIN', 'URL',
  'IP_ADDRESS', 'DOCUMENT', 'ARTICLE', 'LOCATION', 'EVENT', 'NARRATIVE',
] as const;

export const RELATIONSHIP_TYPES = [
  'HAS_PHONE', 'HAS_EMAIL', 'USES_ALIAS', 'HAS_ACCOUNT', 'WORKS_FOR', 'MEMBER_OF', 'MENTIONED_IN',
  'PUBLISHED', 'SHARED', 'PARTICIPATED_IN', 'ASSOCIATED_WITH',
];

export const TYPE_COLOR: Record<string, string> = {
  PERSON: '#3b82f6',
  PHONE: '#22c55e',
  EMAIL: '#f59e0b',
  USERNAME: '#a78bfa',
  SOCIAL_ACCOUNT: '#ec4899',
  ORGANIZATION: '#06b6d4',
  DOMAIN: '#64748b',
  URL: '#7c8ba1',
  IP_ADDRESS: '#8b7d6b',
  DOCUMENT: '#eab308',
  ARTICLE: '#f97316',
  LOCATION: '#10b981',
  EVENT: '#ef4444',
  NARRATIVE: '#d946ef',
};

export const TYPE_LABEL: Record<string, string> = {
  PERSON: 'Person', PHONE: 'Phone / WhatsApp', EMAIL: 'Email', USERNAME: 'Alias / Username', SOCIAL_ACCOUNT: 'Social account',
  ORGANIZATION: 'Organization', DOMAIN: 'Domain', URL: 'Website / URL', IP_ADDRESS: 'IP address', DOCUMENT: 'Document',
  ARTICLE: 'Article / Post', LOCATION: 'Location', EVENT: 'Event', NARRATIVE: 'Narrative',
};

// 24×24 stroke icons (white on the type colour).
const ICON_PATHS: Record<string, string> = {
  PERSON: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  PHONE: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/>',
  EMAIL: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  USERNAME: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>',
  SOCIAL_ACCOUNT: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6"/>',
  ORGANIZATION: '<path d="M4 21V6l8-3 8 3v15"/><path d="M9 9h.01M15 9h.01M9 13h.01M15 13h.01M10 21v-4h4v4"/>',
  DOMAIN: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.3 3 14.7 0 18M12 3c-3 3.3-3 14.7 0 18"/>',
  URL: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  IP_ADDRESS: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  DOCUMENT: '<path d="M6 2.5h8l4 4v15H6z"/><path d="M14 2.5v4h4M9 12h6M9 16h6"/>',
  ARTICLE: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>',
  LOCATION: '<path d="M12 21.5s7-6.6 7-12a7 7 0 0 0-14 0c0 5.4 7 12 7 12z"/><circle cx="12" cy="9.5" r="2.5"/>',
  EVENT: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  NARRATIVE: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
};

export function iconSvg(type: string, size = 24): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[type] ?? ICON_PATHS['URL']}</svg>`;
}

export const iconDataUri = (type: string) => `data:image/svg+xml;utf8,${encodeURIComponent(iconSvg(type))}`;
export const colorOf = (type: string) => TYPE_COLOR[type] ?? '#7c8ba1';
