// Leverage argument checks for trade.ts. Both throw — trade.ts runs them
// before setting leverage or placing any order.

/** The <leverage> argument: a whole number >= 1. No default — it must be given. */
export function parseLeverageArg(arg: string | undefined): number {
  if (!arg || !/^\d+$/.test(arg.trim())) {
    throw new Error(`leverage must be a whole number >= 1 (got ${JSON.stringify(arg ?? null)})`);
  }
  const leverage = Number(arg.trim());
  if (!Number.isSafeInteger(leverage) || leverage < 1) {
    throw new Error(`leverage must be a whole number >= 1 (got ${JSON.stringify(arg)})`);
  }
  return leverage;
}

/** Refuse leverage above the asset's HL max. A missing/invalid max fails closed. */
export function checkLeverage(leverage: number, coin: string, maxLeverage: unknown): void {
  if (typeof maxLeverage !== 'number' || !Number.isFinite(maxLeverage) || maxLeverage < 1) {
    throw new Error(`No valid maxLeverage for ${coin} in HL meta (got ${JSON.stringify(maxLeverage)})`);
  }
  if (leverage > maxLeverage) {
    throw new Error(`Leverage ${leverage}x exceeds ${coin} max of ${maxLeverage}x`);
  }
}
