CREATE TABLE rate_limits (
  key TEXT,
  window_start INTEGER,
  count INTEGER,
  PRIMARY KEY (key, window_start)
);
