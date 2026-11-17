CREATE TABLE IF NOT EXISTS user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,      -- scheme=2: SHA-256(authKey) hex；scheme=1: 旧 PBKDF2 哈希（hex）
  salt TEXT NOT NULL,               -- scheme=2: auth 盐 hex；scheme=1: 旧 PBKDF2 盐 hex
  kdf_iterations INTEGER NOT NULL DEFAULT 310000,
  scheme INTEGER NOT NULL DEFAULT 2, -- 2=新方案（服务器不接触主密码）；1=旧方案，首次登录自动升级
  enc_salt TEXT,                     -- scheme=2: 条目加密盐 hex
  email TEXT,                        -- 密保邮箱（可选）
  recovery_blob TEXT,                -- 恢复码包裹的 encKey（JSON: {iv,ct}；服务器无法解开）
  recovery_verifier TEXT,            -- SHA-256(encKey) hex：校验恢复码是否正确
  recovery_set_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_type (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  allow_dup INTEGER DEFAULT 0,
  fields TEXT NOT NULL,             -- 字段定义 JSON
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS item (
  id INTEGER PRIMARY KEY,
  type_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  plain TEXT,                       -- 明文字段 JSON
  secret_iv TEXT,                   -- 加密字段 IV (base64)
  secret_ct TEXT,                   -- 加密字段密文，服务器不可读
  created_at INTEGER,
  updated_at INTEGER
);
