# README.agent.md · 部署与 Cloudflare 配置完全指南

> 这份文档面向**第一次接触 Cloudflare / Git** 的人，从零开始：先在本机跑起来，再部署到云端，
> 最后是 Cloudflare 控制台逐项配置、常见故障排查和 Git 入门。
>
> 只想**本地运行、不碰 Cloudflare**：直接看 `local` 分支（仓库里切换分支即可），
> 或按本文第 2 节操作。

---

## 0. 你需要准备什么

| 项目 | 说明 |
|---|---|
| 一台电脑 | Windows / macOS / Linux 都可以 |
| Node.js | **≥ 18**，推荐 20 或 22 LTS。安装：<https://nodejs.org> |
| Git（可选） | 想用 `git clone` 拉代码才需要；不会 Git 就直接下载 ZIP |
| GitHub 账号（可选） | 想把自己的改动推到自己的仓库时用 |
| Cloudflare 账号（可选） | 想部署到公网才需要，免费计划即可。注册：<https://dash.cloudflare.com/sign-up> |

检查本机环境（Windows PowerShell）：

```powershell
node -v        # 应输出 v18+（推荐 v20/v22）
npm -v
git --version  # 可选
```

macOS / Linux：

```bash
node -v
npm -v
git --version
```

---

## 1. 获取代码

### 方式 A：下载 ZIP（完全不会 Git 的人用这个）

1. 打开仓库：<https://github.com/<your-username>/vault-content-manager>
2. 绿色按钮 **Code → Download ZIP**
3. 解压到任意目录（路径尽量不要有奇怪符号）

> 只想本地用、不想处理 Cloudflare：把分支切到 `local` 再下载 ZIP，里面有**一键启动脚本**。

### 方式 B：git clone

```bash
git clone https://github.com/<your-username>/vault-content-manager.git
cd vault-content-manager
```

---

## 2. 先在本机跑起来（不需要 Cloudflare）

> 本地运行使用 **wrangler dev + 本地 D1（SQLite 文件）**，完全离线、不花钱、不注册任何账号。

### 2.1 安装依赖并复制配置模板

```bash
npm install
cp wrangler.toml.example wrangler.toml    # Windows: copy wrangler.toml.example wrangler.toml
```

> 仓库只保留 `wrangler.toml.example`（模板）；真实的 `wrangler.toml` 含你自己的 D1 ID/域名，已被 `.gitignore` 忽略。

### 2.2 初始化本地数据库（只做一次，或换库后做）

```bash
npx wrangler d1 execute vault --local --file schema.sql
```

> 想用 `local` 分支里的一键脚本：`pwsh ./start-local.ps1`（Windows）或 `bash ./start-local.sh`（macOS/Linux），
> 它会自动完成"装依赖 → 建本地库 → 启动"。

### 2.3 启动

```bash
npx wrangler dev
```

浏览器打开：**http://localhost:8787**

### 2.4 第一次使用

1. 输入一个用户名 + 主密码（会提示不存在，自动切到"创建账号"）
2. 再输入一遍确认主密码 → 创建
3. **马上保存弹出的恢复码**（复制/下载 .txt）——忘记主密码时只能靠它找回
4. 进入主界面后可以新建条目、类型、背景、品牌

### 2.5 本地数据在哪 / 怎么备份

- 本地数据库文件：`.wrangler/state/`（不要提交到 Git，`.gitignore` 已忽略）
- 推荐用界面里 **💾 → 导出备份**（加密文件，最可靠）
- 想整体搬走：停掉服务后复制整个 `.wrangler/state/` 目录

> **注意**：本地数据库文件按 `wrangler.toml` 里的 `database_id` 区分。改了 id 等于换库；
> 需要多环境时用 `--persist-to <目录>` 指定独立目录。

---

## 3. 部署到 Cloudflare（详细版）

下面每一步都给了**控制台操作**和**命令行操作**两种方式，任选其一。

### 3.1 注册 Cloudflare 并登录

1. <https://dash.cloudflare.com/sign-up> 注册（邮箱验证）
2. 登录后能看到 **Workers & Pages**（没有域名也能用 Worker 免费额度）

### 3.2 让本机 wrangler 登录 Cloudflare

```bash
npx wrangler login
```

- 会自动打开浏览器，点 **Allow** 授权
- 成功后终端显示：`Successfully logged in`
- 验证：`npx wrangler whoami` 能看到你的账号邮箱

> 如果浏览器授权页打不开/一直失败：确认网络能访问 Cloudflare；或改用 API Token：
> Cloudflare 控制台 → My Profile → API Tokens → Create Token（权限：Workers Scripts:Edit、D1:Edit、
> Account Settings:Read、Zone:Read）→ 然后设置环境变量 `CLOUDFLARE_API_TOKEN` 再执行命令。

### 3.3 创建 D1 数据库

**命令行（推荐）：**

```bash
npx wrangler d1 create vault
```

输出里会有一行：

```
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**控制台方式：** 左侧 **Workers & Pages → D1 → Create database**，名字填 `vault`，
创建后进入详情页能看到 Database ID。

### 3.4 修改 `wrangler.toml`

打开 `wrangler.toml`（没有就先 `cp wrangler.toml.example wrangler.toml`），把 `database_id` 换成上一步拿到的真实 ID：

```toml
[[d1_databases]]
binding = "DB"
database_name = "vault"
database_id = "把这里换成你的真实ID"
```

> 不改会报错：`Invalid database_id` / `database_id must be a valid UUID`。

### 3.5 在远程数据库建表

```bash
npx wrangler d1 execute vault --remote --file schema.sql
```

看到 `Executed N queries` 即成功。**不要加 `--local`**，那是本地库。

### 3.6 设置 JWT 密钥（推荐）

```bash
npx wrangler secret put JWT_SECRET
```

按提示粘贴一串随机字符（例如 64 位 hex）。不设置也能跑，会自动生成并存进 D1。

### 3.7 部署

```bash
npx wrangler deploy
```

成功后终端会给出地址，例如：

```
https://vault.<你的子域>.workers.dev
```

打开这个地址 → 应该能看到登录页。

### 3.8 绑定自定义域名（可选）

前提：你的域名已托管在同一个 Cloudflare 账号（NS 指向 Cloudflare）。

**方式 A（控制台，推荐给新手）：**

1. Cloudflare 控制台 → **Workers & Pages** → 点开 `vault` 项目
2. **Settings → Domains & Routes → Add → Custom domain**
3. 输入 `vault.你的域名.com`（子域随便起，比如 `vault`）
4. Cloudflare 会自动创建 DNS 记录并申请证书，等待状态变成 **Active**（通常 1~5 分钟）

**方式 B（写进配置）：** 在 `wrangler.toml` 里加：

```toml
[[routes]]
pattern = "vault.你的域名.com"
custom_domain = true
```

然后重新 `npx wrangler deploy`。

> 注意：绑了自定义域名后，`*.workers.dev` 默认会被关闭。想两个地址都可用，
> 在 `wrangler.toml` 加 `workers_dev = true` 再部署一次。

### 3.9 上线后验证清单

- [ ] 打开 `https://你的域名/` 能看到登录页
- [ ] 注册账号（用户名 + 主密码两遍）→ **保存恢复码**
- [ ] 新建一个条目，刷新页面后还在
- [ ] 打开条目详情，密码点 👁 能显示
- [ ] 💾 导出备份成功
- [ ] 用手机/另一台设备访问，登录后数据能解密

### 3.10 以后更新代码

```bash
git pull            # 或重新下载 ZIP 覆盖
npx wrangler deploy # 静态文件 + Worker 一起更新
```

> 只改了前端（`src/static/*`）也要 `deploy` 才会同步到线上；本地 `wrangler dev` 会自动热更新。

---

## 4. Cloudflare 控制台配置详解

### 4.1 Worker 项目页

- **Metrics**：请求量、错误率
- **Logs**：实时日志（排查 500/401 很有用）
- **Settings → Variables and Secrets**：环境变量/密钥（`JWT_SECRET` 在这里）
- **Settings → Domains & Routes**：自定义域名、workers.dev 开关
- **Settings → Bindings**：D1 绑定（正常应显示 `DB → vault`）

### 4.2 D1 面板

- 能看到数据库大小、表、执行 SQL（Console 可以手查数据，**但密文看不懂是正常的**）
- **不提供一键备份**，重要数据请用应用里的 💾 导出备份；需要整体备份可用：
  `npx wrangler d1 export vault --remote --output backup.sql`

### 4.3 登录限速（强烈建议，零代码）

Security → **WAF → Rate limiting rules** → Create rule：

- Rule name: `vault-login-limit`
- If incoming requests match:
  - `URI Path` equals `/api/auth/login`
  - OR `URI Path` equals `/api/auth/recover/verify`
- Rate: `10 requests per 1 minute`，characteristics 选 **IP**
- Action: **Block**（或 Managed Challenge）
- 保存后立即生效

免费计划提供有限的限速规则额度，个人使用足够。

### 4.4 访问控制（可选）

如果不想让任何人看到登录页：Cloudflare **Zero Trust → Access → Applications**，
给你的域名加一条 Access 策略（例如只允许自己的邮箱），访问时先过一层 Cloudflare 登录。

### 4.5 缓存注意

本项目的静态资源带 `must-revalidate`，一般刷新即可拿到新版本。
如果更新后页面还是旧的：Ctrl+F5 强制刷新；仍不行就清一下该站点的缓存数据。

### 4.6 免费计划限制

- Worker：每天 10 万次请求、CPU 时间有限（本项目的 PBKDF2 在**浏览器**里算，服务器只做 SHA-256，基本不受影响）
- D1：免费额度足够个人使用（读写行数有限制）
- 自定义域名：不额外收费

---

## 5. 数据迁移（本地 ↔ 云端）

两边是**完全独立的数据库**，需要用备份文件搬：

1. 旧实例：右上角 **💾 → 导出备份**（得到加密 JSON）
2. 新实例：用**同一个用户名 + 主密码**登录一次（空库会自动创建账号；保存恢复码）
3. 新实例：**💾 → 导入备份**

> 两边主密码必须相同，否则导入会提示"备份不是用当前主密码加密的"。

---

## 6. 安全设置清单（上线后逐项做）

- [ ] 保存好**恢复码**（登录后 🛡️ 账号安全里可以重新生成）
- [ ] 设置**密保邮箱**（修改邮箱需要验证主密码）
- [ ] Cloudflare 配置**登录限速**（见 4.3）
- [ ] 定期 **💾 导出备份**，并离线保存
- [ ] 主密码不要太短；不要和别的网站共用
- [ ] 不要把 `wrangler.toml` 里的账号私有信息、`JWT_SECRET`、恢复码提交到 Git

---

## 7. Git 完全入门（不会 Git 也能看完）

### 7.1 安装与配置

- 下载安装 Git：<https://git-scm.com/downloads>
- 配置身份（只需一次）：

```bash
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

### 7.2 克隆仓库

```bash
git clone https://github.com/<your-username>/vault-content-manager.git
cd vault-content-manager
```

### 7.3 修改并提交

```bash
git status                  # 看改了哪些文件
git add -A                  # 把所有改动加入暂存区
git commit -m "说明这次改了什么"
```

### 7.4 推送到 GitHub

推送需要认证。第一次会弹浏览器登录（Git Credential Manager），登录 GitHub 即可；
也可以在 GitHub → Settings → Developer settings → Personal access tokens 创建 token，
用 `https` 地址推送时当密码用。

```bash
git push origin main
```

### 7.5 分支（`local` 分支是什么）

仓库里有两条分支：

| 分支 | 用途 |
|---|---|
| `main` | 完整版（本地开发 + Cloudflare 部署都支持） |
| `local` | 纯本地版：多了一键启动脚本、本地专用配置，**不用管 Cloudflare** |

切换到 local 分支：

```bash
git checkout local        # 已有仓库
git clone -b local https://github.com/<your-username>/vault-content-manager.git  # 新克隆
```

不想用 Git：在 GitHub 页面左上角把分支切到 `local` → Code → Download ZIP。

### 7.6 常见 Git 问题

| 问题 | 解决 |
|---|---|
| `could not read Username for 'https://github.com'` | 推送需要登录：重新 `git push` 并在弹窗/浏览器完成 GitHub 授权；或用 PAT |
| 授权页一闪而过/打不开 | 认证流程需要 git 进程保持运行，别关终端；网络/代理问题可改用 PAT |
| `Updates were rejected` | 先 `git pull --rebase` 再 push |
| 不知道改了哪些文件 | `git status` / `git diff` |

---

## 8. 故障排查（FAQ）

### 8.1 登录后立刻跳回登录页 / 接口全 401

- 确认 Worker 已用最新代码部署（`npx wrangler deploy`）
- 如果是自己改代码后出现：检查 JWT 校验是否带 `'HS256'` 参数
- 清掉浏览器该站点数据后重新登录

### 8.2 页面空白 / 按钮全都没反应 / 关闭按钮无效

- 多半是浏览器缓存了**旧页面**（HTML 与 JS 版本不一致）：**Ctrl+F5 强制刷新**
- 本地开发时重启一次 `npx wrangler dev`（新增文件尤其需要重启）

### 8.3 `GET /crypto.js` 404

- 本地：重启 `npx wrangler dev`（新文件加入静态资源清单需要重启）
- 线上：`npx wrangler deploy` 重新部署

### 8.4 本地数据"消失"

- 检查 `wrangler.toml` 的 `database_id` 是否被改过（本地库按 id 区分）
- 换 id 的正确做法：用 `--persist-to <目录>` 指定本地状态目录，别直接改 id

### 8.5 部署报错

| 报错 | 原因/解决 |
|---|---|
| `Invalid database_id` | `wrangler.toml` 里还是 `local`，换成真实 UUID（3.3） |
| `You are not authenticated` | 重新 `npx wrangler login` |
| `no such table` | 远程没建表：`npx wrangler d1 execute vault --remote --file schema.sql` |
| 自定义域名一直 Pending | 等待证书（几分钟）；确认域名 NS 指向 Cloudflare、且和 Worker 同账号 |

### 8.6 忘记主密码

- 登录页点「忘记主密码？用恢复码找回」，用注册时保存的恢复码重设
- 恢复码也丢了 → 无法解密数据（这是零知识设计的代价），只能清库重建：
  `npx wrangler d1 execute vault --remote --command "DELETE FROM user"`（**会丢加密数据**）

### 8.7 想整体备份/恢复 D1

```bash
npx wrangler d1 export vault --remote --output backup.sql   # 备份
# 恢复：新建库 → npx wrangler d1 execute <新库> --remote --file backup.sql
```

> 注意：SQL 里是密文，**没有主密码依然解不开**，所以真正的备份请用应用内 💾 导出。

---

## 9. 命令速查

```bash
npm install                                             # 安装依赖
cp wrangler.toml.example wrangler.toml                 # 首次：复制配置模板
npx wrangler dev                                        # 本地启动 :8787
npx wrangler d1 execute vault --local --file schema.sql  # 本地建表
npx wrangler d1 create vault                            # 创建远程 D1
npx wrangler d1 execute vault --remote --file schema.sql# 远程建表
npx wrangler secret put JWT_SECRET                      # 设置密钥
npx wrangler deploy                                     # 部署
npx wrangler whoami                                     # 当前登录账号
npx wrangler deployments list                           # 部署历史
```

---

## 10. 本地分支（`local`）说明

`local` 分支 = `main` + 纯本地所需文件，**不需要 Cloudflare 账号**：

| 文件 | 作用 |
|---|---|
| `README.local.md` | 纯本地快速开始（更短的说明） |
| `wrangler.local.toml` | 本地专用配置（`database_id = "local"`，与线上隔离） |
| `start-local.ps1` | Windows 一键：装依赖 → 建本地库 → 启动 |
| `start-local.sh` | macOS/Linux 一键（同上） |
| `package.json` | 增加 `dev` / `db:local` npm 脚本和 wrangler 开发依赖 |

获取方式（任选）：

```bash
git clone -b local https://github.com/<your-username>/vault-content-manager.git
# 或已有仓库：git checkout local
# 或 GitHub 页面切分支 → Code → Download ZIP
```

启动：

```bash
# Windows PowerShell
pwsh ./start-local.ps1

# macOS / Linux
bash ./start-local.sh

# 手动
npm install
npx wrangler d1 execute vault --local --config wrangler.local.toml --file schema.sql
npx wrangler dev --config wrangler.local.toml
```

> `local` 分支的配置**故意**指向本地库（`database_id = "local"`），从该分支直接 `wrangler deploy` 会失败——
> 这是安全设计，避免误把本地配置部署上线。要部署请回到 `main` 分支。
