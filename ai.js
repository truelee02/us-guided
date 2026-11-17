'use strict';
/*
 * AI layer. Uses the Gemini API when GEMINI_API_KEY is set; otherwise runs in
 * STUB mode with deterministic canned behavior so every flow works offline.
 * The key is read from the environment only — never hardcoded, never sent to
 * the client.
 */
const { astroSummary } = require('./astro');

const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const STUB = !API_KEY;

if (STUB) {
  console.warn('[ai] GEMINI_API_KEY not set — running in STUB mode (canned AI responses).');
}

/* ---------------- Gemini transport ---------------- */
async function gemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in model output');
  return JSON.parse(m[0]);
}

/* ---------------- Context about the people ---------------- */
function personContext(p) {
  const lines = [`- ${p.name}:`];
  if (p.love_language) lines.push(`  love language: ${p.love_language}`);
  if (p.attachment_style) lines.push(`  attachment style: ${p.attachment_style}`);
  if (p.personality_snapshot) lines.push(`  personality: ${p.personality_snapshot}`);
  if (p.fight_style) lines.push(`  in a fight: ${p.fight_style}`);
  if (p.calms_down) lines.push(`  calms down with: ${p.calms_down}`);
  if (p.makes_worse) lines.push(`  gets worse with: ${p.makes_worse}`);
  if (p.work_on) lines.push(`  working on: ${p.work_on}`);
  if (p.triggers) lines.push(`  sensitive topics (handle gently): ${p.triggers}`);
  if (p.guide_tone) lines.push(`  prefers the Guide to be: ${p.guide_tone}`);
  const astro = astroSummary(p); // null unless this person opted in
  if (astro) {
    lines.push(`  astrology (opted in): sun sign ${astro.sun}${astro.rising ? `, rising ${astro.rising}` : ''}`);
  }
  return lines.join('\n');
}

function spaceContext(people) {
  return people.map(personContext).join('\n');
}

/* How the Guide should frame this space: a couple's two-person chat, or a
   family group chat it mediates as a whole. */
function spaceFraming(space) {
  if (space && space.kind === 'family') {
    return `This is a FAMILY group chat${space.name ? ` called "${space.name}"` : ''} with several members. Address the group as a whole, not as a couple. You may speak to members by name, give each person something specific, and invite members by name to respond.`;
  }
  return `This is a couple's shared chat${space && space.name ? ` called "${space.name}"` : ''}.`;
}

/* ---------------- Message cleaning ---------------- */
// Words/patterns the stub cleaner scrubs. Deliberately small and conservative.
const STUB_INSULTS = [
  /\byou'?re (so )?(lazy|stupid|dumb|selfish|pathetic|useless|an idiot|a jerk|a child|ridiculous)\b/gi,
  /\b(idiot|jerk|stupid|shut up|whatever|i don'?t care)\b/gi,
  /\byou (always|never) \b/gi,
];
function stubClean(text) {
  let out = text;
  for (const re of STUB_INSULTS) out = out.replace(re, (m) => (re.source.includes('always') ? 'I feel like, lately, you ' : ''));
  out = out.replace(/,\s*,+/g, ', ').replace(/^[\s,;:]+/, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  if (!out) out = text;
  if (out !== text && !/^(i feel|i'm|i am|i need|i would)/i.test(out)) {
    out = `I want to say this calmly: ${out.charAt(0).toLowerCase()}${out.slice(1)}`;
  }
  return { text: out, changed: out !== text, stub: true };
}

async function cleanMessage(rawText, author, people, space) {
  if (STUB) return stubClean(rawText);
  const prompt = `You are the Guide in a shared relationship chat. Rewrite the message below so it keeps the writer's real point and voice but removes anything hostile, insulting, hurtful, blaming, or unproductive. Use calm, healthy, "I feel / I need" language where it fits. If the message is already kind and productive, return it unchanged.
${spaceFraming(space)}
Writer: ${author.name}
People in this space:
${spaceContext(people)}
Message: """${rawText}"""
Respond with ONLY JSON: {"text": "<final message>", "changed": true|false}`;
  try {
    const out = extractJson(await gemini(prompt));
    return { text: String(out.text || rawText), changed: !!out.changed && out.text !== rawText, stub: false };
  } catch (e) {
    console.error('[ai] cleanMessage failed, using stub cleaner:', e.message);
    return stubClean(rawText);
  }
}

/* ---------------- Guide advice reply ---------------- */
function stubAdvice(author, other, others, space) {
  if (space && space.kind === 'family') {
    const names = (others || []).map((p) => p.name);
    const list = names.length ? names.join(', ') : 'everyone';
    return {
      text:
        `[Stub Guide] Thank you for putting that into words calmly, ${author.name}.\n\n` +
        `For ${author.name}: one thing to try is naming the feeling underneath the frustration before asking for a change — it lands softer and is easier to hear.\n` +
        (names.length ? `For ${list}: listening all the way through before responding, and repeating the main point back in your own words, would help ${author.name} feel heard.\n` : '') +
        `\nA question for the whole group: what would "good enough" look like here for everyone?\n\n` +
        `${list} — ${author.name} shared something with the group. When you're ready, your responses matter, and the Guide will help each of you word them kindly too.`,
      stub: true,
    };
  }
  const otherName = other ? other.name : 'your partner';
  return {
    text:
      `[Stub Guide] Thank you for putting that into words calmly.\n\n` +
      `For ${author.name}: one thing to try is naming the feeling underneath the frustration before asking for a change — it lands softer and is easier to hear.\n` +
      (other ? `For ${otherName}: listening all the way through before responding, and repeating the main point back in your own words, would help ${author.name} feel heard.\n` : '') +
      `\nA question to sit with: what would "good enough" look like here for both of you?\n\n` +
      `${otherName}, ${author.name} shared something in the chat — when you're ready, your response matters, and the Guide will help you word it kindly too.`,
    stub: true,
  };
}

async function guideAdvice({ author, other, others, postedText, people, recentMessages, space }) {
  const othersList = others || (other ? [other] : []);
  if (STUB) return stubAdvice(author, other, othersList, space);
  const isFamily = space && space.kind === 'family';
  const inviteNames = othersList.length ? othersList.map((p) => p.name).join(', ') : (isFamily ? 'the other members' : 'the other person');
  const prompt = `You are the Guide in a shared relationship chat. ${spaceFraming(space)} ${author.name} just posted this message (already cleaned up):
"""${postedText}"""
People in this space:
${spaceContext(people)}
Recent chat (oldest to newest):
${recentMessages.slice(-8).map((m) => `${m.kind === 'guide' ? 'Guide' : m.author_name}: ${m.body}`).join('\n')}

Write a short, warm reply that:
1. Suggests what EACH person could do better or differently in this situation (be specific, balanced, no side-taking).${isFamily ? ' Address the group as a whole where it fits.' : ''}
2. Asks one or two questions that would help understand the issue more deeply.
3. Invites ${inviteNames} by name to respond, noting the Guide will help them word their reply calmly too.
Never mention astrology for anyone who has not opted in (only opted-in people's signs appear above). Keep it under 220 words, plain paragraphs.`;
  try {
    return { text: await gemini(prompt), stub: false };
  } catch (e) {
    console.error('[ai] guideAdvice failed, using stub:', e.message);
    return stubAdvice(author, other, othersList, space);
  }
}

/* ---------------- Daily focus ---------------- */
const FOCUS_BY_LOVE_LANGUAGE = {
  'Physical Touch': ['Give your partner a 7 second hug today — no rushing it.', 'Hold your partner\'s hand for a full minute today, just because.'],
  'Words of Affirmation': ['Compliment your partner today — pick something specific, not generic.', 'Tell your partner one thing they did recently that you genuinely appreciated.'],
  'Acts of Service': ['Do one small chore your partner usually handles, without being asked.', 'Make your partner\'s life a little easier today in one concrete way — then don\'t mention it.'],
  'Quality Time': ['Put your phone in another room for 15 minutes and just be with your partner.', 'Ask your partner about their day and really listen — no fixing, no phone.'],
  'Receiving Gifts': ['Leave a tiny surprise for your partner today — a note counts.', 'Pick up one small thing your partner loves next time you\'re out.'],
};
const FOCUS_GENERIC = [
  'Ask your partner, "What\'s one thing I could do this week that would make you feel loved?"',
  'Thank your partner for something specific before the day ends.',
  'Check in with your partner tonight: high point and low point of their day.',
];

function stubFocus(person, partner) {
  const list = (partner && FOCUS_BY_LOVE_LANGUAGE[partner.love_language]) || FOCUS_GENERIC;
  const dayIndex = Math.floor(Date.now() / 86400000);
  const seed = (person.name || '').length + dayIndex;
  return list[seed % list.length];
}

async function dailyFocus(person, partner, people, space) {
  if (STUB) return { text: stubFocus(person, partner), stub: true };
  const isFamily = space && space.kind === 'family';
  const prompt = `You are the Guide. Write ONE short daily focus (a single sentence, an action, not advice-about-advice) for ${person.name}. It should be something concrete they can do today for ${partner ? partner.name : (isFamily ? 'their family' : 'their partner')}${isFamily ? ' — this is a family group, so frame it toward the family, not a partner' : ''}, grounded in their profiles:
${spaceContext(people)}
Examples of the style: "Give your partner a 7 second hug today." / "Compliment your partner on something specific today."
Respond with ONLY the sentence.`;
  try {
    return { text: await gemini(prompt), stub: false };
  } catch (e) {
    console.error('[ai] dailyFocus failed, using stub:', e.message);
    return { text: stubFocus(person, partner), stub: true };
  }
}

/* ---------------- Weekly content ---------------- */
const WEEKLY_DATE_IDEAS = [
  { category: 'at home', idea: 'Cook a "restaurant menu" dinner together at home — pick a cuisine neither of you has cooked and plate it nicely.' },
  { category: 'little to no cost', idea: 'Sunset walk with a $5 treat split on the way home.' },
  { category: 'no sitter needed', idea: 'After the kids are down: living-room picnic on a blanket, phones in the kitchen, one episode of a show you both love.' },
  { category: 'out & about', idea: 'Farmers market or flea market browse with a $10 challenge: best find wins.' },
];
const WEEKLY_ACTIVITIES = [
  { type: 'questionnaire', title: 'The 10-Question Check-In', body: 'Sit down together and take turns asking: 1) What felt good between us this week? 2) What felt hard? 3) When did you feel closest to me? 4) When did you feel far away? 5) What do you need more of? 6) What do you need less of? 7) What are you carrying that I don\'t know about? 8) What\'s one small thing I could do tomorrow? 9) What are you looking forward to? 10) How loved do you feel, 1–10 — and what would make it one point higher?' },
  { type: 'activity', title: 'Appreciation Swap', body: 'Set a timer for 10 minutes. Take turns finishing these sentences about each other: "I appreciated it when you…", "I admire how you…", "I feel loved when you…". No rebuttals, just "thank you."' },
  { type: 'discussion', title: 'One Topic, Two Chairs', body: 'Pick ONE topic that has been simmering (money, chores, time together — just one). Each person gets 5 uninterrupted minutes while the other only listens. Then together, name one tiny next step you both agree on. End by naming one thing that is already working.' },
];
const DAILY_ACTIVITIES = [
  'Ask each other: "What\'s one thing you\'re looking forward to this week?"',
  'Swap: each person shares the best and hardest part of their day in two minutes.',
  'Tell your partner one thing you noticed them do well recently.',
  'Ask: "Is there anything on your mind that I haven\'t asked about lately?"',
  'Each share a small childhood memory you\'ve never told the other.',
  'Ask your partner what their perfect ordinary day looks like right now.',
  'Give your partner a genuine compliment about who they are, not what they do.',
];

function weekKeyOf(date = new Date()) {
  // ISO week key, e.g. 2026-W46
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function weeklyDateIdeas(weekKey) {
  // One idea per category. In stub mode these are a fixed curated set; with a
  // live Gemini key this is where generated sets would be produced per week.
  void weekKey;
  return WEEKLY_DATE_IDEAS.map(({ category, idea }) => ({ category, idea }));
}

function weeklyActivity(weekKey) {
  const n = parseInt(weekKey.replace(/\D/g, ''), 10) || 0;
  return WEEKLY_ACTIVITIES[n % WEEKLY_ACTIVITIES.length];
}

function dailyActivity(dateKey) {
  const n = parseInt(dateKey.replace(/\D/g, ''), 10) || 0;
  return DAILY_ACTIVITIES[n % DAILY_ACTIVITIES.length];
}

module.exports = {
  STUB,
  cleanMessage,
  guideAdvice,
  dailyFocus,
  weeklyDateIdeas,
  weeklyActivity,
  dailyActivity,
  weekKeyOf,
};
