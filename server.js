const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

if (process.env.NODE_ENV === 'production') {
  const buildPath = path.join(__dirname, '../frontend/build');
  const fs = require('fs');
  if (fs.existsSync(buildPath)) app.use(express.static(buildPath));
}

function wrap(fn) {
  return async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e) { console.error('Route error:', e.message); res.status(500).json({ error: e.message }); }
  };
}

function todayDate() { return new Date().toISOString().split('T')[0]; }
function getMaterialTypes() {
  return db.prepare(`SELECT name FROM material_types ORDER BY sort_order, name`).all().map(r => r.name);
}
function getGodowns() {
  return db.prepare(`SELECT name FROM godowns ORDER BY sort_order, name`).all().map(r => r.name);
}
function nextInvoiceNumber() {
  const prefix = db.prepare(`SELECT value FROM company_settings WHERE key='invoice_prefix'`).get();
  const counter = db.prepare(`SELECT value FROM company_settings WHERE key='invoice_counter'`).get();
  const num = String(parseInt(counter.value)).padStart(4, '0');
  db.prepare(`UPDATE company_settings SET value=? WHERE key='invoice_counter'`).run(parseInt(counter.value) + 1);
  return `${prefix.value}-${num}`;
}

// ── Stock calculation helper ──────────────────────────────────────────────────
// Formula: opening_stock + total_produced - total_sold
function calcStock(types) {
  const opening = db.prepare(`SELECT granule_type, bags FROM opening_stock`).all();
  const openMap = {};
  opening.forEach(r => { openMap[r.granule_type] = r.bags; });

  const produced = db.prepare(`SELECT granule_type, COALESCE(SUM(bags),0) as bags FROM production GROUP BY granule_type`).all();
  const prodMap = {};
  produced.forEach(r => { prodMap[r.granule_type] = r.bags; });

  const sold = db.prepare(`SELECT granule_type, COALESCE(SUM(bags),0) as bags FROM sales GROUP BY granule_type`).all();
  const soldMap = {};
  sold.forEach(r => { soldMap[r.granule_type] = r.bags; });

  const stockMap = {};
  types.forEach(t => {
    const o = openMap[t] || 0;
    const p = prodMap[t] || 0;
    const s = soldMap[t] || 0;
    stockMap[t] = Math.max(0, o + p - s);
  });
  return stockMap;
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), node: process.version });
});

// ── OPENING STOCK ─────────────────────────────────────────────────────────────
app.get('/api/opening-stock', wrap((req, res) => {
  const types = getMaterialTypes();
  const rows = db.prepare(`SELECT * FROM opening_stock`).all();
  const map = {};
  types.forEach(t => { map[t] = { bags: 0, note: '' }; });
  rows.forEach(r => { map[r.granule_type] = { bags: r.bags, note: r.note || '' }; });
  res.json(map);
}));

app.put('/api/opening-stock/:type', wrap((req, res) => {
  const { bags, note } = req.body;
  const type = req.params.type;
  const bagsNum = parseInt(bags) || 0;
  db.prepare(`
    INSERT INTO opening_stock (granule_type, bags, note, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(granule_type) DO UPDATE SET bags=?, note=?, updated_at=CURRENT_TIMESTAMP
  `).run(type, bagsNum, note || null, bagsNum, note || null);
  res.json({ message: 'Opening stock updated' });
}));

// ── GODOWNS ───────────────────────────────────────────────────────────────────
app.get('/api/godowns', wrap((req, res) => {
  res.json(db.prepare(`SELECT * FROM godowns ORDER BY sort_order, name`).all());
}));
app.post('/api/godowns', wrap((req, res) => {
  const cleanName = (req.body.name || '').trim().toUpperCase();
  if (!cleanName) return res.status(400).json({ error: 'Name required' });
  if (db.prepare(`SELECT id FROM godowns WHERE name=?`).get(cleanName))
    return res.status(400).json({ error: 'Godown already exists' });
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order),0) as m FROM godowns`).get().m;
  const info = db.prepare(`INSERT INTO godowns (name, sort_order) VALUES (?,?)`).run(cleanName, maxOrder + 1);
  res.json({ id: info.lastInsertRowid, name: cleanName });
}));
app.put('/api/godowns/:id', wrap((req, res) => {
  const cleanName = (req.body.name || '').trim().toUpperCase();
  if (!cleanName) return res.status(400).json({ error: 'Name required' });
  const current = db.prepare(`SELECT name FROM godowns WHERE id=?`).get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Not found' });
  if (db.prepare(`SELECT id FROM godowns WHERE name=? AND id!=?`).get(cleanName, req.params.id))
    return res.status(400).json({ error: 'Name already exists' });
  db.prepare(`UPDATE godowns SET name=? WHERE id=?`).run(cleanName, req.params.id);
  db.prepare(`UPDATE production SET godown=? WHERE godown=?`).run(cleanName, current.name);
  db.prepare(`UPDATE sales SET godown=? WHERE godown=?`).run(cleanName, current.name);
  res.json({ message: 'Renamed' });
}));
app.delete('/api/godowns/:id', wrap((req, res) => {
  const current = db.prepare(`SELECT name FROM godowns WHERE id=?`).get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Not found' });
  const inUse = db.prepare(`SELECT COUNT(*) as c FROM production WHERE godown=?`).get(current.name).c
              + db.prepare(`SELECT COUNT(*) as c FROM sales WHERE godown=?`).get(current.name).c;
  if (inUse > 0) return res.status(400).json({ error: `Cannot delete — "${current.name}" has ${inUse} records` });
  db.prepare(`DELETE FROM godowns WHERE id=?`).run(req.params.id);
  res.json({ message: 'Deleted' });
}));
app.put('/api/godowns/:id/reorder', wrap((req, res) => {
  db.prepare(`UPDATE godowns SET sort_order=? WHERE id=?`).run(req.body.sort_order, req.params.id);
  res.json({ message: 'Reordered' });
}));

// ── INVENTORY ─────────────────────────────────────────────────────────────────
app.get('/api/inventory', wrap((req, res) => {
  const godowns = getGodowns();
  const types = getMaterialTypes();
  const produced = db.prepare(`SELECT godown, granule_type, SUM(bags) as bags FROM production GROUP BY godown, granule_type`).all();
  const soldGodown = db.prepare(`SELECT godown, granule_type, SUM(bags) as bags FROM sales WHERE godown IS NOT NULL GROUP BY godown, granule_type`).all();
  const soldAny = db.prepare(`SELECT granule_type, SUM(bags) as bags FROM sales WHERE godown IS NULL GROUP BY granule_type`).all();

  // Add opening stock distributed to first godown (or evenly if not specified)
  const opening = db.prepare(`SELECT granule_type, bags FROM opening_stock`).all();
  const openMap = {};
  opening.forEach(r => { openMap[r.granule_type] = r.bags; });

  const inv = {};
  godowns.forEach(g => { inv[g] = {}; types.forEach(t => { inv[g][t] = 0; }); });

  // Add opening stock to first godown as base
  if (godowns.length > 0) {
    types.forEach(t => {
      if (openMap[t]) inv[godowns[0]][t] = (inv[godowns[0]][t] || 0) + openMap[t];
    });
  }

  produced.forEach(r => { if (inv[r.godown]) inv[r.godown][r.granule_type] = (inv[r.godown][r.granule_type] || 0) + r.bags; });
  soldGodown.forEach(r => { if (inv[r.godown]) inv[r.godown][r.granule_type] = (inv[r.godown][r.granule_type] || 0) - r.bags; });
  soldAny.forEach(r => {
    let rem = r.bags;
    for (const g of godowns) {
      if (rem <= 0) break;
      const avail = inv[g][r.granule_type] || 0;
      const d = Math.min(avail, rem);
      inv[g][r.granule_type] = avail - d;
      rem -= d;
    }
  });

  const result = godowns.map(g => {
    const typeStock = {};
    let totalBags = 0;
    types.forEach(t => { const bags = Math.max(0, inv[g][t] || 0); typeStock[t] = bags; totalBags += bags; });
    return { godown: g, totalBags, totalKg: totalBags * 25, typeStock };
  });
  res.json({ godowns, types, inventory: result });
}));

app.get('/api/inventory/:godown/production', wrap((req, res) => {
  const godown = req.params.godown;
  let q = `SELECT * FROM production WHERE godown=?`;
  const params = [godown];
  if (req.query.date) { q += ` AND date=?`; params.push(req.query.date); }
  q += ` ORDER BY date DESC, created_at DESC LIMIT 100`;
  res.json(db.prepare(q).all(...params));
}));

// ── MATERIAL TYPES ────────────────────────────────────────────────────────────
app.get('/api/material-types', wrap((req, res) => {
  res.json(db.prepare(`SELECT * FROM material_types ORDER BY sort_order, name`).all());
}));
app.post('/api/material-types', wrap((req, res) => {
  const cleanName = (req.body.name || '').trim().toUpperCase();
  if (!cleanName) return res.status(400).json({ error: 'Name required' });
  if (db.prepare(`SELECT id FROM material_types WHERE name=?`).get(cleanName))
    return res.status(400).json({ error: 'Already exists' });
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order),0) as m FROM material_types`).get().m;
  const info = db.prepare(`INSERT INTO material_types (name, sort_order) VALUES (?,?)`).run(cleanName, maxOrder + 1);
  db.prepare(`INSERT OR IGNORE INTO rates (granule_type, rate_per_kg) VALUES (?,0)`).run(cleanName);
  res.json({ id: info.lastInsertRowid, name: cleanName });
}));
app.put('/api/material-types/:id', wrap((req, res) => {
  const cleanName = (req.body.name || '').trim().toUpperCase();
  if (!cleanName) return res.status(400).json({ error: 'Name required' });
  const current = db.prepare(`SELECT name FROM material_types WHERE id=?`).get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Not found' });
  if (db.prepare(`SELECT id FROM material_types WHERE name=? AND id!=?`).get(cleanName, req.params.id))
    return res.status(400).json({ error: 'Name already exists' });
  db.prepare(`UPDATE material_types SET name=? WHERE id=?`).run(cleanName, req.params.id);
  db.prepare(`UPDATE rates SET granule_type=? WHERE granule_type=?`).run(cleanName, current.name);
  db.prepare(`UPDATE production SET granule_type=? WHERE granule_type=?`).run(cleanName, current.name);
  db.prepare(`UPDATE sales SET granule_type=? WHERE granule_type=?`).run(cleanName, current.name);
  db.prepare(`UPDATE opening_stock SET granule_type=? WHERE granule_type=?`).run(cleanName, current.name);
  res.json({ message: 'Renamed' });
}));
app.delete('/api/material-types/:id', wrap((req, res) => {
  const current = db.prepare(`SELECT name FROM material_types WHERE id=?`).get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Not found' });
  const inUse = db.prepare(`SELECT COUNT(*) as c FROM production WHERE granule_type=?`).get(current.name).c
              + db.prepare(`SELECT COUNT(*) as c FROM sales WHERE granule_type=?`).get(current.name).c;
  if (inUse > 0) return res.status(400).json({ error: `Cannot delete — "${current.name}" used in ${inUse} records` });
  db.prepare(`DELETE FROM material_types WHERE id=?`).run(req.params.id);
  db.prepare(`DELETE FROM rates WHERE granule_type=?`).run(current.name);
  db.prepare(`DELETE FROM opening_stock WHERE granule_type=?`).run(current.name);
  res.json({ message: 'Deleted' });
}));
app.put('/api/material-types/:id/reorder', wrap((req, res) => {
  db.prepare(`UPDATE material_types SET sort_order=? WHERE id=?`).run(req.body.sort_order, req.params.id);
  res.json({ message: 'OK' });
}));

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', wrap((req, res) => {
  const date = req.query.date || todayDate();
  const types = getMaterialTypes();
  const godowns = getGodowns();
  const totalProd = db.prepare(`SELECT COALESCE(SUM(bags),0) as total FROM production WHERE date=?`).get(date);
  const totalSales = db.prepare(`SELECT COALESCE(SUM(bags),0) as total, COALESCE(SUM(total_amount),0) as amount FROM sales WHERE date=?`).get(date);
  const totalScrap = db.prepare(`SELECT COALESCE(SUM(total_weight),0) as total FROM scrap_purchases WHERE date=?`).get(date);
  const prodByGodown = db.prepare(`SELECT godown, COALESCE(SUM(bags),0) as bags FROM production WHERE date=? GROUP BY godown`).all(date);
  const prodByShift = db.prepare(`SELECT shift, COALESCE(SUM(bags),0) as bags FROM production WHERE date=? GROUP BY shift`).all(date);

  // Use unified stock calculation (opening + produced - sold)
  const granuleStock = calcStock(types);

  const recentActivity = db.prepare(`
    SELECT 'scrap' as type, seller as label, total_weight as qty, 'kg' as unit, created_at FROM scrap_purchases WHERE date=?
    UNION ALL
    SELECT 'production' as type, ('Godown '||godown||' '||granule_type) as label, bags as qty, 'bags' as unit, created_at FROM production WHERE date=?
    UNION ALL
    SELECT 'sale' as type, buyer_name as label, bags as qty, 'bags' as unit, created_at FROM sales WHERE date=?
    ORDER BY created_at DESC LIMIT 10
  `).all(date, date, date);

  res.json({ date, totalProduction: totalProd.total, totalSales: totalSales.total,
    todayRevenue: totalSales.amount || 0, totalScrap: totalScrap.total,
    prodByGodown, prodByShift, granuleStock, recentActivity, materialTypes: types, godownNames: godowns });
}));

// ── SCRAP ─────────────────────────────────────────────────────────────────────
app.get('/api/scrap', wrap((req, res) => {
  const rows = db.prepare(`SELECT * FROM scrap_purchases WHERE date=? ORDER BY created_at DESC`).all(req.query.date || todayDate());
  res.json(rows.map(r => ({ ...r, breakdown: JSON.parse(r.breakdown || '{}') })));
}));
app.post('/api/scrap', wrap((req, res) => {
  const { seller, vehicle, total_weight, breakdown, date } = req.body;
  if (!seller || !total_weight) return res.status(400).json({ error: 'Seller and weight required' });
  const info = db.prepare(`INSERT INTO scrap_purchases (seller,vehicle,total_weight,breakdown,date) VALUES (?,?,?,?,?)`)
    .run(seller, vehicle||null, total_weight, JSON.stringify(breakdown||{}), date||todayDate());
  res.json({ id: info.lastInsertRowid });
}));
app.put('/api/scrap/:id', wrap((req, res) => {
  const { seller, vehicle, total_weight, breakdown, date } = req.body;
  if (!seller || !total_weight) return res.status(400).json({ error: 'Seller and weight required' });
  const existing = db.prepare(`SELECT id FROM scrap_purchases WHERE id=?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE scrap_purchases SET seller=?,vehicle=?,total_weight=?,breakdown=?,date=? WHERE id=?`)
    .run(seller, vehicle||null, total_weight, JSON.stringify(breakdown||{}), date||todayDate(), req.params.id);
  res.json({ message: 'Updated' });
}));
app.delete('/api/scrap/:id', wrap((req, res) => {
  db.prepare(`DELETE FROM scrap_purchases WHERE id=?`).run(req.params.id);
  res.json({ message: 'Deleted' });
}));

// ── PRODUCTION ────────────────────────────────────────────────────────────────
// Get by date (default today) OR all recent if no date given
app.get('/api/production', wrap((req, res) => {
  if (req.query.date) {
    res.json(db.prepare(`SELECT * FROM production WHERE date=? ORDER BY created_at DESC`).all(req.query.date));
  } else {
    // Return last 7 days if no date specified
    res.json(db.prepare(`SELECT * FROM production ORDER BY date DESC, created_at DESC LIMIT 200`).all());
  }
}));

// Get single production entry
app.get('/api/production/:id', wrap((req, res) => {
  const row = db.prepare(`SELECT * FROM production WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
}));

app.post('/api/production', wrap((req, res) => {
  const { godown, shift, granule_type, bags, date } = req.body;
  if (!godown || !shift || !granule_type || !bags) return res.status(400).json({ error: 'All fields required' });
  const info = db.prepare(`INSERT INTO production (godown,shift,granule_type,bags,date) VALUES (?,?,?,?,?)`)
    .run(godown, shift, granule_type, parseInt(bags), date||todayDate());
  res.json({ id: info.lastInsertRowid });
}));

// Edit production entry
app.put('/api/production/:id', wrap((req, res) => {
  const { godown, shift, granule_type, bags, date } = req.body;
  if (!godown || !shift || !granule_type || !bags) return res.status(400).json({ error: 'All fields required' });
  const existing = db.prepare(`SELECT id FROM production WHERE id=?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Entry not found' });
  db.prepare(`UPDATE production SET godown=?, shift=?, granule_type=?, bags=?, date=? WHERE id=?`)
    .run(godown, shift, granule_type, parseInt(bags), date||todayDate(), req.params.id);
  res.json({ message: 'Updated' });
}));

app.delete('/api/production/:id', wrap((req, res) => {
  db.prepare(`DELETE FROM production WHERE id=?`).run(req.params.id);
  res.json({ message: 'Deleted' });
}));

// ── SALES ─────────────────────────────────────────────────────────────────────
app.get('/api/sales', wrap((req, res) => {
  res.json(db.prepare(`SELECT * FROM sales WHERE date=? ORDER BY created_at DESC`).all(req.query.date || todayDate()));
}));
app.get('/api/sales/stock', wrap((req, res) => {
  const types = getMaterialTypes();
  const stockMap = calcStock(types);
  res.json(stockMap);
}));
app.get('/api/sales/:id', wrap((req, res) => {
  const sale = db.prepare(`SELECT * FROM sales WHERE id=?`).get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Not found' });
  res.json(sale);
}));
app.post('/api/sales', wrap((req, res) => {
  const { buyer_name, gst_number, vehicle, granule_type, godown, bags, rate_per_kg, date } = req.body;
  if (!buyer_name || !granule_type || !bags) return res.status(400).json({ error: 'Buyer, type and bags required' });
  const types = getMaterialTypes();
  const stockMap = calcStock(types);
  const available = stockMap[granule_type] || 0;
  if (parseInt(bags) > available) return res.status(400).json({ error: `Only ${available} bags available` });
  const rkg = rate_per_kg || 0;
  const invoice_number = nextInvoiceNumber();
  const info = db.prepare(`INSERT INTO sales (buyer_name,gst_number,vehicle,granule_type,godown,bags,rate_per_kg,total_amount,invoice_number,date) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(buyer_name, gst_number||null, vehicle||null, granule_type, godown||null, parseInt(bags), rkg, rkg*parseInt(bags)*25, invoice_number, date||todayDate());
  res.json({ id: info.lastInsertRowid, invoice_number });
}));
app.put('/api/sales/:id', wrap((req, res) => {
  const { buyer_name, gst_number, vehicle, granule_type, godown, bags, rate_per_kg, date } = req.body;
  if (!buyer_name || !granule_type || !bags) return res.status(400).json({ error: 'Buyer, type and bags required' });
  const existing = db.prepare(`SELECT id FROM sales WHERE id=?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const rkg = rate_per_kg || 0;
  db.prepare(`UPDATE sales SET buyer_name=?,gst_number=?,vehicle=?,granule_type=?,godown=?,bags=?,rate_per_kg=?,total_amount=?,date=? WHERE id=?`)
    .run(buyer_name, gst_number||null, vehicle||null, granule_type, godown||null, parseInt(bags), rkg, rkg*parseInt(bags)*25, date||todayDate(), req.params.id);
  res.json({ message: 'Updated' });
}));
app.delete('/api/sales/:id', wrap((req, res) => {
  db.prepare(`DELETE FROM sales WHERE id=?`).run(req.params.id);
  res.json({ message: 'Deleted' });
}));

// ── BUYERS ────────────────────────────────────────────────────────────────────
app.get('/api/buyers', wrap((req, res) => { res.json(db.prepare(`SELECT * FROM buyers ORDER BY name`).all()); }));
app.post('/api/buyers', wrap((req, res) => {
  const { name, gst_number, address, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (db.prepare(`SELECT id FROM buyers WHERE name=?`).get(name)) return res.status(400).json({ error: 'Buyer already exists' });
  const info = db.prepare(`INSERT INTO buyers (name,gst_number,address,phone) VALUES (?,?,?,?)`).run(name, gst_number||null, address||null, phone||null);
  res.json({ id: info.lastInsertRowid });
}));
app.put('/api/buyers/:id', wrap((req, res) => {
  const { name, gst_number, address, phone } = req.body;
  db.prepare(`UPDATE buyers SET name=?,gst_number=?,address=?,phone=? WHERE id=?`).run(name, gst_number||null, address||null, phone||null, req.params.id);
  res.json({ message: 'Updated' });
}));
app.delete('/api/buyers/:id', wrap((req, res) => {
  db.prepare(`DELETE FROM buyers WHERE id=?`).run(req.params.id);
  res.json({ message: 'Deleted' });
}));

// ── RATES ─────────────────────────────────────────────────────────────────────
app.get('/api/rates', wrap((req, res) => { res.json(db.prepare(`SELECT * FROM rates ORDER BY granule_type`).all()); }));
app.put('/api/rates/:type', wrap((req, res) => {
  const { rate_per_kg } = req.body;
  db.prepare(`INSERT INTO rates (granule_type,rate_per_kg) VALUES (?,?) ON CONFLICT(granule_type) DO UPDATE SET rate_per_kg=?,updated_at=CURRENT_TIMESTAMP`)
    .run(req.params.type, rate_per_kg, rate_per_kg);
  res.json({ message: 'Updated' });
}));

// ── SETTINGS ──────────────────────────────────────────────────────────────────
app.get('/api/settings', wrap((req, res) => {
  const obj = {};
  db.prepare(`SELECT key,value FROM company_settings`).all().forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
}));
app.put('/api/settings', wrap((req, res) => {
  const stmt = db.prepare(`UPDATE company_settings SET value=? WHERE key=?`);
  Object.entries(req.body).forEach(([k,v]) => { if (k !== 'invoice_counter') stmt.run(v, k); });
  res.json({ message: 'Saved' });
}));

// ── REPORT ────────────────────────────────────────────────────────────────────
app.get('/api/report', wrap((req, res) => {
  const date = req.query.date || todayDate();
  const types = getMaterialTypes();
  const godowns = getGodowns();
  const production = db.prepare(`SELECT * FROM production WHERE date=? ORDER BY shift, godown`).all(date);
  const sales = db.prepare(`SELECT * FROM sales WHERE date=? ORDER BY created_at`).all(date);
  const scraps = db.prepare(`SELECT * FROM scrap_purchases WHERE date=? ORDER BY created_at`).all(date)
    .map(r => ({ ...r, breakdown: JSON.parse(r.breakdown||'{}') }));
  const prodByShift = { Day: 0, Night: 0 };
  production.forEach(p => { prodByShift[p.shift] = (prodByShift[p.shift]||0) + p.bags; });

  // Use unified stock calculation
  const stockMap = calcStock(types);

  // Opening stock for display
  const openingRows = db.prepare(`SELECT granule_type, bags FROM opening_stock`).all();
  const openingMap = {};
  types.forEach(t => { openingMap[t] = 0; });
  openingRows.forEach(r => { openingMap[r.granule_type] = r.bags; });

  // Godown stock
  const prodByGodownType = db.prepare(`SELECT godown, granule_type, SUM(bags) as bags FROM production GROUP BY godown, granule_type`).all();
  const soldByGodownType = db.prepare(`SELECT godown, granule_type, SUM(bags) as bags FROM sales WHERE godown IS NOT NULL GROUP BY godown, granule_type`).all();
  const soldNoGodown = db.prepare(`SELECT granule_type, SUM(bags) as bags FROM sales WHERE godown IS NULL GROUP BY granule_type`).all();

  const godownStock = {};
  godowns.forEach(g => { godownStock[g] = {}; types.forEach(t => { godownStock[g][t] = 0; }); });
  // Opening stock goes to first godown
  if (godowns.length > 0) {
    types.forEach(t => { if (openingMap[t]) godownStock[godowns[0]][t] = (godownStock[godowns[0]][t] || 0) + openingMap[t]; });
  }
  prodByGodownType.forEach(r => { if (godownStock[r.godown]) godownStock[r.godown][r.granule_type] = (godownStock[r.godown][r.granule_type]||0) + r.bags; });
  soldByGodownType.forEach(r => { if (godownStock[r.godown]) godownStock[r.godown][r.granule_type] = (godownStock[r.godown][r.granule_type]||0) - r.bags; });
  soldNoGodown.forEach(r => {
    let rem = r.bags;
    for (const g of godowns) {
      if (rem <= 0) break;
      const avail = godownStock[g][r.granule_type]||0;
      const d = Math.min(avail, rem); godownStock[g][r.granule_type] = avail - d; rem -= d;
    }
  });

  const totalRevenue = sales.reduce((s, r) => s + (r.total_amount||0), 0);
  const settings = {};
  db.prepare(`SELECT key,value FROM company_settings`).all().forEach(r => { settings[r.key] = r.value; });

  res.json({ date, production, sales, scraps, prodByShift, stockMap, godownStock, openingMap, totalRevenue, settings, materialTypes: types, godownNames: godowns });
}));

// ── CATCH-ALL ─────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    const buildIndex = path.join(__dirname, '../frontend/build/index.html');
    const fs = require('fs');
    if (fs.existsSync(buildIndex)) res.sendFile(buildIndex);
    else res.json({ message: 'RecyclePro API running' });
  });
}

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`RecyclePro running on port ${PORT}`));