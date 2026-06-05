-- Add contractor email tracking to conversations
-- Run once in Supabase SQL Editor

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS "contractorEmailSentAt" TIMESTAMPTZ;
