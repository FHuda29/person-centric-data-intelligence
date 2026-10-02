-- Person-Centric Data Intelligence — baseline schema (paper §11)
-- Logical schemas: iam, cases, sources, collection, intelligence, evidence, audit

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS iam;
CREATE SCHEMA IF NOT EXISTS cases;
CREATE SCHEMA IF NOT EXISTS sources;
CREATE SCHEMA IF NOT EXISTS collection;
CREATE SCHEMA IF NOT EXISTS intelligence;
CREATE SCHEMA IF NOT EXISTS evidence;
CREATE SCHEMA IF NOT EXISTS audit;

-- ---------------------------------------------------------------- iam
CREATE TABLE iam.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('ADMIN','ANALYST','VIEWER')),
  can_reveal_pii boolean NOT NULL DEFAULT false,
  mfa_secret    text,
  mfa_enabled   boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- cases
CREATE TABLE cases.cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  title           text NOT NULL,
  purpose         text NOT NULL CHECK (length(trim(purpose)) >= 10),
  scope           text,
  legal_basis     text,
  owner_id        uuid NOT NULL REFERENCES iam.users(id),
  classification  text NOT NULL DEFAULT 'CONFIDENTIAL'
                  CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ON_HOLD','CLOSED','PURGED')),
  retention_until date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cases.case_members (
  case_id uuid NOT NULL REFERENCES cases.cases(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES iam.users(id),
  access  text NOT NULL DEFAULT 'EDIT' CHECK (access IN ('READ','EDIT')),
  PRIMARY KEY (case_id, user_id)
);

CREATE TABLE cases.seed_entities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          uuid NOT NULL REFERENCES cases.cases(id) ON DELETE CASCADE,
  type             text NOT NULL,
  raw_value        text NOT NULL,
  normalized_value text NOT NULL,
  entity_id        uuid,
  created_by       uuid REFERENCES iam.users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- sources
CREATE TABLE sources.sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_key  text NOT NULL UNIQUE,
  name           text NOT NULL,
  owner          text NOT NULL,
  category       text NOT NULL,
  tier           text NOT NULL CHECK (tier IN ('A','B','C','D','E')),
  access_method  text NOT NULL,
  base_url       text,
  legal_basis    text NOT NULL,
  auth_mode      text NOT NULL DEFAULT 'NONE',
  rate_limit_per_min integer NOT NULL DEFAULT 30,
  allowed_fields text[] NOT NULL DEFAULT '{}',
  input_types    text[] NOT NULL DEFAULT '{}',
  output_types   text[] NOT NULL DEFAULT '{}',
  retention_days integer NOT NULL DEFAULT 365,
  policy_state   text NOT NULL DEFAULT 'PENDING' CHECK (policy_state IN ('APPROVED','PENDING','DISABLED')),
  connector_status text NOT NULL DEFAULT 'READY',
  description    text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- collection
CREATE TABLE collection.collection_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES cases.cases(id) ON DELETE CASCADE,
  source_id       uuid NOT NULL REFERENCES sources.sources(id),
  input_entity_id uuid,
  input_type      text NOT NULL,
  input_value     text NOT NULL,
  status          text NOT NULL DEFAULT 'QUEUED'
                  CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','DEAD','SKIPPED')),
  attempts        integer NOT NULL DEFAULT 0,
  result_summary  jsonb,
  error           text,
  requested_by    uuid REFERENCES iam.users(id),
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  ended_at        timestamptz
);
CREATE INDEX ON collection.collection_jobs (case_id, created_at DESC);

CREATE TABLE collection.observations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES cases.cases(id) ON DELETE CASCADE,
  source_id     uuid NOT NULL REFERENCES sources.sources(id),
  job_id        uuid REFERENCES collection.collection_jobs(id) ON DELETE SET NULL,
  url           text,
  title         text,
  content_text  text,
  content_hash  text NOT NULL,
  author        text,
  published_at  timestamptz,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  raw_ref       text,
  evidence_id   uuid,
  UNIQUE (case_id, content_hash)
);
CREATE INDEX ON collection.observations (case_id, published_at);

-- ---------------------------------------------------------------- evidence
CREATE TABLE evidence.evidence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           uuid NOT NULL REFERENCES cases.cases(id) ON DELETE CASCADE,
  source_id         uuid REFERENCES sources.sources(id),
  url               text,
  title             text,
  published_at      timestamptz,
  retrieved_at      timestamptz NOT NULL DEFAULT now(),
  access_method     text NOT NULL,
  hash              text NOT NULL,
  excerpt           text,
  object_ref        text,
  content_type      text,
  collector_version text NOT NULL,
  created_by        uuid REFERENCES iam.users(id)
);
CREATE INDEX ON evidence.evidence (case_id);

-- ---------------------------------------------------------------- intelligence
CREATE TABLE intelligence.entities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           uuid NOT NULL REFERENCES cases.cases(id) ON DELETE CASCADE,
  canonical_type    text NOT NULL,
  canonical_key     text NOT NULL,
  label             text NOT NULL,
  properties        jsonb NOT NULL DEFAULT '{}',
  confidence        numeric(4,3) NOT NULL DEFAULT 0.5,
  resolution_status text NOT NULL DEFAULT 'CANDIDATE'
                    CHECK (resolution_status IN ('CANDIDATE','RESOLVED','REJECTED','MERGED')),
  merged_into       uuid REFERENCES intelligence.entities(id),
  is_seed           boolean NOT NULL DEFAULT false,
  first_seen        timestamptz NOT NULL DEFAULT now(),
  last_seen         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, canonical_type, canonical_key)
);
CREATE INDEX ON intelligence.entities (case_id, canonical_type);

CREATE TABLE intelligence.entity_attributes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL REFERENCES intelligence.entities(id) ON DELETE CASCADE,
  key         text NOT NULL,
  value       text NOT NULL,
  source_id   uuid REFERENCES sources.sources(id),
  evidence_id uuid REFERENCES evidence.evidence(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, key, value)
);

CREATE TABLE intelligence.relationships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases.cases(id) ON DELETE CASCADE,
  from_id     uuid NOT NULL REFERENCES intelligence.entities(id) ON DELETE CASCADE,
  type        text NOT NULL,
  to_id       uuid NOT NULL REFERENCES intelligence.entities(id) ON DELETE CASCADE,
  confidence  numeric(4,3) NOT NULL DEFAULT 0.5,
  status      text NOT NULL DEFAULT 'CANDIDATE' CHECK (status IN ('CANDIDATE','CONFIRMED','REJECTED')),
  label       text,
  evidence_id uuid REFERENCES evidence.evidence(id) ON DELETE SET NULL,
  source_id   uuid REFERENCES sources.sources(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, type, to_id)
);
CREATE INDEX ON intelligence.relationships (case_id);

CREATE TABLE intelligence.resolution_candidates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases.cases(id) ON DELETE CASCADE,
  entity_a    uuid NOT NULL REFERENCES intelligence.entities(id) ON DELETE CASCADE,
  entity_b    uuid NOT NULL REFERENCES intelligence.entities(id) ON DELETE CASCADE,
  score       numeric(4,3) NOT NULL,
  signals     jsonb NOT NULL,
  deterministic boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'CANDIDATE'
              CHECK (status IN ('UNRESOLVED','CANDIDATE','REVIEW_READY','MERGED','REJECTED')),
  reviewed_by uuid REFERENCES iam.users(id),
  reviewed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_a, entity_b)
);

CREATE TABLE intelligence.narratives (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases.cases(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('TOPIC','CLAIM')),
  topic       text NOT NULL,
  keywords    text[] NOT NULL DEFAULT '{}',
  representative text,
  observation_ids uuid[] NOT NULL DEFAULT '{}',
  source_count integer NOT NULL DEFAULT 0,
  first_seen  timestamptz,
  last_seen   timestamptz,
  propagation jsonb NOT NULL DEFAULT '[]',
  entity_id   uuid REFERENCES intelligence.entities(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE intelligence.findings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES cases.cases(id) ON DELETE CASCADE,
  title        text NOT NULL,
  statement    text NOT NULL,
  claim_type   text NOT NULL DEFAULT 'OBSERVED_FACT'
               CHECK (claim_type IN ('OBSERVED_FACT','SOURCE_CLAIM','ANALYTICAL_INFERENCE','UNVERIFIED_INFO')),
  status       text NOT NULL DEFAULT 'UNVERIFIED'
               CHECK (status IN ('CONFIRMED','CORROBORATED','UNVERIFIED','CONTRADICTED','REJECTED')),
  confidence   numeric(4,3) NOT NULL DEFAULT 0.5,
  analyst_note text,
  entity_ids   uuid[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES iam.users(id),
  reviewed_by  uuid REFERENCES iam.users(id),
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE intelligence.finding_evidence (
  finding_id  uuid NOT NULL REFERENCES intelligence.findings(id) ON DELETE CASCADE,
  evidence_id uuid NOT NULL REFERENCES evidence.evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (finding_id, evidence_id)
);

CREATE TABLE intelligence.reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES cases.cases(id) ON DELETE CASCADE,
  title        text NOT NULL,
  object_ref   text NOT NULL,
  hash         text NOT NULL,
  classification text NOT NULL,
  created_by   uuid REFERENCES iam.users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- audit (append-only)
CREATE TABLE audit.audit_events (
  id          bigserial PRIMARY KEY,
  actor_id    uuid,
  actor_name  text,
  action      text NOT NULL,
  object_type text NOT NULL,
  object_id   text,
  case_id     uuid,
  request_id  text,
  detail      jsonb NOT NULL DEFAULT '{}',
  timestamp   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit.audit_events (case_id, timestamp DESC);

CREATE OR REPLACE FUNCTION audit.block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit.audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit.audit_events
  FOR EACH ROW EXECUTE FUNCTION audit.block_mutation();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.block_mutation();
