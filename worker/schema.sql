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

-- Telegram bot subscribers (daily reminders)
CREATE TABLE IF NOT EXISTS tg_users (
  chat_id INTEGER PRIMARY KEY,
  client  TEXT,                      -- player id the reminders and streak are tied to
  name    TEXT,
  active  INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL
);

-- Telegram groups with a shared daily leaderboard
CREATE TABLE IF NOT EXISTS tg_groups (
  chat_id INTEGER PRIMARY KEY,       -- negative Telegram group id
  title   TEXT,
  active  INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tg_members (
  group_id INTEGER NOT NULL,
  user_id  INTEGER NOT NULL,         -- = tg_users.chat_id (private chat id)
  joined   INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS tg_members_user ON tg_members (user_id);

-- Telegram Stars donations ("Qo'llab-quvvatlash")
CREATE TABLE IF NOT EXISTS donations (
  charge_id TEXT PRIMARY KEY,        -- telegram_payment_charge_id
  chat_id   INTEGER NOT NULL,        -- payer's Telegram user id
  name      TEXT,
  stars     INTEGER NOT NULL,
  anon      INTEGER NOT NULL DEFAULT 0,
  created   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS donations_chat ON donations (chat_id);
