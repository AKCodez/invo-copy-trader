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

`discover` | `follow` | `monitor` | `trade` | `close`

</div>

---

## What is this?

A fully autonomous copy trading system that connects [Invo](https://app.invoapp.com) (social trading platform) with [Hyperliquid](https://hyperliquid.xyz) (decentralized perpetual exchange). An AI agent discovers top-performing traders, follows them, monitors their trades in real-time, and mirrors their positions — all through reverse-engineered APIs. No browser automation. Pure Node.js.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   Claude Code (AI Agent)                                        │
│   ├── Reasoning & analysis                                      │
│   ├── Risk assessment                                           │
│   └── Autonomous decision-making                                │
│         │                                                       │
│         ▼                                                       │
│   Node.js CLI                                                   │
│   ├── preflight.ts  ── 10-point readiness check                 │
│   ├── discover.ts   ── scan & rank 100+ traders                 │
│   ├── follow.ts     ── social graph management                  │
│   ├── monitor.ts    ── real-time signal detection                │
│   ├── trade.ts      ── open position (HL + Invo)                │
│   └── close.ts      ── close position (HL + Invo)               │
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

# Pre-flight check
npx tsx src/commands/preflight.ts

# Run via Claude Code skill
/invo-copy-trade
```

## Commands

| Command | Purpose | Example |
|---|---|---|
| `preflight.ts` | Full readiness check (10 checks) | `npx tsx src/commands/preflight.ts` |
| `verify.ts` | Endpoint health check (8 endpoints) | `npx tsx src/commands/verify.ts` |
| `discover.ts` | Scan & rank top traders | `npx tsx src/commands/discover.ts` |
| `follow.ts` | Follow/unfollow traders | `npx tsx src/commands/follow.ts follow <userId>` |
| `monitor.ts` | Real-time signal monitor | `npx tsx src/commands/monitor.ts '["portfolioId"]'` |
| `trade.ts` | Open a position | `npx tsx src/commands/trade.ts SOL long 0.14 5` |
| `close.ts` | Close a position | `npx tsx src/commands/close.ts SOL [baseShortId]` |

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

## Reverse-Engineered API Surface

### Invo REST API (`api.invoapp.com`)

```
POST /v1_0/trending/get_portfolios_pl   → Discover traders
POST /v1_0/trending/get_users           → Trending users
POST /v1_0/posts/get_feed               → Social feed
POST /v1_0/users/follow                 → Follow user
POST /v1_0/users/unfollow               → Unfollow user
POST /dex/account/ready                 → Account readiness
POST /dex/trade                         → Trade status polling
POST /dex/position/create               → Record open in Invo wallet
POST /dex/position/close                → Record close in Invo wallet
GET  /v1_0/auth/refresh_token           → Refresh access token (350d)
GET  /investment/status/:id             → Investment status
```

All requests use `Authorization: Bearer <jwt>` with headers `x-app-version: 0.0.75`, `x-platform: web`.

Auto-refresh: access tokens expire in ~10 minutes. The client automatically refreshes using the long-lived refresh token before every request.

### Hyperliquid Exchange

Accessed via the `hyperliquid` npm SDK with phantom agent signing:

```
POST api.hyperliquid.xyz/info  → Meta, prices, positions
SDK  exchange.placeOrder()     → IOC limit orders with builder fee
SDK  exchange.updateLeverage() → Set leverage (isolated)
```

Builder fee: `0x557edb253b1d7ed5f15b248a5a3fd919fa5d3c81` at 0.35% — required on all orders for Invo compatibility.

## Discovery Criteria

The `discover.ts` scanner applies strict quality filters:

```
closedPositions  >= 100     # Proven track record
daysActive       >= 90      # Not a flash-in-the-pan
winRate          >= 75%     # Consistent performer
percentChange    >= 500%    # Significant returns
winLossRatio     >= 3.0     # Disciplined risk management
liquidated       == false   # Never blown up
```

Composite score: `W/L*20 + WinRate*1.5 + P&L*0.01 + Streak*2 - Losses*0.5`

## Trade Execution Flow

```
trade.ts SOL long 0.14 5
  │
  ├── 1. Connect HL SDK (agent key + wallet)
  ├── 2. Lookup asset index (SOL = 5, szDecimals = 2)
  ├── 3. Set leverage (5x isolated)
  ├── 4. Snapshot position before
  ├── 5. Place IOC limit order (+2% slippage, builder fee)
  ├── 6. Snapshot position after
  ├── 7. Record on Invo (POST /dex/position/create)
  │      └── mimicMeta (4 UUID fields)
  │      └── submission (hlOrder + hlResponse)
  │      └── summary (qtyBefore, qtyAfter, leverage)
  └── 8. Output: fill details + baseShortId
```

The `baseShortId` is a 10-char client-generated ID required to close positions via the Invo API.

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
| `reduce_only: true` breaks signing | Phantom agent EIP-712 signature recovery fails | Always use `reduce_only: false` |
| `grouping: 'normalTpsl'` breaks signing | Multi-order grouping causes wrong signer | Always use `grouping: 'na'` |
| `"Order has invalid size"` | Wrong szDecimals for the asset | Check asset table above |
| `"Order price cannot be more than 95% away"` | Position too large for available margin | Reduce size |
| Agent key expired | ~90-day validity | Re-authorize in Invo app |

## Tech Stack

- **Runtime**: Node.js + TypeScript (via tsx)
- **HL SDK**: `hyperliquid` (^1.7.7) — handles EIP-712 signing, msgpack, order placement
- **HTTP**: Native `fetch()` — no axios, no browser
- **Auth**: JWT auto-refresh via reverse-engineered `/v1_0/auth/refresh_token` endpoint
- **Crypto**: AES-GCM decryption of FlutterSecureStorage tokens

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
