-- Product Umbrella production schema. Kept aligned with src/migrate.js and src/db.js.
CREATE TABLE IF NOT EXISTS campaigns (
  id text PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  streams jsonb NOT NULL DEFAULT '[]'::jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS offers (
  id text PRIMARY KEY,
  url text NOT NULL CHECK (url ~ '^https://'),
  active boolean NOT NULL DEFAULT true,
  postback_url text,
  payout_type text NOT NULL DEFAULT 'cpa',
  payout numeric(12,4),
  payout_currency text,
  daily_cap integer,
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  param_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_model TEXT NOT NULL DEFAULT 'none',
  cpc NUMERIC(12,6),
  cost_from_param BOOLEAN NOT NULL DEFAULT false,
  postback_url TEXT,
  postback_statuses JSONB NOT NULL DEFAULT '["sale"]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE offers ADD COLUMN IF NOT EXISTS network_id TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS "group" TEXT NOT NULL DEFAULT '';
ALTER TABLE offers ADD COLUMN IF NOT EXISTS conversion_cap INTEGER;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS cap_tz TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE offers ADD COLUMN IF NOT EXISTS alt_offer_id TEXT;
CREATE TABLE IF NOT EXISTS networks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, offer_params TEXT NOT NULL DEFAULT '',
  click_id_param TEXT NOT NULL DEFAULT 'sub1', payout_param TEXT NOT NULL DEFAULT 'payout',
  notes TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clicks (
  click_id uuid PRIMARY KEY,
  campaign text NOT NULL,
  offer_id text NOT NULL,
  path text,
  referrer text,
  user_agent text,
  subid text,
  country text,
  ip text,
  stream text,
  params jsonb,
  cost numeric(12,6) NOT NULL DEFAULT 0,
  revenue numeric(12,6) NOT NULL DEFAULT 0,
  landing_id text,
  lp_clicked_at timestamptz,
  is_unique_campaign boolean NOT NULL DEFAULT true,
  is_unique_stream boolean NOT NULL DEFAULT true,
  is_unique_global boolean NOT NULL DEFAULT true,
  device text,
  os text,
  browser text,
  language text,
  asn integer,
  isp text,
  datacenter boolean,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversions (
  click_id uuid NOT NULL REFERENCES clicks(click_id),
  tid text NOT NULL DEFAULT '',  -- '' = main conversion; other values = upsells (postback tid)
  revenue numeric(12,4),
  currency text,
  status text NOT NULL DEFAULT 'sale' CHECK (status IN ('lead', 'sale', 'rejected', 'trash')),
  params jsonb,                  -- sub_id_N sent with the postback
  updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS conversions_click_tid_idx ON conversions(click_id, tid);
CREATE TABLE IF NOT EXISTS bots (
  id BIGSERIAL PRIMARY KEY, campaign TEXT NOT NULL, offer_id TEXT, stream TEXT,
  user_agent TEXT, ip TEXT, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bots_campaign_created_idx ON bots(campaign, created_at);
-- Postback journals (G7): direction 'in' (incoming /postback) or 'out' (S2S attempt). URLs without credentials.
CREATE TABLE IF NOT EXISTS postbacks (
  id BIGSERIAL PRIMARY KEY, direction TEXT NOT NULL, click_id TEXT, campaign TEXT, offer_id TEXT, tid TEXT,
  status TEXT, revenue TEXT, currency TEXT, url TEXT, status_code INTEGER, error TEXT, attempt INTEGER, ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS postbacks_direction_created_idx ON postbacks(direction, created_at);
CREATE INDEX IF NOT EXISTS postbacks_campaign_created_idx ON postbacks(campaign, created_at);

CREATE INDEX IF NOT EXISTS clicks_campaign_created_idx ON clicks(campaign, created_at);
CREATE INDEX IF NOT EXISTS clicks_created_idx ON clicks(created_at);
CREATE INDEX IF NOT EXISTS conversions_created_idx ON conversions(created_at);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('owner', 'buyer', 'viewer')),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  hide_revenue boolean NOT NULL DEFAULT false,
  offers_access text NOT NULL DEFAULT 'all' CHECK (offers_access IN ('all', 'own')),
  view_all boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  last4 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS landings (
  id text PRIMARY KEY,
  url text NOT NULL CHECK (url ~ '^https://'),
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
