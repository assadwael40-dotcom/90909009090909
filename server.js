const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ORDER_EMAIL = process.env.ORDER_EMAIL || 'assadwael40@gmail.com';
let mailer = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = require('nodemailer').createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
}
function notify(o) {
  if (!mailer) return console.log('لم يتم ضبط SMTP_USER/SMTP_PASS، الطلب اتحفظ بس من غير إيميل');
  const text = `الاسم: ${o.name}\nالموبايل: ${o.phone}\nالعنوان: ${o.address}\n\n` +
    o.items.map(i => `${i.name} × ${i.qty} = ${i.price * i.qty}`).join('\n') + `\n\nالإجمالي: ${o.total} ج.م`;
  mailer.sendMail({ from: process.env.SMTP_USER, to: ORDER_EMAIL, subject: 'طلب جديد #' + o.id, text }).catch(e => console.error('فشل إرسال الإيميل:', e.message));
}

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // غيّرها!
const DB = path.join(__dirname, 'data.json');

const seed = {
  products: [
    { id: 1, name: 'سماعات لاسلكية', price: 850, category: 'إلكترونيات', emoji: '🎧', desc: 'بلوتوث 5.3 وبطارية تدوم 30 ساعة.', stock: 20 },
    { id: 2, name: 'ساعة ذكية', price: 1900, category: 'إلكترونيات', emoji: '⌚', desc: 'تتبّع النوم والخطوات ومقاومة للماء.', stock: 12 },
    { id: 3, name: 'حقيبة ظهر', price: 420, category: 'أزياء', emoji: '🎒', desc: 'تتسع لابتوب 15 بوصة، قماش مقاوم للبلل.', stock: 30 },
    { id: 4, name: 'كوب حراري', price: 180, category: 'منزل', emoji: '☕', desc: 'يحفظ الحرارة 12 ساعة.', stock: 50 },
    { id: 5, name: 'مصباح مكتب', price: 310, category: 'منزل', emoji: '💡', desc: 'إضاءة قابلة للتعديل وشحن USB.', stock: 25 },
    { id: 6, name: 'حذاء رياضي', price: 1100, category: 'أزياء', emoji: '👟', desc: 'خفيف ومريح للجري اليومي.', stock: 18 }
  ],
  orders: []
};

let db;
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); }
catch { db = seed; save(); }
function save() { fs.writeFileSync(DB, JSON.stringify(db, null, 2)); }

const tokens = new Set();
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function admin(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!tokens.has(t)) return res.status(401).json({ error: 'غير مصرح' });
  next();
}

function clean(b) {
  const name = String(b.name || '').trim().slice(0, 100);
  const price = Number(b.price);
  if (!name || !(price >= 0)) return null;
  return {
    name, price,
    category: String(b.category || 'عام').trim().slice(0, 40),
    emoji: String(b.emoji || '📦').slice(0, 4),
    image: String(b.image || '').slice(0, 500),
    desc: String(b.desc || '').slice(0, 500),
    stock: Math.max(0, parseInt(b.stock) || 0)
  };
}

// ---- Auth ----
app.post('/api/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'كلمة المرور غلط' });
  const t = crypto.randomBytes(24).toString('hex');
  tokens.add(t);
  res.json({ token: t });
});

// ---- Products ----
app.get('/api/products', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const cat = req.query.category;
  res.json(db.products.filter(p =>
    (!q || (p.name + p.desc).toLowerCase().includes(q)) && (!cat || p.category === cat)));
});

app.get('/api/products/:id', (req, res) => {
  const p = db.products.find(x => x.id == req.params.id);
  p ? res.json(p) : res.status(404).json({ error: 'المنتج غير موجود' });
});

app.post('/api/products', admin, (req, res) => {
  const data = clean(req.body);
  if (!data) return res.status(400).json({ error: 'الاسم والسعر مطلوبين' });
  const p = { id: Date.now(), ...data };
  db.products.push(p); save();
  res.status(201).json(p);
});

app.put('/api/products/:id', admin, (req, res) => {
  const i = db.products.findIndex(x => x.id == req.params.id);
  const data = clean(req.body);
  if (i < 0) return res.status(404).json({ error: 'المنتج غير موجود' });
  if (!data) return res.status(400).json({ error: 'بيانات غير صحيحة' });
  db.products[i] = { id: db.products[i].id, ...data }; save();
  res.json(db.products[i]);
});

app.delete('/api/products/:id', admin, (req, res) => {
  db.products = db.products.filter(x => x.id != req.params.id); save();
  res.json({ ok: true });
});

// ---- Orders ----
app.post('/api/orders', (req, res) => {
  const { name, phone, address, items } = req.body;
  if (!name || !phone || !address || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'كمّل بيانات الطلب' });
  let total = 0;
  const lines = [];
  for (const it of items) {
    const p = db.products.find(x => x.id == it.id);
    const qty = parseInt(it.qty) || 0;
    if (!p || qty < 1) return res.status(400).json({ error: 'منتج غير صحيح في السلة' });
    if (p.stock < qty) return res.status(400).json({ error: `المتاح من "${p.name}" ${p.stock} فقط` });
    lines.push({ id: p.id, name: p.name, price: p.price, qty });
    total += p.price * qty;
  }
  lines.forEach(l => { db.products.find(x => x.id === l.id).stock -= l.qty; });
  const order = {
    id: Date.now(), date: new Date().toISOString(), total,
    name: String(name).slice(0, 80), phone: String(phone).slice(0, 20),
    address: String(address).slice(0, 300), items: lines
  };
  db.orders.push(order); save(); notify(order);
  res.status(201).json({ id: order.id, total });
});

app.get('/api/orders', admin, (req, res) => res.json(db.orders.slice().reverse()));

app.listen(PORT, () => console.log(`الموقع شغال على http://localhost:${PORT}`));
