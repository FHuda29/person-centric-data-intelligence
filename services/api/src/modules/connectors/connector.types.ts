import { EntityType, RelationshipType } from '../../common/types';

/** Input handed to a transform: one entity of the case graph. */
export interface TransformInput {
  entityId: string;
  caseId: string;
  type: EntityType;
  value: string; // canonical label/value
  properties: Record<string, any>;
  /** Other labels of the case useful for query expansion (organisations, verified identifiers). */
  context: { organizations: string[]; cities: string[]; verifiedPhones: string[]; verifiedEmails: string[] };
}

export interface ObservationDraft {
  ref: string;
  url?: string | null;
  title?: string | null;
  /** Human-readable text (used for extraction, narrative and full-text search). */
  text?: string | null;
  author?: string | null;
  publishedAt?: string | Date | null;
  /** Raw payload persisted as evidence object. */
  raw: string | Buffer;
  contentType: string;
  /** Run entity extraction (NER + identifiers) over `text`. */
  extract?: boolean;
  /** Content entity (ARTICLE/DOCUMENT/URL ref) representing this observation in the graph. */
  entityRef?: string;
}

export interface EntityDraft {
  ref: string;
  type: EntityType;
  value: string;
  /** Normalisation hints, e.g. { discriminator: 'wikidata:Q42' } for person candidates. */
  hints?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  confidence?: number;
  obsRef?: string;
}

export interface RelationshipDraft {
  from: string; // entity ref or 'input'
  type: RelationshipType;
  to: string;
  confidence: number;
  label?: string;
  obsRef?: string;
}

export interface AttributeDraft {
  entityRef: string; // entity ref or 'input'
  key: string;
  value: string;
  obsRef?: string;
}

export interface ConnectorOutput {
  observations: ObservationDraft[];
  entities: EntityDraft[];
  relationships: RelationshipDraft[];
  attributes?: AttributeDraft[];
  notes?: string[];
}

export interface SourceDefinition {
  key: string;
  name: string;
  owner: string;
  category: string;
  tier: 'A' | 'B' | 'C' | 'D' | 'E';
  accessMethod: string;
  baseUrl?: string;
  legalBasis: string;
  authMode: 'NONE' | 'API_KEY' | 'TOKEN' | 'INTERNAL';
  rateLimitPerMin: number;
  allowedFields: string[];
  inputTypes: EntityType[];
  outputTypes: EntityType[];
  retentionDays: number;
  defaultPolicy: 'APPROVED' | 'PENDING' | 'DISABLED';
  /** When false, the transform only runs when explicitly invoked by an analyst. */
  autoRun: boolean;
  description: string;
  requiresCredential?: () => boolean;
}

export interface Connector {
  readonly def: SourceDefinition;
  run(input: TransformInput): Promise<ConnectorOutput>;
}

export const emptyOutput = (): ConnectorOutput => ({ observations: [], entities: [], relationships: [], attributes: [] });
