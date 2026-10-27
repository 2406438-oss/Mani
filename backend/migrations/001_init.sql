CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('client', 'master', 'admin')),
  PRIMARY KEY (user_id, role)
) STRICT;

CREATE TABLE masters (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  specialization TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
) STRICT;

CREATE TABLE services (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  price_kopecks INTEGER NOT NULL CHECK (price_kopecks >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
) STRICT;

CREATE TABLE master_services (
  master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (master_id, service_id)
) STRICT;

CREATE TABLE schedules (
  id INTEGER PRIMARY KEY,
  master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  CHECK (starts_at < ends_at),
  UNIQUE (master_id, weekday, starts_at)
) STRICT;

CREATE TABLE time_blocks (
  id INTEGER PRIMARY KEY,
  master_id INTEGER REFERENCES masters(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  CHECK (starts_at < ends_at)
) STRICT;

CREATE TABLE appointments (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id),
  master_id INTEGER NOT NULL REFERENCES masters(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'completed', 'cancelled_by_client', 'cancelled_by_salon', 'no_show')),
  intentional_overlap INTEGER NOT NULL DEFAULT 0 CHECK (intentional_overlap IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (starts_at < ends_at)
) STRICT;

CREATE TABLE appointment_services (
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id),
  title_snapshot TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  price_kopecks INTEGER NOT NULL CHECK (price_kopecks >= 0),
  PRIMARY KEY (appointment_id, service_id)
) STRICT;

CREATE TABLE slot_holds (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  master_id INTEGER NOT NULL REFERENCES masters(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (starts_at < ends_at)
) STRICT;

CREATE TABLE access_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE product_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY,
  identity_key TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1))
) STRICT;

CREATE INDEX idx_user_roles_role ON user_roles(role, user_id);
CREATE INDEX idx_schedules_master_weekday ON schedules(master_id, weekday);
CREATE INDEX idx_time_blocks_interval ON time_blocks(starts_at, ends_at, master_id);
CREATE INDEX idx_appointments_master_interval ON appointments(master_id, status, starts_at, ends_at);
CREATE INDEX idx_appointments_client ON appointments(client_id, starts_at);
CREATE INDEX idx_holds_master_expiry ON slot_holds(master_id, expires_at, starts_at, ends_at);
CREATE INDEX idx_tokens_user_expiry ON access_tokens(user_id, expires_at);
CREATE INDEX idx_login_attempts_identity_time ON login_attempts(identity_key, attempted_at);

CREATE TRIGGER appointments_no_overlap_insert
BEFORE INSERT ON appointments
WHEN NEW.status = 'booked' AND NEW.intentional_overlap = 0
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.master_id = NEW.master_id
      AND a.status = 'booked'
      AND NEW.starts_at < a.ends_at
      AND NEW.ends_at > a.starts_at
  ) THEN RAISE(ABORT, 'appointment_overlap') END;
END;

CREATE TRIGGER appointments_no_overlap_update
BEFORE UPDATE OF master_id, starts_at, ends_at, status, intentional_overlap ON appointments
WHEN NEW.status = 'booked' AND NEW.intentional_overlap = 0
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.id <> NEW.id
      AND a.master_id = NEW.master_id
      AND a.status = 'booked'
      AND NEW.starts_at < a.ends_at
      AND NEW.ends_at > a.starts_at
  ) THEN RAISE(ABORT, 'appointment_overlap') END;
END;
