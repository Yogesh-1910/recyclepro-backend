const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// In production (Railway), use /data volume for persistence.
// Locally, store next to server.js.
const DB_DIR = process.env.DB_PATH || __dirname;

// Make sure the directory exists (important for Railway volume)
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(path.join(DB_DIR, 'recyclepro.db'));

db.exec(`
  PRAGMA journal_mode=WAL;

  CREATE TABLE IF NOT EXISTS scrap_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller TEXT NOT NULL,
    vehicle TEXT,
    total_weight REAL NOT NULL,
    date TEXT NOT NULL,
    breakdown TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS production (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    godown TEXT NOT NULL,
    shift TEXT NOT NULL,
    granule_type TEXT NOT NULL,
    bags INTEGER NOT NULL,
    weight_kg REAL GENERATED ALWAYS AS (bags * 25) VIRTUAL,
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_name TEXT NOT NULL,
    gst_number TEXT,
    vehicle TEXT,
    granule_type TEXT NOT NULL,
    godown TEXT,
    bags INTEGER NOT NULL,
    rate_per_kg REAL DEFAULT 0,
    total_amount REAL DEFAULT 0,
    weight_kg REAL GENERATED ALWAYS AS (bags * 25) VIRTUAL,
    invoice_number TEXT,
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS buyers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    gst_number TEXT,
    address TEXT,
    phone TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    granule_type TEXT NOT NULL UNIQUE,
    rate_per_kg REAL NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS material_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS godowns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  INSERT OR IGNORE INTO material_types (name, sort_order) VALUES ('LD', 1);
  INSERT OR IGNORE INTO material_types (name, sort_order) VALUES ('BLD', 2);
  INSERT OR IGNORE INTO material_types (name, sort_order) VALUES ('HM', 3);
  INSERT OR IGNORE INTO material_types (name, sort_order) VALUES ('PP', 4);

  INSERT OR IGNORE INTO rates (granule_type, rate_per_kg) VALUES ('LD', 0);
  INSERT OR IGNORE INTO rates (granule_type, rate_per_kg) VALUES ('BLD', 0);
  INSERT OR IGNORE INTO rates (granule_type, rate_per_kg) VALUES ('HM', 0);
  INSERT OR IGNORE INTO rates (granule_type, rate_per_kg) VALUES ('PP', 0);

  INSERT OR IGNORE INTO godowns (name, sort_order) VALUES ('A', 1);
  INSERT OR IGNORE INTO godowns (name, sort_order) VALUES ('B', 2);
  INSERT OR IGNORE INTO godowns (name, sort_order) VALUES ('C', 3);

  CREATE TABLE IF NOT EXISTS company_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  INSERT OR IGNORE INTO company_settings (key, value) VALUES ('name', 'My Recycling Company');
  INSERT OR IGNORE INTO company_settings (key, value) VALUES ('address', '');
  INSERT OR IGNORE INTO company_settings (key, value) VALUES ('gst', '');
  INSERT OR IGNORE INTO company_settings (key, value) VALUES ('phone', '');
  INSERT OR IGNORE INTO company_settings (key, value) VALUES ('invoice_prefix', 'INV');
  INSERT OR IGNORE INTO company_settings (key, value) VALUES ('invoice_counter', '1');
`);

module.exports = db;
