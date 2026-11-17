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
function cleanOfferPrice(value, regularPrice) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const offer = Number(value);
  if (!Number.isInteger(offer) || offer < 1 || offer >= Number(regularPrice)) return NaN;
  return offer;
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

// Public customer reviews are held for admin approval before appearing publicly.
app.get('/api/reviews', async (req, res) => {
  const productId = Number(req.query.productId);
  if (!Number.isInteger(productId) || productId < 1) return res.status(400).json({ error: 'Invalid product.' });
  const { data, error } = await supabase.from('reviews').select('id, customer_name, rating, comment, created_at')
    .eq('product_id', productId).eq('status', 'Approved').order('created_at', { ascending: false });
  if (error) return sendSupabaseError(res, error);
  res.json(data || []);
});

app.post('/api/reviews', async (req, res) => {
  const productId = Number(req.body?.productId);
  const customerName = String(req.body?.customerName || '').trim().slice(0, 80);
  const comment = String(req.body?.comment || '').trim().slice(0, 1200);
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(productId) || productId < 1 || !customerName || !comment || !Number.isInteger(rating) || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'নাম, ১–৫ Rating এবং Review লিখুন।' });
  const { data: product, error: productError } = await supabase.from('products').select('id, name').eq('id', productId).maybeSingle();
  if (productError) return sendSupabaseError(res, productError);
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  const { data, error } = await supabase.from('reviews').insert({
    product_id: product.id, product_name: product.name, customer_name: customerName,
    rating, comment, status: 'Pending'
  }).select('id, status').single();
  if (error) return sendSupabaseError(res, error);
  res.status(201).json({ ok: true, review: data });
});

app.get('/api/admin/reviews', requireAdmin, async (_req, res) => {
  const { data, error } = await supabase.from('reviews').select('*').order('created_at', { ascending: false });
  if (error) return sendSupabaseError(res, error);
  res.json(data || []);
});

app.patch('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  const status = String(req.body?.status || '');
  if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ error: 'Invalid review status.' });
  const { data, error } = await supabase.from('reviews').update({ status })
    .eq('id', Number(req.params.id)).select('id, status').maybeSingle();
  if (error) return sendSupabaseError(res, error);
  if (!data) return res.status(404).json({ error: 'Review not found.' });
  res.json({ ok: true });
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
  const stockQuantity = Number(req.body?.stockQuantity);
  const offerPrice = cleanOfferPrice(req.body?.offerPrice, price);
  if (!name || !category || !Number.isInteger(Number(price)) || Number(price) < 0 || !Number.isInteger(stockQuantity) || stockQuantity < 0 || Number.isNaN(offerPrice))
    return res.status(400).json({ error: 'Product name, category, valid regular price and a lower offer price are required.' });

  const { data: latest, error: readError } = await supabase.from('products').select('id').order('id', { ascending: false }).limit(1);
  if (readError) return sendSupabaseError(res, readError);
  const nextId = (latest && latest.length ? Number(latest[0].id) : 0) + 1;
  const product = {
    id: nextId, name: String(name).trim(), category: String(category).trim(),
    price: Number(price), offer_price: offerPrice, description: String(description), image: String(image),
    variants: cleanVariants(req.body.variants), stock_quantity: stockQuantity
  };
  const { data, error } = await supabase.from('products').insert(product).select().single();
  if (error) return sendSupabaseError(res, error);
  res.json(data);
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const { name, category, price, description = '', image = '' } = req.body || {};
  const stockQuantity = Number(req.body?.stockQuantity);
  const offerPrice = cleanOfferPrice(req.body?.offerPrice, price);
  if (!name || !category || !Number.isInteger(Number(price)) || Number(price) < 0 || !Number.isInteger(stockQuantity) || stockQuantity < 0 || Number.isNaN(offerPrice))
    return res.status(400).json({ error: 'Invalid product details or offer price. Offer must be lower than regular price.' });
  const update = {
    name: String(name).trim(), category: String(category).trim(), price: Number(price), offer_price: offerPrice,
    description: String(description), image: String(image), variants: cleanVariants(req.body.variants), stock_quantity: stockQuantity
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
    const { customerName, phone, district, address, items } = req.body || {};
    const deliveryLocations = ['inside_kushtia', 'inside_naogaon', 'outside']
    if (!customerName?.trim() || !phone?.trim() || !address?.trim() || !deliveryLocations.includes(String(district || '').trim()))
      return res.status(400).json({ error: 'নাম, ফোন নম্বর, Delivery Location ও সম্পূর্ণ ঠিকানা দিন।' });
    const deliveryCharge = district === 'inside_kushtia' ? 90 : district === 'inside_naogaon' ? 100 : 130;
    if (!Array.isArray(items) || !items.length || items.length > 50)
      return res.status(400).json({ error: 'আপনার Cart-এ কোনো পণ্য নেই।' });

    const ids = [...new Set(items.map(i => Number(i.productId)).filter(Number.isInteger))];
    const { data: products, error } = await supabase.from('products').select('*').in('id', ids);
    if (error) return sendSupabaseError(res, error);
    const byId = new Map((products || []).map(p => [Number(p.id), p]));
    const verifiedItems = [];
    const reserved = [];
    let total = 0;

    for (const item of items) {
      const p = byId.get(Number(item.productId));
      const qty = Number(item.quantity);
      if (!p || !Number.isInteger(qty) || qty < 1 || qty > 99)
        return res.status(400).json({ error: 'কার্টের একটি পণ্যের তথ্য সঠিক নয়।' });
      const availableStock = Number(p.stock_quantity ?? 999);
      if (availableStock < qty) return res.status(400).json({ error: `${p.name}: পর্যাপ্ত Stock নেই। Available: ${availableStock} পিস।` });
      const variants = Array.isArray(p.variants) ? p.variants : [];
      let selected = null;
      if (variants.length) {
        selected = variants.find(v => v.name === String(item.variantName || ''));
        if (!selected) return res.status(400).json({ error: `${p.name}: সঠিক Color নির্বাচন করুন।` });
      }
      const regularPrice = Number(p.price);
      const unitPrice = p.offer_price !== null && p.offer_price !== undefined ? Number(p.offer_price) : regularPrice;
      total += unitPrice * qty;
      verifiedItems.push({
        productId: p.id, name: p.name, color: selected?.name || '',
        image: selected?.image || p.image || '', price: unitPrice,
        regularPrice, quantity: qty
      });
    }

    // Reserve stock with a conditional update so simultaneous orders cannot oversell.
    const stockNeeds = new Map();
    for (const item of verifiedItems) stockNeeds.set(item.productId, (stockNeeds.get(item.productId) || 0) + item.quantity);
    for (const [productId, needed] of stockNeeds) {
      const p = byId.get(Number(productId));
      const currentStock = Number(p.stock_quantity ?? 999);
      const { data: updated, error: stockError } = await supabase.from('products')
        .update({ stock_quantity: currentStock - needed })
        .eq('id', productId).eq('stock_quantity', currentStock).select('id').maybeSingle();
      if (stockError || !updated) {
        for (const r of reserved) await supabase.from('products').update({ stock_quantity: r.stock }).eq('id', r.id);
        return res.status(409).json({ error: `${p.name}: Stock পরিবর্তিত হয়েছে বা পর্যাপ্ত নেই। আবার চেষ্টা করুন।` });
      }
      reserved.push({ id: productId, stock: currentStock });
    }
    total += deliveryCharge;
    const orderNumber = `RZ${Date.now()}`;
    const locationLabel = district === 'inside_kushtia' ? 'Inside Kushtia' : district === 'inside_naogaon' ? 'Inside Naogaon' : 'Outside Kushtia & Naogaon (All Bangladesh)';
    const fullAddress = `Delivery Location: ${locationLabel}\n${String(address).trim()}`;
    const { data, error: insertError } = await supabase.from('orders').insert({
      order_number: orderNumber,
      customer_name: String(customerName).trim(),
      phone: String(phone).trim(),
      address: fullAddress,
      items: verifiedItems,
      total_amount: total,
      status: 'Pending'
    }).select('id, order_number, status, total_amount, created_at').single();
    if (insertError) {
      for (const r of reserved) await supabase.from('products').update({ stock_quantity: r.stock }).eq('id', r.id);
      return sendSupabaseError(res, insertError);
    }
    res.status(201).json({ ok: true, order: { ...data, delivery_charge: deliveryCharge } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'অর্ডার সম্পন্ন করা যায়নি। আবার চেষ্টা করুন।' });
  }
});

// Customers can check only their own order using order number + phone.
app.post('/api/orders/track', async (req, res) => {
  try {
    const orderNumber = String(req.body?.orderNumber || '').trim();
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (!orderNumber || !phone) return res.status(400).json({ error: 'Order Number ও ফোন নম্বর দিন।' });

    const { data: order, error } = await supabase.from('orders')
      .select('order_number, phone, status, total_amount, items, created_at')
      .eq('order_number', orderNumber).maybeSingle();
    if (error) return sendSupabaseError(res, error);

    const savedPhone = String(order?.phone || '').replace(/\D/g, '');
    if (!order || !savedPhone || savedPhone !== phone) {
      return res.status(404).json({ error: 'এই Order Number ও ফোন নম্বরের মিল পাওয়া যায়নি।' });
    }
    res.json({
      order: {
        order_number: order.order_number,
        status: order.status,
        total_amount: order.total_amount,
        items: order.items,
        created_at: order.created_at
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'অর্ডারের তথ্য পাওয়া যায়নি। আবার চেষ্টা করুন।' });
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

// Permanently delete an order. Admin session is required.
app.delete('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid order ID.' });
  const { data, error } = await supabase.from('orders').delete().eq('id', id).select('id').maybeSingle();
  if (error) return sendSupabaseError(res, error);
  if (!data) return res.status(404).json({ error: 'Order not found.' });
  res.json({ ok: true });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => res.status(400).json({ error: err.message || 'Request failed.' }));
app.listen(PORT, () => console.log(`RIZQA is running on port ${PORT}`));
