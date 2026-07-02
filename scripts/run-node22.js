'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function parseMajor(version) {
  const match = /^v?(\d+)/.exec(String(version || '').trim());
  return match ? Number(match[1]) : 0;
}

function listNode22Candidates() {
  const homeDir = os.homedir();
  const explicitCandidates = [
    process.env.SESAPP_NODE22_PATH,
    process.env.NODE22_BIN,
  ].filter(Boolean);

  const nvmRoot = process.env.NVM_DIR || path.join(homeDir, '.nvm');
  const nvmVersionsDir = path.join(nvmRoot, 'versions', 'node');
  const fnmRoot = process.env.FNM_DIR || path.join(homeDir, '.local', 'share', 'fnm');
  const fnmVersionsDir = path.join(fnmRoot, 'node-versions');
  const discoveredCandidates = [];

  try {
    const versions = fs.readdirSync(nvmVersionsDir)
      .filter((entry) => /^v22\./.test(entry))
      .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }));
    for (const version of versions) {
      discoveredCandidates.push(path.join(nvmVersionsDir, version, 'bin', 'node'));
    }
  } catch {}

  try {
    const versions = fs.readdirSync(fnmVersionsDir)
      .filter((entry) => /^v22\./.test(entry))
      .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }));
    for (const version of versions) {
      discoveredCandidates.push(path.join(fnmVersionsDir, version, 'installation', 'bin', 'node'));
    }
  } catch {}

  return [...explicitCandidates, ...discoveredCandidates];
}

function resolveNode22Binary() {
  if (parseMajor(process.version) >= 22) return process.execPath;

  for (const candidate of listNode22Candidates()) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const versionCheck = spawnSync(candidate, ['-p', 'process.version'], {
        encoding: 'utf8',
      });
      if (versionCheck.status === 0 && parseMajor(versionCheck.stdout) >= 22) {
        return candidate;
      }
    } catch {}
  }

  return null;
}

function resolveNodeArgs(mode, extraArgs) {
  if (mode === 'test') return ['--test', ...extraArgs];
  if (mode === 'script') {
    if (!extraArgs.length) {
      throw new Error('script mode requires a script path');
    }
    return extraArgs;
  }
  throw new Error(`Unknown mode: ${mode || 'missing'}`);
}

function main() {
  const [mode, ...extraArgs] = process.argv.slice(2);
  const targetNode = resolveNode22Binary();
  if (!targetNode) {
    console.error('Node 22 is required for this command because the project uses node:sqlite.');
    console.error('Run `nvm use 22` or set `SESAPP_NODE22_PATH` to a Node 22 binary.');
    process.exit(1);
  }

  const nodeArgs = resolveNodeArgs(mode, extraArgs);
  const tempRoot = process.env.SESAPP_TMPDIR || '/tmp';
  const childEnv = {
    ...process.env,
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
  };
  const result = spawnSync(targetNode, nodeArgs, {
    stdio: 'inherit',
    env: childEnv,
  });

  if (result.error) throw result.error;
  process.exit(result.status === null ? 1 : result.status);
}

main();
