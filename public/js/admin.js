// 管理者の画面の動き（screens.md 2・4）
import { callApi } from './api.js';
import { messageFor } from './messages.js';
import { displayRange } from './time.js';

// 認証している管理者 { id, login_id, display_name }。認証の画面に移るときは null（screens.md 4.1）
let admin = null;

const bar = document.getElementById('bar');
const adminLabel = document.getElementById('admin-label');
const loginForm = document.getElementById('login-form');
const loginId = document.getElementById('login-id');
const loginPassword = document.getElementById('login-password');
const logoutButton = document.getElementById('logout');

// 画面を出す。認証の画面では帯を隠す。画面を切り替えたら文を消す（screens.md 2.3）
function show(name) {
  for (const section of document.querySelectorAll('section')) {
    section.hidden = section.id !== `screen-${name}`;
  }
  bar.hidden = name === 'login';
  setMessage(name, '', null);
}

function currentScreen() {
  return document.querySelector('section:not([hidden])').id.replace('screen-', '');
}

// 文は textContent で入れる（SEC-1）。kind は 'error' か 'success'
function setMessage(name, text, kind) {
  const element = document.querySelector(`#screen-${name} .message`);
  element.textContent = text;
  element.classList.toggle('error', kind === 'error');
  element.classList.toggle('success', kind === 'success');
}

function setAdmin(value) {
  admin = value;
  adminLabel.textContent = admin === null ? '' : `管理者：${admin.display_name}（${admin.login_id}）`;
}

// 断られた応答を受け取る1つの関数（screens.md 2.4）。
// AUTH_REQUIRED・AUTH_REVOKED なら認証の画面に移ってそこに文を出し、ほかは今の画面に文を出す
function showError(code) {
  if (code === 'AUTH_REQUIRED' || code === 'AUTH_REVOKED') {
    setAdmin(null);
    show('login');
    setMessage('login', messageFor(code, 'admin'), 'error');
    return;
  }
  setMessage(currentScreen(), messageFor(code, 'admin'), 'error');
}

// 認証（screens.md 4.2。ADM-2）
loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('login', '', null);
  // ID は前後の空白を除き、パスワードは欄の値のまま送る。空なら送らない（screens.md 2.9）
  const id = loginId.value.trim();
  const password = loginPassword.value;
  if (id === '') return setMessage('login', 'ID を入れてください。', 'error');
  if (password === '') return setMessage('login', 'パスワードを入れてください。', 'error');

  const button = loginForm.querySelector('button');
  button.disabled = true;
  try {
    const result = await callApi('POST', '/api/admin/login', { login_id: id, password });
    // 成功でも断られても、パスワードの欄を空にする。ID の欄は残す
    loginPassword.value = '';
    if (result.ok) {
      setAdmin(result.data);
      open('devices');
    } else {
      setMessage('login', messageFor(result.code, 'admin'), 'error');
    }
  } finally {
    button.disabled = false;
  }
});

// 認証を解く（screens.md 4.1）。確かめずに送る。
// AUTH_REQUIRED・AUTH_REVOKED はすでに解けていたものとして、2.4 の自動の遷移より先にここで受ける
logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    const result = await callApi('POST', '/api/admin/logout', {});
    if (result.ok || result.code === 'AUTH_REQUIRED' || result.code === 'AUTH_REVOKED') {
      setAdmin(null);
      show('login');
      setMessage('login', '認証を解きました。', 'success');
    } else {
      showError(result.code);
    }
  } finally {
    logoutButton.disabled = false;
  }
});

// 共有された情報（screens.md 4.7。ADM-3）。値は QR コードと URL の文字にだけ持ち、ページを閉じると消える
const sharedInfoButton = document.getElementById('shared-info-set');
const sharedInfoQr = document.getElementById('shared-info-qr');
const sharedInfoUrl = document.getElementById('shared-info-url');

function clearSharedInfo() {
  sharedInfoQr.hidden = true;
  sharedInfoQr.removeAttribute('src');
  sharedInfoUrl.hidden = true;
  sharedInfoUrl.textContent = '';
}

// createImgTag・createSvgTag は HTML の文字列を返すので使わず、データの URL を img の src に入れる（screens.md 2.8）
function showSharedInfo(value) {
  const url = `${location.origin}/#k=${value}`;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  sharedInfoQr.src = qr.createDataURL(8, 4);
  sharedInfoQr.hidden = false;
  sharedInfoUrl.textContent = url;
  sharedInfoUrl.hidden = false;
}

sharedInfoButton.addEventListener('click', async () => {
  // 最初の設定でも同じ文で確かめる（画面は未設定かどうかを知らない）
  if (!confirm('共有された情報を変更しますか？ 今までの QR コードは使えなくなります。')) return;
  setMessage('shared-info', '', null);
  sharedInfoButton.disabled = true;
  try {
    const result = await callApi('POST', '/api/admin/shared-info', {});
    if (result.ok) {
      showSharedInfo(result.data.value);
      setMessage(
        'shared-info',
        '設定しました。この QR コードを印刷するか、画像を保存してください。ページを閉じたり読み込み直したりすると、もう表示できません。',
        'success',
      );
      return;
    }
    // 応答が届かなかったときは台帳で変わっているかもしれないので、前の QR コードを消す。
    // 断られたときは台帳が変わっていないので残す
    if (result.code === null) clearSharedInfo();
    showError(result.code);
  } finally {
    sharedInfoButton.disabled = false;
  }
});

// ---- 機器（screens.md 4.3。MNG-1, MNG-2） ----

const deviceCreateForm = document.getElementById('device-create-form');
const deviceCreateName = document.getElementById('device-create-name');
const deviceEmpty = document.getElementById('device-empty');
const deviceList = document.getElementById('device-list');
const deviceRenameForm = document.getElementById('device-rename-form');
const deviceRenameName = document.getElementById('device-rename-name');

// 名前の変更のフォームで扱っている機器 { id, name }。隠しているときは null
let renaming = null;

function hideRenameForm() {
  renaming = null;
  deviceRenameForm.hidden = true;
}

// 一覧を取り直して描く。文は消さない（取り直しが断られたときだけ、その文で置き換える。screens.md 3.1）
async function loadDevices() {
  const result = await callApi('GET', '/api/admin/devices');
  if (!result.ok) return showError(result.code);
  const { devices } = result.data;
  deviceEmpty.hidden = devices.length > 0;
  deviceList.replaceChildren(...devices.map(deviceRow));
}

// 1行は名前と「名前の変更」「削除」のボタン。名前は textContent（SEC-1）
function deviceRow(device) {
  const item = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = device.name;

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.textContent = '名前の変更';
  rename.addEventListener('click', () => {
    renaming = device;
    deviceRenameName.value = device.name;
    deviceRenameForm.hidden = false;
    deviceRenameName.focus();
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '削除';
  remove.addEventListener('click', () => deleteDevice(device, remove));

  item.append(name, rename, remove);
  return item;
}

// コードごとの動き（screens.md 4.3）。NOT_FOUND_DEVICE は文を出し、フォームを隠して一覧を取り直す
function showDeviceError(code) {
  showError(code);
  if (code === 'NOT_FOUND_DEVICE') {
    hideRenameForm();
    loadDevices();
  }
}

// 操作のボタンを応答が返るまで止めて API を呼ぶ（screens.md 2.6）
async function sendWith(button, path, body) {
  button.disabled = true;
  try {
    return await callApi('POST', path, body);
  } finally {
    button.disabled = false;
  }
}

// 追加。名前は欄の値のまま送る（前後の空白は台帳が除く）
deviceCreateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('devices', '', null);
  const name = deviceCreateName.value;
  if (name.trim() === '') return setMessage('devices', '名前を入れてください。', 'error');

  const result = await sendWith(deviceCreateForm.querySelector('button'), '/api/admin/devices', { name });
  // INPUT_DEVICE_NAME・RULE_DEVICE_NAME_DUPLICATE は欄を残す
  if (!result.ok) return showDeviceError(result.code);
  deviceCreateName.value = '';
  setMessage('devices', `「${result.data.name}」を追加しました。`, 'success');
  loadDevices();
});

// 名前の変更。同じ名前のまま決定しても成功する
deviceRenameForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('devices', '', null);
  if (renaming === null) return;
  const name = deviceRenameName.value;
  if (name.trim() === '') return setMessage('devices', '名前を入れてください。', 'error');

  const button = deviceRenameForm.querySelector('button[type="submit"]');
  const result = await sendWith(button, `/api/admin/devices/${renaming.id}/rename`, { name });
  if (!result.ok) return showDeviceError(result.code);
  hideRenameForm();
  setMessage('devices', '名前を変えました。', 'success');
  loadDevices();
});

document.getElementById('device-rename-cancel').addEventListener('click', hideRenameForm);

// 削除。確かめの文に件数は入れない（screens.md 2.7）。RULE_DEVICE_IN_USE は一覧が変わっていないので取り直さない
async function deleteDevice(device, button) {
  if (!confirm(`「${device.name}」を削除しますか？ この機器の予約済の予約はすべて取り消されます。`)) return;
  setMessage('devices', '', null);
  const result = await sendWith(button, `/api/admin/devices/${device.id}/delete`, {});
  if (!result.ok) return showDeviceError(result.code);
  if (renaming !== null && renaming.id === device.id) hideRenameForm();
  setMessage('devices', `「${result.data.name}」を削除しました。`, 'success');
  loadDevices();
}

// ---- 予約の管理（screens.md 4.4。MNG-3） ----

const manageDeviceField = document.getElementById('manage-device');
const manageRefresh = document.getElementById('manage-refresh');
const manageNoDevices = document.getElementById('manage-no-devices');
const manageEmpty = document.getElementById('manage-empty');
const manageList = document.getElementById('manage-list');

const MANAGE_STATUS_LABELS = { reserved: '予約済', in_use: '利用中' };
const ROLE_LABELS = { student: '生徒', teacher: '教員' };

// 選んでいる機器の番号。なければ null
let manageDeviceId = null;

function clearManageList() {
  manageList.replaceChildren();
  manageEmpty.hidden = true;
}

// 開いたときの 1：機器の選択肢を作り直す。選んでいた機器が選択肢にあればそれを、なければ最初の機器を選ぶ（3.4 と同じ）。
// 機器があれば 2 に進む
async function loadManageDevices() {
  const result = await callApi('GET', '/api/admin/devices');
  if (!result.ok) return showError(result.code);
  const { devices } = result.data;
  const keep = devices.some((device) => device.id === manageDeviceId);
  manageDeviceId = keep ? manageDeviceId : (devices[0]?.id ?? null);
  manageDeviceField.replaceChildren(
    ...devices.map((device) => {
      const option = document.createElement('option');
      option.value = String(device.id);
      option.textContent = device.name; // SEC-1
      return option;
    }),
  );
  if (manageDeviceId !== null) manageDeviceField.value = String(manageDeviceId);
  manageNoDevices.hidden = devices.length > 0;
  manageDeviceField.disabled = devices.length === 0;
  manageRefresh.disabled = devices.length === 0;
  if (manageDeviceId === null) return clearManageList();
  await loadManageReservations();
}

// 開いたときの 2：選んでいる機器の予約済・利用中の一覧を取り直して描く（api.md 8.37）。.message は消さない（screens.md 3.1）
async function loadManageReservations() {
  if (manageDeviceId === null) return;
  const result = await callApi('GET', `/api/admin/devices/${manageDeviceId}/reservations`);
  if (!result.ok) return showManageError(result.code);
  const { reservations } = result.data;
  manageEmpty.hidden = reservations.length > 0;
  manageList.replaceChildren(...reservations.map(manageRow));
}

// 1行は「時間帯 状態 生徒か教員か 学籍番号 名前」と操作のボタン。学籍番号・名前は textContent（SEC-1）。
// 学籍番号は MNG-3 により出す（VIW-2 は管理者の画面には当てはまらない）。ボタンは status だけで決める
function manageRow(reservation) {
  const item = document.createElement('li');
  const text = document.createElement('span');
  text.className = 'name';
  text.textContent = [
    displayRange(reservation.start, reservation.end),
    MANAGE_STATUS_LABELS[reservation.status],
    ROLE_LABELS[reservation.role],
    reservation.student_id,
    reservation.name,
  ].join(' ');
  item.append(text);

  const button = document.createElement('button');
  button.type = 'button';
  if (reservation.status === 'reserved') {
    button.textContent = '取消';
    button.addEventListener('click', () =>
      manageAction(button, '/cancel', reservation.id, 'この予約を取り消しますか？', '取り消しました。'),
    );
  } else {
    button.textContent = '終了';
    button.addEventListener('click', () =>
      manageAction(button, '/finish', reservation.id, 'この利用を終了させますか？', '利用を終了させました。'),
    );
  }
  item.append(button);
  return item;
}

// コードごとの動き（screens.md 4.4）。予約のコードは一覧を取り直し、NOT_FOUND_DEVICE は機器の選択肢から読み直す
function showManageError(code) {
  showError(code);
  if (code === 'NOT_FOUND_RESERVATION' || code === 'STATE_NOT_RESERVED' || code === 'STATE_NOT_IN_USE') {
    loadManageReservations();
  } else if (code === 'NOT_FOUND_DEVICE') {
    loadManageDevices();
  }
}

// 取消・終了。番号はクロージャで持つ（screens.md 4.1）。本文は {}
async function manageAction(button, suffix, id, question, success) {
  if (!confirm(question)) return;
  setMessage('reservations', '', null);
  const result = await sendWith(button, `/api/admin/reservations/${id}${suffix}`, {});
  if (!result.ok) return showManageError(result.code);
  setMessage('reservations', success, 'success');
  loadManageReservations();
}

// 機器を変えたとき、「最新にする」を押したときは 2 だけを行う
manageDeviceField.addEventListener('change', () => {
  manageDeviceId = Number(manageDeviceField.value);
  setMessage('reservations', '', null);
  clearManageList();
  loadManageReservations();
});

manageRefresh.addEventListener('click', () => {
  setMessage('reservations', '', null);
  loadManageReservations();
});

// 数値（screens.md 4.5。RSV-25, RSV-26）。行は data-key（api.md 8.41 の項目の名前）と data-label（文に使う名前）を持つ
const settingRows = [...document.querySelectorAll('#screen-settings [data-key]')];

// 応答の3つの値で3つの欄をすべて入れ直す
function fillSettings(values) {
  for (const row of settingRows) row.querySelector('input').value = String(values[row.dataset.key]);
}

// 開いたとき：取り直して欄に入れる。断られたら文だけを出す
async function loadSettings() {
  const result = await callApi('GET', '/api/admin/settings');
  if (!result.ok) return showError(result.code);
  fillSettings(result.data);
}

// 保存：その行の値だけを送る。空・数でなければ送らない（screens.md 2.9）。小数・0 などは送り、台帳に任せる
for (const row of settingRows) {
  const input = row.querySelector('input');
  const button = row.querySelector('button');
  button.addEventListener('click', async () => {
    setMessage('settings', '', null);
    const label = row.dataset.label;
    if (input.value.trim() === '') return setMessage('settings', `${label}を入れてください。`, 'error');
    const value = Number(input.value);
    if (!Number.isFinite(value)) return setMessage('settings', `${label}を数で入れてください。`, 'error');

    const result = await sendWith(button, '/api/admin/settings', { key: row.dataset.key, value });
    // INPUT_SETTING_VALUE は文を出して欄を残す
    if (!result.ok) return showError(result.code);
    fillSettings(result.data);
    setMessage('settings', '保存しました。', 'success');
  });
}

// ---- 管理者のアカウント（screens.md 4.6。ADM-2） ----

const adminList = document.getElementById('admin-list');
const adminCreateForm = document.getElementById('admin-create-form');
const adminCreateId = document.getElementById('admin-create-id');
const adminCreateName = document.getElementById('admin-create-name');
const adminCreatePassword = document.getElementById('admin-create-password');
const adminResetForm = document.getElementById('admin-reset-form');
const adminResetTarget = document.getElementById('admin-reset-target');
const adminResetPassword = document.getElementById('admin-reset-password');

// 設定し直しのフォームで扱っている管理者 { id, login_id, display_name }。隠しているときは null
let resetting = null;

const adminText = (target) => `${target.display_name}（${target.login_id}）`;

function hideResetForm() {
  resetting = null;
  adminResetPassword.value = '';
  adminResetForm.hidden = true;
}

// 一覧を取り直して描く（api.md 8.44）。文は消さない（screens.md 3.1）
async function loadAdmins() {
  const result = await callApi('GET', '/api/admin/admins');
  if (!result.ok) return showError(result.code);
  adminList.replaceChildren(...result.data.admins.map(adminRow));
}

// 1行は「名前（ID）」と操作のボタン。名前と ID は textContent（SEC-1）。
// 自分の行は「（自分）」を付け、設定し直しを出さない（api.md 8.46）。削除は出す（ADM-2）
function adminRow(target) {
  const self = admin !== null && target.id === admin.id;
  const item = document.createElement('li');
  const text = document.createElement('span');
  text.className = 'name';
  text.textContent = self ? `${adminText(target)}（自分）` : adminText(target);
  item.append(text);

  if (!self) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'パスワードの設定し直し';
    reset.addEventListener('click', () => {
      resetting = target;
      adminResetTarget.textContent = adminText(target);
      adminResetPassword.value = '';
      adminResetForm.hidden = false;
      adminResetPassword.focus();
    });
    item.append(reset);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '削除';
  remove.addEventListener('click', () => deleteAdminAccount(target, self, remove));
  item.append(remove);
  return item;
}

// コードごとの動き（screens.md 4.6）。NOT_FOUND_ADMIN は文を出し、フォームを隠して一覧を取り直す。
// 入力のコードと RULE_ADMIN_* は文を出して欄を残す
function showAdminError(code) {
  showError(code);
  if (code === 'NOT_FOUND_ADMIN') {
    hideResetForm();
    loadAdmins();
  }
}

// 作成（api.md 8.45）。ID は前後の空白を除き、名前とパスワードは欄の値のまま送る。空なら送らない（screens.md 2.9）
adminCreateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('admins', '', null);
  const loginIdValue = adminCreateId.value.trim();
  const displayName = adminCreateName.value;
  const password = adminCreatePassword.value;
  if (loginIdValue === '') return setMessage('admins', 'ID を入れてください。', 'error');
  if (displayName.trim() === '') return setMessage('admins', '名前を入れてください。', 'error');
  if (password === '') return setMessage('admins', 'パスワードを入れてください。', 'error');

  const result = await sendWith(adminCreateForm.querySelector('button'), '/api/admin/admins', {
    login_id: loginIdValue,
    display_name: displayName,
    password,
  });
  if (!result.ok) return showAdminError(result.code);
  adminCreateId.value = '';
  adminCreateName.value = '';
  adminCreatePassword.value = '';
  // そろえた ID で認証することを示す（api.md 8.1）
  setMessage('admins', `${result.data.display_name}を作成しました。ID は ${result.data.login_id} です`, 'success');
  loadAdmins();
});

// パスワードの設定し直し（api.md 8.46）
adminResetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('admins', '', null);
  if (resetting === null) return;
  const password = adminResetPassword.value;
  if (password === '') return setMessage('admins', 'パスワードを入れてください。', 'error');

  const button = adminResetForm.querySelector('button[type="submit"]');
  const result = await sendWith(button, `/api/admin/admins/${resetting.id}/reset-password`, { password });
  if (!result.ok) return showAdminError(result.code);
  const name = result.data.display_name;
  hideResetForm();
  setMessage('admins', `${name}のパスワードを設定し直しました。${name}の認証はすべての端末で解けました`, 'success');
  loadAdmins();
});

document.getElementById('admin-reset-cancel').addEventListener('click', hideResetForm);

// 削除（api.md 8.47）。自分を削除したら応答で Cookie が消えるので、認証の画面に移る。
// RULE_ADMIN_LAST は一覧が変わっていないので取り直さない
async function deleteAdminAccount(target, self, button) {
  const question = self
    ? '自分のアカウントを削除しますか？ 削除すると、この画面の認証も解けます。'
    : `${adminText(target)}を削除しますか？`;
  if (!confirm(question)) return;
  setMessage('admins', '', null);
  const result = await sendWith(button, `/api/admin/admins/${target.id}/delete`, {});
  if (!result.ok) return showAdminError(result.code);
  if (self) {
    setAdmin(null);
    show('login');
    setMessage('login', '自分のアカウントを削除しました', 'success');
    return;
  }
  if (resetting !== null && resetting.id === target.id) hideResetForm();
  setMessage('admins', `${result.data.display_name}を削除しました`, 'success');
  loadAdmins();
}

// 画面を出し、出すたびに取り直す画面なら取り直す（screens.md 4.1・3.1）
function open(name) {
  show(name);
  if (name === 'devices') {
    hideRenameForm();
    loadDevices();
  } else if (name === 'reservations') {
    loadManageDevices();
  } else if (name === 'settings') {
    loadSettings();
  } else if (name === 'admins') {
    hideResetForm();
    loadAdmins();
  }
}

for (const button of bar.querySelectorAll('[data-screen]')) {
  button.addEventListener('click', () => open(button.dataset.screen));
}

// 開いたとき（screens.md 2.5）
async function start() {
  const result = await callApi('GET', '/api/admin/me');
  if (result.ok) {
    setAdmin(result.data);
    open('devices');
    return;
  }
  show('login');
  showError(result.code);
}

start();
