/* ============================================================
   共享加密工具（登录页 / 主界面共用，必须最先加载）

   新方案（scheme=2）：
     authKey = PBKDF2(主密码, auth 盐(hex 字符串), iterations)
     verifier = SHA-256(authKey)            → 只有 verifier 上送服务器
     encKey   = PBKDF2(主密码, enc 盐(hex 字符串), iterations) → AES-256-GCM，只留在浏览器
   服务器保存 verifier / 两个盐 / 条目密文，不接触主密码

   旧方案（scheme=1）兼容：
     · 服务器校验值 = PBKDF2(主密码, 盐的原始字节, N) 的 hex
     · 条目加密密钥 = PBKDF2(主密码, 盐的 hex 字符串, N)（旧前端做法）
   首次登录时由 login.js 用旧密钥解密、新密钥重加密后原子升级
============================================================ */
const VaultCrypto = {
  KDF_ITERATIONS: 310000,

  _enc: s => new TextEncoder().encode(s),
  _dec: b => new TextDecoder().decode(b),
  b64: u8 => btoa(String.fromCharCode(...u8)),
  unb64: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
  hex: u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join(''),
  unhex: h => new Uint8Array((h.match(/.{2}/g) || []).map(x => parseInt(x, 16))),

  randomHex(bytes) {
    return this.hex(crypto.getRandomValues(new Uint8Array(bytes)));
  },

  /* ---------- 恢复码（方案 C：服务器拿不到可解密材料） ---------- */
  RECOVERY_LABEL: 'vault-recovery-v1',

  normalizeRecovery(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  },

  /* 生成 24 位恢复码（去掉易混字符），按 4 位分组便于抄写 */
  generateRecoveryCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += alphabet[bytes[i] % alphabet.length];
    return s.match(/.{1,4}/g).join('-');
  },

  /* 恢复码 → KEK（与主密码、服务器盐都无关） */
  async recoveryKey(code) {
    const norm = this.normalizeRecovery(code);
    if (norm.length < 16) throw new Error('恢复码长度不对');
    return this.importAes(await this.pbkdf2Bits(norm, this.RECOVERY_LABEL, this.KDF_ITERATIONS));
  },

  /* 把 encKey（原始字节）用恢复码包裹成 blob；verifier 用于服务器校验恢复码是否正确 */
  async wrapEncKeyForRecovery(encKeyBits, code) {
    const kek = await this.recoveryKey(code);
    const blob = await this.encrypt(kek, this.b64(encKeyBits));
    return { blob, verifier: await this.sha256Hex(encKeyBits) };
  },

  async pbkdf2Bits(password, saltText, iterations) {
    const base = await crypto.subtle.importKey('raw', this._enc(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: this._enc(saltText), iterations, hash: 'SHA-256' }, base, 256);
    return new Uint8Array(bits);
  },

  async importAes(bits) {
    return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  },

  async sha256Hex(u8) {
    return this.hex(new Uint8Array(await crypto.subtle.digest('SHA-256', u8)));
  },

  /* 新方案：登录证明 */
  async verifier(master, authSaltHex, iterations) {
    const authKey = await this.pbkdf2Bits(master, authSaltHex, iterations);
    return this.sha256Hex(authKey);
  },

  /* 新方案：条目加密密钥 */
  async encKey(master, encSaltHex, iterations) {
    return this.importAes(await this.pbkdf2Bits(master, encSaltHex, iterations));
  },

  /* 旧方案：登录证明（盐按原始字节用） */
  async legacyProof(master, saltHex, iterations) {
    const base = await crypto.subtle.importKey('raw', this._enc(master), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: this.unhex(saltHex), iterations, hash: 'SHA-256' }, base, 256);
    return this.hex(new Uint8Array(bits));
  },

  /* 旧方案：条目加密密钥（盐按 hex 字符串用，与旧前端一致） */
  async legacyEncKey(master, saltHex, iterations) {
    return this.importAes(await this.pbkdf2Bits(master, saltHex, iterations));
  },

  async encrypt(key, plain) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, this._enc(plain));
    return { iv: this.b64(iv), ct: this.b64(new Uint8Array(ct)) };
  },

  async decrypt(key, ivB64, ctB64) {
    return this._dec(new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this.unb64(ivB64) }, key, this.unb64(ctB64))));
  },
};
