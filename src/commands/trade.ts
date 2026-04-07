import { randomUUID, randomBytes } from 'crypto';
import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as invo from '../invo-client.js';
import * as hl from '../hl-client.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

function genBaseShortId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = randomBytes(10);
  let id = '';
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

async function main() {
  const [coin, side, sizeStr, leverageStr, mimicMetaJson] = process.argv.slice(2);

  if (!coin || !side || !sizeStr) {
    console.error('Usage: trade <coin> <long|short> <size> [leverage] [mimicMetaJson]');
    process.exit(1);
  }

  const isBuy = side === 'long';
  const leverage = parseInt(leverageStr ?? '1', 10);

  await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS);

  // Resolve asset index
  const meta = await hl.getMeta();
  const assetIndex = meta.universe.findIndex(a => a.name === coin);
  if (assetIndex < 0) throw new Error(`Unknown coin: ${coin}`);

  // Set leverage
  await hl.setLeverage(coin, leverage);

  // Snapshot position before
  const posBefore = await hl.getPositions(WALLET_ADDRESS);
  const existing = posBefore.find((p: any) => p.coin === coin);
  const qtyBefore = existing ? existing.szi : '0';

  // Place order on HL
  const nonceMs = Date.now();
  const orderResult = await hl.placeMarketOrder(coin, isBuy, sizeStr);

  // Snapshot position after
  const posAfter = await hl.getPositions(WALLET_ADDRESS);
  const updated = posAfter.find((p: any) => p.coin === coin);
  const qtyAfter = updated ? updated.szi : '0';

  // IDs
  const baseShortId = genBaseShortId();
  const clientTxId = randomUUID();

  // Build mimicMeta (accept from arg or generate random UUIDs)
  const mimicMeta = mimicMetaJson
    ? JSON.parse(mimicMetaJson)
    : {
        portfolioId: randomUUID(),
        creatorInvoUserId: randomUUID(),
        initialSourcePaperUpdateId: randomUUID(),
        sourcePaperTradeBaseId: randomUUID(),
      };

  // Record on Invo (non-fatal if it fails — position is open on HL regardless)
  let invoResult: any = null;
  try {
    invoResult = await invo.recordOpen({
      clientTxId,
      coin,
      assetIndex,
      entry: {
        side: isBuy ? 'long' : 'short',
        marginMode: 'isolated',
        leverage,
        tpPx: null,
        slPx: null,
      },
      submission: {
        hlOrder: orderResult,
        nonceMs,
        hlResponse: orderResult,
      },
      summary: {
        qtyBefore,
        qtyAfter,
        intendedLeverage: leverage,
      },
      mimicMeta,
    });
  } catch (e: any) {
    invoResult = { error: e.message };
  }

  console.log(JSON.stringify({
    status: 'filled',
    coin,
    side,
    size: sizeStr,
    leverage,
    baseShortId,
    clientTxId,
    qtyBefore,
    qtyAfter,
    hlResult: orderResult,
    invoResult,
  }));
}

main().catch(e => { console.error(e.message); process.exit(1); });
