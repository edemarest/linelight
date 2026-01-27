CREATE TABLE IF NOT EXISTS donations (
  session_id TEXT PRIMARY KEY,
  payment_intent_id TEXT,
  status TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  donor_name TEXT,
  donor_email TEXT,
  livemode BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS donations_status_idx ON donations (status);
CREATE INDEX IF NOT EXISTS donations_created_at_idx ON donations (created_at DESC);
