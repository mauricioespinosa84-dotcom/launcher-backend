const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function parseInclude(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') return null;
  const set = new Set(
    trimmed
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
  return set.size ? set : null;
}

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function walk(dir, root, out, includeSet) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out, includeSet);
      continue;
    }
    if (entry.name === 'manifest.json') continue;
    const rel = path.relative(root, full).replace(/\\/g, '/');
    const firstSegment = rel.split('/')[0];
    if (includeSet && !includeSet.has(firstSegment)) continue;

    const stat = fs.statSync(full);
    const hash = await sha1File(full);
    out.push({
      path: rel,
      hash,
      size: stat.size
    });
  }
}

async function generateForInstance(instanceDir, baseUrl, includeSet) {
  const files = [];
  await walk(instanceDir, instanceDir, files, includeSet);

  const instanceName = path.basename(instanceDir);
  const instanceBase = `${baseUrl.replace(/\/$/, '')}/${instanceName}`;

  const manifest = files.map((file) => ({
    path: file.path,
    hash: file.hash,
    size: file.size,
    url: `${instanceBase}/${file.path}`
  }));

  const outputPath = path.join(instanceDir, 'manifest.json');
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${manifest.length} entries -> ${instanceName}/manifest.json`);
}

async function main() {
  const root = getArg('--root') || process.env.MANIFEST_ROOT || 'files';
  const baseUrl = getArg('--base-url') || process.env.MANIFEST_BASE_URL;
  const includeValue = getArg('--include') || process.env.MANIFEST_INCLUDE || 'mods,config,resourcepacks,versions,libraries,shaderpacks';
  const includeSet = parseInclude(includeValue);

  if (!baseUrl) {
    console.error('Missing --base-url (or MANIFEST_BASE_URL).');
    process.exit(1);
  }

  const rootPath = path.resolve(root);
  if (!fs.existsSync(rootPath)) {
    console.error(`Root folder not found: ${rootPath}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  if (!entries.length) {
    console.warn(`No instance folders found in ${rootPath}`);
    return;
  }

  for (const entry of entries) {
    await generateForInstance(path.join(rootPath, entry.name), baseUrl, includeSet);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
