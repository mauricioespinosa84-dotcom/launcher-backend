const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function walk(dir, root, out) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, root, out);
            continue;
        }
        const rel = path.relative(root, full).replace(/\\/g, '/');
        const data = fs.readFileSync(full);
        const hash = crypto.createHash('sha1').update(data).digest('hex');
        out.push({
            path: rel,
            hash: hash,
            size: data.length
        });
    }
}

function main() {
    const folder = process.argv[2];
    const baseUrl = process.argv[3];
    const output = process.argv[4] || 'manifest.json';

    if (!folder || !baseUrl) {
        console.error('Usage: node generate-manifest.js <folder> <baseUrl> [output]');
        process.exit(1);
    }

    const absFolder = path.resolve(folder);
    const files = [];
    walk(absFolder, absFolder, files);

    const manifest = files.map((file) => ({
        path: file.path,
        hash: file.hash,
        size: file.size,
        url: `${baseUrl.replace(/\\/$/, '')}/${file.path}`
    }));

    fs.writeFileSync(output, JSON.stringify(manifest, null, 4));
    console.log(`Wrote ${manifest.length} entries to ${output}`);
}

main();
