// ==UserScript==
// @name         X Account Location Tagger
// @name:zh-CN   X 账号归属地标注
// @namespace    https://github.com/Noctyn/x-location
// @homepageURL  https://github.com/Noctyn/x-location
// @supportURL   https://github.com/Noctyn/x-location/issues
// @updateURL    https://raw.githubusercontent.com/Noctyn/x-location/main/x-location.user.js
// @downloadURL  https://raw.githubusercontent.com/Noctyn/x-location/main/x-location.user.js
// @version      0.37
// @description  悬浮资料卡（HoverCard）用户名下方与推文 / 引用推文时间戳旁，以原生风格徽章显示「账号所在地 / App Store 区域」
// @author       Noctyn
// @license      MIT
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @noframes
// @grant        none

(function () {
    'use strict';

    /*****************************************************************
     * 配置区
     *****************************************************************/

    const OPERATION = 'AboutAccountQuery';
    // 默认 query ID；失效（400/404）时脚本会尝试从 X 的前端 bundle 中自动发现新的
    const DEFAULT_QUERY_ID = 'zs_jFPFT78rBpXv9Z3U2YQ';
    const QUERY_ID_KEY = 'xLocQueryId_v1';
    const QUERY_ID_RECHECK = 30 * 60 * 1000;   // 两次自动发现之间的最短间隔
    const DISCOVER_CONCURRENCY = 4;            // 自动发现时并发扫描的 bundle 数
    const DISCOVER_MAX_BUNDLES = 16;

    const AUTH_BEARER =
        'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

    const CACHE_KEY = 'xLocCache_v1';
    const CACHE_TTL = 3 * 24 * 3600 * 1000;      // 有数据的结果缓存 3 天（所在地很少变）
    const CACHE_TTL_EMPTY = 12 * 3600 * 1000;    // 无数据的结果缓存 12 小时
    const CACHE_MAX_ENTRIES = 1000;              // 持久化缓存上限
    const ERROR_COOLDOWN = 60 * 1000;            // 单用户失败后冷却 60 秒
    const DEFAULT_BACKOFF = 5 * 60 * 1000;       // 429 / query ID 失效时的全局退避
    const AUTH_BACKOFF = 3 * 60 * 1000;          // 401（登录态失效）时的全局退避
    const ERROR_COOLDOWN_MAX = 30 * 60 * 1000;   // 同一用户反复失败时，冷却时间指数增长的上限
    const FAIL_STREAK_LIMIT = 6;                 // 连续这么多次失败（中间没有任何成功）才视为整体异常
    const FAIL_BACKOFF_BASE = 2 * 60 * 1000;     // 整体异常的首次退避，之后每次翻倍
    const FAIL_BACKOFF_MAX = 15 * 60 * 1000;
    const RATE_LIMIT_LOW = 3;                    // 剩余配额 ≤ 该值时主动退避到窗口重置
    const PACE_BELOW = 0.5;                      // 剩余配额低于上限的这个比例后，推文请求开始放慢
    const TWEET_PACE_MAX = 20 * 1000;            // 放慢后两次请求的最大间隔
    const HOVER_DELAY = 300;                     // 卡片出现后延迟多久才发请求（毫秒）

    const CARD_SEL = '[data-testid="HoverCard"]';
    const OWN_ATTR = 'data-x-location-hover-tag';
    const OWN_SEL = `[${OWN_ATTR}]`;

    // 时间线推文头部
    const TWEET_SEL = 'article[data-testid="tweet"]';
    const USER_NAME_SEL = '[data-testid="User-Name"]';
    const TWEET_BADGE_ATTR = 'data-xlt-tweet-badge';
    const TWEET_BADGE_SEL = `[${TWEET_BADGE_ATTR}]`;
    const TRIGGER_SEL = [CARD_SEL, TWEET_SEL, USER_NAME_SEL, 'time'].join(',');
    const TWEET_FETCH_INTERVAL = 600;        // 推文徽章两次「真实网络请求」的最小间隔
    const TWEET_QUEUE_LIMIT = 60;            // 队列上限（按用户计），超出时等队列排空后补扫
    const TWEET_RETRY_DELAY = 60 * 1000;     // 无数据 / 失败后的重试间隔

    const HANDLE_RE = /^@[A-Za-z0-9_]{1,15}$/;

    // 设置：'1' = 同时在时间线推文旁显示属地；默认关闭，只在悬浮资料卡里显示
    const TIMELINE_KEY = 'xLocTimeline_v1';

    const DEBUG = false;

    function log(...args) {
        if (DEBUG) console.log('[X-AccountLocation]', ...args);
    }

    function loadTimelineSetting() {
        try {
            return localStorage.getItem(TIMELINE_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    let showTimeline = loadTimelineSetting();

    /*****************************************************************
     * 通用工具
     *****************************************************************/

    function getCsrfToken() {
        const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 去音标、统一撇号、小写，用于国家名比较
    const norm = (s) =>
        String(s)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[’‘`]/g, "'")
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

    /*****************************************************************
     * 多语言（跟随页面语言：中文 / 英文）
     *****************************************************************/

    const LANG = /^zh/i.test(document.documentElement.lang || navigator.language || '') ? 'zh' : 'en';

    const I18N = {
        zh: {
            group: '账号归属地信息',
            basedIn: (c) => `账号所在地：${c}`,
            source: (s) => `连接来源：${s}`,
            mismatch: '应用商店区域与账号所在地不一致',
            vpn: '疑似 VPN',
            vpnTip: 'X 提示该账号的所在地可能不准确（可能使用了 VPN / 代理）',
            web: '网页端',
            menuOn: '时间线推文显示属地：已开启（点击关闭）',
            menuOff: '时间线推文显示属地：已关闭（点击开启）',
        },
        en: {
            group: 'Account location info',
            basedIn: (c) => `Account based in ${c}`,
            source: (s) => `Connected via ${s}`,
            mismatch: 'Store region differs from the account’s location',
            vpn: 'Possible VPN',
            vpnTip: 'X says this location may be inaccurate (possibly a VPN / proxy)',
            web: 'Web',
            menuOn: 'Timeline badges: ON (click to turn off)',
            menuOff: 'Timeline badges: OFF (click to turn on)',
        },
    };

    function t(key, ...args) {
        const v = I18N[LANG][key];
        return typeof v === 'function' ? v(...args) : v;
    }

    /*****************************************************************
     * 国家名 → ISO 代码 → 国旗
     * 用 Intl.DisplayNames 反向建表，无需手写几百个国家
     *****************************************************************/

    const COUNTRY_ALIASES = {
        'turkey': 'TR', 'turkiye': 'TR',
        'czech republic': 'CZ',
        'hong kong': 'HK', 'hong kong sar china': 'HK',
        'macau': 'MO', 'macao': 'MO', 'macao sar china': 'MO',
        'uk': 'GB', 'great britain': 'GB',
        'usa': 'US', 'united states of america': 'US',
        'korea': 'KR', 'south korea': 'KR', 'republic of korea': 'KR',
        'russian federation': 'RU',
        'viet nam': 'VN',
        'ivory coast': 'CI',
        'burma': 'MM', 'myanmar': 'MM',
        'swaziland': 'SZ',
        'cape verde': 'CV',
        'palestine': 'PS',
        'macedonia': 'MK',
        'east timor': 'TL',
    };

    let countryIndex = null;

    function getCountryIndex() {
        if (countryIndex) return countryIndex;
        countryIndex = new Map();

        const langs = [...new Set(['en', document.documentElement.lang, navigator.language].filter(Boolean))];
        for (const lang of langs) {
            let dn;
            try {
                dn = new Intl.DisplayNames([lang], { type: 'region', fallback: 'none' });
            } catch (e) {
                continue;
            }
            for (let i = 0; i < 26; i++) {
                for (let j = 0; j < 26; j++) {
                    const code = String.fromCharCode(65 + i, 65 + j);
                    if (code === 'ZZ') continue;
                    let name;
                    try {
                        name = dn.of(code);
                    } catch (e) {
                        continue;
                    }
                    if (name) {
                        const k = norm(name);
                        if (!countryIndex.has(k)) countryIndex.set(k, code);
                    }
                }
            }
        }
        for (const [k, v] of Object.entries(COUNTRY_ALIASES)) countryIndex.set(norm(k), v);
        return countryIndex;
    }

    function countryToCode(name) {
        if (!name) return null;
        return getCountryIndex().get(norm(name)) || null;
    }

    const flagEmoji = (code) =>
        String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)));

    // Windows 的浏览器不渲染国旗 emoji（会显示成 "JP" 字母），用 canvas 检测并降级
    let flagSupport = null;
    function flagSupported() {
        if (flagSupport !== null) return flagSupport;
        try {
            const c = document.createElement('canvas');
            c.width = 32;
            c.height = 16;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.textBaseline = 'top';
            ctx.font = '14px sans-serif';
            ctx.fillText(flagEmoji('JP'), 0, 0);
            const d = ctx.getImageData(0, 0, 32, 16).data;
            flagSupport = false;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] && (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2])) {
                    flagSupport = true;
                    break;
                }
            }
        } catch (e) {
            flagSupport = false;
        }
        return flagSupport;
    }

    /*****************************************************************
     * 解析 GraphQL 响应，提取归属地信息
     *****************************************************************/

    function extractLocationFromResponse(data) {
        if (!data || !data.data) return null;

        const d = data.data;
        const result =
            (d.user_result && d.user_result.result) ||
            (d.user && d.user.result) ||
            (d.user_result_by_screen_name && d.user_result_by_screen_name.result) ||
            null;

        if (!result) {
            log('未知 GraphQL 顶层结构，data =', data);
            return null;
        }

        const aboutProfile =
            result.about_profile ||
            result.aboutProfile ||
            (result.aboutModule && (result.aboutModule.about_profile || result.aboutModule.aboutProfile)) ||
            null;

        if (!aboutProfile) {
            log('未找到 about_profile 字段:', result);
            return null;
        }

        const country = aboutProfile.account_based_in || aboutProfile.accountBasedIn || null;
        // 形如 "Japan App Store" / "Turkey App Store" / "Canada Android App"
        const appStoreRegion = aboutProfile.source || null;
        // location_accurate 为 false 表示可能使用了 VPN
        const locationAccurate = aboutProfile.location_accurate !== false;

        if (!country && !appStoreRegion) return null;
        return { country, appStoreRegion, locationAccurate };
    }

    // 把 "Japan App Store" 拆成 { kind: 'ios', region: 'Japan' }
    function parseSource(source) {
        if (!source) return null;
        const raw = String(source).trim();
        if (!raw) return null;

        const rules = [
            ['ios', /\b(?:iOS\s+)?App\s*Store\b/i],
            ['android', /\bAndroid(?:\s+App)?\b|\bGoogle\s*Play\b/i],
            ['web', /\bWeb(?:\s+App)?\b/i],
        ];
        for (const [kind, re] of rules) {
            if (re.test(raw)) {
                return { raw, kind, region: raw.replace(re, '').replace(/\s{2,}/g, ' ').trim() };
            }
        }
        return { raw, kind: 'other', region: '' };
    }

    const hasInfo = (info) => !!(info && (info.country || info.appStoreRegion));

    /*****************************************************************
     * 缓存（带 TTL，持久化到 localStorage，多标签页合并写入）
     *****************************************************************/

    const locationCache = new Map();     // key -> { v, t }
    const inFlightRequests = new Map();  // key -> Promise
    const errorUntil = new Map();        // key -> 冷却截止时间
    const errorCount = new Map();        // key -> 连续失败次数（用于指数冷却）
    let globalBackoffUntil = 0;
    let failStreak = 0;                  // 连续失败次数（任一成功响应后清零）
    let streakBackoffs = 0;              // 已触发的整体退避次数（成功后清零）
    let rateLimit = 0;                   // 最近一次响应里的配额上限 / 剩余 / 重置时间
    let rateRemaining = null;
    let rateResetAt = 0;

    // 进入全局退避。这类事件很少见，所以始终在控制台打一行，方便排查「为什么没有徽章」
    function backoffFor(reason, until) {
        if (until <= globalBackoffUntil) return;
        globalBackoffUntil = until;
        console.info(`[X-AccountLocation] 暂停请求（${reason}），恢复时间 ${new Date(until).toLocaleTimeString()}`);
    }

    // 单个账号返回 400 / 403 / 404 很常见（已删除、屏蔽了你、受限等），
    // 只有连续多次失败、中间没有一次成功，才认为是整体异常
    function noteFailure(status) {
        failStreak++;
        if (failStreak < FAIL_STREAK_LIMIT) return;
        failStreak = 0;
        const wait = Math.min(FAIL_BACKOFF_BASE * 2 ** streakBackoffs, FAIL_BACKOFF_MAX);
        streakBackoffs++;
        backoffFor(`连续 ${FAIL_STREAK_LIMIT} 次失败，最近一次 HTTP ${status}`, Date.now() + wait);
    }

    // 有数据与无数据使用不同的 TTL
    function isFresh(entry, now = Date.now()) {
        if (!entry || typeof entry.t !== 'number') return false;
        return now - entry.t < (hasInfo(entry.v) ? CACHE_TTL : CACHE_TTL_EMPTY);
    }

    // 把 localStorage 里的条目并入内存（以更新的 t 为准）
    function mergeSavedCache(now = Date.now()) {
        try {
            const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
            for (const [k, entry] of Object.entries(saved)) {
                if (!isFresh(entry, now)) continue;
                const mine = locationCache.get(k);
                if (!mine || entry.t > mine.t) locationCache.set(k, entry);
            }
        } catch (err) {
            // 忽略损坏的缓存
        }
    }

    mergeSavedCache();
    log('已恢复缓存条目数:', locationCache.size);

    let persistTimer = null;
    let cacheDirty = false;

    function writeCache() {
        if (!cacheDirty) return;
        cacheDirty = false;
        try {
            const now = Date.now();
            mergeSavedCache(now); // 先吸收其他标签页写入的条目，避免整表覆盖丢数据

            for (const [k, entry] of locationCache) {
                if (!isFresh(entry, now)) locationCache.delete(k);
            }
            for (const [k, until] of errorUntil) {
                if (until <= now) errorUntil.delete(k);
            }
            if (locationCache.size > CACHE_MAX_ENTRIES) {
                const sorted = [...locationCache.entries()].sort((a, b) => a[1].t - b[1].t);
                const drop = locationCache.size - CACHE_MAX_ENTRIES;
                for (let i = 0; i < drop; i++) locationCache.delete(sorted[i][0]);
            }
            localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(locationCache)));
        } catch (err) {
            // 存储已满或被禁用时静默忽略
        }
    }

    function persistCache() {
        cacheDirty = true;
        if (persistTimer) return; // 合并短时间内的多次写入
        persistTimer = setTimeout(() => {
            persistTimer = null;
            writeCache();
        }, 1000);
    }

    function flushCache() {
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        writeCache();
    }

    function getCached(screenName) {
        const e = locationCache.get(screenName.toLowerCase());
        return isFresh(e) ? e : null;
    }

    // 该用户当前最早可以再次请求的时间（全局退避 / 单用户冷却）
    function blockedUntil(key) {
        return Math.max(globalBackoffUntil, errorUntil.get(key) || 0);
    }

    /*****************************************************************
     * Query ID 管理：失效时自动从前端 bundle 中找回
     *****************************************************************/

    function loadQueryId() {
        try {
            const s = JSON.parse(localStorage.getItem(QUERY_ID_KEY));
            // 只在默认值没变的前提下信任存储的值，避免手动更新脚本后被旧值覆盖
            if (s && s.id && s.base === DEFAULT_QUERY_ID) return s.id;
        } catch (e) {
            // ignore
        }
        return DEFAULT_QUERY_ID;
    }

    let queryId = loadQueryId();
    let discovering = null;
    let lastDiscoverAt = 0;

    // 多路并发扫描 bundle，命中即停
    async function scanBundlesForQueryId(urls) {
        const reBefore = new RegExp(`queryId:"([\\w-]+)",operationName:"${OPERATION}"`);
        const reAfter = new RegExp(`operationName:"${OPERATION}",[^}]{0,80}?queryId:"([\\w-]+)"`);

        let next = 0;
        let found = null;
        const worker = async () => {
            while (!found && next < urls.length) {
                const u = urls[next++];
                try {
                    // bundle 多半已在浏览器缓存中，优先走缓存
                    const res = await fetch(u, { cache: 'force-cache' });
                    const txt = await res.text();
                    const m = txt.match(reBefore) || txt.match(reAfter);
                    if (m && !found) found = m[1];
                } catch (e) {
                    // 单个 bundle 失败不影响其余
                }
            }
        };
        await Promise.all(Array.from({ length: DISCOVER_CONCURRENCY }, worker));
        return found;
    }

    // 返回 { status: 'found' | 'none' | 'throttled', id }
    function discoverQueryId() {
        if (discovering) return discovering;
        if (Date.now() - lastDiscoverAt < QUERY_ID_RECHECK) {
            return Promise.resolve({ status: 'throttled', id: null });
        }
        lastDiscoverAt = Date.now();

        discovering = (async () => {
            let id = null;
            try {
                const urls = [
                    ...new Set([
                        ...Array.from(document.scripts, (s) => s.src),
                        ...performance.getEntriesByType('resource').map((r) => r.name),
                    ]),
                ].filter((u) => /abs\.twimg\.com\/responsive-web\/client-web[^?#]*\.js$/.test(u));

                // main / api 包最可能包含，优先扫描
                const weight = (u) => (/\/(?:main|api)\./.test(u) ? 1 : 0);
                urls.sort((a, b) => weight(b) - weight(a));

                id = await scanBundlesForQueryId(urls.slice(0, DISCOVER_MAX_BUNDLES));
            } catch (e) {
                log('自动发现 query ID 失败:', e);
            }
            return id ? { status: 'found', id } : { status: 'none', id: null };
        })().finally(() => {
            discovering = null;
        });

        return discovering;
    }

    /*****************************************************************
     * 调用 GraphQL（缓存 + 去重 + 冷却 + 退避）
     *****************************************************************/

    function requestHeaders() {
        return {
            'authorization': AUTH_BEARER,
            'x-csrf-token': getCsrfToken(),
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
            'x-twitter-client-language': document.documentElement.lang || 'en',
            'accept': '*/*',
            'content-type': 'application/json',
        };
    }

    async function requestAbout(screenName) {
        const send = () =>
            fetch(
                `${location.origin}/i/api/graphql/${queryId}/${OPERATION}` +
                `?variables=${encodeURIComponent(JSON.stringify({ screenName }))}`,
                { method: 'GET', credentials: 'include', headers: requestHeaders() }
            );

        let res = await send();
        if (res.status !== 400 && res.status !== 404) return res;

        // 400/404：可能是 query ID 失效，也可能只是这个账号本身有问题（已删除 / 不存在）。
        // 这里只负责尝试换新 ID；是否整体退避由调用方按「连续失败次数」判断
        const d = await discoverQueryId();
        if (d.status === 'found' && d.id !== queryId) {
            log('发现新的 query ID:', d.id);
            queryId = d.id;
            try {
                localStorage.setItem(QUERY_ID_KEY, JSON.stringify({ id: d.id, base: DEFAULT_QUERY_ID }));
            } catch (e) {
                // ignore
            }
            res = await send();
        }
        return res;
    }

    async function fetchAccountLocation(screenName) {
        const key = screenName.toLowerCase();
        const now = Date.now();

        const cached = getCached(screenName);
        if (cached) return cached.v;
        if (inFlightRequests.has(key)) return inFlightRequests.get(key);

        // 未登录没有 ct0，请求必然失败
        if (!getCsrfToken()) return null;

        if (now < globalBackoffUntil) {
            log('全局退避中，跳过请求:', screenName);
            return null;
        }
        if (now < (errorUntil.get(key) || 0)) {
            log('该用户处于失败冷却期，跳过请求:', screenName);
            return null;
        }

        log('请求', OPERATION, screenName);

        const promise = (async () => {
            try {
                const res = await requestAbout(screenName);

                if (res.status === 429) {
                    const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
                    backoffFor('HTTP 429 限流', reset > Date.now() ? reset : Date.now() + DEFAULT_BACKOFF);
                    throw new Error('HTTP 429');
                }
                if (res.status === 401) {
                    // 登录态失效，对所有用户都一样
                    backoffFor('HTTP 401 登录态失效', Date.now() + AUTH_BACKOFF);
                    throw new Error('HTTP 401');
                }
                if (!res.ok) {
                    // 400 / 403 / 404 等多半只是这个账号的问题：只做单用户冷却，连续多次才整体退避
                    log('HTTP', res.status, '：', screenName);
                    noteFailure(res.status);
                    throw new Error(`HTTP ${res.status}`);
                }

                failStreak = 0;
                streakBackoffs = 0;
                errorCount.delete(key);

                // 根据剩余配额提前减速，而不是等撞上 429
                const limit = Number(res.headers.get('x-rate-limit-limit'));
                const remaining = res.headers.get('x-rate-limit-remaining');
                const resetAt = Number(res.headers.get('x-rate-limit-reset')) * 1000;
                rateLimit = limit > 0 ? limit : 0;
                rateRemaining = remaining !== null ? Number(remaining) : null;
                rateResetAt = resetAt > 0 ? resetAt : 0;
                if (remaining !== null && Number(remaining) <= RATE_LIMIT_LOW && resetAt > Date.now()) {
                    backoffFor(`配额即将用尽，剩余 ${remaining}${rateLimit ? ` / 上限 ${rateLimit}` : ''}`, resetAt);
                }

                const loc = extractLocationFromResponse(await res.json());
                log('获得位置:', screenName, loc);
                locationCache.set(key, { v: loc || {}, t: Date.now() });
                persistCache();
                return loc;
            } catch (e) {
                // 同一用户反复失败时冷却时间翻倍（1 → 2 → 4 … 分钟，上限 30 分钟），不再每分钟重试一次
                const n = (errorCount.get(key) || 0) + 1;
                errorCount.set(key, n);
                errorUntil.set(key, Date.now() + Math.min(ERROR_COOLDOWN * 2 ** (n - 1), ERROR_COOLDOWN_MAX));
                throw e;
            } finally {
                inFlightRequests.delete(key);
            }
        })();

        inFlightRequests.set(key, promise);
        return promise;
    }

    /*****************************************************************
     * 样式
     * 优先用 adoptedStyleSheets（不受页面 CSP 的 inline style 限制），
     * 不支持时退回 <style>。颜色全部来自卡片自身文字色 → 自动适配
     * 浅色 / 暗淡 / 熄灯三种主题与用户自定义强调色。
     *****************************************************************/

    const CSS_TEXT = `
.xlt-root{
  --xlt-warn:176,98,0;
  --xlt-danger:224,36,94;
  display:flex;flex-wrap:wrap;align-items:center;gap:6px;
  box-sizing:border-box;max-width:100%;margin-top:8px;
  -webkit-font-smoothing:antialiased;
  animation:xlt-fade .2s ease-out both;
}
.xlt-root[data-theme="dark"]{--xlt-warn:255,184,64;--xlt-danger:255,110,160}

.xlt-chip{
  --tone:var(--xlt-fg);
  display:inline-flex;align-items:center;gap:6px;
  box-sizing:border-box;height:26px;max-width:100%;padding:0 10px 0 7px;
  border-radius:9999px;
  font-size:12.5px;line-height:16px;font-weight:600;letter-spacing:.005em;white-space:nowrap;
  color:rgb(var(--tone));
  background:rgba(var(--tone),.07);
  box-shadow:inset 0 0 0 1px rgba(var(--tone),.12);
  cursor:default;user-select:text;
  animation:xlt-pop .32s cubic-bezier(.2,.9,.25,1.15) both;
  animation-delay:calc(var(--i,0) * 50ms);
  transition:background-color .15s ease,box-shadow .15s ease;
}
.xlt-chip:not(.xlt-skel):hover{
  background:rgba(var(--tone),.12);
  box-shadow:inset 0 0 0 1px rgba(var(--tone),.22);
}
.xlt-chip--muted{--tone:var(--xlt-mute);font-weight:500}
.xlt-chip--warn{--tone:var(--xlt-warn)}
.xlt-chip--danger{--tone:var(--xlt-danger)}

.xlt-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.xlt-sub{opacity:.72;font-weight:500}

.xlt-ico{width:14px;height:14px;flex:none;display:block}
.xlt-flag{
  flex:none;width:18px;text-align:center;font-size:15px;line-height:16px;
  font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif;
  filter:drop-shadow(0 0 .5px rgba(0,0,0,.35));
}
.xlt-code{
  flex:none;padding:0 4px;border-radius:4px;
  font:700 9.5px/14px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:.03em;background:rgba(var(--tone),.14);
}

/* 推文时间戳旁：纯文本，完全跟随 X 原生元信息的字体与颜色 */
.xlt-tb{
  --xlt-warn:176,98,0;
  display:inline-flex;align-items:baseline;gap:4px;flex:none;
  box-sizing:border-box;max-width:200px;min-width:0;
  margin:0;padding:0;border:0;box-shadow:none;
  vertical-align:baseline;
  white-space:nowrap;overflow:visible;
  cursor:default;user-select:text;
}
.xlt-tb[data-theme="dark"]{--xlt-warn:255,184,64}
.xlt-tb,
.xlt-tb > span{
  font-family:var(--xlt-tb-font,inherit)!important;
  font-size:var(--xlt-tb-size,inherit)!important;
  font-weight:var(--xlt-tb-weight,inherit)!important;
  line-height:var(--xlt-tb-line,inherit)!important;
  letter-spacing:var(--xlt-tb-space,inherit)!important;
  color:var(--xlt-tb-color,rgb(83,100,113))!important;
  background:none!important;
  border:0!important;
  box-shadow:none!important;
  text-transform:none!important;
}
.xlt-tb > span{flex:none}
.xlt-tb .xlt-tb-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.xlt-tb .xlt-tb-flag{
  font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif!important;
  font-size:.94em!important;
  line-height:inherit!important;
}
.xlt-tb--warn > span{color:rgb(var(--xlt-warn))!important}

.xlt-skel{
  padding:0;box-shadow:none;
  background:linear-gradient(100deg,rgba(var(--xlt-fg),.06) 30%,rgba(var(--xlt-fg),.14) 50%,rgba(var(--xlt-fg),.06) 70%);
  background-size:200% 100%;
  animation:xlt-shimmer 1.3s ease-in-out infinite;
}

.xlt-leaving{animation:xlt-leave .18s ease-in forwards}

@keyframes xlt-fade{from{opacity:0}to{opacity:1}}
@keyframes xlt-pop{from{opacity:0;transform:translateY(5px) scale(.94)}to{opacity:1;transform:none}}
@keyframes xlt-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
@keyframes xlt-leave{to{opacity:0;transform:translateY(-3px) scale(.97)}}

@media (prefers-reduced-motion:reduce){
  .xlt-root,.xlt-chip,.xlt-tb{animation:none!important;transition:none!important}
}
`;

    function injectStyles() {
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(CSS_TEXT);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
            return;
        } catch (e) {
            // 退回 <style>
        }
        const el = document.createElement('style');
        el.id = 'xlt-style';
        el.textContent = CSS_TEXT;
        (document.head || document.documentElement).appendChild(el);
    }

    /*****************************************************************
     * 图标（用 createElementNS 构建，避开 innerHTML / Trusted Types）
     *****************************************************************/

    const SVG_NS = 'http://www.w3.org/2000/svg';

    const APPLE_PATH =
        'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701';

    const ANDROID_PATH =
        'M6 18c0 .55.45 1 1 1h1v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h2v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h1c.55 0 1-.45 1-1V8H6v10zM3.5 8C2.67 8 2 8.67 2 9.5v7c0 .83.67 1.5 1.5 1.5S5 17.33 5 16.5v-7C5 8.67 4.33 8 3.5 8zm17 0c-.83 0-1.5.67-1.5 1.5v7c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-7c0-.83-.67-1.5-1.5-1.5zm-4.97-5.84l1.3-1.3c.2-.2.2-.51 0-.71-.2-.2-.51-.2-.71 0l-1.48 1.48C13.85 1.23 12.95 1 12 1c-.96 0-1.86.23-2.66.63L7.85.15c-.2-.2-.51-.2-.71 0-.2.2-.2.51 0 .71l1.31 1.31C6.97 3.26 6 5.01 6 7h12c0-1.99-.97-3.75-2.47-4.84zM10 5H9V4h1v1zm5 0h-1V4h1v1z';

    const ICONS = {
        globe: {
            stroke: true,
            els: [
                ['circle', { cx: 12, cy: 12, r: 9 }],
                ['path', { d: 'M3 12h18' }],
                ['path', { d: 'M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z' }],
            ],
        },
        shield: {
            stroke: true,
            els: [
                ['path', { d: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z' }],
                ['path', { d: 'M12 8.5v4' }],
                ['path', { d: 'M12 15.8h.01' }],
            ],
        },
        monitor: {
            stroke: true,
            els: [
                ['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }],
                ['path', { d: 'M8 20h8M12 16v4' }],
            ],
        },
        apple: { stroke: false, els: [['path', { d: APPLE_PATH }]] },
        android: { stroke: false, els: [['path', { d: ANDROID_PATH }]] },
    };

    function makeIcon(name) {
        const def = ICONS[name] || ICONS.globe;
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('class', 'xlt-ico');
        svg.setAttribute('aria-hidden', 'true');
        if (def.stroke) {
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
        } else {
            svg.setAttribute('fill', 'currentColor');
        }
        for (const [tag, attrs] of def.els) {
            const e = document.createElementNS(SVG_NS, tag);
            for (const k in attrs) e.setAttribute(k, attrs[k]);
            svg.appendChild(e);
        }
        return svg;
    }

    function flagNode(code) {
        if (code && flagSupported()) {
            const s = document.createElement('span');
            s.className = 'xlt-flag';
            s.textContent = flagEmoji(code);
            return s;
        }
        if (code) {
            const s = document.createElement('span');
            s.className = 'xlt-code';
            s.textContent = code;
            return s;
        }
        return makeIcon('globe');
    }

    /*****************************************************************
     * 徽章构建
     *****************************************************************/

    function makeChip({ cls = '', icon, text, sub, title }) {
        const el = document.createElement('span');
        el.className = `xlt-chip ${cls}`.trim();
        if (title) el.title = title;
        if (icon) el.appendChild(icon);

        const label = document.createElement('span');
        label.className = 'xlt-text';
        label.textContent = text;
        if (sub) {
            const s = document.createElement('span');
            s.className = 'xlt-sub';
            s.textContent = ` · ${sub}`;
            label.appendChild(s);
        }
        el.appendChild(label);
        return el;
    }

    function readRgb(el, fallback) {
        try {
            const m = getComputedStyle(el).color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
            if (m) return [+m[1], +m[2], +m[3]];
        } catch (e) {
            // ignore
        }
        return fallback;
    }

    const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

    function createRoot(handleSpan, nameAnchor) {
        const root = document.createElement('div');
        root.className = 'xlt-root';
        root.setAttribute(OWN_ATTR, '1');
        root.setAttribute('role', 'group');
        root.setAttribute('aria-label', t('group'));

        // 从卡片自身取色：显示名 = 主色，@handle = 次要色
        const nameSpan = nameAnchor.querySelector('span') || nameAnchor;
        const fg = readRgb(nameSpan, [15, 20, 25]);
        const mute = readRgb(handleSpan, [83, 100, 113]);

        root.dataset.theme = luminance(fg) > 0.6 ? 'dark' : 'light';
        root.style.setProperty('--xlt-fg', fg.join(', '));
        root.style.setProperty('--xlt-mute', mute.join(', '));
        try {
            root.style.fontFamily = getComputedStyle(handleSpan).fontFamily;
        } catch (e) {
            // ignore
        }
        return root;
    }

    function skeletonChip(width) {
        const el = document.createElement('span');
        el.className = 'xlt-chip xlt-skel';
        el.style.width = `${width}px`;
        return el;
    }

    function renderSkeleton(root) {
        root.replaceChildren(skeletonChip(116), skeletonChip(88));
    }

    function renderInfo(root, info) {
        const chips = [];
        const src = parseSource(info.appStoreRegion);
        const cCode = countryToCode(info.country);
        const rCode = src && src.region ? countryToCode(src.region) : null;
        const mismatch = !!(cCode && rCode && cCode !== rCode);

        // 1) 账号所在地
        if (info.country) {
            chips.push(
                makeChip({
                    icon: flagNode(cCode),
                    text: info.country,
                    title: t('basedIn', info.country),
                })
            );
        }

        // 2) 连接来源（App Store / Android / Web）；区域与所在地相同时不重复显示
        if (src) {
            const sameRegion =
                info.country && src.region &&
                (cCode && rCode ? cCode === rCode : norm(src.region) === norm(info.country));
            const showRegion = src.region && !sameRegion;

            const label =
                src.kind === 'ios' ? 'App Store' :
                    src.kind === 'android' ? 'Android' :
                        src.kind === 'web' ? t('web') :
                            src.raw;
            const icon =
                src.kind === 'ios' ? 'apple' :
                    src.kind === 'android' ? 'android' :
                        src.kind === 'web' ? 'monitor' :
                            'globe';

            chips.push(
                makeChip({
                    cls: mismatch ? 'xlt-chip--warn' : 'xlt-chip--muted',
                    icon: makeIcon(icon),
                    text: label,
                    sub: showRegion ? src.region : '',
                    title: t('source', src.raw) + (mismatch ? `\n${t('mismatch')}` : ''),
                })
            );
        }

        // 3) X 官方标记的“位置可能不准确”
        if (info.locationAccurate === false) {
            chips.push(
                makeChip({
                    cls: 'xlt-chip--danger',
                    icon: makeIcon('shield'),
                    text: t('vpn'),
                    title: t('vpnTip'),
                })
            );
        }

        if (!chips.length) return false;
        chips.forEach((c, i) => c.style.setProperty('--i', i)); // 依次渐入
        root.replaceChildren(...chips);
        return true;
    }

    function fadeOut(el) {
        el.classList.add('xlt-leaving');
        setTimeout(() => el.remove(), 200);
    }

    /*****************************************************************
     * 悬浮资料卡（HoverCard）逻辑
     *****************************************************************/

    // 优先选「文本与所在链接路径一致」的 @handle，避免把显示名恰好是 "@xxx" 的账号误认
    function findHandleSpan(card) {
        let loose = null;
        for (const span of card.querySelectorAll('span')) {
            const text = span.textContent.trim();
            if (!HANDLE_RE.test(text)) continue;
            const a = span.closest('a[href]');
            if (a && (a.getAttribute('href') || '').toLowerCase() === `/${text.slice(1).toLowerCase()}`) {
                return span;
            }
            if (!loose) loose = span;
        }
        return loose;
    }

    function findDisplayNameAnchor(card, screenName) {
        const anchors = card.querySelectorAll(`a[href="/${CSS.escape(screenName)}"]`);
        for (const a of anchors) {
            const span = a.querySelector('span');
            if (span && !span.textContent.trim().startsWith('@')) return a;
        }
        return null;
    }

    // "用户名 + @handle" 的公共父容器，徽章追加在其末尾（即 @handle 下方）
    function findUsernameBlockContainer(nameAnchor, handleSpan) {
        const handleAnchor = handleSpan.closest('a') || handleSpan.parentElement;
        if (
            nameAnchor &&
            handleAnchor &&
            nameAnchor.parentElement &&
            nameAnchor.parentElement.contains(handleAnchor)
        ) {
            return nameAnchor.parentElement;
        }
        return null;
    }

    function mount(root, nameAnchor, handleSpan) {
        const container = findUsernameBlockContainer(nameAnchor, handleSpan);
        if (container) {
            container.appendChild(root);
        } else {
            const handleAnchor = handleSpan.closest('a') || handleSpan;
            (handleAnchor.closest('div') || handleAnchor).insertAdjacentElement('afterend', root);
        }
    }

    // card -> { key, root, dismissed }，记录“这张卡片正在处理谁”
    const cardStates = new WeakMap();

    async function handleHoverCard(card) {
        const handleSpan = findHandleSpan(card);
        if (!handleSpan) return;

        const screenName = handleSpan.textContent.trim().slice(1);
        if (!screenName) return;
        const key = screenName.toLowerCase();

        const nameAnchor = findDisplayNameAnchor(card, screenName);
        if (!nameAnchor) return; // 卡片内容还没渲染完，等下一次 mutation

        const prev = cardStates.get(card);
        if (prev && prev.key === key) {
            // 同一张卡片、同一个用户：若徽章被 React 重渲染冲掉了，补挂回去
            if (!prev.dismissed && !prev.root.isConnected) mount(prev.root, nameAnchor, handleSpan);
            return;
        }

        // 卡片被复用于另一个用户：清掉旧徽章
        if (prev) prev.root.remove();
        card.querySelectorAll(OWN_SEL).forEach((el) => el.remove());

        const root = createRoot(handleSpan, nameAnchor);
        const state = { key, root, dismissed: false };
        cardStates.set(card, state);

        const stillValid = () => card.isConnected && cardStates.get(card) === state;
        const dismiss = () => {
            state.dismissed = true;
            fadeOut(root);
        };

        try {
            const cached = getCached(screenName);

            // 命中缓存：直接渲染，无闪烁
            if (cached) {
                if (!hasInfo(cached.v) || !renderInfo(root, cached.v)) {
                    state.dismissed = true;
                    return;
                }
                mount(root, nameAnchor, handleSpan);
                return;
            }

            // 未登录 / 全局退避 / 该用户冷却中：本来也发不出请求，不要先挂骨架屏再让它淡出
            if (!getCsrfToken() || blockedUntil(key) > Date.now()) {
                state.dismissed = true;
                return;
            }

            // 未命中：先挂骨架屏占位（高度与最终徽章一致，不会撑动卡片）
            renderSkeleton(root);
            mount(root, nameAnchor, handleSpan);

            // 鼠标快速划过时不发请求
            await sleep(HOVER_DELAY);
            if (!stillValid()) return root.remove();

            const info = await fetchAccountLocation(screenName);
            if (!stillValid()) return root.remove();

            if (hasInfo(info) && renderInfo(root, info)) return;
            dismiss();
        } catch (e) {
            log('悬浮卡查询归属地失败:', screenName, e.message || e);
            // 不清除状态，避免被 MutationObserver 反复触发重试；重试由冷却期控制
            if (stillValid()) dismiss();
            else root.remove();
        }
    }

    function scanHoverCards() {
        document.querySelectorAll(CARD_SEL).forEach((card) => {
            handleHoverCard(card);
        });
    }

    /*****************************************************************
     * 时间线推文 / 引用卡片：时间戳旁显示账号属地
     * 以各自的 User-Name 头部为单位，徽章插在「@handle · 时间」行末尾
     *
     * 队列按「用户」去重：同一用户在时间线上出现多次只排一次队，
     * 请求完成后一并给所有仍在页面上的头部渲染徽章。
     *****************************************************************/

    const tweetStates = new WeakMap();   // header -> { key, badge, info, done }
    const badgeMeta = new WeakMap();     // badge  -> { header, time }
    const tweetQueue = [];               // 待处理条目：{ key, headers:Set<header> }
    const tweetQueued = new Map();       // key -> 条目（排队中或正在请求中）
    let tweetQueueRunning = false;
    let tweetOverflow = false;           // 队列满时丢弃过任务，排空后需要补扫
    let lastTweetFetchAt = 0;

    function findTweetHandleAnchor(header, screenName) {
        const target = `/${screenName}`.toLowerCase();
        for (const a of header.querySelectorAll('a[href]')) {
            const href = (a.getAttribute('href') || '').toLowerCase();
            if (href === target && a.textContent.trim().startsWith('@')) return a;
        }
        return null;
    }

    function findTweetHandleSpan(header, screenName) {
        for (const span of header.querySelectorAll('span')) {
            const text = span.textContent.trim();
            if (!text.startsWith('@')) continue;
            if (!screenName) {
                if (/^@[A-Za-z0-9_]+$/.test(text)) return span;
            } else if (text.slice(1).toLowerCase() === screenName.toLowerCase()) {
                return span;
            }
        }
        return null;
    }

    // 优先用头部里的时间；详情页的时间在正文下方的页脚里，可能离头部很远
    function findOwnTime(header) {
        const inHeader = header.querySelector('time');
        if (inHeader) return inHeader;

        // 详情页主推文：整条推文里找页脚时间，跳过引用卡片 / 嵌套头部自己的时间
        const article = header.closest(TWEET_SEL);
        if (article) {
            for (const tm of article.querySelectorAll('time')) {
                if (!(header.compareDocumentPosition(tm) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
                const owner = tm.closest(USER_NAME_SEL);
                if (!owner || owner === header) return tm;
            }
            return null;
        }

        // 从近到远找「本头部之后、下一条推文头部之前」的第一个时间
        let scope = header.parentElement;
        for (let depth = 0; scope && scope !== document.body && depth < 8; depth++) {
            let seen = false;
            for (const el of scope.querySelectorAll(`${USER_NAME_SEL}, time`)) {
                if (el === header) {
                    seen = true;
                } else if (el.matches(USER_NAME_SEL)) {
                    if (seen) return null;
                } else if (seen) {
                    return el;
                }
            }
            scope = scope.parentElement;
        }
        return null;
    }

    function findTweetMeta(header) {
        let screenName = '';
        let timeAnchor = null;

        // 常规推文：时间戳是 /handle/status/... 链接
        for (const a of header.querySelectorAll('a[href]')) {
            const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]+)\/status\/\d+/);
            if (!m) continue;
            screenName = m[1];
            if (a.querySelector('time')) {
                timeAnchor = a;
                break;
            }
        }

        const timeEl = findOwnTime(header);
        if (!timeEl) return null;

        let handleSpan = screenName ? findTweetHandleSpan(header, screenName) : null;

        // 引用卡片常把 @handle 和日期渲染成非链接文本
        if (!screenName) {
            handleSpan = findTweetHandleSpan(header, '');
            if (handleSpan) {
                screenName = handleSpan.textContent.trim().slice(1);
            } else {
                // 退回到头部里的资料链接（名字 / 头像），或整张卡片的外层链接
                const links = [...header.querySelectorAll('a[href]')];
                const card = header.closest('a[href]');
                if (card) links.push(card);
                for (const a of links) {
                    const m = (a.getAttribute('href') || '').match(
                        /^\/([A-Za-z0-9_]+)(?:\/status\/\d+)?\/?(?:[?#]|$)/
                    );
                    if (m) {
                        screenName = m[1];
                        break;
                    }
                }
                if (!screenName) {
                    const m = header.textContent.match(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/);
                    if (m) screenName = m[1];
                }
            }
        }
        if (!screenName) return null;

        if (!timeAnchor) {
            // 时间可能位于整张引用卡的外层链接里；只接受仅包裹时间的链接
            const a = timeEl.closest('a');
            timeAnchor = a && a.textContent.trim() === timeEl.textContent.trim() ? a : timeEl;
        }
        const handleAnchor = findTweetHandleAnchor(header, screenName) || handleSpan;

        return { header, timeAnchor, handleAnchor, screenName };
    }

    // 时间戳在头部之外（详情页页脚）时，只在本行内把它插到时间后面
    function insertAfterTimeGroup(unit, badge) {
        let target = unit;
        while (target.parentElement && target.parentElement !== document.body) {
            const parent = target.parentElement;
            const onlyTime = [...parent.childNodes].every((n) => {
                if (n === target) return true;
                if (n.nodeType === Node.TEXT_NODE) {
                    return !n.textContent.trim() || n.textContent.trim() === '·';
                }
                return n.nodeType === Node.ELEMENT_NODE && n.textContent.trim() === '·';
            });
            if (!onlyTime) break;
            target = parent;
        }
        target.insertAdjacentElement('afterend', badge);
    }

    // 外层可能靠 gap 也可靠子元素边距留白：保证徽章前有 4px，且不与已有 gap 叠加
    function applyTweetBadgeSpacing(badge) {
        const parent = badge.parentElement;
        let gap = 0;
        if (parent) {
            const cs = getComputedStyle(parent);
            if (cs.display !== 'inline') gap = parseFloat(cs.columnGap) || 0;
        }
        badge.style.marginInlineStart = `${Math.max(0, 4 - gap)}px`;
    }

    // 从时间戳往上找同时包含 @handle 的最小行，把徽章插到时间戳后面
    function insertTweetBadge(meta, badge) {
        // 头部不含时间（详情页页脚）时不能往上找到整条推文，否则会掉到推文末尾
        if (!meta.header.contains(meta.timeAnchor)) {
            insertAfterTimeGroup(meta.timeAnchor, badge);
            applyTweetBadgeSpacing(badge);
            return;
        }

        let row = meta.timeAnchor;
        while (row && row !== meta.header) {
            if (meta.handleAnchor && row.contains(meta.handleAnchor)) break;
            row = row.parentElement;
        }
        const container =
            row && row !== meta.header ? row : meta.timeAnchor.parentElement || meta.timeAnchor;

        let child = meta.timeAnchor;
        while (child.parentElement && child.parentElement !== container) {
            child = child.parentElement;
        }
        if (child.parentElement === container) {
            container.insertBefore(badge, child.nextSibling);
        } else {
            (meta.timeAnchor.parentElement || meta.timeAnchor).insertAdjacentElement('afterend', badge);
        }
        applyTweetBadgeSpacing(badge);
    }

    // 徽章可能插在 User-Name 之外：字体、颜色都直接取时间戳的最终样式
    function syncTweetBadgeStyle(badge, time) {
        const s = getComputedStyle(time);
        badge.style.setProperty('--xlt-tb-color', s.color || 'rgb(83, 100, 113)');
        badge.style.setProperty('--xlt-tb-font', s.fontFamily);
        badge.style.setProperty('--xlt-tb-size', s.fontSize);
        badge.style.setProperty('--xlt-tb-weight', s.fontWeight);
        badge.style.setProperty('--xlt-tb-line', s.lineHeight);
        badge.style.setProperty('--xlt-tb-space', s.letterSpacing);
        badge.dataset.theme =
            luminance(readRgb(time, [83, 100, 113])) > 0.6 ? 'dark' : 'light';
    }

    function createTweetBadge(info, timeAnchor) {
        const src = parseSource(info.appStoreRegion);
        // 账号所在地优先；没有时退回 App Store / Android 区域（Web 无法推断地区）
        const country = info.country || (src && src.kind !== 'web' ? src.region : '') || '';
        if (!country) return null;

        const code = countryToCode(country);
        const rCode = src && src.region ? countryToCode(src.region) : null;
        const mismatch = !!(info.country && code && rCode && code !== rCode);
        const inaccurate = info.locationAccurate === false;

        const badge = document.createElement('span');
        badge.className = inaccurate ? 'xlt-tb xlt-tb--warn' : 'xlt-tb';
        badge.setAttribute(TWEET_BADGE_ATTR, '1');
        syncTweetBadgeStyle(badge, timeAnchor);

        const sep = document.createElement('span');
        sep.className = 'xlt-tb-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '·';
        badge.appendChild(sep);

        // 原生风格：有国旗字体时显示国旗，否则不插入会突兀的 CH 小方块
        if (code && flagSupported()) {
            const flag = document.createElement('span');
            flag.className = 'xlt-tb-flag';
            flag.setAttribute('aria-hidden', 'true');
            flag.textContent = flagEmoji(code);
            badge.appendChild(flag);
        }

        const label = document.createElement('span');
        label.className = 'xlt-tb-label';
        label.textContent = country;
        badge.appendChild(label);

        const note = [];
        if (info.country) note.push(t('basedIn', info.country));
        else if (src) note.push(t('source', src.raw));
        if (info.country && src) note.push(t('source', src.raw));
        if (mismatch) note.push(t('mismatch'));
        if (inaccurate) note.push(t('vpnTip'));
        badge.title = note.join('\n');
        badge.setAttribute('aria-label', note.join('; '));
        return badge;
    }

    function renderTweetBadge(header, state, meta) {
        meta = meta || findTweetMeta(header);
        if (!meta || meta.screenName.toLowerCase() !== state.key) return;

        if (state.badge && state.badge.isConnected) {
            const bm = badgeMeta.get(state.badge);
            if (bm && bm.header === header) return;
        }

        if (!state.badge || !state.badge.isConnected) {
            const badge = createTweetBadge(state.info, meta.timeAnchor);
            if (!badge) {
                state.done = true;
                return;
            }
            badgeMeta.set(badge, { header, time: meta.timeAnchor });
            state.badge = badge;
        }
        insertTweetBadge(meta, state.badge);
    }

    /* ---------- 重扫调度（退避 / 冷却结束后自动补扫） ---------- */

    let rescanTimer = null;
    let rescanDue = 0;

    function scheduleRescanAt(time) {
        const at = Math.max(time, Date.now() + 500);
        if (rescanTimer && rescanDue <= at) return;
        clearTimeout(rescanTimer);
        rescanDue = at;
        rescanTimer = setTimeout(() => {
            rescanTimer = null;
            rescanDue = 0;
            scheduleScan();
        }, at - Date.now());
    }

    /* ---------- 队列 ---------- */

    function waitVisible() {
        return new Promise((resolve) => {
            const on = () => {
                if (document.hidden) return;
                document.removeEventListener('visibilitychange', on);
                resolve();
            };
            document.addEventListener('visibilitychange', on);
        });
    }

    // 条目里仍在页面上的头部，距视口中线的最小距离；全部已移除则为 Infinity
    function tweetDistance(item) {
        const mid = window.innerHeight / 2;
        let best = Infinity;
        for (const h of item.headers) {
            if (!h.isConnected) continue;
            const r = h.getBoundingClientRect();
            best = Math.min(best, Math.abs((r.top + r.bottom) / 2 - mid));
        }
        return best;
    }

    // 取下一个要处理的条目：已有缓存的立即处理；否则选离视口中线最近的；顺手清理已滚走的
    function takeNextTweetItem() {
        const alive = [];
        let best = null;
        let bestDist = Infinity;

        for (const item of tweetQueue) {
            if (getCached(item.key)) {
                tweetQueue.splice(tweetQueue.indexOf(item), 1);
                return item;
            }
            const d = tweetDistance(item);
            if (d === Infinity) {
                tweetQueued.delete(item.key);
                continue;
            }
            alive.push(item);
            if (d < bestDist) {
                bestDist = d;
                best = item;
            }
        }

        tweetQueue.length = 0;
        for (const item of alive) if (item !== best) tweetQueue.push(item);
        return best;
    }

    async function runTweetItem(item) {
        let info = null;
        try {
            info = await fetchAccountLocation(item.key);
        } catch (e) {
            log('推文属地查询失败:', item.key, e.message || e);
        } finally {
            tweetQueued.delete(item.key);
        }

        if (!showTimeline) return; // 请求期间被关掉了：结果已进缓存，不再渲染

        if (!hasInfo(info)) {
            // 缓存里已有（含「无数据」）时下次扫描会处理；否则等退避 / 冷却结束再试
            if (!getCached(item.key)) {
                let until = blockedUntil(item.key);
                if (until <= Date.now()) {
                    until = Date.now() + TWEET_RETRY_DELAY;
                    errorUntil.set(item.key, until);
                }
                scheduleRescanAt(until);
            }
            return;
        }

        // 同一用户在页面上的所有头部一并渲染
        for (const header of item.headers) {
            if (!header.isConnected) continue;
            const state = tweetStates.get(header);
            if (!state || state.key !== item.key || state.done) continue;
            state.info = info;
            const meta = findTweetMeta(header);
            if (meta) renderTweetBadge(header, state, meta);
        }
    }

    // 剩余配额充足时按固定间隔快速请求；低于上限的一半后，把剩余配额摊到窗口重置前，
    // 避免一口气烧光之后整段时间都没有徽章
    function tweetFetchInterval() {
        const now = Date.now();
        if (rateLimit > 0 && rateRemaining !== null && rateResetAt > now && rateRemaining < rateLimit * PACE_BELOW) {
            const spread = (rateResetAt - now) / Math.max(1, rateRemaining - RATE_LIMIT_LOW);
            return Math.min(Math.max(TWEET_FETCH_INTERVAL, spread), TWEET_PACE_MAX);
        }
        return TWEET_FETCH_INTERVAL;
    }

    async function pumpTweetQueue() {
        if (tweetQueueRunning) return;
        tweetQueueRunning = true;
        try {
            while (tweetQueue.length) {
                if (document.hidden) {
                    await waitVisible(); // 标签页在后台时暂停出队
                    continue;
                }

                const item = takeNextTweetItem();
                if (!item) break;

                // 只有真要发网络请求时才限速；缓存命中 / 已滚走的条目不占间隔
                if (!getCached(item.key) && Date.now() >= globalBackoffUntil) {
                    const wait = lastTweetFetchAt + tweetFetchInterval() - Date.now();
                    if (wait > 0) {
                        // 放回队列，等完再重新挑选：这段时间里视口可能已经滚到别处
                        tweetQueue.push(item);
                        await sleep(wait);
                        continue;
                    }
                    lastTweetFetchAt = Date.now();
                }

                try {
                    await runTweetItem(item);
                } catch (e) {
                    log('推文属地队列任务失败:', e.message || e);
                }
            }
        } finally {
            tweetQueueRunning = false;
            if (tweetOverflow) {
                tweetOverflow = false;
                scheduleScan(); // 之前被拒绝的头部补一次扫描
            }
        }
    }

    function ensureTweetBadge(header, state, meta) {
        if (state.done) return;
        if (state.info) {
            if (!state.badge || !state.badge.isConnected) renderTweetBadge(header, state, meta);
            return;
        }

        const cached = getCached(state.key);
        if (cached) {
            if (hasInfo(cached.v)) {
                state.info = cached.v;
                renderTweetBadge(header, state, meta);
            } else {
                state.done = true;
            }
            return;
        }

        // 该用户已在排队 / 请求中：只登记这个头部，完成后一起渲染
        const queued = tweetQueued.get(state.key);
        if (queued) {
            queued.headers.add(header);
            return;
        }

        if (!getCsrfToken()) return; // 未登录

        const until = blockedUntil(state.key);
        if (until > Date.now()) {
            scheduleRescanAt(until);
            return;
        }

        if (tweetQueue.length >= TWEET_QUEUE_LIMIT) {
            tweetOverflow = true;
            return;
        }

        const item = { key: state.key, headers: new Set([header]) };
        tweetQueue.push(item);
        tweetQueued.set(state.key, item);
        pumpTweetQueue();
    }

    // 切换明暗主题后，时间戳颜色会变；同步刷新已挂载徽章的颜色
    let badgeColorTimer = null;
    function refreshTweetBadgeColors() {
        if (badgeColorTimer) return;
        badgeColorTimer = setTimeout(() => {
            badgeColorTimer = null;
            document.querySelectorAll(TWEET_BADGE_SEL).forEach((badge) => {
                const bm = badgeMeta.get(badge);
                if (!bm || !bm.time || !bm.time.isConnected) return;
                syncTweetBadgeStyle(badge, bm.time);
            });
        }, 150);
    }

    function scanTweets() {
        document.querySelectorAll(USER_NAME_SEL).forEach((header) => {
            const meta = findTweetMeta(header);
            if (!meta) return;
            const key = meta.screenName.toLowerCase();

            let state = tweetStates.get(header);
            if (!state || state.key !== key) {
                if (state && state.badge) state.badge.remove();
                state = { key, badge: null, info: null, done: false };
                tweetStates.set(header, state);
            }
            ensureTweetBadge(header, state, meta);
        });
    }

    /*****************************************************************
     * 启动：轻量 MutationObserver + rAF 合并
     *****************************************************************/

    let scanScheduled = false;

    function scanAll() {
        scanHoverCards();
        if (showTimeline) scanTweets();
    }

    /* ---------- 设置：时间线推文是否显示属地 ---------- */

    let menuId = null;

    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        try {
            if (menuId !== null && typeof GM_unregisterMenuCommand === 'function') {
                GM_unregisterMenuCommand(menuId);
            }
            menuId = GM_registerMenuCommand(t(showTimeline ? 'menuOn' : 'menuOff'), () => {
                setTimelineSetting(!showTimeline);
            });
        } catch (e) {
            log('注册菜单失败:', e);
        }
    }

    function applyTimelineSetting(on) {
        if (on === showTimeline) return;
        showTimeline = on;
        if (on) {
            scheduleScan();
        } else {
            // 关闭：清空排队中的请求，移除已挂载的时间线徽章（悬浮卡不受影响）
            tweetQueue.length = 0;
            tweetQueued.clear();
            document.querySelectorAll(TWEET_BADGE_SEL).forEach((el) => el.remove());
        }
        registerMenu();
    }

    function setTimelineSetting(on) {
        try {
            localStorage.setItem(TIMELINE_KEY, on ? '1' : '0');
        } catch (e) {
            // 存储被禁用时仅本次页面内有效
        }
        applyTimelineSetting(on);
    }

    function scheduleScan() {
        if (scanScheduled) return;
        scanScheduled = true;
        requestAnimationFrame(() => {
            scanScheduled = false;
            scanAll();
        });
    }

    function init() {
        log('归属地标注脚本启动 v0.41');
        injectStyles();
        registerMenu();
        scanAll();

        const mo = new MutationObserver((mutations) => {
            // 时间线关闭时只关心悬浮卡，减少无谓的扫描
            const sel = showTimeline ? TRIGGER_SEL : CARD_SEL;
            for (const m of mutations) {
                for (const n of m.addedNodes) {
                    if (n.nodeType !== 1) continue;
                    if (n.closest && (n.closest(OWN_SEL) || n.closest(TWEET_BADGE_SEL))) continue;
                    // 新卡片出现，或卡片 / 推文内部内容异步渲染完成
                    if (n.closest(sel) || n.querySelector(sel)) {
                        scheduleScan();
                        return;
                    }
                }
            }
        });

        mo.observe(document.body, { childList: true, subtree: true });

        try {
            const themeMo = new MutationObserver(refreshTweetBadgeColors);
            themeMo.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['style', 'class'],
            });
            themeMo.observe(document.body, {
                attributes: true,
                attributeFilter: ['style', 'class'],
            });
            themeMo.observe(document.head, { childList: true, subtree: true, characterData: true });
        } catch (e) {
            // 主题观察失败不影响主功能
        }
        try {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            if (mq.addEventListener) mq.addEventListener('change', refreshTweetBadgeColors);
        } catch (e) {
            // ignore
        }

        // 其他标签页改了开关时同步
        window.addEventListener('storage', (e) => {
            if (e.key === TIMELINE_KEY) applyTimelineSetting(e.newValue === '1');
        });

        // 页面关闭 / 切到后台前，立即把防抖期内的缓存落盘
        window.addEventListener('pagehide', flushCache);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) flushCache();
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init, { once: true });
    }
})();