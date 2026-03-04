const fs = require('fs');
const path = require('path');

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate())
  ].join('-') + '-' + [
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds())
  ].join('');
}

function stripBom(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/^\uFEFF/, '');
}

function readJson(filePath) {
  const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
  return JSON.parse(raw);
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

const fileArg = getArg('--file') || process.env.CACHE_VERSION_FILE || 'launcher/config.json';
const valueArg = getArg('--value') || process.env.CACHE_VERSION;
const filePath = path.resolve(fileArg);

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const data = readJson(filePath);
const nextValue = valueArg || formatTimestamp(new Date());

if (data.cache_version === nextValue) {
  console.log(`cache_version unchanged: ${nextValue}`);
  process.exit(0);
}

data.cache_version = nextValue;
writeJson(filePath, data);
console.log(`cache_version updated: ${nextValue}`);