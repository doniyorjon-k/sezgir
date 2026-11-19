-- one row per player per daily puzzle
CREATE TABLE IF NOT EXISTS plays (
  date    TEXT    NOT NULL,          -- YYYY-MM-DD of the puzzle
  client  TEXT    NOT NULL,          -- random id kept in the player's browser
  total   INTEGER NOT NULL,          -- 0..100
  scores  TEXT    NOT NULL,          -- JSON array of the five test scores
  created INTEGER NOT NULL,          -- unix ms
  PRIMARY KEY (date, client)
);
CREATE INDEX IF NOT EXISTS plays_date_total ON plays (date, total);

-- one row per visitor per day; `last` is refreshed by a ping every couple of minutes while the page is open
CREATE TABLE IF NOT EXISTS visits (
  date   TEXT    NOT NULL,           -- YYYY-MM-DD in Asia/Tashkent
  client TEXT    NOT NULL,
  last   INTEGER NOT NULL,           -- unix ms of the latest ping
  PRIMARY KEY (date, client)
);
CREATE INDEX IF NOT EXISTS visits_last ON visits (last);
