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

app.get('/api/products', async (_req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('id', { ascending: false });
  if (error) return sendSupabaseError(res, error);
  res.json(data || []);
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  const validUser = username === ADMIN_USER;
  const validPass = typeof password === 'string' &&
    await bcrypt.compare(password, await bcrypt.hash(ADMIN_PASSWORD, 10));
  if (!validUser || !validPass) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
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
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(safeName, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });

  if (error) return sendSupabaseError(res, error);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(safeName);
  res.json({ image: data.publicUrl });
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const { name, category, price, description = '', image = '' } = req.body || {};
  if (!name || !category || !Number.isInteger(Number(price)) || Number(price) < 0) {
    return res.status(400).json({ error: 'Product name, category and valid price are required.' });
  }

  const { data: latest, error: readError } = await supabase
    .from('products').select('id').order('id', { ascending: false }).limit(1);
  if (readError) return sendSupabaseError(res, readError);

  const nextId = (latest && latest.length ? Number(latest[0].id) : 0) + 1;
  const product = {
    id: nextId,
    name: String(name).trim(),
    category: String(category).trim(),
    price: Number(price),
    description: String(description),
    image: String(image)
  };

  const { data, error } = await supabase.from('products').insert(product).select().single();
  if (error) return sendSupabaseError(res, error);
  res.json(data);
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const { name, category, price, description = '', image = '' } = req.body || {};
  if (!name || !category || !Number.isInteger(Number(price)) || Number(price) < 0) {
    return res.status(400).json({ error: 'Invalid product details.' });
  }

  const update = {
    name: String(name).trim(),
    category: String(category).trim(),
    price: Number(price),
    description: String(description),
    image: String(image)
  };
  const { data, error } = await supabase
    .from('products').update(update).eq('id', Number(req.params.id)).select().maybeSingle();
  if (error) return sendSupabaseError(res, error);
  if (!data) return res.status(404).json({ error: 'Product not found.' });
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase.from('products').delete().eq('id', Number(req.params.id));
  if (error) return sendSupabaseError(res, error);
  res.json({ ok: true });
});

app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.use((err, _req, res, _next) =>
  res.status(400).json({ error: err.message || 'Request failed.' })
);

app.listen(PORT, () => console.log(`RIZQA is running on port ${PORT}`));
