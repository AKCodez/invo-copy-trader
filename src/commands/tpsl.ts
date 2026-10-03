import { validateEnv, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as hl from '../hl-client.js';
import { runTpsl } from '../tpsl-exec.js';
import { randomCloid } from '../trade-exec.js';
import { FileLedgerStore, defaultLedgerPath } from '../copy-ledger.js';
import { withFileLock } from '../file-lock.js';
import { runCommand } from '../run-command.js';

validateEnv();

const ledgerPath = defaultLedgerPath();

// Replicates the trader's TP/SL on our copy (a `tpsl` signal, or an `open` signal to re-apply its TP/SL).
// One trade/close/tpsl at a time: each reads the ledger, trades, then rewrites it.
runCommand(() => withFileLock(`${ledgerPath}.lock`, () => runTpsl(process.argv.slice(2), {
  hl: {
    connect: () => hl.connect(HL_AGENT_KEY, WALLET_ADDRESS),
    getMeta: hl.getMeta,
    getAllMids: hl.getAllMids,
    getPositions: () => hl.getPositions(WALLET_ADDRESS),
    getOrderFill: cloid => hl.getOrderFill(WALLET_ADDRESS, cloid),
    getOpenOrders: () => hl.getOpenOrders(WALLET_ADDRESS),
    placePositionTpsl: hl.placePositionTpsl,
    cancelByCloid: hl.cancelByCloid,
  },
  ledger: new FileLedgerStore(ledgerPath),
  newCloid: randomCloid,
})),
  out => out.status === 'refused' || out.status === 'failed');
