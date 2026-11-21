'use strict';
/*
 * Us, Guided — standalone server.
 * Express + (SQLite | JSON fallback). No build step; the frontend files
 * (index.html, app.js, styles.css, ...) sit alongside this file.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* --- tiny .env loader (no dependency) --- */
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const express = require('express');
const store = require('./db');
const ai = require('./ai');
const backups = require('./backups');
const mailer = require('./mailer');
const { astroSummary } = require('./astro');

const TERMS_VERSION = '2026-11-19';
/* The signup form's agreement checkbox arrives as 'on' (form data) or a
   boolean true (JSON). Anything else counts as not agreed. */
function agreedToTerms(body) {
  const v = body && body.agree;
  return v === true || v === 1 || v === 'on' || v === 'true' || v === '1';
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const COOKIE_SECURE = process.env.NODE_ENV === 'production' ? '; Secure' : '';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

/* ---------------- passwords & sessions ---------------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expected) {
  const hash = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(hash, Buffer.from(expected, 'hex'));
}
function signToken(token) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('base64url');
  return `${token}.${sig}`;
}
function readSession(req) {
  const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('sid='));
  if (!cookie) return null;
  const raw = decodeURIComponent(cookie.slice(4));
  const [token, sig] = raw.split('.');
  if (!token || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return store.getSessionUser(token);
}
function setSession(res, userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  store.createSession(token, userId);
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(signToken(token))}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${COOKIE_SECURE}`);
}
function currentToken(req) {
  const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('sid='));
  return cookie ? decodeURIComponent(cookie.slice(4)).split('.')[0] : null;
}
function clearSession(req, res) {
  const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('sid='));
  if (cookie) store.deleteSession(decodeURIComponent(cookie.slice(4)).split('.')[0]);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' + COOKIE_SECURE);
}
function requireAuth(req, res, next) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}
const inviteCode = () => crypto.randomBytes(4).toString('hex').toUpperCase(); // e.g. 9F3AC21B

/* ---------------- helpers ---------------- */
function publicPerson(p) {
  if (!p) return null;
  const astro = astroSummary(p);
  return { ...p, astro, sun_sign: astro ? astro.sun : null, rising_sign: astro ? astro.rising : null };
}
function myPerson(req) {
  return req.spaceId ? store.getPersonInSpace(req.spaceId, req.user.id) : null;
}
const todayKey = () => new Date().toISOString().slice(0, 10);

/* ---------------- spaces ----------------
 * One account can belong to many Spaces. The client sends the active one
 * in the X-Space-Id header; when the header is absent (or names a space
 * the user isn't in), the user's earliest space is used, so older clients
 * and header-less calls keep working. */
function resolveSpace(req) {
  const spaces = store.listSpacesForUser(req.user.id);
  if (!spaces.length) return null;
  const wanted = req.get('x-space-id');
  if (wanted) {
    const match = spaces.find((s) => s.id === wanted);
    if (match) return match;
  }
  return spaces[0];
}
function requireSpace(req, res, next) {
  const space = resolveSpace(req);
  if (!space) return res.status(400).json({ error: 'No space yet — create or join one first.' });
  req.space = space;
  req.spaceId = space.id;
  next();
}

/* Fields carried over when a profile is copied into another space. */
const PROFILE_COPY_FIELDS = ['name', 'email', 'birthday', 'birth_city', 'birth_time',
  'birth_time_unknown', 'astrology_opt_in', 'love_language', 'attachment_style',
  'personality_snapshot', 'fight_style', 'calms_down', 'makes_worse', 'work_on',
  'triggers', 'guide_tone', 'relationship_type', 'together_duration', 'timezone',
  'profile_complete'];
/* The user's profile inside a space, creating it on first entry by copying
   their profile from another of their spaces when one exists. */
function ensurePersonInSpace(spaceId, user) {
  const existing = store.getPersonInSpace(spaceId, user.id);
  if (existing) return existing;
  const source = store.getAnyPersonForUser(user.id);
  const fields = { space_id: spaceId, user_id: user.id, email: user.email };
  if (source) {
    for (const f of PROFILE_COPY_FIELDS) if (source[f] !== undefined) fields[f] = source[f];
  } else {
    fields.name = user.email.split('@')[0];
  }
  return store.createPerson(fields);
}

/* ---------------- scheduled message delivery ----------------
 * A scheduled message is stored (already cleaned — the raw draft is never
 * kept) with scheduled_for set. Only its author can see or cancel it. When
 * its time comes, it posts to the shared chat and the Guide replies, exactly
 * as if it had just been sent.
 */
let delivering = false;
async function deliverDue() {
  if (delivering) return;
  delivering = true;
  try {
    for (const m of store.listDueScheduled()) {
      const delivered = store.deliverScheduled(m.id);
      if (!delivered || delivered.scheduled_for) continue;
      const people = store.listPeople(m.space_id);
      const author = people.find((p) => p.id === m.person_id);
      if (!author) continue;
      const others = people.filter((p) => p.id !== author.id);
      const other = others[0] || null;
      const space = store.getSpace(m.space_id);
      const recent = store.listMessages(m.space_id, 10).map((x) => ({
        ...x, author_name: x.kind === 'guide' ? 'Guide' : (people.find((p) => p.id === x.person_id)?.name || 'Someone'),
      }));
      const advice = await ai.guideAdvice({ author, other, others, postedText: delivered.body, people, recentMessages: recent, space });
      store.addMessage({
        space_id: m.space_id, person_id: null, kind: 'guide', body: advice.text, reworded: 0,
      });
    }
  } catch (e) {
    console.error('[schedule] delivery failed:', e.message);
  } finally {
    delivering = false;
  }
}
setInterval(() => { deliverDue(); }, 30000);

/* ---------------- auth ---------------- */
app.post('/api/auth/signup', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (!agreedToTerms(req.body)) {
    return res.status(400).json({ error: 'Please read and agree to the Terms of Use and Privacy Policy to create an account.' });
  }
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (store.getUserByEmail(String(email).toLowerCase())) return res.status(409).json({ error: 'That email already has an account.' });
  const { salt, hash } = hashPassword(String(password));
  const user = store.createUser({
    email: String(email).toLowerCase(), password_hash: hash, salt,
    terms_agreed_at: new Date().toISOString(), terms_version: TERMS_VERSION,
  });
  const space = store.createSpace({ name: `${String(name)}'s space`, kind: 'couple', invite_code: inviteCode(), owner_id: user.id });
  store.addMembership(user.id, space.id, 'owner');
  const person = store.createPerson({ space_id: space.id, user_id: user.id, name: String(name), email: user.email });
  setSession(res, user.id);
  res.json({ user: { id: user.id, email: user.email }, space, person: publicPerson(person) });
});

/* Public invite preview: given a code, say which space it opens so the
   join form can confirm "You're joining 'X'" BEFORE any account exists.
   Only the space's name/kind and the owner's first name are exposed —
   the same things the share message itself already tells the invitee. */
app.get('/api/invite/:code', (req, res) => {
  const space = store.getSpaceByInvite(String(req.params.code).trim().toUpperCase());
  if (!space) return res.status(404).json({ error: 'Invite code not found.' });
  const owner = store.listPeople(space.id).find((p) => p.user_id && p.user_id === space.owner_id) || null;
  const ownerFirst = owner && owner.name ? String(owner.name).trim().split(/\s+/)[0] : null;
  res.json({ space: { name: space.name, kind: space.kind }, owner_first_name: ownerFirst });
});

/* Join with an invite: creates the account AND lands the new user in the
   invited space (their only space, so it's where they arrive). The code
   is validated before anything is created — a bad code creates no
   account — and the Terms agreement is enforced exactly as on signup. */
app.post('/api/auth/join', (req, res) => {
  const { email, password, name, code, birthday } = req.body || {};
  if (!email || !password || !name || !code) return res.status(400).json({ error: 'Name, email, password and invite code are required.' });
  if (!agreedToTerms(req.body)) {
    return res.status(400).json({ error: 'Please read and agree to the Terms of Use and Privacy Policy to create an account.' });
  }
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const space = store.getSpaceByInvite(String(code).trim().toUpperCase());
  if (!space) return res.status(404).json({ error: 'Invite code not found.' });
  if (store.getUserByEmail(String(email).toLowerCase())) return res.status(409).json({ error: 'That email already has an account.' });
  const { salt, hash } = hashPassword(String(password));
  const user = store.createUser({
    email: String(email).toLowerCase(), password_hash: hash, salt,
    terms_agreed_at: new Date().toISOString(), terms_version: TERMS_VERSION,
  });
  store.addMembership(user.id, space.id, 'member');
  const person = store.createPerson({
    space_id: space.id, user_id: user.id, name: String(name), email: user.email,
    birthday: birthday || null,
  });
  setSession(res, user.id);
  res.json({ user: { id: user.id, email: user.email }, space, person: publicPerson(person) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? store.getUserByEmail(String(email).toLowerCase()) : null;
  if (!user || !verifyPassword(String(password || ''), user.salt, user.password_hash)) {
    return res.status(401).json({ error: 'Email or password is wrong.' });
  }
  setSession(res, user.id);
  res.json({ user: { id: user.id, email: user.email } });
});

app.post('/api/auth/logout', (req, res) => { clearSession(req, res); res.json({ ok: true }); });

/* Password reset: "forgot" emails a one-hour, single-use link. The raw
   token only ever exists in the email — the store keeps its SHA-256 hash.
   The response is the same whether or not the email has an account, so
   the endpoint can't be used to probe who is signed up. */
app.post('/api/auth/forgot', async (req, res) => {
  const email = String((req.body || {}).email || '').toLowerCase();
  const user = email ? store.getUserByEmail(email) : null;
  if (user) {
    store.deleteResetTokensForUser(user.id);
    const raw = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    store.createResetToken({
      user_id: user.id, token_hash: tokenHash,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const base = process.env.APP_URL || `${proto}://${req.get('host')}`;
    await mailer.sendPasswordReset(user.email, `${base}/?reset=${raw}`);
  }
  res.json({ ok: true });
});

app.post('/api/auth/reset', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'A reset link and a new password are required.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const rec = store.getResetToken(tokenHash);
  if (!rec) return res.status(400).json({ error: 'That reset link isn\'t valid. Request a new one.' });
  if (new Date(rec.expires_at).getTime() < Date.now()) {
    store.deleteResetToken(tokenHash);
    return res.status(400).json({ error: 'That reset link has expired. Request a new one.' });
  }
  const { salt, hash } = hashPassword(String(password));
  store.updateUserPassword(rec.user_id, salt, hash);
  store.deleteResetTokensForUser(rec.user_id);
  store.deleteSessionsForUser(rec.user_id); // sign out everywhere; log in fresh
  res.json({ ok: true });
});

/* Change password while signed in. Other devices are signed out; this
   one stays signed in. */
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(String(currentPassword || ''), req.user.salt, req.user.password_hash)) {
    return res.status(401).json({ error: 'Your current password is wrong.' });
  }
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const { salt, hash } = hashPassword(String(newPassword));
  store.updateUserPassword(req.user.id, salt, hash);
  store.deleteSessionsForUser(req.user.id, currentToken(req));
  res.json({ ok: true });
});

/* Delete my account. Requires the password, takes a safety backup first,
   and removes the account from every Space it belongs to (see db.js for
   the per-space semantics: empty spaces are deleted, owned spaces pass
   to the earliest remaining member). */
app.delete('/api/account', requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (!verifyPassword(String(password || ''), req.user.salt, req.user.password_hash)) {
    return res.status(401).json({ error: 'Password is wrong — account not deleted.' });
  }
  backups.snapshot('pre-account-delete');
  const result = store.deleteAccount(req.user.id);
  clearSession(req, res);
  res.json({ ok: true, ...result });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const spaces = store.listSpacesForUser(req.user.id);
  const space = resolveSpace(req);
  const person = space ? store.getPersonInSpace(space.id, req.user.id) : null;
  res.json({ user: { id: req.user.id, email: req.user.email }, spaces, space, person: publicPerson(person) });
});

/* ---------------- spaces ---------------- */
app.get('/api/spaces', requireAuth, (req, res) => {
  res.json({ spaces: store.listSpacesForUser(req.user.id) });
});

app.post('/api/spaces', requireAuth, (req, res) => {
  const { name, kind } = req.body || {};
  const spaceKind = kind === 'family' ? 'family' : 'couple';
  const source = store.getAnyPersonForUser(req.user.id);
  const spaceName = String(name || '').trim() ||
    (source ? `${source.name}'s space` : 'Our space');
  const space = store.createSpace({ name: spaceName, kind: spaceKind, invite_code: inviteCode(), owner_id: req.user.id });
  store.addMembership(req.user.id, space.id, 'owner');
  const person = ensurePersonInSpace(space.id, req.user);
  res.json({ space: { ...space, role: 'owner', member_count: 1 }, person: publicPerson(person) });
});

app.post('/api/spaces/join', requireAuth, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'An invite code is required.' });
  const space = store.getSpaceByInvite(String(code).trim().toUpperCase());
  if (!space) return res.status(404).json({ error: 'Invite code not found.' });
  const alreadyMember = !!store.getMembership(req.user.id, space.id);
  if (!alreadyMember) store.addMembership(req.user.id, space.id, 'member');
  const person = ensurePersonInSpace(space.id, req.user);
  const mine = store.listSpacesForUser(req.user.id).find((s) => s.id === space.id);
  res.json({ space: mine || space, alreadyMember, person: publicPerson(person) });
});

/* Rename a space — owner only. Non-members get a 404 so the space's
   existence isn't leaked; members who aren't the owner get a 403. */
app.patch('/api/spaces/:id', requireAuth, (req, res) => {
  const space = store.getSpace(req.params.id);
  if (!space || !store.getMembership(req.user.id, space.id)) {
    return res.status(404).json({ error: 'Space not found.' });
  }
  if (space.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the space owner can rename it.' });
  }
  const name = String((req.body || {}).name || '').trim();
  if (!name || name.length > 60) {
    return res.status(400).json({ error: 'Give the space a name (1 to 60 characters).' });
  }
  store.updateSpaceName(space.id, name);
  const mine = store.listSpacesForUser(req.user.id).find((s) => s.id === space.id);
  res.json({ space: mine || store.getSpace(space.id) });
});

/* Delete a space — owner only. Removes the space and everything in it
   (memberships, people, messages, focuses, reminders, date ideas, weekly
   sets, daily activities) for everyone. The owner's account is untouched,
   and deleting your only space is allowed. */
app.delete('/api/spaces/:id', requireAuth, (req, res) => {
  const space = store.getSpace(req.params.id);
  if (!space || !store.getMembership(req.user.id, space.id)) {
    return res.status(404).json({ error: 'Space not found.' });
  }
  if (space.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the space owner can delete it.' });
  }
  store.deleteSpace(space.id);
  res.json({ ok: true });
});

/* ---------------- people / profiles ---------------- */
app.get('/api/people', requireAuth, requireSpace, (req, res) => {
  res.json({ people: store.listPeople(req.spaceId).map(publicPerson) });
});

app.post('/api/people', requireAuth, requireSpace, (req, res) => {
  const { name, email, birthday } = req.body || {};
  if (!name) return res.status(400).json({ error: 'A name is required.' });
  const person = store.createPerson({
    space_id: req.spaceId, name: String(name),
    email: email || null, birthday: birthday || null,
  });
  res.json({ person: publicPerson(person) });
});

const PROFILE_FIELDS = ['name', 'email', 'birthday', 'birth_city', 'birth_time', 'birth_time_unknown',
  'astrology_opt_in', 'love_language', 'attachment_style', 'personality_snapshot', 'fight_style',
  'calms_down', 'makes_worse', 'work_on', 'triggers', 'guide_tone', 'relationship_type',
  'together_duration', 'timezone'];

app.put('/api/people/:id', requireAuth, requireSpace, (req, res) => {
  const person = store.getPerson(req.params.id);
  if (!person || person.space_id !== req.spaceId) return res.status(404).json({ error: 'Person not found.' });
  const updates = {};
  for (const f of PROFILE_FIELDS) {
    if (req.body && f in req.body) {
      updates[f] = (f === 'birth_time_unknown' || f === 'astrology_opt_in') ? (req.body[f] ? 1 : 0) : req.body[f];
    }
  }
  if (updates.birth_time_unknown) updates.birth_time = null; // rising sign needs a real time
  if (req.body && req.body.finish === true) updates.profile_complete = 1;
  res.json({ person: publicPerson(store.updatePerson(person.id, updates)) });
});

/* ---------------- talk (shared chat) ---------------- */
app.get('/api/messages', requireAuth, requireSpace, async (req, res) => {
  await deliverDue(); // post anything whose time has come before showing the chat
  const people = store.listPeople(req.spaceId);
  const byId = Object.fromEntries(people.map((p) => [p.id, p.name]));
  const messages = store.listMessages(req.spaceId, 100).map((m) => ({
    ...m, author_name: m.kind === 'guide' ? 'Guide' : (byId[m.person_id] || 'Someone'),
  }));
  res.json({ messages });
});

app.post('/api/messages', requireAuth, requireSpace, async (req, res) => {
  const { text, sendAt } = req.body || {};
  const author = myPerson(req);
  if (!author) return res.status(400).json({ error: 'Finish setting up your profile first.' });
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Message is empty.' });
  let when = null;
  if (sendAt) {
    when = new Date(sendAt);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'That send time doesn\'t look right.' });
  }

  const people = store.listPeople(req.spaceId);
  const others = people.filter((p) => p.id !== author.id);
  const other = others[0] || null;

  // 1) Clean the raw draft. The raw text is NEVER stored — only the result.
  // The cleaned message posts with no marker: the rewording is disclosed in
  // the Talk tab, the signup agreement and the Terms instead.
  const cleaned = await ai.cleanMessage(String(text), author, people, req.space);
  const body = cleaned.text;

  // 1b) Scheduled send: keep the cleaned message private to the author and
  // post it when its time comes (see deliverDue above).
  if (when && when.getTime() > Date.now()) {
    const scheduled = store.addMessage({
      space_id: req.spaceId, person_id: author.id,
      kind: 'message', body, reworded: cleaned.changed ? 1 : 0,
      scheduled_for: when.toISOString(),
    });
    return res.json({ scheduled: { ...scheduled, author_name: author.name }, stub: cleaned.stub });
  }

  const posted = store.addMessage({
    space_id: req.spaceId, person_id: author.id,
    kind: 'message', body, reworded: cleaned.changed ? 1 : 0,
  });

  // 2) Guide advice reply.
  const recent = store.listMessages(req.spaceId, 10).map((m) => ({
    ...m, author_name: m.kind === 'guide' ? 'Guide' : (people.find((p) => p.id === m.person_id)?.name || 'Someone'),
  }));
  const advice = await ai.guideAdvice({ author, other, others, postedText: body, people, recentMessages: recent, space: req.space });
  const guideMsg = store.addMessage({
    space_id: req.spaceId, person_id: null, kind: 'guide', body: advice.text, reworded: 0,
  });

  res.json({
    posted: { ...posted, author_name: author.name },
    guide: { ...guideMsg, author_name: 'Guide' },
    stub: cleaned.stub || advice.stub,
  });
});

/* Scheduled messages: the author alone can see and cancel their own. */
app.get('/api/messages/scheduled', requireAuth, requireSpace, (req, res) => {
  const me = myPerson(req);
  if (!me) return res.json({ scheduled: [] });
  const scheduled = store.listScheduled(req.spaceId, me.id)
    .map((m) => ({ ...m, author_name: me.name }));
  res.json({ scheduled });
});

app.delete('/api/messages/scheduled/:id', requireAuth, requireSpace, (req, res) => {
  const me = myPerson(req);
  if (!me) return res.status(404).json({ error: 'Scheduled message not found.' });
  const mine = store.listScheduled(req.spaceId, me.id);
  if (!mine.some((m) => m.id === req.params.id)) {
    return res.status(404).json({ error: 'Scheduled message not found.' });
  }
  store.deleteMessage(req.params.id);
  res.json({ ok: true });
});

/* ---------------- together: reminders & date ideas ---------------- */
app.get('/api/reminders', requireAuth, requireSpace, (req, res) => {
  res.json({ reminders: store.listReminders(req.spaceId) });
});
app.post('/api/reminders', requireAuth, requireSpace, (req, res) => {
  const { text, personId } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Reminder text is required.' });
  res.json({ reminder: store.addReminder({ space_id: req.spaceId, person_id: personId || null, text: String(text) }) });
});
app.patch('/api/reminders/:id', requireAuth, (req, res) => {
  store.setReminderDone(req.params.id, !!(req.body && req.body.done));
  res.json({ ok: true });
});

app.get('/api/date-ideas', requireAuth, requireSpace, (req, res) => {
  res.json({ ideas: store.listDateIdeas(req.spaceId) });
});
app.post('/api/date-ideas', requireAuth, requireSpace, (req, res) => {
  const { title, category, notes } = req.body || {};
  if (!title) return res.status(400).json({ error: 'An idea title is required.' });
  res.json({ idea: store.addDateIdea({ space_id: req.spaceId, title: String(title), category, notes }) });
});
app.delete('/api/date-ideas/:id', requireAuth, (req, res) => {
  store.deleteDateIdea(req.params.id);
  res.json({ ok: true });
});

/* ---------------- daily focuses + weekly/daily content ---------------- */
app.get('/api/focuses', requireAuth, requireSpace, async (req, res) => {
  const people = store.listPeople(req.spaceId);
  const dateKey = todayKey();
  const me = myPerson(req);
  const focuses = [];
  for (const person of people) {
    let focus = store.getDailyFocus(req.spaceId, person.id, dateKey);
    if (!focus) {
      const partner = people.find((p) => p.id !== person.id) || null;
      const { text } = await ai.dailyFocus(person, partner, people, req.space);
      focus = store.saveDailyFocus(req.spaceId, person.id, dateKey, text);
    }
    /* Focuses are private: a focus is still generated for every person
       in the space, but the API only ever returns the requester's own. */
    if (me && person.id === me.id) {
      focuses.push({ ...focus, person_name: person.name });
    }
  }
  res.json({ focuses });
});
/* Toggle a focus's done state — only its owner can. A focus in a space
   the requester has no profile in gets a 404 so its existence isn't
   leaked; a fellow member of the space gets a 403 (same conventions
   as rename/delete space). */
app.patch('/api/focuses/:id', requireAuth, (req, res) => {
  const focus = store.getDailyFocusById(req.params.id);
  if (!focus) return res.status(404).json({ error: 'Focus not found.' });
  const me = store.getPersonInSpace(focus.space_id, req.user.id);
  if (!me) return res.status(404).json({ error: 'Focus not found.' });
  if (focus.person_id !== me.id) {
    return res.status(403).json({ error: 'You can only update your own focus.' });
  }
  store.setDailyFocusDone(focus.id, !!(req.body && req.body.done));
  res.json({ ok: true });
});

app.get('/api/weekly', requireAuth, requireSpace, (req, res) => {
  const hid = req.spaceId;
  const weekKey = ai.weekKeyOf();
  let ideas = store.getWeeklySet(hid, weekKey, 'date_ideas');
  if (!ideas) ideas = store.saveWeeklySet(hid, weekKey, 'date_ideas', ai.weeklyDateIdeas(weekKey));
  let activity = store.getWeeklySet(hid, weekKey, 'activity');
  if (!activity) activity = store.saveWeeklySet(hid, weekKey, 'activity', ai.weeklyActivity(weekKey));
  const dateKey = todayKey();
  let daily = store.getDailyActivity(hid, dateKey);
  if (!daily) daily = store.saveDailyActivity(hid, dateKey, ai.dailyActivity(dateKey));
  res.json({ weekKey, weeklyDateIdeas: ideas.payload, weeklyActivity: activity.payload, dailyActivity: daily });
});

/* ---------------- health & static ---------------- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: store.mode, ai: ai.STUB ? 'stub' : 'gemini', model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', backups: backups.status() });
});

/* Owner-only operations, gated by the ADMIN_SECRET env var and the
   x-admin-secret header. With no secret configured these routes do not
   exist (404). They let the owner pull an off-site backup copy and
   recover a locked-out tester's account during the testing phase. */
function adminOk(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.get('x-admin-secret') || '');
  const expected = Buffer.from(secret);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
app.get('/api/admin/backup', (req, res) => {
  if (!adminOk(req)) return res.status(404).end();
  const file = backups.mainFile();
  if (!file) return res.status(404).json({ error: 'No data file yet.' });
  res.download(file, path.basename(file));
});
app.post('/api/admin/snapshot', (req, res) => {
  if (!adminOk(req)) return res.status(404).end();
  res.json({ ok: true, snapshot: backups.snapshot('admin') });
});
app.post('/api/admin/reset-password', (req, res) => {
  if (!adminOk(req)) return res.status(404).end();
  const { email, newPassword } = req.body || {};
  const user = email ? store.getUserByEmail(String(email).toLowerCase()) : null;
  if (!user) return res.status(404).json({ error: 'No account with that email.' });
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const { salt, hash } = hashPassword(String(newPassword));
  store.updateUserPassword(user.id, salt, hash);
  store.deleteResetTokensForUser(user.id);
  store.deleteSessionsForUser(user.id);
  res.json({ ok: true });
});

/* Web assets (index.html, app.js, styles.css, ...) live in this same folder.
   Never serve the server-side code, dependencies, or the data directory. */
const BLOCKED_PATHS = new Set(['/server.js', '/db.js', '/ai.js', '/astro.js',
  '/backups.js', '/mailer.js',
  '/package.json', '/package-lock.json', '/render.yaml', '/README.md',
  '/.env.example', '/.gitignore']);
app.use((req, res, next) => {
  if (BLOCKED_PATHS.has(req.path) || req.path === '/data' ||
      req.path.startsWith('/data/') || req.path.startsWith('/node_modules/')) {
    return res.status(404).end();
  }
  next();
});
app.use(express.static(__dirname, { index: false }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

backups.start();

app.listen(PORT, () => {
  console.log(`Us, Guided listening on http://localhost:${PORT} (db: ${store.mode}, ai: ${ai.STUB ? 'STUB' : 'Gemini'})`);
});
