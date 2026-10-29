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
await db.query(`
  CREATE TABLE IF NOT EXISTS landings (
    id         TEXT        PRIMARY KEY,
    url        TEXT        NOT NULL,
    name       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS landing_id TEXT`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS lp_clicked_at TIMESTAMPTZ`);
await db.query(`ALTER TABLE conversions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sale'`);
await db.query(`ALTER TABLE conversions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
for (const column of ['device', 'os', 'browser', 'language']) await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS ${column} TEXT`);
for (const column of ['is_unique_campaign', 'is_unique_stream', 'is_unique_global']) await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS ${column} BOOLEAN NOT NULL DEFAULT true`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS params JSONB`);
await db.query(`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS cost NUMERIC(12,6) NOT NULL DEFAULT 0`);

await db.query(`
  CREATE TABLE IF NOT EXISTS conversions (
    click_id   UUID        PRIMARY KEY REFERENCES clicks(click_id),
    revenue    NUMERIC(12,4),
    currency   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

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

await db.query(`CREATE INDEX IF NOT EXISTS clicks_campaign_created_idx ON clicks(campaign, created_at)`);
await db.query(`CREATE INDEX IF NOT EXISTS clicks_created_idx ON clicks(created_at)`);

console.log('[migrate] All tables ready');
await db.end();
