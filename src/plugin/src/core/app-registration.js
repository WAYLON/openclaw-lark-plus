"use strict";
/**
 * [openclaw-lark-plus] Feishu App Registration session helper.
 *
 * Delegates to the original FeishuAuth class from @larksuite/openclaw-lark-tools
 * to ensure identical behavior with the original `openclaw feishu install` flow.
 *
 * Flow:
 *   1. init()  → initialize registration session
 *   2. begin() → get QR-code URL (archetype=PersonalAgent)
 *   3. poll()  → wait for user scan, returns client_id + client_secret
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRegistrationSession = createRegistrationSession;

const { FeishuAuth } = require("@larksuite/openclaw-lark-tools/dist/utils/feishu-auth");
const lark_logger_1 = require("./lark-logger.js");
const log = (0, lark_logger_1.larkLogger)('core/app-registration');

// ---------------------------------------------------------------------------
// High-level session helper
// ---------------------------------------------------------------------------

/**
 * Create a registration session and return { qrUrl, waitForScan }.
 *
 * Uses the original FeishuAuth from @larksuite/openclaw-lark-tools
 * to ensure identical behavior with `openclaw feishu install`.
 *
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Abort signal to cancel polling
 * @returns {Promise<{ qrUrl: string, deviceCode: string, waitForScan: () => Promise<RegistrationResult> }>}
 */
async function createRegistrationSession(options = {}) {
    const auth = new FeishuAuth();

    // Step 1: init (identical to original install-prompts.js flow)
    const initRes = await auth.init();
    if (!initRes.supported_auth_methods?.includes('client_secret')) {
        throw new Error('Feishu registration API does not support client_secret auth method');
    }

    // Step 2: begin (identical to original)
    const beginRes = await auth.begin();
    const qrUrl = new URL(beginRes.verification_uri_complete);
    qrUrl.searchParams.set('from', 'onboard');
    const qrUrlStr = qrUrl.toString();
    const deviceCode = beginRes.device_code;
    const interval = beginRes.interval || 5;
    const expireIn = beginRes.expire_in || 600;

    log.info(`registration session created, deviceCode=${deviceCode.slice(0, 8)}..., expire=${expireIn}s`);

    // Step 3: return poll function (replicates original install-prompts.js polling)
    const waitForScan = () => pollUntilComplete(auth, deviceCode, interval, expireIn, options.signal);

    return { qrUrl: qrUrlStr, deviceCode, expireIn, waitForScan };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Poll loop — identical logic to the original install-prompts.js handleNewInstallation().
 * Uses FeishuAuth.setDomain() for Lark tenant brand switching.
 */
async function pollUntilComplete(auth, deviceCode, intervalS, expireIn, signal) {
    const startTime = Date.now();
    let currentInterval = intervalS;
    let isLark = false;
    let domainSwitched = false;

    while (Date.now() - startTime < expireIn * 1000) {
        if (signal?.aborted) {
            throw new Error('Registration cancelled');
        }

        const res = await auth.poll(deviceCode);

        // Check tenant brand for domain switching (same as original)
        if (res.user_info?.tenant_brand) {
            isLark = res.user_info.tenant_brand === 'lark';
            if (!domainSwitched && isLark) {
                auth.setDomain(isLark);
                domainSwitched = true;
                log.info('tenant is lark, switching domain');
                continue;
            }
        }

        // Success: got credentials
        if (res.client_id && res.client_secret) {
            const domain = isLark ? 'lark' : 'feishu';
            log.info(`registration complete: appId=${res.client_id}, openId=${res.user_info?.open_id}, domain=${domain}`);
            return {
                appId: res.client_id,
                appSecret: res.client_secret,
                openId: res.user_info?.open_id,
                domain,
            };
        }

        // Handle errors (same as original)
        if (res.error) {
            if (res.error === 'authorization_pending') {
                // Normal — keep polling
            } else if (res.error === 'slow_down') {
                currentInterval += 5;
            } else if (res.error === 'access_denied') {
                throw new Error('User denied authorization');
            } else if (res.error === 'expired_token') {
                throw new Error('Registration session expired');
            } else {
                throw new Error(`Registration error: ${res.error} - ${res.error_description || ''}`);
            }
        }

        await sleep(currentInterval * 1000, signal);
    }

    throw new Error('Registration timed out');
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('Aborted'));
            }, { once: true });
        }
    });
}
