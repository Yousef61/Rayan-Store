'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { db, getSettings, setSetting, transaction, PUBLIC_SETTINGS } = require('./src/db');
const auth = require('./src/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

const GOVERNORATES = [
  'القاهرة', 'الجيزة', 'الإسكندرية', 'القليوبية', 'الشرقية', 'الدقهلية', 'الغربية', 'المنوفية',
  'البحيرة', 'كفر الشيخ', 'دمياط', 'بورسعيد', 'الإسماعيلية', 'السويس', 'الفيوم', 'بني سويف',
  'المنيا', 'أسيوط', 'سوهاج', 'قنا', 'الأقصر', 'أسوان', 'البحر الأحمر', 'الوادي الجديد',
  'مطروح', 'شمال سيناء', 'جنوب سيناء',
];
const ORDER_STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];

// ---------- helpers ----------
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

function productRow(p) {
  if (!p) return p;
  return {
    ...p,
    images: JSON.parse(p.images || '[]'),
    options: p.options ? p.options.split(',').map((s) => s.trim()).filter(Boolean) : [],
    active: !!p.active,
    featured: !!p.featured,
  };
}

function publicSettings() {
  const s = getSettings();
  const out = {};
  for (const k of PUBLIC_SETTINGS) out[k] = s[k] ?? '';
  out.shipping_fee = Number(out.shipping_fee) || 0;
  out.free_shipping_over = Number(out.free_shipping_over) || 0;
  out.governorates = GOVERNORATES;
  return out;
}

function shippingFor(subtotal, s = publicSettings()) {
  if (s.free_shipping_over > 0 && subtotal >= s.free_shipping_over) return 0;
  return s.shipping_fee;
}

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'حصل خطأ في السيرفر' });
  }
};
const bad = (message) => Object.assign(new Error(message), { status: 400 });

// ---------- public API ----------
app.get('/api/settings', wrap((req, res) => res.json(publicSettings())));

app.get('/api/categories', wrap((req, res) => {
  res.json(db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS product_count
    FROM categories c ORDER BY c.sort, c.id`).all());
}));

app.get('/api/products', wrap((req, res) => {
  const where = ['p.active = 1'];
  const params = [];
  if (req.query.category) {
    where.push('c.slug = ?');
    params.push(str(req.query.category, 100));
  }
  if (req.query.q) {
    where.push('(p.name LIKE ? OR p.description LIKE ?)');
    const q = `%${str(req.query.q, 100)}%`;
    params.push(q, q);
  }
  if (req.query.featured === '1') where.push('p.featured = 1');
  const rows = db.prepare(`
    SELECT p.*, c.name AS category_name, c.slug AS category_slug
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.featured DESC, p.id DESC`).all(...params);
  res.json(rows.map(productRow));
}));

app.get('/api/products/:id', wrap((req, res) => {
  const p = db.prepare(`
    SELECT p.*, c.name AS category_name, c.slug AS category_slug
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.id = ? AND p.active = 1`).get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'المنتج غير موجود' });
  res.json(productRow(p));
}));

const orderLimiter = new Map();
app.post('/api/orders', wrap((req, res) => {
  // Simple anti-spam: max 10 orders per IP per hour.
  const now = Date.now();
  const hits = (orderLimiter.get(req.ip) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= 10) return res.status(429).json({ error: 'طلبات كثيرة، حاول مرة أخرى لاحقاً' });

  const b = req.body || {};
  const customer_name = str(b.customer_name, 100);
  const phone = str(b.phone, 20).replace(/[^\d+]/g, '');
  const phone2 = str(b.phone2, 20).replace(/[^\d+]/g, '');
  const governorate = str(b.governorate, 50);
  const address = str(b.address, 500);
  const notes = str(b.notes, 1000);

  if (customer_name.length < 2) throw bad('من فضلك اكتب الاسم');
  if (!/^(\+?20)?0?1[0125]\d{8}$/.test(phone)) throw bad('رقم الموبايل غير صحيح');
  if (!GOVERNORATES.includes(governorate)) throw bad('اختر المحافظة');
  if (address.length < 5) throw bad('من فضلك اكتب العنوان بالتفصيل');
  if (!Array.isArray(b.items) || b.items.length === 0) throw bad('السلة فارغة');
  if (b.items.length > 50) throw bad('عدد المنتجات كبير جداً');

  const order = transaction(() => {
    const getP = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
    const items = [];
    const needed = new Map();
    for (const it of b.items) {
      const qty = Math.floor(num(it.qty));
      if (!(qty >= 1 && qty <= 99)) throw bad('كمية غير صحيحة');
      const p = productRow(getP.get(Math.floor(num(it.id))));
      if (!p) throw bad('منتج في السلة لم يعد متاحاً، من فضلك حدّث السلة');
      const option = str(it.option, 100);
      if (p.options.length && !p.options.includes(option)) throw bad(`اختر اللون/الموديل لـ "${p.name}"`);
      needed.set(p.id, (needed.get(p.id) || 0) + qty);
      if (needed.get(p.id) > p.stock) throw bad(`الكمية المتاحة من "${p.name}" هي ${p.stock} فقط`);
      items.push({ id: p.id, name: p.name, price: p.price, qty, option: p.options.length ? option : '', image: p.images[0] || '' });
    }
    const dec = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
    for (const [id, qty] of needed) dec.run(qty, id);

    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const shipping = shippingFor(subtotal);
    const total = subtotal + shipping;
    const r = db.prepare(`INSERT INTO orders (customer_name, phone, phone2, governorate, address, notes, items, subtotal, shipping, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(customer_name, phone, phone2, governorate, address, notes, JSON.stringify(items), subtotal, shipping, total);
    return { id: Number(r.lastInsertRowid), items, subtotal, shipping, total };
  });

  hits.push(now);
  orderLimiter.set(req.ip, hits);
  res.status(201).json(order);
}));

// ---------- admin API ----------
app.post('/api/admin/login', wrap((req, res) => {
  if (!auth.loginAllowed(req.ip)) return res.status(429).json({ error: 'محاولات كثيرة، حاول بعد 15 دقيقة' });
  const password = String(req.body?.password || '');
  if (!auth.verifyPassword(password, getSettings().admin_password_hash)) {
    auth.recordFailure(req.ip);
    return res.status(401).json({ error: 'كلمة السر غير صحيحة' });
  }
  auth.clearFailures(req.ip);
  auth.setSessionCookie(req, res);
  res.json({ ok: true });
}));

app.post('/api/admin/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => res.json({ admin: auth.isAdmin(req) }));

const admin = express.Router();
admin.use(auth.requireAdmin);

admin.get('/stats', wrap((req, res) => {
  const one = (sql) => db.prepare(sql).get();
  res.json({
    products: one('SELECT COUNT(*) AS n FROM products').n,
    out_of_stock: one('SELECT COUNT(*) AS n FROM products WHERE stock <= 0 AND active = 1').n,
    new_orders: one("SELECT COUNT(*) AS n FROM orders WHERE status = 'new'").n,
    orders_today: one("SELECT COUNT(*) AS n FROM orders WHERE date(created_at, 'localtime') = date('now', 'localtime')").n,
    revenue: one("SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE status = 'delivered'").n,
  });
}));

// Products
function readProductBody(b) {
  const p = {
    name: str(b.name, 150),
    description: str(b.description, 5000),
    price: num(b.price),
    old_price: b.old_price === '' || b.old_price == null ? null : num(b.old_price),
    category_id: b.category_id ? Math.floor(num(b.category_id)) : null,
    images: JSON.stringify((Array.isArray(b.images) ? b.images : []).map((u) => str(u, 300)).filter((u) => u.startsWith('/uploads/')).slice(0, 10)),
    options: (Array.isArray(b.options) ? b.options : String(b.options || '').split(','))
      .map((s) => str(s, 50).replace(/,/g, ' ')).filter(Boolean).join(','),
    stock: Math.max(0, Math.floor(num(b.stock) || 0)),
    active: b.active === false || b.active === 0 ? 0 : 1,
    featured: b.featured ? 1 : 0,
  };
  if (!p.name) throw bad('اسم المنتج مطلوب');
  if (!(p.price >= 0)) throw bad('السعر غير صحيح');
  if (p.old_price !== null && !(p.old_price >= 0)) throw bad('السعر القديم غير صحيح');
  if (p.category_id && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(p.category_id)) throw bad('القسم غير موجود');
  return p;
}

admin.get('/products', wrap((req, res) => {
  const rows = db.prepare(`SELECT p.*, c.name AS category_name FROM products p
    LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.id DESC`).all();
  res.json(rows.map(productRow));
}));

admin.post('/products', wrap((req, res) => {
  const p = readProductBody(req.body || {});
  const r = db.prepare(`INSERT INTO products (name, description, price, old_price, category_id, images, options, stock, active, featured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.name, p.description, p.price, p.old_price, p.category_id, p.images, p.options, p.stock, p.active, p.featured);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));

admin.put('/products/:id', wrap((req, res) => {
  const p = readProductBody(req.body || {});
  const r = db.prepare(`UPDATE products SET name=?, description=?, price=?, old_price=?, category_id=?, images=?, options=?, stock=?, active=?, featured=?
    WHERE id = ?`)
    .run(p.name, p.description, p.price, p.old_price, p.category_id, p.images, p.options, p.stock, p.active, p.featured, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'المنتج غير موجود' });
  res.json({ ok: true });
}));

admin.delete('/products/:id', wrap((req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// Image upload
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[file.mimetype];
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)),
});
admin.post('/upload', (req, res) => {
  upload.array('images', 10)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'حجم الصورة أكبر من 8 ميجا' : 'فشل رفع الصور' });
    res.json({ urls: (req.files || []).map((f) => `/uploads/${f.filename}`) });
  });
});

// Categories
function readCategoryBody(b) {
  const name = str(b.name, 80);
  if (!name) throw bad('اسم القسم مطلوب');
  let slug = str(b.slug, 80).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) slug = `cat-${crypto.randomBytes(3).toString('hex')}`;
  return { name, slug, sort: Math.floor(num(b.sort)) || 0 };
}
admin.post('/categories', wrap((req, res) => {
  const c = readCategoryBody(req.body || {});
  try {
    const r = db.prepare('INSERT INTO categories (name, slug, sort) VALUES (?, ?, ?)').run(c.name, c.slug, c.sort);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch {
    throw bad('الرابط (slug) مستخدم من قبل');
  }
}));
admin.put('/categories/:id', wrap((req, res) => {
  const c = readCategoryBody(req.body || {});
  try {
    db.prepare('UPDATE categories SET name=?, slug=?, sort=? WHERE id=?').run(c.name, c.slug, c.sort, Number(req.params.id));
  } catch {
    throw bad('الرابط (slug) مستخدم من قبل');
  }
  res.json({ ok: true });
}));
admin.delete('/categories/:id', wrap((req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// Orders
admin.get('/orders', wrap((req, res) => {
  const status = ORDER_STATUSES.includes(req.query.status) ? req.query.status : null;
  const rows = status
    ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT 500').all(status)
    : db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 500').all();
  res.json(rows.map((o) => ({ ...o, items: JSON.parse(o.items) })));
}));

admin.put('/orders/:id', wrap((req, res) => {
  const status = req.body?.status;
  if (!ORDER_STATUSES.includes(status)) throw bad('حالة غير صحيحة');
  transaction(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!o) throw Object.assign(new Error('الطلب غير موجود'), { status: 404 });
    // Return items to stock when an order is cancelled, and take them again if it is un-cancelled.
    const wasCancelled = o.status === 'cancelled';
    const nowCancelled = status === 'cancelled';
    if (wasCancelled !== nowCancelled) {
      const upd = db.prepare('UPDATE products SET stock = MAX(0, stock + ?) WHERE id = ?');
      for (const it of JSON.parse(o.items)) upd.run(nowCancelled ? it.qty : -it.qty, it.id);
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, o.id);
  });
  res.json({ ok: true });
}));

admin.delete('/orders/:id', wrap((req, res) => {
  db.prepare('DELETE FROM orders WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// Settings
admin.get('/settings', wrap((req, res) => res.json(publicSettings())));
admin.put('/settings', wrap((req, res) => {
  const b = req.body || {};
  for (const k of PUBLIC_SETTINGS) {
    if (!(k in b)) continue;
    let v = str(b[k], 300);
    if (k === 'shipping_fee' || k === 'free_shipping_over') {
      if (!(Number(v) >= 0)) throw bad('قيمة الشحن غير صحيحة');
      v = String(Number(v));
    }
    if (k === 'whatsapp' || k === 'phone') v = v.replace(/[^\d+]/g, '');
    if (k === 'facebook_url' && v && !/^https?:\/\//.test(v)) throw bad('رابط الفيسبوك غير صحيح');
    setSetting(k, v);
  }
  res.json({ ok: true });
}));

admin.put('/password', wrap((req, res) => {
  const { current, next } = req.body || {};
  if (!auth.verifyPassword(String(current || ''), getSettings().admin_password_hash)) throw bad('كلمة السر الحالية غير صحيحة');
  if (String(next || '').length < 6) throw bad('كلمة السر الجديدة لازم تكون 6 حروف على الأقل');
  setSetting('admin_password_hash', auth.hashPassword(String(next)));
  auth.setSessionCookie(req, res);
  res.json({ ok: true });
}));

app.use('/api/admin', admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'غير موجود' }));

// ---------- static files ----------
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Rayan Store running on http://localhost:${PORT}`));
