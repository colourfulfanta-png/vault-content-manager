import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';

type Bindings = { DB: D1Database; ASSETS: Fetcher; JWT_SECRET?: string };
type Variables = { jwtPayload: { sub: string; name?: string; scope?: string }; scope?: string };
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/* ---------------- 工具 ---------------- */
const TE = new TextEncoder();
const hex = (u8: Uint8Array) => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

const HEX32 = /^[0-9a-f]{32}$/;   /* 16 字节盐（hex） */
const HEX64 = /^[0-9a-f]{64}$/;   /* 32 字节摘要 / 旧方案 PBKDF2 输出（hex） */
const KDF_MIN = 100000;
const KDF_MAX = 1000000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', TE.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
}

function validBlob(b: any) {
  return !!b && typeof b === 'object'
    && typeof b.iv === 'string' && typeof b.ct === 'string'
    && b.iv.length > 0 && b.iv.length < 100 && b.ct.length > 0 && b.ct.length < 4000;
}
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,}$/;

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* JWT 密钥：优先环境变量，否则生成一次存入 settings 表 */
async function jwtSecret(env: Bindings) {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'jwt_secret'`)
    .first<{ value: string }>();
  if (row) return row.value;
  /* OR IGNORE + 回读：并发首次请求时不会因为主键冲突而 500 */
  const s = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('jwt_secret', ?)`).bind(s).run();
  const saved = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'jwt_secret'`)
    .first<{ value: string }>();
  return saved?.value ?? s;
}

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  salt: string;
  kdf_iterations: number;
  scheme: number | null;
  enc_salt: string | null;
};

/* ---------------- 认证（新方案：服务器不接触主密码） ----------------
   · scheme=2：authKey = PBKDF2(主密码, auth盐, iterations)，服务器只存 SHA-256(authKey)；
               encKey  = PBKDF2(主密码, enc盐, iterations)，只存在于浏览器
   · scheme=1：旧方案兼容（password_hash = PBKDF2(主密码, 旧盐, N)），首次登录后由前端原子升级
   ---------------------------------------------------------------- */
async function issueToken(env: Bindings, id: number, name: string) {
  return sign({ sub: String(id), name, exp: Math.floor(Date.now() / 1000) + 86400 }, await jwtSecret(env));
}

/* 注册：客户端提交 verifier + 两个盐，服务器不接触主密码 */
app.post('/api/register', async c => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username ?? '').trim();
  const verifier = norm(body.verifier);
  const authSalt = norm(body.auth_salt);
  const encSalt = norm(body.enc_salt);
  const iterations = Number(body.iterations) || 0;

  if (!username) return c.json({ error: '用户名不能为空' }, 400);
  if (!HEX64.test(verifier)) return c.json({ error: 'verifier 格式错误' }, 400);
  if (!HEX32.test(authSalt) || !HEX32.test(encSalt)) return c.json({ error: '盐格式错误' }, 400);
  if (iterations < KDF_MIN || iterations > KDF_MAX) return c.json({ error: '迭代次数不合法' }, 400);

  /* 恢复码（可选）：recovery_blob 是恢复码包裹的 encKey，服务器无法解开 */
  const recoveryBlob = body.recovery_blob;
  const recoveryVerifier = norm(body.recovery_verifier);
  const hasRecovery = recoveryVerifier.length > 0 || recoveryBlob;
  if (hasRecovery) {
    if (!validBlob(recoveryBlob) || !HEX64.test(recoveryVerifier))
      return c.json({ error: '恢复码数据格式错误' }, 400);
  }

  /* 单用户模式：数据表全局共享，多账号会互相看到数据且私密字段无法解密 */
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM user').first<{ n: number }>();
  if ((count?.n ?? 0) > 0)
    return c.json({ error: '该实例已有账号，注册已关闭。请用已有账号登录' }, 403);
  if (await c.env.DB.prepare('SELECT id FROM user WHERE username = ?').bind(username).first())
    return c.json({ error: '用户已存在，请直接登录' }, 409);

  await c.env.DB.prepare(
    'INSERT INTO user (username, password_hash, salt, kdf_iterations, scheme, enc_salt, recovery_blob, recovery_verifier, recovery_set_at) VALUES (?,?,?,?,2,?,?,?,?)'
  ).bind(username, verifier, authSalt, iterations, encSalt,
    hasRecovery ? JSON.stringify(recoveryBlob) : null,
    hasRecovery ? recoveryVerifier : null,
    hasRecovery ? Math.floor(Date.now() / 1000) : null).run();
  return c.json({ ok: true });
});

/* 登录挑战：只返回方案与盐（不返回任何可逆凭据） */
app.post('/api/auth/challenge', async c => {
  const body = await c.req.json().catch(() => ({}));
  const u = String(body.username ?? '').trim();
  if (!u) return c.json({ error: '请输入用户名' }, 400);
  const row = await c.env.DB.prepare('SELECT * FROM user WHERE username = ?').bind(u).first<UserRow>();
  if (!row) return c.json({ error: 'USER_NOT_FOUND' }, 404);
  return c.json({
    scheme: row.scheme ?? 1,
    salt: row.salt,
    enc_salt: row.enc_salt,
    iterations: row.kdf_iterations,
  });
});

/* 登录校验：proof = scheme2 的 SHA-256(authKey) / scheme1 的旧 PBKDF2 哈希 */
app.post('/api/auth/login', async c => {
  const body = await c.req.json().catch(() => ({}));
  const u = String(body.username ?? '').trim();
  const proof = norm(body.proof);
  if (!u) return c.json({ error: '请输入用户名' }, 400);
  if (!HEX64.test(proof)) return c.json({ error: '请求格式错误' }, 400);

  const row = await c.env.DB.prepare('SELECT * FROM user WHERE username = ?').bind(u).first<UserRow>();
  if (!row) return c.json({ error: 'USER_NOT_FOUND' }, 404);
  if (!safeEqual(String(row.password_hash ?? '').toLowerCase(), proof))
    return c.json({ error: '用户名或主密码错误' }, 401);

  const token = await issueToken(c.env, row.id, u);
  return c.json({
    token,
    scheme: row.scheme ?? 1,
    salt: row.salt,
    enc_salt: row.enc_salt,
    iterations: row.kdf_iterations,
    username: u,
  });
});

/* ---------------- 恢复码找回（无需登录） ---------------- */
app.post('/api/auth/recover/challenge', async c => {
  const body = await c.req.json().catch(() => ({}));
  const u = String(body.username ?? '').trim();
  if (!u) return c.json({ error: '请输入用户名' }, 400);
  const row = await c.env.DB.prepare('SELECT id, recovery_blob FROM user WHERE username = ?').bind(u)
    .first<{ id: number; recovery_blob: string | null }>();
  if (!row) return c.json({ error: 'USER_NOT_FOUND' }, 404);
  if (!row.recovery_blob) return c.json({ error: '该账号未生成恢复码，无法通过恢复码找回' }, 409);
  return c.json({ blob: JSON.parse(row.recovery_blob) });
});

app.post('/api/auth/recover/verify', async c => {
  const body = await c.req.json().catch(() => ({}));
  const u = String(body.username ?? '').trim();
  const verifier = norm(body.verifier);
  if (!u || !HEX64.test(verifier)) return c.json({ error: '请求格式错误' }, 400);
  const row = await c.env.DB.prepare('SELECT id, recovery_verifier FROM user WHERE username = ?').bind(u)
    .first<{ id: number; recovery_verifier: string | null }>();
  if (!row) return c.json({ error: 'USER_NOT_FOUND' }, 404);
  if (!row.recovery_verifier) return c.json({ error: '该账号未生成恢复码' }, 409);
  if (!safeEqual(row.recovery_verifier.toLowerCase(), verifier))
    return c.json({ error: '恢复码不正确' }, 403);
  /* 恢复凭证：10 分钟有效，只允许读取数据 + 提交重置 */
  const token = await sign(
    { sub: String(row.id), scope: 'recover', exp: Math.floor(Date.now() / 1000) + 600 },
    await jwtSecret(c.env)
  );
  return c.json({ token });
});

/* ---------------- 以下接口需要 Bearer Token ---------------- */
const auth = new Hono<{ Bindings: Bindings; Variables: Variables }>();

auth.use('*', async (c, next) => {
  const t = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!t) return c.json({ error: '未登录' }, 401);
  try {
    /* Hono 4.13+ 的 verify 不再默认 alg，必须显式传 'HS256'，否则抛 JwtAlgorithmRequired */
    const payload = (await verify(t, await jwtSecret(c.env), 'HS256')) as {
      sub: string; name?: string; scope?: string;
    };
    const scope = payload.scope;
    const path = c.req.path;
    const method = c.req.method;
    if (scope === 'recover') {
      /* 恢复凭证只能：读类型、读条目、提交重置 */
      const allowed =
        (method === 'GET' && (path === '/api/items' || path === '/api/types')) ||
        (method === 'POST' && path === '/api/auth/recover/reset');
      if (!allowed) return c.json({ error: '恢复凭证权限不足' }, 403);
    } else if (path === '/api/auth/recover/reset') {
      return c.json({ error: '请先通过恢复码验证' }, 403);
    }
    c.set('jwtPayload', payload);
    c.set('scope', scope);
    await next();
  } catch (err) {
    console.error('JWT 校验失败:', err);
    return c.json({ error: '登录已过期，请重新登录' }, 401);
  }
});

/* 旧方案 → 新方案：凭据 + 全部条目密文一次原子提交（D1 batch 是事务） */
auth.post('/auth/upgrade', async c => {
  const uid = Number(c.get('jwtPayload')?.sub);
  if (!uid) return c.json({ error: '未登录' }, 401);

  const row = await c.env.DB.prepare('SELECT id, scheme FROM user WHERE id = ?').bind(uid)
    .first<{ id: number; scheme: number }>();
  if (!row) return c.json({ error: '用户不存在' }, 404);
  if ((row.scheme ?? 1) !== 1) return c.json({ error: '该账号已是新方案，无需升级' }, 409);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: '数据格式错误' }, 400);
  const verifier = norm(body.verifier);
  const authSalt = norm(body.auth_salt);
  const encSalt = norm(body.enc_salt);
  const iterations = Number(body.iterations) || 0;
  const items = Array.isArray(body.items) ? (body.items as Record<string, any>[]) : null;

  if (!HEX64.test(verifier) || !HEX32.test(authSalt) || !HEX32.test(encSalt) ||
      iterations < KDF_MIN || iterations > KDF_MAX || !items)
    return c.json({ error: '升级参数不合法' }, 400);

  const typeIds = new Set(
    (await c.env.DB.prepare('SELECT id FROM item_type').all<{ id: number }>()).results.map(r => r.id)
  );
  for (const it of items) {
    if (!it?.title || !typeIds.has(it.type_id))
      return c.json({ error: `条目「${it?.title ?? '?'}」的类型无效` }, 400);
    if (!!it.secret_iv !== !!it.secret_ct)
      return c.json({ error: `条目「${it.title}」加密数据不完整` }, 400);
  }

  const db = c.env.DB;
  await db.batch([
    db.prepare(
      'UPDATE user SET password_hash=?, salt=?, enc_salt=?, kdf_iterations=?, scheme=2 WHERE id=?'
    ).bind(verifier, authSalt, encSalt, iterations, uid),
    db.prepare('DELETE FROM item'),
    ...items.map(it => db.prepare(
      'INSERT INTO item (id, type_id, title, plain, secret_iv, secret_ct, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(it.id, it.type_id, it.title, JSON.stringify(it.plain || {}),
      it.secret_iv || null, it.secret_ct || null, it.created_at || Date.now(), it.updated_at || Date.now())),
  ]);
  return c.json({ ok: true });
});

/* ---------------- 账号安全：邮箱 / 恢复码 / 恢复重置 ---------------- */
auth.get('/auth/me', async c => {
  const uid = Number(c.get('jwtPayload')?.sub);
  if (!uid) return c.json({ error: '未登录' }, 401);
  const row = await c.env.DB.prepare(
    'SELECT username, email, scheme, kdf_iterations, recovery_blob, created_at FROM user WHERE id = ?'
  ).bind(uid).first<Record<string, any>>();
  if (!row) return c.json({ error: '用户不存在' }, 404);
  return c.json({
    username: row.username,
    email: row.email || null,
    scheme: row.scheme,
    iterations: row.kdf_iterations,
    has_recovery: !!row.recovery_blob,
    created_at: row.created_at,
  });
});

/* 设置 / 修改密保邮箱：必须出示当前主密码（proof = SHA-256(authKey)） */
auth.post('/auth/email', async c => {
  const uid = Number(c.get('jwtPayload')?.sub);
  const body = await c.req.json().catch(() => ({}));
  const proof = norm(body.proof);
  const email = String(body.email ?? '').trim();
  if (!HEX64.test(proof)) return c.json({ error: '请求格式错误' }, 400);
  if (email && !EMAIL_RE.test(email)) return c.json({ error: '邮箱格式不正确' }, 400);

  const row = await c.env.DB.prepare('SELECT password_hash FROM user WHERE id = ?').bind(uid)
    .first<{ password_hash: string }>();
  if (!row) return c.json({ error: '用户不存在' }, 404);
  if (!safeEqual(String(row.password_hash).toLowerCase(), proof))
    return c.json({ error: '主密码不正确' }, 403);

  await c.env.DB.prepare('UPDATE user SET email = ? WHERE id = ?').bind(email || null, uid).run();
  return c.json({ ok: true, email: email || null });
});

/* 生成 / 重新生成恢复码：必须出示当前主密码，客户端提交包裹后的 blob */
auth.post('/auth/recovery-setup', async c => {
  const uid = Number(c.get('jwtPayload')?.sub);
  const body = await c.req.json().catch(() => ({}));
  const proof = norm(body.proof);
  const blob = body.recovery_blob;
  const recoveryVerifier = norm(body.recovery_verifier);
  if (!HEX64.test(proof) || !validBlob(blob) || !HEX64.test(recoveryVerifier))
    return c.json({ error: '请求格式错误' }, 400);

  const row = await c.env.DB.prepare('SELECT password_hash FROM user WHERE id = ?').bind(uid)
    .first<{ password_hash: string }>();
  if (!row) return c.json({ error: '用户不存在' }, 404);
  if (!safeEqual(String(row.password_hash).toLowerCase(), proof))
    return c.json({ error: '主密码不正确' }, 403);

  await c.env.DB.prepare(
    'UPDATE user SET recovery_blob = ?, recovery_verifier = ?, recovery_set_at = ? WHERE id = ?'
  ).bind(JSON.stringify(blob), recoveryVerifier, Math.floor(Date.now() / 1000), uid).run();
  return c.json({ ok: true });
});

/* 用恢复凭证重置主密码：原子更新凭据 + 恢复码 + 全部条目密文 */
auth.post('/auth/recover/reset', async c => {
  if (c.get('scope') !== 'recover') return c.json({ error: '请先通过恢复码验证' }, 403);
  const uid = Number(c.get('jwtPayload')?.sub);
  if (!uid) return c.json({ error: '未登录' }, 401);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: '数据格式错误' }, 400);
  const verifier = norm(body.verifier);
  const authSalt = norm(body.auth_salt);
  const encSalt = norm(body.enc_salt);
  const iterations = Number(body.iterations) || 0;
  const items = Array.isArray(body.items) ? (body.items as Record<string, any>[]) : null;
  const blob = body.recovery_blob;
  const recoveryVerifier = norm(body.recovery_verifier);
  if (!HEX64.test(verifier) || !HEX32.test(authSalt) || !HEX32.test(encSalt) ||
      iterations < KDF_MIN || iterations > KDF_MAX || !items ||
      !validBlob(blob) || !HEX64.test(recoveryVerifier))
    return c.json({ error: '重置参数不合法' }, 400);

  if (!(await c.env.DB.prepare('SELECT id FROM user WHERE id = ?').bind(uid).first()))
    return c.json({ error: '用户不存在' }, 404);

  const typeIds = new Set(
    (await c.env.DB.prepare('SELECT id FROM item_type').all<{ id: number }>()).results.map(r => r.id)
  );
  for (const it of items) {
    if (!it?.title || !typeIds.has(it.type_id))
      return c.json({ error: `条目「${it?.title ?? '?'}」的类型无效` }, 400);
    if (!!it.secret_iv !== !!it.secret_ct)
      return c.json({ error: `条目「${it.title}」加密数据不完整` }, 400);
  }

  const db = c.env.DB;
  await db.batch([
    db.prepare(
      'UPDATE user SET password_hash=?, salt=?, enc_salt=?, kdf_iterations=?, scheme=2, recovery_blob=?, recovery_verifier=?, recovery_set_at=? WHERE id=?'
    ).bind(verifier, authSalt, encSalt, iterations,
      JSON.stringify(blob), recoveryVerifier, Math.floor(Date.now() / 1000), uid),
    db.prepare('DELETE FROM item'),
    ...items.map(it => db.prepare(
      'INSERT INTO item (id, type_id, title, plain, secret_iv, secret_ct, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(it.id, it.type_id, it.title, JSON.stringify(it.plain || {}),
      it.secret_iv || null, it.secret_ct || null, it.created_at || Date.now(), it.updated_at || Date.now())),
  ]);
  return c.json({ ok: true });
});

/* ---- 类型：读 + 全量替换 ---- */
auth.get('/types', async c => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM item_type ORDER BY sort_order, id'
  ).all<{ id: number; name: string; icon: string; allow_dup: number; fields: string }>();
  return c.json(results.map(r => ({
    id: r.id, name: r.name, icon: r.icon,
    allow_dup: !!r.allow_dup, fields: JSON.parse(r.fields),
  })));
});

auth.put('/types', async c => {
  const types = await c.req.json().catch(() => null);
  if (!Array.isArray(types)) return c.json({ error: '数据格式错误' }, 400);
  for (const t of types)
    if (!t?.name || !Array.isArray(t.fields))
      return c.json({ error: `类型「${t?.name ?? '?'}」数据不完整` }, 400);

  const db = c.env.DB;
  await db.batch([
    db.prepare('DELETE FROM item_type'),
    ...types.map(t => db.prepare(
      'INSERT INTO item_type (id, name, icon, allow_dup, fields) VALUES (?,?,?,?,?)'
    ).bind(t.id, t.name, t.icon || '📦', t.allow_dup ? 1 : 0, JSON.stringify(t.fields))),
  ]);
  return c.json({ ok: true });
});

/* ---------- 条目：单条增删改（A2，常规保存走这里） ---------- */
async function validateItem(db: D1Database, it: Record<string, any> | null) {
  if (!it) return '数据格式错误';
  if (!it.title) return '条目缺少标题';
  const type = await db.prepare('SELECT id FROM item_type WHERE id = ?').bind(it.type_id).first();
  if (!type) return `条目「${it.title}」的类型无效`;
  if (!!it.secret_iv !== !!it.secret_ct) return `条目「${it.title}」加密数据不完整`;
  return null;
}

auth.post('/items', async c => {
  const it = await c.req.json().catch(() => null);
  const err = await validateItem(c.env.DB, it);
  if (err) return c.json({ error: err }, 400);
  const exists = await c.env.DB.prepare('SELECT id FROM item WHERE id = ?').bind(it.id).first();
  if (exists) return c.json({ error: '条目 id 已存在' }, 409);
  await c.env.DB.prepare(
    'INSERT INTO item (id, type_id, title, plain, secret_iv, secret_ct, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(it.id, it.type_id, it.title, JSON.stringify(it.plain || {}),
    it.secret_iv || null, it.secret_ct || null, it.created_at || Date.now(), it.updated_at || Date.now()).run();
  return c.json({ ok: true });
});

auth.put('/items/:id', async c => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: '条目 id 不合法' }, 400);
  const it = await c.req.json().catch(() => null);
  const err = await validateItem(c.env.DB, it);
  if (err) return c.json({ error: err }, 400);

  const cur = await c.env.DB.prepare('SELECT id, updated_at FROM item WHERE id = ?').bind(id)
    .first<{ id: number; updated_at: number }>();
  if (!cur) return c.json({ error: '条目不存在' }, 404);
  /* 乐观冲突检测：客户端带上读取时的 updated_at，别处改过就拒绝，避免静默覆盖 */
  if (it.base_updated_at != null && Number(it.base_updated_at) !== Number(cur.updated_at))
    return c.json({ error: '该条目已在别处被修改，请刷新后重试' }, 409);

  await c.env.DB.prepare(
    'UPDATE item SET type_id=?, title=?, plain=?, secret_iv=?, secret_ct=?, updated_at=? WHERE id=?'
  ).bind(it.type_id, it.title, JSON.stringify(it.plain || {}),
    it.secret_iv || null, it.secret_ct || null, it.updated_at || Date.now(), id).run();
  return c.json({ ok: true });
});

auth.delete('/items/:id', async c => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: '条目 id 不合法' }, 400);
  const cur = await c.env.DB.prepare('SELECT id FROM item WHERE id = ?').bind(id).first();
  if (!cur) return c.json({ error: '条目不存在' }, 404);
  await c.env.DB.prepare('DELETE FROM item WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

/* ---- 条目：读 + 整表替换（仅备份恢复 / 旧数据迁移使用） ---- */
auth.get('/items', async c => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM item ORDER BY updated_at DESC'
  ).all<Record<string, any>>();
  return c.json(results.map(r => ({
    id: r.id, type_id: r.type_id, title: r.title,
    plain: r.plain ? JSON.parse(r.plain) : {},
    secret_iv: r.secret_iv, secret_ct: r.secret_ct,
    created_at: r.created_at, updated_at: r.updated_at,
  })));
});

auth.put('/items', async c => {
  const items = await c.req.json().catch(() => null);
  if (!Array.isArray(items)) return c.json({ error: '数据格式错误' }, 400);

  const typeIds = new Set(
    (await c.env.DB.prepare('SELECT id FROM item_type').all<{ id: number }>()).results.map(r => r.id)
  );
  for (const it of items) {
    if (!it?.title || !typeIds.has(it.type_id))
      return c.json({ error: `条目「${it?.title ?? '?'}」的类型无效` }, 400);
    if (!!it.secret_iv !== !!it.secret_ct)
      return c.json({ error: `条目「${it.title}」加密数据不完整` }, 400);
  }

  const db = c.env.DB;
  await db.batch([
    db.prepare('DELETE FROM item'),
    ...items.map(it => db.prepare(
      'INSERT INTO item (id, type_id, title, plain, secret_iv, secret_ct, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(it.id, it.type_id, it.title, JSON.stringify(it.plain || {}),
      it.secret_iv || null, it.secret_ct || null, it.created_at || Date.now(), it.updated_at || Date.now())),
  ]);
  return c.json({ ok: true });
});

app.route('/api', auth);

/* ---------------- 其余路径 → 静态文件 ---------------- */
app.all('*', c => c.env.ASSETS.fetch(c.req.raw));

export default app;
