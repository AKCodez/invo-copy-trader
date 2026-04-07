import 'dotenv/config';

export const INVO_TOKEN = process.env.INVO_TOKEN ?? '';
export const INVO_REFRESH_TOKEN = process.env.INVO_REFRESH_TOKEN ?? '';
export const HL_AGENT_KEY = process.env.HL_AGENT_KEY ?? '';
export const WALLET_ADDRESS = process.env.WALLET_ADDRESS ?? '';

export function validateEnv() {
  const missing: string[] = [];
  if (!INVO_TOKEN && !INVO_REFRESH_TOKEN) missing.push('INVO_TOKEN or INVO_REFRESH_TOKEN');
  if (!HL_AGENT_KEY) missing.push('HL_AGENT_KEY');
  if (!WALLET_ADDRESS) missing.push('WALLET_ADDRESS');
  if (missing.length) {
    console.error(`Missing .env vars: ${missing.join(', ')}`);
    console.error('Create C:\\Users\\User\\Invo\\.env with:');
    console.error('  INVO_REFRESH_TOKEN=eyJ...  (350-day TTL, preferred)');
    console.error('  INVO_TOKEN=Bearer eyJ...   (optional, ~10 min TTL)');
    console.error('  HL_AGENT_KEY=0x...');
    console.error('  WALLET_ADDRESS=0x...');
    process.exit(1);
  }
}
