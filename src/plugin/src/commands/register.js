"use strict";
/**
 * [openclaw-lark-plus] /feishu_register and approval commands.
 *
 * Security model:
 *   - First scan: auto-approved, becomes admin
 *   - Subsequent scans: pending admin approval via Feishu message
 *   - Admin approves/rejects via /feishu approve|reject <id>
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRegisterCommand = registerRegisterCommand;
exports.runRegisterFlow = runRegisterFlow;
exports.approveRegistration = approveRegistration;
exports.rejectRegistration = rejectRegistration;
exports.listPending = listPending;

const QRCode = require("qrcode");
const app_registration_1 = require("../core/app-registration.js");
const accounts_manager_1 = require("../core/accounts-manager.js");
const accounts_1 = require("../core/accounts.js");
const lark_client_1 = require("../core/lark-client.js");
const app_owner_fallback_1 = require("../core/app-owner-fallback.js");
const lark_logger_1 = require("../core/lark-logger.js");
const log = (0, lark_logger_1.larkLogger)('commands/register');

// ---------------------------------------------------------------------------
// User name resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve a Feishu user's display name using an existing bot's credentials.
 * Returns the name, or '' if resolution fails.
 *
 * @param {string} openId - Target user's open_id
 * @param {object} cfg - OpenClaw config (to find admin's bot account)
 * @returns {Promise<string>}
 */
async function resolveDisplayName(openId, cfg) {
    try {
        const admin = (0, accounts_manager_1.getAdmin)();
        if (!admin) return '';
        const account = (0, accounts_1.getLarkAccount)(cfg, admin.accountId);
        if (!account?.configured) return '';
        const client = lark_client_1.LarkClient.fromAccount(account).sdk;
        const res = await client.contact.user.get({
            path: { user_id: openId },
            params: { user_id_type: 'open_id' },
        });
        return res?.data?.user?.name
            || res?.data?.user?.display_name
            || res?.data?.user?.nickname
            || res?.data?.user?.en_name
            || '';
    } catch (err) {
        log.warn(`failed to resolve display name for ${openId}: ${err}`);
        return '';
    }
}

/**
 * Build a human-readable ID from display name and open_id.
 * e.g. "张三-a1b2" or "ou_xxxx" as fallback.
 */
function buildUserLabel(displayName, openId) {
    const suffix = openId ? openId.slice(-4) : '';
    if (displayName) {
        return `${displayName}-${suffix}`;
    }
    return openId || 'unknown';
}

// ---------------------------------------------------------------------------
// I18n
// ---------------------------------------------------------------------------

const T = {
    zh_cn: {
        qrReady: (qrUrl, expireMin) =>
            `📱 **新用户注册二维码已生成**\n\n` +
            `请将二维码转发给新用户，用飞书扫码即可注册：\n\n` +
            `🔗 ${qrUrl}\n\n` +
            `⏰ 有效期：${expireMin} 分钟\n\n` +
            `⏳ 正在后台等待扫码结果，扫码完成后需管理员审批...`,
        firstUserSuccess: (accountId, appId, openId) =>
            `✅ **首位用户注册成功（已设为管理员）**\n\n` +
            `  • 账号 ID: \`${accountId}\`\n` +
            `  • App ID: \`${appId}\`\n` +
            `  • 管理员 Open ID: \`${openId}\`\n\n` +
            `🔑 您是管理员，后续用户注册需要您审批。\n` +
            `运行 \`openclaw gateway restart\` 使 Bot 生效。`,
        pendingApproval: (pendingId, appId, openId) =>
            `⏳ **新用户待审批**\n\n` +
            `  • 待审批 ID: \`${pendingId}\`\n` +
            `  • App ID: \`${appId}\`\n` +
            `  • 用户 Open ID: \`${openId || '(未知)'}\`\n\n` +
            `已通知管理员审批。`,
        adminNotify: (pendingId, appId, openId, displayName) =>
            `🔔 **新用户注册申请**\n\n` +
            `  • 待审批 ID: \`${pendingId}\`\n` +
            (displayName ? `  • 用户名: \`${displayName}\`\n` : '') +
            `  • App ID: \`${appId}\`\n` +
            `  • 用户 Open ID: \`${openId || '(未知)'}\`\n\n` +
            `请回复以下命令进行审批：\n` +
            `  ✅ \`/feishu approve ${pendingId}\`\n` +
            `  ❌ \`/feishu reject ${pendingId}\``,
        approved: (pendingId, accountId) =>
            `✅ **已批准注册** \`${pendingId}\`\n\n` +
            `账号 \`${accountId}\` 已写入配置。\n` +
            `运行 \`openclaw gateway restart\` 使新 Bot 生效。`,
        rejected: (pendingId) =>
            `❌ **已拒绝注册** \`${pendingId}\`\n\n凭据已丢弃，该用户需要重新扫码注册。`,
        notFound: (pendingId) => `⚠️ 未找到待审批记录: \`${pendingId}\``,
        notAdmin: '❌ 仅管理员可执行此操作',
        noAdmin: '⚠️ 尚未设置管理员（等待第一位用户完成扫码注册）',
        noPending: '📋 当前无待审批的注册请求',
        pendingList: (items) => {
            const lines = ['📋 **待审批注册列表**\n'];
            for (const item of items) {
                const age = Math.floor((Date.now() - item.requestedAt) / 60000);
                const who = item.displayName || item.openId || '-';
                lines.push(`  • \`${item.pendingId}\` | 用户: \`${who}\` | App: \`${item.appId}\` | ${age} 分钟前`);
            }
            lines.push(`\n审批命令：\`/feishu approve <id>\` 或 \`/feishu reject <id>\``);
            return lines.join('\n');
        },
        scanFailed: (err) => `❌ 注册失败: ${err}`,
        usage:
            '用法: /feishu register [agent_id]\n\n' +
            '生成新用户注册二维码。\n' +
            '  • 第一个扫码的用户自动成为管理员\n' +
            '  • 后续用户需管理员审批\n\n' +
            '审批命令：\n' +
            '  /feishu approve <pending_id> - 批准注册\n' +
            '  /feishu reject <pending_id>  - 拒绝注册\n' +
            '  /feishu pending              - 查看待审批列表',
    },
};

// ---------------------------------------------------------------------------
// Core registration flow
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {string} [params.agentId]
 * @param {object} [params.cfg] - OpenClaw config (for resolving user display names)
 * @param {string} [params.adminSenderId] - The open_id of the person invoking /feishu register
 * @param {string} [params.adminAccountId] - The accountId the admin is using
 * @param {string} [params.locale]
 * @param {(msg: string) => void} [params.sendToAdmin] - Send message to admin's chat
 * @param {(msg: string) => void} [params.sendToRequester] - Send follow-up to requester's chat
 * @param {(pngBuffer: Buffer) => Promise<void>} [params.sendImageToRequester] - Send QR image to requester's chat
 */
async function runRegisterFlow(params = {}) {
    const { agentId, cfg, adminSenderId, adminAccountId, locale = 'zh_cn', sendToAdmin, sendToRequester, sendImageToRequester } = params;
    const t = T[locale] || T.zh_cn;

    // Auto-set admin if not yet configured.
    // The person who ran `openclaw feishu install` is the bot owner — detect via API.
    // Fall back to the command sender's open_id.
    if (!(0, accounts_manager_1.getAdmin)()) {
        let ownerOpenId = adminSenderId;
        if (cfg && adminAccountId) {
            try {
                const account = (0, accounts_1.getLarkAccount)(cfg, adminAccountId);
                if (account?.configured) {
                    const sdk = lark_client_1.LarkClient.fromAccount(account).sdk;
                    const detected = await (0, app_owner_fallback_1.getAppOwnerFallback)(account, sdk);
                    if (detected) ownerOpenId = detected;
                }
            } catch (err) {
                log.warn(`failed to detect bot owner, using sender: ${err}`);
            }
        }
        (0, accounts_manager_1.setAdmin)(ownerOpenId, adminAccountId || 'default');
        log.info(`auto-set admin: openId=${ownerOpenId}, accountId=${adminAccountId || 'default'}`);
    }

    const session = await (0, app_registration_1.createRegistrationSession)();
    const expireMin = Math.floor(session.expireIn / 60);

    // Generate and send QR code image
    if (sendImageToRequester) {
        QRCode.toBuffer(session.qrUrl, { type: 'png', width: 300, margin: 2 }, (err, pngBuffer) => {
            if (err) {
                log.warn(`QR code generation failed: ${err}`);
                return;
            }
            sendImageToRequester(pngBuffer).catch(e => log.warn(`QR image send failed: ${e}`));
        });
    }

    // Background poll — new user scans QR, gets pending approval
    session.waitForScan().then(async (result) => {
        // Resolve user display name via admin's bot
        const displayName = cfg ? await resolveDisplayName(result.openId, cfg) : '';
        const userLabel = buildUserLabel(displayName, result.openId);
        const userAgentId = agentId || userLabel;
        const pendingId = `reg-${Date.now().toString(36)}`;

        try {
            (0, accounts_manager_1.addPendingRegistration)({
                pendingId,
                appId: result.appId,
                appSecret: result.appSecret,
                openId: result.openId,
                domain: result.domain,
                agentId: userAgentId,
                workspace: { name: userLabel },
                displayName,
            });

            log.info(`pending registration: ${pendingId} (${displayName || result.openId}, awaiting admin approval)`);

            // Notify requester (the admin who ran /feishu register)
            if (sendToRequester) {
                sendToRequester(t.pendingApproval(pendingId, result.appId, result.openId));
            }

            // Notify admin
            if (sendToAdmin) {
                sendToAdmin(t.adminNotify(pendingId, result.appId, result.openId, displayName));
            }
        } catch (err) {
            log.error(`failed to store pending registration: ${err}`);
            if (sendToRequester) sendToRequester(t.scanFailed(String(err)));
        }
    }).catch((err) => {
        log.warn(`registration poll failed: ${err}`);
        if (sendToRequester) sendToRequester(t.scanFailed(String(err)));
    });

    return t.qrReady(session.qrUrl, expireMin);
}

// ---------------------------------------------------------------------------
// Approve / Reject
// ---------------------------------------------------------------------------

/**
 * Approve a pending registration — creates the account.
 * @param {string} pendingId
 * @returns {string} Result message
 */
function approveRegistration(pendingId) {
    const t = T.zh_cn;
    const reg = (0, accounts_manager_1.getPendingRegistration)(pendingId);
    if (!reg) return t.notFound(pendingId);

    const userLabel = buildUserLabel(reg.displayName || '', reg.openId);
    const accountId = userLabel;
    (0, accounts_manager_1.addFeishuAccount)({
        accountId,
        appId: reg.appId,
        appSecret: reg.appSecret,
        domain: reg.domain,
        openId: reg.openId,
        agentId: reg.agentId || userLabel,
        workspace: reg.workspace || { name: userLabel },
    });

    (0, accounts_manager_1.removePendingRegistration)(pendingId);
    log.info(`registration approved: ${pendingId} -> ${accountId}`);
    return t.approved(pendingId, accountId);
}

/**
 * Reject a pending registration — discards credentials.
 * @param {string} pendingId
 * @returns {string} Result message
 */
function rejectRegistration(pendingId) {
    const t = T.zh_cn;
    const reg = (0, accounts_manager_1.removePendingRegistration)(pendingId);
    if (!reg) return t.notFound(pendingId);

    log.info(`registration rejected: ${pendingId}`);
    return t.rejected(pendingId);
}

/**
 * List pending registrations.
 * @returns {string}
 */
function listPending() {
    const t = T.zh_cn;
    const items = (0, accounts_manager_1.listPendingRegistrations)();
    if (items.length === 0) return t.noPending;
    return t.pendingList(items);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

function registerRegisterCommand(api) {
    api.registerCommand({
        name: 'feishu_register',
        description: '[openclaw-lark-plus] Generate QR code for new user registration (admin approval required)',
        acceptsArgs: true,
        requireAuth: true,
        async handler(ctx) {
            const args = ctx.args?.trim().split(/\s+/) || [];
            const subArg = args[0]?.toLowerCase();

            if (subArg === 'help' || subArg === '-h') {
                return { text: T.zh_cn.usage };
            }

            const agentId = args[0] || undefined;

            try {
                const admin = (0, accounts_manager_1.getAdmin)();

                // Build message senders
                const makeSender = (toOpenId, toAccountId) => {
                    if (!toOpenId || !toAccountId) return undefined;
                    return (msg) => {
                        try {
                            const send = require("../messaging/outbound/send.js");
                            send.sendMessageFeishu({
                                cfg: ctx.config,
                                to: toOpenId,
                                text: msg,
                                accountId: toAccountId,
                            }).catch(err => log.error(`send failed: ${err}`));
                        } catch (err) {
                            log.error(`send error: ${err}`);
                        }
                    };
                };

                const sendToAdmin = admin ? makeSender(admin.openId, admin.accountId) : undefined;
                // Requester gets follow-up in the current chat
                const sendToRequester = (ctx.to || ctx.senderId)
                    ? (msg) => {
                        try {
                            const send = require("../messaging/outbound/send.js");
                            send.sendMessageFeishu({
                                cfg: ctx.config,
                                to: (ctx.to || ctx.senderId),
                                text: msg,
                                accountId: ctx.accountId,
                            }).catch(err => log.error(`send failed: ${err}`));
                        } catch (err) {
                            log.error(`send error: ${err}`);
                        }
                    }
                    : undefined;

                // Send QR code as image to requester's chat
                const sendImageToRequester = (ctx.to || ctx.senderId)
                    ? async (pngBuffer) => {
                        const media = require("../messaging/outbound/media.js");
                        const { imageKey } = await media.uploadImageLark({
                            cfg: ctx.config,
                            image: pngBuffer,
                            imageType: 'message',
                            accountId: ctx.accountId,
                        });
                        await media.sendImageLark({
                            cfg: ctx.config,
                            to: (ctx.to || ctx.senderId),
                            imageKey,
                            accountId: ctx.accountId,
                        });
                    }
                    : undefined;

                const text = await runRegisterFlow({
                    agentId,
                    cfg: ctx.config,
                    adminSenderId: ctx.senderId,
                    adminAccountId: ctx.accountId,
                    locale: 'zh_cn',
                    sendToAdmin,
                    sendToRequester,
                    sendImageToRequester,
                });

                return { text };
            } catch (err) {
                return { text: T.zh_cn.scanFailed(err instanceof Error ? err.message : String(err)) };
            }
        },
    });
}
