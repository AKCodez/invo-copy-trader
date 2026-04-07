import 'dotenv/config';
import * as hl from '../hl-client.js';
import * as invo from '../invo-client.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

async function main() {
  const checks: Check[] = [];

  // 1. Node.js version
  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1));
  checks.push({
    name: 'node_version',
    status: major >= 18 ? 'ok' : 'fail',
    detail: `Node.js ${nodeVer}${major < 18 ? ' (need v18+)' : ''}`,
  });

  // 2. Environment variables
  const refreshToken = process.env.INVO_REFRESH_TOKEN ?? '';
  const accessToken = process.env.INVO_TOKEN ?? '';
  const agentKey = process.env.HL_AGENT_KEY ?? '';
  const wallet = process.env.WALLET_ADDRESS ?? '';

  checks.push({
    name: 'env_refresh_token',
    status: refreshToken ? 'ok' : accessToken ? 'warn' : 'fail',
    detail: refreshToken
      ? 'INVO_REFRESH_TOKEN set (350-day TTL)'
      : accessToken
        ? 'Only INVO_TOKEN set (short TTL, will expire)'
        : 'Missing INVO_REFRESH_TOKEN and INVO_TOKEN',
  });

  checks.push({
    name: 'env_agent_key',
    status: agentKey ? 'ok' : 'fail',
    detail: agentKey ? `HL_AGENT_KEY set (${agentKey.substring(0, 6)}...)` : 'Missing HL_AGENT_KEY',
  });

  checks.push({
    name: 'env_wallet',
    status: wallet ? 'ok' : 'fail',
    detail: wallet ? `WALLET_ADDRESS set (${wallet.substring(0, 8)}...)` : 'Missing WALLET_ADDRESS',
  });

  // 3. Invo auth — refresh token validity
  if (refreshToken) {
    try {
      const payload = JSON.parse(atob(refreshToken.split('.')[1]));
      const remainingDays = Math.round((payload.expires - Date.now() / 1000) / 86400);
      checks.push({
        name: 'invo_refresh_expiry',
        status: remainingDays > 30 ? 'ok' : remainingDays > 0 ? 'warn' : 'fail',
        detail: remainingDays > 0 ? `Refresh token valid for ${remainingDays} days` : 'Refresh token EXPIRED',
      });
    } catch {
      checks.push({ name: 'invo_refresh_expiry', status: 'fail', detail: 'Cannot decode refresh token' });
    }
  }

  // 4. HL agent key expiry
  if (agentKey) {
    // Agent keys have ~90 day validity but we can't decode them directly
    // Test by connecting
    try {
      await hl.connect(agentKey, wallet);
      checks.push({ name: 'hl_agent_key', status: 'ok', detail: 'SDK connected with agent key' });
    } catch (e: any) {
      checks.push({ name: 'hl_agent_key', status: 'fail', detail: `SDK connect failed: ${e.message}` });
    }
  }

  // 5. Invo API — access token refresh
  if (refreshToken || accessToken) {
    if (accessToken) invo.setToken(accessToken);
    if (refreshToken) invo.setRefreshToken(refreshToken);
    try {
      await invo.ensureToken();
      checks.push({ name: 'invo_auth', status: 'ok', detail: 'Access token acquired via auto-refresh' });
    } catch (e: any) {
      checks.push({ name: 'invo_auth', status: 'fail', detail: `Auth failed: ${e.message}` });
    }
  }

  // 6. Invo account readiness
  if (refreshToken || accessToken) {
    try {
      const data = await invo.checkAccountReady();
      const acct = (data as any)?.data;
      const ready = acct?.status === 'ready';
      const paused = acct?.summary?.guards?.tradingPaused;
      checks.push({
        name: 'invo_account',
        status: ready && !paused ? 'ok' : 'fail',
        detail: ready
          ? `Account ready, trading ${paused ? 'PAUSED' : 'enabled'}, wallet: ${acct.context?.tradingAddress?.substring(0, 10)}...`
          : `Account not ready: ${acct?.status ?? 'unknown'}`,
      });
    } catch (e: any) {
      checks.push({ name: 'invo_account', status: 'fail', detail: `Account check failed: ${e.message}` });
    }
  }

  // 7. HL wallet balance + positions
  if (wallet) {
    try {
      const resp = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: wallet }),
      });
      const data = await resp.json();
      const equity = parseFloat(data.marginSummary?.accountValue ?? '0');
      const availableBalance = parseFloat(data.withdrawable ?? '0');
      const positions = data.assetPositions?.filter((p: any) => parseFloat(p.position.szi) !== 0) ?? [];

      checks.push({
        name: 'hl_balance',
        status: equity > 5 ? 'ok' : equity > 0 ? 'warn' : 'fail',
        detail: `Equity: $${equity.toFixed(2)} │ Available: $${availableBalance.toFixed(2)} │ Open positions: ${positions.length}`,
      });

      if (equity < 5) {
        checks.push({
          name: 'hl_funding',
          status: 'fail',
          detail: equity === 0
            ? 'Wallet is empty — deposit USDC to Hyperliquid before trading'
            : `Balance too low ($${equity.toFixed(2)}) — minimum ~$10 recommended for copy trading`,
        });
      }
    } catch (e: any) {
      checks.push({ name: 'hl_balance', status: 'fail', detail: `Balance check failed: ${e.message}` });
    }
  }

  // 8. HL meta + prices (connectivity)
  try {
    const meta = await hl.getMeta();
    const mids = await hl.getAllMids();
    checks.push({
      name: 'hl_market_data',
      status: 'ok',
      detail: `${meta.universe.length} assets indexed │ SOL $${parseFloat(mids['SOL']).toFixed(2)} │ BTC $${parseFloat(mids['BTC']).toFixed(0)} │ ETH $${parseFloat(mids['ETH']).toFixed(0)}`,
    });
  } catch (e: any) {
    checks.push({ name: 'hl_market_data', status: 'fail', detail: `Market data failed: ${e.message}` });
  }

  // Summary
  const ok = checks.filter(c => c.status === 'ok').length;
  const warn = checks.filter(c => c.status === 'warn').length;
  const fail = checks.filter(c => c.status === 'fail').length;

  console.log(JSON.stringify({
    summary: { ok, warn, fail, total: checks.length, ready: fail === 0 },
    checks,
  }, null, 2));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
