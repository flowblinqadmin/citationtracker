-- Migration: Add tool_calls column to chatbot_logs table
-- Tracks tool invocations (e.g., probe_integration) for observability
-- Phase 5: Multi-turn awareness with probe_integration tool
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS so a
-- repeated apply (or partial-state recovery) is a no-op.

ALTER TABLE chatbot_logs
ADD COLUMN IF NOT EXISTS tool_calls jsonb NULL;

-- Create index on tool_calls for future admin queries
CREATE INDEX IF NOT EXISTS chatbot_logs_tool_calls_idx
ON chatbot_logs USING gin (tool_calls);
