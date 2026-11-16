'use strict';
/*
 * Data layer. Prefers SQLite via better-sqlite3; if that module is missing
 * (e.g. its native build failed during npm install), falls back to a small
 * JSON-file store with the same method surface. Server code only ever calls
 * the methods exported at the bottom of this file.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const id = () => crypto.randomBytes(9).toString('base64url');
const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* SQLite backend                                                      */
/* ------------------------------------------------------------------ */
function trySqlite() {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (_) {
    return null;
  }
  const db = new Database(path.join(DATA_DIR, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY, invite_code TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL, user_id TEXT,
      name TEXT NOT NULL, email TEXT, birthday TEXT,
      birth_city TEXT, birth_time TEXT, birth_time_unknown INTEGER DEFAULT 0,
      astrology_opt_in INTEGER DEFAULT 0,
      love_language TEXT, attachment_style TEXT, personality_snapshot TEXT,
      fight_style TEXT, calms_down TEXT, makes_worse TEXT, work_on TEXT,
      triggers TEXT, guide_tone TEXT,
      relationship_type TEXT, together_duration TEXT, timezone TEXT,
      profile_complete INTEGER DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL, person_id TEXT,
      kind TEXT NOT NULL, body TEXT NOT NULL, reworded INTEGER DEFAULT 0,
      scheduled_for TEXT,
      created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL, person_id TEXT,
      text TEXT NOT NULL, done INTEGER DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS date_ideas (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL, title TEXT NOT NULL,
      category TEXT, notes TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS weekly_sets (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL, week_key TEXT NOT NULL,
      kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(household_id, week_key, kind));
    CREATE TABLE IF NOT EXISTS daily_focuses (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL, person_id TEXT NOT NULL,
      date_key TEXT NOT NULL, text TEXT NOT NULL, done INTEGER DEFAULT 0,
      UNIQUE(household_id, person_id, date_key));
    CREATE TABLE IF NOT EXISTS daily_activities (
      id TEXT PRIMARY KEY, household_id TEXT NOT NULL, date_key TEXT NOT NULL,
      text TEXT NOT NULL, UNIQUE(household_id, date_key));
  `);
  // Migration for databases created before scheduled messages existed.
  try { db.exec('ALTER TABLE messages ADD COLUMN scheduled_for TEXT'); } catch (_) {}

  const row = (sql, ...p) => db.prepare(sql).get(...p) || null;
  const rows = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  return {
    mode: 'sqlite',
    createHousehold(inviteCode) {
      const h = { id: id(), invite_code: inviteCode, created_at: now() };
      run('INSERT INTO households (id, invite_code, created_at) VALUES (?,?,?)', h.id, h.invite_code, h.created_at);
      return h;
    },
    getHouseholdByInvite: (code) => row('SELECT * FROM households WHERE invite_code = ?', code),
    getHousehold: (hid) => row('SELECT * FROM households WHERE id = ?', hid),
    createUser(u) {
      const user = { id: id(), created_at: now(), ...u };
      run('INSERT INTO users (id, household_id, email, password_hash, salt, created_at) VALUES (?,?,?,?,?,?)',
        user.id, user.household_id, user.email, user.password_hash, user.salt, user.created_at);
      return user;
    },
    getUserByEmail: (email) => row('SELECT * FROM users WHERE email = ?', email),
    getUserById: (uid) => row('SELECT * FROM users WHERE id = ?', uid),
    createSession(token, userId) { run('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)', token, userId, now()); },
    getSessionUser(token) {
      const s = row('SELECT * FROM sessions WHERE token = ?', token);
      return s ? row('SELECT * FROM users WHERE id = ?', s.user_id) : null;
    },
    deleteSession(token) { run('DELETE FROM sessions WHERE token = ?', token); },

    createPerson(f) {
      const p = { id: id(), created_at: now(), birth_time_unknown: 0, astrology_opt_in: 0, profile_complete: 0, ...f };
      const cols = Object.keys(p);
      run(`INSERT INTO people (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => p[c]));
      return row('SELECT * FROM people WHERE id = ?', p.id);
    },
    updatePerson(pid, f) {
      const cols = Object.keys(f);
      if (!cols.length) return row('SELECT * FROM people WHERE id = ?', pid);
      run(`UPDATE people SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE id = ?`, ...cols.map((c) => f[c]), pid);
      return row('SELECT * FROM people WHERE id = ?', pid);
    },
    listPeople: (hid) => rows('SELECT * FROM people WHERE household_id = ? ORDER BY created_at', hid),
    getPerson: (pid) => row('SELECT * FROM people WHERE id = ?', pid),

    addMessage(m) {
      const msg = { id: id(), created_at: now(), reworded: 0, scheduled_for: null, ...m };
      run('INSERT INTO messages (id, household_id, person_id, kind, body, reworded, scheduled_for, created_at) VALUES (?,?,?,?,?,?,?,?)',
        msg.id, msg.household_id, msg.person_id, msg.kind, msg.body, msg.reworded ? 1 : 0, msg.scheduled_for || null, msg.created_at);
      return row('SELECT * FROM messages WHERE id = ?', msg.id);
    },
    // The shared chat only ever shows delivered messages. A message with
    // scheduled_for set is pending: visible only to its author via
    // listScheduled, and delivered (scheduled_for cleared) when due.
    listMessages: (hid, limit = 100) =>
      rows('SELECT * FROM messages WHERE household_id = ? AND scheduled_for IS NULL ORDER BY created_at DESC LIMIT ?', hid, limit).reverse(),
    listScheduled: (hid, personId) =>
      rows('SELECT * FROM messages WHERE household_id = ? AND person_id = ? AND scheduled_for IS NOT NULL ORDER BY scheduled_for', hid, personId),
    listDueScheduled: () =>
      rows('SELECT * FROM messages WHERE scheduled_for IS NOT NULL AND scheduled_for <= ? ORDER BY scheduled_for', now()),
    deliverScheduled(mid) {
      run('UPDATE messages SET scheduled_for = NULL, created_at = ? WHERE id = ? AND scheduled_for IS NOT NULL', now(), mid);
      return row('SELECT * FROM messages WHERE id = ?', mid);
    },
    deleteMessage(mid) { run('DELETE FROM messages WHERE id = ?', mid); },

    addReminder(r) {
      const rem = { id: id(), created_at: now(), done: 0, ...r };
      run('INSERT INTO reminders (id, household_id, person_id, text, done, created_at) VALUES (?,?,?,?,?,?)',
        rem.id, rem.household_id, rem.person_id, rem.text, 0, rem.created_at);
      return row('SELECT * FROM reminders WHERE id = ?', rem.id);
    },
    listReminders: (hid) => rows('SELECT * FROM reminders WHERE household_id = ? ORDER BY created_at', hid),
    setReminderDone(rid, done) { run('UPDATE reminders SET done = ? WHERE id = ?', done ? 1 : 0, rid); },

    addDateIdea(d) {
      const idea = { id: id(), created_at: now(), ...d };
      run('INSERT INTO date_ideas (id, household_id, title, category, notes, created_at) VALUES (?,?,?,?,?,?)',
        idea.id, idea.household_id, idea.title, idea.category || null, idea.notes || null, idea.created_at);
      return row('SELECT * FROM date_ideas WHERE id = ?', idea.id);
    },
    listDateIdeas: (hid) => rows('SELECT * FROM date_ideas WHERE household_id = ? ORDER BY created_at DESC', hid),
    deleteDateIdea(did) { run('DELETE FROM date_ideas WHERE id = ?', did); },

    getWeeklySet(hid, weekKey, kind) {
      const r = row('SELECT * FROM weekly_sets WHERE household_id = ? AND week_key = ? AND kind = ?', hid, weekKey, kind);
      return r ? { ...r, payload: JSON.parse(r.payload) } : null;
    },
    saveWeeklySet(hid, weekKey, kind, payload) {
      run('INSERT OR REPLACE INTO weekly_sets (id, household_id, week_key, kind, payload, created_at) VALUES (?,?,?,?,?,?)',
        id(), hid, weekKey, kind, JSON.stringify(payload), now());
      return this.getWeeklySet(hid, weekKey, kind);
    },
    getDailyFocus(hid, personId, dateKey) {
      return row('SELECT * FROM daily_focuses WHERE household_id = ? AND person_id = ? AND date_key = ?', hid, personId, dateKey);
    },
    saveDailyFocus(hid, personId, dateKey, text) {
      run('INSERT OR IGNORE INTO daily_focuses (id, household_id, person_id, date_key, text, done) VALUES (?,?,?,?,?,0)',
        id(), hid, personId, dateKey, text);
      return this.getDailyFocus(hid, personId, dateKey);
    },
    setDailyFocusDone(fid, done) { run('UPDATE daily_focuses SET done = ? WHERE id = ?', done ? 1 : 0, fid); },
    getDailyActivity(hid, dateKey) {
      return row('SELECT * FROM daily_activities WHERE household_id = ? AND date_key = ?', hid, dateKey);
    },
    saveDailyActivity(hid, dateKey, text) {
      run('INSERT OR IGNORE INTO daily_activities (id, household_id, date_key, text) VALUES (?,?,?,?)', id(), hid, dateKey, text);
      return this.getDailyActivity(hid, dateKey);
    },
  };
}

/* ------------------------------------------------------------------ */
/* JSON-file fallback backend                                          */
/* ------------------------------------------------------------------ */
function jsonStore() {
  const file = path.join(DATA_DIR, 'app.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    data = { households: [], users: [], sessions: [], people: [], messages: [],
             reminders: [], date_ideas: [], weekly_sets: [], daily_focuses: [], daily_activities: [] };
  }
  const save = () => fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const find = (arr, fn) => data[arr].find(fn) || null;
  const filter = (arr, fn) => data[arr].filter(fn);

  return {
    mode: 'json',
    createHousehold(inviteCode) {
      const h = { id: id(), invite_code: inviteCode, created_at: now() };
      data.households.push(h); save(); return h;
    },
    getHouseholdByInvite: (code) => find('households', (h) => h.invite_code === code),
    getHousehold: (hid) => find('households', (h) => h.id === hid),
    createUser(u) {
      const user = { id: id(), created_at: now(), ...u };
      data.users.push(user); save(); return user;
    },
    getUserByEmail: (email) => find('users', (u) => u.email === email),
    getUserById: (uid) => find('users', (u) => u.id === uid),
    createSession(token, userId) { data.sessions.push({ token, user_id: userId, created_at: now() }); save(); },
    getSessionUser(token) {
      const s = find('sessions', (x) => x.token === token);
      return s ? find('users', (u) => u.id === s.user_id) : null;
    },
    deleteSession(token) { data.sessions = data.sessions.filter((s) => s.token !== token); save(); },

    createPerson(f) {
      const p = { id: id(), created_at: now(), birth_time_unknown: 0, astrology_opt_in: 0, profile_complete: 0, ...f };
      data.people.push(p); save(); return p;
    },
    updatePerson(pid, f) {
      const p = find('people', (x) => x.id === pid);
      if (p) { Object.assign(p, f); save(); }
      return p;
    },
    listPeople: (hid) => filter('people', (p) => p.household_id === hid),
    getPerson: (pid) => find('people', (p) => p.id === pid),

    addMessage(m) {
      const msg = { id: id(), created_at: now(), reworded: 0, scheduled_for: null, ...m };
      data.messages.push(msg); save(); return msg;
    },
    listMessages: (hid, limit = 100) => filter('messages', (m) => m.household_id === hid && !m.scheduled_for).slice(-limit),
    listScheduled: (hid, personId) =>
      filter('messages', (m) => m.household_id === hid && m.person_id === personId && m.scheduled_for)
        .sort((a, b) => (a.scheduled_for < b.scheduled_for ? -1 : 1)),
    listDueScheduled: () =>
      filter('messages', (m) => m.scheduled_for && m.scheduled_for <= now())
        .sort((a, b) => (a.scheduled_for < b.scheduled_for ? -1 : 1)),
    deliverScheduled(mid) {
      const m = find('messages', (x) => x.id === mid);
      if (m && m.scheduled_for) { m.scheduled_for = null; m.created_at = now(); save(); }
      return m;
    },
    deleteMessage(mid) { data.messages = data.messages.filter((m) => m.id !== mid); save(); },

    addReminder(r) {
      const rem = { id: id(), created_at: now(), done: 0, ...r };
      data.reminders.push(rem); save(); return rem;
    },
    listReminders: (hid) => filter('reminders', (r) => r.household_id === hid),
    setReminderDone(rid, done) {
      const r = find('reminders', (x) => x.id === rid);
      if (r) { r.done = done ? 1 : 0; save(); }
    },

    addDateIdea(d) {
      const idea = { id: id(), created_at: now(), category: null, notes: null, ...d };
      data.date_ideas.push(idea); save(); return idea;
    },
    listDateIdeas: (hid) => filter('date_ideas', (d) => d.household_id === hid).reverse(),
    deleteDateIdea(did) { data.date_ideas = data.date_ideas.filter((d) => d.id !== did); save(); },

    getWeeklySet(hid, weekKey, kind) {
      return find('weekly_sets', (w) => w.household_id === hid && w.week_key === weekKey && w.kind === kind);
    },
    saveWeeklySet(hid, weekKey, kind, payload) {
      data.weekly_sets = data.weekly_sets.filter((w) => !(w.household_id === hid && w.week_key === weekKey && w.kind === kind));
      const w = { id: id(), household_id: hid, week_key: weekKey, kind, payload, created_at: now() };
      data.weekly_sets.push(w); save(); return w;
    },
    getDailyFocus: (hid, personId, dateKey) =>
      find('daily_focuses', (f) => f.household_id === hid && f.person_id === personId && f.date_key === dateKey),
    saveDailyFocus(hid, personId, dateKey, text) {
      let f = this.getDailyFocus(hid, personId, dateKey);
      if (!f) {
        f = { id: id(), household_id: hid, person_id: personId, date_key: dateKey, text, done: 0 };
        data.daily_focuses.push(f); save();
      }
      return f;
    },
    setDailyFocusDone(fid, done) {
      const f = find('daily_focuses', (x) => x.id === fid);
      if (f) { f.done = done ? 1 : 0; save(); }
    },
    getDailyActivity: (hid, dateKey) => find('daily_activities', (a) => a.household_id === hid && a.date_key === dateKey),
    saveDailyActivity(hid, dateKey, text) {
      let a = this.getDailyActivity(hid, dateKey);
      if (!a) {
        a = { id: id(), household_id: hid, date_key: dateKey, text };
        data.daily_activities.push(a); save();
      }
      return a;
    },
  };
}

const store = trySqlite() || jsonStore();
if (store.mode === 'json') {
  console.warn('[db] better-sqlite3 unavailable — using JSON file store at data/app.json');
}
module.exports = store;
