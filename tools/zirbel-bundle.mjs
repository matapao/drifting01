// Packs the built game (dist/) as a zirbel bundle: dist with zirbel.json at its root, as <id>-<version>.tgz.
// Games on zirbel make no requests beyond their host, so the page's web-font links are left out; the
// styles fall back to local fonts.
//
//   npm run build && node tools/zirbel-bundle.mjs

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'zirbel.json'), 'utf8'));

if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('Build first: npm run build');
fs.writeFileSync(path.join(DIST, 'zirbel.json'), JSON.stringify(manifest, null, 2) + '\n');

const page = path.join(DIST, manifest.entry ?? 'index.html');
const html = fs.readFileSync(page, 'utf8').replace(/\s*<link[^>]+(fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>/g, '');
if (/<(?:link|script|img|iframe|source)[^>]+(?:href|src)=["']?https?:/i.test(html)) {
  throw new Error('The page still loads something from another site');
}
fs.writeFileSync(page, html);

let files = 0;
let bytes = 0;
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`No links in a bundle: ${full}`);
    if (stat.isDirectory()) walk(full);
    else {
      files++;
      bytes += stat.size;
    }
  }
};
walk(DIST);
if (files > 2000 || bytes > 32 * 1024 * 1024) throw new Error(`Too big for zirbel: ${files} files, ${bytes} bytes`);

const out = path.join(ROOT, `${manifest.id}-${manifest.version}.tgz`);
execFileSync('tar', ['-czf', out, '--exclude', '.DS_Store', '-C', DIST, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
const sha256 = createHash('sha256').update(fs.readFileSync(out)).digest('hex');
console.log(`${path.basename(out)}: ${files} files, ${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB, sha256 ${sha256}`);
