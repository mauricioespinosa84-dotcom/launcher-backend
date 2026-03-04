const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function parseBoolean(value, defaultValue = false) {
  if (value === null || value === undefined) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function normalizeRelativePath(value) {
  if (!value || typeof value !== 'string') return '';
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .trim();
}

function normalizeKey(value) {
  return normalizeRelativePath(value).toLowerCase();
}

function runNodeScript(cwd, scriptFile, scriptArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptFile, ...scriptArgs], {
      cwd,
      stdio: 'inherit',
      shell: false
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${scriptFile} exited with code ${code}`));
      }
    });
  });
}

class ManifestWatcher {
  constructor(options) {
    this.cwd = options.cwd;
    this.root = options.root;
    this.watchRoot = options.watchRoot;
    this.baseUrl = options.baseUrl;
    this.include = options.include;
    this.pruneLibraries = options.pruneLibraries;
    this.cacheConfigFile = options.cacheConfigFile;
    this.debounceMs = options.debounceMs;

    this.watchHandle = null;
    this.timer = null;
    this.running = false;
    this.pendingRun = null;

    this.rootKey = normalizeKey(this.root).replace(/\/+$/, '');
    this.cacheFileKey = normalizeKey(this.cacheConfigFile);
  }

  shouldIgnoreFile(relativePath) {
    const normalized = normalizeKey(relativePath);
    if (!normalized) return true;

    if (normalized === this.cacheFileKey) {
      return true;
    }

    if (normalized.endsWith('/manifest.json') || normalized === 'manifest.json') {
      return true;
    }

    if (normalized.startsWith('.git/') || normalized === '.git') {
      return true;
    }

    if (normalized.startsWith('node_modules/') || normalized === 'node_modules') {
      return true;
    }

    if (
      normalized.endsWith('.tmp') ||
      normalized.endsWith('.swp') ||
      normalized.endsWith('.swx') ||
      normalized.endsWith('.ds_store')
    ) {
      return true;
    }

    return false;
  }

  isUnderManifestRoot(relativePath) {
    const normalized = normalizeKey(relativePath);
    if (!normalized || !this.rootKey) return false;
    return normalized === this.rootKey || normalized.startsWith(`${this.rootKey}/`);
  }

  classifyChange(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    if (this.shouldIgnoreFile(normalized)) return null;

    if (this.isUnderManifestRoot(normalized)) {
      return 'full';
    }

    return 'cache';
  }

  mergeModes(currentMode, nextMode) {
    if (currentMode === 'full' || nextMode === 'full') return 'full';
    return nextMode || currentMode || 'cache';
  }

  scheduleRun(mode, reason) {
    const nextMode = mode === 'full' ? 'full' : 'cache';

    if (!this.pendingRun) {
      this.pendingRun = {
        mode: nextMode,
        reason: reason || 'filesystem-change'
      };
    } else {
      this.pendingRun.mode = this.mergeModes(this.pendingRun.mode, nextMode);
      this.pendingRun.reason = reason || this.pendingRun.reason;
    }

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const queued = this.pendingRun || { mode: 'cache', reason: 'debounced-change' };
      this.pendingRun = null;
      this.timer = null;
      this.run(queued.mode, queued.reason);
    }, this.debounceMs);
  }

  async run(mode = 'cache', reason = 'manual') {
    if (this.running) {
      this.scheduleRun(mode, `queued:${reason}`);
      return;
    }

    this.running = true;
    const runMode = mode === 'full' ? 'full' : 'cache';
    console.log(`\n[watch-manifests] Running ${runMode} sync (${reason})`);

    try {
      if (runMode === 'full') {
        const manifestArgs = [
          '--root',
          this.root,
          '--base-url',
          this.baseUrl,
          '--include',
          this.include,
          '--prune-libraries',
          String(this.pruneLibraries)
        ];

        await runNodeScript(this.cwd, 'tools/generate-manifests.js', manifestArgs);
      }

      await runNodeScript(this.cwd, 'tools/bump-cache-version.js', [
        '--file',
        this.cacheConfigFile
      ]);

      if (runMode === 'full') {
        console.log('[watch-manifests] Manifest + cache_version updated');
      } else {
        console.log('[watch-manifests] cache_version updated');
      }
    } catch (error) {
      console.error(`[watch-manifests] Sync failed: ${error.message}`);
    } finally {
      this.running = false;

      if (this.pendingRun && !this.timer) {
        const nextRun = this.pendingRun;
        this.pendingRun = null;
        this.scheduleRun(nextRun.mode, `queued-after:${nextRun.reason}`);
      }
    }
  }

  start() {
    const rootPath = path.resolve(this.cwd, this.root);
    if (!fs.existsSync(rootPath)) {
      throw new Error(`Manifest root folder not found: ${rootPath}`);
    }

    const watchPath = path.resolve(this.cwd, this.watchRoot);
    if (!fs.existsSync(watchPath)) {
      throw new Error(`Watch root folder not found: ${watchPath}`);
    }

    this.run('full', 'startup');

    this.watchHandle = fs.watch(
      watchPath,
      { recursive: true },
      (eventType, fileName) => {
        if (!fileName) return;

        const normalized = normalizeRelativePath(fileName);
        const mode = this.classifyChange(normalized);
        if (!mode) return;

        this.scheduleRun(mode, `${eventType}:${normalized}`);
      }
    );

    this.watchHandle.on('error', (error) => {
      console.error(`[watch-manifests] Watch error: ${error.message}`);
    });

    console.log(`[watch-manifests] Watching ${watchPath}`);
    console.log(`[watch-manifests] Manifest root: ${rootPath}`);
    console.log(`[watch-manifests] Cache file: ${path.resolve(this.cwd, this.cacheConfigFile)}`);
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watchHandle) {
      this.watchHandle.close();
      this.watchHandle = null;
    }
  }
}

function main() {
  const cwd = process.cwd();
  const root = getArg('--root') || process.env.MANIFEST_ROOT || 'files';
  const watchRoot = getArg('--watch-root') || process.env.MANIFEST_WATCH_ROOT || '.';
  const baseUrl = getArg('--base-url') || process.env.MANIFEST_BASE_URL;
  const include =
    getArg('--include') ||
    process.env.MANIFEST_INCLUDE ||
    'mods,config,resourcepacks,versions,libraries,shaderpacks';
  const pruneLibraries = parseBoolean(
    getArg('--prune-libraries') || process.env.MANIFEST_PRUNE_LIBRARIES,
    true
  );
  const cacheConfigFile =
    getArg('--cache-file') || process.env.CACHE_VERSION_FILE || 'launcher/config.json';
  const debounceMs = Number(getArg('--debounce') || process.env.MANIFEST_WATCH_DEBOUNCE || 1200);

  if (!baseUrl) {
    throw new Error('Missing --base-url (or MANIFEST_BASE_URL).');
  }

  const watcher = new ManifestWatcher({
    cwd,
    root,
    watchRoot,
    baseUrl,
    include,
    pruneLibraries,
    cacheConfigFile,
    debounceMs: Number.isFinite(debounceMs) && debounceMs > 100 ? debounceMs : 1200
  });

  watcher.start();

  const shutdown = () => {
    watcher.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main();
} catch (error) {
  console.error(`[watch-manifests] ${error.message}`);
  process.exit(1);
}