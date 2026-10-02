export const ENTITY_TYPES = [
  'PERSON',
  'PHONE',
  'EMAIL',
  'USERNAME',
  'SOCIAL_ACCOUNT',
  'ORGANIZATION',
  'DOMAIN',
  'URL',
  'IP_ADDRESS',
  'DOCUMENT',
  'ARTICLE',
  'LOCATION',
  'EVENT',
  'NARRATIVE',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const RELATIONSHIP_TYPES = [
  'HAS_PHONE',
  'HAS_EMAIL',
  'USES_ALIAS',
  'HAS_ACCOUNT',
  'WORKS_FOR',
  'MEMBER_OF',
  'MENTIONED_IN',
  'PUBLISHED',
  'SHARED',
  'PARTICIPATED_IN',
  'ASSOCIATED_WITH',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const FINDING_STATUSES = ['CONFIRMED', 'CORROBORATED', 'UNVERIFIED', 'CONTRADICTED', 'REJECTED'] as const;
export const CLAIM_TYPES = ['OBSERVED_FACT', 'SOURCE_CLAIM', 'ANALYTICAL_INFERENCE', 'UNVERIFIED_INFO'] as const;

export type Role = 'ADMIN' | 'ANALYST' | 'VIEWER';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  canRevealPii: boolean;
}

/** Identifier types that are personal data and must be masked in list views (paper §13). */
export const PII_TYPES = new Set<string>(['PHONE', 'EMAIL']);
