'use strict';
/*
 * Data layer. Prefers SQLite via better-sqlite3; if that module is missing
 * (e.g. its native build failed during npm install), falls back to a small
 * JSON-file store with the same method surface. Server code only ever calls
 * the methods exported at the bottom of this file.
 *
 * Spaces model (Nov 17): a user account can belong to many Spaces via
 * memberships. Each Space (kind 'couple' | 'family') has its own people
 * (profiles keyed by space + user), messages, reminders, date ideas,
 * weekly sets, daily focuses and daily activities — all keyed by space_id.
 * Older data keyed by household_id is migrated at startup: each household
 * becomes a couple Space keeping its id and invite code, its users become
 * members (earliest user = owner), and every household_id field is re-keyed
 * to space_id. A backups.js snapshot is taken before migrating.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const id = () => crypto.randomBytes(9).toString('base64url');
const now = () => new Date().toISOString();
const byCreated = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);

/* Name for a Space created without one (signup / household migration):
   two members -> "A & B", one -> "A's space", none -> "Our space". */
function spaceNameFor(names) {
  const clean = (names || []).filter(Boolean);
  if (clean.length >= 2) return `${clean[0]} & ${clean[1]}`;
  if (clean.length === 1) return `${clean[0]}'s space`;
  return 'Our space';
}

function preMigrationSnapshot() {
  try { require('./backups').snapshot('pre-spaces-migration'); } catch (_) { /* never block migration */ }
}

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
    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY, name TEXT, kind TEXT NOT NULL DEFAULT 'couple',
      invite_code TEXT UNIQUE NOT NULL, owner_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, space_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL,
      UNIQUE(user_id, space_id));
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, user_id TEXT,
      name TEXT NOT NULL, email TEXT, birthday TEXT,
      birth_city TEXT, birth_time TEXT, birth_time_unknown INTEGER DEFAULT 0,
      astrology_opt_in INTEGER DEFAULT 0,
      love_language TEXT, attachment_style TEXT, personality_snapshot TEXT,
      fight_style TEXT, calms_down TEXT, makes_worse TEXT, work_on TEXT,
      triggers TEXT, guide_tone TEXT,
      relationship_type TEXT, together_duration TEXT, timezone TEXT,
      profile_complete INTEGER DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, person_id TEXT,
      kind TEXT NOT NULL, body TEXT NOT NULL, reworded INTEGER DEFAULT 0,
      scheduled_for TEXT,
      created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, person_id TEXT,
      text TEXT NOT NULL, done INTEGER DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS date_ideas (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, title TEXT NOT NULL,
      category TEXT, notes TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS weekly_sets (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, week_key TEXT NOT NULL,
      kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(space_id, week_key, kind));
    CREATE TABLE IF NOT EXISTS daily_focuses (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, person_id TEXT NOT NULL,
      date_key TEXT NOT NULL, text TEXT NOT NULL, done INTEGER DEFAULT 0,
      UNIQUE(space_id, person_id, date_key));
    CREATE TABLE IF NOT EXISTS daily_activities (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, date_key TEXT NOT NULL,
      text TEXT NOT NULL, UNIQUE(space_id, date_key));
    CREATE TABLE IF NOT EXISTS reset_tokens (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  // Migration for databases created before scheduled messages existed.
  try { db.exec('ALTER TABLE messages ADD COLUMN scheduled_for TEXT'); } catch (_) {}

  const row = (sql, ...p) => db.prepare(sql).get(...p) || null;
  const rows = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  /* ---- Spaces migration: households -> spaces (idempotent) ---- */
  try {
    const hasHouseholds = row("SELECT name FROM sqlite_master WHERE type='table' AND name='households'");
    if (hasHouseholds) {
      preMigrationSnapshot();
      const cols = (t) => rows(`PRAGMA table_info(${t})`).map((c) => c.name);
      for (const t of ['people', 'messages', 'reminders', 'date_ideas', 'weekly_sets', 'daily_focuses', 'daily_activities']) {
        const c = cols(t);
        if (c.includes('household_id') && !c.includes('space_id')) {
          db.exec(`ALTER TABLE ${t} RENAME COLUMN household_id TO space_id`);
        }
      }
      const households = rows('SELECT * FROM households');
      for (const h of households) {
        if (!row('SELECT * FROM spaces WHERE id = ?', h.id)) {
          const members = rows('SELECT * FROM users WHERE household_id = ? ORDER BY created_at', h.id);
          const names = members.map((u) => {
            const p = row('SELECT * FROM people WHERE space_id = ? AND user_id = ?', h.id, u.id);
            return p ? p.name : null;
          });
          run('INSERT INTO spaces (id, name, kind, invite_code, owner_id, created_at) VALUES (?,?,?,?,?,?)',
            h.id, spaceNameFor(names), 'couple', h.invite_code, members.length ? members[0].id : null, h.created_at);
          members.forEach((u, i) => {
            run('INSERT OR IGNORE INTO memberships (id, user_id, space_id, role, created_at) VALUES (?,?,?,?,?)',
              id(), u.id, h.id, i === 0 ? 'owner' : 'member', u.created_at);
          });
        }
      }
      if (cols('users').includes('household_id')) {
        try { db.exec('ALTER TABLE users DROP COLUMN household_id'); } catch (_) {}
      }
      db.exec('DROP TABLE IF EXISTS households');
    }
  } catch (e) {
    console.error('[db] spaces migration (sqlite) failed:', e.message);
  }

  const deleteSpaceData = (sid) => {
    run('DELETE FROM messages WHERE space_id = ?', sid);
    run('DELETE FROM reminders WHERE space_id = ?', sid);
    run('DELETE FROM date_ideas WHERE space_id = ?', sid);
    run('DELETE FROM weekly_sets WHERE space_id = ?', sid);
    run('DELETE FROM daily_focuses WHERE space_id = ?', sid);
    run('DELETE FROM daily_activities WHERE space_id = ?', sid);
    run('DELETE FROM people WHERE space_id = ?', sid);
    run('DELETE FROM memberships WHERE space_id = ?', sid);
    run('DELETE FROM spaces WHERE id = ?', sid);
  };

  return {
    mode: 'sqlite',
    createSpace(s) {
      const space = { id: id(), kind: 'couple', owner_id: null, created_at: now(), ...s };
      run('INSERT INTO spaces (id, name, kind, invite_code, owner_id, created_at) VALUES (?,?,?,?,?,?)',
        space.id, space.name || null, space.kind, space.invite_code, space.owner_id, space.created_at);
      return row('SELECT * FROM spaces WHERE id = ?', space.id);
    },
    getSpace: (sid) => row('SELECT * FROM spaces WHERE id = ?', sid),
    getSpaceByInvite: (code) => row('SELECT * FROM spaces WHERE invite_code = ?', code),
    setSpaceOwner(sid, uid) { run('UPDATE spaces SET owner_id = ? WHERE id = ?', uid, sid); },
    addMembership(uid, sid, role) {
      run('INSERT OR IGNORE INTO memberships (id, user_id, space_id, role, created_at) VALUES (?,?,?,?,?)',
        id(), uid, sid, role || 'member', now());
      return row('SELECT * FROM memberships WHERE user_id = ? AND space_id = ?', uid, sid);
    },
    getMembership: (uid, sid) => row('SELECT * FROM memberships WHERE user_id = ? AND space_id = ?', uid, sid),
    listMemberships: (sid) => rows('SELECT * FROM memberships WHERE space_id = ? ORDER BY created_at', sid),
    listSpacesForUser(uid) {
      return rows(`SELECT s.*, m.role AS role,
          (SELECT COUNT(*) FROM memberships mm WHERE mm.space_id = s.id) AS member_count
        FROM spaces s JOIN memberships m ON m.space_id = s.id
        WHERE m.user_id = ? ORDER BY m.created_at`, uid);
    },
    deleteSpace: deleteSpaceData,

    createUser(u) {
      const user = { id: id(), created_at: now(), ...u };
      run('INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?,?,?,?,?)',
        user.id, user.email, user.password_hash, user.salt, user.created_at);
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
    updateUserPassword(uid, salt, hash) {
      run('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', hash, salt, uid);
    },
    deleteSessionsForUser(uid, exceptToken) {
      if (exceptToken) run('DELETE FROM sessions WHERE user_id = ? AND token != ?', uid, exceptToken);
      else run('DELETE FROM sessions WHERE user_id = ?', uid);
    },
    createResetToken(t) {
      run('INSERT INTO reset_tokens (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)',
        t.token_hash, t.user_id, t.expires_at, now());
    },
    getResetToken: (tokenHash) => row('SELECT * FROM reset_tokens WHERE token_hash = ?', tokenHash),
    deleteResetToken(tokenHash) { run('DELETE FROM reset_tokens WHERE token_hash = ?', tokenHash); },
    deleteResetTokensForUser(uid) { run('DELETE FROM reset_tokens WHERE user_id = ?', uid); },
    /* Removes the user's account from every Space it belongs to: their
       membership, their profile there, and everything they personally
       authored there. A Space left with no members is deleted with all
       its data; a Space whose owner leaves passes ownership to the
       earliest remaining member. */
    deleteAccount(uid) {
      const user = row('SELECT * FROM users WHERE id = ?', uid);
      if (!user) return { spacesExited: 0, spacesDeleted: 0 };
      run('DELETE FROM sessions WHERE user_id = ?', uid);
      run('DELETE FROM reset_tokens WHERE user_id = ?', uid);
      const memberships = rows('SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at', uid);
      let spacesDeleted = 0;
      for (const ms of memberships) {
        const sid = ms.space_id;
        const person = row('SELECT * FROM people WHERE space_id = ? AND user_id = ?', sid, uid);
        if (person) {
          run('DELETE FROM messages WHERE person_id = ?', person.id);
          run('DELETE FROM daily_focuses WHERE person_id = ?', person.id);
          run('DELETE FROM reminders WHERE person_id = ?', person.id);
          run('DELETE FROM people WHERE id = ?', person.id);
        }
        run('DELETE FROM memberships WHERE user_id = ? AND space_id = ?', uid, sid);
        const remaining = rows('SELECT * FROM memberships WHERE space_id = ? ORDER BY created_at', sid);
        if (!remaining.length) {
          deleteSpaceData(sid);
          spacesDeleted++;
        } else {
          const space = row('SELECT * FROM spaces WHERE id = ?', sid);
          if (space && space.owner_id === uid) {
            run('UPDATE spaces SET owner_id = ? WHERE id = ?', remaining[0].user_id, sid);
            run("UPDATE memberships SET role = 'owner' WHERE user_id = ? AND space_id = ?", remaining[0].user_id, sid);
          }
        }
      }
      run('DELETE FROM users WHERE id = ?', uid);
      return { spacesExited: memberships.length, spacesDeleted };
    },

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
    listPeople: (sid) => rows('SELECT * FROM people WHERE space_id = ? ORDER BY created_at', sid),
    getPerson: (pid) => row('SELECT * FROM people WHERE id = ?', pid),
    getPersonInSpace: (sid, uid) => row('SELECT * FROM people WHERE space_id = ? AND user_id = ?', sid, uid),
    getAnyPersonForUser: (uid) => row('SELECT * FROM people WHERE user_id = ? ORDER BY created_at LIMIT 1', uid),

    addMessage(m) {
      const msg = { id: id(), created_at: now(), reworded: 0, scheduled_for: null, ...m };
      run('INSERT INTO messages (id, space_id, person_id, kind, body, reworded, scheduled_for, created_at) VALUES (?,?,?,?,?,?,?,?)',
        msg.id, msg.space_id, msg.person_id, msg.kind, msg.body, msg.reworded ? 1 : 0, msg.scheduled_for || null, msg.created_at);
      return row('SELECT * FROM messages WHERE id = ?', msg.id);
    },
    // The shared chat only ever shows delivered messages. A message with
    // scheduled_for set is pending: visible only to its author via
    // listScheduled, and delivered (scheduled_for cleared) when due.
    listMessages: (sid, limit = 100) =>
      rows('SELECT * FROM messages WHERE space_id = ? AND scheduled_for IS NULL ORDER BY created_at DESC LIMIT ?', sid, limit).reverse(),
    listScheduled: (sid, personId) =>
      rows('SELECT * FROM messages WHERE space_id = ? AND person_id = ? AND scheduled_for IS NOT NULL ORDER BY scheduled_for', sid, personId),
    listDueScheduled: () =>
      rows('SELECT * FROM messages WHERE scheduled_for IS NOT NULL AND scheduled_for <= ? ORDER BY scheduled_for', now()),
    deliverScheduled(mid) {
      run('UPDATE messages SET scheduled_for = NULL, created_at = ? WHERE id = ? AND scheduled_for IS NOT NULL', now(), mid);
      return row('SELECT * FROM messages WHERE id = ?', mid);
    },
    deleteMessage(mid) { run('DELETE FROM messages WHERE id = ?', mid); },

    addReminder(r) {
      const rem = { id: id(), created_at: now(), done: 0, ...r };
      run('INSERT INTO reminders (id, space_id, person_id, text, done, created_at) VALUES (?,?,?,?,?,?)',
        rem.id, rem.space_id, rem.person_id, rem.text, 0, rem.created_at);
      return row('SELECT * FROM reminders WHERE id = ?', rem.id);
    },
    listReminders: (sid) => rows('SELECT * FROM reminders WHERE space_id = ? ORDER BY created_at', sid),
    setReminderDone(rid, done) { run('UPDATE reminders SET done = ? WHERE id = ?', done ? 1 : 0, rid); },

    addDateIdea(d) {
      const idea = { id: id(), created_at: now(), ...d };
      run('INSERT INTO date_ideas (id, space_id, title, category, notes, created_at) VALUES (?,?,?,?,?,?)',
        idea.id, idea.space_id, idea.title, idea.category || null, idea.notes || null, idea.created_at);
      return row('SELECT * FROM date_ideas WHERE id = ?', idea.id);
    },
    listDateIdeas: (sid) => rows('SELECT * FROM date_ideas WHERE space_id = ? ORDER BY created_at DESC', sid),
    deleteDateIdea(did) { run('DELETE FROM date_ideas WHERE id = ?', did); },

    getWeeklySet(sid, weekKey, kind) {
      const r = row('SELECT * FROM weekly_sets WHERE space_id = ? AND week_key = ? AND kind = ?', sid, weekKey, kind);
      return r ? { ...r, payload: JSON.parse(r.payload) } : null;
    },
    saveWeeklySet(sid, weekKey, kind, payload) {
      run('INSERT OR REPLACE INTO weekly_sets (id, space_id, week_key, kind, payload, created_at) VALUES (?,?,?,?,?,?)',
        id(), sid, weekKey, kind, JSON.stringify(payload), now());
      return this.getWeeklySet(sid, weekKey, kind);
    },
    getDailyFocus(sid, personId, dateKey) {
      return row('SELECT * FROM daily_focuses WHERE space_id = ? AND person_id = ? AND date_key = ?', sid, personId, dateKey);
    },
    saveDailyFocus(sid, personId, dateKey, text) {
      run('INSERT OR IGNORE INTO daily_focuses (id, space_id, person_id, date_key, text, done) VALUES (?,?,?,?,?,0)',
        id(), sid, personId, dateKey, text);
      return this.getDailyFocus(sid, personId, dateKey);
    },
    setDailyFocusDone(fid, done) { run('UPDATE daily_focuses SET done = ? WHERE id = ?', done ? 1 : 0, fid); },
    getDailyActivity(sid, dateKey) {
      return row('SELECT * FROM daily_activities WHERE space_id = ? AND date_key = ?', sid, dateKey);
    },
    saveDailyActivity(sid, dateKey, text) {
      run('INSERT OR IGNORE INTO daily_activities (id, space_id, date_key, text) VALUES (?,?,?,?)', id(), sid, dateKey, text);
      return this.getDailyActivity(sid, dateKey);
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
    data = { spaces: [], memberships: [], users: [], sessions: [], people: [], messages: [],
             reminders: [], date_ideas: [], weekly_sets: [], daily_focuses: [], daily_activities: [],
             reset_tokens: [] };
  }
  // Older data files predate password-reset tokens.
  if (!Array.isArray(data.reset_tokens)) data.reset_tokens = [];
  const save = () => fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const find = (arr, fn) => data[arr].find(fn) || null;
  const filter = (arr, fn) => data[arr].filter(fn);

  /* ---- Spaces migration: households -> spaces (idempotent) ----
     Runs only when the file still has households and no spaces yet. The
     on-disk file is still in the old format at this point, so the backup
     snapshot taken first preserves the pre-migration data. Each household
     keeps its id (so every household_id below simply becomes a space_id),
     its invite code, and becomes a 'couple' Space; its users become
     members, earliest first = owner. */
  if (Array.isArray(data.households) && !Array.isArray(data.spaces)) {
    preMigrationSnapshot();
    data.spaces = [];
    data.memberships = [];
    for (const h of data.households) {
      const members = data.users.filter((u) => u.household_id === h.id).sort(byCreated);
      const names = members.map((u) => {
        const p = data.people.find((x) => x.household_id === h.id && x.user_id === u.id);
        return p ? p.name : null;
      });
      data.spaces.push({
        id: h.id, name: spaceNameFor(names), kind: 'couple',
        invite_code: h.invite_code, owner_id: members.length ? members[0].id : null,
        created_at: h.created_at,
      });
      members.forEach((u, i) => {
        data.memberships.push({
          id: id(), user_id: u.id, space_id: h.id,
          role: i === 0 ? 'owner' : 'member', created_at: u.created_at,
        });
      });
    }
    for (const coll of ['people', 'messages', 'reminders', 'date_ideas', 'weekly_sets', 'daily_focuses', 'daily_activities']) {
      for (const rec of data[coll] || []) {
        if ('household_id' in rec) { rec.space_id = rec.household_id; delete rec.household_id; }
      }
    }
    for (const u of data.users) delete u.household_id;
    delete data.households;
    save();
  }
  if (!Array.isArray(data.spaces)) data.spaces = [];
  if (!Array.isArray(data.memberships)) data.memberships = [];

  const deleteSpaceData = (sid) => {
    data.messages = data.messages.filter((m) => m.space_id !== sid);
    data.reminders = data.reminders.filter((r) => r.space_id !== sid);
    data.date_ideas = data.date_ideas.filter((d) => d.space_id !== sid);
    data.weekly_sets = data.weekly_sets.filter((w) => w.space_id !== sid);
    data.daily_focuses = data.daily_focuses.filter((f) => f.space_id !== sid);
    data.daily_activities = data.daily_activities.filter((a) => a.space_id !== sid);
    data.people = data.people.filter((p) => p.space_id !== sid);
    data.memberships = data.memberships.filter((m) => m.space_id !== sid);
    data.spaces = data.spaces.filter((s) => s.id !== sid);
  };

  return {
    mode: 'json',
    createSpace(s) {
      const space = { id: id(), kind: 'couple', owner_id: null, created_at: now(), ...s };
      data.spaces.push(space); save(); return space;
    },
    getSpace: (sid) => find('spaces', (s) => s.id === sid),
    getSpaceByInvite: (code) => find('spaces', (s) => s.invite_code === code),
    setSpaceOwner(sid, uid) {
      const s = find('spaces', (x) => x.id === sid);
      if (s) { s.owner_id = uid; save(); }
    },
    addMembership(uid, sid, role) {
      let m = find('memberships', (x) => x.user_id === uid && x.space_id === sid);
      if (!m) {
        m = { id: id(), user_id: uid, space_id: sid, role: role || 'member', created_at: now() };
        data.memberships.push(m); save();
      }
      return m;
    },
    getMembership: (uid, sid) => find('memberships', (m) => m.user_id === uid && m.space_id === sid),
    listMemberships: (sid) => filter('memberships', (m) => m.space_id === sid).sort(byCreated),
    listSpacesForUser(uid) {
      return filter('memberships', (m) => m.user_id === uid).sort(byCreated)
        .map((m) => {
          const s = find('spaces', (x) => x.id === m.space_id);
          if (!s) return null;
          return { ...s, role: m.role, member_count: data.memberships.filter((x) => x.space_id === s.id).length };
        }).filter(Boolean);
    },
    deleteSpace(sid) { deleteSpaceData(sid); save(); },

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
    updateUserPassword(uid, salt, hash) {
      const u = find('users', (x) => x.id === uid);
      if (u) { u.password_hash = hash; u.salt = salt; save(); }
    },
    deleteSessionsForUser(uid, exceptToken) {
      data.sessions = data.sessions.filter((s) => !(s.user_id === uid && s.token !== exceptToken));
      save();
    },
    createResetToken(t) {
      data.reset_tokens.push({ created_at: now(), ...t }); save();
    },
    getResetToken: (tokenHash) => find('reset_tokens', (t) => t.token_hash === tokenHash),
    deleteResetToken(tokenHash) {
      data.reset_tokens = data.reset_tokens.filter((t) => t.token_hash !== tokenHash); save();
    },
    deleteResetTokensForUser(uid) {
      data.reset_tokens = data.reset_tokens.filter((t) => t.user_id !== uid); save();
    },
    /* Removes the user's account from every Space it belongs to: their
       membership, their profile there, and everything they personally
       authored there. A Space left with no members is deleted with all
       its data; a Space whose owner leaves passes ownership to the
       earliest remaining member. */
    deleteAccount(uid) {
      const user = find('users', (u) => u.id === uid);
      if (!user) return { spacesExited: 0, spacesDeleted: 0 };
      data.sessions = data.sessions.filter((s) => s.user_id !== uid);
      data.reset_tokens = data.reset_tokens.filter((t) => t.user_id !== uid);
      const myMemberships = filter('memberships', (m) => m.user_id === uid).sort(byCreated);
      let spacesDeleted = 0;
      for (const ms of myMemberships) {
        const sid = ms.space_id;
        const person = find('people', (p) => p.space_id === sid && p.user_id === uid);
        if (person) {
          data.messages = data.messages.filter((m) => m.person_id !== person.id);
          data.daily_focuses = data.daily_focuses.filter((f) => f.person_id !== person.id);
          data.reminders = data.reminders.filter((r) => r.person_id !== person.id);
          data.people = data.people.filter((p) => p.id !== person.id);
        }
        data.memberships = data.memberships.filter((m) => !(m.user_id === uid && m.space_id === sid));
        const remaining = filter('memberships', (m) => m.space_id === sid).sort(byCreated);
        if (!remaining.length) {
          deleteSpaceData(sid);
          spacesDeleted++;
        } else {
          const space = find('spaces', (s) => s.id === sid);
          if (space && space.owner_id === uid) {
            space.owner_id = remaining[0].user_id;
            remaining[0].role = 'owner';
          }
        }
      }
      data.users = data.users.filter((u) => u.id !== uid);
      save();
      return { spacesExited: myMemberships.length, spacesDeleted };
    },

    createPerson(f) {
      const p = { id: id(), created_at: now(), birth_time_unknown: 0, astrology_opt_in: 0, profile_complete: 0, ...f };
      data.people.push(p); save(); return p;
    },
    updatePerson(pid, f) {
      const p = find('people', (x) => x.id === pid);
      if (p) { Object.assign(p, f); save(); }
      return p;
    },
    listPeople: (sid) => filter('people', (p) => p.space_id === sid),
    getPerson: (pid) => find('people', (p) => p.id === pid),
    getPersonInSpace: (sid, uid) => find('people', (p) => p.space_id === sid && p.user_id === uid),
    getAnyPersonForUser: (uid) => filter('people', (p) => p.user_id === uid).sort(byCreated)[0] || null,

    addMessage(m) {
      const msg = { id: id(), created_at: now(), reworded: 0, scheduled_for: null, ...m };
      data.messages.push(msg); save(); return msg;
    },
    listMessages: (sid, limit = 100) => filter('messages', (m) => m.space_id === sid && !m.scheduled_for).slice(-limit),
    listScheduled: (sid, personId) =>
      filter('messages', (m) => m.space_id === sid && m.person_id === personId && m.scheduled_for)
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
    listReminders: (sid) => filter('reminders', (r) => r.space_id === sid),
    setReminderDone(rid, done) {
      const r = find('reminders', (x) => x.id === rid);
      if (r) { r.done = done ? 1 : 0; save(); }
    },

    addDateIdea(d) {
      const idea = { id: id(), created_at: now(), category: null, notes: null, ...d };
      data.date_ideas.push(idea); save(); return idea;
    },
    listDateIdeas: (sid) => filter('date_ideas', (d) => d.space_id === sid).reverse(),
    deleteDateIdea(did) { data.date_ideas = data.date_ideas.filter((d) => d.id !== did); save(); },

    getWeeklySet(sid, weekKey, kind) {
      return find('weekly_sets', (w) => w.space_id === sid && w.week_key === weekKey && w.kind === kind);
    },
    saveWeeklySet(sid, weekKey, kind, payload) {
      data.weekly_sets = data.weekly_sets.filter((w) => !(w.space_id === sid && w.week_key === weekKey && w.kind === kind));
      const w = { id: id(), space_id: sid, week_key: weekKey, kind, payload, created_at: now() };
      data.weekly_sets.push(w); save(); return w;
    },
    getDailyFocus: (sid, personId, dateKey) =>
      find('daily_focuses', (f) => f.space_id === sid && f.person_id === personId && f.date_key === dateKey),
    saveDailyFocus(sid, personId, dateKey, text) {
      let f = this.getDailyFocus(sid, personId, dateKey);
      if (!f) {
        f = { id: id(), space_id: sid, person_id: personId, date_key: dateKey, text, done: 0 };
        data.daily_focuses.push(f); save();
      }
      return f;
    },
    setDailyFocusDone(fid, done) {
      const f = find('daily_focuses', (x) => x.id === fid);
      if (f) { f.done = done ? 1 : 0; save(); }
    },
    getDailyActivity: (sid, dateKey) => find('daily_activities', (a) => a.space_id === sid && a.date_key === dateKey),
    saveDailyActivity(sid, dateKey, text) {
      let a = this.getDailyActivity(sid, dateKey);
      if (!a) {
        a = { id: id(), space_id: sid, date_key: dateKey, text };
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
