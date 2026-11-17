/* ============================================================
   数据层为 localStorage Mock，接口形状与未来 REST API 一致。
   加密字段：主密码派生 AES-256-GCM，服务端只接触密文。
============================================================ */
const $ = id => document.getElementById(id);
const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

/* ============ 全局兜底：关闭 / 取消 / 点遮罩 / ESC ============
   · 放在脚本最前面用事件委托绑定：即使后面某个按钮因“浏览器缓存了旧页面、缺少元素”而抛错，
     “关闭/取消/后退”这类操作也不会跟着一起失效
   · 同时捕获脚本错误并提示强刷，避免用户卡死在弹窗里 */
const BUILD = '2026-11-18-fix3';
console.info('[Vault] 前端版本 ' + BUILD);

window.addEventListener('error', e => {
  console.error('页面脚本错误：', e.message);
  if(document.getElementById('vault-error-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'vault-error-bar';
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#b3261e;color:#fff;padding:10px 14px;font-size:13px;text-align:center;';
  bar.textContent = '页面脚本加载不完整（很可能缓存了旧页面）：请按 Ctrl+F5 强制刷新；若仍不行，重启 npx wrangler dev。';
  document.body.appendChild(bar);
});

document.addEventListener('click', e => {
  const t = e.target;
  if(!t || !t.closest) return;
  if(t.classList && t.classList.contains('modal-mask')){ closeModals(); return; }
  if(t.closest('[data-close]')) closeModals();
});
document.addEventListener('keydown', e => { if(e.key === 'Escape') closeModals(); });

/* ================= 1. 加密模块（实现见 crypto.js） ================= */
/* 主界面只用到：新方案的条目密钥加密/解密 + 旧 Mock 数据迁移时的旧密钥派生 */
const Crypto = {
  deriveKey: (master, salt) => VaultCrypto.legacyEncKey(master, salt, 100000),  /* 仅旧数据迁移 */
  encrypt: (key, plain) => VaultCrypto.encrypt(key, plain),
  decrypt: (key, iv, ct) => VaultCrypto.decrypt(key, iv, ct),
};

/* ================= 2. 默认类型 ================= */
const DEFAULT_TYPES = [
  { id:1, name:'密码', icon:'🔑', allow_dup:false, fields:[
    { uid:'u1', label:'网址',   kind:'url',  secret:false, allow_empty:true },
    { uid:'u2', label:'用户名', kind:'text', secret:false, allow_empty:false },
    { uid:'u3', label:'密码',   kind:'text', secret:true,  allow_empty:false },
  ]},
  { id:2, name:'域名', icon:'🌐', allow_dup:false, fields:[
    { uid:'u1', label:'注册商',    kind:'text', secret:false, allow_empty:true },
    { uid:'u2', label:'到期日期',  kind:'text', secret:false, allow_empty:true },
    { uid:'u3', label:'DNS服务商', kind:'enum', secret:false, allow_empty:false,
      options:['Cloudflare','阿里云','DNSPod','GoDaddy'] },
    { uid:'u4', label:'二级域名（每行一个）', kind:'textarea', secret:false, allow_empty:true },
  ]},
  { id:3, name:'服务器', icon:'🖥️', allow_dup:false, fields:[
    { uid:'u1', label:'IP 地址',  kind:'text',   secret:false, allow_empty:false },
    { uid:'u2', label:'SSH 端口', kind:'number', secret:false, allow_empty:false },
    { uid:'u3', label:'用户名',   kind:'text',   secret:false, allow_empty:false },
    { uid:'u4', label:'密码',     kind:'text',   secret:true,  allow_empty:false },
    { uid:'u5', label:'备注',     kind:'textarea', secret:false, allow_empty:true },
  ]},
  { id:4, name:'笔记', icon:'📝', allow_dup:true, fields:[
    { uid:'u1', label:'内容', kind:'textarea', secret:false, allow_empty:false },
  ]},
];
/* ================= 3. 数据层（REST API 版） ================= */
let TYPES = [], ITEMS = [];
let LOAD_FAILED = false;
let ME = null;   /* /api/auth/me：用户名、密保邮箱、是否已生成恢复码 */   /* 启动时读取服务器数据失败：界面要明确提示，禁止误操作覆盖 */

const api = {
  async req(path, opts = {}){
    const r = await fetch('/api' + path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + sessionStorage.getItem('vault_token'),
      },
    });
    if(r.status === 401){ sessionStorage.clear(); location.href = 'login.html'; throw new Error('未登录'); }
    const body = await r.json().catch(() => ({}));
    if(!r.ok){
      const err = new Error(body.error || '请求失败');
      err.status = r.status;
      throw err;
    }
    return body;
  },
  getTypes(){ return this.req('/types') },
  putTypes(t){ return this.req('/types', { method:'PUT', body: JSON.stringify(t) }) },
  getItems(){ return this.req('/items') },
  /* 条目单条增删改（A2）：避免“整表替换”在多标签页/并发时互相覆盖 */
  createItem(it){ return this.req('/items', { method:'POST', body: JSON.stringify(it) }) },
  updateItem(id, it){ return this.req('/items/' + id, { method:'PUT', body: JSON.stringify(it) }) },
  deleteItem(id){ return this.req('/items/' + id, { method:'DELETE' }) },
  /* 仅备份恢复 / 旧数据迁移使用：会整表替换 */
  replaceItems(list){ return this.req('/items', { method:'PUT', body: JSON.stringify(list) }) },
};

/* 读走内存缓存（同步，UI 层无需改动），写时更新缓存并异步推给服务端。
   失败时回滚缓存并提示，避免界面显示“已保存”但其实没落库 */
const DB = {
  types(){ return TYPES },
  saveTypes(t){
    const prev = TYPES; TYPES = t;
    return api.putTypes(t).then(() => true).catch(e => {
      TYPES = prev;
      alert('保存类型失败：' + e.message + '\n已回滚到上次成功保存的状态，请重试。');
      renderAll();
      return false;
    });
  },
  items(){ return ITEMS },

  async createItem(it){
    const prev = ITEMS;
    ITEMS = [...ITEMS, it];
    try{ await api.createItem(it); return true; }
    catch(e){
      ITEMS = prev;
      alert('保存失败：' + e.message + '\n已回滚，请重试。');
      renderGrid();
      return false;
    }
  },
  async updateItem(it){
    const prev = ITEMS;
    ITEMS = ITEMS.map(x => x.id === it.id ? it : x);
    try{ await api.updateItem(it.id, it); return true; }
    catch(e){
      ITEMS = prev;
      if(e.status === 409){
        alert('该条目已在别处被修改，界面已刷新为最新数据，请重新编辑。');
        try{ ITEMS = await api.getItems(); }catch{}
        closeModals(); renderGrid();
      }else{
        alert('保存失败：' + e.message + '\n已回滚，请重试。');
        renderGrid();
      }
      return false;
    }
  },
  async deleteItem(id){
    const prev = ITEMS;
    ITEMS = ITEMS.filter(x => x.id !== id);
    try{ await api.deleteItem(id); return true; }
    catch(e){
      ITEMS = prev;
      alert('删除失败：' + e.message);
      renderGrid();
      return false;
    }
  },
  /* 备份恢复 / 旧数据迁移用：整表替换 */
  async replaceItems(list){
    const prev = ITEMS;
    ITEMS = list;
    try{ await api.replaceItems(list); return true; }
    catch(e){
      ITEMS = prev;
      alert('写入失败：' + e.message);
      renderGrid();
      return false;
    }
  },
};

/* 条目/类型 id 必须唯一：Date.now() 同毫秒两次会撞主键，导致整批保存失败 */
let __idSeq = 0;
const newId = () => Date.now() * 1000 + (__idSeq++ % 1000);

/* ================= 4. 会话启动（REST API 版） ================= */
let KEY = null, USER = null;
(async function boot(){
  USER = sessionStorage.getItem('vault_user');
  const master = sessionStorage.getItem('vault_master');
  const encSalt = sessionStorage.getItem('vault_enc_salt');
  const iter = Number(sessionStorage.getItem('vault_iterations')) || 0;
  const scheme = Number(sessionStorage.getItem('vault_scheme'));

  /* 旧会话（升级前登录的）没有新方案参数：清掉会话回登录页，用新流程重新登录 */
  if(!USER || !master || !encSalt || scheme !== 2 || !iter){
    sessionStorage.clear();
    location.href = 'login.html';
    return;
  }

  KEY = await VaultCrypto.encKey(master, encSalt, iter);   /* 条目加密密钥只在浏览器内派生 */

  /* 每一步分开兜底：任何一步失败都不能让整个界面变空白 */
  let typesOk = false, itemsOk = false;
  try{ TYPES = await api.getTypes(); typesOk = true; }catch(e){ console.error('读取类型失败', e); }
  try{ ITEMS = await api.getItems(); itemsOk = true; }catch(e){ console.error('读取条目失败', e); }

  if(!typesOk || !itemsOk){
    /* 读取失败 ≠ 服务器为空：绝不能按“空库”处理，否则会用默认值覆盖服务器数据 */
    LOAD_FAILED = true;
    alert('读取服务器数据失败（' + (!typesOk && !itemsOk ? '类型和条目' : !typesOk ? '类型' : '条目') +
      '）。\n当前界面可能显示为空，请刷新页面重试；本次不会写入任何数据。');
  } else {
    /* 一次性迁移：同源 localStorage 里的旧 Mock 数据 */
    try{ await migrateMockData(master); }
    catch(e){ console.warn('旧数据迁移失败（本地数据已保留，不影响使用）', e); }

    /* 空库初始化：确认“成功读到且确实为空”时才写入默认类型 */
    if(!TYPES.length){
      TYPES = JSON.parse(JSON.stringify(DEFAULT_TYPES));
      try{ await api.putTypes(TYPES); }
      catch(e){
        console.error('写入默认类型失败', e);
        alert('默认类型写入失败：' + (e.message || e) + '\n界面可以先看，但新建条目可能保存不了。');
      }
    }
  }

  /* 顶栏搜索框防浏览器自动填充：进入页面时清空（配合 HTML 上的 readonly） */
  const sb = $('searchBox');
  if(sb) sb.value = '';
  applyBrand();

  renderAll();

  /* 账号安全状态（邮箱 / 恢复码） */
  try{ ME = await api.req('/auth/me'); }catch(e){ console.warn('读取账号信息失败', e); }
  if(ME && !ME.has_recovery && !sessionStorage.getItem('secPrompted')){
    sessionStorage.setItem('secPrompted', '1');
    alert('提醒：你还没有生成恢复码。\n忘记主密码时将无法找回数据，建议到右上角「🛡️ 账号安全」立即生成并保存。');
  }
})();

/* 旧 Mock 数据迁移：
   · 只处理“服务器对应表确实为空”的情况，且只有上传成功后才删本地
   · 失败时保留 localStorage，绝不静默丢弃 */
async function migrateMockData(master){
  const rawTypes = localStorage.getItem('vault_types');
  const rawItems = localStorage.getItem('vault_items');

  if(rawTypes && !TYPES.length){
    try{
      const localTypes = JSON.parse(rawTypes);
      if(Array.isArray(localTypes) && localTypes.length){
        TYPES = localTypes;
        await api.putTypes(TYPES);
        localStorage.removeItem('vault_types');
      }
    }catch(e){ console.warn('旧类型迁移失败，本地数据保留：', e); }
  }

  if(rawItems && !ITEMS.length){
    try{
      const localItems = JSON.parse(rawItems);
      if(Array.isArray(localItems) && localItems.length){
        /* 旧条目用旧盐加密，需先解密再用服务端盐重加密 */
        const oldKey = await Crypto.deriveKey(master, 'vault-salt::' + USER);
        for(const it of localItems){
          if(!it.secret_ct) continue;
          try{
            const obj = JSON.parse(await Crypto.decrypt(oldKey, it.secret_iv, it.secret_ct));
            ({ iv: it.secret_iv, ct: it.secret_ct } = await Crypto.encrypt(KEY, JSON.stringify(obj)));
          }catch(e){
            console.warn('旧条目无法解密，已跳过密文部分：', it.title);
            it.secret_iv = it.secret_ct = null;
          }
        }
        ITEMS = localItems;
        await api.replaceItems(ITEMS);
        localStorage.removeItem('vault_items');
      }
    }catch(e){ console.warn('旧条目迁移失败，本地数据保留：', e); }
  }
}

/* ================= 5. 列表渲染 ================= */
let curFilter = '', curQuery = '';

function renderAll(){ renderTypeFilter(); renderGrid(); }

function renderTypeFilter(){
  const ts = DB.types();
  /* 当前筛选的类型可能已被删除：必须一并重置，否则列表会被错误过滤成空 */
  if(curFilter && !ts.some(t => String(t.id) === curFilter)) curFilter = '';
  $('typeFilter').innerHTML =
    `<option value="">全部类型</option>` +
    ts.map(t => `<option value="${t.id}">${esc(t.icon)} ${esc(t.name)}</option>`).join('');
  $('typeFilter').value = curFilter;
}

const isPinned = it => !!(it.plain && it.plain._pin);
function renderGrid(){
  const items = DB.items().filter(it => {
    if(curFilter && it.type_id !== +curFilter) return false;
    if(curQuery){
      const hay = (it.title + ' ' + JSON.stringify(it.plain || {})).toLowerCase();
      if(!hay.includes(curQuery.toLowerCase())) return false;
    }
    return true;
  }).sort((a, b) => ((isPinned(b) ? 1 : 0) - (isPinned(a) ? 1 : 0)) || (b.updated_at - a.updated_at));

  $('grid').innerHTML = items.map(it => {
    const t = DB.types().find(x => x.id === it.type_id) || { name:'?', icon:'❔', fields:[] };
    const first = t.fields.find(f => !f.secret && it.plain?.[f.uid] != null && it.plain[f.uid] !== '');
    const hasSec = !!(it.secret_ct && t.fields.some(f => f.secret));
    /* 锁图标放标题旁；预览只放明文字段 */
    return `<div class="item-card" onclick="showItem(${it.id})">
      <h4>${esc(t.icon)} ${esc(it.title)}${hasSec ? ' <span title="含加密字段">🔒</span>' : ''}<button class="btn btn-sm btn-icon pin-btn" title="${isPinned(it) ? '取消置顶' : '置顶'}" onclick="event.stopPropagation();togglePin(${it.id})">${isPinned(it) ? '📌' : '📍'}</button></h4>
      <div class="preview">${first ? esc(it.plain[first.uid]) : esc(t.name)}</div>
      <div class="preview muted">${esc(t.name)}</div>
    </div>`;
  }).join('');
  const noTypes = DB.types().length === 0;
  $('empty').textContent = LOAD_FAILED
    ? '读取服务器数据失败：请刷新页面重试（当前显示可能为空，请不要在此状态下新建或修改）'
    : noTypes
      ? '还没有任何类型：点右上角「类型管理」新建一个类型，再回来新建条目'
      : '暂无条目，点击右上角「＋ 新建条目」';
  $('empty').hidden = items.length > 0;
}

/* 置顶 / 取消置顶（存在 plain._pin，零迁移） */
async function togglePin(id){
  const it = DB.items().find(x => x.id === id);
  if(!it) return;
  const plain = { ...(it.plain || {}) };
  if(plain._pin) delete plain._pin; else plain._pin = true;
  const updated = { ...it, plain, updated_at: Date.now(), base_updated_at: it.updated_at };
  const ok = await DB.updateItem(updated);
  if(ok) renderGrid();
}

$('searchBox').oninput   = e => { curQuery = e.target.value; renderGrid(); };
/* bfcache / 浏览器表单恢复：重新进入页面时清空搜索框，避免把登录用户名带进来 */
window.addEventListener('pageshow', () => {
  const sb = $('searchBox');
  if(sb && sb.value){ sb.value = ''; curQuery = ''; renderGrid(); }
});
$('typeFilter').onchange = e => { curFilter = e.target.value; renderGrid(); };

/* ================= 6. 详情 ================= */
let curItem = null, curSecrets = null, curCopyValues = {};

async function showItem(id){
  const item = DB.items().find(x => x.id === id);
  if(!item){ return alert('条目不存在（可能已被其它标签页删除）'); }
  const t = DB.types().find(x => x.id === item.type_id);

  /* 解密失败要提示，不能静默不弹窗；解密完再落地全局状态，避免快速连点时串位 */
  let secrets = {};
  if(item.secret_ct){
    try{ secrets = JSON.parse(await Crypto.decrypt(KEY, item.secret_iv, item.secret_ct)); }
    catch(e){
      console.error('解密失败', e);
      alert('该条目的加密内容无法解密（主密码或盐不匹配），明文字段仍会显示。');
    }
  }
  curItem = item; curSecrets = secrets;

  $('dTitle').textContent = item.title;
  $('dType').textContent = t ? `${t.icon} ${t.name}` : '未知类型';

  $('dFields').innerHTML = (t?.fields || []).map(f => {
    const v = f.secret ? secrets[f.uid] : item.plain?.[f.uid];
    if(v == null || v === '') return '';
    curCopyValues[f.uid] = String(v);
    let inner;
    if(f.kind === 'url'){
      /* 只把 http(s) 渲染成链接，避免 javascript: 等伪协议被点击执行 */
      inner = /^https?:\/\//i.test(String(v))
        ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`
        : esc(v);
    }
    else if(f.kind === 'textarea')
      inner = `<span style="white-space:pre-wrap">${esc(v)}</span>`;
    else if(f.secret)
      inner = `<span class="secret-text" data-sec="${f.uid}">••••••••</span>
               <button class="btn btn-sm btn-icon" onclick="toggleSec('${f.uid}')">👁</button>`;
    else inner = esc(v);
    return `<div class="field-row"><span class="k">${esc(f.label)}</span><span class="v">${inner}<button class="btn btn-sm btn-icon copy-btn" title="复制" onclick="copyField('${f.uid}', this)">📋</button></span></div>`;
  }).join('') || '<div class="muted">无内容</div>';

  openModal('detailModal');
}

function toggleSec(uid){
  const el = document.querySelector(`[data-sec="${uid}"]`);
  el.textContent = el.textContent.startsWith('•') ? curSecrets[uid] : '••••••••';
}

/* ---------- 一键复制字段值（标题除外） ---------- */
function legacyCopy(text, done){
  try{
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  }catch(e){ alert('复制失败，请手动选择复制'); }
}
function copyField(uid, btn){
  const v = curCopyValues[uid];
  if(v == null || v === ''){ alert('没有可复制的内容'); return; }
  const done = () => {
    if(!btn) return;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '📋'; }, 1500);
  };
  if(navigator.clipboard && window.isSecureContext){
    navigator.clipboard.writeText(String(v)).then(done).catch(() => legacyCopy(String(v), done));
  }else{
    legacyCopy(String(v), done);
  }
}

$('dEdit').onclick = () => { closeModals(); openItemForm(curItem.type_id, curItem, curSecrets); };
$('dDel').onclick = async () => {
  if(!confirm(`确认删除「${curItem.title}」？`)) return;
  const ok = await DB.deleteItem(curItem.id);
  if(ok){ closeModals(); renderGrid(); }
};

/* ================= 7. 条目表单 ================= */
let editingId = null, curFormType = null, editingSecrets = {};
const KINDS = { text:'字符', textarea:'长文本', number:'数值', enum:'枚举', url:'网址' };
const isRequired = f => f.kind === 'enum' || f.allow_empty === false;

$('btnNew').onclick = () => {
  if(curFilter) return openItemForm(+curFilter, null, null);
  const ts = DB.types();
  $('pickList').innerHTML = ts.length
    ? ts.map(t =>
        `<button class="btn" onclick="closeModals();openItemForm(${t.id},null,null)">${esc(t.icon)} ${esc(t.name)}</button>`
      ).join('')
    : '<div class="muted">还没有任何类型 —— 请先到「类型管理」新建一个类型，然后再新建条目。</div>';
  openModal('pickModal');
};

function openItemForm(typeId, item, secretObj){
  editingId = item?.id ?? null;
  editingSecrets = secretObj ? JSON.parse(JSON.stringify(secretObj)) : {};
  curFormType = DB.types().find(x => x.id === typeId);
  if(!curFormType){
    alert('该类型已不存在，请重新选择类型');
    renderTypeFilter(); renderGrid();
    return;
  }
  $('iTitle').textContent = item ? '编辑条目' : `新建条目 · ${curFormType.name}`;
  const titleInput = $('iTitleInput');
  titleInput.value = item ? item.title : '';   /* 编辑时回填标题，避免用户每次都要重输 */
  titleInput.classList.remove('err');
  $('iFields').innerHTML = curFormType.fields.map(f =>
    `<label>${esc(f.label)}${isRequired(f) ? '<span class="req">*</span>' : ''}${f.secret ? ' 🔒' : ''}</label>${fieldInputHTML(f, item, secretObj)}`
  ).join('');
  openModal('itemModal');
}

/* 防自动填充核心：
   · 加密字段用 type=text + CSS 圆点（密码管理器不识别，不会硬填）
   · 所有文本框 readonly，focus 时解除（浏览器不填 readonly 字段） */
function fieldInputHTML(f, item, secretObj){
  /* 加密字段优先取已解密值；若该字段原本是明文（类型里刚改成加密），退回明文值以便迁移 */
  const v = f.secret
    ? (secretObj?.[f.uid] ?? item?.plain?.[f.uid] ?? '')
    : (item?.plain?.[f.uid] ?? '');
  const uid = `data-uid="${f.uid}" autocomplete="off" readonly onfocus="this.removeAttribute('readonly')"`;
  if(f.kind === 'enum'){
    const optsArr = Array.isArray(f.options) ? f.options : [];
    const opts = optsArr.map(o =>
      `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('');
    const extra = v && !optsArr.includes(v) ? `<option selected>${esc(v)}</option>` : '';
    const empty = optsArr.length ? '' : '<option value="">（该枚举类型没有可选项，请先在类型管理里补充）</option>';
    return `<select ${uid}>${empty}${extra}${opts}</select>`;
  }
  if(f.kind === 'textarea') return `<textarea ${uid}>${esc(v)}</textarea>`;
  if(f.kind === 'number')   return `<input ${uid} type="number" value="${esc(v)}">`;
  if(f.secret) return `<div class="row"><input ${uid} type="text" class="masked" name="fld_${f.uid}" value="${esc(v)}">
    <button type="button" class="btn btn-icon" onclick="peek(this)">👁</button></div>`;
  return `<input ${uid} name="fld_${f.uid}" value="${esc(v)}">`;
}
function peek(btn){
  btn.parentElement.querySelector('input.masked').classList.toggle('reveal');
}

/* 输入时清除错误标红 */
$('iFields').addEventListener('input', e => e.target.classList.remove('err'));

$('iSave').onclick = async () => {
  if(!curFormType){ return alert('类型信息丢失，请关闭弹窗重试'); }
  const title = $('iTitleInput').value.trim();
  if(!title){ $('iTitleInput').classList.add('err'); $('iTitleInput').focus(); return; }

  const plain = {}, secretObj = {}, missing = [];
  document.querySelectorAll('#iFields [data-uid]').forEach(el => {
    const f = curFormType.fields.find(x => x.uid === el.dataset.uid);
    if(!f) return;
    const v = f.kind === 'textarea' ? el.value : el.value.trim();
    if(isRequired(f) && v === ''){
      missing.push(f); el.classList.add('err');
      return;
    }
    if(v !== '') (f.secret ? secretObj : plain)[f.uid] = v;
  });

  if(missing.length)
    return alert('以下必填字段未填写：\n' +
      missing.map(f => `「${f.label}」（${KINDS[f.kind] || f.kind}）`).join('、'));

  if(curFormType.allow_dup !== true){
    const dup = DB.items().some(x =>
      x.type_id === curFormType.id && x.title === title && x.id !== editingId);
    if(dup){
      $('iTitleInput').classList.add('err');
      return alert(`此类型不允许重复标题：已存在「${title}」`);
    }
  }

  /* 编辑时：类型里已删除的字段，其旧值保留下来，不在保存时静默丢弃 */
  let finalPlain = plain, finalSecret = secretObj;
  if(editingId){
    const curUids = new Set(curFormType.fields.map(f => f.uid));
    const keptPlain = {};
    for(const [k, v] of Object.entries(DB.items().find(x => x.id === editingId)?.plain || {}))
      if(!curUids.has(k)) keptPlain[k] = v;
    finalPlain = Object.assign(keptPlain, plain);

    const keptSecret = {};
    for(const [k, v] of Object.entries(editingSecrets || {}))
      if(!curUids.has(k)) keptSecret[k] = v;
    finalSecret = Object.assign(keptSecret, secretObj);
  }

  $('iSave').disabled = true;
  try{
    let iv = null, ct = null;
    if(Object.keys(finalSecret).length)
      ({ iv, ct } = await Crypto.encrypt(KEY, JSON.stringify(finalSecret)));

    if(editingId){
      const base = DB.items().find(x => x.id === editingId);
      if(!base){ return alert('条目已不存在（可能被其它标签页删除）'); }
      const ok = await DB.updateItem({ ...base, title, plain: finalPlain,
        secret_iv:iv, secret_ct:ct, updated_at:Date.now(), base_updated_at: base.updated_at });
      if(ok){ closeModals(); renderGrid(); }
    }else{
      const item = { id:newId(), type_id:curFormType.id, title, plain: finalPlain,
                     secret_iv:iv, secret_ct:ct, created_at:Date.now(), updated_at:Date.now() };
      const ok = await DB.createItem(item);
      if(ok){ closeModals(); renderGrid(); }
    }
  } finally {
    $('iSave').disabled = false;
  }
};

/* ================= 8. 类型管理 ================= */

$('btnTypes').onclick = () => { renderTypeList(); openModal('typesModal'); };
$('tAdd').onclick = () => editType(null);
/* 取消只退回类型列表，不要把整个类型管理弹层一起关掉（元素缺失时也不能抛错） */
const teCancelBtn = $('teCancel');
if(teCancelBtn) teCancelBtn.onclick = e => { e.stopPropagation(); $('typeEditModal').classList.remove('open'); };

function renderTypeList(){
  $('typeList').innerHTML = DB.types().map(t => `
    <div class="row" style="justify-content:space-between;padding:10px 0;border-bottom:1px dashed var(--border)">
      <span>${esc(t.icon)} <b>${esc(t.name)}</b>
        <span class="muted">· ${t.fields.length} 字段 · ${t.allow_dup ? '允许重复' : '不可重复'}</span></span>
      <span style="flex:none">
        <button class="btn btn-sm" onclick="editType(${t.id})">编辑</button>
        <button class="btn btn-sm btn-danger" onclick="delType(${t.id})">删除</button>
      </span>
    </div>`).join('');
}

function delType(id){
  if(DB.items().some(i => i.type_id === id))
    return alert('该类型下已有条目，请先删除或迁移条目');
  if(!confirm('确认删除该类型？')) return;
  if(String(id) === curFilter) curFilter = '';   /* 正在筛这个类型时一并复位 */
  DB.saveTypes(DB.types().filter(t => t.id !== id));
  renderTypeList(); renderTypeFilter(); renderGrid();
}

let editTypeId = null;
function editType(id){
  editTypeId = id;
  const t = id ? DB.types().find(x => x.id === id)
               : { name:'', icon:'📦', allow_dup:false, fields:[] };
  if(id && !t){ return alert('该类型已不存在（可能被其它标签页删除）'); }
  $('teTitle').textContent = id ? '编辑类型' : '新建类型';
  $('teName').value = t.name;
  $('teIcon').value = t.icon;
  $('teDup').checked = t.allow_dup === true;
  $('teFields').innerHTML = t.fields.map(fieldRowHTML).join('');
  openModal('typeEditModal');
}

function fieldRowHTML(f){
  const isEnum = f.kind === 'enum';
  return `<div class="type-field" data-uid="${f.uid}">
    <div class="row">
      <input class="tf-label" autocomplete="off" placeholder="字段名" value="${esc(f.label)}">
      <select class="tf-kind">${Object.entries(KINDS).map(([k, n]) =>
        `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label class="row" style="gap:4px;margin:0;color:var(--text)" title="加密存储（AES-GCM）">
        <input type="checkbox" class="tf-secret" ${f.secret ? 'checked' : ''}>🔒</label>
      <label class="row" style="gap:4px;margin:0;color:var(--text)" title="勾选=可留空；不勾=必填。枚举类型恒为必填">
        <input type="checkbox" class="tf-empty" ${isEnum ? 'disabled' : (f.allow_empty === true ? 'checked' : '')}>置空</label>
      <button class="btn btn-sm btn-danger tf-del">✕</button>
    </div>
    <textarea class="tf-opts enum-opts ${isEnum ? 'show' : ''}"
      placeholder="枚举可选项（每行一个）">${(f.options || []).join('\n')}</textarea>
  </div>`;
}

$('teAddField').onclick = () => {
  $('teFields').insertAdjacentHTML('beforeend',
    fieldRowHTML({ uid:'u' + newId(), label:'', kind:'text', allow_empty:true }));
};
$('teFields').addEventListener('click', e => {
  if(e.target.classList.contains('tf-del')) e.target.closest('.type-field').remove();
});
$('teFields').addEventListener('change', e => {
  if(e.target.classList.contains('tf-kind')){
    const row = e.target.closest('.type-field');
    const isEnum = e.target.value === 'enum';
    row.querySelector('.tf-opts').classList.toggle('show', isEnum);
    const cb = row.querySelector('.tf-empty');
    cb.disabled = isEnum;
    if(isEnum) cb.checked = false;
  }
});

$('teSave').onclick = async () => {
  const name = $('teName').value.trim();
  if(!name) return alert('请输入类型名称');
  const allowDup = $('teDup').checked;
  const fields = [...document.querySelectorAll('#teFields .type-field')].map(row => {
    const label = row.querySelector('.tf-label').value.trim();
    if(!label) return null;
    const kind = row.querySelector('.tf-kind').value;
    return {
      uid: row.dataset.uid, label, kind,
      secret: row.querySelector('.tf-secret').checked,
      allow_empty: kind === 'enum' ? false : row.querySelector('.tf-empty').checked,
      options: kind === 'enum'
        ? row.querySelector('.tf-opts').value.split('\n').map(s => s.trim()).filter(Boolean)
        : undefined,
    };
  }).filter(Boolean);
  if(!fields.length) return alert('至少需要一个字段');

  /* 枚举没有可选项会导致该类型的条目永远填不完，这里直接拦住 */
  const badEnum = fields.find(f => f.kind === 'enum' && !(f.options && f.options.length));
  if(badEnum) return alert(`枚举字段「${badEnum.label}」至少需要一个可选项`);

  if(allowDup && fields.some(f => f.secret))
    return alert('「加密」与「允许重复」不可同时开启：请取消勾选“允许重复标题”，或将需要重复的字段改为不加密');

  const icon = $('teIcon').value.trim() || '📦';
  const types = JSON.parse(JSON.stringify(DB.types()));   /* 拷贝后再改，失败才能回滚 */
  if(editTypeId){
    const target = types.find(x => x.id === editTypeId);
    if(!target) return alert('该类型已不存在（可能被其它标签页删除）');
    Object.assign(target, { name, icon, allow_dup:allowDup, fields });
  }else{
    types.push({ id:newId(), name, icon, allow_dup:allowDup, fields });
  }

  $('teSave').disabled = true;
  try{
    const ok = await DB.saveTypes(types);
    if(ok){
      /* 只关类型编辑弹层，类型管理列表留在原地，方便连续编辑 */
      $('typeEditModal').classList.remove('open');
      renderTypeList(); renderTypeFilter(); renderGrid();
    }
  } finally {
    $('teSave').disabled = false;
  }
};

/* ================= 9. 背景设置（无改动） ================= */
let bgUploadedImage = '';

$('btnBg').onclick = () => { bgSyncUI(); openModal('setModal'); };

function bgSyncUI(){
  const S = BgSys.load();
  $('sMode').value = S.mode;
  $('sColor').value = S.color;
  $('sGradFromText').value = S.gradFrom; $('sGradToText').value = S.gradTo;
  try{ $('sGradFrom').value = normColor(S.gradFrom); }catch{}
  try{ $('sGradTo').value = normColor(S.gradTo); }catch{}
  $('sGradAngle').value = S.gradAngle;
  $('sGradCSS').value = S.gradCSS;
  $('sImageUrl').value = S.image.startsWith('data:') ? '' : S.image;
  bgUploadedImage = S.image.startsWith('data:') ? S.image : '';
  $('sFit').value = S.fit;
  $('sAlpha').value = S.alpha;
  bgToggleGroups();
}
function bgToggleGroups(){
  const m = $('sMode').value;
  $('gColor').hidden = m !== 'color';
  $('gGrad').hidden  = m !== 'gradient';
  $('gImage').hidden = m !== 'image';
}
function bgCollect(){
  const S = BgSys.load();
  S.mode = $('sMode').value;
  S.color = $('sColor').value.trim();
  S.gradFrom = $('sGradFromText').value.trim() || $('sGradFrom').value;
  S.gradTo = $('sGradToText').value.trim() || $('sGradTo').value;
  S.gradAngle = +$('sGradAngle').value || 135;
  S.gradCSS = $('sGradCSS').value.trim();
  S.image = $('sImageUrl').value.trim() || bgUploadedImage || '';
  S.fit = $('sFit').value;
  S.alpha = +$('sAlpha').value;
  BgSys.save(S); BgSys.apply(S);
}
['sMode','sColor','sGradFromText','sGradToText','sGradAngle','sGradCSS','sImageUrl','sFit','sAlpha']
  .forEach(id => $(id).addEventListener('input', bgCollect));
$('sMode').addEventListener('change', bgToggleGroups);
$('sGradFrom').addEventListener('input', e => { $('sGradFromText').value = e.target.value; bgCollect(); });
$('sGradTo').addEventListener('input', e => { $('sGradToText').value = e.target.value; bgCollect(); });
$('sGradFromText').addEventListener('change', e => { try{ $('sGradFrom').value = normColor(e.target.value); }catch{} });
$('sGradToText').addEventListener('change', e => { try{ $('sGradTo').value = normColor(e.target.value); }catch{} });
$('sImageFile').addEventListener('change', async e => {
  const f = e.target.files[0]; if(!f) return;
  try{
    bgUploadedImage = await imageToDataURL(f);
    $('sImageUrl').value = '';
    bgCollect();
  }catch{ alert('图片解析失败'); }
});
$('sReset').onclick = () => {
  localStorage.removeItem('vault_bg');
  BgSys.apply(BgSys.DEFAULTS); bgSyncUI();
};

/* ================= 11. 备份 / 恢复 ================= */
/* 全部用存在性判断绑定：即使浏览器缓存了旧页面、缺元素，也不会中断后面的脚本 */
if($('btnBackup')) $('btnBackup').onclick = () => { if($('bkMsg')) $('bkMsg').textContent = ''; openModal('backupModal'); };

if($('bkExport')) $('bkExport').onclick = async () => {
  try{
    const master = sessionStorage.getItem('vault_master');
    if(!master) throw new Error('会话已失效，请重新登录后再导出');
    /* 备份密钥只由主密码派生（与服务器盐无关）：同一主密码可在任意实例导入，方便本地 → 云端迁移 */
    const backupKey = await VaultCrypto.encKey(master, 'vault-backup-v2', VaultCrypto.KDF_ITERATIONS);
    const items = [];
    for(const it of DB.items()){
      const copy = { ...it };
      if(it.secret_ct){
        try{ copy.secret = JSON.parse(await Crypto.decrypt(KEY, it.secret_iv, it.secret_ct)); }
        catch{ copy.secret = null; }
        delete copy.secret_iv; delete copy.secret_ct;
      }
      items.push(copy);
    }
    const payload = { v: 2, exportedAt: new Date().toISOString(), user: USER, types: DB.types(), items };
    const { iv, ct } = await VaultCrypto.encrypt(backupKey, JSON.stringify(payload));
    const blob = new Blob([JSON.stringify({ format: 'vault-backup', v: 2, kdf: 'master-v2', iv, ct })], { type: 'application/json' });
    const name = 'vault-backup-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    $('bkMsg').textContent = `已导出：${payload.types.length} 个类型 / ${payload.items.length} 个条目（可用同一主密码在任意实例导入）`;
  }catch(e){ $('bkMsg').textContent = '导出失败：' + e.message; }
};

if($('bkImportFile')) $('bkImportFile').onchange = async e => {
  const f = e.target.files[0];
  if(!f) return;
  $('bkMsg').textContent = '读取备份中…';
  try{
    let env;
    try{ env = JSON.parse(await f.text()); }
    catch{ throw new Error('不是合法的 JSON 文件'); }
    if(env.format !== 'vault-backup' || !env.iv || !env.ct) throw new Error('不是 Vault 备份文件');

    let payload;
    if(env.kdf === 'master-v2'){
      const master = sessionStorage.getItem('vault_master');
      if(!master) throw new Error('会话已失效，请重新登录后再导入');
      const backupKey = await VaultCrypto.encKey(master, 'vault-backup-v2', VaultCrypto.KDF_ITERATIONS);
      try{ payload = JSON.parse(await VaultCrypto.decrypt(backupKey, env.iv, env.ct)); }
      catch{ throw new Error('解密失败：该备份不是用当前主密码加密的'); }
      /* 备份里的 secret 是明文对象（在加密信封内），导入时用本实例的密钥重新加密 */
      for(const it of payload.items || []){
        if(it.secret && Object.keys(it.secret).length){
          const enc = await Crypto.encrypt(KEY, JSON.stringify(it.secret));
          it.secret_iv = enc.iv; it.secret_ct = enc.ct;
        }
        delete it.secret;
      }
    }else{
      /* 旧格式：直接用当前实例密钥解密（仅同一实例可用） */
      try{ payload = JSON.parse(await Crypto.decrypt(KEY, env.iv, env.ct)); }
      catch{ throw new Error('解密失败：该备份不是用当前主密码加密的'); }
    }
    if(!payload || !Array.isArray(payload.types) || !Array.isArray(payload.items))
      throw new Error('备份内容结构不正确');

    if(!confirm(`将用备份替换当前数据：${payload.types.length} 个类型 / ${payload.items.length} 个条目。\n当前数据会被覆盖（建议先导出当前数据），确认继续？`)){
      $('bkMsg').textContent = '已取消';
      return;
    }
    $('bkMsg').textContent = '写入服务器中…';
    const okTypes = await DB.saveTypes(payload.types);
    if(!okTypes) throw new Error('类型写入失败');
    const okItems = await DB.replaceItems(payload.items);
    if(!okItems) throw new Error('条目写入失败');
    TYPES = payload.types; ITEMS = payload.items;
    renderTypeFilter(); renderGrid();
    $('bkMsg').textContent = `恢复完成 ✅（${payload.types.length} 个类型 / ${payload.items.length} 个条目）`;
  }catch(err){
    $('bkMsg').textContent = '导入失败：' + err.message;
  }finally{
    e.target.value = '';
  }
};

/* ================= 12. 账号安全（密保邮箱 / 恢复码） ================= */
function openSecurity(){
  if(!$('secModal')) return;
  $('secUser').value = (ME && ME.username) || USER || '';
  $('secEmail').value = (ME && ME.email) || '';
  $('secProof').value = '';
  $('secMsg').textContent = (ME && ME.has_recovery)
    ? '恢复码：已生成 ✅（可重新生成，旧的会作废）'
    : '恢复码：尚未生成（忘记主密码将无法找回数据）';
  $('secRecoveryBox').hidden = true;
  applyBrand();
  openModal('secModal');
}
if($('btnSecurity')) $('btnSecurity').onclick = openSecurity;

async function proofOfMaster(master){
  return VaultCrypto.verifier(master,
    sessionStorage.getItem('vault_salt'),
    Number(sessionStorage.getItem('vault_iterations')));
}

if($('secEmailSave')) $('secEmailSave').onclick = async () => {
  const master = $('secProof').value;
  const email = $('secEmail').value.trim();
  if(!master){ $('secMsg').textContent = '请先输入当前主密码以验证身份'; return; }
  $('secMsg').textContent = '保存中…';
  try{
    const proof = await proofOfMaster(master);
    const r = await api.req('/auth/email', { method:'POST', body: JSON.stringify({ proof, email }) });
    ME = { ...(ME||{}), email: r.email };
    $('secProof').value = '';
    $('secMsg').textContent = r.email ? '密保邮箱已保存 ✅' : '密保邮箱已清空';
  }catch(e){ $('secMsg').textContent = '保存失败：' + e.message; }
};

if($('secRecoveryGen')) $('secRecoveryGen').onclick = async () => {
  const master = $('secProof').value;
  if(!master){ $('secMsg').textContent = '请先输入当前主密码以验证身份'; return; }
  $('secMsg').textContent = '正在生成恢复码…';
  try{
    const proof = await proofOfMaster(master);
    const encSalt = sessionStorage.getItem('vault_enc_salt');
    const iterations = Number(sessionStorage.getItem('vault_iterations'));
    const bits = await VaultCrypto.pbkdf2Bits(master, encSalt, iterations);
    const code = VaultCrypto.generateRecoveryCode();
    const rec = await VaultCrypto.wrapEncKeyForRecovery(bits, code);
    await api.req('/auth/recovery-setup', { method:'POST',
      body: JSON.stringify({ proof, recovery_blob: rec.blob, recovery_verifier: rec.verifier }) });
    ME = { ...(ME||{}), has_recovery: true };
    $('secProof').value = '';
    $('secMsg').textContent = '恢复码已生成/更新 ✅ 请立即保存下方恢复码（旧恢复码已作废）';
    $('secRecoveryCode').textContent = code;
    $('secRecoveryBox').hidden = false;
  }catch(e){ $('secMsg').textContent = '生成失败：' + e.message; }
};

if($('secRecoveryCopy')) $('secRecoveryCopy').onclick = async () => {
  try{
    await navigator.clipboard.writeText($('secRecoveryCode').textContent);
    $('secRecoveryCopy').textContent = '已复制';
    setTimeout(() => { $('secRecoveryCopy').textContent = '复制'; }, 1500);
  }catch{ $('secRecoveryCopy').textContent = '请手动抄写'; }
};

if($('secRecoveryDownload')) $('secRecoveryDownload').onclick = () => {
  const text = [
    'Vault 恢复码',
    '用户名：' + ($('secUser').value || ''),
    '恢复码：' + $('secRecoveryCode').textContent,
    '生成时间：' + new Date().toLocaleString(),
    '',
    '忘记主密码时，在登录页点「忘记主密码？用恢复码找回」，输入该恢复码即可重设主密码。',
  ].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type:'text/plain' }));
  a.download = 'vault-recovery-code.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

/* ================= 13. 品牌（localStorage，与背景/主题一致） ================= */
const BRAND_DEFAULTS = { icon: '🔐', title: 'Vault', subtitle: '个人密码与资产保管库' };
function loadBrand(){
  try{
    const b = JSON.parse(localStorage.getItem('vault_brand') || '{}');
    return { ...BRAND_DEFAULTS, ...(b && typeof b === 'object' ? b : {}) };
  }catch{ return { ...BRAND_DEFAULTS }; }
}
function applyBrand(){
  const b = loadBrand();
  const logo = $('brandLogo');
  if(logo) logo.textContent = `${b.icon} ${b.title}`;
  const bi = $('brandIcon'), bt = $('brandTitleInput'), bs = $('brandSubInput');
  if(bi && document.activeElement !== bi) bi.value = b.icon;
  if(bt && document.activeElement !== bt) bt.value = b.title;
  if(bs && document.activeElement !== bs) bs.value = b.subtitle;
}
if($('brandSave')) $('brandSave').onclick = () => {
  const icon = ($('brandIcon').value.trim() || BRAND_DEFAULTS.icon).slice(0, 4);
  const title = ($('brandTitleInput').value.trim() || BRAND_DEFAULTS.title).slice(0, 20);
  const subtitle = ($('brandSubInput').value.trim() || BRAND_DEFAULTS.subtitle).slice(0, 40);
  localStorage.setItem('vault_brand', JSON.stringify({ icon, title, subtitle }));
  applyBrand();
  if($('brandMsg')) $('brandMsg').textContent = '品牌已保存（本浏览器生效；登录页刷新后生效）';
};

/* ================= 14. 快捷键：/ 搜索，n 新建 ================= */
document.addEventListener('keydown', e => {
  if(e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target;
  const tag = (el && el.tagName || '').toLowerCase();
  if(tag === 'input' || tag === 'textarea' || tag === 'select' || (el && el.isContentEditable)) return;
  if(document.querySelector('.modal-mask.open')) return;
  if(e.key === '/'){ e.preventDefault(); const sb = $('searchBox'); if(sb){ sb.removeAttribute('readonly'); sb.focus(); } }
  else if(e.key === 'n' || e.key === 'N'){ e.preventDefault(); if($('btnNew')) $('btnNew').click(); }
});

/* ================= 10. 顶栏其余按钮 + 弹窗通用 ================= */
$('btnTheme').onclick = () => {
  const S = BgSys.load();
  S.theme = S.theme === 'dark' ? 'light' : 'dark';
  BgSys.save(S); BgSys.apply(S);
};
$('btnLock').onclick = () => { sessionStorage.clear(); location.href = 'login.html'; };

function openModal(id){ $(id).classList.add('open'); }
function closeModals(){ document.querySelectorAll('.modal-mask').forEach(m => m.classList.remove('open')); }
/* 关闭 / 取消 / 点遮罩 / ESC 由脚本最前面的全局事件委托统一处理，这里不再逐个元素绑定 */
