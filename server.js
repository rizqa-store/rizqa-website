const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'product-images';

if (!ADMIN_PASSWORD || !SESSION_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set ADMIN_PASSWORD, SESSION_SECRET, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'rizqa.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only JPG, PNG, WEBP or GIF images are allowed.'))
});

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'Please sign in as admin.' });
}
function sendSupabaseError(res, error) {
  console.error(error);
  return res.status(500).json({ error: 'Database/storage request failed. Please try again.' });
}
function cleanVariants(value) {
  if (!Array.isArray(value)) return [];
  return value.map(v => ({
    name: String(v.name || '').trim().slice(0, 80),
    image: String(v.image || '').trim()
  })).filter(v => v.name);
}

app.get('/api/products', async (_req, res) => {
  const { data, error } = await supabase.from('products').select('*').order('id', { ascending: false });
  if (error) return sendSupabaseError(res, error);
  res.json((data || []).map(p => ({ ...p, variants: Array.isArray(p.variants) ? p.variants : [] })));
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  const validUser = username === ADMIN_USER;
  const validPass = typeof password === 'string' &&
    await bcrypt.compare(password, await bcrypt.hash(ADMIN_PASSWORD, 10));
  if (!validUser || !validPass) return res.status(401).json({ error: 'Incorrect username or password.' });
  req.session.admin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) =>
  req.session.destroy(() => res.json({ ok: true }))
);
app.get('/api/admin/session', (req, res) =>
  res.json({ loggedIn: !!(req.session && req.session.admin) })
);

app.post('/api/admin/upload', requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image first.' });
  const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const safeName = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(safeName, req.file.buffer, {
    contentType: req.file.mimetype, upsert: false
  });
  if (error) return sendSupabaseError(res, error);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(safeName);
  res.json({ image: data.publicUrl });
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const { name, category, price, description = '', image = '' } = req.body || {};
  if (!name || !category || !Number.isInteger(Number(price)) || Number(price) < 0)
    return res.status(400).json({ error: 'Product name, category and valid price are required.' });

  const { data: latest, error: readError } = await supabase.from('products').select('id').order('id', { ascending: false }).limit(1);
  if (readError) return sendSupabaseError(res, readError);
  const nextId = (latest && latest.length ? Number(latest[0].id) : 0) + 1;
  const product = {
    id: nextId, name: String(name).trim(), category: String(category).trim(),
    price: Number(price), description: String(description), image: String(image),
    variants: cleanVariants(req.body.variants)
  };
  const { data, error } = await supabase.from('products').insert(product).select().single();
  if (error) return sendSupabaseError(res, error);
  res.json(data);
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const { name, category, price, description = '', image = '' } = req.body || {};
  if (!name || !category || !Number.isInteger(Number(price)) || Number(price) < 0)
    return res.status(400).json({ error: 'Invalid product details.' });
  const update = {
    name: String(name).trim(), category: String(category).trim(), price: Number(price),
    description: String(description), image: String(image), variants: cleanVariants(req.body.variants)
  };
  const { data, error } = await supabase.from('products').update(update)
    .eq('id', Number(req.params.id)).select().maybeSingle();
  if (error) return sendSupabaseError(res, error);
  if (!data) return res.status(404).json({ error: 'Product not found.' });
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase.from('products').delete().eq('id', Number(req.params.id));
  if (error) return sendSupabaseError(res, error);
  res.json({ ok: true });
});

// Direct website checkout: price and product information are always verified from Supabase.
app.post('/api/orders', async (req, res) => {
  try {
    const { customerName, phone, address, items } = req.body || {};
    if (!customerName?.trim() || !phone?.trim() || !address?.trim())
      return res.status(400).json({ error: 'নাম, ফোন নম্বর ও ঠিকানা দিন।' });
    if (!Array.isArray(items) || !items.length || items.length > 50)
      return res.status(400).json({ error: 'আপনার Cart-এ কোনো পণ্য নেই।' });

    const ids = [...new Set(items.map(i => Number(i.productId)).filter(Number.isInteger))];
    const { data: products, error } = await supabase.from('products').select('*').in('id', ids);
    if (error) return sendSupabaseError(res, error);
    const byId = new Map((products || []).map(p => [Number(p.id), p]));
    const verifiedItems = [];
    let total = 0;

    for (const item of items) {
      const p = byId.get(Number(item.productId));
      const qty = Number(item.quantity);
      if (!p || !Number.isInteger(qty) || qty < 1 || qty > 99)
        return res.status(400).json({ error: 'কার্টের একটি পণ্যের তথ্য সঠিক নয়।' });
      const variants = Array.isArray(p.variants) ? p.variants : [];
      let selected = null;
      if (variants.length) {
        selected = variants.find(v => v.name === String(item.variantName || ''));
        if (!selected) return res.status(400).json({ error: `${p.name}: সঠিক Color নির্বাচন করুন।` });
      }
      const unitPrice = Number(p.price);
      total += unitPrice * qty;
      verifiedItems.push({
        productId: p.id, name: p.name, color: selected?.name || '',
        image: selected?.image || p.image || '', price: unitPrice, quantity: qty
      });
    }

    const orderNumber = `RZ${Date.now()}`;
    const { data, error: insertError } = await supabase.from('orders').insert({
      order_number: orderNumber,
      customer_name: String(customerName).trim(),
      phone: String(phone).trim(),
      address: String(address).trim(),
      items: verifiedItems,
      total_amount: total,
      status: 'Pending'
    }).select('id, order_number, status, total_amount, created_at').single();
    if (insertError) return sendSupabaseError(res, insertError);
    res.status(201).json({ ok: true, order: data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'অর্ডার সম্পন্ন করা যায়নি। আবার চেষ্টা করুন।' });
  }
});

app.get('/api/admin/orders', requireAdmin, async (_req, res) => {
  const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
  if (error) return sendSupabaseError(res, error);
  res.json(data || []);
});

app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const allowed = ['Pending', 'Confirmed', 'Shipped', 'Delivered', 'Cancelled'];
  const status = String(req.body?.status || '');
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid order status.' });
  const { data, error } = await supabase.from('orders').update({ status })
    .eq('id', Number(req.params.id)).select().maybeSingle();
  if (error) return sendSupabaseError(res, error);
  if (!data) return res.status(404).json({ error: 'Order not found.' });
  res.json({ ok: true });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => res.status(400).json({ error: err.message || 'Request failed.' }));
app.listen(PORT, () => console.log(`RIZQA is running on port ${PORT}`));
