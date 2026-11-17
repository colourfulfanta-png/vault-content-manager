# Vault · 本地版（不需要 Cloudflare）

这是 **`local` 分支**：纯本地运行版本。不需要 Cloudflare 账号、不需要部署、完全离线，数据只存在你自己的电脑上。

> 完整版（含 Cloudflare 部署）在 `main` 分支；部署/配置/排错详见 `main` 分支里的 `README.agent.md`。

## 一键启动

Windows（PowerShell 7 或 Windows PowerShell 5.1）：

```powershell
pwsh ./start-local.ps1
```

macOS / Linux：

```bash
bash ./start-local.sh
```

脚本会自动：检查 Node → 安装依赖 → 初始化本地数据库 → 启动服务。

启动后打开：**http://localhost:8787**

### 手动启动（不用脚本）

```bash
npm install
npx wrangler d1 execute vault --local --config wrangler.local.toml --file schema.sql
npx wrangler dev --config wrangler.local.toml
```

也可以直接用 npm 脚本：

```bash
npm run db:local   # 初始化本地 D1
npm run dev        # 启动 :8787
```

## 第一次使用

1. 输入用户名 + 主密码（会提示不存在，自动切到"创建账号"）
2. 再输入一遍确认主密码 → 创建
3. **保存弹出的恢复码**（复制或下载 .txt）——忘记主密码时只能靠它找回
4. 建议进 🛡️ 账号安全设置密保邮箱；也可以在里面重新生成恢复码

## 数据在哪 / 怎么备份

- 本地数据库：`.wrangler/state/`（SQLite 文件，已在 `.gitignore` 里）
- 推荐：界面右上角 **💾 → 导出备份**（加密文件，最可靠）
- 整体搬迁：停掉服务后复制整个 `.wrangler/state/` 目录

> 本地库按 `wrangler.local.toml` 里的 `database_id = "local"` 区分；
> 换配置等于换库，需要多份数据时用 `--persist-to <目录>`。

## 和 main 分支的区别

| 文件 | 作用 |
|---|---|
| `wrangler.local.toml` | 本地专用配置（`database_id = "local"`，与线上隔离） |
| `start-local.ps1` / `start-local.sh` | 一键启动脚本 |
| `package.json` | 增加 `dev` / `db:local` 脚本和 wrangler 开发依赖 |
| `README.local.md` | 本文档 |

⚠️ **不要把 local 分支部署上线**：配置故意指向本地库，`wrangler deploy` 会失败，这是安全设计。
要部署请回到 `main` 分支，按 `README.agent.md` 操作。

## 常见问题

- **页面空白 / 按钮没反应 / 关闭无效**：浏览器缓存了旧页面 → `Ctrl+F5`；本地开发新增文件后重启 `wrangler dev`
- **登录后跳回登录页**：确认页面是最新的（强刷），以及服务已启动
- **忘记主密码**：登录页「忘记主密码？用恢复码找回」；恢复码也丢了数据就无法解密
- **本地数据"消失"**：检查是否改过 `wrangler.local.toml` 的 `database_id`
- 更多排错：`main` 分支的 `README.agent.md`

## 环境要求

- Node.js ≥ 18（推荐 20 / 22 LTS）
- 首次启动需要联网安装依赖；之后可完全离线运行
