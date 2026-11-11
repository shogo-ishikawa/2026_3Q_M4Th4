'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const site = path.resolve(process.argv[2] || '_site');
const project = path.resolve(__dirname, '..');
const version = /^version = "([^"]+)"$/m.exec(fs.readFileSync(path.join(project, 'pyproject.toml'), 'utf8'))[1];
let checks = 0;
for (const page of [path.join(site, 'index.html'), path.join(site, 'vocal-fluctuation-lab/index.html')]) {
  const html = fs.readFileSync(page, 'utf8');
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1];
    if (href.endsWith('.zip') && !href.startsWith('http')) {
      assert(fs.statSync(path.resolve(path.dirname(page), href)).isFile(), `Missing download: ${href}`);
      checks++;
    }
    if (href.startsWith('https://colab.research.google.com/github/')) {
      const notebook = href.split('/blob/main/')[1];
      assert(notebook, 'Colab link must select the main branch notebook');
      assert(fs.statSync(path.join(root, notebook)).isFile(), `Missing notebook: ${notebook}`);
      checks++;
    }
  }
}
const html = fs.readFileSync(path.join(site, 'vocal-fluctuation-lab/index.html'), 'utf8');
for (const filename of ['app.js', 'catalogue.js', 'style.css']) {
  assert(html.includes(`${filename}?v=${version}`), `Stale asset version: ${filename}`);
  assert(fs.statSync(path.join(site, 'vocal-fluctuation-lab', filename)).isFile());
  checks++;
}
const catalogue = path.join(site, 'vocal-fluctuation-lab/data/reference_catalogue_public.json');
assert.deepEqual(JSON.parse(fs.readFileSync(catalogue, 'utf8')),
  JSON.parse(fs.readFileSync(path.join(project, 'data/reference_catalogue_public.json'), 'utf8')),
  'Published catalogue must match the bundled reference catalogue');
checks++;
console.log(`${checks} public link and asset checks passed.`);
