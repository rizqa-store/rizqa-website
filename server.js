const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error('Set ADMIN_PASSWORD and SESSION_SECRET before starting.');
  process.exit(1);
}

const dataDir = path.join(__dirname, 'data');
const uploadDir = path.join(__dirname, 'public', 'uploads');
const dbFile = path.join(dataDir, 'products.json');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

function readProducts() {
  try { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function writeProducts(products) {
  const temp = dbFile + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(products, null, 2), 'utf8');
  fs.renameSync(temp, dbFile);
}
function nextId(products) { return products.reduce((m, p) => Math.max(m, p.id), 0) + 1; }

app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'rizqa.sid', secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage, limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Only JPG, PNG, WEBP or GIF images are allowed.'))
});
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'Please sign in as admin.' });
}

app.get('/api/products', (_req, res) => res.json(readProducts()));
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  const validUser = username === ADMIN_USER;
  const validPass = typeof password === 'string' && await bcrypt.compare(password, await bcrypt.hash(ADMIN_PASSWORD, 10));
  if (!validUser || !validPass) return res.status(401).json({ error: 'Incorrect username or password.' });
  req.session.admin = true; res.json({ ok: true });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/admin/session', (req, res) => res.json({ loggedIn: !!(req.session && req.session.admin) }));
app.post('/api/admin/upload', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image first.' });
  res.json({ image: `/uploads/${req.file.filename}` });
});
app.post('/api/admin/products', requireAdmin, (req, res) => {
  const { name, category, price, description = '', image = '' } = req.body || {};
  if (!name || !category || !Number.isInteger(Number(price)) || Number(price) < 0) return res.status(400).json({ error: 'Product name, category and valid price are required.' });
  const products = readProducts();
  const product = { id: nextId(products), name: String(name).trim(), category: String(category).trim(), price: Number(price), description: String(description), image: String(image) };
  products.unshift(product); writeProducts(products); res.json(product);
});
app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  const { name, category, price, description = '', image = '' } = req.body || {};
  if (!name || !category || !Number.isInteger(Number(price)) || Number(price) < 0) return res.status(400).json({ error: 'Invalid product details.' });
  const products = readProducts(), id = Number(req.params.id), index = products.findIndex(p => p.id === id);
  if (index < 0) return res.status(404).json({ error: 'Product not found.' });
  products[index] = { ...products[index], name: String(name).trim(), category: String(category).trim(), price: Number(price), description: String(description), image: String(image) };
  writeProducts(products); res.json({ ok: true });
});
app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  writeProducts(readProducts().filter(p => p.id !== Number(req.params.id))); res.json({ ok: true });
});
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => res.status(400).json({ error: err.message || 'Request failed.' }));
app.listen(PORT, () => console.log(`RIZQA is running on port ${PORT}`));
