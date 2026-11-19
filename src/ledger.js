// Durable Object「台帳」（docs/design/detailed/api.md 3.2・3.3・4、docs/design/basic/architecture.md 3）
import { DurableObject } from 'cloudflare:workers';
import { checkAuth, prepareAuth } from './api/auth.js';
import { ROUTES, findRoute } from './api/routes.js';
import { refuse, serverError } from './api/respond.js';
import { readJsonBody } from './lib/body.js';
import { adminCookie, userCookie } from './lib/cookie.js';
import { floorMinute } from './lib/time.js';
import { applyMigrations } from './store/migrations.js';

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // 版の適用が終わるまでリクエストを受けない（schema.md 5.2）。
    // 失敗したら例外のまま投げ、台帳を作り直させる
    ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx.storage, Date.now());
    });
  }

  async fetch(request) {
    return this.handle(request, Date.now);
  }

  // すべての API に共通の流れ。clock は現在時刻（ミリ秒）を返す関数で、1つの要求で1回だけ呼ぶ
  // （time-and-concurrency.md 2）。routes はテストが自分の経路の表を渡すためにある（api.md 3.2）
  async handle(request, clock, routes = ROUTES) {
    try {
      // 共1：経路があるか
      const found = findRoute(routes, request.method, new URL(request.url).pathname);
      if (found === null) return refuse('NOT_FOUND_API');

      if (found.route.wrap) {
        // 包んだ処理が例外を投げると台帳が作り直されるので、中で受け止める（time-and-concurrency.md 4）
        return await this.ctx.blockConcurrencyWhile(async () => {
          try {
            return await this.#run(request, clock, found);
          } catch (error) {
            logUnexpected(error);
            return serverError();
          }
        });
      }
      return await this.#run(request, clock, found);
    } catch (error) {
      logUnexpected(error);
      return serverError();
    }
  }

  async #run(request, clock, { route, params }) {
    const isGet = request.method === 'GET';

    // await が要る準備。本文が壊れていても、ここでは断らない（api.md 3.3 の 2）
    const body = isGet ? null : await readJsonBody(request);
    const prepared = await prepareAuth(route.auth, request, this.env);
    const routePrepared = route.prepare ? await route.prepare({ request, body }) : null;

    // 現在時刻は準備の後に1回だけ取る（api.md 3.3 の 3）
    const now = clock();
    const nowMin = floorMinute(now);

    // ここから書き込みまで await を挟まない（RSV-23）

    // 共2：GET 以外で、Origin が自分のサイトと一致するか（保守用の API は確かめない）
    if (!isGet && route.auth !== 'maint' && !isSameOrigin(request)) return refuse('AUTH_ORIGIN');

    // 共3：認証
    const auth = checkAuth(route.auth, { storage: this.ctx.storage, request, prepared, now });
    if (!auth.ok) return refuse(auth.code);

    // 管理者・利用者の API は、共3 を通った後の応答で期限を延ばす（api.md 3.3・8.5・8.12）
    const extend = (response) => withExtendedCookie(response, route.auth, prepared.token);

    // 共4：本文を読めたか。認証が通ってから返す。本文を自分で確かめる API は処理が確かめる（api.md 4 の例外）
    if (body !== null && !body.ok && !route.ownBodyCheck) return extend(refuse('INPUT_BODY'));

    // API ごとの処理。自動の変化の反映と書き込みは、処理の中で transactionSync に包む（api.md 3.5）
    const response = await route.handler({
      storage: this.ctx.storage,
      env: this.env,
      request,
      params,
      body: body === null || !body.ok ? null : body.value,
      bodyOk: body === null || body.ok,
      auth,
      routePrepared,
      now,
      nowMin,
    });
    return extend(response);
  }
}

// 受け取った値で Set-Cookie を送り直す。管理者・利用者の API だけ。
// 処理がすでに Set-Cookie を付けた応答（認証を解くなど）と 500 には付けない
function withExtendedCookie(response, kind, token) {
  const cookie = kind === 'admin' ? adminCookie : kind === 'user' ? userCookie : null;
  if (cookie === null || response.status === 500 || response.headers.has('Set-Cookie')) return response;
  response.headers.append('Set-Cookie', cookie(token));
  return response;
}

// 要求の URL のオリジンと Origin ヘッダが完全に一致するか。ヘッダがなければ一致しない（api.md 4）
function isSameOrigin(request) {
  return request.headers.get('Origin') === new URL(request.url).origin;
}

// 例外の中身だけを出す。要求と応答の本文・Cookie・ヘッダの値は出さない（LOG-4, SEC-4。api.md 1）
function logUnexpected(error) {
  console.error('想定していない例外', error instanceof Error ? error.stack : String(error));
}
