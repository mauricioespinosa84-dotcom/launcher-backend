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
    this.baseUrl = options.baseUrl;
    this.include = options.include;
    this.pruneLibraries = options.pruneLibraries;
    this.cacheConfigFile = options.cacheConfigFile;
    this.debounceMs = options.debounceMs;
    this.watchHandle = null;
    this.timer = null;
    this.running = false;
    this.pendingReason = null;
  }

  shouldIgnoreFile(relativePath) {
    if (!relativePath || typeof relativePath !== 'string') return true;
    const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
    if (!normalized) return true;

    if (normalized.endsWith('/manifest.json') || normalized === 'manifest.json') {
      return true;
    }

    if (normalized.endsWith('.tmp') || normalized.endsWith('.swp')) {
      return true;
    }

    return false;
  }

  scheduleRun(reason) {
    this.pendingReason = reason || 'filesystem-change';
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run(this.pendingReason);
    }, this.debounceMs);
  }

  async run(reason) {
    if (this.running) {
      this.pendingReason = reason || 'queued-change';
      return;
    }

    this.running = true;
    const runReason = reason || 'manual';
    console.log(`\n[watch-manifests] Running sync (${runReason})`);

    try {
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
      await runNodeScript(this.cwd, 'tools/bump-cache-version.js', [
        '--file',
        this.cacheConfigFile
      ]);

      console.log('[watch-manifests] Manifest + cache_version updated');
    } catch (error) {
      console.error(`[watch-manifests] Sync failed: ${error.message}`);
    } finally {
      this.running = false;
      if (this.pendingReason && this.pendingReason !== runReason) {
        const nextReason = this.pendingReason;
        this.pendingReason = null;
        this.scheduleRun(`queued-after-${nextReason}`);
      } else {
        this.pendingReason = null;
      }
    }
  }

  start() {
    const rootPath = path.resolve(this.cwd, this.root);
    if (!fs.existsSync(rootPath)) {
      throw new Error(`Root folder not found: ${rootPath}`);
    }

    this.run('startup');

    this.watchHandle = fs.watch(
      rootPath,
      { recursive: true },
      (eventType, fileName) => {
        if (!fileName) return;
        if (this.shouldIgnoreFile(fileName)) return;
        this.scheduleRun(`${eventType}:${fileName}`);
      }
    );

    this.watchHandle.on('error', (error) => {
      console.error(`[watch-manifests] Watch error: ${error.message}`);
    });

    console.log(`[watch-manifests] Watching ${rootPath}`);
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
