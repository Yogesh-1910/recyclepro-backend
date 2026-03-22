const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: function (origin, callback) {
    // Always allow requests with no origin (curl, Postman, mobile apps)
    if (!origin) return callback(null, true);

    // In development (no FRONTEND_URL set): allow any localhost port
    if (!process.env.FRONTEND_URL) {
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        return callback(null, true);
      }
    }

    // In production: allow the configured FRONTEND_URL
    if (process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL) {
      return callback(null, true);
    }

    // Block everything else
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json());

// Serve React build in production (single-server deploy)
if (process.env.NODE_ENV === 'production') {
  const buildPath = path.join(__dirname, '../frontend/build');
  const fs = require('fs');
  if (fs.existsSync(buildPath)) {
    app.use(express.static(buildPath));
    console.log('Serving static frontend from', buildPath);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── GODOWNS ──────────────────────────────────────────────────────────────────
app.get('/api/godowns', (req, res) => {
  res.json(db.prepare(`SELECT * FROM godowns ORDER BY sort_order, name`).all());
});
app.post('/api/godowns', (req, res) => {
  const cleanName = (req.body.name || '').trim().toUpperCase();
  if (!cleanName) return res.status(400).json({ error: 'Name required' });
  if (db.prepare(`SELECT id FROM godowns WHERE name=?`).get(cleanName))
    return res.status(400).json({ error: 'Godown already exists' });
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order),0) as m FROM godowns`).get().m;
  const info = db.prepare(`INSERT INTO godowns (name, sort_order) VALUES (?,?)`).run(cleanName, maxOrder + 1);
  res.json({ id: info.lastInsertRowid, name: cleanName });
});
app.put('/api/godowns/:id', (req, res) => {
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
});
app.delete('/api/godowns/:id', (req, res) => {
  const current = db.prepare(`SELECT name FROM godowns WHERE id=?`).get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Not found' });
  const inUse = db.prepare(`SELECT COUNT(*) as c FROM production WHERE godown=?`).get(current.name).c
              + db.prepare(`SELECT COUNT(*) as c FROM sales WHERE godown=?`).get(current.name).c;
  if (inUse > 0) return res.status(400).json({ error: `Cannot delete — "${current.name}" has ${inUse} records` });
  db.prepare(`DELETE FROM godowns WHERE id=?`).run(req.params.id);
  res.json({ message: 'Deleted' });
});
app.put('/api/godowns/:id/reorder', (req, res) => {
  db.prepare(`UPDATE godowns SET sort_order=? WHERE id=?`).run(req.body.sort_order, req.params.id);
  res.json({ message: 'Reordered' });
});

// ── INVENTORY ────────────────────────────────────────────────────────────────
app.get('/api/inventory', (req, res) => {
  const godowns = getGodowns();
  const types = getMaterialTypes();
  const produced = db.prepare(`SELECT godown, granule_type, SUM(bags) as bags FROM production GROUP BY godown, granule_type`).all();
  const soldGodown = db.prepare(`SELECT godown, granule_type, SUM(bags) as bags FROM sales WHERE godown IS NOT NULL GROUP BY godown, granule_type`).all();
  const soldAny = db.prepare(`SELECT granule_type, SUM(bags) as bags FROM sales WHERE godown IS NULL GROUP BY granule_type`).all();
  const inv = {};
  godowns.forEach(g => { inv[g] = {}; types.forEach(t => { inv[g][t] = 0; }); });
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
});
app.get('/api/inventory/:godown/production', (req, res) => {
  const godown = req.params.godown;
  let q = `SELECT * FROM production WHERE godown=?`;
  const params = [godown];
  if (req.query.date) { q += ` AND date=?`; params.push(req.query.date); }
  q += ` ORDER BY created_at DESC LIMIT 50`;
  res.json(db.prepare(q).all(...params));
});

// ── MATERIAL TYPES ───────────────────────────────────────────────────────────
app.get('/api/material-types', (req, res) => {
  res.json(db.prepare(`SELECT * FROM material_types ORDER BY sort_order, name`).all());
});
app.post('/api/material-types', (req, res) => {
  const cleanName = (req.body.name || '').trim().toUpperCase();
  if (!cleanName) return res.status(400).json({ error: 'Name required' });
  if (db.prepare(`SELECT id FROM material_types WHERE name=?`).get(cleanName))
    return res.status(400).json({ error: 'Already exists' });
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order),0) as m FROM material_types`).get().m;
  const info = db.prepare(`INSERT INTO material_types (name, sort_order) VALUES (?,?)`).run(cleanName, maxOrder + 1);
  db.prepare(`INSERT OR IGNORE INTO rates (granule_type, rate_per_kg) VALUES (?,0)`).run(cleanName);
  res.json({ id: info.lastInsertRowid, name: cleanName });
});
app.put('/api/material-types/:id', (req, res) => {
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
  res.json({ message: 'Renamed' });
});
app.delete('/api/material-types/:id', (req, res) => {
  const current = db.prepare(`SELECT name FROM material_types WHERE id=?`).get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Not found' });
  const inUse = db.prepare(`SELECT COUNT(*) as c FROM production WHERE granule_type=?`).get(current.name).c
              + db.prepare(`SELECT COUNT(*) as c FROM sales WHERE granule_type=?`).get(current.name).c;
  if (inUse > 0) return res.status(400).json({ error: `Cannot delete — "${current.name}" used in ${inUse} records` });
  db.prepare(`DELETE FROM material_types WHERE id=?`).run(req.params.id);
  db.prepare(`DELETE FROM rates WHERE granule_type=?`).run(current.name);
  res.json({ message: 'Deleted' });
});
app.put('/api/material-types/:id/reorder', (req, res) => {
  db.prepare(`UPDATE material_types SET sort_order=? WHERE id=?`).run(req.body.sort_order, req.params.id);
  res.json({ message: 'OK' });
});

// ── DASHBOARD ────────────────────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  const date = req.query.date || todayDate();
  const types = getMaterialTypes();
  const godowns = getGodowns();
  const totalProd = db.prepare(`SELECT COALESCE(SUM(bags),0) as total FROM production WHERE date=?`).get(date);
  const totalSales = db.prepare(`SELECT COALESCE(SUM(bags),0) as total, COALESCE(SUM(total_amount),0) as amount FROM sales WHERE date=?`).get(date);
  const totalScrap = db.prepare(`SELECT COALESCE(SUM(total_weight),0) as total FROM scrap_purchases WHERE date=?`).get(date);
  const prodByGodown = db.prepare(`SELECT godown, COALESCE(SUM(bags),0) as bags FROM production WHERE date=? GROUP BY godown`).all(date);
  const prodByShift = db.prepare(`SELECT shift, COALESCE(SUM(bags),0) as bags FROM production WHERE date=? GROUP BY shift`).all(date);
  const stockRows = db.prepare(`
    SELECT granule_type,
      COALESCE((SELECT SUM(bags) FROM production WHERE granule_type=p.granule_type),0)
      - COALESCE((SELECT SUM(bags) FROM sales WHERE granule_type=p.granule_type),0) as stock
    FROM (SELECT DISTINCT granule_type FROM production UNION SELECT DISTINCT granule_type FROM sales) p
  `).all();
  const granuleStock = {};
  types.forEach(t => { granuleStock[t] = 0; });
  stockRows.forEach(r => { granuleStock[r.granule_type] = Math.max(0, r.stock); });
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
});

// ── SCRAP ────────────────────────────────────────────────────────────────────
app.get('/api/scrap', (req, res) => {
  const rows = db.prepare(`SELECT * FROM scrap_purchases WHERE date=? ORDER BY created_at DESC`).all(req.query.date || todayDate());
  res.json(rows.map(r => ({ ...r, breakdown: JSON.parse(r.breakdown || '{}') })));
});
app.post('/api/scrap', (req, res) => {
  const { seller, vehicle, total_weight, breakdown, date } = req.body;
  if (!seller || !total_weight) return res.status(400).json({ error: 'Seller and weight required' });
  const info = db.prepare(`INSERT INTO scrap_purchases (seller,vehicle,total_weight,breakdown,date) VALUES (?,?,?,?,?)`)
    .run(seller, vehicle||null, total_weight, JSON.stringify(breakdown||{}), date||todayDate());
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/scrap/:id', (req, res) => {
  db.prepare(`DELETE FROM scrap_purchases WHERE id=?`).run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── PRODUCTION ───────────────────────────────────────────────────────────────
app.get('/api/production', (req, res) => {
  res.json(db.prepare(`SELECT * FROM production WHERE date=? ORDER BY created_at DESC`).all(req.query.date || todayDate()));
});
app.post('/api/production', (req, res) => {
  const { godown, shift, granule_type, bags, date } = req.body;
  if (!godown || !shift || !granule_type || !bags) return res.status(400).json({ error: 'All fields required' });
  const info = db.prepare(`INSERT INTO production (godown,shift,granule_type,bags,date) VALUES (?,?,?,?,?)`)
    .run(godown, shift, granule_type, bags, date||todayDate());
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/production/:id', (req, res) => {
  db.prepare(`DELETE FROM production WHERE id=?`).run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── SALES ────────────────────────────────────────────────────────────────────
app.get('/api/sales', (req, res) => {
  res.json(db.prepare(`SELECT * FROM sales WHERE date=? ORDER BY created_at DESC`).all(req.query.date || todayDate()));
});
app.get('/api/sales/stock', (req, res) => {
  const types = getMaterialTypes();
  const stock = db.prepare(`
    SELECT granule_type, COALESCE(SUM(CASE WHEN src='p' THEN qty ELSE -qty END),0) as bags
    FROM (
      SELECT granule_type, bags as qty, 'p' as src FROM production
      UNION ALL
      SELECT granule_type, bags as qty, 's' as src FROM sales
    ) GROUP BY granule_type
  `).all();
  const map = {};
  types.forEach(t => { map[t] = 0; });
  stock.forEach(s => { map[s.granule_type] = Math.max(0, s.bags); });
  res.json(map);
});
app.get('/api/sales/:id', (req, res) => {
  const sale = db.prepare(`SELECT * FROM sales WHERE id=?`).get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Not found' });
  res.json(sale);
});
app.post('/api/sales', (req, res) => {
  const { buyer_name, gst_number, vehicle, granule_type, godown, bags, rate_per_kg, date } = req.body;
  if (!buyer_name || !granule_type || !bags) return res.status(400).json({ error: 'Buyer, type and bags required' });
  const available = db.prepare(`
    SELECT COALESCE((SELECT SUM(bags) FROM production WHERE granule_type=?),0)
         - COALESCE((SELECT SUM(bags) FROM sales WHERE granule_type=?),0) as avail
  `).get(granule_type, granule_type).avail;
  if (bags > available) return res.status(400).json({ error: `Only ${available} bags available` });
  const rkg = rate_per_kg || 0;
  const invoice_number = nextInvoiceNumber();
  const info = db.prepare(`INSERT INTO sales (buyer_name,gst_number,vehicle,granule_type,godown,bags,rate_per_kg,total_amount,invoice_number,date) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(buyer_name, gst_number||null, vehicle||null, granule_type, godown||null, bags, rkg, rkg*bags*25, invoice_number, date||todayDate());
  res.json({ id: info.lastInsertRowid, invoice_number });
});
app.delete('/api/sales/:id', (req, res) => {
  db.prepare(`DELETE FROM sales WHERE id=?`).run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── BUYERS ───────────────────────────────────────────────────────────────────
app.get('/api/buyers', (req, res) => { res.json(db.prepare(`SELECT * FROM buyers ORDER BY name`).all()); });
app.post('/api/buyers', (req, res) => {
  const { name, gst_number, address, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (db.prepare(`SELECT id FROM buyers WHERE name=?`).get(name)) return res.status(400).json({ error: 'Buyer already exists' });
  const info = db.prepare(`INSERT INTO buyers (name,gst_number,address,phone) VALUES (?,?,?,?)`).run(name, gst_number||null, address||null, phone||null);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/buyers/:id', (req, res) => {
  const { name, gst_number, address, phone } = req.body;
  db.prepare(`UPDATE buyers SET name=?,gst_number=?,address=?,phone=? WHERE id=?`).run(name, gst_number||null, address||null, phone||null, req.params.id);
  res.json({ message: 'Updated' });
});
app.delete('/api/buyers/:id', (req, res) => {
  db.prepare(`DELETE FROM buyers WHERE id=?`).run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── RATES ────────────────────────────────────────────────────────────────────
app.get('/api/rates', (req, res) => { res.json(db.prepare(`SELECT * FROM rates ORDER BY granule_type`).all()); });
app.put('/api/rates/:type', (req, res) => {
  const { rate_per_kg } = req.body;
  db.prepare(`INSERT INTO rates (granule_type,rate_per_kg) VALUES (?,?) ON CONFLICT(granule_type) DO UPDATE SET rate_per_kg=?,updated_at=CURRENT_TIMESTAMP`)
    .run(req.params.type, rate_per_kg, rate_per_kg);
  res.json({ message: 'Updated' });
});

// ── SETTINGS ─────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const obj = {};
  db.prepare(`SELECT key,value FROM company_settings`).all().forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
});
app.put('/api/settings', (req, res) => {
  const stmt = db.prepare(`UPDATE company_settings SET value=? WHERE key=?`);
  Object.entries(req.body).forEach(([k,v]) => { if (k !== 'invoice_counter') stmt.run(v, k); });
  res.json({ message: 'Saved' });
});

// ── REPORT ───────────────────────────────────────────────────────────────────
app.get('/api/report', (req, res) => {
  const date = req.query.date || todayDate();
  const types = getMaterialTypes();
  const godowns = getGodowns();
  const production = db.prepare(`SELECT * FROM production WHERE date=? ORDER BY shift, godown`).all(date);
  const sales = db.prepare(`SELECT * FROM sales WHERE date=? ORDER BY created_at`).all(date);
  const scraps = db.prepare(`SELECT * FROM scrap_purchases WHERE date=? ORDER BY created_at`).all(date)
    .map(r => ({ ...r, breakdown: JSON.parse(r.breakdown||'{}') }));
  const prodByShift = { Day: 0, Night: 0 };
  production.forEach(p => { prodByShift[p.shift] = (prodByShift[p.shift]||0) + p.bags; });
  const lifeStock = db.prepare(`
    SELECT granule_type, COALESCE(SUM(CASE WHEN src='p' THEN bags ELSE -bags END),0) as bags
    FROM (
      SELECT granule_type, bags, 'p' as src FROM production
      UNION ALL
      SELECT granule_type, bags, 's' as src FROM sales
    ) GROUP BY granule_type
  `).all();
  const stockMap = {};
  types.forEach(t => { stockMap[t] = 0; });
  lifeStock.forEach(r => { stockMap[r.granule_type] = Math.max(0, r.bags); });
  const prodByGodownType = db.prepare(`SELECT godown, granule_type, SUM(bags) as bags FROM production GROUP BY godown, granule_type`).all();
  const soldByGodownType = db.prepare(`SELECT godown, granule_type, SUM(bags) as bags FROM sales WHERE godown IS NOT NULL GROUP BY godown, granule_type`).all();
  const soldNoGodown = db.prepare(`SELECT granule_type, SUM(bags) as bags FROM sales WHERE godown IS NULL GROUP BY granule_type`).all();
  const godownStock = {};
  godowns.forEach(g => { godownStock[g] = {}; types.forEach(t => { godownStock[g][t] = 0; }); });
  prodByGodownType.forEach(r => { if (godownStock[r.godown]) godownStock[r.godown][r.granule_type] = (godownStock[r.godown][r.granule_type]||0) + r.bags; });
  soldByGodownType.forEach(r => { if (godownStock[r.godown]) godownStock[r.godown][r.granule_type] = (godownStock[r.godown][r.granule_type]||0) - r.bags; });
  soldNoGodown.forEach(r => {
    let rem = r.bags;
    for (const g of godowns) {
      if (rem <= 0) break;
      const avail = godownStock[g][r.granule_type]||0;
      const d = Math.min(avail, rem);
      godownStock[g][r.granule_type] = avail - d;
      rem -= d;
    }
  });
  const totalRevenue = sales.reduce((s, r) => s + (r.total_amount||0), 0);
  const settings = {};
  db.prepare(`SELECT key,value FROM company_settings`).all().forEach(r => { settings[r.key] = r.value; });
  res.json({ date, production, sales, scraps, prodByShift, stockMap, godownStock, totalRevenue, settings, materialTypes: types, godownNames: godowns });
});

// ── CATCH-ALL (React SPA) ─────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    const buildIndex = path.join(__dirname, '../frontend/build/index.html');
    const fs = require('fs');
    if (fs.existsSync(buildIndex)) {
      res.sendFile(buildIndex);
    } else {
      res.json({ message: 'RecyclePro API is running' });
    }
  });
}

app.listen(PORT, () => console.log(`RecyclePro running on port ${PORT}`));