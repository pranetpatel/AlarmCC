-- Run this once in your Supabase SQL Editor
-- (supabase.com → your project → SQL Editor → New query → paste → Run)

CREATE TABLE IF NOT EXISTS calls (
  id              BIGSERIAL    PRIMARY KEY,
  "callId"        TEXT         NOT NULL UNIQUE,
  "customerId"    TEXT,
  "phoneNumber"   TEXT,
  direction       TEXT         NOT NULL DEFAULT 'inbound'
                               CHECK (direction IN ('inbound','outbound')),
  status          TEXT         NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','completed','failed','unanswered')),
  duration        INTEGER,
  "recordingUrl"  TEXT,
  "createdAt"     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_customer ON calls("customerId");
CREATE INDEX IF NOT EXISTS idx_calls_phone    ON calls("phoneNumber");

CREATE OR REPLACE FUNCTION touch_call_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_call ON calls;
CREATE TRIGGER trg_touch_call
  BEFORE UPDATE ON calls
  FOR EACH ROW EXECUTE FUNCTION touch_call_updated_at();
