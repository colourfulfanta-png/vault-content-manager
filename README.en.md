# Vault · Personal Password & Asset Manager

A single-user personal vault running on **Cloudflare Workers + D1**: store passwords, domains,
servers, notes and more. Sensitive fields are encrypted in the browser with AES-256-GCM derived
from your master password — **the server never sees the master password**.

- Frontend: vanilla HTML/CSS/JS (no framework, no build step), served by Workers Static Assets
- Backend: Hono (TypeScript, single entry `src/index.ts`)
- Database: D1 (SQLite)
- Local dev: `wrangler dev` (local D1, fully offline)

Live instance: deploy it to your own Cloudflare account (see [README.agent.md](README.agent.md))

> Step-by-step deployment / Cloudflare configuration / Git basics / troubleshooting:
> see **[README.agent.md](README.agent.md)**. To run purely locally (no Cloudflare account),
> use the **`local` branch** which ships one-click startup scripts.

## Features

- **Smart login / registration**: unknown usernames automatically switch to "create account" mode;
  existing accounts only type the master password once
- Custom types: field name, kind (text / long text / number / enum / URL), encrypted or not, required or not
- Item CRUD, detail dialog, masked password fields with 👁 toggle
- **One-click copy**: 📋 next to each field in the detail dialog (title excluded); encrypted fields
  copy the decrypted value directly
- **Pin**: 📍/📌 toggle on each card, pinned items sort first (stored in `plain._pin`, no DB migration)
- **Keyboard shortcuts**: `/` focuses search, `n` creates a new item (ignored while typing / dialog open)
- **Branding**: customize the login title/subtitle and the main-logo text (stored in this browser's localStorage)
- Background & theme: solid / gradient / image (cover / stretch / contain), opacity, dark/light themes
- Encrypted backup export / import (portable format, works across instances)
- **Recovery code**: reset the master password and re-encrypt the whole vault if you forget it
- Security panel: recovery email (changing it requires the master password), generate/regenerate recovery codes
- Per-item writes + optimistic conflict detection (multi-tab / multi-device safe)
- Save failures roll back with a clear message — the UI never pretends a save succeeded

## Encryption & authentication design

```
master password (browser memory / sessionStorage only; cleared when the tab closes)
  ├─ authKey  = PBKDF2(master, auth salt, 310,000) → SHA-256 → verifier (all the server stores)
  ├─ encKey   = PBKDF2(master, enc salt, 310,000)  → AES-256-GCM for secret field values (never leaves the browser)
  └─ backupKey= PBKDF2(master, fixed salt 'vault-backup-v2', 310,000) → encrypts backup files (portable)
```

- Two independent salts: if D1 leaks, each candidate password needs two PBKDF2 runs to both verify
  login and attempt decryption
- The server stores only: username, verifier, salts, iteration count, ciphertext items, recovery blob —
  **no reversible credential**
- **Recovery code**: at registration `encKey` is wrapped with a key derived from a random recovery code
  (`recovery_blob` + `recovery_verifier`). The server cannot unwrap it; during recovery the client
  unwraps `encKey`, re-encrypts everything with the new master password and commits atomically —
  zero-knowledge is preserved
- Legacy accounts (scheme=1) are upgraded atomically by the frontend on first login

## Login / registration (smart, frontend-only)

- After typing a username (on blur or 600 ms pause) the page checks whether the account exists:
  - exists → login mode, confirm-password field hidden, type the master password once
  - missing → "create new account" auto-checked, confirm-password field shown
- If the auto-detection is wrong, you can manually toggle **"Create new account"** to correct it
- If the username turns out to be missing at submit time, the page switches to create mode and asks
  for the confirmation instead of showing a parse error

## Useful tips

| Action | How |
|---|---|
| Copy a field | Open item detail → 📋 next to the field |
| Pin an item | 📍 at the card's top-right |
| Search | Press `/` or click the top search box |
| New item | Press `n` or click "＋ New item" |
| Close dialog | `Esc` / click the backdrop / "Close" |
| Custom branding | 🛡️ Security → Branding → Save (this browser only) |

> Branding is stored in `localStorage` (same as background/theme) and does not sync across devices.

## Backup / restore

Top-right **💾** → "Export backup" produces an encrypted JSON file: secret values are decrypted inside
the encrypted envelope, then the whole file is encrypted with a **backup key derived only from the
master password** (independent of server salts). Importing re-encrypts everything with the target
instance's key. **Losing the master password means the backup cannot be decrypted** — keep it safe.

## Migration (local → cloud)

1. Old instance: **💾 → Export backup**
2. New instance: log in once with the **same username + master password** (creates the account on an
   empty DB; save the recovery code)
3. New instance: **💾 → Import backup**

## Forgot master password (recovery code)

1. On the login page click "Forgot master password? Recover with a recovery code"
2. Enter username + recovery code + new master password (twice)
3. The client unwraps the old data key → re-encrypts the whole vault with the new password →
   **atomic D1 batch commit**
4. A **new recovery code** is shown (the old one is invalidated) — save it

> The recovery code is shown once. Lose it and forget the master password = data is unrecoverable.

## Local development

```bash
npm install
cp wrangler.toml.example wrangler.toml                    # first time (Windows: copy ...)
npx wrangler d1 execute vault --local --file schema.sql   # first run or after switching DB
npx wrangler dev                                          # → http://localhost:8787
```

> The local D1 file is keyed by `database_id` in `wrangler.toml`; changing the id means a different local DB.
> Use `--persist-to <dir>` for isolated environments.

## Deploy to Cloudflare

```bash
npx wrangler d1 create vault                 # put the returned database_id into wrangler.toml
npx wrangler d1 execute vault --remote --file schema.sql
npx wrangler secret put JWT_SECRET           # recommended
npx wrangler deploy
```

For upgrades of an existing database, run the SQL files under `migrations/` in order (each only once).

After deploying, bind your own custom domain in the Cloudflare dashboard (see [README.agent.md](README.agent.md)).

## Security & operations

- **Login rate limiting (recommended, configure in the Cloudflare dashboard — no code)**:
  Security → WAF → Rate limiting rules, create a rule:
  - match `URI Path` equals `/api/auth/login` or `/api/auth/recover/verify`
  - threshold: 10 requests per minute per IP; action Block (or Managed Challenge)
  - the free plan has enough quota for personal use
- A code-based limiter (D1 failure counter → 429) is on the TODO list
- For public deployments consider Cloudflare Access (Zero Trust) as an extra gate

## Project layout

```
├── src/
│   ├── index.ts          # Hono routes: auth / recovery / types / items + asset fallback
│   └── static/
│       ├── index.html    # main UI
│       ├── login.html    # login page
│       ├── crypto.js     # crypto / key derivation / recovery code helpers (shared)
│       ├── app.js        # main UI logic (render, form, copy, pin, shortcuts, backup, branding)
│       ├── login.js      # smart login/registration, recovery flow, legacy upgrade
│       ├── bg.js         # theme / background system
│       └── *.css
├── migrations/           # DB upgrade scripts (001 encryption scheme / 002 recovery+email)
├── schema.sql            # D1 schema
├── wrangler.toml
└── package.json
```

## Known limitations / not implemented yet

- No "change master password" button (use recovery-code reset; equivalent to a full re-encryption)
- **Email recovery is not enabled**: sending verification emails and recovering data via email
  (which would require handing decryptable material to the server and weaken zero-knowledge) is
  deferred. Recovery currently uses the **recovery code**. The recovery email is just an account
  label/reminder for now
- R2 attachments are deferred (one-click copy covers the common need)
- Login rate limiting is expected to be configured in Cloudflare (see above); no built-in code version
- No trash/undo delete; backup restore replaces the whole vault; type saving is still full-replace
  (few types, low risk)
- Password masking is imperfect on Firefox; PBKDF2 on the Workers free plan may hit CPU limits
