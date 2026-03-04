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

function parseBoolean(value, defaultValue = false) {
  if (value === null || value === undefined) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function stripBom(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/^\uFEFF/, '');
}

function readJsonFile(filePath) {
  const content = stripBom(fs.readFileSync(filePath, 'utf8'));
  return JSON.parse(content);
}

function libraryPathFromCoordinate(name) {
  if (!name || typeof name !== 'string') return null;

  const [coordinate, extensionRaw] = name.split('@');
  const extension = extensionRaw && extensionRaw.trim() ? extensionRaw.trim() : 'jar';
  const parts = coordinate.split(':');
  if (parts.length < 3) return null;

  const group = parts[0];
  const artifact = parts[1];
  const version = parts[2];
  const classifier = parts[3] || null;

  if (!group || !artifact || !version) return null;

  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
  return `libraries/${group.replace(/\./g, '/')}/${artifact}/${version}/${fileName}`;
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

function collectVersionJsonFiles(dirPath, output = []) {
  if (!fs.existsSync(dirPath)) return output;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectVersionJsonFiles(full, output);
      continue;
    }
    if (entry.name.toLowerCase().endsWith('.json')) {
      output.push(full);
    }
  }
  return output;
}

function collectReferencedLibraries(instanceDir) {
  const referenced = new Set();
  const versionsDir = path.join(instanceDir, 'versions');
  const versionJsonFiles = collectVersionJsonFiles(versionsDir);

  for (const versionJsonFile of versionJsonFiles) {
    let parsed;
    try {
      parsed = readJsonFile(versionJsonFile);
    } catch (error) {
      console.warn(
        `Skipping invalid version json (${versionJsonFile}): ${error.message}`
      );
      continue;
    }

    const libraries = Array.isArray(parsed?.libraries) ? parsed.libraries : [];
    for (const library of libraries) {
      const coordinatePath = libraryPathFromCoordinate(library?.name);
      if (coordinatePath) {
        referenced.add(coordinatePath.replace(/\\/g, '/'));
      }

      const artifactPath = library?.downloads?.artifact?.path;
      if (artifactPath && typeof artifactPath === 'string') {
        referenced.add(`libraries/${artifactPath.replace(/\\/g, '/')}`);
      }

      const classifiers = library?.downloads?.classifiers;
      if (classifiers && typeof classifiers === 'object') {
        for (const classifier of Object.values(classifiers)) {
          if (classifier?.path && typeof classifier.path === 'string') {
            referenced.add(`libraries/${classifier.path.replace(/\\/g, '/')}`);
          }
        }
      }
    }
  }

  return referenced;
}

async function walk(dir, root, out, includeSet, libraryReferenceSet = null) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out, includeSet, libraryReferenceSet);
      continue;
    }

    if (entry.name === 'manifest.json') continue;

    const rel = path.relative(root, full).replace(/\\/g, '/');
    const firstSegment = rel.split('/')[0];

    if (includeSet && !includeSet.has(firstSegment)) continue;

    if (
      libraryReferenceSet &&
      firstSegment === 'libraries' &&
      !libraryReferenceSet.has(rel)
    ) {
      continue;
    }

    const stat = fs.statSync(full);
    const hash = await sha1File(full);
    out.push({
      path: rel,
      hash,
      size: stat.size
    });
  }
}

async function generateForInstance(instanceDir, baseUrl, includeSet, pruneLibraries) {
  const instanceName = path.basename(instanceDir);
  let libraryReferenceSet = null;

  if (pruneLibraries) {
    const referenced = collectReferencedLibraries(instanceDir);
    if (referenced.size > 0) {
      libraryReferenceSet = referenced;
      console.log(
        `[${instanceName}] Pruning libraries to ${referenced.size} referenced entries`
      );
    } else {
      console.log(
        `[${instanceName}] No version library references found, keeping all libraries`
      );
    }
  }

  const files = [];
  await walk(instanceDir, instanceDir, files, includeSet, libraryReferenceSet);

  const instanceBase = `${baseUrl.replace(/\/$/, '')}/${instanceName}`;
  const manifest = files.map((file) => ({
    path: file.path,
    hash: file.hash,
    size: file.size,
    url: `${instanceBase}/${file.path}`
  }));

  const outputPath = path.join(instanceDir, 'manifest.json');
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${manifest.length} entries -> ${instanceName}/manifest.json`);
}

async function main() {
  const root = getArg('--root') || process.env.MANIFEST_ROOT || 'files';
  const baseUrl = getArg('--base-url') || process.env.MANIFEST_BASE_URL;
  const includeValue =
    getArg('--include') ||
    process.env.MANIFEST_INCLUDE ||
    'mods,config,resourcepacks,versions,libraries,shaderpacks';
  const includeSet = parseInclude(includeValue);
  const pruneLibraries = parseBoolean(
    getArg('--prune-libraries') || process.env.MANIFEST_PRUNE_LIBRARIES,
    false
  );

  if (!baseUrl) {
    console.error('Missing --base-url (or MANIFEST_BASE_URL).');
    process.exit(1);
  }

  const rootPath = path.resolve(root);
  if (!fs.existsSync(rootPath)) {
    console.error(`Root folder not found: ${rootPath}`);
    process.exit(1);
  }

  const entries = fs
    .readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  if (!entries.length) {
    console.warn(`No instance folders found in ${rootPath}`);
    return;
  }

  for (const entry of entries) {
    await generateForInstance(
      path.join(rootPath, entry.name),
      baseUrl,
      includeSet,
      pruneLibraries
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
