// Run this once on your computer from the project folder.
// It imports data/products.json and uploads images from public/uploads to Supabase Storage.
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in this PowerShell window first.');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const bucket = 'product-images';
const productsFile = path.join(__dirname, 'data', 'products.json');
const uploadsDir = path.join(__dirname, 'public', 'uploads');

async function main() {
  if (!fs.existsSync(productsFile)) {
    throw new Error('data/products.json was not found. Keep your data folder in the project.');
  }
  const products = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
  const migrated = [];

  for (const p of products) {
    let imageUrl = p.image || '';
    if (p.image && p.image.startsWith('/uploads/')) {
      const filename = path.basename(p.image);
      const localFile = path.join(uploadsDir, filename);
      if (fs.existsSync(localFile)) {
        const buffer = fs.readFileSync(localFile);
        const ext = path.extname(filename).toLowerCase();
        const contentType = ext === '.png' ? 'image/png' :
          ext === '.webp' ? 'image/webp' :
          ext === '.gif' ? 'image/gif' : 'image/jpeg';
        const { error: uploadError } = await supabase.storage
          .from(bucket)
          .upload(filename, buffer, { contentType, upsert: true });
        if (uploadError) throw uploadError;
        imageUrl = supabase.storage.from(bucket).getPublicUrl(filename).data.publicUrl;
      } else {
        console.warn(`Image file missing, keeping old path: ${filename}`);
      }
    }

    migrated.push({
      id: Number(p.id),
      name: String(p.name || ''),
      category: String(p.category || ''),
      price: Number(p.price || 0),
      description: String(p.description || ''),
      image: imageUrl
    });
  }

  const { error } = await supabase.from('products').upsert(migrated, { onConflict: 'id' });
  if (error) throw error;
  console.log(`Success: imported ${migrated.length} products and uploaded available images.`);
}

main().catch(err => {
  console.error('Migration failed:', err.message || err);
  process.exit(1);
});
