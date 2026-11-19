// Worker の入口（docs/design/detailed/api.md 3.1）
// /api/ の要求を、手を加えずに台帳へ渡すだけ。版の食い違い（api.md 5）の影響を受けないよう、ほかに何もしない
import { refuse } from './api/respond.js';

export { Ledger } from './ledger.js';

export default {
  async fetch(request, env) {
    // 静的ファイルは基盤が先に返している（architecture.md 1）
    if (!new URL(request.url).pathname.startsWith('/api/')) return refuse('NOT_FOUND_API');

    const stub = env.LEDGER.get(env.LEDGER.idFromName('ledger'));
    return stub.fetch(request);
  },
};
