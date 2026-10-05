-- Expands the raffle inventory without changing existing sold or reserved rows.
CREATE TABLE raffle_numbers_expanded (
  number INTEGER PRIMARY KEY CHECK (number BETWEEN 1 AND 250),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold')),
  order_id TEXT,
  FOREIGN KEY (order_id) REFERENCES raffle_orders(id)
);

INSERT INTO raffle_numbers_expanded(number, status, order_id)
SELECT number, status, order_id FROM raffle_numbers;

WITH RECURSIVE n(x) AS (SELECT 201 UNION ALL SELECT x + 1 FROM n WHERE x < 250)
INSERT OR IGNORE INTO raffle_numbers_expanded(number) SELECT x FROM n;

DROP TABLE raffle_numbers;
ALTER TABLE raffle_numbers_expanded RENAME TO raffle_numbers;

ALTER TABLE raffle_orders ADD COLUMN provider_order_id TEXT;
CREATE UNIQUE INDEX raffle_orders_provider_order_idx ON raffle_orders(provider_order_id) WHERE provider_order_id IS NOT NULL;
