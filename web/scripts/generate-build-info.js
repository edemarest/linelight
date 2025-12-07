#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function main() {
  const outPath = path.join(process.cwd(), 'public', 'build-info.json');
  const now = new Date();

  // Try to get git commit and commit date
  const commit = safeExec('git rev-parse --short HEAD');
  const commitDate = safeExec('git log -1 --format=%cI');

  // Determine most recently changed tracked file's mtime
  let latestFile = null;
  let latestMtime = 0;
  try {
    const files = safeExec('git ls-files') || '';
    files.split(/\r?\n/).forEach((file) => {
      if (!file) return;
      try {
        const stat = fs.statSync(file);
        const mtime = stat.mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latestFile = file;
        }
      } catch (e) {
        // skip unreadable files
      }
    });
  } catch (e) {
    // fallback: ignore
  }

  const payload = {
    commit: commit || null,
    commitDate: commitDate || null,
    latestChangedFile: latestFile || null,
    latestChangedTime: latestMtime ? new Date(latestMtime).toISOString() : null,
    generatedAt: now.toISOString(),
  };

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
    console.log('Wrote', outPath);
  } catch (e) {
    console.error('Failed to write build-info:', e);
    process.exit(2);
  }
}

main();
