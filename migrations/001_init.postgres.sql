-- migrations/001_init.postgres.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- ConsentGrid — PRODUCTION Postgres schema (Postgres 14+).
--
-- This is the source-of-truth schema for production. The SQLite variant
-- (001_init.sqlite.sql) mirrors it for local dev/CI where the built-in
-- node:sqlite driver is used. Keep the two in sync.
--
-- Design notes flagged inline with [MUST-V1] / [DESIGN-FOR] / [TIER-2].
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Tenancy ──────────────────────────────────────────────────────────────
CREATE TABLE orgs (
  org_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,               -- scrypt; see src/lib/password.js
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys: only a hash is stored; the plaintext key is shown once at creation.
CREATE TABLE api_keys (
  key_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  key_prefix  TEXT NOT NULL,                 -- first 8 chars, for display
  key_hash    TEXT NOT NULL,                 -- sha256 of full key
  scope       TEXT NOT NULL DEFAULT 'server',-- server | publishable
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_keys_org ON api_keys(org_id);
CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys(key_hash);

-- [MUST-V1] RBAC + audited access grants. No engineer has blanket read on raw
-- consent data; a time-boxed grant is required and every use is logged.
CREATE TABLE staff_users (
  staff_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'viewer', -- owner | admin | viewer | support
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE access_grants (
  grant_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    UUID NOT NULL REFERENCES staff_users(staff_id),
  org_id      UUID NOT NULL REFERENCES orgs(org_id),
  reason      TEXT NOT NULL,
  granted_by  UUID NOT NULL REFERENCES staff_users(staff_id),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE access_log (
  id         BIGSERIAL PRIMARY KEY,
  grant_id   UUID REFERENCES access_grants(grant_id),
  staff_id   UUID,
  action     TEXT NOT NULL,
  target     TEXT,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Users (Data Principals) — NO RAW PII ─────────────────────────────────
-- We store only the per-user salt (Fiduciary-held) + metadata. The opaque
-- user_token itself is never persisted; we key-hash it into artifacts.
-- [DESIGN-FOR: Consent Manager] principal_link_id lets a principal later
-- unify their opaque tokens across orgs without the platform holding raw PII.
CREATE TABLE users (
  org_id            UUID NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  user_ref          TEXT NOT NULL,           -- opaque handle chosen by client (NOT raw PII)
  salt              TEXT,                     -- per-user salt (hex). NULL => crypto-shredded.
  principal_link_id UUID,                     -- [DESIGN-FOR] cross-fiduciary linkage
  is_minor          BOOLEAN NOT NULL DEFAULT false,
  shredded_at       TIMESTAMPTZ,              -- set when salt destroyed (erasure)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_ref)
);
CREATE INDEX idx_users_principal_link ON users(principal_link_id);

-- ── Notice templates (versioned + immutable once referenced) ─────────────
-- [MUST-V1] version pinning. [DESIGN-FOR] template_hash / variable_payload_hash split.
CREATE TABLE notice_templates (
  template_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  purposes     JSONB NOT NULL,               -- [{id,label_key,required:false}]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notice_versions (
  version_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id           UUID NOT NULL REFERENCES notice_templates(template_id) ON DELETE CASCADE,
  org_id                UUID NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  version_num           INT NOT NULL,
  template_hash         TEXT NOT NULL,        -- hash of immutable legal boilerplate
  variable_payload      JSONB NOT NULL,       -- runtime specifics (data points, third parties)
  variable_payload_hash TEXT NOT NULL,
  notice_version_hash   TEXT NOT NULL,        -- sha256(template_hash || variable_payload_hash)
  locked                BOOLEAN NOT NULL DEFAULT false, -- becomes true once referenced by a live artifact
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_num)
);

-- Per-language approved notice text. legal_review_state gates eligibility.
-- auto_translated flag => visibly flagged as unreviewed in dashboard.
CREATE TABLE notice_locales (
  id                 BIGSERIAL PRIMARY KEY,
  version_id         UUID NOT NULL REFERENCES notice_versions(version_id) ON DELETE CASCADE,
  org_id             UUID NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  locale             TEXT NOT NULL,           -- BCP-47, e.g. en, hi, ur, ta
  title              TEXT NOT NULL,
  body_html          TEXT NOT NULL,
  direction          TEXT NOT NULL DEFAULT 'ltr', -- ltr | rtl  [MUST-V1 RTL test]
  legal_review_state TEXT NOT NULL DEFAULT 'draft', -- draft | approved
  auto_translated    BOOLEAN NOT NULL DEFAULT false,
  approved_by        TEXT,
  approved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (version_id, locale)
);
CREATE INDEX idx_locales_lookup ON notice_locales(org_id, locale, legal_review_state);

-- [MUST-V1] DB-level immutability: once a notice_version is locked, block edits
-- to it and to its approved locales. Edits must create a NEW version.
CREATE OR REPLACE FUNCTION forbid_locked_version_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.locked THEN
    RAISE EXCEPTION 'notice_version % is locked (referenced by a live artifact); create a new version instead', OLD.version_id;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notice_versions_immutable
  BEFORE UPDATE OR DELETE ON notice_versions
  FOR EACH ROW WHEN (OLD.locked) EXECUTE FUNCTION forbid_locked_version_edit();

CREATE OR REPLACE FUNCTION forbid_approved_locale_edit() RETURNS trigger AS $$
DECLARE v_locked BOOLEAN;
BEGIN
  SELECT locked INTO v_locked FROM notice_versions WHERE version_id = OLD.version_id;
  IF v_locked THEN
    RAISE EXCEPTION 'locale % belongs to a locked notice_version; create a new version instead', OLD.locale;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notice_locales_immutable
  BEFORE UPDATE OR DELETE ON notice_locales
  FOR EACH ROW EXECUTE FUNCTION forbid_approved_locale_edit();

-- ── Consent artifacts (the ledger) ───────────────────────────────────────
-- [DESIGN-FOR] Partition by org_id (hash) then range by month. Declarative
-- partitioning; a maintenance job creates next-month partitions.
CREATE TABLE consent_artifacts (
  artifact_id           UUID NOT NULL,
  org_id                UUID NOT NULL,
  seq                   BIGINT NOT NULL,       -- per-org monotonic sequence (chain order)
  id_hash               TEXT NOT NULL,         -- keyed hash; NEVER raw PII [MUST-V1]
  action                TEXT NOT NULL,         -- GRANT | WITHDRAW | CORRECT | ERASE
  channel               TEXT NOT NULL DEFAULT 'web',
  purposes              JSONB NOT NULL,
  interaction_events    JSONB NOT NULL,        -- explicit click/tap proof [MUST-V1 no pre-tick]
  locale                TEXT NOT NULL,
  template_hash         TEXT NOT NULL,
  variable_payload_hash TEXT NOT NULL,
  notice_version_hash   TEXT NOT NULL,
  is_minor              BOOLEAN NOT NULL DEFAULT false,
  guardian_verification JSONB,                 -- {method, ref_hash, verified_at} | null
  migrated              BOOLEAN NOT NULL DEFAULT false,      -- [DESIGN-FOR] legacy migration
  pre_existing_consent_date TIMESTAMPTZ,                     -- [DESIGN-FOR]
  expires_at            TIMESTAMPTZ,                          -- [DESIGN-FOR] re-consent cadence
  prev_hash             TEXT NOT NULL,         -- chain link
  content_hash          TEXT NOT NULL,
  key_id                TEXT NOT NULL,         -- [MUST-V1] rotation-safe
  algorithm             TEXT NOT NULL,
  signature             TEXT NOT NULL,
  merkle_root_id        UUID,                  -- [TIER-2] filled by anchoring worker
  created_at            TIMESTAMPTZ NOT NULL,  -- event time (in signed body)
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, seq, created_at)
) PARTITION BY LIST (org_id);
-- Per-org partitions are created on org signup, each RANGE-subpartitioned by month.
-- See src/db/partitions.js for the DDL the app emits at runtime. Example:
--   CREATE TABLE consent_artifacts_<org> PARTITION OF consent_artifacts
--     FOR VALUES IN ('<org_id>') PARTITION BY RANGE (created_at);
--   CREATE TABLE consent_artifacts_<org>_2026_09 PARTITION OF consent_artifacts_<org>
--     FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE INDEX idx_artifacts_lookup ON consent_artifacts(org_id, id_hash, created_at DESC);
CREATE INDEX idx_artifacts_id      ON consent_artifacts(artifact_id);
CREATE INDEX idx_artifacts_merkle  ON consent_artifacts(merkle_root_id);

-- Append-only guard: artifacts may never be updated or deleted.
CREATE OR REPLACE FUNCTION forbid_artifact_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_artifacts is append-only (attempted %); use crypto-shredding for erasure', TG_OP;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_artifacts_append_only
  BEFORE UPDATE OR DELETE ON consent_artifacts
  FOR EACH ROW EXECUTE FUNCTION forbid_artifact_mutation();

-- Per-org monotonic sequence generator (chain order independent of clock skew).
CREATE TABLE org_sequences (
  org_id  UUID PRIMARY KEY REFERENCES orgs(org_id) ON DELETE CASCADE,
  next_seq BIGINT NOT NULL DEFAULT 1,
  last_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
);

-- [TIER-2] Merkle anchoring roots.
CREATE TABLE merkle_roots (
  merkle_root_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(org_id),
  root_hash      TEXT NOT NULL,
  leaf_count     INT NOT NULL,
  interval_start TIMESTAMPTZ NOT NULL,
  interval_end   TIMESTAMPTZ NOT NULL,
  external_ref   TEXT,                          -- e.g. QLDB digest / txid once published
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Minor / guardian verification sessions ───────────────────────────────
-- OTP flow. We store only a hash of the guardian-declared phone + a hashed OTP.
CREATE TABLE guardian_verifications (
  gv_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  user_ref      TEXT NOT NULL,
  method        TEXT NOT NULL DEFAULT 'otp',
  guardian_ref_hash TEXT NOT NULL,              -- hash of declared guardian phone (no raw PII)
  otp_hash      TEXT NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  verified_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_gv_lookup ON guardian_verifications(org_id, user_ref);

-- ── Webhooks ─────────────────────────────────────────────────────────────
CREATE TABLE webhook_endpoints (
  endpoint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,                    -- per-endpoint HMAC secret
  events      JSONB NOT NULL DEFAULT '["consent.granted","consent.withdrawn","consent.erased"]',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- [MUST-V1] Delivery queue with dead-letter state.
CREATE TABLE webhook_deliveries (
  delivery_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id   UUID NOT NULL REFERENCES webhook_endpoints(endpoint_id) ON DELETE CASCADE,
  org_id        UUID NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,                 -- standardized revocation payload
  status        TEXT NOT NULL DEFAULT 'pending',-- pending | delivered | failed | dead
  attempts      INT NOT NULL DEFAULT 0,
  max_attempts  INT NOT NULL DEFAULT 8,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_deliveries_due ON webhook_deliveries(status, next_attempt_at);

-- ── [DESIGN-FOR] Breach / incident log ───────────────────────────────────
CREATE TABLE incident_log (
  incident_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES orgs(org_id),
  severity    TEXT NOT NULL,
  summary     TEXT NOT NULL,
  detail      JSONB,
  dpb_notified_at  TIMESTAMPTZ,                 -- automation is post-MVP
  users_notified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── [DESIGN-FOR] Re-consent scheduler bookkeeping ────────────────────────
CREATE TABLE reconsent_jobs (
  job_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  purpose_id TEXT NOT NULL,
  window_days INT NOT NULL,                     -- org-configured expiry window
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
