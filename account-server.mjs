import {createServer} from 'node:http';
import {createHash, randomBytes, randomUUID, scrypt as derive, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {isIP} from 'node:net';
import Database from 'better-sqlite3';
import {validateRecords} from './core/journal.mjs';
import {validateRecipes} from './core/recipes.mjs';
import {attachScaleRelay} from './scale-bridge-server.mjs';

const scrypt = promisify(derive);
const cookieName = '__Host-doudang';
const lifetime = 30 * 24 * 60 * 60;
const maxData = 16 * 1024 * 1024;
const empty = '{"records":[],"recipes":[]}';
const hashToken = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), {status});

function passwordHash(password, salt) {
  return scrypt(password, salt, 32, {N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024});
}

function passwordInput(password, minimum = 10) {
  if (typeof password !== 'string' || password.length < minimum || Buffer.byteLength(password) > 256) {
    throw fail(400, '请输入至少 10 个字符、且不超过 256 字节的密码。');
  }
  return password;
}

async function readJson(request, limit) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw fail(415, '请求格式无效。');
  if (Number(request.headers['content-length']) > limit) throw fail(413, '资料超过 16 MB 的同步上限。');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({destroyOnReturn: false})) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw fail(413, '资料超过 16 MB 的同步上限。');
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw fail(400, '无法读取请求内容。'); }
}

function checkedData(body) {
  const records = validateRecords(body.records);
  for (const [index, record] of records.entries()) {
    const undo = body.records[index].undoDeduction;
    if (undo && typeof undo.token === 'string' && undo.token.length <= 100 &&
        [undo.previous, undo.remaining].every(value => typeof value === 'string' && value && Number.isFinite(Number(value)))) {
      record.undoDeduction = {token: undo.token, previous: undo.previous, remaining: undo.remaining,
        ...(Number.isFinite(undo.previousDose) ? {previousDose: undo.previousDose} : {})};
    }
  }
  return JSON.stringify({records, recipes: validateRecipes(body.recipes)});
}

export function createAccountServer({databasePath, origin, trustLoopbackProxy = false, maxAccounts = 100}) {
  const expectedOrigin = new URL(origin).origin;
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password TEXT NOT NULL,
      data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires);
    CREATE TABLE IF NOT EXISTS saved_mutations (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, saved_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS mutations_by_time ON saved_mutations(saved_at);
  `);
  const byName = db.prepare('SELECT id, name, salt, password FROM users WHERE name = ?');
  const byId = db.prepare('SELECT id, name, salt, password FROM users WHERE id = ?');
  const lookup = db.prepare('SELECT users.id, users.name FROM sessions JOIN users ON users.id = user_id WHERE token = ? AND expires > ?');
  const writeSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  const removeSession = db.prepare('DELETE FROM sessions WHERE token = ?');
  const expireSessions = db.prepare('DELETE FROM sessions WHERE expires <= ?');
  const newUser = db.prepare('INSERT INTO users (id,name,salt,password,data) VALUES (?,?,?,?,?)');
  const total = db.prepare('SELECT COUNT(*) AS count FROM users');
  const snapshot = db.prepare('SELECT revision, data FROM users WHERE id = ?');
  const writeSnapshot = db.prepare('UPDATE users SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ?');
  const hasMutation = db.prepare('SELECT 1 FROM saved_mutations WHERE user_id = ? AND id = ?');
  const noteMutation = db.prepare('INSERT INTO saved_mutations VALUES (?, ?, ?)');
  const expireMutations = db.prepare('DELETE FROM saved_mutations WHERE saved_at <= ?');
  const saveSnapshot = db.transaction((userId, body, data) => {
    if (!writeSnapshot.run(data, userId, body.revision).changes) throw fail(409, '其他设备刚刚更新了豆库，已保留服务器资料，请核对后重试。');
    expireMutations.run(Date.now() - 24 * 60 * 60 * 1000);
    noteMutation.run(userId, body.mutation, Date.now());
  });
  const writePassword = db.prepare('UPDATE users SET salt = ?, password = ? WHERE id = ? AND password = ?');
  const revokeUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const attempts = new Map();
  const dummySalt = randomBytes(16).toString('hex');
  let checking = 0;
  let uploading = 0;

  function rate(key, limit, now) {
    const slot = attempts.get(key) ?? {count: 0, until: now + 15 * 60 * 1000};
    if (slot.count >= limit) throw fail(429, '尝试次数过多，请稍后再试。');
    if (attempts.size >= 4000 && !attempts.has(key)) throw fail(429, '账号服务繁忙，请稍后再试。');
    slot.count++;
    attempts.set(key, slot);
  }

  function tokenFor(request) {
    const value = request.headers.cookie?.match(/(?:^|;\s*)__Host-doudang=([a-f0-9]{64})(?:;|$)/)?.[1];
    return value ? hashToken(value) : '';
  }

  function sessionFor(user, previous) {
    const value = randomBytes(32).toString('hex');
    const now = Date.now();
    if (previous) removeSession.run(previous);
    expireSessions.run(now);
    writeSession.run(hashToken(value), user.id, now + lifetime * 1000);
    return value;
  }

  const cookie = (value, age = lifetime) => `${cookieName}=${value}; Max-Age=${age}; Path=/; Secure; HttpOnly; SameSite=Strict`;
  const server = createServer({requestTimeout: 30000, headersTimeout: 15000}, async (request, response) => {
    const send = (status, data, extra = {}) => {
      if (response.destroyed) return;
      response.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff', ...extra});
      response.end(data === undefined ? undefined : JSON.stringify(data));
    };
    const {method, url} = request;
    const token = tokenFor(request);
    try {
      if (method !== 'GET' && request.headers.origin !== expectedOrigin) throw fail(403, '请求来源无效，请重新打开豆档。');
      const user = lookup.get(token, Date.now());
      if (method === 'GET' && url === '/api/account/session') return send(200, {user: user ?? null});
      if (method === 'POST' && ['/api/account/register','/api/account/login','/api/account/password'].includes(url)) {
        const peer = request.socket.remoteAddress ?? '';
        const ip = request.headers['x-real-ip'];
        const source = trustLoopbackProxy && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer) &&
          typeof ip === 'string' && isIP(ip) ? ip : peer;
        const now = Date.now();
        for (const [key, slot] of attempts) if (slot.until <= now) attempts.delete(key);
        rate('ip:' + source, 30, now);
        if (url.endsWith('/register')) rate('register:' + source, 5, now);
        const body = await readJson(request, 4096);
        if (!body || typeof body !== 'object') throw fail(400, '账号资料格式无效。');
        const change = url.endsWith('/password');
        if (change && (!user || request.headers['x-cafe-account'] !== user.id)) throw fail(401, '请重新登录。');
        const name = change ? user.name : typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
        if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(name)) throw fail(400, '账号须为 3–32 位英文字母、数字、下划线或短横线。');
        rate('account:' + name, 10, now);
        if (checking >= 3) throw fail(429, '账号服务繁忙，请稍后再试。');
        const register = url.endsWith('/register');
        const password = passwordInput(body.password, register ? 10 : 1);
        const newPassword = change ? passwordInput(body.newPassword) : null;
        checking++;
        try {
          let account = byName.get(name);
          let value;
          if (register) {
            if (account) throw fail(409, '这个账号名已被使用。');
            if (total.get().count >= maxAccounts) throw fail(503, '暂时无法注册新账号。');
            const salt = randomBytes(16).toString('hex');
            const hashed = await passwordHash(password, salt);
            if (byName.get(name)) throw fail(409, '这个账号名已被使用。');
            if (total.get().count >= maxAccounts) throw fail(503, '暂时无法注册新账号。');
            account = {id: randomUUID(), name};
            value = db.transaction(() => {
              newUser.run(account.id, name, salt, hashed.toString('hex'), empty);
              return sessionFor(account, token);
            })();
          } else {
            const hashed = await passwordHash(password, account?.salt ?? dummySalt);
            if (!account || !timingSafeEqual(hashed, Buffer.from(account.password, 'hex')) ||
                byId.get(account.id)?.password !== account.password) throw fail(401, '账号或密码不正确。');
            if (change) {
              const salt = randomBytes(16).toString('hex');
              const next = await passwordHash(newPassword, salt);
              value = db.transaction(() => {
                if (!lookup.get(token, Date.now()) ||
                    !writePassword.run(salt, next.toString('hex'), account.id, account.password).changes) throw fail(401, '请重新登录。');
                revokeUser.run(account.id);
                return sessionFor(account);
              })();
            } else value = db.transaction(() => sessionFor(account, token))();
          }
          attempts.delete('account:' + name);
          return send(register ? 201 : 200, {user: {id: account.id, name}}, {'Set-Cookie': cookie(value)});
        } finally { checking--; }
      }
      if (!user || request.headers['x-cafe-account'] !== user.id) throw fail(401, '账号已切换或登录已过期，请重新打开豆档。');
      if (method === 'POST' && url === '/api/account/logout') {
        removeSession.run(token);
        return send(200, {user: null}, {'Set-Cookie': cookie('', 0)});
      }
      if (url === '/api/account/data' && method === 'GET') {
        const current = snapshot.get(user.id);
        const etag = '"' + current.revision + '"';
        if (request.headers['if-none-match'] === etag) return send(304, undefined, {ETag: etag});
        return send(200, {revision: current.revision, ...JSON.parse(current.data)}, {ETag: etag});
      }
      if (url === '/api/account/data' && method === 'PUT') {
        if (uploading >= 4) throw fail(429, '同步服务繁忙，请稍后重试。');
        uploading++;
        try {
          const body = await readJson(request, maxData);
          if (!body || !Number.isSafeInteger(body.revision) || body.revision < 0 ||
              typeof body.mutation !== 'string' || !/^[a-f0-9-]{36}$/.test(body.mutation)) throw fail(400, '同步版本无效。');
          if (!lookup.get(token, Date.now())) throw fail(401, '登录已过期，请重新打开豆档。');
          if (hasMutation.get(user.id, body.mutation)) {
            const current = snapshot.get(user.id);
            return send(200, {revision: current.revision, ...JSON.parse(current.data)});
          }
          let data;
          try { data = checkedData(body); }
          catch (error) { throw fail(400, error.message); }
          if (Buffer.byteLength(data) > maxData) throw fail(413, '资料超过 16 MB 的同步上限。');
          saveSnapshot(user.id, body, data);
          return send(200, {revision: body.revision + 1, ...JSON.parse(data)});
        } finally { uploading--; }
      }
      return send(404, {message:'找不到这个账号操作。'});
    } catch (error) {
      if (!error.status) console.error('Account request failed:', error.code ?? error.name);
      send(error.status ?? 500, {message: error.status ? error.message : '账号服务暂时不可用，请稍后重试。'});
    }
  });
  server.once('close', () => db.close());
  // 电子秤中继：iOS 上的浏览器没有 Web Bluetooth，靠 /api/scale/relay 把重量转进来。
  // 握手前用登录态认人，房间按用户隔离；同源代理要让 /api/scale/ 的 Upgrade 头透传到账号服务。
  attachScaleRelay(server, {
    authenticate: request => {
      const token = tokenFor(request);
      if (!token) return '';
      return lookup.get(token, Date.now())?.id ?? '';
    },
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  createAccountServer({
    databasePath: process.env.CAFE_ACCOUNT_DB,
    origin: process.env.CAFE_ACCOUNT_ORIGIN,
    trustLoopbackProxy: process.env.CAFE_ACCOUNT_TRUST_LOOPBACK_PROXY === '1',
  }).listen(Number(process.env.CAFE_ACCOUNT_PORT ?? 1635), '127.0.0.1');
}
