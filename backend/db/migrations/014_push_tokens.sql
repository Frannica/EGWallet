-- Authenticated Expo / FCM push token registry + delivery dedupe.
-- Never stores Firebase/Expo service credentials — only device tokens.

CREATE TABLE IF NOT EXISTS push_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL,
  token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web', 'unknown')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  app_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at TIMESTAMPTZ,
  last_error TEXT,
  CONSTRAINT push_tokens_token_unique UNIQUE (token),
  CONSTRAINT push_tokens_user_device_unique UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS push_tokens_user_enabled_idx
  ON push_tokens (user_id)
  WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS push_delivery_attempts (
  id UUID PRIMARY KEY,
  notification_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  token TEXT NOT NULL,
  provider_ticket TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT push_delivery_notification_token_unique UNIQUE (notification_id, token)
);

CREATE INDEX IF NOT EXISTS push_delivery_user_idx
  ON push_delivery_attempts (user_id, created_at DESC);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT TRUE;
