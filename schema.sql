-- AlarmCC Supabase Schema
-- Run this once in your Supabase SQL Editor (supabase.com → project → SQL Editor)

CREATE TABLE IF NOT EXISTS conversations (
  id           BIGSERIAL PRIMARY KEY,
  "customerId" TEXT        NOT NULL UNIQUE,
  status       TEXT        NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','resolved','dispatched')),
  "contractorEmailSentAt" TIMESTAMPTZ,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id               BIGSERIAL PRIMARY KEY,
  "conversationId" BIGINT      NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT        NOT NULL CHECK (role IN ('system','user','assistant')),
  content          TEXT        NOT NULL,
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages("conversationId");

-- Auto-update updatedAt on conversations whenever a row changes
CREATE OR REPLACE FUNCTION touch_conversation_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversations
  SET "updatedAt" = NOW()
  WHERE id = NEW."conversationId";
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_conversation ON messages;
CREATE TRIGGER trg_touch_conversation
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION touch_conversation_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Calls table — tracks inbound & outbound phone calls (Vonage)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calls (
  id              BIGSERIAL    PRIMARY KEY,
  "callId"        TEXT         NOT NULL UNIQUE,  -- Vonage UUID
  "customerId"    TEXT,                            -- links to conversations.customerId
  "phoneNumber"   TEXT,
  direction       TEXT         NOT NULL DEFAULT 'inbound'
                               CHECK (direction IN ('inbound','outbound')),
  status          TEXT         NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','completed','failed','unanswered')),
  duration        INTEGER,                         -- seconds
  "recordingUrl"  TEXT,
  "createdAt"     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_customer ON calls("customerId");
CREATE INDEX IF NOT EXISTS idx_calls_phone    ON calls("phoneNumber");

-- Auto-update updatedAt on calls
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
