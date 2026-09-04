-- migrations/001_init.sqlite.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- SQLite mirror of 001_init.postgres.sql for local dev + CI (node:sqlite).
--
-- Semantic parity with Postgres. Differences are mechanical:
--   UUID/JSONB -> TEXT, TIMESTAMPTZ -> TEXT(ISO8601), gen_random_uuid()/now()
--   supplied by the app layer, partitioning is a no-op (single table),
--   plpgsql triggers -> equivalent SQLite BEFORE triggers with RAISE(ABORT).
-- The application query layer is identical across both backends.
-- ═══════════════════════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;

CREATE TABLE orgs (
  org_id        TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL
);

CREATE TABLE api_keys (
  key_id     TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash   TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'server',
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_api_keys_org ON api_keys(org_id);
CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE staff_users (
  staff_id   TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'viewer',
  created_at TEXT NOT NULL
);
CREATE TABLE access_grants (
  grant_id   TEXT PRIMARY KEY,
  staff_id   TEXT NOT NULL REFERENCES staff_users(staff_id),
  org_id     TEXT NOT NULL REFERENCES orgs(org_id),
  reason     TEXT NOT NULL,
  granted_by TEXT NOT NULL REFERENCES staff_users(staff_id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE access_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id TEXT,
  staff_id TEXT,
  action   TEXT NOT NULL,
  target   TEXT,
  at       TEXT NOT NULL
);

CREATE TABLE users (
  org_id            TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  user_ref          TEXT NOT NULL,
  salt              TEXT,
  principal_link_id TEXT,
  is_minor          INTEGER NOT NULL DEFAULT 0,
  shredded_at       TEXT,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (org_id, user_ref)
);
CREATE INDEX idx_users_principal_link ON users(principal_link_id);

CREATE TABLE notice_templates (
  template_id TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  purposes    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE notice_versions (
  version_id            TEXT PRIMARY KEY,
  template_id           TEXT NOT NULL REFERENCES notice_templates(template_id) ON DELETE CASCADE,
  org_id                TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  version_num           INTEGER NOT NULL,
  template_hash         TEXT NOT NULL,
  variable_payload      TEXT NOT NULL,
  variable_payload_hash TEXT NOT NULL,
  notice_version_hash   TEXT NOT NULL,
  locked                INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  UNIQUE (template_id, version_num)
);

CREATE TABLE notice_locales (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id         TEXT NOT NULL REFERENCES notice_versions(version_id) ON DELETE CASCADE,
  org_id             TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  locale             TEXT NOT NULL,
  title              TEXT NOT NULL,
  body_html          TEXT NOT NULL,
  direction          TEXT NOT NULL DEFAULT 'ltr',
  legal_review_state TEXT NOT NULL DEFAULT 'draft',
  auto_translated    INTEGER NOT NULL DEFAULT 0,
  approved_by        TEXT,
  approved_at        TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE (version_id, locale)
);
CREATE INDEX idx_locales_lookup ON notice_locales(org_id, locale, legal_review_state);

-- [MUST-V1] Immutability triggers: block edits/deletes on locked versions
-- and on locales whose version is locked. Edits must create a new version.
CREATE TRIGGER trg_notice_versions_no_update
BEFORE UPDATE ON notice_versions
FOR EACH ROW WHEN OLD.locked = 1 AND NEW.locked = 1
BEGIN
  SELECT RAISE(ABORT, 'notice_version is locked (referenced by a live artifact); create a new version instead');
END;
CREATE TRIGGER trg_notice_versions_no_delete
BEFORE DELETE ON notice_versions
FOR EACH ROW WHEN OLD.locked = 1
BEGIN
  SELECT RAISE(ABORT, 'notice_version is locked; cannot delete');
END;
CREATE TRIGGER trg_notice_locales_no_update
BEFORE UPDATE ON notice_locales
FOR EACH ROW WHEN (SELECT locked FROM notice_versions WHERE version_id = OLD.version_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'locale belongs to a locked notice_version; create a new version instead');
END;
CREATE TRIGGER trg_notice_locales_no_delete
BEFORE DELETE ON notice_locales
FOR EACH ROW WHEN (SELECT locked FROM notice_versions WHERE version_id = OLD.version_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'locale belongs to a locked notice_version; cannot delete');
END;

-- Single physical table in SQLite; partitioning is a Postgres-only concern.
CREATE TABLE consent_artifacts (
  artifact_id           TEXT NOT NULL,
  org_id                TEXT NOT NULL,
  seq                   INTEGER NOT NULL,
  id_hash               TEXT NOT NULL,
  action                TEXT NOT NULL,
  channel               TEXT NOT NULL DEFAULT 'web',
  purposes              TEXT NOT NULL,
  interaction_events    TEXT NOT NULL,
  locale                TEXT NOT NULL,
  template_hash         TEXT NOT NULL,
  variable_payload_hash TEXT NOT NULL,
  notice_version_hash   TEXT NOT NULL,
  is_minor              INTEGER NOT NULL DEFAULT 0,
  guardian_verification TEXT,
  migrated              INTEGER NOT NULL DEFAULT 0,
  pre_existing_consent_date TEXT,
  expires_at            TEXT,
  prev_hash             TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  key_id                TEXT NOT NULL,
  algorithm             TEXT NOT NULL,
  signature             TEXT NOT NULL,
  merkle_root_id        TEXT,
  created_at            TEXT NOT NULL,
  received_at           TEXT NOT NULL,
  PRIMARY KEY (org_id, seq)
);
CREATE INDEX idx_artifacts_lookup ON consent_artifacts(org_id, id_hash, created_at DESC);
CREATE UNIQUE INDEX idx_artifacts_id ON consent_artifacts(artifact_id);
CREATE INDEX idx_artifacts_merkle ON consent_artifacts(merkle_root_id);

-- Append-only guard.
CREATE TRIGGER trg_artifacts_no_update
BEFORE UPDATE ON consent_artifacts
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'consent_artifacts is append-only; use crypto-shredding for erasure');
END;
CREATE TRIGGER trg_artifacts_no_delete
BEFORE DELETE ON consent_artifacts
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'consent_artifacts is append-only; use crypto-shredding for erasure');
END;

CREATE TABLE org_sequences (
  org_id    TEXT PRIMARY KEY REFERENCES orgs(org_id) ON DELETE CASCADE,
  next_seq  INTEGER NOT NULL DEFAULT 1,
  last_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
);

CREATE TABLE merkle_roots (
  merkle_root_id TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES orgs(org_id),
  root_hash      TEXT NOT NULL,
  leaf_count     INTEGER NOT NULL,
  interval_start TEXT NOT NULL,
  interval_end   TEXT NOT NULL,
  external_ref   TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE guardian_verifications (
  gv_id             TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  user_ref          TEXT NOT NULL,
  method            TEXT NOT NULL DEFAULT 'otp',
  guardian_ref_hash TEXT NOT NULL,
  otp_hash          TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  verified_at       TEXT,
  expires_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_gv_lookup ON guardian_verifications(org_id, user_ref);

CREATE TABLE webhook_endpoints (
  endpoint_id TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  events      TEXT NOT NULL DEFAULT '["consent.granted","consent.withdrawn","consent.erased"]',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE webhook_deliveries (
  delivery_id     TEXT PRIMARY KEY,
  endpoint_id     TEXT NOT NULL REFERENCES webhook_endpoints(endpoint_id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 8,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_deliveries_due ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE incident_log (
  incident_id       TEXT PRIMARY KEY,
  org_id            TEXT,
  severity          TEXT NOT NULL,
  summary           TEXT NOT NULL,
  detail            TEXT,
  dpb_notified_at   TEXT,
  users_notified_at TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE reconsent_jobs (
  job_id      TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  purpose_id  TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  last_run_at TEXT,
  created_at  TEXT NOT NULL
);
