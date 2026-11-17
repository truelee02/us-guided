'use strict';
/* Us, Guided — vanilla client. */

const $ = (sel) => document.querySelector(sel);
const api = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = { me: null, people: [], messages: [] };

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
  document.querySelectorAll('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.authTab === which));
  $('#login-form').hidden = which !== 'login';
  $('#signup-form').hidden = which !== 'signup';
  $('#join-form').hidden = which !== 'join';
  $('#forgot-form').hidden = which !== 'forgot';
  $('#reset-form').hidden = which !== 'reset';
  $('#forgot-row').hidden = which !== 'login';
  $('#auth-error').hidden = true;
}
document.querySelectorAll('.auth-tab').forEach((btn) => {
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
handleAuth('#signup-form', '/api/auth/signup');
handleAuth('#join-form', '/api/auth/join');

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
  const { messages } = await api('GET', '/api/messages');
  state.messages = messages;
  const mine = state.me?.person?.id;
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
  const text = ta.value.trim();
  if (!text) return;
  const err = $('#talk-error');
  err.hidden = true;
  ta.disabled = true;
  try {
    await api('POST', '/api/messages', { text });
    ta.value = '';
    await loadMessages();
  } catch (e2) {
    err.textContent = e2.message; err.hidden = false;
  } finally { ta.disabled = false; ta.focus(); }
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
  const [rem, ideas, weekly] = await Promise.all([
    api('GET', '/api/reminders'), api('GET', '/api/date-ideas'), api('GET', '/api/weekly'),
  ]);
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
  const { people } = await api('GET', '/api/people');
  state.people = people;
  $('#invite-code').textContent = state.me?.household?.invite_code || '—';
  wireInvite();
  $('#people-list').innerHTML = people.map((p) => `
    <div class="card person-card">
      <h3>${esc(p.name)} ${p.id === state.me?.person?.id ? '<span class="badge">you</span>' : ''}</h3>
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
  const code = state.me?.household?.invite_code || '';
  return `Join me on Us, Guided 💜 — a shared space with an AI guide that helps us talk things through.\n\n1. Open ${location.origin}\n2. Tap "Join with invite"\n3. Use this code: ${code}`;
}
function wireInvite() {
  if (!state.me?.household?.invite_code) return;
  const text = inviteText();
  $('#invite-sms').href = `sms:?&body=${encodeURIComponent(text)}`;
  $('#invite-mail').href = `mailto:?subject=${encodeURIComponent('Join me on Us, Guided')}&body=${encodeURIComponent(text)}`;
}
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
    $('#auth-view').hidden = true;
    $('#app-view').hidden = false;
    $('#account-email').textContent = me.user.email;
    if (resetToken) { history.replaceState({}, '', location.pathname); resetToken = null; }
    const health = await api('GET', '/api/health').catch(() => null);
    if (health && health.ai === 'stub') $('#stub-badge').hidden = false;
    await loadPeople();
    await loadFocuses();
    await loadMessages();
    await loadScheduled();
  } catch (_) {
    $('#auth-view').hidden = false;
    $('#app-view').hidden = true;
  }
}
boot();

// Keep the chat fresh so scheduled messages appear shortly after they post.
setInterval(() => {
  if (!$('#app-view').hidden) { loadMessages(); loadScheduled(); }
}, 30000);
