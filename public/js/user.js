// 利用者の画面の動き（screens.md 2・3）
import { callApi } from './api.js';
import { messageFor } from './messages.js';

const bar = document.getElementById('bar');
const userLabel = document.getElementById('user-label');

// 利用者（screens.md 3.1。USR-3）。登録・ログイン・名前と期生の変更の応答の { role, student_id, name, cohort }。
// なければ null。端末に覚えさせず、ページを読み込み直すと消える
let user = null;

// 利用者が要る画面を出そうとして利用者がいなかったときの行き先（screens.md 3.1）
let destination = null;

// 利用者が要る画面。確保・予約なしの利用は予約の操作の実装で足す
const NEEDS_USER = new Set(['mine', 'change']);

// ログインと登録の画面。行き来しても覚えた行き先は消さない（screens.md 3.1）
const USER_ENTRY = new Set(['login', 'register']);

// 画面を出す。利用の開始の画面では帯を隠す。画面を切り替えたら文を消す（screens.md 2.3・3.1）
function show(name) {
  for (const section of document.querySelectorAll('section')) {
    section.hidden = section.id !== `screen-${name}`;
  }
  bar.hidden = name === 'start';
  setMessage(name, '', null);
  // 名前・期生の変更は出すたびに欄を利用者の値で入れ直す（screens.md 3.3.4）
  if (name === 'change' && user !== null) fillChangeForm();
  // 予約状況は出すたびに取り直す（screens.md 3.1）。応答は後で届くので、呼んだ側がこの後に出す文は消えない
  if (name === 'day') loadDayDevices();
}

// 帯のボタンから画面を出す。利用者が要る画面で利用者がいなければ、行き先を覚えてログインを出す（screens.md 3.1）。
// ログイン・登録以外の画面を自分で選んだら、前に覚えた行き先は使わない
function open(name) {
  if (!USER_ENTRY.has(name)) destination = null;
  if (NEEDS_USER.has(name) && user === null) {
    destination = name;
    return show('login');
  }
  show(name);
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

// 上の帯の操作する人（screens.md 3.1）
function renderUserLabel() {
  if (user === null) {
    userLabel.textContent = '操作する人：未ログイン';
  } else if (user.role === 'teacher') {
    userLabel.textContent = `操作する人：${user.name}（教員）`;
  } else {
    userLabel.textContent = `操作する人：${user.name}（${user.cohort}期・生徒）`;
  }
}

// 断られた応答を受け取る1つの関数（screens.md 2.4）。
// AUTH_REQUIRED・AUTH_REVOKED なら利用の開始へ、NOT_FOUND_USER ならログインへ移ってそこに文を出し、
// ほかは今の画面に文を出す
function showError(code) {
  if (code === 'AUTH_REQUIRED' || code === 'AUTH_REVOKED') {
    show('start');
    setMessage('start', messageFor(code), 'error');
    return;
  }
  // ログインの画面で受けたときは移らず、利用者の変数も変えない（screens.md 3.3.2）
  if (code === 'NOT_FOUND_USER' && currentScreen() !== 'login') {
    // 利用者の変数を消し、元の画面を行き先として覚える
    destination = currentScreen();
    user = null;
    renderUserLabel();
    show('login');
    setMessage('login', messageFor(code), 'error');
    return;
  }
  setMessage(currentScreen(), messageFor(code), 'error');
}

for (const button of bar.querySelectorAll('[data-screen]')) {
  button.addEventListener('click', () => open(button.dataset.screen));
}

// ---- 予約状況（screens.md 3.4 の 1。VIW-1） ----

const dayDeviceField = document.getElementById('day-device');
const dayDateField = document.getElementById('day-date');
const dayEmpty = document.getElementById('day-empty');

// 直近の応答の now（YYYY-MM-DDTHH:mm、日本時間）。初期値はこれから作り、端末の時計は読まない（screens.md 2.8・3.1）
let now = null;

// 選んでいる機器 { id, name }。なければ null（screens.md 3.1）。番号は数で持つ
let selectedDevice = null;

// 機器の選択肢を作り直し、now を持つ。日の欄が空なら now の日を入れる
async function loadDayDevices() {
  const result = await callApi('GET', '/api/devices');
  if (!result.ok) return showError(result.code);
  now = result.data.now;
  const { devices } = result.data;

  // 選んでいた機器が選択肢にあればそれを、なければ最初の機器を選ぶ
  const keep = selectedDevice === null ? undefined : devices.find((device) => device.id === selectedDevice.id);
  selectedDevice = keep ?? devices[0] ?? null;
  dayDeviceField.replaceChildren(
    ...devices.map((device) => {
      const option = document.createElement('option');
      option.value = String(device.id);
      option.textContent = device.name; // SEC-1
      return option;
    }),
  );
  if (selectedDevice !== null) dayDeviceField.value = String(selectedDevice.id);
  dayEmpty.hidden = devices.length > 0;
  dayDeviceField.disabled = devices.length === 0;

  if (dayDateField.value === '') dayDateField.value = now.slice(0, 10);
}

dayDeviceField.addEventListener('change', () => {
  const id = Number(dayDeviceField.value);
  const option = dayDeviceField.selectedOptions[0];
  selectedDevice = option === undefined ? null : { id, name: option.textContent };
});

// ---- ログイン・登録・名前と期生の変更（screens.md 3.3。USR-3〜USR-7） ----

const loginForm = document.getElementById('login-form');
const loginStudentIdField = document.getElementById('login-student-id');
const registerForm = document.getElementById('register-form');
const registerStudentIdField = document.getElementById('register-student-id');
const registerNameField = document.getElementById('register-name');
const registerCohortField = document.getElementById('register-cohort');
const registerCohortLabel = document.getElementById('register-cohort-label');
const changeForm = document.getElementById('change-form');
const changeNameField = document.getElementById('change-name');
const changeCohortField = document.getElementById('change-cohort');
const changeCohortLabel = document.getElementById('change-cohort-label');

function selectedRole(form) {
  return form.querySelector('input[name="role"]:checked')?.value ?? null;
}

function selectRole(form, role) {
  for (const radio of form.querySelectorAll('input[name="role"]')) radio.checked = radio.value === role;
}

// 送る前に確かめるのは、空の欄と、期生が数でないことだけ（screens.md 2.9）。
// その画面にある欄だけを渡す（ない欄は undefined）。role は生徒か教員かで、期生を見るかを決めるのにも使う。
// 問題があれば文を、なければ null を返す
function checkFields({ role, studentId, name, cohort }) {
  if (role === null) return '生徒か教員かを選んでください。';
  if (studentId !== undefined && studentId === '') return '学籍番号を入れてください。';
  if (name !== undefined && name === '') return '名前を入れてください。';
  if (role === 'student' && cohort !== undefined) {
    if (cohort === '') return '期生を入れてください。';
    if (!Number.isFinite(Number(cohort))) return '期生は数で入れてください。';
  }
  return null;
}

// 応答の利用者で利用者の変数を置き換える（screens.md 3.3.1）
function setUser(data) {
  const { role, student_id, name, cohort } = data;
  user = { role, student_id, name, cohort };
  renderUserLabel();
}

// ログイン・登録が成功したら、覚えた行き先か予約状況を出し、そこに文を出す（screens.md 3.3.2・3.3.3）
function enterAs(data) {
  setUser(data);
  const next = destination ?? 'day';
  destination = null;
  show(next);
  setMessage(next, `${data.name}として操作します。`, 'success');
}

// 操作のボタンを応答が返るまで止めて API を呼ぶ（screens.md 2.6）
async function submitWith(form, path, body) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    return await callApi('POST', path, body);
  } finally {
    button.disabled = false;
  }
}

// ログイン（screens.md 3.3.2）
loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('login', '', null);
  const role = selectedRole(loginForm);
  // 学籍番号は前後の空白だけ除く。全角・大文字は台帳がそろえる（screens.md 3.3.1）
  const studentId = loginStudentIdField.value.trim();
  const problem = checkFields({ role, studentId });
  if (problem !== null) return setMessage('login', problem, 'error');

  const result = await submitWith(loginForm, '/api/me/login', { role, student_id: studentId });
  // 断られたら利用者の変数は変えない（NOT_FOUND_USER もこの画面では変えない）
  if (!result.ok) return showError(result.code);
  loginStudentIdField.value = result.data.student_id; // そろえた値に置き換える（USR-4）
  enterAs(result.data);
});

// 「初めて使う人は登録」：登録の欄が空なら、生徒か教員か・学籍番号を写す。覚えた行き先はそのまま（screens.md 3.3.2）
document.getElementById('login-to-register').addEventListener('click', () => {
  const loginRole = selectedRole(loginForm);
  if (selectedRole(registerForm) === null && loginRole !== null) {
    selectRole(registerForm, loginRole);
    registerCohortLabel.hidden = loginRole === 'teacher';
  }
  if (registerStudentIdField.value === '') registerStudentIdField.value = loginStudentIdField.value.trim();
  show('register');
});

// 「ログインに戻る」：覚えた行き先はそのまま（screens.md 3.3.3）
document.getElementById('register-to-login').addEventListener('click', () => show('login'));

// 登録で教員を選んでいる間は期生の欄を隠す（値は残す。screens.md 3.3.1）
for (const radio of registerForm.querySelectorAll('input[name="role"]')) {
  radio.addEventListener('change', () => {
    registerCohortLabel.hidden = selectedRole(registerForm) === 'teacher';
  });
}

// 登録（screens.md 3.3.3）
registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('register', '', null);
  const role = selectedRole(registerForm);
  const studentId = registerStudentIdField.value.trim();
  const name = registerNameField.value;
  const cohort = registerCohortField.value;
  const problem = checkFields({ role, studentId, name, cohort });
  if (problem !== null) return setMessage('register', problem, 'error');

  // 名前は欄の値のまま送る（前後の空白は台帳が除く）。教員は期生を送らない
  const body = { role, student_id: studentId, name };
  if (role === 'student') body.cohort = Number(cohort);
  const result = await submitWith(registerForm, '/api/me/register', body);
  // RULE_USER_DUPLICATE でも自動ではログインしない（screens.md 3.3.3）
  if (!result.ok) return showError(result.code);
  // ログインの画面の欄も応答の値に置き換える
  selectRole(loginForm, result.data.role);
  loginStudentIdField.value = result.data.student_id;
  enterAs(result.data);
});

// 名前・期生の変更の欄を利用者の値で入れ直す。教員なら期生の欄を隠す（screens.md 3.3.4）
function fillChangeForm() {
  changeNameField.value = user.name;
  changeCohortField.value = user.cohort === null ? '' : String(user.cohort);
  changeCohortLabel.hidden = user.role === 'teacher';
}

// 名前・期生の変更（screens.md 3.3.4）。識別の組は利用者の変数の値を送る
changeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('change', '', null);
  if (user === null) return showError('NOT_FOUND_USER');
  const name = changeNameField.value;
  const cohort = changeCohortField.value;
  const problem = checkFields({ role: user.role, name, cohort });
  if (problem !== null) return setMessage('change', problem, 'error');

  const body = { role: user.role, student_id: user.student_id, name };
  if (user.role === 'student') body.cohort = Number(cohort);
  const result = await submitWith(changeForm, '/api/me/change', body);
  if (!result.ok) return showError(result.code);
  // 同じ値で決定しても成功する。画面は移らない
  setUser(result.data);
  fillChangeForm();
  setMessage('change', '名前・期生を変えました。', 'success');
});

// 開いたとき（screens.md 2.5・3.2。USR-2）
async function start() {
  // #k= があれば値をそのまま送る（空の文字列でも送り、台帳が断る）。# があって k がなければ #k= がないものとする
  const k = location.hash === '' ? null : new URLSearchParams(location.hash.slice(1)).get('k');
  if (k !== null) {
    const pending = callApi('POST', '/api/session', { k });
    // 応答を待たずに URL から # 以降を消す（auth.md 2）
    history.replaceState(null, '', location.pathname + location.search);
    const result = await pending;
    if (result.ok) return show('day');
    show('start');
    return showError(result.code);
  }

  const result = await callApi('GET', '/api/session');
  if (result.ok && result.data.active) return show('day');
  show('start');
  // active が偽なら reason のコードの文を出す（api.md 8.13）
  showError(result.ok ? result.data.reason : result.code);
}

start();
