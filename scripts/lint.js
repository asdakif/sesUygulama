'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const ignoredDirs = new Set(['node_modules', 'dist', '.git']);
const roots = ['server.js', 'database.js', 'electron', 'public', 'server', 'scripts', 'test'];

function collectJavaScriptFiles(targetPath, collected) {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    if (targetPath.endsWith('.js')) collected.push(targetPath);
    return;
  }

  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    collectJavaScriptFiles(path.join(targetPath, entry.name), collected);
  }
}

const files = [];
for (const root of roots) {
  const target = path.join(projectRoot, root);
  if (!fs.existsSync(target)) continue;
  collectJavaScriptFiles(target, files);
}

let hasErrors = false;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit',
  });
  if (result.status !== 0) hasErrors = true;
}

if (hasErrors) {
  process.exitCode = 1;
} else {
  console.log(`Lint passed for ${files.length} JavaScript files.`);
}
