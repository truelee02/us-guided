'use strict';
/* Us, Guided — vanilla client. */

const $ = (sel) => document.querySelector(sel);
const api = async (method, url, body) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  // Tell the server which space we're looking at; without it the server
  // falls back to our earliest space.
  if (state.activeSpaceId) headers['X-Space-Id'] = state.activeSpaceId;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = {
  me: null, people: [], messages: [], spaces: [],
  activeSpaceId: localStorage.getItem('ug-active-space') || null,
  myPersonId: null,
};
const activeSpace = () => state.spaces.find((s) => s.id === state.activeSpaceId) || state.spaces[0] || null;

/* Space relationship types — mirrors types.js on the server. The type
   drives the Guide's tone, focuses and Together ideas for the space. */
const SPACE_TYPES = {
  partner: { name: 'Romantic partner', icon: '💑' },
  coparent: { name: 'Co-parents', icon: '🧒' },
  parent_child: { name: 'Parent & child', icon: '👨‍👧' },
  family: { name: 'Family', icon: '👨‍👩‍👧' },
  friends: { name: 'Friends', icon: '🎉' },
  roommates: { name: 'Roommates', icon: '🏠' },
  caregivers: { name: 'Caregivers', icon: '💛' },
};
const typeOf = (space) => SPACE_TYPES[space?.kind] || SPACE_TYPES.partner; // legacy 'couple' reads as partner
const typeName = (space) => typeOf(space).name;

/* The no-space state (reachable by deleting your only space): clear the
   per-space panels and point at the Us tab, where spaces are made/joined. */
function showNoSpace() {
  $('#messages').innerHTML = '<p class="muted">You don\'t have a space open right now. Create one, or join one with an invite code, in the Us tab.</p>';
  $('#focus-cards').innerHTML = '';
  $('#scheduled-strip').hidden = true;
  $('#scheduled-list').innerHTML = '';
  $('#people-list').innerHTML = '';
  $('#invite-code').textContent = '—';
  $('#active-space-name').textContent = 'this space';
}

/* ================= Quizzes ================= */
const LOVE_QUIZ = [
  { q: 'I feel most loved when my partner…', options: [
    ['Words of Affirmation', 'tells me they appreciate me'],
    ['Physical Touch', 'pulls me in for a hug'],
    ['Acts of Service', 'does something helpful without being asked'],
    ['Quality Time', 'spends real, uninterrupted time with me'],
    ['Receiving Gifts', 'surprises me with something small'],
  ]},
  { q: 'On a hard day, what helps most?', options: [
    ['Physical Touch', 'Being held, no talking needed'],
    ['Words of Affirmation', 'Hearing "I\'ve got you, it\'s going to be okay"'],
    ['Acts of Service', 'Them quietly taking something off my plate'],
    ['Quality Time', 'Them sitting with me, phones away'],
    ['Receiving Gifts', 'A little treat showing they thought of me'],
  ]},
  { q: 'I wish my partner would more often…', options: [
    ['Words of Affirmation', 'say what they like about me, out loud'],
    ['Quality Time', 'plan time that is just us'],
    ['Physical Touch', 'reach for my hand or sit close'],
    ['Receiving Gifts', 'bring home small surprises'],
    ['Acts of Service', 'notice what needs doing and just do it'],
  ]},
  { q: 'What makes you feel closest to your partner?', options: [
    ['Quality Time', 'A long, real conversation'],
    ['Physical Touch', 'Cuddling on the couch'],
    ['Words of Affirmation', 'A heartfelt note or text'],
    ['Acts of Service', 'Seeing them handle something I was dreading'],
    ['Receiving Gifts', 'A gift that shows they really know me'],
  ]},
  { q: 'Pick the best kind of date:', options: [
    ['Acts of Service', 'They cook my favorite meal, start to finish'],
    ['Receiving Gifts', 'A surprise outing they planned and paid for'],
    ['Quality Time', 'A slow walk and talking, nowhere to be'],
    ['Words of Affirmation', 'Dinner where they tell me why they chose me'],
    ['Physical Touch', 'Dancing in the kitchen to our songs'],
  ]},
];

const ATTACHMENT_QUIZ = [
  { q: 'When my partner doesn\'t reply for hours, I usually…', options: [
    ['Secure', 'assume they\'re busy and get on with my day'],
    ['Anxious', 'check my phone a lot and worry something is wrong'],
    ['Avoidant', 'barely notice — I like my own space'],
    ['Fearful', 'swing between worrying and telling myself I don\'t care'],
  ]},
  { q: 'In an argument, my instinct is to…', options: [
    ['Anxious', 'fix it right now, even if it gets heated'],
    ['Secure', 'talk it through, or take a break and come back calmly'],
    ['Fearful', 'panic that the relationship is ending'],
    ['Avoidant', 'shut down or leave until it blows over'],
  ]},
  { q: 'Getting really close to someone feels…', options: [
    ['Secure', 'good — closeness is comfortable'],
    ['Avoidant', 'a bit suffocating after a while'],
    ['Anxious', 'great, but I worry it won\'t last'],
    ['Fearful', 'something I want and fear at the same time'],
  ]},
  { q: 'When I\'m upset, what I want most is…', options: [
    ['Anxious', 'reassurance, right away, that we\'re okay'],
    ['Fearful', 'comfort — but I\'m not sure I can trust it'],
    ['Secure', 'to talk when I\'m ready and be heard'],
    ['Avoidant', 'space to sort it out on my own first'],
  ]},
  { q: 'Asking for what I need feels…', options: [
    ['Avoidant', 'uncomfortable — I\'d rather handle it myself'],
    ['Secure', 'normal — my needs are allowed'],
    ['Fearful', 'risky — it might push them away or start a fight'],
    ['Anxious', 'urgent — if I don\'t ask, I\'ll stew about it'],
  ]},
];

function renderQuiz(container, quiz, name) {
  container.innerHTML = quiz.map((item, qi) => `
    <div class="quiz-q">
      <p><strong>${qi + 1}.</strong> ${esc(item.q)}</p>
      ${item.options.map(([tag, label]) => `
        <label class="radio"><input type="radio" name="${name}-${qi}" value="${esc(tag)}"> ${esc(label)}</label>`).join('')}
    </div>`).join('');
}
function scoreQuiz(quiz, name) {
  const counts = {};
  let answered = 0;
  quiz.forEach((_, qi) => {
    const picked = document.querySelector(`input[name="${name}-${qi}"]:checked`);
    if (picked) { counts[picked.value] = (counts[picked.value] || 0) + 1; answered++; }
  });
  if (!answered) return null;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/* ================= Auth ================= */
function showAuth(which) {
  document.querySelectorAll('[data-auth-tab]').forEach((b) => b.classList.toggle('active', b.dataset.authTab === which));
  $('#login-form').hidden = which !== 'login';
  $('#signup-form').hidden = which !== 'signup';
  $('#forgot-form').hidden = which !== 'forgot';
  $('#reset-form').hidden = which !== 'reset';
  $('#forgot-row').hidden = which !== 'login';
  $('#auth-error').hidden = true;
}
document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
  btn.addEventListener('click', () => showAuth(btn.dataset.authTab));
});

function authError(msg) { const el = $('#auth-error'); el.textContent = msg; el.hidden = false; }
function authNote(msg) { const el = $('#auth-note'); el.textContent = msg; el.hidden = false; }

/* Forgot / reset password */
let resetToken = new URLSearchParams(location.search).get('reset');
$('#forgot-link').addEventListener('click', (e) => { e.preventDefault(); showAuth('forgot'); });
document.querySelectorAll('.back-to-login').forEach((a) => {
  a.addEventListener('click', (e) => { e.preventDefault(); showAuth('login'); });
});
$('#forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = new FormData(e.target).get('email');
  try { await api('POST', '/api/auth/forgot', { email }); } catch (_) { /* same note either way */ }
  showAuth('login');
  authNote('If that email has an account, a password reset link is on its way. It expires in 1 hour.');
});
$('#reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  if (fd.get('password') !== fd.get('password2')) { authError('The two passwords don\'t match.'); return; }
  try {
    await api('POST', '/api/auth/reset', { token: resetToken, password: fd.get('password') });
    resetToken = null;
    history.replaceState({}, '', location.pathname);
    e.target.reset();
    showAuth('login');
    authNote('Password updated — log in with your new password.');
  } catch (err) { authError(err.message); }
});
if (resetToken) showAuth('reset');

async function handleAuth(formId, url) {
  const form = $(formId);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', url, Object.fromEntries(new FormData(form)));
      await boot();
    } catch (err) { authError(err.message); }
  });
}
handleAuth('#login-form', '/api/auth/login');

/* Sign up — one form, two outcomes. The invite-code box at the top is
   optional: leave it blank and it's a plain signup (account + your own
   first space). Put a code in and the SAME form joins that Space as it
   creates the account: the code is checked against the public preview
   endpoint as it's typed, so the form can say "You're joining 'X'"
   before anything is created, and on submit it's checked once more — a
   code that's present but wrong is a hard stop, never a silent solo
   signup. After a join, the invited space is made the active one, so
   the new user lands inside it — never in a space of their own. */
let pendingWelcome = null;
async function lookupInvite(code) {
  const res = await fetch(`/api/invite/${encodeURIComponent(code)}`);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}
function showSignupInfo(ok, text) {
  const el = $('#signup-space-info');
  el.textContent = text;
  el.className = ok ? 'small note' : 'small error';
  el.hidden = false;
}
$('#signup-code').addEventListener('input', () => { $('#signup-space-info').hidden = true; });
$('#signup-code').addEventListener('blur', async () => {
  const code = $('#signup-code').value.trim().toUpperCase();
  if (!code) { $('#signup-space-info').hidden = true; return; }
  const found = await lookupInvite(code);
  if (!found) {
    showSignupInfo(false, 'That code doesn\'t match any Space — check it and try again, or clear the box to start your own Space.');
    return;
  }
  const who = found.owner_first_name ? ` (${found.owner_first_name}'s Space)` : '';
  const what = found.space.kind_name ? ` — a ${found.space.kind_name} Space` : '';
  showSignupInfo(true, `You're joining '${found.space.name}'${what}${who}.`);
});
$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form));
  const code = String(body.code || '').trim().toUpperCase();
  if (!code) {
    // Plain signup — no code, no join; the account gets its own space.
    try {
      await api('POST', '/api/auth/signup', body);
      await boot();
    } catch (err) { authError(err.message); }
    return;
  }
  const found = await lookupInvite(code);
  if (!found) {
    showSignupInfo(false, 'That code doesn\'t match any Space — check it and try again, or clear the box to start your own Space. No account was created.');
    return;
  }
  try {
    const data = await api('POST', '/api/auth/join', { ...body, code });
    if (data.space?.id) {
      state.activeSpaceId = data.space.id;
      localStorage.setItem('ug-active-space', data.space.id);
      pendingWelcome = data.space;
    }
    await boot();
    if (pendingWelcome) {
      const el = $('#welcome-note');
      el.textContent = `💜 You're in '${pendingWelcome.name}' — the Space you were invited to. This is your shared chat with your people; say hello below.`;
      el.hidden = false;
      pendingWelcome = null;
    }
  } catch (err) { authError(err.message); }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  location.reload();
});

/* ================= Tabs ================= */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    ['talk', 'together', 'us'].forEach((t) => { $(`#tab-${t}`).hidden = t !== btn.dataset.tab; });
    if (btn.dataset.tab === 'together') loadTogether();
    if (btn.dataset.tab === 'us') loadPeople();
  });
});

/* ================= Talk ================= */
async function loadFocuses() {
  if (!state.activeSpaceId) { $('#focus-cards').innerHTML = ''; return; }
  const { focuses } = await api('GET', '/api/focuses');
  $('#focus-cards').innerHTML = focuses.map((f) => `
    <div class="card focus-card">
      <label class="check">
        <input type="checkbox" data-focus="${f.id}" ${f.done ? 'checked' : ''}>
        <span><strong>Today's focus — ${esc(f.person_name)}:</strong> ${esc(f.text)}</span>
      </label>
    </div>`).join('');
  document.querySelectorAll('[data-focus]').forEach((cb) => {
    cb.addEventListener('change', () => api('PATCH', `/api/focuses/${cb.dataset.focus}`, { done: cb.checked }));
  });
}

async function loadMessages() {
  if (!state.activeSpaceId) return;
  const { messages } = await api('GET', '/api/messages');
  state.messages = messages;
  const mine = state.myPersonId;
  $('#messages').innerHTML = messages.map((m) => `
    <div class="msg ${m.kind === 'guide' ? 'guide' : (m.person_id === mine ? 'mine' : 'theirs')}">
      <div class="msg-author">${esc(m.author_name)}${m.reworded ? '' : ''}</div>
      <div class="msg-body">${esc(m.body)}</div>
    </div>`).join('') || '<p class="muted">No messages yet. Say the first thing — the Guide will help it land kindly.</p>';
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ta = $('#composer-text');
  const typed = ta.value;
  const text = typed.trim();
  if (!text) return;
  const err = $('#talk-error');
  err.hidden = true;
  const sendBtn = $('#send-btn');
  ta.disabled = true;
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending...';
  try {
    await api('POST', '/api/messages', { text });
    ta.value = '';
    await loadMessages();
  } catch (e2) {
    // A failed send must never fail silently: say so, and put the words
    // back in the box so nothing the user wrote is lost.
    err.textContent = 'That message did not send. Check your connection and try again.';
    err.hidden = false;
    ta.value = typed;
  } finally {
    ta.disabled = false;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    ta.focus();
  }
});

/* ================= Scheduled messages ================= */
let pickedSendAt = null;

function fmtWhen(iso) {
  return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function setPicked(date) {
  pickedSendAt = date;
  $('#schedule-at').value = toLocalInput(date);
  $('#schedule-preview').textContent = `Will post ${fmtWhen(date.toISOString())} — only you can see it until then.`;
}

$('#schedule-toggle').addEventListener('click', () => {
  const panel = $('#schedule-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    $('#schedule-at').min = toLocalInput(new Date());
    if (!pickedSendAt) setPicked(new Date(Date.now() + 60 * 60 * 1000));
  }
});
$('#schedule-cancel').addEventListener('click', () => { $('#schedule-panel').hidden = true; });
document.querySelectorAll('[data-sched]').forEach((b) => {
  b.addEventListener('click', () => {
    const now = new Date();
    let d;
    if (b.dataset.sched === '1h') d = new Date(now.getTime() + 60 * 60 * 1000);
    else if (b.dataset.sched === 'tonight') { d = new Date(now); d.setHours(20, 0, 0, 0); if (d <= now) d.setDate(d.getDate() + 1); }
    else { d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); }
    setPicked(d);
  });
});
$('#schedule-at').addEventListener('change', (e) => {
  if (!e.target.value) return;
  pickedSendAt = new Date(e.target.value);
  $('#schedule-preview').textContent = `Will post ${fmtWhen(pickedSendAt.toISOString())} — only you can see it until then.`;
});
$('#schedule-confirm').addEventListener('click', async () => {
  const ta = $('#composer-text');
  const text = ta.value.trim();
  const err = $('#talk-error');
  err.hidden = true;
  if (!text) { err.textContent = 'Write your message first, then schedule it.'; err.hidden = false; return; }
  if (!pickedSendAt || pickedSendAt.getTime() <= Date.now()) {
    err.textContent = 'Pick a time in the future.'; err.hidden = false; return;
  }
  try {
    await api('POST', '/api/messages', { text, sendAt: pickedSendAt.toISOString() });
    ta.value = '';
    $('#schedule-panel').hidden = true;
    pickedSendAt = null;
    await loadScheduled();
  } catch (e2) { err.textContent = e2.message; err.hidden = false; }
});

async function loadScheduled() {
  if (!state.activeSpaceId) { $('#scheduled-strip').hidden = true; return; }
  const { scheduled } = await api('GET', '/api/messages/scheduled');
  $('#scheduled-strip').hidden = !scheduled.length;
  $('#scheduled-list').innerHTML = scheduled.map((m) => `
    <div class="sched-row">
      <span class="sched-body">${esc(m.body)}</span>
      <span class="muted small">posts ${esc(fmtWhen(m.scheduled_for))}</span>
      <button class="ghost small-btn" data-cancel-sched="${m.id}">Cancel</button>
    </div>`).join('');
  document.querySelectorAll('[data-cancel-sched]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api('DELETE', `/api/messages/scheduled/${b.dataset.cancelSched}`);
      loadScheduled();
    });
  });
}

/* ================= Together ================= */
async function loadTogether() {
  if (!state.activeSpaceId) return;
  const [rem, ideas, weekly] = await Promise.all([
    api('GET', '/api/reminders'), api('GET', '/api/date-ideas'), api('GET', '/api/weekly'),
  ]);
  const together = weekly.together || {};
  $('#weekly-ideas-title').textContent = together.heading || '🎲 This week\'s ideas';
  $('#saved-ideas-title').textContent = together.savedHeading || '💡 Saved ideas';
  $('#daily-activity-title').textContent = together.dailyHeading || '🌱 Today\'s connection activity';
  if (Array.isArray(together.categories) && together.categories.length) {
    const current = $('#idea-category').value;
    $('#idea-category').innerHTML = together.categories.map((c) =>
      `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (together.categories.includes(current)) $('#idea-category').value = current;
  }
  $('#daily-activity').textContent = weekly.dailyActivity?.text || '—';
  const wa = weekly.weeklyActivity || {};
  $('#weekly-activity').innerHTML = `<strong>${esc(wa.title || '')}</strong> <span class="badge">${esc(wa.type || '')}</span><br>${esc(wa.body || '')}`;
  $('#weekly-ideas').innerHTML = (weekly.weeklyDateIdeas || []).map((d) =>
    `<li><strong>${esc(d.category)}:</strong> ${esc(d.idea)}</li>`).join('');

  const byId = Object.fromEntries(state.people.map((p) => [p.id, p.name]));
  $('#reminders').innerHTML = rem.reminders.length ? rem.reminders.map((r) => `
    <label class="check reminder">
      <input type="checkbox" data-reminder="${r.id}" ${r.done ? 'checked' : ''}>
      <span class="${r.done ? 'done' : ''}">${esc(r.text)}${r.person_id ? ` <em class="muted">(${esc(byId[r.person_id] || '')})</em>` : ''}</span>
    </label>`).join('') : '<p class="muted">No reminders yet.</p>';
  document.querySelectorAll('[data-reminder]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      await api('PATCH', `/api/reminders/${cb.dataset.reminder}`, { done: cb.checked });
      loadTogether();
    });
  });
  $('#reminder-person').innerHTML = state.people.map((p) =>
    `<option value="${p.id}">${esc(p.name)}</option>`).join('');

  $('#date-ideas').innerHTML = ideas.ideas.length ? ideas.ideas.map((d) => `
    <li><strong>${esc(d.category || '')}:</strong> ${esc(d.title)}
      <button class="ghost small-btn" data-del-idea="${d.id}">✕</button></li>`).join('')
    : '<li class="muted">No saved ideas yet.</li>';
  document.querySelectorAll('[data-del-idea]').forEach((b) => {
    b.addEventListener('click', async () => { await api('DELETE', `/api/date-ideas/${b.dataset.delIdea}`); loadTogether(); });
  });
}

$('#reminder-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('POST', '/api/reminders', { text: $('#reminder-text').value, personId: $('#reminder-person').value || null });
  $('#reminder-text').value = '';
  loadTogether();
});
$('#idea-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('POST', '/api/date-ideas', { title: $('#idea-title').value, category: $('#idea-category').value });
  $('#idea-title').value = '';
  loadTogether();
});

/* ================= Us / profiles ================= */
async function loadPeople() {
  if (!state.activeSpaceId) {
    state.people = [];
    state.myPersonId = null;
    $('#people-list').innerHTML = '';
    $('#invite-code').textContent = '—';
    $('#active-space-name').textContent = 'this space';
    return;
  }
  const { people } = await api('GET', '/api/people');
  state.people = people;
  const mine = people.find((p) => p.user_id === state.me?.user?.id) || null;
  state.myPersonId = mine ? mine.id : null;
  const space = activeSpace();
  $('#invite-code').textContent = space?.invite_code || '—';
  $('#active-space-name').textContent = space?.name || 'this space';
  wireInvite();
  $('#people-list').innerHTML = people.map((p) => `
    <div class="card person-card">
      <h3>${esc(p.name)} ${p.id === state.myPersonId ? '<span class="badge">you</span>' : ''}</h3>
      <ul class="plain-list small">
        ${p.birthday ? `<li>🎂 ${esc(p.birthday)}${p.sun_sign ? ` · ☀️ ${esc(p.sun_sign)}${p.rising_sign ? ` · ⬆️ rising ${esc(p.rising_sign)}` : ''}` : ''}</li>` : ''}
        ${p.love_language ? `<li>💗 Love language: ${esc(p.love_language)}</li>` : ''}
        ${p.attachment_style ? `<li>🧭 Attachment: ${esc(p.attachment_style)}</li>` : ''}
        ${p.work_on ? `<li>🎯 Working on: ${esc(p.work_on)}</li>` : ''}
      </ul>
      <button class="primary" data-edit-person="${p.id}">${p.profile_complete ? 'Edit profile' : 'Finish profile'}</button>
    </div>`).join('');
  document.querySelectorAll('[data-edit-person]').forEach((b) => {
    b.addEventListener('click', () => openProfile(state.people.find((p) => p.id === b.dataset.editPerson)));
  });
}

/* ================= Invite sharing =================
   One tap opens the phone's own share sheet (Messages, Mail, WhatsApp, …)
   with the app link and invite code already written out — the app itself
   never sees or contacts the person being invited. Where the share sheet
   isn't available, Text / Email / Copy options appear instead. */
function inviteText() {
  const space = activeSpace();
  const code = space?.invite_code || '';
  const where = space?.name ? `my "${space.name}" space` : 'my space';
  return `Join me on Us, Guided 💜 — a shared space with an AI guide that helps us talk things through.\n\n1. Go to ${location.host}\n2. Tap "Sign up"\n3. Put this code in the invite-code box at the top of the form: ${code}\n\nThat code joins ${where} — you'll land right in it with me.`;
}
function wireInvite() {
  if (!activeSpace()?.invite_code) return;
  const text = inviteText();
  $('#invite-sms').href = `sms:?&body=${encodeURIComponent(text)}`;
  $('#invite-mail').href = `mailto:?subject=${encodeURIComponent('Join me on Us, Guided')}&body=${encodeURIComponent(text)}`;
}

/* ================= Spaces =================
   One account, many spaces. The switcher at the top picks the active
   space; every tab reloads for it, and the choice is remembered on this
   device (localStorage) so the app reopens where you left it. */
function renderSwitcher() {
  const sel = $('#space-switcher');
  sel.innerHTML = state.spaces.map((s) =>
    `<option value="${s.id}" ${s.id === state.activeSpaceId ? 'selected' : ''}>${esc(s.name)} ${typeOf(s).icon}</option>`).join('');
}

function renderSpaces() {
  renderSwitcher();
  $('#spaces-list').innerHTML = state.spaces.map((s) => `
    <div class="space-item">
      <div class="space-row ${s.id === state.activeSpaceId ? 'active' : ''}">
        <span class="space-row-main">
          <strong>${esc(s.name)}</strong>
          <span class="badge">${typeOf(s).icon} ${esc(typeName(s))}</span>
          ${s.role === 'owner' ? '<span class="badge">owner</span>' : ''}
          <br><span class="muted small">${s.member_count} member${s.member_count === 1 ? '' : 's'} · invite code <strong>${esc(s.invite_code)}</strong></span>
        </span>
        ${s.id === state.activeSpaceId
          ? '<span class="muted small">viewing</span>'
          : `<button type="button" class="ghost small-btn" data-switch-space="${s.id}">Switch</button>`}
        ${s.role === 'owner' ? `<span class="space-row-actions">
          <button type="button" class="ghost small-btn" data-rename-space="${s.id}">Rename</button>
          <button type="button" class="ghost small-btn" data-type-space="${s.id}">Kind</button>
          <button type="button" class="ghost small-btn" data-delete-space="${s.id}">Delete</button>
        </span>` : ''}
      </div>
      ${s.role === 'owner' ? `
      <div class="space-edit" data-type-panel="${s.id}" hidden>
        <label class="small">What kind of Space is this?
          <select data-type-input="${s.id}" aria-label="Kind of this space">
            ${Object.entries(SPACE_TYPES).map(([key, t]) => `<option value="${key}" ${key === s.kind ? 'selected' : ''}>${t.icon} ${esc(t.name)}</option>`).join('')}
          </select>
        </label>
        <button type="button" class="primary small-btn" data-type-save="${s.id}">Save kind</button>
        <button type="button" class="ghost small-btn" data-type-cancel="${s.id}">Cancel</button>
        <p class="muted small">The kind shapes the Guide's focuses, ideas and activities for this space.</p>
      </div>
      <div class="space-edit" data-rename-panel="${s.id}" hidden>
        <input type="text" maxlength="60" value="${esc(s.name)}" data-rename-input="${s.id}" aria-label="New name for this space">
        <button type="button" class="primary small-btn" data-rename-save="${s.id}">Save name</button>
        <button type="button" class="ghost small-btn" data-rename-cancel="${s.id}">Cancel</button>
      </div>
      <div class="space-edit" data-delete-panel="${s.id}" hidden>
        <p class="small">Delete <strong>${esc(s.name)}</strong>? Deleting permanently removes the space and its conversations for everyone in it, and cannot be undone.</p>
        <button type="button" class="danger" data-delete-confirm="${s.id}">Yes, delete this space</button>
        <button type="button" class="ghost small-btn" data-delete-cancel="${s.id}">Keep it</button>
      </div>` : ''}
    </div>`).join('');
  document.querySelectorAll('[data-switch-space]').forEach((b) => {
    b.addEventListener('click', () => switchSpace(b.dataset.switchSpace));
  });
  document.querySelectorAll('[data-rename-space]').forEach((b) => {
    b.addEventListener('click', () => {
      const panel = document.querySelector(`[data-rename-panel="${b.dataset.renameSpace}"]`);
      panel.hidden = false;
      panel.querySelector('input').focus();
    });
  });
  document.querySelectorAll('[data-rename-cancel]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelector(`[data-rename-panel="${b.dataset.renameCancel}"]`).hidden = true;
    });
  });
  document.querySelectorAll('[data-rename-save]').forEach((b) => {
    b.addEventListener('click', () => renameSpace(b.dataset.renameSave));
  });
  document.querySelectorAll('[data-type-space]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelector(`[data-type-panel="${b.dataset.typeSpace}"]`).hidden = false;
    });
  });
  document.querySelectorAll('[data-type-cancel]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelector(`[data-type-panel="${b.dataset.typeCancel}"]`).hidden = true;
    });
  });
  document.querySelectorAll('[data-type-save]').forEach((b) => {
    b.addEventListener('click', () => changeSpaceType(b.dataset.typeSave));
  });
  document.querySelectorAll('[data-delete-space]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelector(`[data-delete-panel="${b.dataset.deleteSpace}"]`).hidden = false;
    });
  });
  document.querySelectorAll('[data-delete-cancel]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelector(`[data-delete-panel="${b.dataset.deleteCancel}"]`).hidden = true;
    });
  });
  document.querySelectorAll('[data-delete-confirm]').forEach((b) => {
    b.addEventListener('click', () => deleteSpace(b.dataset.deleteConfirm));
  });
}

async function renameSpace(spaceId) {
  const input = document.querySelector(`[data-rename-input="${spaceId}"]`);
  const name = (input?.value || '').trim();
  const msg = $('#space-msg');
  if (!name) {
    msg.textContent = 'Give the space a name first.';
    msg.className = 'small error';
    msg.hidden = false;
    return;
  }
  try {
    await api('PATCH', `/api/spaces/${spaceId}`, { name });
    await refreshSpaces();
    await loadPeople(); // keeps the invite card's space name current
    msg.textContent = `Renamed to "${name}".`;
    msg.className = 'small note';
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'small error';
  }
  msg.hidden = false;
}

async function changeSpaceType(spaceId) {
  const select = document.querySelector(`[data-type-input="${spaceId}"]`);
  const kind = select?.value;
  const msg = $('#space-msg');
  if (!kind || !SPACE_TYPES[kind]) {
    msg.textContent = 'Pick a kind first.';
    msg.className = 'small error';
    msg.hidden = false;
    return;
  }
  try {
    const { space } = await api('PATCH', `/api/spaces/${spaceId}`, { kind });
    await refreshSpaces();
    if (!$('#tab-together').hidden) loadTogether(); // headings + ideas follow the new kind
    msg.textContent = `"${space.name}" is now a ${typeName(space)} Space — the Guide's focuses and ideas will match.`;
    msg.className = 'small note';
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'small error';
  }
  msg.hidden = false;
}

async function deleteSpace(spaceId) {
  const msg = $('#space-msg');
  const wasActive = state.activeSpaceId === spaceId;
  try {
    await api('DELETE', `/api/spaces/${spaceId}`);
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'small error';
    msg.hidden = false;
    return;
  }
  await refreshSpaces(); // re-points activeSpaceId at a remaining space, or null
  if (!state.spaces.length) {
    state.activeSpaceId = null;
    localStorage.removeItem('ug-active-space');
    renderSpaces();
    showNoSpace();
    msg.textContent = 'Space deleted. That was your only space — create a new one above, or join one with an invite code.';
  } else {
    if (wasActive) await switchSpace(state.activeSpaceId);
    else renderSpaces();
    msg.textContent = 'Space deleted.';
  }
  msg.className = 'small note';
  msg.hidden = false;
}

async function refreshSpaces() {
  const { spaces } = await api('GET', '/api/spaces');
  state.spaces = spaces;
  if (!state.spaces.some((s) => s.id === state.activeSpaceId)) {
    state.activeSpaceId = state.spaces[0]?.id || null;
  }
  renderSpaces();
}

async function switchSpace(spaceId) {
  if (!state.spaces.some((s) => s.id === spaceId)) return;
  state.activeSpaceId = spaceId;
  localStorage.setItem('ug-active-space', spaceId);
  renderSpaces();
  await loadPeople();
  await loadFocuses();
  await loadMessages();
  await loadScheduled();
  if (!$('#tab-together').hidden) loadTogether();
}

$('#space-switcher').addEventListener('change', (e) => switchSpace(e.target.value));
$('#new-space-btn').addEventListener('click', () => {
  document.querySelector('.tab[data-tab="us"]').click();
  $('#space-name').focus();
});

$('#space-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#space-msg');
  try {
    const { space } = await api('POST', '/api/spaces', {
      name: $('#space-name').value,
      kind: document.querySelector('input[name="space-kind"]:checked')?.value || 'partner',
    });
    $('#space-name').value = '';
    await refreshSpaces();
    await switchSpace(space.id);
    msg.textContent = `Created "${space.name}" — invite people with its code below.`;
    msg.className = 'small note';
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'small error';
  }
  msg.hidden = false;
});

/* Join a space while logged in: look the code up first and show a
   preview ("You're joining 'X'") with a confirm, so a stray code never
   silently changes anything. Already in that space? Say so and just
   switch to it. */
let pendingJoinCode = null;
function showSpaceMsg(text, isError) {
  const msg = $('#space-msg');
  msg.textContent = text;
  msg.className = isError ? 'small error' : 'small note';
  msg.hidden = false;
}
$('#space-join-code').addEventListener('input', () => {
  $('#space-join-preview').hidden = true;
  pendingJoinCode = null;
});
$('#space-join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#space-join-code').value.trim().toUpperCase();
  $('#space-join-preview').hidden = true;
  pendingJoinCode = null;
  if (!code) { showSpaceMsg('Enter an invite code first.', true); return; }
  // Already a member of the space this code opens? No join needed.
  const mine = state.spaces.find((s) => s.invite_code === code);
  if (mine) {
    $('#space-join-code').value = '';
    await switchSpace(mine.id);
    showSpaceMsg(`You're already in this Space — switched you to "${mine.name}".`, false);
    return;
  }
  const found = await lookupInvite(code);
  if (!found) {
    showSpaceMsg('That code doesn\'t match any Space — check it and try again.', true);
    return;
  }
  pendingJoinCode = code;
  $('#space-join-preview-text').textContent = `You're joining '${found.space.name}'${found.space.kind_name ? ` — a ${found.space.kind_name} Space` : ''}${found.owner_first_name ? ` (${found.owner_first_name}'s)` : ''}.`;
  $('#space-join-preview').hidden = false;
  $('#space-msg').hidden = true;
});
$('#space-join-cancel').addEventListener('click', () => {
  $('#space-join-preview').hidden = true;
  pendingJoinCode = null;
});
$('#space-join-confirm').addEventListener('click', async () => {
  if (!pendingJoinCode) return;
  const code = pendingJoinCode;
  $('#space-join-preview').hidden = true;
  pendingJoinCode = null;
  try {
    const { space, alreadyMember } = await api('POST', '/api/spaces/join', { code });
    $('#space-join-code').value = '';
    await refreshSpaces();
    await switchSpace(space.id);
    showSpaceMsg(alreadyMember
      ? `You're already in this Space — switched you to "${space.name}".`
      : `Joined "${space.name}" — you're in! Say hello in the Talk tab.`, false);
  } catch (err) {
    showSpaceMsg(err.message, true);
  }
});
$('#join-space-btn').addEventListener('click', () => {
  document.querySelector('.tab[data-tab="us"]').click();
  $('#space-join-code').focus();
});
$('#share-invite').addEventListener('click', async () => {
  if (navigator.share) {
    try { await navigator.share({ title: 'Us, Guided', text: inviteText() }); } catch (_) { /* sheet closed */ }
  } else {
    $('#invite-fallback').hidden = false;
  }
});
$('#invite-copy').addEventListener('click', async () => {
  const msg = $('#invite-msg');
  try {
    await navigator.clipboard.writeText(inviteText());
    msg.textContent = 'Invite text copied — paste it anywhere.';
  } catch (_) {
    msg.textContent = inviteText();
  }
  msg.hidden = false;
});

function openProfile(person) {
  if (!person) return;
  $('#profile-title').textContent = `Profile — ${person.name}`;
  const form = $('#profile-form');
  form.reset();
  form.personId.value = person.id;
  for (const key of ['name', 'email', 'birthday', 'birth_city', 'birth_time', 'personality_snapshot',
    'fight_style', 'calms_down', 'makes_worse', 'work_on', 'triggers', 'guide_tone',
    'relationship_type', 'together_duration', 'timezone']) {
    if (form.elements[key]) form.elements[key].value = person[key] || '';
  }
  form.elements.birth_time_unknown.checked = !!person.birth_time_unknown;
  form.elements.astrology_opt_in.checked = !!person.astrology_opt_in;
  renderQuiz($('#quiz-love'), LOVE_QUIZ, 'love');
  renderQuiz($('#quiz-attachment'), ATTACHMENT_QUIZ, 'attach');
  $('#love-result').textContent = person.love_language || '—';
  $('#attachment-result').textContent = person.attachment_style || '—';
  // Live quiz scoring
  form.onchange = () => {
    const love = scoreQuiz(LOVE_QUIZ, 'love');
    const att = scoreQuiz(ATTACHMENT_QUIZ, 'attach');
    if (love) $('#love-result').textContent = love;
    if (att) $('#attachment-result').textContent = att;
  };
  $('#profile-error').hidden = true;
  $('#profile-modal').hidden = false;
}

$('#profile-cancel').addEventListener('click', () => { $('#profile-modal').hidden = true; });

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const body = Object.fromEntries(fd);
  const love = scoreQuiz(LOVE_QUIZ, 'love');
  const att = scoreQuiz(ATTACHMENT_QUIZ, 'attach');
  if (love) body.love_language = love;
  if (att) body.attachment_style = att;
  body.birth_time_unknown = fd.get('birth_time_unknown') === 'on';
  body.astrology_opt_in = fd.get('astrology_opt_in') === 'on';
  if (body.birth_time_unknown) body.birth_time = '';
  body.finish = true;
  try {
    await api('PUT', `/api/people/${body.personId}`, body);
    $('#profile-modal').hidden = true;
    await loadPeople();
    await loadFocuses();
  } catch (err) {
    const el = $('#profile-error'); el.textContent = err.message; el.hidden = false;
  }
});

$('#add-person-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('POST', '/api/people', Object.fromEntries(new FormData(e.target)));
  e.target.reset();
  loadPeople();
});

/* ================= Account: change password / delete ================= */
$('#change-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#account-msg');
  try {
    await api('POST', '/api/auth/change-password', Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    msg.textContent = 'Password changed. Other devices were signed out.';
    msg.className = 'small note';
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'small error';
  }
  msg.hidden = false;
});
$('#delete-open').addEventListener('click', () => {
  $('#delete-form').hidden = false;
  $('#delete-open').hidden = true;
});
$('#delete-cancel').addEventListener('click', () => {
  $('#delete-form').hidden = true;
  $('#delete-open').hidden = false;
  $('#delete-error').hidden = true;
});
$('#delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('DELETE', '/api/account', { password: new FormData(e.target).get('password') });
    location.reload(); // session is gone; boot lands back on the sign-in screen
  } catch (err) {
    const el = $('#delete-error');
    el.textContent = err.message;
    el.hidden = false;
  }
});

/* ================= Boot ================= */
async function boot() {
  try {
    const me = await api('GET', '/api/auth/me');
    state.me = me;
    state.spaces = me.spaces || [];
    if (!state.spaces.some((s) => s.id === state.activeSpaceId)) {
      state.activeSpaceId = state.spaces[0]?.id || null;
    }
    if (state.activeSpaceId) localStorage.setItem('ug-active-space', state.activeSpaceId);
    $('#auth-view').hidden = true;
    $('#app-view').hidden = false;
    $('#account-email').textContent = me.user.email;
    if (resetToken) { history.replaceState({}, '', location.pathname); resetToken = null; }
    const health = await api('GET', '/api/health').catch(() => null);
    if (health && health.ai === 'stub') $('#stub-badge').hidden = false;
    renderSpaces();
    if (state.activeSpaceId) {
      await loadPeople();
      await loadFocuses();
      await loadMessages();
      await loadScheduled();
    } else {
      showNoSpace();
    }
  } catch (_) {
    $('#auth-view').hidden = false;
    $('#app-view').hidden = true;
  }
}
boot();

// Keep the chat fresh so scheduled messages appear shortly after they post.
setInterval(() => {
  if (!$('#app-view').hidden && state.activeSpaceId) { loadMessages(); loadScheduled(); }
}, 30000);
