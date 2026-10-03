import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as invo from '../invo-client.js';
import * as hl from '../hl-client.js';
import { runTrade } from '../trade-exec.js';
import { FileLedgerStore, defaultLedgerPath } from '../copy-ledger.js';
import { withFileLock } from '../file-lock.js';
import { runCommand } from '../run-command.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

const ledgerPath = defaultLedgerPath();

// One trade/close at a time: each reads the ledger, trades, then rewrites it.
// runCommand exits explicitly: the HL SDK leaves a timer running that would keep the process alive.
runCommand(() => withFileLock(`${ledgerPath}.lock`, () => runTrade(process.argv.slice(2), {
  hl: {
    connect: () => hl.connect(HL_AGENT_KEY, WALLET_ADDRESS),
    getMeta: hl.getMeta,
    getAllMids: hl.getAllMids,
    getPositions: () => hl.getPositions(WALLET_ADDRESS),
    getOrderFill: cloid => hl.getOrderFill(WALLET_ADDRESS, cloid),
    getAccountEquity: () => hl.getAccountEquity(WALLET_ADDRESS),
    setLeverage: hl.setLeverage,
    placeMarketOrder: hl.placeMarketOrder,
    getOpenOrders: () => hl.getOpenOrders(WALLET_ADDRESS),
    placePositionTpsl: hl.placePositionTpsl,
    cancelByCloid: hl.cancelByCloid,
  },
  invo,
  ledger: new FileLedgerStore(ledgerPath),
})),
  // Nothing filled (incl. an order HL rejected), fill unknown, filled but not recorded (the copy
  // can't be closed by a signal until fixed), or the trader's TP/SL not fully replicated
  out => out.status !== 'filled' || !!out.ledger.error || !!out.tpsl?.error);
