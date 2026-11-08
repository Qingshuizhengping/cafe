const recordsKey = 'doudang-preview-records';
const recipesKey = 'doudang-recipes-v1';
const signalKey = 'doudang-account-updated';
const empty = {records: [], recipes: []};
const $ = id => document.getElementById(id);

export async function createAccountStorage() {
  const api = new URL('./api/account/', import.meta.url);
  let user = null;
  let snapshot;
  let reachable = false;
  let queue = Promise.resolve();
  let listener;
  let syncing = false;

  async function request(path, {method = 'GET', body, match, timeout = 15000} = {}) {
    let response;
    const headers = {};
    if (user) headers['X-Cafe-Account'] = user.id;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (match !== undefined) headers['If-None-Match'] = '"' + match + '"';
    try {
      response = await fetch(new URL(path, api), {
        method, headers, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
        signal: AbortSignal.timeout(timeout), body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw Object.assign(new Error('无法确认服务器是否收到修改，请核对后重试。'), {network: true});
    }
    if (response.status === 304) return null;
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.message || (response.status === 413
      ? '资料超过 16 MB 的同步上限。' : '同步服务暂不可用，请稍后重试。')), {status: response.status});
    return value;
  }

  function localData() {
    const records = JSON.parse(localStorage.getItem(recordsKey));
    const recipes = JSON.parse(localStorage.getItem(recipesKey));
    return {records: Array.isArray(records) ? records : [], recipes: Array.isArray(recipes) ? recipes : []};
  }

  function saveLocal(before, after) {
    const records = before.records !== after.records ? JSON.stringify(after.records) : null;
    const recipes = before.recipes !== after.recipes ? JSON.stringify(after.recipes) : null;
    const previousRecipes = localStorage.getItem(recipesKey);
    if (recipes !== null) localStorage.setItem(recipesKey, recipes);
    try {
      if (records !== null) localStorage.setItem(recordsKey, records);
    } catch (error) {
      if (recipes !== null) {
        try {
          if (previousRecipes === null) localStorage.removeItem(recipesKey);
          else localStorage.setItem(recipesKey, previousRecipes);
        } catch {
          throw new Error('豆档未保存，冲煮方案已写入。请检查浏览器储存后重试。');
        }
      }
      throw error;
    }
  }

  function status(message) {
    $('account-status').textContent = message;
    $('account-open').textContent = user ? (reachable && snapshot ? '已登录' : '同步待重试') : '账号';
    $('account-mode').textContent = user ? '账号 · ' + user.name : '本机模式';
  }

  function adopt(next) {
    if (!next || (snapshot && next.revision <= snapshot.revision)) return;
    snapshot = next;
    listener?.(next);
  }

  function notifySession() {
    try { localStorage.setItem(signalKey, crypto.randomUUID()); } catch {}
  }

  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      if (user) adopt(await request('data', {match: snapshot?.revision}));
      else {
        const session = await request('session');
        if (session.user) { location.reload(); return; }
      }
      reachable = true;
      status(user ? '已同步到服务器' : '登录后可在其他设备查看同一豆库。');
    } catch (error) {
      reachable = false;
      if (error.status === 401) { location.reload(); return; }
      status(user ? '同步暂不可用。恢复连接后会自动更新。' : '暂时无法连接账号服务。');
    } finally { syncing = false; }
  }

  try {
    const session = await request('session', {timeout:4500});
    user = session.user ?? null;
    if (user) adopt(await request('data'));
    reachable = true;
  } catch {}
  status(user ? (snapshot ? '已同步到服务器' : '暂未读取到服务器资料。') :
    (reachable ? '登录后可在其他设备查看同一豆库。' : '暂时无法连接账号服务。'));

  function change(transform) {
    const run = async () => {
      if (!user) {
        const before = localData();
        const next = transform(before);
        saveLocal(before, next);
        return next;
      }
      try {
        adopt(await request('data', {match: snapshot?.revision}));
        const next = transform(snapshot);
        status('正在保存到服务器…');
        const write = {method:'PUT', body:{...next, revision:snapshot.revision, mutation:crypto.randomUUID()}};
        let saved;
        try { saved = await request('data', write); }
        catch (error) {
          if (!error.network || !navigator.onLine) throw error;
          saved = await request('data', write);
        }
        adopt(saved);
        reachable = true;
        status('已同步到服务器');
        return snapshot;
      } catch (error) {
        if (error.status === 409) {
          try { adopt(await request('data')); } catch {}
        }
        if (error.network) reachable = false;
        status('这次修改未确认保存，请核对后重试。');
        throw error;
      }
    };
    if (!user && navigator.locks) return navigator.locks.request(recordsKey, run);
    const task = queue.then(run);
    queue = task.catch(() => {});
    return task;
  }

  function connect(onData) {
    listener = onData;
    window.addEventListener('storage', event => {
      if (event.key === signalKey) { location.reload(); return; }
      if (!user && [recordsKey, recipesKey].includes(event.key)) {
        try { onData(localData()); } catch { status('暂时无法读取本机资料。'); }
      }
    });
    window.addEventListener('online', sync);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void sync();
    });
    setInterval(() => {
      if (user && !document.hidden) void sync();
    }, 15000);
  }

  function connectDialog(importLocal) {
    const dialog = $('account-dialog');
    const form = $('account-form');
    let mode = 'login';
    let busy = false;
    function draw() {
      const passwordMode = mode === 'password';
      $('account-credentials').hidden = !!user && !passwordMode;
      $('account-options').hidden = !user || passwordMode;
      $('account-name-field').hidden = passwordMode;
      $('account-name').disabled = passwordMode;
      $('account-new-field').hidden = !passwordMode;
      $('account-new').disabled = !passwordMode;
      $('account-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
      $('account-password').minLength = mode === 'register' ? 10 : 1;
      $('account-password-label').textContent = passwordMode ? '当前密码' : '密码';
      $('account-submit').textContent = {login:'登录', register:'注册并登录', password:'保存新密码'}[mode];
      $('account-switch').textContent = {login:'创建账号', register:'已有账号，去登录', password:'返回账号'}[mode];
      $('account-local-import').hidden = !user || !importLocal;
    }
    function setMode(next) {
      mode = next;
      form.reset();
      $('account-feedback').textContent = '';
      draw();
    }
    async function perform(action, callback) {
      if (busy) return;
      busy = true;
      action.disabled = true;
      $('account-close').disabled = true;
      $('account-feedback').textContent = '';
      try { await callback(); }
      catch (error) { $('account-feedback').textContent = error.message; }
      finally { busy = false; action.disabled = false; $('account-close').disabled = false; }
    }
    $('account-open').onclick = () => {
      setMode('login');
      dialog.showModal();
      void sync();
    };
    $('account-close').onclick = () => { if (!busy) dialog.close(); };
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => form.reset());
    $('account-switch').onclick = () => {
      if (!busy) setMode(mode === 'login' ? 'register' : 'login');
    };
    $('account-password-open').onclick = () => setMode('password');
    form.onsubmit = event => {
      event.preventDefault();
      void perform($('account-submit'), async () => {
        await request(mode, {method:'POST',body:{
          name:$('account-name').value, password:$('account-password').value, newPassword:$('account-new').value,
        }});
        notifySession();
        location.reload();
      });
    };
    $('account-logout').onclick = () => perform($('account-logout'), async () => {
      await request('logout', {method:'POST'});
      notifySession();
      location.reload();
    });
    $('account-local-import').onclick = () => perform($('account-local-import'), async () => {
      await importLocal(localData());
      $('account-feedback').textContent = '本机资料已合并到账号。重复导入会跳过相同资料。';
    });
    draw();
  }

  return {
    user, change, connect, connectDialog,
    current: () => user ? snapshot ?? empty : localData(),
    deviceKey: key => user ? key + ':' + user.id : key,
  };
}
