"use strict";
/**
 * [openclaw-lark-plus] Dynamic account management.
 *
 * Provides helpers to add/remove Feishu accounts at runtime by
 * reading and writing the OpenClaw config file (~/.openclaw/openclaw.json).
 *
 * Also manages:
 *   - Admin identity (first registered user)
 *   - Pending registrations (awaiting admin approval)
 *
 * After writing, the plugin's config reload mechanism
 * (reload.configPrefixes: ['channels.feishu']) picks up changes automatically.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.addFeishuAccount = addFeishuAccount;
exports.removeFeishuAccount = removeFeishuAccount;
exports.getConfigFilePath = getConfigFilePath;
exports.readOpenClawConfig = readOpenClawConfig;
exports.writeOpenClawConfig = writeOpenClawConfig;
exports.getAdmin = getAdmin;
exports.setAdmin = setAdmin;
exports.isAdmin = isAdmin;
exports.addPendingRegistration = addPendingRegistration;
exports.getPendingRegistration = getPendingRegistration;
exports.listPendingRegistrations = listPendingRegistrations;
exports.removePendingRegistration = removePendingRegistration;

const fs = require("fs");
const path = require("path");
const os = require("os");
const lark_logger_1 = require("./lark-logger.js");
const log = (0, lark_logger_1.larkLogger)('core/accounts-manager');

// ---------------------------------------------------------------------------
// Config file I/O
// ---------------------------------------------------------------------------

function getConfigFilePath() {
    const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
    return path.join(stateDir, 'openclaw.json');
}

function readOpenClawConfig() {
    const configPath = getConfigFilePath();
    if (!fs.existsSync(configPath)) {
        return {};
    }
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
}

function writeOpenClawConfig(config) {
    const configPath = getConfigFilePath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    log.info(`config written to ${configPath}`);
}

// ---------------------------------------------------------------------------
// plus namespace helper (channels.feishu.plus)
// ---------------------------------------------------------------------------

function ensurePlus(config) {
    if (!config.channels) config.channels = {};
    if (!config.channels.feishu) config.channels.feishu = {};
    if (!config.channels.feishu.plus) config.channels.feishu.plus = {};
    return config.channels.feishu.plus;
}

function getPlus(config) {
    return config?.channels?.feishu?.plus;
}

// ---------------------------------------------------------------------------
// Admin management
// ---------------------------------------------------------------------------

/**
 * Get the current admin info.
 * @returns {{ openId: string, accountId: string } | null}
 */
function getAdmin() {
    const config = readOpenClawConfig();
    const plus = getPlus(config);
    if (!plus?.adminOpenId) return null;
    return {
        openId: plus.adminOpenId,
        accountId: plus.adminAccountId,
    };
}

/**
 * Set the admin (first registered user).
 * @param {string} openId
 * @param {string} accountId
 */
function setAdmin(openId, accountId) {
    const config = readOpenClawConfig();
    const plus = ensurePlus(config);
    plus.adminOpenId = openId;
    plus.adminAccountId = accountId;
    writeOpenClawConfig(config);
    log.info(`admin set: openId=${openId}, accountId=${accountId}`);
}

/**
 * Check if an openId is the admin.
 */
function isAdmin(openId) {
    const admin = getAdmin();
    return admin !== null && admin.openId === openId;
}

// ---------------------------------------------------------------------------
// Pending registrations
// ---------------------------------------------------------------------------

/**
 * Add a pending registration awaiting admin approval.
 * @param {object} reg
 * @param {string} reg.pendingId   - Unique pending ID
 * @param {string} reg.appId
 * @param {string} reg.appSecret
 * @param {string} [reg.openId]
 * @param {string} [reg.domain]
 * @param {string} [reg.agentId]
 * @param {object} [reg.workspace]
 */
function addPendingRegistration(reg) {
    const config = readOpenClawConfig();
    const plus = ensurePlus(config);
    if (!plus.pendingRegistrations) plus.pendingRegistrations = {};
    plus.pendingRegistrations[reg.pendingId] = {
        appId: reg.appId,
        appSecret: reg.appSecret,
        openId: reg.openId,
        domain: reg.domain,
        agentId: reg.agentId,
        workspace: reg.workspace,
        requestedAt: Date.now(),
    };
    writeOpenClawConfig(config);
    log.info(`pending registration added: ${reg.pendingId} (appId=${reg.appId})`);
}

/**
 * Get a specific pending registration.
 * @param {string} pendingId
 * @returns {object | null}
 */
function getPendingRegistration(pendingId) {
    const config = readOpenClawConfig();
    const plus = getPlus(config);
    return plus?.pendingRegistrations?.[pendingId] ?? null;
}

/**
 * List all pending registrations.
 * @returns {Array<{ pendingId: string, ...reg }>}
 */
function listPendingRegistrations() {
    const config = readOpenClawConfig();
    const plus = getPlus(config);
    const pending = plus?.pendingRegistrations;
    if (!pending) return [];
    return Object.entries(pending).map(([id, reg]) => ({ pendingId: id, ...reg }));
}

/**
 * Remove a pending registration (after approval or rejection).
 * @param {string} pendingId
 * @returns {object | null} The removed registration, or null if not found
 */
function removePendingRegistration(pendingId) {
    const config = readOpenClawConfig();
    const plus = getPlus(config);
    if (!plus?.pendingRegistrations?.[pendingId]) return null;

    const reg = plus.pendingRegistrations[pendingId];
    delete plus.pendingRegistrations[pendingId];

    if (Object.keys(plus.pendingRegistrations).length === 0) {
        delete plus.pendingRegistrations;
    }

    writeOpenClawConfig(config);
    log.info(`pending registration removed: ${pendingId}`);
    return reg;
}

// ---------------------------------------------------------------------------
// Account CRUD
// ---------------------------------------------------------------------------

/**
 * Add a new Feishu account to the OpenClaw config.
 *
 * @param {object} params
 * @param {string} params.accountId   - Unique account identifier
 * @param {string} params.appId       - Feishu App ID (client_id)
 * @param {string} params.appSecret   - Feishu App Secret (client_secret)
 * @param {string} [params.domain]    - "feishu" or "lark"
 * @param {string} [params.openId]    - The scanning user's open_id
 * @param {string} [params.agentId]   - Agent ID to assign
 * @param {object} [params.workspace] - Workspace config
 * @returns {{ accountId: string, config: object }}
 */
function addFeishuAccount(params) {
    const { accountId, appId, appSecret, domain, openId, agentId, workspace } = params;
    const config = readOpenClawConfig();

    if (!config.channels) config.channels = {};
    if (!config.channels.feishu) config.channels.feishu = {};
    const feishu = config.channels.feishu;

    if (!feishu.accounts) feishu.accounts = {};

    const accountCfg = {
        appId,
        appSecret,
        enabled: true,
        dmPolicy: 'open',
    };
    if (domain) accountCfg.domain = domain;
    if (openId) {
        accountCfg.dmPolicy = 'allowlist';
        accountCfg.allowFrom = [openId];
    }

    feishu.accounts[accountId] = accountCfg;

    const effectiveAgentId = agentId || accountId;

    // Per-user agent + workspace isolation via the framework's native
    // routing system (config.agents.list + config.bindings).
    //
    // This is the documented way to give each user their own agent
    // identity, workspace directory, system prompt, skills, etc.
    // The framework's resolveAgentRoute() will pick the per-user agent
    // automatically when the user's openId matches a binding rule.
    if (openId) {
        // 1. Define the agent in config.agents.list
        if (!config.agents) config.agents = {};
        if (!Array.isArray(config.agents.list)) config.agents.list = [];

        // Safety net: ensure a `main` agent exists.
        //
        // Any channel-wide binding (e.g. legacy `{agentId: "main", match: {channel: "feishu"}}`)
        // and the framework's default routing both resolve to `agentId: "main"`.
        // If `main` isn't in `agents.list`, the SDK's `pickFirstExistingAgentId`
        // falls back to the FIRST agent in the list — which is whichever per-user
        // agent happens to be at index 0. That causes unrelated users (including
        // the admin) to get routed into some other user's session.
        //
        // Defining `main` explicitly keeps the fallback well-behaved: un-bound
        // users land on a real default agent instead of hijacking someone else's.
        if (!config.agents.list.some(a => a?.id === 'main')) {
            config.agents.list.unshift({
                id: 'main',
                name: 'main',
                default: true,
            });
        }

        const existingAgentIdx = config.agents.list.findIndex(a => a?.id === effectiveAgentId);
        const agentEntry = {
            id: effectiveAgentId,
            name: workspace?.name || effectiveAgentId,
        };
        // Per-user workspace directory under ~/.openclaw/workspaces/<user>
        const wsDir = workspace?.dir || path.join(os.homedir(), '.openclaw', 'workspaces', effectiveAgentId);
        try {
            fs.mkdirSync(wsDir, { recursive: true });
        } catch (err) {
            log.warn(`failed to create workspace dir ${wsDir}: ${err}`);
        }
        agentEntry.workspace = wsDir;

        if (existingAgentIdx >= 0) {
            config.agents.list[existingAgentIdx] = { ...config.agents.list[existingAgentIdx], ...agentEntry };
        } else {
            config.agents.list.push(agentEntry);
        }

        // 2. Bind the user's openId to that agent via config.bindings
        if (!Array.isArray(config.bindings)) config.bindings = [];
        const bindingExists = config.bindings.some(b =>
            b?.type === 'route' &&
            b?.agentId === effectiveAgentId &&
            b?.match?.channel === 'feishu' &&
            b?.match?.accountId === accountId &&
            b?.match?.peer?.id === openId
        );
        if (!bindingExists) {
            config.bindings.push({
                type: 'route',
                agentId: effectiveAgentId,
                comment: `[openclaw-lark-plus] auto-binding for ${workspace?.name || openId}`,
                match: {
                    channel: 'feishu',
                    accountId,
                    peer: { kind: 'direct', id: openId },
                },
            });
        }
    }

    if (!config.plugins) config.plugins = {};
    if (!config.plugins.allow) config.plugins.allow = [];
    if (!config.plugins.allow.includes('openclaw-lark-plus')) {
        config.plugins.allow.push('openclaw-lark-plus');
    }

    writeOpenClawConfig(config);
    log.info(`account added: ${accountId} (appId=${appId}, agent=${effectiveAgentId})`);

    return { accountId, config };
}

/**
 * Remove a Feishu account from the OpenClaw config.
 */
function removeFeishuAccount(accountId) {
    const config = readOpenClawConfig();
    const feishu = config.channels?.feishu;
    if (!feishu?.accounts?.[accountId]) {
        return false;
    }

    delete feishu.accounts[accountId];

    if (Object.keys(feishu.accounts).length === 0) {
        delete feishu.accounts;
    }

    writeOpenClawConfig(config);
    log.info(`account removed: ${accountId}`);
    return true;
}
