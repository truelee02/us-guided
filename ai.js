'use strict';
/*
 * AI layer. Uses the Gemini API when GEMINI_API_KEY is set; otherwise runs in
 * STUB mode with deterministic canned behavior so every flow works offline.
 * The key is read from the environment only — never hardcoded, never sent to
 * the client.
 */
const { astroSummary } = require('./astro');
const { typeMeta, normalizeKind } = require('./types');

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

/* How the Guide should frame this space, driven by the space's
   relationship type (partner, coparent, parent_child, family, friends,
   roommates, caregivers). The per-type framing text lives in types.js. */
function spaceFraming(space) {
  const meta = typeMeta(space && space.kind);
  const named = space && space.name ? ` called "${space.name}"` : '';
  return `This chat${named} is a ${meta.name} space. ${meta.framing}`;
}

/* ---------------- Message cleaning ---------------- */
// Words/patterns the stub cleaner scrubs. Deliberately small and conservative.
const STUB_INSULTS = [
  /\byou(?:'?re| are) (so )?(lazy|stupid|dumb|selfish|pathetic|useless|an idiot|a jerk|a child|ridiculous)\b/gi,
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
  const meta = typeMeta(space && space.kind);
  if (meta.group) {
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
  const kind = normalizeKind(space && space.kind);
  const otherName = other ? other.name : (kind === 'partner' ? 'your partner' : 'the other person');
  if (kind === 'coparent') {
    return {
      text:
        `[Stub Guide] Thank you for keeping that clear and calm, ${author.name}.\n\n` +
        `For ${author.name}: short, specific, business-like messages about the kids land best — one topic, one request, no history attached.\n` +
        (other ? `For ${otherName}: a brief reply confirming the plan (times, places, who brings what) keeps handoffs smooth for the kids.\n` : '') +
        `\nA question to sit with: what does the most boring, predictable version of this look like for the kids? Boring is good — it means they feel secure.\n\n` +
        `${otherName}, ${author.name} shared a plan in the chat — when you're ready, a calm confirmation helps everyone, especially the kids.`,
      stub: true,
    };
  }
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

/* The prompt the Guide's advice reply is generated from — exported so
   tests can verify the space's type reaches it. */
function advicePrompt({ author, other, others, postedText, people, recentMessages, space }) {
  const othersList = others || (other ? [other] : []);
  const meta = typeMeta(space && space.kind);
  const inviteNames = othersList.length ? othersList.map((p) => p.name).join(', ') : (meta.group ? 'the other members' : 'the other person');
  return `You are the Guide in a shared relationship chat. ${spaceFraming(space)} ${author.name} just posted this message (already cleaned up):
"""${postedText}"""
People in this space:
${spaceContext(people)}
Recent chat (oldest to newest):
${recentMessages.slice(-8).map((m) => `${m.kind === 'guide' ? 'Guide' : m.author_name}: ${m.body}`).join('\n')}

Write a short, warm reply that:
1. Suggests what EACH person could do better or differently in this situation (be specific, balanced, no side-taking).${meta.group ? ' Address the group as a whole where it fits.' : ''}
2. Asks one or two questions that would help understand the issue more deeply.
3. Invites ${inviteNames} by name to respond, noting the Guide will help them word their reply calmly too.
Never mention astrology for anyone who has not opted in (only opted-in people's signs appear above). Keep it under 220 words, plain paragraphs.`;
}

async function guideAdvice(args) {
  const { author, other, others, space } = args;
  const othersList = others || (other ? [other] : []);
  if (STUB) return stubAdvice(author, other, othersList, space);
  const prompt = advicePrompt(args);
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

/* Per-type stub focuses. The partner shelf keeps the love-language logic;
   every other type has its own shelf written in its own language — the
   co-parent shelf is practical, kid-centered co-parenting advice. */
const FOCUS_BY_TYPE = {
  coparent: [
    'Keep today\'s handoff short, warm and boring — say hello, confirm the plan, and let the kids see the two of you being a team.',
    'Send one brief, business-calm message today that covers only the kids: times, places, and who brings what. One topic, no extras.',
    'Match one small routine across both homes today — same bedtime, same homework spot — so the kids feel one steady rhythm.',
    'If something about the kids needs raising today, write it once, read it back as if you were receiving it, then send the calmer version.',
    'Tell the kids one true, kind thing about their other parent today. They relax when they don\'t have to pick a side.',
    'Put one kid event on the shared plan today — school, medical, or a game — with time and place spelled out, so nothing lives in anyone\'s memory alone.',
  ],
  parent_child: [
    'Ask one question today you\'ve never asked before — and just listen to the whole answer.',
    'Share one small memory from when they were little (or from your own childhood) today.',
    'Send a no-reason message today: just "thinking of you" counts.',
    'Do one small thing side by side today — a walk, a drive, a cup of tea — with phones put away.',
  ],
  family: [
    'Thank one person in this family out loud today for something specific they do.',
    'Put one shared plan in writing today — a meal, a visit, a ride — so nobody has to guess.',
    'Check in on the family member who\'s been quietest lately — one message is enough.',
    'Name one thing this family is doing well right now, and say it where everyone can hear it.',
  ],
  friends: [
    'Send your friend the song, photo or meme that made you think of them — today, not "sometime".',
    'Ask your friend one real question today — "how are you, actually?" — and stay for the answer.',
    'Put a low-key plan on the calendar today, even a short one. Friendship runs on kept plans.',
    'Tell your friend one specific thing you appreciate about them today.',
  ],
  roommates: [
    'Do one shared-space reset today without being asked — kitchen counter, bathroom, entryway — and don\'t keep score out loud.',
    'Check one fairness item today: is a chore, bill or shared supply quietly landing on one person? Name it kindly if so.',
    'Leave the shared spaces a little better than you found them today — future-you (and everyone else) says thanks.',
    'Confirm one house plan in writing today — guests, bills, quiet hours — so nobody has to guess.',
  ],
  caregivers: [
    'Write down one care task today that only lives in your head — an appointment, a refill, a phone call — and share it with the group.',
    'Ask the person carrying the most this week what one thing you can take off their plate — then take it.',
    'Schedule one real break today, even a short one. Respite is part of the care plan, not a reward for finishing it.',
    'Send the group one plain update today: how your loved one is doing, in two sentences. Everyone sleeps better informed.',
  ],
};

function stubFocus(person, partner, space) {
  const kind = normalizeKind(space && space.kind);
  let list;
  if (kind === 'partner') {
    list = (partner && FOCUS_BY_LOVE_LANGUAGE[partner.love_language]) || FOCUS_GENERIC;
  } else {
    list = FOCUS_BY_TYPE[kind] || FOCUS_GENERIC;
  }
  const dayIndex = Math.floor(Date.now() / 86400000);
  const seed = (person.name || '').length + dayIndex;
  return list[seed % list.length];
}

/* The prompt a daily focus is generated from — exported so tests can
   verify the space's type (and, for co-parents, the co-parenting
   framing) actually reaches the AI. */
function focusPrompt(person, partner, people, space) {
  const meta = typeMeta(space && space.kind);
  const kind = normalizeKind(space && space.kind);
  const target = partner ? partner.name : (meta.group ? 'the group' : 'the other person');
  let prompt = `You are the Guide in a ${meta.name} space. ${meta.framing}
Write ONE short daily focus (a single sentence, an action, not advice-about-advice) for ${person.name}, directed toward ${target}.
Type guidance: ${meta.focusGuidance}`;
  if (kind === 'partner' && partner && partner.love_language) {
    prompt += `\n${partner.name}'s love language is ${partner.love_language} — key the focus to it.`;
  }
  prompt += `
Grounded in their profiles:
${spaceContext(people)}
Respond with ONLY the sentence.`;
  return prompt;
}

async function dailyFocus(person, partner, people, space) {
  if (STUB) return { text: stubFocus(person, partner, space), stub: true };
  const prompt = focusPrompt(person, partner, people, space);
  try {
    return { text: await gemini(prompt), stub: false };
  } catch (e) {
    console.error('[ai] dailyFocus failed, using stub:', e.message);
    return { text: stubFocus(person, partner, space), stub: true };
  }
}

/* ---------------- Weekly content ----------------
 * Every type has its own shelf: partner keeps the four date categories;
 * co-parents get coordination ideas (never dates); the others get
 * time-together / hangout / house / care-coordination ideas. */
const WEEKLY_IDEAS_BY_TYPE = {
  partner: [
    { category: 'at home', idea: 'Cook a "restaurant menu" dinner together at home — pick a cuisine neither of you has cooked and plate it nicely.' },
    { category: 'little to no cost', idea: 'Sunset walk with a $5 treat split on the way home.' },
    { category: 'no sitter needed', idea: 'After the kids are down: living-room picnic on a blanket, phones in the kitchen, one episode of a show you both love.' },
    { category: 'out & about', idea: 'Farmers market or flea market browse with a $10 challenge: best find wins.' },
  ],
  coparent: [
    { category: 'handoffs', idea: 'Agree on a handoff script this week: same meeting spot, a two-minute kid-focused update, and a calm goodbye — the kids borrow your calm.' },
    { category: 'one shared plan', idea: 'Put this month\'s kid schedule — school, activities, appointments — into one shared plan both homes follow, so nothing depends on memory.' },
    { category: 'school & medical', idea: 'Pick one school or medical item to close the loop on together this week: a form, an appointment, a teacher email — one sender, both informed.' },
    { category: 'kid events', idea: 'Plan the next kid event together in one short exchange: who brings what, who takes photos, and how the kids get time with both of you.' },
  ],
  parent_child: [
    { category: 'at home', idea: 'Cook one family recipe together — and write down the story that goes with it while you cook.' },
    { category: 'little to no cost', idea: 'A walk with one rule: each person asks a question they\'ve never asked the other.' },
    { category: 'out & about', idea: 'Visit a place from the family story — an old neighborhood, a favorite diner — and retell what happened there.' },
    { category: 'from a distance', idea: 'A video call with a theme: show-and-tell, one object each, with the story behind it.' },
  ],
  family: [
    { category: 'at home', idea: 'Family game or movie night with a rotating host — the host picks, everyone else just shows up.' },
    { category: 'little to no cost', idea: 'A family walk where each person shares one high and one low from their week.' },
    { category: 'out & about', idea: 'Farmers market or park outing, one small treat per person, no phones at the table.' },
    { category: 'helping each other', idea: 'Pick one family member\'s annoying task this week and knock it out together in under an hour.' },
  ],
  friends: [
    { category: 'at home', idea: 'Cook-along night: same recipe, both kitchens (or one), music on, taste-test verdicts at the end.' },
    { category: 'little to no cost', idea: 'A walk-and-talk with a question deck: pull one "big question" card each.' },
    { category: 'out & about', idea: 'Try the place you keep saying you\'ll try — cheapest item on the menu challenge.' },
    { category: 'from a distance', idea: 'Watch the same episode or game "together" with a running group text, then a 10-minute call after.' },
  ],
  roommates: [
    { category: 'shared meals', idea: 'One house dinner this week: split the cost, split the cooking, and agree the kitchen gets reset the same night.' },
    { category: 'chore fairness', idea: 'Do a 10-minute chore audit together: list the recurring jobs, check who actually does them, and rebalance one thing that\'s lopsided.' },
    { category: 'house projects', idea: 'Pick one small house project — a shelf, a bulb, the junk drawer — and finish it together in under an hour.' },
    { category: 'house peace', idea: 'Agree on one house-peace upgrade this week: guest notice, quiet hours, or a shared-supplies list — write it where everyone can see it.' },
  ],
  caregivers: [
    { category: 'visit & appointment planning', idea: 'Build next week\'s visit and appointment plan together: who drives, who sits in, who takes notes — written down, not assumed.' },
    { category: 'respite swaps', idea: 'Swap one care shift this week so the person carrying the most gets a real block of time off — and protect it like an appointment.' },
    { category: 'family check-ins', idea: 'Hold a 20-minute family check-in: how your loved one is doing, what changed, and the one decision to make this week — just one.' },
    { category: 'sharing the load', idea: 'List every recurring care task and mark which ones only one person does. Move exactly one of them this week.' },
  ],
};
const WEEKLY_ACTIVITIES_BY_TYPE = {
  partner: [
    { type: 'questionnaire', title: 'The 10-Question Check-In', body: 'Sit down together and take turns asking: 1) What felt good between us this week? 2) What felt hard? 3) When did you feel closest to me? 4) When did you feel far away? 5) What do you need more of? 6) What do you need less of? 7) What are you carrying that I don\'t know about? 8) What\'s one small thing I could do tomorrow? 9) What are you looking forward to? 10) How loved do you feel, 1–10 — and what would make it one point higher?' },
    { type: 'activity', title: 'Appreciation Swap', body: 'Set a timer for 10 minutes. Take turns finishing these sentences about each other: "I appreciated it when you…", "I admire how you…", "I feel loved when you…". No rebuttals, just "thank you."' },
    { type: 'discussion', title: 'One Topic, Two Chairs', body: 'Pick ONE topic that has been simmering (money, chores, time together — just one). Each person gets 5 uninterrupted minutes while the other only listens. Then together, name one tiny next step you both agree on. End by naming one thing that is already working.' },
  ],
  coparent: [
    { type: 'questionnaire', title: 'The Kid-Focused Check-In', body: 'Take turns answering, briefly and calmly: 1) What went well for the kids this week? 2) What was hard for them? 3) What did each kid need more of? 4) What is one routine we should keep identical in both homes? 5) What is coming up that we both need on the plan? Keep every answer about the kids — adult grievances get a different time and place.' },
    { type: 'activity', title: 'One Plan, Two Homes', body: 'Pick ONE thing to make identical in both homes this week — bedtime, homework routine, or screen rules. Write the shared version down together in two sentences. Consistency is the gift; the kids feel it immediately.' },
    { type: 'discussion', title: 'One Kid Topic, Two Parents', body: 'Pick ONE kid topic that has been simmering (school, health, a behavior — just one). Each parent gets 5 uninterrupted minutes while the other only listens. Then name one tiny next step you both agree on, and one thing that is already working for the kids.' },
  ],
  parent_child: [
    { type: 'questionnaire', title: 'Across the Years Check-In', body: 'Take turns asking: 1) What is something you wish I understood about your life right now? 2) What is a favorite memory of us? 3) What do you need more of from me? 4) What do you need less of? 5) What are you proud of lately that I might not know about?' },
    { type: 'activity', title: 'Story Swap', body: 'Each person tells one story the other has never heard — a childhood mishap, a proud moment, a lesson learned the hard way. No advice, just listening and one follow-up question each.' },
    { type: 'discussion', title: 'One Topic, Two Generations', body: 'Pick ONE topic that matters to you both (time together, boundaries, plans — just one). Each person gets 5 uninterrupted minutes while the other only listens. End by naming one small thing you will do together this week.' },
  ],
  family: [
    { type: 'questionnaire', title: 'The Family Round', body: 'Go around the group: 1) What went well for you this week? 2) What was hard? 3) What do you need from this family right now? 4) Who helped you recently — thank them out loud. 5) What is one thing we should do together soon?' },
    { type: 'activity', title: 'Appreciation Round', body: 'Go around the group: each person names one specific thing they appreciate about the person next to them. Specific beats big. No rebuttals, just "thank you."' },
    { type: 'discussion', title: 'One Topic, Whole Family', body: 'Pick ONE family topic (plans, chores, a decision — just one). Everyone gets a turn to speak without interruption, youngest first. Together, name one tiny next step everyone agrees on.' },
  ],
  friends: [
    { type: 'questionnaire', title: 'The Real Check-In', body: 'Take turns asking: 1) How are you, actually? 2) What is taking up the most room in your head? 3) What is one thing you are looking forward to? 4) How can I show up better as your friend? Keep it light, keep it honest.' },
    { type: 'activity', title: 'Hype Swap', body: 'Take turns hyping each other up: one genuine strength, one recent win the other person downplayed, and one thing you are rooting for them on. Screenshot it for a bad day.' },
    { type: 'discussion', title: 'One Topic, No Rush', body: 'Pick ONE topic that has been floating between you (a plan, a small friction, a big decision — just one). Take turns talking and listening without fixing. End by naming the next small step, even if it is just "talk again Tuesday".' },
  ],
  roommates: [
    { type: 'questionnaire', title: 'The House Check-In', body: 'Take turns answering: 1) What is working about living here? 2) What is one small thing that bugs you? 3) Are chores and bills landing fairly? 4) Any guest or quiet-hours adjustments? Keep it short, specific and kind.' },
    { type: 'activity', title: 'The Fairness Audit', body: 'List the recurring house jobs together and mark who actually does each one. Rebalance exactly one thing, write the new arrangement down, and thank whoever has been quietly carrying extra.' },
    { type: 'discussion', title: 'One House Topic', body: 'Pick ONE house topic (guests, noise, shared supplies — just one). Each person gets 3 uninterrupted minutes. End with one written house agreement you all accept, posted where everyone can see it.' },
  ],
  caregivers: [
    { type: 'questionnaire', title: 'The Care Circle Check-In', body: 'Go around the group: 1) How is our loved one doing, really? 2) What changed this week? 3) Who is carrying the most right now? 4) What does that person need — practically, and as a human? 5) What is the one decision for this week?' },
    { type: 'activity', title: 'The Load Map', body: 'Write down every recurring care task — visits, calls, paperwork, supplies, appointments — and who does each. Circle anything only one person carries, and move one of them this week.' },
    { type: 'discussion', title: 'One Care Decision', body: 'Pick ONE care decision that has been hanging over the group. Each person shares their view without interruption. Name what you agree on, park the rest for a set date, and end by appreciating one thing someone did this week.' },
  ],
};
const DAILY_ACTIVITIES_BY_TYPE = {
  partner: [
    'Ask each other: "What\'s one thing you\'re looking forward to this week?"',
    'Swap: each person shares the best and hardest part of their day in two minutes.',
    'Tell your partner one thing you noticed them do well recently.',
    'Ask: "Is there anything on your mind that I haven\'t asked about lately?"',
    'Each share a small childhood memory you\'ve never told the other.',
    'Ask your partner what their perfect ordinary day looks like right now.',
    'Give your partner a genuine compliment about who they are, not what they do.',
  ],
  coparent: [
    'Exchange one short update about the kids today: how they slept, ate, and seemed — two sentences each is plenty.',
    'Confirm tomorrow\'s plan in one calm message: times, places, and who is bringing what.',
    'Share one good thing about the kids today — a funny line, a small win, a photo — with no agenda attached.',
    'Check one shared item off the plan today: a form, a fee, a packed bag for the other home.',
    'Ask: "Anything about the kids I should know before the next handoff?" — then just listen.',
    'Agree on one word or phrase you will both use for a current kid phase, so the kids hear the same language in both homes.',
    'End the day with one brief thank-you for something the other parent handled. Short counts.',
  ],
  parent_child: [
    'Ask: "What\'s one thing you\'re looking forward to this week?" — and really listen.',
    'Share the best and hardest part of your day, two minutes each.',
    'Tell them one thing you noticed them do well recently.',
    'Ask about something from their world you know little about — a hobby, a friend, a plan.',
    'Share a small memory from your own childhood at their age.',
    'Ask: "Is there anything on your mind I haven\'t asked about lately?"',
    'Say one specific thing you admire about who they are becoming.',
  ],
  family: [
    'Everyone shares one high and one low from today — two minutes total.',
    'Thank one family member for something specific today.',
    'Ask: "What\'s one thing you\'re looking forward to this week?" — go around the group.',
    'Share one piece of good news, however small, with the whole group.',
    'Ask who needs a hand this week, and let one person actually take the offer.',
    'Each person names one thing another family member did well recently.',
    'Put one family plan in writing today — a meal, a visit, a ride.',
  ],
  friends: [
    'Send the meme, song or photo that made you think of them — today.',
    'Ask: "What\'s taking up the most room in your head right now?"',
    'Share your best and hardest moment of the day in two minutes each.',
    'Hype them: name one thing they did recently that you thought was great.',
    'Float one concrete plan — a day, a time, a place — instead of "we should hang out soon".',
    'Ask about the thing they mentioned last time and you actually remembered.',
    'Tell them one thing you appreciate about the friendship, plainly.',
  ],
  roommates: [
    'Do a 5-minute shared-space reset together — counters, couch, entryway.',
    'Ask: "Anything about the house bugging you this week?" — small stuff counts.',
    'Confirm one house thing in writing today: a bill split, a guest, a chore swap.',
    'Share one thing about your day that has nothing to do with the house.',
    'Restock one shared supply before it runs out — and note it on the shared list.',
    'Thank a roommate for one invisible thing they do — trash, filters, the good toilet paper.',
    'Agree on tonight\'s quiet plan: guests, music, or an early night — no guessing.',
  ],
  caregivers: [
    'Post one plain update: how your loved one is today, in two sentences.',
    'Ask the group: "Who has the least left in the tank today?" — and adjust one plan around the answer.',
    'Confirm tomorrow\'s care plan in writing: visits, calls, appointments, who does what.',
    'Share one small good moment from a visit or call — the group runs on those too.',
    'Move one small care task from your list to someone who offered — let them help.',
    'Check one piece of paperwork or one refill today, and note it where everyone can see.',
    'Name one thing a fellow caregiver did this week and thank them specifically.',
  ],
};

function weekKeyOf(date = new Date()) {
  // ISO week key, e.g. 2026-W46
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function weeklyIdeas(space, weekKey) {
  // One idea per category, from the space type's own shelf. In stub mode
  // these are fixed curated sets; with a live Gemini key this is where
  // generated sets would be produced per week.
  void weekKey;
  const kind = normalizeKind(space && space.kind);
  return (WEEKLY_IDEAS_BY_TYPE[kind] || WEEKLY_IDEAS_BY_TYPE.partner)
    .map(({ category, idea }) => ({ category, idea }));
}

/* Back-compat: the partner shelf under its old name. */
function weeklyDateIdeas(weekKey, space) {
  return weeklyIdeas(space || { kind: 'partner' }, weekKey);
}

function weeklyActivity(weekKey, space) {
  const kind = normalizeKind(space && space.kind);
  const list = WEEKLY_ACTIVITIES_BY_TYPE[kind] || WEEKLY_ACTIVITIES_BY_TYPE.partner;
  const n = parseInt(weekKey.replace(/\D/g, ''), 10) || 0;
  return list[n % list.length];
}

function dailyActivity(dateKey, space) {
  const kind = normalizeKind(space && space.kind);
  const list = DAILY_ACTIVITIES_BY_TYPE[kind] || DAILY_ACTIVITIES_BY_TYPE.partner;
  const n = parseInt(dateKey.replace(/\D/g, ''), 10) || 0;
  return list[n % list.length];
}

module.exports = {
  STUB,
  cleanMessage,
  guideAdvice,
  dailyFocus,
  weeklyIdeas,
  weeklyDateIdeas,
  weeklyActivity,
  dailyActivity,
  weekKeyOf,
  // Exported for tests: the prompts the type is woven into.
  focusPrompt,
  advicePrompt,
  spaceFraming,
};
