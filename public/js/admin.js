// 管理者の画面の動き（screens.md 2・4）
import { callApi } from './api.js';
import { messageFor } from './messages.js';

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

// 画面を出し、出すたびに取り直す画面なら取り直す（screens.md 4.1・3.1）
function open(name) {
  show(name);
  if (name === 'devices') {
    hideRenameForm();
    loadDevices();
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
