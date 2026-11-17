'use strict';
/*
 * Automatic data backups. Takes timestamped snapshots of the data store
 * (app.json and/or app.db) into DATA_DIR/backups, keeping the newest 30.
 * Snapshots protect against bad writes, bugs, and accidental deletions.
 * They live on the same disk as the data, so they do NOT protect against
 * losing the disk itself — GET /api/admin/backup (ADMIN_SECRET-gated)
 * exists so the owner can pull an off-site copy.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = 30;
const FILES = ['app.json', 'app.db', 'app.db-wal', 'app.db-shm'];
let last = null;

function prune() {
  try {
    const dirs = fs.readdirSync(BACKUP_DIR).sort();
    while (dirs.length > KEEP) {
      fs.rmSync(path.join(BACKUP_DIR, dirs.shift()), { recursive: true, force: true });
    }
  } catch (_) { /* no backups yet */ }
}

function snapshot(reason = 'manual') {
  try {
    const present = FILES.filter((f) => fs.existsSync(path.join(DATA_DIR, f)));
    if (!present.length) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(BACKUP_DIR, stamp);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of present) fs.copyFileSync(path.join(DATA_DIR, f), path.join(dir, f));
    const meta = { at: new Date().toISOString(), reason, files: present };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    last = meta;
    prune();
    return last;
  } catch (e) {
    console.error('[backups] snapshot failed:', e.message);
    return null;
  }
}

function status() {
  let count = 0;
  try { count = fs.readdirSync(BACKUP_DIR).length; } catch (_) { /* none yet */ }
  return { last, count };
}

function mainFile() {
  const json = path.join(DATA_DIR, 'app.json');
  if (fs.existsSync(json)) return json;
  const db = path.join(DATA_DIR, 'app.db');
  return fs.existsSync(db) ? db : null;
}

let started = false;
function start() {
  if (started) return;
  started = true;
  setTimeout(() => snapshot('startup'), 5000).unref();
  setInterval(() => snapshot('scheduled'), 6 * 60 * 60 * 1000).unref();
}

module.exports = { snapshot, status, start, mainFile, BACKUP_DIR };
