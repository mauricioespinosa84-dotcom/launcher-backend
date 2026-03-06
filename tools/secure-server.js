const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function stripBom(text) {
  return typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';
}

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    if (fallback !== null) return fallback;
    throw new Error(`Missing file: ${filePath}`);
  }

  const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
  if (!raw.trim()) {
    return fallback !== null ? fallback : {};
  }

  return JSON.parse(raw);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', reject);
  });
}

function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  let normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  return Buffer.from(normalized, 'base64');
}

function base64UrlToBase64(value) {
  return base64UrlDecode(value).toString('base64');
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function normalizeUsername(value) {
  return String(value || '').trim();
}

function buildOfflineUuid(username) {
  return crypto.createHash('sha1').update(`offline:${username}`).digest('hex').slice(0, 32);
}

function normalizeRelative(relativePath) {
  return String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .join('/');
}

function encodePathSegments(relativePath) {
  return normalizeRelative(relativePath)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function safeResolve(rootDir, relativePath) {
  const normalizedRoot = path.resolve(rootDir);
  const resolved = path.resolve(normalizedRoot, relativePath);
  const prefix = `${normalizedRoot}${path.sep}`;

  if (resolved !== normalizedRoot && !resolved.startsWith(prefix)) {
    throw new Error('Unsafe path access denied.');
  }

  return resolved;
}

function manifestRelativeFromInstance(instance) {
  try {
    const parsed = new URL(String(instance?.url || ''));
    const marker = parsed.pathname.toLowerCase().indexOf('/files/');
    if (marker !== -1) {
      return normalizeRelative(parsed.pathname.slice(marker + 1));
    }
  } catch (_) {
    // ignore invalid URL and fall back to loader path
  }

  return normalizeRelative(`files/${instance?.loader?.loader_type || 'fabric'}/manifest.json`);
}

function instanceRootDir(rootDir, instance) {
  const manifestPath = safeResolve(rootDir, manifestRelativeFromInstance(instance));
  return path.dirname(manifestPath);
}

function instanceVisible(instance, isStaff) {
  if (isStaff) return true;
  return !instance?.staffOnly && !instance?.hidden;
}

function filterInstances(instances, isStaff) {
  const filtered = {};
  for (const [key, value] of Object.entries(instances || {})) {
    if (instanceVisible(value, isStaff)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function sanitizeLauncherConfig(config, isStaff) {
  return {
    ...config,
    staff_users: [],
    cache_version: isStaff ? config?.cache_version || null : null
  };
}

function bearerTokenFromRequest(req) {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  return header.slice(7).trim() || null;
}

function signTokenPayload(secret, encodedPayload) {
  return base64UrlEncode(
    crypto.createHmac('sha256', secret).update(encodedPayload).digest()
  );
}

function createSessionToken(secret, payload) {
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signature = signTokenPayload(secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(secret, token) {
  if (!token || !token.includes('.')) {
    return null;
  }

  const [encodedPayload, encodedSignature] = token.split('.', 2);
  const expected = signTokenPayload(secret, encodedPayload);
  const left = Buffer.from(encodedSignature);
  const right = Buffer.from(expected);

  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
    if (!payload?.exp || Number(payload.exp) <= nowUnix()) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

function canonicalManifestBuffer(payload) {
  const entries = Array.isArray(payload.entries)
    ? payload.entries.map((entry) => ({
        path: entry.path,
        hash: entry.hash,
        size: entry.size,
        url: entry.url
      }))
    : [];

  return Buffer.from(
    JSON.stringify({
      instanceKey: payload.instanceKey,
      generatedAt: payload.generatedAt,
      expiresAt: payload.expiresAt,
      entries
    })
  );
}

function createSigningMaterial() {
  const privatePem = process.env.LAUNCHER_MANIFEST_PRIVATE_KEY_PEM;
  const publicPem = process.env.LAUNCHER_MANIFEST_PUBLIC_KEY_PEM;
  let privateKey;
  let publicKey;
  let persistent = true;

  if (privatePem && String(privatePem).trim()) {
    privateKey = crypto.createPrivateKey(privatePem);
    publicKey = publicPem && String(publicPem).trim()
      ? crypto.createPublicKey(publicPem)
      : crypto.createPublicKey(privateKey);
  } else {
    ({ privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'));
    persistent = false;
  }

  const jwk = publicKey.export({ format: 'jwk' });
  return {
    privateKey,
    publicKey,
    publicKeyBase64: base64UrlToBase64(jwk.x),
    persistent
  };
}

function contentTypeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    case '.txt':
    case '.cfg':
    case '.log': return 'text/plain; charset=utf-8';
    case '.jar': return 'application/java-archive';
    case '.zip': return 'application/zip';
    default: return 'application/octet-stream';
  }
}

function streamFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendError(res, 404, 'File not found.');
    return;
  }

  const stream = fs.createReadStream(filePath);
  res.writeHead(200, {
    'Content-Type': contentTypeForFile(filePath),
    'Content-Length': fs.statSync(filePath).size,
    'Cache-Control': 'no-store'
  });
  stream.pipe(res);
  stream.on('error', () => {
    if (!res.headersSent) {
      sendError(res, 500, 'File stream failed.');
    } else {
      res.destroy();
    }
  });
}

function getPublicBaseUrl(req, state) {
  if (state.publicBaseUrl) {
    return state.publicBaseUrl.replace(/\/$/, '');
  }

  const host = req.headers.host || `${state.host}:${state.port}`;
  return `${state.protocol}://${host}`;
}

function loadLauncherConfig(state) {
  return readJsonFile(path.join(state.rootDir, 'launcher', 'config.json'), {});
}

function loadInstances(state) {
  return readJsonFile(path.join(state.rootDir, 'launcher', 'instances.json'), {});
}

function loadNews(state) {
  return readJsonFile(path.join(state.rootDir, 'launcher', 'news.json'), []);
}

function getInstance(state, instanceKey) {
  const instances = loadInstances(state);
  return {
    instances,
    instance: instances?.[instanceKey] || null
  };
}

function parseSession(req, state, required = false) {
  const token = bearerTokenFromRequest(req);
  if (!token) {
    if (required) {
      throw { statusCode: 401, message: 'Missing backend session token.' };
    }
    return null;
  }

  const payload = verifySessionToken(state.sessionSecret, token);
  if (!payload) {
    throw { statusCode: 401, message: 'Invalid or expired backend session token.' };
  }

  return payload;
}

function sessionCanAccessInstance(session, instance) {
  if (!instance?.staffOnly) {
    return true;
  }

  return session?.role === 'staff';
}

function buildBootstrapPayload(req, state, session) {
  const launcherConfig = loadLauncherConfig(state);
  const isStaff = session?.role === 'staff';
  const news = launcherConfig.news_enabled ? loadNews(state) : [];
  const instances = filterInstances(loadInstances(state), isStaff);

  return {
    launcherConfig: sanitizeLauncherConfig(launcherConfig, isStaff),
    instances,
    news,
    isStaff,
    manifestPublicKey: state.signing.publicKeyBase64,
    secureMode: true
  };
}

function verifyMinecraftProfile(accessToken) {
  return new Promise((resolve) => {
    const request = https.request(
      'https://api.minecraftservices.com/minecraft/profile',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          if (response.statusCode !== 200) {
            resolve(null);
            return;
          }

          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(parsed);
          } catch (_) {
            resolve(null);
          }
        });
      }
    );

    request.on('error', () => resolve(null));
    request.end();
  });
}

async function issueSession(state, body) {
  const kind = String(body?.kind || 'offline').trim().toLowerCase();
  let username = normalizeUsername(body?.username) || 'Player';
  let uuid = String(body?.uuid || '').trim();
  let verified = false;

  if (kind === 'microsoft' && typeof body?.accessToken === 'string' && body.accessToken.trim()) {
    const profile = await verifyMinecraftProfile(body.accessToken.trim());
    if (profile?.name && profile?.id) {
      username = String(profile.name).trim();
      uuid = String(profile.id).trim();
      verified = true;
    }
  }

  if (!uuid) {
    uuid = buildOfflineUuid(username);
  }

  let isStaff = verified && state.staffUsers.has(username.toLowerCase());
  if (!isStaff && state.trustOfflineStaff && !verified) {
    isStaff = state.staffUsers.has(username.toLowerCase());
  }

  const expiresAt = nowUnix() + state.sessionTtlSeconds;
  const token = createSessionToken(state.sessionSecret, {
    sub: uuid,
    username,
    uuid,
    role: isStaff ? 'staff' : 'public',
    kind,
    verified,
    exp: expiresAt
  });

  return {
    token,
    expiresAt,
    isStaff,
    username,
    uuid
  };
}

function buildManifestResponse(req, state, instanceKey, manifestEntries) {
  const expiresAt = nowUnix() + state.manifestTtlSeconds;
  const payload = {
    instanceKey,
    generatedAt: new Date().toISOString(),
    expiresAt,
    entries: manifestEntries.map((entry) => ({
      path: normalizeRelative(entry.path),
      hash: String(entry.hash || ''),
      size: Number(entry.size || 0),
      url: `${getPublicBaseUrl(req, state)}/api/files/${encodeURIComponent(instanceKey)}/${encodePathSegments(entry.path)}`
    }))
  };

  const signature = crypto
    .sign(null, canonicalManifestBuffer(payload), state.signing.privateKey)
    .toString('base64');

  return {
    ...payload,
    signature
  };
}

function handleManifest(req, res, state, session, instanceKey) {
  const { instance } = getInstance(state, instanceKey);
  if (!instance || !instanceVisible(instance, session?.role === 'staff')) {
    sendError(res, 404, 'Instance not found.');
    return;
  }

  if (!sessionCanAccessInstance(session, instance)) {
    sendError(res, 403, 'This instance is restricted to staff.');
    return;
  }

  const manifestPath = safeResolve(state.rootDir, manifestRelativeFromInstance(instance));
  const manifestEntries = readJsonFile(manifestPath, []);
  sendJson(res, 200, buildManifestResponse(req, state, instanceKey, manifestEntries));
}

function handleProtectedFile(res, state, session, instanceKey, filePath) {
  const { instance } = getInstance(state, instanceKey);
  if (!instance || !instanceVisible(instance, session?.role === 'staff')) {
    sendError(res, 404, 'Instance not found.');
    return;
  }

  if (!sessionCanAccessInstance(session, instance)) {
    sendError(res, 403, 'This instance is restricted to staff.');
    return;
  }

  const rootDir = instanceRootDir(state.rootDir, instance);
  const safePath = safeResolve(rootDir, normalizeRelative(filePath));
  streamFile(res, safePath);
}

function handlePublicLauncherAsset(res, state, pathname) {
  const safePath = safeResolve(state.rootDir, normalizeRelative(pathname));
  streamFile(res, safePath);
}

function createState() {
  const rootDir = path.resolve(getArg('--root', process.cwd()));
  const host = getArg('--host', process.env.LAUNCHER_SECURE_HOST || '127.0.0.1');
  const port = Number(getArg('--port', process.env.LAUNCHER_SECURE_PORT || 8787));
  const protocol = parseBoolean(process.env.LAUNCHER_SECURE_HTTPS, false) ? 'https' : 'http';
  const publicBaseUrl = process.env.LAUNCHER_PUBLIC_BASE_URL || null;
  const sessionSecret =
    process.env.LAUNCHER_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  const sessionTtlSeconds = Number(process.env.LAUNCHER_SESSION_TTL_SECONDS || 6 * 60 * 60);
  const manifestTtlSeconds = Number(process.env.LAUNCHER_MANIFEST_TTL_SECONDS || 10 * 60);
  const signing = createSigningMaterial();
  const launcherConfig = loadLauncherConfig({ rootDir });
  const staffUsers = new Set(
    Array.isArray(launcherConfig?.staff_users)
      ? launcherConfig.staff_users.map((name) => String(name).trim().toLowerCase()).filter(Boolean)
      : []
  );

  return {
    rootDir,
    host,
    port,
    protocol,
    publicBaseUrl,
    sessionSecret,
    sessionTtlSeconds: Number.isFinite(sessionTtlSeconds) ? sessionTtlSeconds : 21600,
    manifestTtlSeconds: Number.isFinite(manifestTtlSeconds) ? manifestTtlSeconds : 600,
    signing,
    staffUsers,
    trustOfflineStaff: parseBoolean(process.env.LAUNCHER_TRUST_OFFLINE_STAFF, false)
  };
}

async function routeRequest(req, res, state) {
  const url = new URL(req.url, `${state.protocol}://${req.headers.host || `${state.host}:${state.port}`}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, {
      secureMode: true,
      manifestPublicKey: state.signing.publicKeyBase64,
      sessionTtlSeconds: state.sessionTtlSeconds,
      manifestTtlSeconds: state.manifestTtlSeconds
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/session') {
    const raw = await readBody(req);
    const body = raw.trim() ? JSON.parse(raw) : {};
    const session = await issueSession(state, body);
    sendJson(res, 200, session);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    const session = parseSession(req, state, false);
    sendJson(res, 200, buildBootstrapPayload(req, state, session));
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/manifest/')) {
    const session = parseSession(req, state, true);
    const instanceKey = decodeURIComponent(pathname.slice('/api/manifest/'.length));
    handleManifest(req, res, state, session, instanceKey);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/files/')) {
    const session = parseSession(req, state, true);
    const remainder = pathname.slice('/api/files/'.length);
    const [rawInstanceKey, ...rawPath] = remainder.split('/');
    if (!rawInstanceKey || rawPath.length === 0) {
      sendError(res, 400, 'Invalid protected file path.');
      return;
    }

    const instanceKey = decodeURIComponent(rawInstanceKey);
    const relativePath = rawPath.map((segment) => decodeURIComponent(segment)).join('/');
    handleProtectedFile(res, state, session, instanceKey, relativePath);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/launcher/')) {
    handlePublicLauncherAsset(res, state, pathname);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/files/')) {
    sendError(res, 403, 'Direct file access is disabled in secure mode.');
    return;
  }

  if (req.method === 'GET' && pathname === '/') {
    sendJson(res, 200, {
      name: 'Tavari Secure Backend',
      secureMode: true,
      manifestPublicKey: state.signing.publicKeyBase64
    });
    return;
  }

  sendError(res, 404, 'Route not found.');
}

async function main() {
  const state = createState();
  const server = http.createServer((req, res) => {
    routeRequest(req, res, state).catch((error) => {
      const statusCode = Number(error?.statusCode || 500);
      sendError(res, statusCode, error?.message || 'Unhandled secure backend error.');
    });
  });

  server.listen(state.port, state.host, () => {
    console.log(`[secure-backend] Root: ${state.rootDir}`);
    console.log(`[secure-backend] Listening on ${state.protocol}://${state.host}:${state.port}`);
    console.log(`[secure-backend] Manifest key mode: ${state.signing.persistent ? 'env' : 'ephemeral'}`);
    console.log(`[secure-backend] Offline staff trusted: ${state.trustOfflineStaff}`);
  });
}

main().catch((error) => {
  console.error(`[secure-backend] ${error.message}`);
  process.exit(1);
});
