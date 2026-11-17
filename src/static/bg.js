/* ============ 背景与主题（登录页/主界面共享） ============ */
const BgSys = {
  DEFAULTS:{ mode:'color', color:'', gradFrom:'#3b6ef5', gradTo:'#7c5bff',
             gradAngle:135, gradCSS:'', image:'', fit:'cover', alpha:100, theme:'dark' },

  load(){ try{ return {...this.DEFAULTS, ...JSON.parse(localStorage.getItem('vault_bg')||'{}')} }
          catch{ return {...this.DEFAULTS} } },

  save(s){ try{ localStorage.setItem('vault_bg', JSON.stringify(s)) }
           catch{ alert('保存失败：本地存储空间不足（背景图太大？），建议改用 URL 方式') } },

  apply(s){
    document.body.classList.toggle('theme-dark',  s.theme==='dark');
    document.body.classList.toggle('theme-light', s.theme==='light');
    const root = document.documentElement;
    let layer = s.color || 'var(--bg)';   // 纯色留空 → 跟随主题底色
    let size  = 'cover';
    if(s.mode==='image' && s.image){
      layer = `url("${s.image}")`;
      size = { stretch:'100% 100%', cover:'cover', contain:'contain' }[s.fit] || 'cover';
    }else if(s.mode==='gradient'){
      layer = s.gradCSS || `linear-gradient(${s.gradAngle}deg, ${s.gradFrom}, ${s.gradTo})`;
    }
    root.style.setProperty('--bg-layer', layer);
    root.style.setProperty('--bg-size',  size);
    root.style.setProperty('--bg-alpha', s.alpha/100);
  },

  init(){ this.apply(this.load()); }
};
BgSys.init();

/* 任意格式颜色值 → 规范化（借 canvas 解析，#hex/rgb()/hsl() 通吃） */
function normColor(c){
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillStyle = c;
  return ctx.fillStyle;   // 合法时返回 #rrggbb 或 rgba(...)
}

/* 本地图片 → 压缩 dataURL（防止 localStorage 撑爆） */
async function imageToDataURL(file, maxW=1920, quality=.85){
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxW/bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width*scale);
  c.height = Math.round(bmp.height*scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}
