# openclaw-lark-plus

[English](./README.md) | 简体中文

`@larksuite/openclaw-lark` 的多用户分支 —— 每个飞书用户扫码即可拥有**独立的飞书机器人**，独立的 agent、对话历史和工作目录。

## 为什么要有这个分支

官方的 `@larksuite/openclaw-lark` 插件是单用户的：只有应用创建者能完成 OAuth 授权，每个 OpenClaw 实例只能配置一个飞书机器人。

`openclaw-lark-plus` 解决了这些问题：

- **扫码注册** —— 新用户扫码即可通过飞书的 `/oauth/v1/app/registration` API 自动创建独立的"个人助理"应用。无需手动创建应用，无需复制粘贴 client_id/client_secret。
- **管理员审批** —— 第一个注册的用户成为管理员，后续注册需要管理员在飞书内审批。
- **每用户独立 agent 和 workspace** —— 每个注册用户在 `config.agents.list` 中有自己的条目，在 `config.bindings` 中有匹配的路由规则。OpenClaw 框架原生按此路由，每个用户拥有独立的 workspace 目录（`~/.openclaw/workspaces/<user>`）、对话历史、记忆和 skills。
- **会话隔离** —— 基于 SDK 的 `sessionKey`（按 agent + channel + peer 作用域），每个用户的聊天记录天然与其他人隔离。
- **与原插件共存** —— 插件 ID 是 `openclaw-lark-plus`，所以可以和 `@larksuite/openclaw-lark` 并存，方便迁移。

## 前置条件

- 已安装并运行 [OpenClaw](https://www.npmjs.com/package/openclaw)（`openclaw gateway` 服务已启动）
- Node.js >= 18
- 一个飞书/Lark 账号用于扫第一张二维码，成为管理员

## 安装

### 1. 克隆插件到 extensions 目录

```bash
mkdir -p ~/.openclaw/extensions
cd ~/.openclaw/extensions
git clone https://github.com/shyrock/openclaw-lark-plus.git
cd openclaw-lark-plus
npm install
```

### 2. 在 `~/.openclaw/openclaw.json` 中启用插件

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

> OpenClaw 内置的 `@openclaw/feishu` 通道驱动负责实际的飞书 WebSocket 连接 —— `openclaw-lark-plus` 在其之上叠加多用户管理、二维码注册和审批流。两者可以同时启用。

### 3. 重启网关

```bash
systemctl restart openclaw-gateway   # 或你用来运行网关的命令
```

## 引导首位管理员

这里有个先有鸡还是先有蛋的问题：`/feishu register` 是聊天命令，但现在还没有飞书机器人可以接收命令。所以第一个用户要通过 **CLI 安装命令**：

```bash
openclaw lark-plus-install
```

这会在终端打印一张二维码。用飞书/Lark 扫描：

1. 飞书为你的账号创建一个新的"个人助理"应用
2. CLI 轮询直到授权完成，收到新的 `client_id` / `client_secret`
3. 扫码用户被记录为 **管理员**，写入 `~/.openclaw/openclaw.json`
4. 自动写入 `accounts` 条目、`agents.list` 条目、该用户的 `bindings` 路由规则，并创建 workspace 目录（`~/.openclaw/workspaces/<admin-openId>`）
5. 重启网关 —— 你的个人飞书机器人就上线了

之后你就可以直接在飞书里私聊这个新机器人。

## 添加更多用户

管理员的机器人上线后，**在和管理员机器人的私聊里**运行：

```
/feishu register
```

机器人会回复一张二维码图片。把这张图转发/截图分享给新用户。

新用户扫码后：

1. 飞书为 TA 创建另一个独立的个人助理应用
2. 插件将注册存为 **待审批** 状态（凭据暂存在 `~/.openclaw/openclaw.json` 的 `channels.feishu.plus.pendingRegistrations` 下）
3. 管理员收到一条飞书通知，附带待审批 ID 和两个快捷审批命令

管理员批准或拒绝：

```
/feishu approve reg-xxxxx
/feishu reject  reg-xxxxx
```

批准后，插件为新用户写入完整账号（account + agent + binding + workspace 目录），并提示管理员重启网关。拒绝后，待审批凭据会被丢弃。

```bash
systemctl restart openclaw-gateway
```

重启后，新用户就可以直接私聊**自己的机器人**。

## 命令

下列命令均在和 `openclaw-lark-plus` 管理的机器人的飞书聊天中运行。

| 命令 | 权限 | 说明 |
|------|------|------|
| `/feishu register` | 管理员 | 生成二维码邀请新用户 |
| `/feishu approve <pending_id>` | 管理员 | 批准一条待审批注册 |
| `/feishu reject <pending_id>` | 管理员 | 拒绝并丢弃一条待审批注册 |
| `/feishu pending` | 管理员 | 列出所有待审批注册 |
| `/feishu users` | 管理员 | 列出已授权用户及其 account/agent 映射 |
| `/feishu doctor` | 任何人 | 运行配置诊断 |
| `/feishu help` | 任何人 | 显示帮助 |

终端下的引导命令：

| CLI | 说明 |
|-----|------|
| `openclaw lark-plus-install` | 交互式二维码流程，注册首位管理员 |

## 每用户隔离的实现原理

`openclaw-lark-plus` **没有**自带路由层。它直接写入 OpenClaw 原生的配置结构，让框架自己路由：

**1. 每个用户一个 `accounts` 条目**（在 `channels.feishu.accounts` 下） —— 每个用户拥有自己的 `appId`/`appSecret`，`dmPolicy: "allowlist"` 仅允许该用户自己的 `openId`。

**2. 每个用户一个 `agents.list` 条目** —— agent id 就是用户的 `openId`，`workspace` 是独立目录。

**3. 每个用户一条 `bindings` 规则** —— `{type: "route", agentId: <openId>, match: {channel: "feishu", peer: {kind: "direct", id: <openId>}}}` —— 告诉框架的 `resolveAgentRoute` 把该用户的私聊路由到 TA 自己的 agent。

**4. 默认 `main` agent 兜底** —— 永远被注入到 `agents.list` 的第一位，作为安全网。这样任何未绑定的流量（比如遗留的 channel 级 binding）都路由到真正的默认 agent，而不会静默穿透到别人的私人 agent。

因为每个用户都有唯一的 `agentId`，框架生成的 session key 变成：

```
agent:<用户-openId>:feishu:direct:<用户-openId>
```

……这意味着 **对话历史、记忆和 workspace 状态天然按用户隔离**。任意两个用户都不会共享 session。

### 自动生成的配置结构

一个管理员 + 一个普通用户注册完成后，`~/.openclaw/openclaw.json` 大致长这样：

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

你可以手动编辑任一 agent 的 `workspace`、`systemPromptOverride`、`skills`、`model` 等字段 —— 这些都是 OpenClaw SDK 中 `agents.list` 的标准字段，参见 OpenClaw SDK 文档。

## 架构

```
  /feishu register
        │
        ▼
飞书 /oauth/v1/app/registration (init → begin → poll)
        │
        ▼
  新用户扫码
        │
  ┌─────┴─────┐
  │           │
首位用户     后续用户
  │           │
  │           ▼
  │     存为 pending
  │     通知管理员
  │           │
  │     ┌─────┴─────┐
  │     ▼           ▼
  │   批准        拒绝
  │     │           │
  ▼     ▼           ▼
  └─► 写入 account + agent + binding + workspace
              │
              ▼
      重启网关 → 新机器人上线
```

### 关键文件

| 文件 | 作用 |
|------|------|
| `src/plugin/src/core/accounts-manager.js` | 多账号 CRUD、管理员追踪、pending 存储，并自动注入 `agents.list` + `bindings` + `main` 兜底 agent |
| `src/plugin/src/core/app-registration.js` | 飞书 App Registration API 客户端（init / begin / poll） |
| `src/plugin/src/commands/register.js` | `/feishu register`、`/feishu approve`、`/feishu reject`、`/feishu pending` |
| `src/plugin/src/commands/cli-install.js` | 终端版首位管理员引导（`openclaw lark-plus-install`） |
| `src/plugin/src/commands/users.js` | `/feishu users` —— 列出已注册账号及其绑定 |
| `src/plugin/index.js` | 插件入口；注册命令并校验配置 |

## 安全

- **管理员审批门** —— 只有首位注册的用户能批准新注册
- **配置文件权限 0600** —— 写入 `~/.openclaw/openclaw.json` 的凭据仅对属主 Unix 用户可读
- **被拒绝的凭据会被丢弃** —— `/feishu reject` 完全删除待审批条目
- **机器人级 DM 白名单** —— 每个用户的机器人都设置了 `dmPolicy: "allowlist"`，仅允许该用户自己的 `openId`，别人无法和该机器人对话
- **OAuth token 作用域隔离** —— OpenClaw SDK 按 `{appId}:{userOpenId}` 存储 token，无法跨机器人泄露
- **每用户 workspace 隔离** —— 每个机器人的 agent 运行在独立目录 `~/.openclaw/workspaces/<openId>` 下，文件、记忆和工具状态在磁盘上物理隔离

## 故障排查

**启动时报 "Channel already registered: feishu"**
: 无害 —— 意味着本插件和 OpenClaw 内置的 `@openclaw/feishu` 都尝试注册了通道。内置驱动胜出并处理 WebSocket，本插件负责多用户命令和配置写入。

**新用户的消息被路由到管理员的 agent（或反过来）**
: 这是 `pickFirstExistingAgentId` 兜底机制咬到你了 —— 意味着 `agents.list` 缺少 `main` 条目，某条 channel 级 binding 把所有流量静默路由到了列表中的第 0 个 agent。请升级到最新的 `openclaw-lark-plus`（`main` 兜底注入已修复此问题），或手动在 `agents.list` **最前面** 加上 `{"id": "main", "name": "main", "default": true}` 然后重启。

**管理员运行 `/feishu register` 没反应**
: 查 `journalctl -u openclaw-gateway | grep register` —— 最常见的原因是管理员自己的 `dmPolicy: "allowlist"` 不包含自己的 `openId`。重新运行 `openclaw lark-plus-install` 重建管理员条目。

**批准后新机器人没上线**
: 需要重启网关（`systemctl restart openclaw-gateway`）—— OpenClaw 只在启动时读取 `channels.feishu.accounts`，热重载只能感知已存在账号的变更，无法感知新增账号。

## 许可证

MIT
