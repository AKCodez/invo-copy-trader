import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN } from '../env.js';
import * as invo from '../invo-client.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];
  const userIds = args.slice(1);

  if (!action || !['follow', 'unfollow'].includes(action) || userIds.length === 0) {
    console.error('Usage: follow <follow|unfollow> <userId1> [userId2] ...');
    process.exit(1);
  }

  const results: { userId: string; status: string; data?: any; message?: string }[] = [];
  for (const userId of userIds) {
    try {
      const data = action === 'unfollow'
        ? await invo.unfollowUser(userId)
        : await invo.followUser(userId);
      results.push({ userId, status: 'ok', data });
    } catch (e: any) {
      results.push({ userId, status: 'error', message: e.message });
    }
  }

  console.log(JSON.stringify({ action, results }));
}

main().catch(e => { console.error(e.message); process.exit(1); });
