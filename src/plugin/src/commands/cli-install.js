"use strict";
/**
 * [openclaw-lark-plus] CLI install command.
 *
 * Provides `openclaw lark-plus-install` — a terminal-based setup flow
 * that creates a Feishu bot via QR code scanning and sets the scanning
 * user as admin.
 *
 * Replicates the original `openclaw feishu install` flow using
 * FeishuAuth from @larksuite/openclaw-lark-tools, but is completely
 * independent of the original plugin.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCliInstall = registerCliInstall;

const { FeishuAuth } = require("@larksuite/openclaw-lark-tools/dist/utils/feishu-auth");
const accounts_manager_1 = require("../core/accounts-manager.js");

// ---------------------------------------------------------------------------
// CLI install flow
// ---------------------------------------------------------------------------

/**
 * Interactive terminal install: show QR → user scans → store credentials → set admin.
 */
async function runCliInstall() {
    const chalk = await loadChalk();
    const auth = new FeishuAuth();

    // 1. Init
    console.log(chalk.cyan('\n[openclaw-lark-plus] 初始化注册会话...\n'));
    const initRes = await auth.init();
    if (!initRes.supported_auth_methods?.includes('client_secret')) {
        console.error(chalk.red('错误: 当前环境不支持 client_secret 认证方式'));
        process.exitCode = 1;
        return;
    }

    // 2. Begin — get QR URL
    const beginRes = await auth.begin();
    const qrUrl = new URL(beginRes.verification_uri_complete);
    qrUrl.searchParams.set('from', 'onboard');
    const qrUrlStr = qrUrl.toString();

    console.log(chalk.cyan('请使用飞书扫码，配置机器人 (Scan with Feishu to configure your bot):\n'));
    FeishuAuth.printQRCode(qrUrlStr);
    console.log(`\n${chalk.underline(qrUrlStr)}\n`);

    // 3. Poll for scan completion
    const startTime = Date.now();
    let currentInterval = beginRes.interval || 5;
    const expireIn = beginRes.expire_in || 600;
    let isLark = false;
    let domainSwitched = false;

    process.stdout.write(chalk.yellow('正在等待扫码结果...'));

    while (Date.now() - startTime < expireIn * 1000) {
        const pollRes = await auth.poll(beginRes.device_code);

        // Domain switching for Lark tenants
        if (pollRes.user_info?.tenant_brand) {
            isLark = pollRes.user_info.tenant_brand === 'lark';
            if (!domainSwitched && isLark) {
                auth.setDomain(isLark);
                domainSwitched = true;
                continue;
            }
        }

        // Success
        if (pollRes.client_id && pollRes.client_secret) {
            console.log(chalk.green('\n\n✓ 机器人配置成功! (Bot configured successfully!)\n'));

            const domain = isLark ? 'lark' : 'feishu';
            const openId = pollRes.user_info?.open_id;
            const accountId = 'default';

            // Write to openclaw.json
            const config = accounts_manager_1.readOpenClawConfig();
            if (!config.channels) config.channels = {};
            if (!config.channels.feishu) config.channels.feishu = {};
            const feishu = config.channels.feishu;

            feishu.appId = pollRes.client_id;
            feishu.appSecret = pollRes.client_secret;
            feishu.domain = domain;
            feishu.enabled = true;
            feishu.connectionMode = feishu.connectionMode || 'websocket';
            feishu.dmPolicy = 'open';

            // Ensure plugin is allowed and enabled
            if (!config.plugins) config.plugins = {};
            if (!config.plugins.allow) config.plugins.allow = [];
            if (!config.plugins.allow.includes('openclaw-lark-plus')) {
                config.plugins.allow.push('openclaw-lark-plus');
            }
            if (!config.plugins.entries) config.plugins.entries = {};
            if (!config.plugins.entries['openclaw-lark-plus']) {
                config.plugins.entries['openclaw-lark-plus'] = { enabled: true };
            }
            // The framework keys channel entries by channel ID ("feishu"),
            // not by plugin ID. If this entry is disabled/missing, the
            // gateway will silently skip loading our plugin.
            config.plugins.entries['feishu'] = { enabled: true };

            // Set admin and grant command authorization
            if (openId) {
                const plus = config.channels.feishu.plus || {};
                plus.adminOpenId = openId;
                plus.adminAccountId = accountId;
                config.channels.feishu.plus = plus;

                // Add admin to allowFrom so commands with requireAuth work.
                // dmPolicy:'open' only bypasses the DM gate — command auth
                // is a separate check against the allowFrom list.
                if (!feishu.allowFrom) feishu.allowFrom = [];
                if (!feishu.allowFrom.includes(openId)) {
                    feishu.allowFrom.push(openId);
                }
            }

            accounts_manager_1.writeOpenClawConfig(config);

            console.log(`  App ID:    ${chalk.green(pollRes.client_id)}`);
            console.log(`  Domain:    ${chalk.green(domain)}`);
            if (openId) {
                console.log(`  Admin:     ${chalk.green(openId)}`);
            }
            console.log(`\n${chalk.cyan('配置已写入，正在重启 gateway...')}\n`);
            try {
                const { execSync } = require('child_process');
                execSync('openclaw gateway restart', { stdio: 'inherit' });
                console.log(`\n${chalk.green('✓ Gateway 已重启')}`);
            } catch (e) {
                console.log(`\n${chalk.yellow('⚠ Gateway 重启失败，请手动运行:')} ${chalk.bold('openclaw gateway restart')}`);
            }
            console.log(`\n${chalk.cyan('在飞书中发送 /feishu register 为其他用户生成注册二维码。')}\n`);
            return;
        }

        // Handle errors
        if (pollRes.error) {
            if (pollRes.error === 'authorization_pending') {
                process.stdout.write('.');
            } else if (pollRes.error === 'slow_down') {
                currentInterval += 5;
            } else if (pollRes.error === 'access_denied') {
                console.log(chalk.red('\n\n✗ 用户拒绝授权 (User denied authorization)'));
                process.exitCode = 1;
                return;
            } else if (pollRes.error === 'expired_token') {
                console.log(chalk.red('\n\n✗ 会话过期，请重试 (Session expired)'));
                process.exitCode = 1;
                return;
            } else {
                console.log(chalk.red(`\n\n✗ 错误: ${pollRes.error} - ${pollRes.error_description || ''}`));
                process.exitCode = 1;
                return;
            }
        }

        await new Promise(resolve => setTimeout(resolve, currentInterval * 1000));
    }

    console.log(chalk.red('\n\n✗ 超时，请重试 (Timed out)'));
    process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// chalk loader (optional dependency)
// ---------------------------------------------------------------------------

async function loadChalk() {
    try {
        return require('chalk');
    } catch {
        // Minimal fallback if chalk is not available
        const noop = (s) => s;
        return {
            cyan: noop, green: noop, red: noop, yellow: noop,
            bold: noop, underline: noop,
        };
    }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function registerCliInstall(api) {
    api.registerCli((ctx) => {
        ctx.program
            .command('lark-plus-install')
            .description('[openclaw-lark-plus] 扫码配置飞书机器人并设置管理员')
            .action(async () => {
                try {
                    await runCliInstall();
                } catch (err) {
                    console.error(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
                    process.exitCode = 1;
                }
            });
    }, { commands: ['lark-plus-install'] });
}
