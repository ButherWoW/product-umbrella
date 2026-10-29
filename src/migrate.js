// Run with: node src/migrate.js
// Requires DATABASE_URL to be set.

import { db } from './db.js';

if (!db) {
  console.error('DATABASE_URL is not set or PostgreSQL is unreachable. Nothing to migrate.');
  process.exit(1);
}

await db.query(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id         TEXT        PRIMARY KEY,
    name       TEXT        NOT NULL,
    active     BOOLEAN     NOT NULL DEFAULT true,
    streams    JSONB       NOT NULL DEFAULT '[]'::jsonb,
    config     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await db.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS streams JSONB NOT NULL DEFAULT '[]'::jsonb`);
await db.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb`);

await db.query(`
  CREATE TABLE IF NOT EXISTS offers (
    id         TEXT        PRIMARY KEY,
    url        TEXT        NOT NULL,
    active     BOOLEAN     NOT NULL DEFAULT true,
    postback_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true`);
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS postback_url TEXT`);
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS payout_type TEXT NOT NULL DEFAULT 'cpa'`);
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS payout NUMERIC(12,4)`);
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS payout_currency TEXT`);

await db.query(`
  CREATE TABLE IF NOT EXISTS clicks (
    click_id   UUID        PRIMARY KEY,
    campaign   TEXT        NOT NULL,
    offer_id   TEXT        NOT NULL,
    path       TEXT,
    referrer   TEXT,
    user_agent TEXT,
    subid      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
// Idempotent upgrades for existing installs
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS subid TEXT`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS country TEXT`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS ip TEXT`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS stream TEXT`);
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS daily_cap INTEGER`);
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS name TEXT`);
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS network_id TEXT`);
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false`);
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS "group" TEXT NOT NULL DEFAULT ''`);
// Conversion cap per local day (lead + sale) and the alternative offer that takes traffic when it is reached.
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS conversion_cap INTEGER`);
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS cap_tz TEXT NOT NULL DEFAULT 'UTC'`);
await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS alt_offer_id TEXT`);
await db.query(`CREATE TABLE IF NOT EXISTS networks (id TEXT PRIMARY KEY, name TEXT NOT NULL, offer_params TEXT NOT NULL DEFAULT '', click_id_param TEXT NOT NULL DEFAULT 'sub1', payout_param TEXT NOT NULL DEFAULT 'payout', notes TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
await db.query(`
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    param_map JSONB NOT NULL DEFAULT '{}'::jsonb,
    cost_model TEXT NOT NULL DEFAULT 'none',
    cpc NUMERIC(12,6),
    cost_from_param BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
// Postback to the traffic source (URL with macros and the statuses that trigger it).
await db.query(`ALTER TABLE sources ADD COLUMN IF NOT EXISTS postback_url TEXT`);
await db.query(`ALTER TABLE sources ADD COLUMN IF NOT EXISTS postback_statuses JSONB NOT NULL DEFAULT '["sale"]'::jsonb`);
await db.query(`
  CREATE TABLE IF NOT EXISTS landings (
    id         TEXT        PRIMARY KEY,
    url        TEXT        NOT NULL,
    name       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
// Owner of an offer / landing / source / network: the creating user's id; NULL = team (created by the owner or ADMIN_TOKEN).
for (const table of ['offers', 'landings', 'sources', 'networks']) await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS owner_id TEXT`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS landing_id TEXT`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS lp_clicked_at TIMESTAMPTZ`);
for (const column of ['device', 'os', 'browser', 'language']) await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS ${column} TEXT`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS asn INTEGER`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS isp TEXT`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS datacenter BOOLEAN`);
// Connection type from the ASN: mobile | broadband | datacenter (NULL without GEOIP_ASN_DB).
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS connection TEXT`);
for (const column of ['is_unique_campaign', 'is_unique_stream', 'is_unique_global']) await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS ${column} BOOLEAN NOT NULL DEFAULT true`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS params JSONB`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS cost NUMERIC(12,6) NOT NULL DEFAULT 0`);
// CPC offer payout earned by the click (DEFAULT_CURRENCY).
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS revenue NUMERIC(12,6) NOT NULL DEFAULT 0`);

await db.query(`
  CREATE TABLE IF NOT EXISTS conversions (
    click_id   UUID        PRIMARY KEY REFERENCES clicks(click_id),
    revenue    NUMERIC(12,4),
    currency   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await db.query(`ALTER TABLE conversions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sale'`);
await db.query(`ALTER TABLE conversions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
await db.query(`ALTER TABLE conversions ADD COLUMN IF NOT EXISTS tid TEXT NOT NULL DEFAULT ''`);
await db.query(`ALTER TABLE conversions ADD COLUMN IF NOT EXISTS params JSONB`);
// Upsells (G6): one row per (click_id, tid); tid '' is the main conversion. The new unique index is created
// before the old primary key on click_id is dropped, so uniqueness never lapses.
await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS conversions_click_tid_idx ON conversions(click_id, tid)`);
await db.query(`ALTER TABLE conversions DROP CONSTRAINT IF EXISTS conversions_pkey`);

await db.query(`
  CREATE TABLE IF NOT EXISTS users (
    id            UUID        PRIMARY KEY,
    email         TEXT        NOT NULL UNIQUE,
    role          TEXT        NOT NULL CHECK (role IN ('owner', 'buyer')),
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await db.query(`
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT        PRIMARY KEY,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await db.query(`CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`);
// User permissions: read-only viewer role and per-user flags.
await db.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
await db.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'buyer', 'viewer'))`);
await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_revenue BOOLEAN NOT NULL DEFAULT false`);
await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS offers_access TEXT NOT NULL DEFAULT 'all' CHECK (offers_access IN ('all', 'own'))`);
await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS view_all BOOLEAN NOT NULL DEFAULT false`);
// Per-user API keys: only the SHA-256 of the secret and its last 4 characters are stored.
await db.query(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id           UUID        PRIMARY KEY,
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    key_hash     TEXT        NOT NULL UNIQUE,
    last4        TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
  )
`);
await db.query(`CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(user_id)`);

await db.query(`CREATE INDEX IF NOT EXISTS clicks_campaign_created_idx ON clicks(campaign, created_at)`);
await db.query(`CREATE INDEX IF NOT EXISTS clicks_created_idx ON clicks(created_at)`);
// Offer daily click cap (offer_id + today) and IP deduplication (campaign + ip + window) on the click path.
await db.query(`CREATE INDEX IF NOT EXISTS clicks_offer_created_idx ON clicks(offer_id, created_at)`);
await db.query(`CREATE INDEX IF NOT EXISTS clicks_campaign_ip_created_idx ON clicks(campaign, ip, created_at)`);
await db.query(`CREATE TABLE IF NOT EXISTS bots (id BIGSERIAL PRIMARY KEY, campaign TEXT NOT NULL, offer_id TEXT, stream TEXT, user_agent TEXT, ip TEXT, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
await db.query(`CREATE INDEX IF NOT EXISTS bots_campaign_created_idx ON bots(campaign, created_at)`);
await db.query(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS isp TEXT`);
// Postback journals (G7): incoming postbacks and outgoing S2S attempts. URLs are stored without credentials.
await db.query(`CREATE TABLE IF NOT EXISTS postbacks (id BIGSERIAL PRIMARY KEY, direction TEXT NOT NULL, click_id TEXT, campaign TEXT, offer_id TEXT, tid TEXT,
  status TEXT, revenue TEXT, currency TEXT, url TEXT, status_code INTEGER, error TEXT, attempt INTEGER, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
await db.query(`CREATE INDEX IF NOT EXISTS postbacks_direction_created_idx ON postbacks(direction, created_at)`);
await db.query(`CREATE INDEX IF NOT EXISTS postbacks_campaign_created_idx ON postbacks(campaign, created_at)`);
// Spend imports (FB CSV): the clicks of the last import per key, so a re-import replaces it instead of adding.
await db.query(`CREATE TABLE IF NOT EXISTS cost_imports (import_key TEXT PRIMARY KEY, campaign TEXT NOT NULL, click_ids TEXT[] NOT NULL DEFAULT '{}',
  cost NUMERIC(14,6) NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
// Offer conversion cap counts today's conversions.
await db.query(`CREATE INDEX IF NOT EXISTS conversions_created_idx ON conversions(created_at)`);

console.log('[migrate] All tables ready');
await db.end();
