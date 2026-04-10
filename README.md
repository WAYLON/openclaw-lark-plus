# openclaw-lark-plus

Multi-user fork of `@larksuite/openclaw-lark` — each Feishu user scans a QR code to get their **own independent Feishu bot**, with their own agent, conversation history, and workspace directory.

## Why

The official `@larksuite/openclaw-lark` plugin is single-owner: only the app creator can complete OAuth, and only one Feishu bot is configured per OpenClaw instance.

`openclaw-lark-plus` solves this by:

- **QR-code registration** — new users scan a QR code to auto-create an independent Feishu "Personal Agent" app via Feishu's `/oauth/v1/app/registration` API. No manual app creation, no client_id/secret copy-paste.
- **Admin approval** — the first user becomes admin; subsequent registrations require admin approval from inside Feishu.
- **Per-user agent + workspace** — each registered user gets their own entry in `config.agents.list` and a matching `config.bindings` rule, so the OpenClaw framework natively routes their messages to a per-user agent with its own workspace directory (`~/.openclaw/workspaces/<user>`), conversation history, memory, and skills.
- **Conversation isolation** — built on the SDK's `sessionKey` (scoped to agent + channel + peer), each user's chat history is naturally isolated from everyone else.
- **Coexists with the original plugin** — plugin ID is `openclaw-lark-plus`, so you can keep `@larksuite/openclaw-lark` installed side-by-side during migration.

## Prerequisites

- [OpenClaw](https://www.npmjs.com/package/openclaw) installed and running (`openclaw gateway` service up)
- Node.js >= 18
- A Feishu / Lark account to scan the first QR code and become admin

## Installation

### 1. Clone the plugin into the extensions directory

```bash
mkdir -p ~/.openclaw/extensions
cd ~/.openclaw/extensions
git clone https://github.com/shyrock/openclaw-lark-plus.git
cd openclaw-lark-plus
npm install
```

### 2. Enable the plugin in `~/.openclaw/openclaw.json`

```json
{
  "plugins": {
    "allow": ["openclaw-lark-plus"],
    "installs": {
      "openclaw-lark-plus": {
        "path": "~/.openclaw/extensions/openclaw-lark-plus"
      }
    }
  }
}
```

> The built-in `@openclaw/feishu` channel driver handles the actual Feishu WebSocket connection — `openclaw-lark-plus` layers multi-user management, QR registration, and approval flow on top of it. Both can be enabled simultaneously.

### 3. Restart the gateway

```bash
systemctl restart openclaw-gateway   # or however you run the gateway
```

## Bootstrapping the first admin

There's a chicken-and-egg problem: `/feishu register` is a chat command, but there's no Feishu bot configured yet to receive commands. Use the **CLI install** command for the very first user:

```bash
openclaw lark-plus-install
```

This prints a QR code in the terminal. Scan it with Feishu/Lark:

1. Feishu creates a new "Personal Agent" app tied to your account
2. The CLI polls until authorization completes, then receives the new `client_id` / `client_secret`
3. The scanning user is recorded as **admin** in `~/.openclaw/openclaw.json`
4. An `accounts` entry, an `agents.list` entry, a per-user `bindings` rule, and a workspace directory (`~/.openclaw/workspaces/<admin-openId>`) are all written automatically
5. Restart the gateway — your personal Feishu bot is now online

From this point on, you can DM your new bot directly.

## Adding more users

Once the admin's bot is online, **in a DM with the admin's bot**, run:

```
/feishu register
```

The bot replies with a QR-code image. Share it with the new user (forward the image, screenshot, etc.).

When the new user scans:

1. Feishu creates another independent Personal Agent app for them
2. The plugin stores the registration as **pending** (credentials are held in `~/.openclaw/openclaw.json` under `channels.feishu.plus.pendingRegistrations`)
3. The admin receives a Feishu notification with the pending ID and two quick-reply commands

Admin approves or rejects:

```
/feishu approve reg-xxxxx
/feishu reject  reg-xxxxx
```

On approval, the plugin writes a full account for the new user (account + agent + binding + workspace directory) and tells the admin to restart the gateway. On rejection, the pending credentials are discarded.

```bash
systemctl restart openclaw-gateway
```

After restart, the new user can DM **their own bot** directly.

## Commands

All commands below are invoked inside a Feishu chat with a `openclaw-lark-plus`-managed bot.

| Command | Who | Description |
|---------|-----|-------------|
| `/feishu register` | admin | Generate a QR code to invite a new user |
| `/feishu approve <pending_id>` | admin | Approve a pending registration |
| `/feishu reject <pending_id>` | admin | Reject & discard a pending registration |
| `/feishu pending` | admin | List all pending registrations |
| `/feishu users` | admin | List authorized users and their account/agent mapping |
| `/feishu doctor` | anyone | Run configuration diagnostics |
| `/feishu help` | anyone | Show help |

Plus the terminal-only bootstrap:

| CLI | Description |
|-----|-------------|
| `openclaw lark-plus-install` | Interactive QR flow to register the first admin user |

## How per-user isolation works

`openclaw-lark-plus` does **not** ship a custom routing layer. It writes directly into OpenClaw's native config schema so the framework does the routing for you:

**1. One `accounts` entry per user** (under `channels.feishu.accounts`) — each user has their own `appId`/`appSecret` and a `dmPolicy: "allowlist"` restricted to that user's own `openId`.

**2. One `agents.list` entry per user** — the agent id matches the user's `openId`, with a unique `workspace` directory.

**3. One `bindings` rule per user** — `{type: "route", agentId: <openId>, match: {channel: "feishu", peer: {kind: "direct", id: <openId>}}}` — tells the framework's `resolveAgentRoute` to send this user's DMs to their own agent.

**4. A default `main` agent** is always injected at the front of `agents.list` as a safety net, so any un-bound traffic (e.g. channel-wide legacy bindings) routes to a real default agent instead of silently falling through to someone else's private agent.

Because each user gets a unique `agentId`, the framework's session key becomes:

```
agent:<user-openId>:feishu:direct:<user-openId>
```

…which means **conversation history, memory, and workspace state are naturally isolated per user**. No two users share a session.

### Auto-generated config shape

After one admin + one regular user are registered, `~/.openclaw/openclaw.json` looks roughly like this:

```json
{
  "plugins": {
    "allow": ["openclaw-lark-plus"],
    "installs": {
      "openclaw-lark-plus": { "path": "~/.openclaw/extensions/openclaw-lark-plus" }
    }
  },
  "channels": {
    "feishu": {
      "accounts": {
        "ou_alice": {
          "appId": "cli_alice_xxx",
          "appSecret": "***",
          "enabled": true,
          "dmPolicy": "allowlist",
          "allowFrom": ["ou_alice"]
        },
        "ou_bob": {
          "appId": "cli_bob_xxx",
          "appSecret": "***",
          "enabled": true,
          "dmPolicy": "allowlist",
          "allowFrom": ["ou_bob"]
        }
      },
      "plus": {
        "adminOpenId": "ou_alice",
        "adminAccountId": "ou_alice"
      }
    }
  },
  "agents": {
    "list": [
      { "id": "main", "name": "main", "default": true },
      { "id": "ou_alice", "name": "ou_alice", "workspace": "/root/.openclaw/workspaces/ou_alice" },
      { "id": "ou_bob",   "name": "ou_bob",   "workspace": "/root/.openclaw/workspaces/ou_bob" }
    ]
  },
  "bindings": [
    {
      "type": "route",
      "agentId": "ou_alice",
      "match": { "channel": "feishu", "peer": { "kind": "direct", "id": "ou_alice" } }
    },
    {
      "type": "route",
      "agentId": "ou_bob",
      "match": { "channel": "feishu", "peer": { "kind": "direct", "id": "ou_bob" } }
    }
  ]
}
```

You can hand-edit any agent's `workspace`, `systemPromptOverride`, `skills`, `model`, etc. — those are standard OpenClaw `agents.list` fields, documented in the OpenClaw SDK.

## Architecture

```
  /feishu register
        │
        ▼
Feishu /oauth/v1/app/registration (init → begin → poll)
        │
        ▼
  new user scans QR
        │
  ┌─────┴─────┐
  │           │
First user   Subsequent
  │           │
  │           ▼
  │     store as pending
  │     notify admin
  │           │
  │     ┌─────┴─────┐
  │     ▼           ▼
  │  approve     reject
  │     │           │
  ▼     ▼           ▼
  └─► write account + agent + binding + workspace
              │
              ▼
      restart gateway → new bot online
```

### Key files

| File | Purpose |
|------|---------|
| `src/plugin/src/core/accounts-manager.js` | Multi-account CRUD, admin tracking, pending storage, and auto-injection of `agents.list` + `bindings` + the `main` safety-net agent |
| `src/plugin/src/core/app-registration.js` | Feishu App Registration API client (init / begin / poll) |
| `src/plugin/src/commands/register.js` | `/feishu register`, `/feishu approve`, `/feishu reject`, `/feishu pending` |
| `src/plugin/src/commands/cli-install.js` | Terminal-based first-admin bootstrap (`openclaw lark-plus-install`) |
| `src/plugin/src/commands/users.js` | `/feishu users` — list registered accounts and their bindings |
| `src/plugin/index.js` | Plugin entrypoint; registers commands and validates config |

## Security

- **Admin approval gate** — only the first registered user can approve new registrations
- **Config file is mode 0600** — credentials written to `~/.openclaw/openclaw.json` are readable only by the owning Unix user
- **Rejected credentials are discarded** — `/feishu reject` deletes the pending entry entirely
- **Per-bot DM allowlist** — each user's bot has `dmPolicy: "allowlist"` with only that user's `openId`, so bots cannot be spoken to by anyone else
- **OAuth token scope isolation** — the OpenClaw SDK stores tokens keyed by `{appId}:{userOpenId}`, so cross-bot token leakage is not possible
- **Per-user workspace isolation** — each bot's agent runs in its own directory under `~/.openclaw/workspaces/<openId>`, so files, memory, and tool state are physically separated on disk

## Troubleshooting

**"Channel already registered: feishu" on startup**
: Harmless — means both this plugin and OpenClaw's built-in `@openclaw/feishu` tried to register. The built-in driver wins and handles the WebSocket; this plugin contributes the multi-user commands and config writes.

**New user's messages route to the admin's agent (or vice versa)**
: This is the `pickFirstExistingAgentId` fallback biting you — it means `agents.list` is missing a `main` entry, and a channel-wide binding is silently routing everything to index 0. Upgrade to the latest `openclaw-lark-plus` (the `main` safety-net injection fixes this), or manually add `{"id": "main", "name": "main", "default": true}` at the **front** of `agents.list` and restart.

**Admin runs `/feishu register` but nothing happens**
: Check `journalctl -u openclaw-gateway | grep register` — the most common cause is the admin's `dmPolicy: "allowlist"` not including their own `openId`. Re-run `openclaw lark-plus-install` to rebuild the admin entry.

**New bot doesn't come online after approval**
: You need to restart the gateway (`systemctl restart openclaw-gateway`) — OpenClaw reads `channels.feishu.accounts` at startup, and a hot-reload only picks up existing account mutations, not newly-added accounts.

## License

MIT
