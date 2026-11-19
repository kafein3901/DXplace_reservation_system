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
      show('devices');
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

for (const button of bar.querySelectorAll('[data-screen]')) {
  button.addEventListener('click', () => show(button.dataset.screen));
}

// 開いたとき（screens.md 2.5）
async function start() {
  const result = await callApi('GET', '/api/admin/me');
  if (result.ok) {
    setAdmin(result.data);
    show('devices');
    return;
  }
  show('login');
  showError(result.code);
}

start();
