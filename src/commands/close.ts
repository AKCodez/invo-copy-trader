import { randomUUID } from 'crypto';
import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as invo from '../invo-client.js';
import * as hl from '../hl-client.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

async function main() {
  const [coin, baseShortId] = process.argv.slice(2);

  if (!coin) {
    console.error('Usage: close <coin> [baseShortId]');
    process.exit(1);
  }

  await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS);

  // Current position
  const positions = await hl.getPositions(WALLET_ADDRESS);
  const pos = positions.find((p: any) => p.coin === coin);
  if (!pos) throw new Error(`No open position for ${coin}`);

  const qtyBefore = pos.szi;

  // Resolve asset index
  const meta = await hl.getMeta();
  const assetIndex = meta.universe.findIndex(a => a.name === coin);
  if (assetIndex < 0) throw new Error(`Unknown coin: ${coin}`);

  // Close on HL
  const nonceMs = Date.now();
  const closeResult = await hl.closePosition(coin, WALLET_ADDRESS);

  // Record on Invo (best-effort — Invo auto-detects HL closes)
  let invoResult: any = null;
  if (baseShortId) {
    try {
      invoResult = await invo.recordClose({
        clientTxId: randomUUID(),
        baseShortId,
        assetIndex,
        submission: {
          hlOrder: closeResult,
          nonceMs,
          hlResponse: closeResult,
        },
        summary: {
          qtyBefore,
          qtyAfter: '0',
        },
      });
    } catch (e: any) {
      invoResult = { error: e.message };
    }
  }

  console.log(JSON.stringify({
    status: 'closed',
    coin,
    qtyBefore,
    hlResult: closeResult,
    invoResult,
  }));
}

main().catch(e => { console.error(e.message); process.exit(1); });
