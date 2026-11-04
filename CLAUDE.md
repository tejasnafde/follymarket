# follymarket

Private friend-group prediction market with fake money. LMSR maker, YES/NO
shares, about 10 players. Design: `docs/plans/2026-08-05-chaotic-paper-prediction-market-design.md`.
Static design mock, no build step: `docs/mock.html`.

Shared cross-project conventions live in `~/Desktop/projects/CLAUDE.local.md` and
are the source of truth for: the two gcloud identities and the
`--configuration=personal` rule, the `tn07` OAuth consent screen, the `tn07.dev`
hostname table, Cloudflare DNS via `tn07-site/dns.sh`, Secret Manager inventory,
Firebase, Cloud Run gotchas, and the writing style rules. Read it before any
gcloud, DNS, OAuth or secret work. Do not copy its content here; fix it there and
every project inherits the fix.

@/Users/tejas/Desktop/projects/CLAUDE.local.md

## What is live (2026-08-05)

| Piece | Where |
|---|---|
| Site and API, one origin | `https://follymarket.tn07.dev` |
| Worker (static assets + `/api/*` proxy) | Cloudflare Worker `follymarket`, `wrangler.toml` |
| API | Cloud Run `follymarket-api`, `asia-south1`, project `teejayproject` |
| Data | Firestore `(default)` in `teejayproject`, collections prefixed `folly_` |
| Auth | Firebase Auth, Google provider, web app `follymarket` |
| Secrets | one JSON secret `follymarket-config` (keys `FOLLY_DISCORD_WEBHOOK`, `FOLLY_VAPID_PRIVATE_PEM`), injected as `FOLLYMARKET_CONFIG` and expanded by `api/config_blob.py` (since 2026-11-04) |

Deploy, both idempotent, no CI:

```sh
npx wrangler deploy                        # frontend + edge, from the repo root
cd api && gcloud --configuration=personal run deploy follymarket-api \
  --project teejayproject --region asia-south1 --source . --allow-unauthenticated \
  --set-secrets=FOLLYMARKET_CONFIG=follymarket-config:latest
```

`--set-secrets` (not `--update-secrets`) replaces every secret ref, so the old
per-value refs detach. Plain env vars (`FOLLY_ADMIN_EMAIL`, `FOLLY_JOIN_CODE`,
`FOLLY_VAPID_PUBLIC`, ...) are not in the command and carry over from the live
service. On Cloud Run the API refuses to start without `FOLLYMARKET_CONFIG`.

**One thing is not done: the Google sign-in provider is not enabled yet.** Until
someone clicks it on in the Firebase console (Authentication > Sign-in method >
Google), `signInWithPopup` fails with `auth/operation-not-allowed` and nobody can
get in. There is no CLI for it: `firebase` only does hosting, functions, rules and
user import/export, `gcloud` has no Identity Platform provider command, and the
REST call refuses to save without an OAuth `client_id` and secret that no public
API can create. Checked 2026-08-05, do not re-litigate it. See the Firebase
section of `CLAUDE.local.md`.

## Layout

- `web/` - `index.html`, `app.js`, `style.css`. No framework, no build. Firebase
  Auth from the gstatic CDN. `style.css` is generated from `docs/mock.html`, so
  visual changes belong in both or the mock stops being the reference.
- `api/` - FastAPI. `main.py` is the whole API, `lmsr.py` is the maths with a
  `python lmsr.py` self-check that the Dockerfile runs at build time.
- `edge/worker.js` - path routing. `/api/*` to Cloud Run, everything else to
  Workers Assets.
- `firestore.rules` - deny-all.

## Rules of the money

- The browser previews trades and decides nothing. Every rupee moves inside a
  Firestore transaction in `main.py`.
- **Everyone starts at ₹0 and chooses their own stake.** The first top-up IS that
  choice, so there is no onboarding flag and no starting grant. Top up again any
  time. One share pays ₹1 if its side wins.
- Top-ups are public on purpose: ledger row, Discord alert, and the portfolio
  scores `net = cash + positions - deposited`. Free money with a hidden top-up
  would make every P/L number a lie.
- `b = 200`, fixed, tuned for real bet sizes of ₹25 to ₹200: ₹100 takes a 50%
  market to about 70%, ₹500 nearly settles it at 96%. There is no chaos setting.
- Firestore holds all state. Nothing lives in a process, which is why Cloud Run
  can scale past one instance safely.
- Admin emails come from `FOLLY_ADMIN_EMAIL` (comma separated). An admin admits
  itself on first login; everyone else needs a row in `folly_allowlist`.

## Race conditions, audited 2026-08-05

Every write path was checked. Firestore transactions are optimistic: if a document
read inside a transaction changes before commit, the transaction retries, so a
read-modify-write inside one cannot lose an update.

| Path | State |
|---|---|
| Buy | Transactional. Client sends a `nonce` per confirmed trade and reuses it on retry; the nonce is the trade document id, so a lost response cannot charge twice. |
| Top up | Same nonce guard, ledger id `topup_<nonce>`. |
| Resolve | Claims the market in a transaction BEFORE paying. Each payout marks `settled_as` on the position and writes a deterministic ledger id, so re-running the same outcome finishes a half-done payout instead of paying twice. A different outcome is refused. |
| Close | Transactional, so two clicks cannot both succeed, and an in-flight trade retries and then sees the closed market. |
| First login | `create()`, not `set()`. Two concurrent first requests used to both write the document, and the loser's `set` could zero a balance. |
| Comment | `Increment(1)` is atomic. A retry can post a duplicate comment. Left alone: it is not money and the fix is a delete button. |
| Portfolio read | Not a snapshot. Totals can look inconsistent for the moment a resolution is paying out. Display only, self-corrects on the next poll. |

Two bugs found and fixed in this pass, both in `resolve`: the status flipped only
after the payout loop, so two resolvers clicking together paid every holder twice,
and there was no idempotency at all on trades.

## Findings and decisions

Append here when something is verified or decided. One or two lines. Only record
what would cost time to rediscover: a trap, a corrected assumption, a decision
with a reason. Routine progress does not belong here. Anything that also applies
to other projects goes in `CLAUDE.local.md` instead, not both.

- **2026-08-05: Supabase was designed in and then dropped.** The free plan caps
  an org at 2 active projects and both are taken. Firestore in `teejayproject`
  has no such cap, so the data model moved there. The design doc's Postgres and
  RLS sections are history, not the build.
- **2026-08-05: one Worker serves the site AND proxies the API.** Workers Assets
  hosts `web/`, and `/api/*` is rewritten to the Cloud Run host. This beats
  Pages plus a second hostname twice over: a Workers custom domain creates its
  own DNS record, and one origin means CORS does not exist. The hostname answered
  200 within seconds of the first deploy, with no cert wait. Renaming it later was
  one line in `wrangler.toml` plus a deploy: wrangler moved the custom domain and
  deleted the old DNS record itself.
- **2026-08-05: Firestore had no security rules at all.** Not restrictive rules,
  none, because the database was made through GCP rather than Firebase. A
  deny-all ruleset is now deployed. Registering a Firebase web app publishes an
  API key, so the two changes belong together: the key alone must not open the
  database. Nothing reads Firestore from a browser, by design.
- **2026-08-05: live charts need no realtime code.** The client polls the API
  every 8 seconds while a tab is visible. Cloud Run does support WebSockets, and
  Firestore listeners exist, but neither earns its complexity for 10 players.
  Revisit only if polling shows up as a real cost.
- **2026-08-05: there is no chaos setting.** One `b`, no `chaos_level`, no
  picker. The joke is that you cannot turn it down. The three presets were
  deleted from the design doc, not marked wrong. State the effect in words: "one
  ₹100 YES buy takes a 50% market to about 70%".
- **2026-08-05: resolution pays out one transaction per holder.** A single
  transaction over every holder would hit Firestore's 500-write limit and would
  retry the whole payout on any contention. Per-holder transactions retry alone.
- **2026-08-05: design direction is refined dark, mobile-first.** Phone layout is
  the base CSS, `@media (min-width: 800px)` adds desktop. Green and red mean YES
  and NO only. All numbers are tabular so prices do not jitter. Rejected
  editorial-light and neo-brutalist.
- **2026-08-05: enabling a Google sign-in provider cannot be scripted.** All
  three surfaces were checked: `firebase` CLI, `gcloud`, and the Identity Toolkit
  REST API. The API needs an OAuth client id and secret, and Google exposes no
  API to create an OAuth client, so the console does it. Registering the web app,
  initialising Auth and setting authorized domains ARE all scriptable.
- **2026-08-05: `--set-env-vars` cannot hold a comma, and `^@^` is a trap for
  emails.** See the Cloud Run gotchas in `CLAUDE.local.md`. Use `^|^`.
- **2026-08-05: the Discord webhook is a Cloud Run secret ref, not an env var.**
  `FOLLYMARKET_DISCORD_WEBHOOK` in Secret Manager, injected as
  `FOLLY_DISCORD_WEBHOOK`. It was pasted into a chat, so rotate it. Alerts are
  best effort in `tell_discord`: a dead webhook must never fail a trade.

- **2026-08-05: never name Discord in UI copy.** The alerts still fire from
  `tell_discord`, but the interface says "public in the ledger" or "he can see
  every attempt" instead. Discord is plumbing, not a feature the app boasts about.
- **2026-08-05: never hard-code a tab count in CSS.** `grid-template-columns:
  repeat(5, 1fr)` came from the mock's five tabs and crammed the app's three into
  60% of the bar. `grid-auto-flow: column` fits whatever is there. The same class
  of bug hid a `display: none` when the stylesheet was machine-extracted, which is
  why the mock now links `web/style.css` instead of holding a copy.

## Conventions

No em dashes anywhere. No emoji in UI copy or docs. Merge, never rebase. Commit
and push only when asked; this repo has no remote. Trades and resolution are
server-side only.
