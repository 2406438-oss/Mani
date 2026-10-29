CREATE TABLE external_identities (
  provider TEXT NOT NULL CHECK (provider IN ('yandex')),
  provider_user_id TEXT NOT NULL,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
) STRICT;
