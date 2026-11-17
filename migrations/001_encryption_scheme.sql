-- ============================================================
-- 旧库升级：加密方案字段（只跑一次；已经是新 schema 的库不要重复执行）
--   scheme   : 1 = 旧方案（主密码上送服务器校验），2 = 新方案
--   enc_salt : 新方案的条目加密盐（hex）
-- 迁移后旧用户仍是 scheme=1，首次用新前端登录时会自动原子升级
-- ============================================================
ALTER TABLE user ADD COLUMN scheme INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user ADD COLUMN enc_salt TEXT;
