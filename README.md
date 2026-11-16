# Us, Guided — standalone app

A standalone, self-hostable app (it began as the "Shared Relationship AI"
prototype, originally a Muse Space). Two or more people in a household share one chat
with an AI **Guide** that knows each person's profile — love language,
attachment style, personality, what calms them, what they're working on — and
helps them say hard things kindly.

- **Talk** — the shared chat. You type what you'd actually say; the Guide
  cleans up hostile/insulting/hurtful wording (keeping your point and voice)
  and posts the cleaned version. If it changed anything, the message ends with
  *"(reworded by AI for clearer communication)"*. Your raw draft is **never
  stored**. After each post, the Guide replies with what each person could do
  better or differently, questions to understand the issue deeper, and an
  invitation to the other person, by name, to respond. There is no grievances
  list — grievances live only in this chat. Messages can also be **scheduled**:
  write one now and pick when it posts (in an hour, tonight 8 PM, tomorrow
  8 AM, or any date/time). A scheduled message is cleaned by the Guide at
  schedule time, stays visible only to its author (who can cancel it) until
  its moment, then posts to the chat and gets the usual Guide reply.
- **Us** — one profile per person: short signup (name, email, birthday), then
  a "Finish profile" step with birth city/time (+ "I don't know my birth
  time"), a per-person astrology opt-in/opt-out, a 5-question love-language
  quiz, a 5-question attachment-style quiz, personality snapshot, fight style,
  what calms them vs. what makes it worse, top things to work on, triggers,
  how they want the Guide to talk to them, and practical details.
- **Together** — per-person reminders, saved date ideas, one fresh weekly set
  of date ideas (at home / little to no cost / no sitter needed / out &
  about), a weekly connection activity (rotating questionnaire / activity /
  discussion), a daily connection activity, and a personal **daily focus**
  card for each person (e.g. "give your partner a 7 second hug").

## Run it locally

```bash
npm install
cp .env.example .env     # then edit .env
npm start                # http://localhost:3000
```

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `GEMINI_API_KEY` | No | From Google AI Studio. **If unset, the server runs in STUB mode** — canned, deterministic AI responses (the UI shows a "STUB AI" badge) so every flow works end-to-end for testing. |
| `PORT` | No | Default `3000`. |
| `SESSION_SECRET` | In production | Signs session cookies. Use a long random string. |
| `GEMINI_MODEL` | No | Default `gemini-3.6-flash`. |

The AI call is made server-side only:
`POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`
with the key in the `x-goog-api-key` header. The key never reaches the browser
and is never hardcoded.

## Data model

SQLite via `better-sqlite3` (database file: `data/app.db`). If that native
module fails to install, the server automatically falls back to a JSON file
store (`data/app.json`) with the same API — check the boot log / `GET
/api/health` to see which backend is active (`"db": "sqlite"` or `"json"`).

Tables: `households` (with invite code), `users` (scrypt-hashed passwords),
`sessions`, `people` (profiles), `messages` (kind: `message` | `guide`;
`reworded` flag; `scheduled_for` set while a scheduled send is pending, null
once delivered; raw drafts are never written), `reminders`, `date_ideas`,
`weekly_sets` (per-week date ideas + connection activity), `daily_focuses`,
`daily_activities`.

**Astrology:** sun sign is computed exactly from the birthday. Rising sign is
an *approximation* (a real ascendant needs an ephemeris calculation) and is
only computed when a birth time is known. Each person opts in or out of
astrology individually; the Guide's prompts only include sign information for
people who opted in.

**Accounts:** the first person signs up and gets an invite code; the partner
joins the same household with that code ("Join with invite"). Extra people
(e.g. family members without a login) can be added from the Us tab.

## Going live — what's still needed

This repo is the foundation, not a finished product. Before charging anyone:

1. **Hosting account** — a VPS or platform (Render, Railway, Fly.io, a small
   VPS, etc.) with the `.env` values set as real secrets, HTTPS in front
   (required for service workers/PWA install and secure cookies).
   For Render, this repo includes a `render.yaml` blueprint: it creates a
   Starter web service plus a 1 GB persistent disk mounted at `/var/data`
   and sets `DATA_DIR=/var/data` so couple data survives redeploys. Set
   `GEMINI_API_KEY` in the Render dashboard (never in the repo).
2. **Domain** — a real domain pointed at the host; update nothing in code,
   the app is domain-agnostic.
3. **A real Gemini key** — create one in Google AI Studio, set
   `GEMINI_API_KEY`, and test thoroughly (mind the free-tier rate limits;
   a paid tier is advisable before real users).
4. **Stripe billing wiring** — accounts/subscriptions don't exist yet. Add a
   `subscriptions` table, Stripe Checkout for signup/paywall, a webhook
   handler for `customer.subscription.*` events, and gate household creation
   (or message volume) on an active subscription. Stripe keys go in `.env`
   (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price IDs) — never in code.
5. **Web push (VAPID keys)** — the service worker already has a `push`
   handler. Still needed: generate a VAPID key pair, store browser push
   subscriptions per user, and send pushes (e.g. with the `web-push` npm
   package) when a partner posts or a daily focus is ready.
   `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` go in `.env`.
6. **Capacitor wrap for the app stores** — `npx @capacitor/cli init`, point
   it at the hosted URL (or bundle `public/`), add the push-notifications
   plugin, then build for Apple (needs an Apple Developer account, ~$99/yr)
   and Google Play (~$25 one-time). The Guide in the store build still calls
   this same server, so the Gemini key stays server-side.
7. **Product/legal basics before selling** — privacy policy and terms
   (you're storing relationship conversations and birth data), account
   deletion, password reset by email (needs a mail provider), rate limiting,
   and backups of `data/`.

## Notes / known simplifications in this foundation

- Sessions are stored server-side in a table; cookie is HMAC-signed.
- Weekly date ideas and the weekly activity are curated sets (rotated by
  week); with a live Gemini key they can be generated per household later.
- Daily focuses are template-based (keyed to the partner's love language) in
  stub mode; with a live key they're generated per person per day.
- This is an AI helper for everyday relationship stuff — not a replacement
  for professional therapy.
