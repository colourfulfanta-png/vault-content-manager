/* ===== 登录 / 注册（智能判断，纯前端） / 恢复码找回 / 旧方案自动升级 ===== */
const $ = id => document.getElementById(id);
const tip = msg => { $('tip').textContent = msg; };
const rtip = msg => { $('rTip').textContent = msg; };
const b64u8 = u8 => VaultCrypto.b64(u8);

let pendingLogin = null;
let afterCode = null;

/* ---------- 品牌（localStorage，与背景/主题一致） ---------- */
function applyBrand(){
  try{
    const b = JSON.parse(localStorage.getItem('vault_brand') || '{}') || {};
    const icon = (typeof b.icon === 'string' && b.icon.trim()) ? b.icon.trim() : '🔐';
    const title = (typeof b.title === 'string' && b.title.trim()) ? b.title.trim() : 'Vault';
    const sub = (typeof b.subtitle === 'string' && b.subtitle.trim()) ? b.subtitle.trim() : '个人密码与资产保管库';
    if($('brandTitle')) $('brandTitle').textContent = icon + ' ' + title;
    if($('brandSub')) $('brandSub').textContent = sub;
  }catch{}
}
applyBrand();

/* ---------- 登录 / 创建 模式（纯前端智能判断，不动后端） ---------- */
function setCreateMode(on, silent){
  if($('regMode')) $('regMode').checked = !!on;
  if($('confirmWrap')) $('confirmWrap').hidden = !on;
  if(!silent) tip(on ? '创建新账号模式：请再输入一次确认主密码' : '登录模式：输入主密码即可登录');
}
let detectTimer = null;
async function detectAccount(){
  const u = $('user').value.trim();
  if(!u) return;
  clearTimeout(detectTimer);
  detectTimer = setTimeout(async () => {
    if($('user').value.trim() !== u) return;
    try{
      const ch = await challenge(u);
      if($('user').value.trim() !== u) return;
      /* 只在提示区没有报错/显式提示时才覆盖，避免把"密码错误""两次不一致"等覆盖掉 */
      const softTip = msg => {
        const cur = ($('tip').textContent || '').trim();
        if(!cur || /检测到账号|用户名不存在|输入用户名和主密码登录/.test(cur)) $('tip').textContent = msg;
      };
      if(ch.status === 200){ setCreateMode(false, true); softTip('检测到账号，直接登录即可'); }
      else if(ch.status === 404){ setCreateMode(true, true); softTip('该用户名不存在，已切换为创建账号模式'); }
    }catch{}
  }, 600);
}
if($('user')){
  $('user').addEventListener('input', detectAccount);
  $('user').addEventListener('blur', detectAccount);
}
if($('regMode')) $('regMode').addEventListener('change', () => setCreateMode($('regMode').checked));

/* ---------- 网络 ---------- */
async function challenge(username) {
  const r = await fetch('/api/auth/challenge', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function register(username, master, code) {
  const iterations = VaultCrypto.KDF_ITERATIONS;
  const auth_salt = VaultCrypto.randomHex(16);
  const enc_salt = VaultCrypto.randomHex(16);
  const verifier = await VaultCrypto.verifier(master, auth_salt, iterations);
  const encBits = await VaultCrypto.pbkdf2Bits(master, enc_salt, iterations);
  const rec = await VaultCrypto.wrapEncKeyForRecovery(encBits, code);
  const r = await fetch('/api/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username, verifier, auth_salt, enc_salt, iterations,
      recovery_blob: rec.blob, recovery_verifier: rec.verifier,
    }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function loginProof(username, master, ch) {
  const proof = ch.scheme === 2
    ? await VaultCrypto.verifier(master, ch.salt, ch.iterations)
    : await VaultCrypto.legacyProof(master, ch.salt, ch.iterations);
  const r = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, proof }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/* 旧方案（scheme=1）→ 新方案；顺带生成恢复码 */
async function upgrade(master, token, legacySalt, legacyIterations) {
  tip('检测到旧版账号，正在升级加密方案（请勿关闭页面）…');
  const oldKey = await VaultCrypto.legacyEncKey(master, legacySalt, legacyIterations);
  const itemsRes = await fetch('/api/items', { headers: { authorization: 'Bearer ' + token } });
  if (!itemsRes.ok) throw new Error('读取条目失败：' + itemsRes.status);
  const items = await itemsRes.json();

  const iterations = VaultCrypto.KDF_ITERATIONS;
  const auth_salt = VaultCrypto.randomHex(16);
  const enc_salt = VaultCrypto.randomHex(16);
  const newBits = await VaultCrypto.pbkdf2Bits(master, enc_salt, iterations);
  const newKey = await VaultCrypto.importAes(newBits);
  const verifier = await VaultCrypto.verifier(master, auth_salt, iterations);

  for (const it of items) {
    if (!it.secret_ct) continue;
    const obj = JSON.parse(await VaultCrypto.decrypt(oldKey, it.secret_iv, it.secret_ct));
    const enc = await VaultCrypto.encrypt(newKey, JSON.stringify(obj));
    it.secret_iv = enc.iv;
    it.secret_ct = enc.ct;
  }

  const r = await fetch('/api/auth/upgrade', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ verifier, auth_salt, enc_salt, iterations, items }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || '升级失败');

  let code = null;
  try {
    code = VaultCrypto.generateRecoveryCode();
    const rec = await VaultCrypto.wrapEncKeyForRecovery(newBits, code);
    await fetch('/api/auth/recovery-setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ proof: verifier, recovery_blob: rec.blob, recovery_verifier: rec.verifier }),
    });
  } catch (e) { console.warn('生成恢复码失败', e); code = null; }

  return { auth_salt, enc_salt, iterations, code };
}

/* ---------- 恢复码展示 ---------- */
function showCode(code, note) {
  $('newCode').textContent = code;
  $('codeNote').textContent = note || '';
  $('codeSaved').checked = false;
  $('codeContinue').disabled = true;
  $('loginForm').hidden = true;
  $('recoverPanel').hidden = true;
  $('codePanel').hidden = false;
}

$('codeSaved').onchange = () => { $('codeContinue').disabled = !$('codeSaved').checked; };

$('codeCopy').onclick = async () => {
  const text = $('newCode').textContent;
  try {
    await navigator.clipboard.writeText(text);
    $('codeCopy').textContent = '已复制';
    setTimeout(() => { $('codeCopy').textContent = '复制'; }, 1500);
  } catch {
    $('codeCopy').textContent = '请手动抄写';
  }
};

$('codeDownload').onclick = () => {
  const text = [
    'Vault 恢复码',
    '用户名：' + ($('user').value.trim() || '(未填写)'),
    '恢复码：' + $('newCode').textContent,
    '生成时间：' + new Date().toLocaleString(),
    '',
    '忘记主密码时，在登录页点「忘记主密码？用恢复码找回」，输入该恢复码即可重设主密码。',
  ].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = 'vault-recovery-code.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

$('codeContinue').onclick = () => {
  $('codePanel').hidden = true;
  $('loginForm').hidden = false;
  if (afterCode === 'login' && pendingLogin) {
    const { u, p } = pendingLogin;
    pendingLogin = null;
    afterCode = null;
    tip('验证中…');
    challenge(u).then(ch => {
      if (ch.status !== 200) return tip('自动登录失败，请手动登录');
      return runLogin(u, p, ch.body);
    }).catch(e => tip('失败：' + (e.message || e)));
  } else if (afterCode === 'enter') {
    location.href = 'index.html';
  } else {
    afterCode = null;
  }
};

/* ---------- 登录主流程 ---------- */
async function runLogin(u, p, ch) {
  const lg = await loginProof(u, p, ch);
  if (lg.status !== 200) { tip(lg.body.error || '用户名或主密码错误'); return; }

  const { token, scheme, salt, enc_salt, iterations } = lg.body;
  let sessionSalt = salt, sessionEncSalt = enc_salt, sessionIter = iterations, code = null;

  if (scheme === 1) {
    const up = await upgrade(p, token, salt, iterations);
    sessionSalt = up.auth_salt;
    sessionEncSalt = up.enc_salt;
    sessionIter = up.iterations;
    code = up.code;
  }

  sessionStorage.setItem('vault_user', u);
  sessionStorage.setItem('vault_token', token);
  sessionStorage.setItem('vault_salt', sessionSalt);
  sessionStorage.setItem('vault_enc_salt', sessionEncSalt);
  sessionStorage.setItem('vault_iterations', String(sessionIter));
  sessionStorage.setItem('vault_scheme', '2');
  sessionStorage.setItem('vault_master', p);

  if (code) {
    afterCode = 'enter';
    showCode(code, '旧版账号已升级。这是你的恢复码（只显示这一次），忘记主密码时用它找回数据，请保存好。');
    return;
  }
  location.href = 'index.html';
}

/* ---------- 登录 / 注册提交 ---------- */
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const u = $('user').value.trim();
  const p = $('pass').value;
  const p2 = $('pass2').value;
  const createMode = $('regMode').checked;
  if (!u || !p) return tip('请输入用户名和主密码');
  if (p.length < 6) return tip('主密码至少 6 位');
  if (createMode && p2 !== p) return tip('两次输入的主密码不一致，请重新输入确认');
  tip('验证中…');

  try {
    const ch = await challenge(u);

    if (ch.status === 404) {
      if (!createMode) {
        setCreateMode(true);
        tip('该用户名不存在，已切换为创建账号模式，请再输入一次主密码确认');
        $('pass2').focus();
        return;
      }
      tip('正在创建账户…');
      const code = VaultCrypto.generateRecoveryCode();
      const reg = await register(u, p, code);
      if (reg.status === 403) return tip(reg.body.error || '注册已关闭');
      if (reg.status !== 200) return tip(reg.body.error || '注册失败');
      pendingLogin = { u, p };
      afterCode = 'login';
      showCode(code, '这是你的「恢复码」，只显示这一次：忘记主密码时用它找回数据。请抄写或下载保存好（丢失将无法找回）。');
      return;
    }

    if (ch.status === 200) {
      if (createMode) {
        setCreateMode(false);
        tip('该用户名已存在，注册已关闭；已切换为登录模式，请再点一次「解锁」');
        return;
      }
      await runLogin(u, p, ch.body);
      return;
    }

    tip(ch.body.error || '用户名或主密码错误');
  } catch (err) {
    tip('失败：' + (err.message || err));
  }
});

/* ---------- 忘记主密码：恢复码找回 ---------- */
$('forgotLink').onclick = e => {
  e.preventDefault();
  $('loginForm').hidden = true;
  $('codePanel').hidden = true;
  $('recoverPanel').hidden = false;
  rtip('');
};

$('rBack').onclick = e => {
  e.preventDefault();
  $('recoverPanel').hidden = true;
  $('loginForm').hidden = false;
};

$('rSubmit').onclick = async () => {
  const u = $('rUser').value.trim();
  const code = $('rCode').value.trim();
  const np = $('rPass').value;
  const np2 = $('rPass2').value;
  if (!u || !code || !np) return rtip('请填写用户名、恢复码和新主密码');
  if (np.length < 6) return rtip('新主密码至少 6 位');
  if (np !== np2) return rtip('两次输入的新主密码不一致');
  rtip('验证恢复码…');

  try {
    const chRes = await fetch('/api/auth/recover/challenge', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u }),
    });
    const chb = await chRes.json().catch(() => ({}));
    if (!chRes.ok) return rtip(chb.error || '无法找回');

    let encB64;
    try {
      const rk = await VaultCrypto.recoveryKey(code);
      encB64 = await VaultCrypto.decrypt(rk, chb.blob.iv, chb.blob.ct);
    } catch { return rtip('恢复码不正确'); }

    const encBitsOld = VaultCrypto.unb64(encB64);
    const proof = await VaultCrypto.sha256Hex(encBitsOld);
    const vr = await fetch('/api/auth/recover/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, verifier: proof }),
    });
    const vrb = await vr.json().catch(() => ({}));
    if (!vr.ok) return rtip(vrb.error || '恢复码不正确');

    const token = vrb.token;
    const H = { authorization: 'Bearer ' + token };
    rtip('正在读取数据…');
    const [typesRes, itemsRes] = await Promise.all([
      fetch('/api/types', { headers: H }),
      fetch('/api/items', { headers: H }),
    ]);
    if (!typesRes.ok || !itemsRes.ok) throw new Error('读取数据失败');
    const items = await itemsRes.json();

    rtip('正在用新主密码重新加密数据…');
    const oldKey = await VaultCrypto.importAes(encBitsOld);
    const iterations = VaultCrypto.KDF_ITERATIONS;
    const auth_salt = VaultCrypto.randomHex(16);
    const enc_salt = VaultCrypto.randomHex(16);
    const newBits = await VaultCrypto.pbkdf2Bits(np, enc_salt, iterations);
    const newKey = await VaultCrypto.importAes(newBits);

    for (const it of items) {
      if (!it.secret_ct) continue;
      let obj;
      try { obj = JSON.parse(await VaultCrypto.decrypt(oldKey, it.secret_iv, it.secret_ct)); }
      catch { throw new Error('有数据无法解密，已中止（数据库未被修改）'); }
      const enc = await VaultCrypto.encrypt(newKey, JSON.stringify(obj));
      it.secret_iv = enc.iv;
      it.secret_ct = enc.ct;
    }

    const verifier = await VaultCrypto.verifier(np, auth_salt, iterations);
    const newCode = VaultCrypto.generateRecoveryCode();
    const rec = await VaultCrypto.wrapEncKeyForRecovery(newBits, newCode);

    const reset = await fetch('/api/auth/recover/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({
        verifier, auth_salt, enc_salt, iterations, items,
        recovery_blob: rec.blob, recovery_verifier: rec.verifier,
      }),
    });
    const rb = await reset.json().catch(() => ({}));
    if (!reset.ok) throw new Error(rb.error || '重置失败');

    $('rUser').value = ''; $('rCode').value = ''; $('rPass').value = ''; $('rPass2').value = '';
    afterCode = 'none';
    $('recoverPanel').hidden = true;
    $('loginForm').hidden = true;
    showCode(newCode, '主密码已重置，数据已用新主密码重新加密。这是你的新恢复码（旧恢复码已作废），请保存。');
  } catch (err) {
    rtip('失败：' + (err.message || err));
  }
};