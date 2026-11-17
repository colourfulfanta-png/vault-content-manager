ALTER TABLE user ADD COLUMN email TEXT;            -- 密保邮箱（可选，仅用于账号标识/提醒）
ALTER TABLE user ADD COLUMN recovery_blob TEXT;     -- 恢复码包裹的 encKey（JSON: {iv, ct}，服务器无法解开）
ALTER TABLE user ADD COLUMN recovery_verifier TEXT; -- SHA-256(encKey) hex，用于校验恢复码是否正确
ALTER TABLE user ADD COLUMN recovery_set_at INTEGER;
