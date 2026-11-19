// 経路の表（docs/design/detailed/api.md 3.3）
//
// 1行が1つの API。各行は次の形：
//   method：'GET' か 'POST'
//   path：'/api/reservations/{id}/cancel' など。{id} は正の整数（先頭が0でない数字の並び）に当たる（api.md 2）
//   auth：認証の種類（auth.md 1）。'public'（誰でも）、'user'（利用者）、'admin'（管理者）、'maint'（保守）
//   wrap：処理全体を blockConcurrencyWhile で包むか（PBKDF2 を使う操作だけ。time-and-concurrency.md 4）
//   handler：src/api/ の関数。共通の流れ（ledger.js の handle）の後の部分だけを書く
//   ownBodyCheck：真なら handle は共4 を確かめず、処理が上限 → 本文 → 認証の値の順に確かめる（api.md 4 の例外）。省略は偽
//   prepare：省略できる。その API だけの await が要る準備。{ request, body }（body は読んだ結果）を受け取り、
//     結果は処理に routePrepared として渡る
//
// API は機能ごとの実装で足す。
//
// deps はテストが差し替える部品。derivePassword は PBKDF2 の関数で、テストは呼ばれた回数を数える（api.md 8.3）。
// 本番の台帳は既定の部品で作った ROUTES だけを使う
import { login, logout, me, prepareLogin } from './admin-auth.js';
import {
  createDevice,
  deleteDevice,
  deviceDay,
  listDevicesForAdmin,
  listDevicesForUser,
  renameDevice,
} from './devices.js';
import { changeUser, loginUser, registerUser } from './me.js';
import { createAdminByMaint, resetAdminPasswordByMaint } from './maint.js';
import { createReservation, startWalkIn } from './reservations.js';
import { prepareSession, prepareSessionStatus, sessionStatus, startSession } from './session.js';
import { prepareSharedInfo, setSharedInfo } from './shared-info.js';
import { pbkdf2 } from '../lib/hash.js';

export function buildRoutes({ derivePassword = pbkdf2 } = {}) {
  return [
    // 保守用の API（api.md 8.1・8.2。ADM-2）
    {
      method: 'POST',
      path: '/api/maint/admins',
      auth: 'maint',
      wrap: true,
      handler: (context) => createAdminByMaint(context, derivePassword),
    },
    {
      method: 'POST',
      path: '/api/maint/admins/{id}/reset-password',
      auth: 'maint',
      wrap: true,
      handler: (context) => resetAdminPasswordByMaint(context, derivePassword),
    },
    // 管理者の認証（api.md 8.4・8.6・8.7。ADM-2）
    {
      method: 'POST',
      path: '/api/admin/login',
      auth: 'public',
      wrap: true,
      ownBodyCheck: true,
      prepare: prepareLogin,
      handler: (context) => login(context, derivePassword),
    },
    { method: 'GET', path: '/api/admin/me', auth: 'admin', wrap: false, handler: me },
    { method: 'POST', path: '/api/admin/logout', auth: 'admin', wrap: false, handler: logout },
    // 共有された情報の設定・変更（api.md 8.9。ADM-3）。ハッシュは SHA-256 だけなので包まない
    {
      method: 'POST',
      path: '/api/admin/shared-info',
      auth: 'admin',
      wrap: false,
      prepare: prepareSharedInfo,
      handler: setSharedInfo,
    },
    // 利用の開始（api.md 8.11・8.13。USR-2）。認証の種類は「誰でも」で、利用者の証明は処理が確かめる
    {
      method: 'POST',
      path: '/api/session',
      auth: 'public',
      wrap: false,
      ownBodyCheck: true,
      prepare: prepareSession,
      handler: startSession,
    },
    {
      method: 'GET',
      path: '/api/session',
      auth: 'public',
      wrap: false,
      prepare: prepareSessionStatus,
      handler: sessionStatus,
    },
    // 登録・ログイン・名前と期生の変更（api.md 8.15。USR-3〜USR-7）。PBKDF2 がないので包まない
    { method: 'POST', path: '/api/me/register', auth: 'user', wrap: false, handler: registerUser },
    { method: 'POST', path: '/api/me/login', auth: 'user', wrap: false, handler: loginUser },
    { method: 'POST', path: '/api/me/change', auth: 'user', wrap: false, handler: changeUser },
    // 機器（api.md 8.18〜8.22。MNG-1, MNG-2, VIW-1）
    { method: 'GET', path: '/api/admin/devices', auth: 'admin', wrap: false, handler: listDevicesForAdmin },
    { method: 'POST', path: '/api/admin/devices', auth: 'admin', wrap: false, handler: createDevice },
    { method: 'POST', path: '/api/admin/devices/{id}/rename', auth: 'admin', wrap: false, handler: renameDevice },
    { method: 'POST', path: '/api/admin/devices/{id}/delete', auth: 'admin', wrap: false, handler: deleteDevice },
    { method: 'GET', path: '/api/devices', auth: 'user', wrap: false, handler: listDevicesForUser },
    // 予約状況・確保（api.md 8.24・8.25。VIW-1〜VIW-3, RSV-2〜RSV-6）
    { method: 'GET', path: '/api/devices/{id}/day', auth: 'user', wrap: false, handler: deviceDay },
    { method: 'POST', path: '/api/reservations', auth: 'user', wrap: false, handler: createReservation },
    { method: 'POST', path: '/api/walk-ins', auth: 'user', wrap: false, handler: startWalkIn },
  ];
}

export const ROUTES = buildRoutes();

const ID_PATTERN = /^[1-9][0-9]*$/;

// メソッドとパスに当たる行を引く。なければ null（NOT_FOUND_API）。
// 当たれば { route, params }。params.id はパスの {id} を数値にしたもの
export function findRoute(routes, method, pathname) {
  const segments = pathname.split('/');
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path.split('/'), segments);
    if (params !== null) return { route, params };
  }
  return null;
}

function matchPath(patternSegments, segments) {
  if (patternSegments.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const pattern = patternSegments[i];
    const segment = segments[i];
    if (pattern === '{id}') {
      if (!ID_PATTERN.test(segment)) return null;
      params.id = Number(segment);
    } else if (pattern !== segment) {
      return null;
    }
  }
  return params;
}
