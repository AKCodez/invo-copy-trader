```
 ___  ________   ___      ___ ________          ________  ________  ________  ___    ___ 
|\  \|\   ___  \|\  \    /  /|\   __  \        |\   ____\|\   __  \|\   __  \|\  \  /  /|
\ \  \ \  \\ \  \ \  \  /  / | \  \|\  \       \ \  \___|\ \  \|\  \ \  \|\  \ \  \/  / /
 \ \  \ \  \\ \  \ \  \/  / / \ \  \\\  \       \ \  \    \ \  \\\  \ \   ____\ \    / / 
  \ \  \ \  \\ \  \ \    / /   \ \  \\\  \       \ \  \____\ \  \\\  \ \  \___|\/  /  /  
   \ \__\ \__\\ \__\ \__/ /     \ \_______\       \ \_______\ \_______\ \__\ __/  / /    
    \|__|\|__| \|__|\|__|/       \|_______|        \|_______|\|_______|\|__||\___/ /     
                                                                          \|___|/       
```

<div align="center">

**Autonomous AI Copy Trading Agent**

*Reverse-engineered Invo social layer + Hyperliquid DEX execution*
*Powered by Claude Code*

---

`preflight` | `discover` | `follow` | `monitor` | `trade` | `close`

</div>

---

## What is this?

A fully autonomous copy trading system that connects [Invo](https://app.invoapp.com) (social trading platform) with [Hyperliquid](https://hyperliquid.xyz) (decentralized perpetual exchange). An AI agent discovers top-performing traders, follows them, monitors their trades in real-time, and mirrors their positions — all through reverse-engineered APIs. No browser automation. Pure Node.js.

**How it works:** The agent scans Invo's social feed for verified trade signals from followed traders. When a trader opens or closes a position, the feed emits a post containing the full trade details (coin, direction, leverage, entry price) plus Invo metadata needed to record the copy trade. The agent evaluates the signal against your configured risk criteria and executes on Hyperliquid, recording the position on both platforms.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   Claude Code (AI Agent)                                        │
│   ├── Reasoning & risk analysis                                 │
│   ├── Signal evaluation against user criteria                   │
│   └── Autonomous trade execution                                │
│         │                                                       │
│         ▼                                                       │
│   Node.js CLI                                                   │
│   ├── preflight.ts  ── 10-point readiness check                 │
│   ├── discover.ts   ── scan & rank 100+ traders                 │
│   ├── follow.ts     ── social graph management                  │
│   ├── monitor.ts    ── event-driven signal detection            │
│   ├── trade.ts      ── open / add to a copy (HL + Invo)         │
│   ├── close.ts      ── close / reduce one trader's copy         │
│   └── tpsl.ts       ── mirror the trader's TP/SL                │
│         │                                                       │
│    ┌────┴────────────────────┐                                  │
│    ▼                         ▼                                  │
│   Invo REST API         Hyperliquid SDK                         │
│   (auto-refresh JWT)    (phantom agent signing)                 │
│   ├── Discovery         ├── Meta & prices                       │
│   ├── Social feed        ├── Set leverage                       │
│   ├── Follow/unfollow   ├── Place orders (IOC)                  │
│   ├── Position create   ├── Close positions                     │
│   └── Position close    └── Account state                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Clone
git clone https://github.com/AKCodez/invo-copy-trader.git
cd invo-copy-trader

# Install
npm install

# Configure (see Credentials section below)
cp .env.example .env
# Edit .env with your credentials

# Pre-flight check
npx tsx src/commands/preflight.ts

# Run via Claude Code skill
/invo-copy-trade
```

<!-- SKILL_INSTALL_PLACEHOLDER -->
<!-- Installation instructions for the Claude Code skill will be added here once published to the skills marketplace. -->

## Commands

All commands run via `npx tsx src/commands/<cmd>.ts`.

| Command | Purpose | Example |
|---|---|---|
| `preflight.ts` | Full readiness check (10 checks) | `npx tsx src/commands/preflight.ts` |
| `verify.ts` | Endpoint health check (8 endpoints) | `npx tsx src/commands/verify.ts` |
| `discover.ts` | Scan & rank top traders | `npx tsx src/commands/discover.ts` |
| `follow.ts` | Follow/unfollow traders | `npx tsx src/commands/follow.ts follow <userId>` |
| `monitor.ts` | Real-time signal monitor (your Invo following list) | `npx tsx src/commands/monitor.ts` |
| `monitor.ts` | Extra /dex/trade watch entries (open copies are polled automatically) | `npx tsx src/commands/monitor.ts '[{"baseShortId":"x","mimicStartedAt":"..."}]'` |
| `monitor.ts` | Wait-for-signal mode (resumes from `data/monitor-state.json`; missed opens copied only if stopped ≤ `--max-catchup`, default 300s) | `npx tsx src/commands/monitor.ts --wait-for-signal` |
| `trade.ts` | Copy an open, or the trader's increase | `npx tsx src/commands/trade.ts '<open or increase signal JSON>'` |
| `trade.ts` | Open a position (copies nobody) | `npx tsx src/commands/trade.ts SOL long auto 5 manual` |
| `close.ts` | Close one trader's copy, or reduce it by the trader's partial close | `npx tsx src/commands/close.ts '<close or decrease signal JSON>'` |
| `tpsl.ts` | Set/move our TP or SL to the trader's | `npx tsx src/commands/tpsl.ts '<tpsl signal JSON>'` |
| `close.ts` | Flatten a coin (explicit user request) | `npx tsx src/commands/close.ts SOL manual` |

## Signal Detection

The monitor copies **only the traders your Invo account currently follows**. At startup it loads your following list (`POST /v1_0/users/get_following`) and resolves each trader's portfolios (`POST /v1_0/portfolios/v2/get_users_portfolios`), then re-fetches the list every 60s (`--refresh=<sec>`, min 10) and on demand when the feed shows an unknown trader. Follow or unfollow people in the Invo app — the monitor picks it up on the next refresh or restart and prints a `following_changed` line. It never follows or unfollows anyone itself, and exits if the following list can't be loaded at startup.

A feed post becomes a `signal` only if it's a verified trade (`verifiedTrade: true`), not a repost, its owner is in the current following list, and its portfolio belongs to that trader. Open and increase signals must also include the trader's trade IDs (`id`, `baseId`, `baseShortId`); close signals don't need them. Other trade posts are logged to stderr as `{"type":"skipped","reason":...}`. Each signal contains:

```
Feed post (postTypeId: "investment" | "update")
  └── update
      ├── ticker          → coin (SOL, BTC, ETH)
      ├── directionLong   → true = long, false = short
      ├── leverage         → leverage used
      ├── entryPrice       → entry price
      ├── closingPrice     → exit price (on close)
      ├── isOpen           → position state
      ├── verifiedTrade    → confirmed real Invo trade
      ├── portfolio.id     → mimicMeta.portfolioId
      ├── owner.id         → mimicMeta.creatorInvoUserId
      ├── id               → mimicMeta.initialSourcePaperUpdateId
      ├── baseId           → mimicMeta.sourcePaperTradeBaseId
      └── baseShortId      → mimicMeta.sourcePaperTradeBaseShortId (trader's; for /dex/trade polling)
```

**Two monitor modes:**

| Mode | Behavior | Use case |
|---|---|---|
| Default | Runs forever, prints JSON lines | Manual monitoring, log tailing |
| `--wait-for-signal` | Exits after first new signal | Agent auto-notify (zero token burn while waiting) |

In `--wait-for-signal` mode, the Node.js process polls server-side (free) and the AI agent is idle until a signal arrives. Event-driven, not polling-driven.

## Copy Trading Flow

A copy replicates the trader's trade — asset, direction, leverage, entry price,
TP/SL, increases, partial closes, closes and liquidations — and differs only in
size, which comes from **our** Hyperliquid equity (5–15%), never the trader's
dollar amount or account %. All parameters are taken from the monitor's signal
JSON, never typed separately. Anything that can't be replicated exactly is
refused rather than approximated:

| Trader does | We do | Refused when |
|---|---|---|
| Opens (feed `open`) | `trade.ts`: their coin, side, leverage (isolated); IOC limit ≤ 2% worse than their entry price; size clamped so all active copies stay within 80% of equity | posted > 300s ago (or no post time); price already moved > 2% against their entry; leverage over HL max or ≠ the coin's existing leverage; any trigger/TP/SL order in the coin |
| Opens with TP/SL | Their exact prices as HL position TP/SL after the fill | price not exactly placeable; already crossed; coin position shared with other trades |
| Adds (`/dex/trade` `increase`) | `trade.ts`: same % of our copy (in coins, from the $ figures in Invo's feed post for the change), capped at the room left under 80% of equity for all active copies, and at the tier % of equity (≤ 15%), the room left under 15% of equity for the whole copy, and 80% of the copy (or coin position, if smaller) | older than 300s; copy already at 15% of equity; under $10 |
| Partial close (`decrease`) | `close.ts`: same % of our copy (from the $ figures in Invo's feed post for the change), reduce-only | under $10 (except a full close); live position smaller than the copies tracked in it; no feed post with $ figures within 120s, or figures that don't reconcile (adds too) |
| Sets/moves TP/SL (`tp`/`sl`) | `tpsl.ts`: cancel ours, place theirs | copy isn't the whole coin position; a TP/SL we didn't place; no price given (removal not seen yet) |
| Closes / TP or SL hit / liquidated | `close.ts`: close the copy (reduce-only) | — (already gone → `already_closed`) |

```
Signal detected: @trader opened SOL long 8x
  │
  ├── 1. Evaluate against locked-in criteria
  │      ├── Leverage ≤ max? (e.g., 8x ≤ 20x ✓)
  │      ├── Asset allowed? (SOL not blocked ✓)
  │      ├── Trader WR ≥ auto-copy threshold? (86% ≥ 80% ✓)
  │      └── Size computed in code (src/sizing.ts) from fresh account equity:
  │          initial 5-15% of equity by trader tier (poor 5%, average 7.8/10.4%,
  │          strong 15%; never under HL's $10 minimum, refused under $66.67 equity);
  │          increases: the trader's add in proportion to our copy, capped at
  │          tier % (≤ 15%), 15% of equity for the whole copy, and 80% of the copy
  │
  ├── 2. Execute on Hyperliquid
  │      ├── Set the trader's leverage (8x isolated)
  │      ├── Place IOC limit order (≤ 2% worse than the trader's entry, builder fee)
  │      ├── Verify fill
  │      └── Place the trader's TP/SL (position TP/SL, exact prices)
  │
  ├── 3. Record on Invo
  │      ├── POST /dex/position/create
  │      ├── mimicMeta from signal, passed unchanged (validated before any order)
  │      └── Output: sourceBaseShortId (trader's) + positionRecordId (ours)
  │
  └── 4. Monitor for exit
         ├── Trader adds / reduces / changes TP/SL → trade.ts / close.ts / tpsl.ts
         │      with that change signal (from /dex/trade; each applied once)
         └── When trader closes → close.ts with the close signal
                closes only that trader's copy (matched in data/copy-ledger.json);
                other copies in the same coin stay open. Unmatched → refused.
                Open copies are also polled on /dex/trade, so a close is seen
                even after an unfollow. trade/close run one at a time (lock file)
                and record every order as pending before sending it.
```

**Exit strategy: mirror the trader.** We close when they close, reduce when they reduce, and use their TP/SL — never one of our own. The whole point of copy trading is trusting the trader's entries AND exits.

## Credentials Setup

Create a `.env` file in the project root:

```env
INVO_REFRESH_TOKEN=eyJ...   # 350-day JWT (see below)
HL_AGENT_KEY=0x...           # Hyperliquid phantom agent key
WALLET_ADDRESS=0x...         # Master wallet address
```

### How to obtain each credential

**`INVO_REFRESH_TOKEN`** (valid ~350 days)
1. Open `app.invoapp.com` in Chrome, log in
2. F12 -> Application -> Local Storage -> `app.invoapp.com`
3. The value of `FlutterSecureStorage.REFRESH_TOKEN` is AES-GCM encrypted
4. Decrypt using the key in the `FlutterSecureStorage` entry (base64 AES-GCM key)
5. The decrypted value is a JWT — that's your refresh token

**`HL_AGENT_KEY`** (valid ~90 days)
1. F12 -> Application -> IndexedDB -> `invo_hl_agents` -> `agents` -> `current`
2. Copy the `privateKey` field (starts with `0x`)
3. This is a secp256k1 key authorized as a phantom agent sub-key

**`WALLET_ADDRESS`**
1. Visible in your Invo profile page
2. Or in the JWT payload under `trading_account.wallet_address`

### Credential lifespan

| Credential | TTL | Renewal |
|---|---|---|
| `INVO_REFRESH_TOKEN` | ~350 days | Re-extract from browser |
| `HL_AGENT_KEY` | ~90 days | Re-authorize in Invo app |
| `WALLET_ADDRESS` | Permanent | Never changes |

The system auto-refreshes short-lived access tokens (10-min TTL) using the refresh token. No manual token management after initial setup.

## Reverse-Engineered API Surface

### Invo REST API (`api.invoapp.com`)

All requests use `Authorization: Bearer <jwt>`, `Content-Type: application/json`, `x-app-version: 0.0.75`, `x-platform: web`.

```
GET  /v1_0/auth/refresh_token           → Refresh access token (10-min → 350-day cycle)
POST /v1_0/trending/get_portfolios_pl   → Discover traders (filters: trending, all, user)
POST /v1_0/trending/get_users           → Trending users
POST /v1_0/posts/get_feed               → Social feed (filters: trending, following, all)
POST /v1_0/users/follow                 → Follow user
POST /v1_0/users/unfollow               → Unfollow user
GET  /v1_0/users/get_user               → Current user (id)
POST /v1_0/users/get_following          → Users you follow {userId, query, params: {page, size}}
POST /v1_0/portfolios/v2/get_users_portfolios → A user's portfolios {userId, params: {isDeleted, page, size}}
POST /dex/account/ready                 → Account readiness check
POST /dex/trade                         → Trade status polling (data[].updates[].updateType: close, tp, sl)
POST /dex/position/create               → Record open in Invo wallet
POST /dex/position/close                → Record close in Invo wallet
GET  /investment/status/:id             → Investment status
```

### Hyperliquid Exchange

Accessed via the `hyperliquid` npm SDK with phantom agent signing:

```
POST api.hyperliquid.xyz/info  → Meta, prices, positions
SDK  exchange.placeOrder()     → IOC limit orders with builder fee
SDK  exchange.updateLeverage() → Set leverage (isolated)
```

Builder fee: `0x557edb253b1d7ed5f15b248a5a3fd919fa5d3c81` at 0.35% — required on all orders for Invo compatibility.

## Discovery Criteria

The `discover.ts` scanner applies strict quality filters (configurable via the agent):

```
closedPositions  >= 100     # Proven track record
daysActive       >= 90      # Not a flash-in-the-pan
winRate          >= 75%     # Consistent performer
percentChange    >= 500%    # Significant returns
winLossRatio     >= 3.0     # Disciplined risk management
liquidated       == false   # Never blown up
```

Composite score: `W/L*20 + WinRate*1.5 + P&L*0.01 + Streak*2 - Losses*0.5`

## Asset Reference

| Asset | HL Index | szDecimals | Max Leverage |
|-------|----------|------------|-------------|
| BTC   | 0        | 5          | 40x         |
| ETH   | 1        | 4          | 25x         |
| SOL   | 5        | 2          | 20x         |
| DOGE  | 12       | 0          | 10x         |
| XRP   | 25       | 0          | 20x         |

## Known Issues & Workarounds

| Issue | Cause | Fix |
|-------|-------|-----|
| `reduce_only: true` was reported to break signing | Phantom agent EIP-712 signature recovery failed | Unconfirmed: the SDK encodes the flag the same either way and its own `marketClose` uses `true`. Opens use `false`; closes use `true` so they can never flip a position. If a close fails with a signer error, it reports `not_filled` with `orderError` |
| `grouping: 'normalTpsl'` breaks signing | Reported upstream (unconfirmed): multi-order grouping causes wrong signer | Entry/close orders use `'na'`. TP/SL are separate `positionTpsl` orders as the Invo app sends them — not yet confirmed live from this tool; a rejection is reported as `tpsl.error` (non-zero exit) |
| `"Unknown asset: SOL"` | SDK expects `-PERP` suffix | Use `SOL-PERP`, `BTC-PERP`, etc. (handled in `hl-client.ts`) |
| `"Price must be divisible by tick size"` | More than 5 significant figures, or more than `6 − szDecimals` decimals | Both limits applied by `limitPrice` in `sizing.ts` (rounded away from mid) |
| `"Order has invalid size"` | Wrong szDecimals for the asset | Check asset table above |
| `"Order price cannot be more than 95% away"` | Position too large for available margin | Reduce size |
| `/dex/trade` returns 404 | Polling with a `baseShortId` that isn't the trader's | Use `signal.mimicMeta.sourcePaperTradeBaseShortId` (= `trade.ts` `sourceBaseShortId`) |
| Agent key expired | ~90-day validity | Re-authorize in Invo app |
| Feed signal delay | Trade posts appear 1-10s after execution | Acceptable for copy trading (not HFT) |

## Tech Stack

- **Runtime**: Node.js + TypeScript (via tsx)
- **HL SDK**: `hyperliquid` (^1.7.7) — handles EIP-712 signing, msgpack, order placement
- **HTTP**: Native `fetch()` — no axios, no browser
- **Auth**: JWT auto-refresh via reverse-engineered `/v1_0/auth/refresh_token` endpoint
- **Signal detection**: Invo social feed polling with verified trade filtering
- **Agent integration**: Claude Code skill (`/invo-copy-trade`) for autonomous operation

## Disclaimer

> **USE AT YOUR OWN RISK.** This software is provided "as is", without warranty of any kind, express or implied. The authors and contributors are **not responsible** for any financial losses, liquidations, missed trades, or damages of any kind arising from the use of this software.

**By using this software, you acknowledge and agree that:**

1. **Not Financial Advice.** Nothing in this repository constitutes financial advice, investment advice, trading advice, or any other sort of professional advice. You are solely responsible for your own trading decisions.

2. **No Guaranteed Returns.** Past performance of any trader, strategy, or signal does not guarantee future results. Copy trading is inherently risky and you can lose your entire investment.

3. **Experimental Software.** This project relies on reverse-engineered, undocumented APIs that may change, break, or become unavailable at any time without notice. There is no guarantee of uptime, accuracy, or reliability.

4. **API & Protocol Risk.** This software interacts with third-party platforms (Invo, Hyperliquid) over which the authors have no control. API changes, outages, rate limits, or account restrictions imposed by these platforms are outside the scope of this project.

5. **Smart Contract & DeFi Risk.** Hyperliquid is a decentralized exchange. Transactions are on-chain and irreversible. You accept all risks associated with DeFi protocols, including but not limited to smart contract bugs, oracle failures, and network congestion.

6. **No Affiliation.** This project is **not affiliated with, endorsed by, or associated with** Invo or Hyperliquid in any way. All trademarks belong to their respective owners.

7. **Regulatory Compliance.** You are solely responsible for ensuring that your use of this software complies with all applicable laws and regulations in your jurisdiction. Copy trading and leveraged trading may be restricted or prohibited in certain regions.

8. **Key & Credential Security.** You are responsible for safeguarding your private keys, agent keys, and tokens. The authors are not liable for any unauthorized access or loss of funds resulting from compromised credentials.

9. **Leverage Risk.** Leveraged trading amplifies both gains and losses. Positions can be liquidated, resulting in total loss of margin. Understand leverage before using this software.

10. **No Warranty of Accuracy.** Discovery scores, win rates, P&L figures, and all other metrics are derived from third-party data and may be inaccurate, delayed, or incomplete.

**If you do not agree with any of the above, do not use this software.**

## License

MIT — see above disclaimer. The MIT license's "AS IS" clause applies in full.
