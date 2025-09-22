// src/dbmigrations.js
import db from "./db.js";

function getCols(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
}
function addIfMissing(table, name, type) {
  const cols = getCols(table);
  if (!cols.includes(name)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
    console.log(`✔ added column ${name} (${type})`);
  }
}

const T = "ads_universal";

// kolommen die we in server.js schrijven
addIfMissing(T, "eu_total_reach", "INTEGER");
addIfMissing(T, "page_category", "TEXT");
addIfMissing(T, "page_likes", "INTEGER");
addIfMissing(T, "ad_id", "TEXT");
addIfMissing(T, "cta_text", "TEXT");

console.log("DB migrations done.");
process.exit(0);
