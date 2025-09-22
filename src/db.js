import Database from "better-sqlite3";

// 1) Open/maak lokale DB-file
const db = new Database("ads.db");
db.pragma("journal_mode = WAL"); // snellere writes, veilig lokaal

// 2) Hoofdtabel met JOUW kolommen
db.exec(`
CREATE TABLE IF NOT EXISTS ads_universal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT,
  pulled_at TEXT,
  keyword TEXT,
  country TEXT,
  ad_snapshot_url TEXT UNIQUE,
  page_name TEXT,
  reach INTEGER,
  reach_min INTEGER,
  reach_max INTEGER,
  product_url TEXT,
  start_date TEXT,
  media_type TEXT,
  platforms TEXT
);
`);

// 3) History/log van elke run
db.exec(`
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  keyword TEXT,
  country TEXT,
  requested INTEGER,
  returned INTEGER,
  skipped INTEGER,
  notes TEXT
);
`);

// 4) Handige indexen (sneller zoeken)
db.exec(`CREATE INDEX IF NOT EXISTS idx_ads_batch ON ads_universal (batch_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_ads_country ON ads_universal (country);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_hist_batch ON history (batch_id);`);

export default db;
