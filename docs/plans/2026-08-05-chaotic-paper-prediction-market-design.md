# Follymarket Design

## Working Name

**Follymarket**

A closed friend-group web app for funny trip predictions. It should feel like a tiny internal Polymarket/Manifold, but without real-money rails. Users get fake balances, trade YES/NO shares on events, watch probabilities move, and settle the final ledger after outcomes are resolved.

## Product Goal

Create a private web app where invited Google-auth users can:

- Sign in with Google through Supabase Auth.
- Create funny prediction markets.
- Buy YES/NO with fake money.
- See live probability, chart history, recent trades, holders, comments, and resolution status.
- Track fake balances, positions, unrealized value, and potential payout.
- Resolve markets as YES, NO, or VOID.
- Generate a final settlement ledger at the end.
- Send Discord alerts for signups and key activity.

The app should preserve the fun of a market without becoming a real financial product.

## Market Mechanism

Use an **LMSR automated market maker** for v1.

LMSR is a classic prediction-market AMM. It gives every market continuous liquidity, moves prices automatically when users trade, and has a bounded market-maker loss. It is simpler for a friend group than a full order book.

For binary markets:

```text
price_yes = exp(yes_shares / b) / (exp(yes_shares / b) + exp(no_shares / b))
price_no = 1 - price_yes
```

The `b` parameter controls how sensitive the market is. Users never see `b`.

There is exactly one sensitivity and it is deliberately violent. It is tuned for
the bets people actually place, ₹25 to ₹200: a ₹100 YES buy takes a 50% market to
about 70%, and ₹500 nearly settles it at 96%.

`b = 200`. Lower `b` is more violent. Tuning it for ₹500 bets, as the first
version did with `b = 600`, made a ₹50 bet move the price 4 points, which is not
a joke, it is a spreadsheet. That is the joke, so it is not configurable.
No chaos presets, no picker, no `chaos_level` column. Tune the single `b`
constant against worked examples during implementation, and state its effect in
plain words in the UI: "one ₹100 YES buy takes a 50% market to about 70%".

## Close And Resolution

### Close Mode

Closing controls when trading stops.

Supported v1 modes:

- **Manual close**: resolver/admin closes trading when appropriate. Default.
- **Date/time close**: market closes automatically at a chosen time.

Manual close is the default because friend-trip markets often have messy timing.

### Resolution

After a market is closed, the resolver can mark it:

- **YES**: YES shares pay out.
- **NO**: NO shares pay out.
- **VOID**: trades are refunded or neutralized.

Resolution should be auditable. The app should record who resolved it, when, and any short note.

## Core Screens

### 1. Sign In

Purpose: keep the app closed.

Elements:

- Google sign-in button.
- Access denied state for users outside the allowlist.
- Simple pending/approved state if invite approval is enabled.

Behavior:

- New signup creates a user profile.
- New signup sends a Discord alert.
- App checks the allowlist before showing private content.

### 2. Home / Market Feed

Purpose: let users see what is alive right now.

Content:

- Active markets sorted by activity or newest.
- Current YES probability.
- Small trend sparkline.
- Status: open, closed, resolved, void.
- Volume traded.
- Comment count.
- User's position badge if they hold shares.

Filters:

- Open.
- Closing soon.
- Resolved.
- My positions.
- Created by me.

Primary actions:

- Create market.
- Open market detail.

### 3. Create Market

Fields:

- Question.
- Description/context.
- Category/tag.
- Initial probability.
- Close mode: manual or date/time.
- Resolver: creator by default, admin override allowed.

Validation:

- Question is required.
- Initial probability must be between 1% and 99%.
- Date/time close must be in the future.

After creation:

- Market opens immediately.
- Creator may optionally seed the first trade, but v1 does not require this.
- Discord alert can announce new market creation.

### 4. Market Detail

Purpose: the main trading surface.

Content:

- Question and description.
- Current probability.
- YES/NO buy panel.
- Trade preview.
- Price chart.
- Recent trades.
- Holders/leaderboard.
- Comments.
- Status and resolution controls where permitted.

Trade preview should show:

- Spend amount.
- Shares received.
- Average price.
- Current probability.
- New probability after trade.
- Potential payout if correct.
- Max loss for that trade.

Actions:

- Buy YES.
- Buy NO.
- Comment.
- Close market if resolver/admin.
- Resolve market if closed and permitted.
- Void market if admin/resolver.

### 5. Portfolio

Purpose: make the fake-money game legible.

Content:

- Fake cash balance.
- Total portfolio value.
- Unrealized gain/loss.
- Open positions grouped by market.
- Potential payout by market.
- Resolved winnings/losses.
- Transaction history.

Important distinction:

- **Cash balance**: unspent fake money.
- **Position value**: current estimated sale/mark-to-market value.
- **Potential payout**: amount if the chosen side resolves true.
- **Final settlement**: what the group should settle outside the app, if desired.

### 6. Activity

Purpose: make the app feel alive.

Items:

- New market.
- Trade placed.
- Large price movement.
- Market closed.
- Market resolved.
- Comment added.
- New signup.

Some activity can also be sent to Discord.

### 7. Admin / Settings

Purpose: keep the private group manageable.

Controls:

- Manage allowlist.
- Promote admins.
- Set starting fake balance.
- Configure Discord webhook.
- Force close/void markets.
- Export final ledger.

## Core Flows

### Signup Flow

1. User opens app.
2. User signs in with Google.
3. Supabase creates auth user.
4. App creates profile if missing.
5. App checks allowlist.
6. Discord receives signup alert.
7. User enters app if allowed.

### Create Market Flow

1. User clicks create.
2. User enters question and optional context.
3. User picks the initial probability.
4. User chooses manual close or close time.
5. App creates market with LMSR state.
6. Market appears in feed.
7. Discord optionally receives new market alert.

### Trade Flow

1. User opens a market.
2. User chooses YES or NO.
3. User enters fake amount.
4. App previews shares and new probability.
5. User confirms.
6. Server validates balance, market status, and math.
7. Server writes trade, updates market state, and updates user balance.
8. Market chart and activity update.

All trade calculations must happen server-side in a transaction or serialized endpoint. The client can preview, but the server is authoritative.

### Resolution Flow

1. Market is manually closed or reaches close time.
2. Resolver opens resolution controls.
3. Resolver chooses YES, NO, or VOID.
4. App previews settlement impact.
5. Resolver confirms.
6. Server records resolution.
7. Server credits fake balances or marks final ledger rows.
8. Discord receives resolution alert.

### Final Ledger Flow

1. Admin opens final ledger.
2. App shows each user's net result across resolved markets.
3. Admin exports CSV.
4. Group settles outside the app if they choose.

## Data Model

### users

- `id`
- `supabase_user_id`
- `email`
- `display_name`
- `avatar_url`
- `role`: user/admin
- `status`: pending/allowed/blocked
- `fake_cash_balance`
- `created_at`
- `last_seen_at`

### allowlist

- `id`
- `email`
- `created_by`
- `created_at`

### markets

- `id`
- `question`
- `description`
- `category`
- `creator_user_id`
- `resolver_user_id`
- `status`: open/closed/resolved/void
- `initial_probability`
- `current_probability`
- `lmsr_b`
- `yes_shares`
- `no_shares`
- `close_mode`: manual/datetime
- `close_at`
- `resolved_outcome`: yes/no/void/null
- `resolution_note`
- `resolved_by`
- `resolved_at`
- `created_at`
- `updated_at`

### trades

- `id`
- `market_id`
- `user_id`
- `side`: yes/no
- `amount_spent`
- `shares_received`
- `avg_price`
- `prob_before`
- `prob_after`
- `created_at`

### positions

- `id`
- `market_id`
- `user_id`
- `yes_shares`
- `no_shares`
- `total_spent`
- `realized_payout`
- `updated_at`

### comments

- `id`
- `market_id`
- `user_id`
- `body`
- `created_at`
- `deleted_at`

### ledger_entries

- `id`
- `market_id`
- `user_id`
- `type`: trade/resolution/refund/admin_adjustment
- `amount`
- `description`
- `created_at`

### activity_events

- `id`
- `actor_user_id`
- `market_id`
- `type`
- `payload`
- `created_at`

## Auth And Access

Use Supabase Auth with Google provider.

Access strategy:

- Google sign-in creates auth identity.
- App profile is created on first login.
- Only allowlisted emails can enter the app.
- Non-allowlisted users see a blocked/pending screen.
- Admins manage allowlist inside the app.

Row-level security should enforce:

- Users can read allowed private market data only if allowed.
- Users can write their own comments/trades only through controlled policies or server endpoints.
- Critical trade and resolution writes should go through the backend service.

## Backend

Deploy a backend service to Google Cloud Run.

Responsibilities:

- Server-authoritative trade execution.
- LMSR calculations.
- Balance updates.
- Market close/resolve operations.
- Discord webhook calls.
- Admin-only exports and overrides.

The client may read low-risk data directly from Supabase, but trades and resolution should go through Cloud Run to avoid race conditions and tampering.

## Discord Alerts

Minimum v1 alerts:

- New signup.
- New market.
- Large trade or large probability movement.
- Market resolved.

Signup alert example:

```text
New signup: Tejas <tejas@example.com>
Status: allowed
Time: 2026-08-05 21:42 IST
```

Market alert example:

```text
New market: "Nihal gets too drunk..."
Created by: Tejas
Initial probability: 50%
```

## V1 Scope

Must have:

- Supabase Google auth.
- Allowlist.
- Market feed.
- Create market.
- LMSR YES/NO trading.
- Portfolio.
- Market detail with probability, chart, recent trades, holders, comments, status.
- Manual close.
- Date/time close.
- Resolve YES/NO/VOID.
- Final ledger export.
- Discord signup alerts.

Should have:

- Discord market/resolution alerts.
- Admin balance adjustment.
- Activity feed.
- Basic mobile support.

Not v1:

- Real money payments.
- Crypto wallets.
- Full order book.
- Limit orders.
- Multiple-outcome markets.
- Public markets.
- Complex moderation.
- Native mobile app.

## Open Product Decisions

- Starting fake balance per user.
- Whether signup is allowlist-only or pending approval.
- The exact `b` value.
- Whether users can sell shares before resolution.
- Whether creators can resolve their own markets or only admins/resolvers.
- Whether VOID refunds original spend or restores market as if trades never happened.
- Whether comments should support images/GIFs.

## Recommended Decisions

- Starting fake balance: ₹10,000.
- Access: allowlist-only, with Discord alert for all signup attempts.
- Selling: defer from v1 unless implementation feels easy after buy flow is stable.
- Resolver: creator by default; admins can override.
- VOID: refund original spend for open positions.
- Comments: text-only v1.

## Implementation Notes

The LMSR math should live in a shared tested module used by the backend and optionally by the frontend for previews.

Server endpoints:

- `POST /api/trades/preview`
- `POST /api/trades`
- `POST /api/markets`
- `POST /api/markets/:id/close`
- `POST /api/markets/:id/resolve`
- `GET /api/portfolio`
- `GET /api/ledger/export`

Tests should cover:

- LMSR price calculation.
- Buy YES increases YES probability.
- Buy NO decreases YES probability.
- Larger trades move price more.
- Balance cannot go negative.
- Closed markets reject trades.
- Resolved markets reject trades.
- VOID refunds correctly.
- Concurrent trades do not corrupt market state.

## Research References

- cdetrio LMSR demo: https://github.com/cdetrio/prediction-market-lmsr
- Gnosis LMSR market maker: https://github.com/gnosis/conditional-tokens-market-makers/blob/master/contracts/LMSRMarketMaker.sol
- Manifold open-source repo: https://github.com/manifoldmarkets/manifold
- Manifold CPMM implementation: https://github.com/manifoldmarkets/manifold/blob/main/common/src/calculate-cpmm.ts
- Polymarket market-maker keeper: https://github.com/Polymarket/poly-market-maker
