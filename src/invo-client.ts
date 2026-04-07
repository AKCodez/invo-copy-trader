const BASE = 'https://api.invoapp.com';

let token = '';
let refreshToken = '';

export function setToken(t: string) {
  token = t.startsWith('Bearer ') ? t : `Bearer ${t}`;
}

export function setRefreshToken(t: string) {
  refreshToken = t;
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshToken) return false;
  try {
    const resp = await fetch(`${BASE}/v1_0/auth/refresh_token`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        'x-app-version': '0.0.75',
        'x-platform': 'web',
      },
    });
    if (resp.status !== 200) return false;
    const data = await resp.json();
    if (data.accessToken) {
      token = `Bearer ${data.accessToken}`;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Ensure we have a valid access token, refreshing if needed. */
export async function ensureToken(): Promise<void> {
  // If we have a token, check if it's about to expire
  if (token) {
    try {
      const payload = JSON.parse(atob(token.replace('Bearer ', '').split('.')[1]));
      const remainingSec = payload.expires - Date.now() / 1000;
      if (remainingSec > 30) return; // still valid
    } catch { /* can't decode — try refresh */ }
  }
  // Token missing or expiring soon — refresh
  const ok = await refreshAccessToken();
  if (!ok && !token) throw new Error('No valid Invo token and refresh failed');
}

async function post(path: string, body: any, retried = false): Promise<any> {
  await ensureToken();
  const resp = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      'x-app-version': '0.0.75',
      'x-platform': 'web',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    // Some Invo responses are base64-encoded JSON
    try { data = JSON.parse(atob(text)); } catch { data = text; }
  }
  // Auto-retry on 401 with refreshed token
  if (resp.status === 401 && !retried) {
    const ok = await refreshAccessToken();
    if (ok) return post(path, body, true);
  }
  if (resp.status >= 400) {
    throw new Error(`Invo ${path} ${resp.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function get(path: string, retried = false): Promise<any> {
  await ensureToken();
  const resp = await fetch(`${BASE}${path}`, {
    headers: { Authorization: token },
  });
  if (resp.status === 401 && !retried) {
    const ok = await refreshAccessToken();
    if (ok) return get(path, true);
  }
  return resp.json();
}

// --- Discovery ---

export async function discoverTraders(filter: string, page = 1, size = 50, userId?: string) {
  const body: any = { filter, params: { page, size } };
  if (userId) body.userId = userId;
  return post('/v1_0/trending/get_portfolios_pl', body);
}

export async function getTrendingUsers(page = 1, size = 25) {
  return post('/v1_0/trending/get_users', { filter: 'trending', params: { page, size } });
}

export async function getFeed(filter: string, lastPostId: string | null = null, itemLimit = 50) {
  return post('/v1_0/posts/get_feed', {
    filter: { filter, assetTypes: [] },
    params: { lastPostId, itemLimit },
  });
}

// --- Social ---

export async function followUser(userId: string) {
  return post('/v1_0/users/follow', { objectId: userId });
}

export async function unfollowUser(userId: string) {
  return post('/v1_0/users/unfollow', { objectId: userId });
}

// --- Trading ---

export async function getTradeUpdates(investments: { baseShortId: string; mimicStartedAt: string }[]) {
  return post('/dex/trade', { investments });
}

export async function checkAccountReady() {
  return post('/dex/account/ready', {});
}

export interface RecordOpenPayload {
  clientTxId: string;
  coin: string;
  assetIndex: number;
  entry: {
    side: 'long' | 'short';
    marginMode: 'isolated' | 'cross';
    leverage: number;
    tpPx: string | null;
    slPx: string | null;
  };
  submission: {
    hlOrder: any;
    nonceMs: number;
    hlResponse: any;
  };
  summary: {
    qtyBefore: string;
    qtyAfter: string;
    intendedLeverage: number;
  };
  mimicMeta: {
    portfolioId: string;
    creatorInvoUserId: string;
    initialSourcePaperUpdateId: string;
    sourcePaperTradeBaseId: string;
  };
}

export async function recordOpen(payload: RecordOpenPayload) {
  return post('/dex/position/create', payload);
}

export interface RecordClosePayload {
  clientTxId: string;
  baseShortId: string;
  assetIndex: number;
  submission: {
    hlOrder: any;
    nonceMs: number;
    hlResponse: any;
  };
  summary: {
    qtyBefore: string;
    qtyAfter: string;
  };
}

export async function recordClose(payload: RecordClosePayload) {
  return post('/dex/position/close', payload);
}

export async function getInvestmentStatus(investmentBaseId: string) {
  return get(`/investment/status/${investmentBaseId}`);
}
