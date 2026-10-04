CREATE TABLE IF NOT EXISTS raffle_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sales_closed INTEGER NOT NULL DEFAULT 0,
  draw_result TEXT,
  live_initialized INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO raffle_settings (id, created_at) VALUES (1, unixepoch() * 1000);

CREATE TABLE IF NOT EXISTS raffle_orders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  numbers_json TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  test_payment INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  payment_id TEXT,
  preference_id TEXT,
  receipt_email_sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS raffle_orders_status_idx ON raffle_orders(status, expires_at);
CREATE INDEX IF NOT EXISTS raffle_orders_email_idx ON raffle_orders(email, status);

CREATE TABLE IF NOT EXISTS raffle_numbers (
  number INTEGER PRIMARY KEY CHECK (number BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold')),
  order_id TEXT,
  FOREIGN KEY (order_id) REFERENCES raffle_orders(id)
);
WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 200)
INSERT OR IGNORE INTO raffle_numbers(number) SELECT x FROM n;

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  address_hash TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS receipt_requests (
  request_key TEXT NOT NULL,
  requested_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS receipt_requests_recent_idx ON receipt_requests(request_key, requested_at);
