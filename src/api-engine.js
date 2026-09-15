'use strict';

/**
 * 官方 API 引擎（备选 / 保底方案，对应原 Python 版 renew_domains.py 的
 * Node.js 移植）。
 *
 * DNSHE 官方 REST API（文档：DNSHE Free Domain API User Guide V2.0）：
 *   - 认证头：X-API-Key / X-API-Secret
 *   - 列表：GET  ...&endpoint=subdomains&action=list&fields=...&page=N&per_page=200
 *   - 积分：GET  ...&endpoint=quota
 *   - 续期：POST ...&endpoint=subdomains&action=renew {"subdomain_id": N}
 *
 * 规则：剩余天数 >= 阈值(默认180)跳过；never_expires 跳过；剩余天数未知
 * 也尝试续期。renewal_not_yet_available（尚未进入续期窗口）为良性结果。
 */

const logger = require('./logger');
const { pushReport } = require('./notify');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP 客户端（内置 fetch + 轻量重试与限流）
// ---------------------------------------------------------------------------
class DnsheClient {
  constructor(apiCfg) {
    this.cfg = apiCfg;
    this._lastCall = 0;
  }

  /** 相邻请求间隔不低于 minInterval 秒，避免触发每分钟 30 次限流 */
  async _throttle() {
    if (this.cfg.minInterval <= 0) return;
    const gap = Date.now() - this._lastCall;
    if (this._lastCall && gap < this.cfg.minInterval * 1000) {
      await sleep(this.cfg.minInterval * 1000 - gap);
    }
    this._lastCall = Date.now();
  }

  _headers() {
    return {
      'X-API-Key': this.cfg.apiKey,
      'X-API-Secret': this.cfg.apiSecret,
      'Content-Type': 'application/json',
    };
  }

  async _request(method, url, body) {
    await this._throttle();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: this._headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new Error(`网络请求失败: ${e.message}`);
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error(`响应非 JSON (HTTP ${res.status}): ${(await res.text().catch(() => '')) || ''}`);
    }
    if (typeof data !== 'object' || data === null) {
      throw new Error(`响应格式异常: ${String(data).slice(0, 200)}`);
    }

    // 统一业务错误结构: { success:false, error_code, message, details }
    if (data.success === false || data.error_code) {
      const err = new Error(this._describe(data));
      err.code = data.error_code || null;
      err.payload = data;
      throw err;
    }
    return data;
  }

  _describe(payload) {
    const message =
      payload.message || payload.error || payload.error_code || '未知错误';
    const code = payload.error_code ? ` [${payload.error_code}]` : '';
    let text = `${message}${code}`;
    if (payload.details && typeof payload.details === 'object') {
      const extra = ['limit', 'remaining', 'reset_at']
        .filter((k) => payload.details[k] !== undefined && payload.details[k] !== null)
        .map((k) => `${k}=${payload.details[k]}`);
      if (extra.length) text += ` (${extra.join(', ')})`;
    }
    return text;
  }

  /** GET 幂等，自动重试 429/5xx（最多 3 次） */
  async _get(url) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this._request('GET', url);
      } catch (e) {
        lastErr = e;
        if (e.code === 'renewal_not_yet_available') throw e; // 业务错误不重试
        const retryable = /429|5\d\d/.test(e.message) || e.message.includes('网络请求失败');
        if (!retryable || attempt === 3) throw e;
        logger.warn(`[api] GET 重试（${attempt}/3）: ${e.message}`);
        await sleep(2000 * attempt);
      }
    }
    throw lastErr;
  }

  /** POST 只重试 429（服务端明确拒收，未产生副作用） */
  async _post(url, body) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this._request('POST', url, body);
      } catch (e) {
        if (e.code) throw e; // 业务错误（含良性 renewal_not_yet_available）不上抛重试
        if (attempt === 2 || !e.message.includes('429')) throw e;
        await sleep(2000 * attempt);
      }
    }
    throw new Error('POST 重试耗尽');
  }

  async fetchQuota() {
    const data = await this._get(`${this.cfg.baseUrl}&endpoint=quota`);
    if (!data.quota || typeof data.quota !== 'object') {
      throw new Error('积分接口响应缺少 quota 字段');
    }
    return data.quota;
  }

  /** 逐页拉取全部子域名（id 去重，防止服务端忽略 page 参数造成无限累积） */
  async fetchSubdomains() {
    const collected = [];
    const seenIds = new Set();
    let page = 1;

    while (page <= this.cfg.maxPages) {
      const data = await this._get(
        `${this.cfg.baseUrl}&endpoint=subdomains&action=list` +
          `&fields=${this.cfg.listFields}&page=${page}&per_page=${this.cfg.pageSize}`
      );
      const batch = data.subdomains;
      if (!Array.isArray(batch)) {
        throw new Error('域名列表响应缺少 subdomains 字段或格式异常（接口可能已变更）');
      }

      let freshCount = 0;
      for (const item of batch) {
        if (item && typeof item === 'object' && item.id !== undefined) {
          if (seenIds.has(item.id)) continue;
          seenIds.add(item.id);
        }
        collected.push(item);
        freshCount++;
      }

      const pagination = data.pagination;
      const hasMore =
        pagination && typeof pagination === 'object' && 'has_more' in pagination
          ? Boolean(pagination.has_more)
          : batch.length >= this.cfg.pageSize && freshCount > 0;
      if (!hasMore) break;

      let nextPage = page + 1;
      if (pagination && pagination.next_page !== undefined) {
        const n = Number(pagination.next_page);
        if (Number.isFinite(n) && n > page) nextPage = n;
      }
      page = nextPage;
    }

    if (page > this.cfg.maxPages) {
      throw new Error(`域名列表分页超过 ${this.cfg.maxPages} 页，疑似接口异常，已中止`);
    }
    if (collected.length === 0) {
      throw new Error('未获取到任何子域名，疑似凭据失效或接口变更，请人工核查');
    }
    return collected;
  }

  /** 提交续期。业务失败（如 renewal_not_yet_available）以 payload 形式随错误返回。 */
  async renew(subdomainId) {
    const url = `${this.cfg.baseUrl}&endpoint=subdomains&action=renew`;
    let payload;
    try {
      payload = await this._post(url, { subdomain_id: subdomainId });
    } catch (e) {
      if (e.payload) {
        return e.payload; // 业务失败响应带 error_code，交上层判断良恶性
      }
      throw e;
    }
    return payload;
  }
}

// ---------------------------------------------------------------------------
// 域名判定与报告
// ---------------------------------------------------------------------------
const EXPIRY_FORMATS = ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'];

function parseExpiry(value, tzOffsetHours) {
  if (!value || typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const tzMs = tzOffsetHours * 3600 * 1000;

  // 处理 YYYY-MM-DD[ HH:mm[:ss]]
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const date = new Date(
      Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))
    );
    return new Date(date.getTime() - tzMs); // 还原为绝对时刻（视为给定时区）
  }

  // ISO 8601（带偏移 / Z）
  const isoText = text.endsWith('Z') ? text : text;
  const parsed = new Date(isoText);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  logger.warn(`[api] 无法解析到期时间 ${value}`);
  return null;
}

function inspectDomain(raw, index) {
  const position = `第${index + 1}条记录`;
  if (!raw || typeof raw !== 'object') {
    return { label: position, problem: `记录格式异常: ${String(raw).slice(0, 80)}` };
  }
  const label = raw.full_domain || raw.subdomain || position;
  const view = {
    label,
    id: raw.id,
    neverExpires: Boolean(raw.never_expires),
    expiresRaw: raw.expires_at || null,
    expiresAt: null,
    daysRemaining: null,
    problem: null,
  };
  if (view.id === undefined || view.id === null) {
    view.problem = '响应缺少 id 字段，无法续期';
    return view;
  }
  view.expiresAt = parseExpiry(view.expiresRaw, 8);
  if (view.expiresAt) {
    view.daysRemaining = Math.floor((view.expiresAt - Date.now()) / 86400000);
  }
  return view;
}

function expiryLine(view) {
  if (view.problem) return `${view.label}: 到期时间 未知（记录异常）`;
  if (view.neverExpires) return `${view.label}: 到期时间 永久有效`;
  if (view.daysRemaining !== null)
    return `${view.label}: 到期时间 ${view.expiresRaw} (剩余 ${view.daysRemaining}天)`;
  if (view.expiresRaw) return `${view.label}: 到期时间 ${view.expiresRaw} (无法解析剩余天数)`;
  return `${view.label}: 到期时间 未知`;
}

function quotaLine(quota) {
  const parts = [];
  if (quota.available !== undefined) parts.push(`可用 ${quota.available}`);
  if (quota.used !== undefined) parts.push(`已用 ${quota.used}`);
  if (quota.total !== undefined) parts.push(`总额 ${quota.total}`);
  const summary = parts.length ? parts.join('，') : JSON.stringify(quota).slice(0, 120);
  if (Number(quota.available) <= 0) {
    return `⚠️ 账户积分：${summary}（积分已耗尽，付费续期将失败）`;
  }
  return `账户积分：${summary}`;
}

function formatCharge(charged) {
  try {
    if (Number(charged) === 0) return '免费';
  } catch (e) {
    /* ignore */
  }
  return `消耗 ${charged} 积分`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function runApiRenew(cfg) {
  const { apiKey, apiSecret, thresholdDays } = cfg.api;
  if (!apiKey || !apiSecret) {
    const msg = '❌ 缺少必需的环境变量: DNSHE_API_KEY / DNSHE_API_SECRET\n' +
      '请登录 DNSHE 后台 -> 免费域名管理 -> API 管理 -> 创建 API 密钥，' +
      '并配置到仓库 Secrets。';
    logger.error(msg);
    await pushReport(cfg.notify, { title: cfg.notify.pushTitle, content: msg });
    return { report: [msg], hasProblems: true, exitCode: 1 };
  }

  const client = new DnsheClient(cfg.api);

  // 1. 拉取域名列表
  let subdomains;
  try {
    subdomains = await client.fetchSubdomains();
  } catch (e) {
    const msg = `❌ 获取域名列表失败，本次未执行任何续期: ${e.message}`;
    logger.error(msg);
    await pushReport(cfg.notify, { title: cfg.notify.pushTitle, content: msg });
    return { report: [msg], hasProblems: true, exitCode: 1 };
  }

  // 2. 积分（辅助信息，失败不致命）
  let quotaText;
  try {
    quotaText = quotaLine(await client.fetchQuota());
  } catch (e) {
    quotaText = `账户积分：查询失败（${e.message}）`;
  }

  // 3. 逐域判定并续期
  const renewalResults = [];
  const expiryLines = [];
  let hasFailure = false;

  for (let i = 0; i < subdomains.length; i++) {
    const view = inspectDomain(subdomains[i], i);
    expiryLines.push(expiryLine(view));

    if (view.problem) {
      hasFailure = true;
      renewalResults.push(`❌ ${view.label}: ${view.problem}`);
      continue;
    }
    if (view.neverExpires) {
      renewalResults.push(`⏭️ ${view.label}: 已设置为永不过期，跳过续期`);
      continue;
    }
    if (view.daysRemaining !== null && view.daysRemaining >= thresholdDays) {
      renewalResults.push(
        `⏭️ ${view.label}: 剩余 ${view.daysRemaining}天 >= ${thresholdDays}天，跳过续期`
      );
      continue;
    }

    // 剩余天数未知也尝试续期：宁可撞一次 422，也不要漏掉真要过期的域名
    try {
      const payload = await client.renew(view.id);
      if (payload.success) {
        const newExpiry = payload.new_expires_at || '未知';
        const tail = payload.remaining_days !== undefined ? `，剩余 ${payload.remaining_days}天` : '';
        renewalResults.push(
          `✅ ${view.label}: 续期成功 (新到期 ${newExpiry}${tail}, ${formatCharge(payload.charged_amount)})`
        );
        // 续期成功后刷新到期清单
        view.expiresRaw = payload.new_expires_at || view.expiresRaw;
        view.expiresAt = parseExpiry(view.expiresRaw, cfg.api.tzOffsetHours);
        view.daysRemaining = view.expiresAt
          ? Math.floor((view.expiresAt - Date.now()) / 86400000)
          : null;
        expiryLines[expiryLines.length - 1] = expiryLine(view);
      } else {
        // 理论不会走到：业务失败已在 client 层抛错
        renewalResults.push(`❌ ${view.label}: 续期失败 (${JSON.stringify(payload).slice(0, 120)})`);
        hasFailure = true;
      }
    } catch (e) {
      if (e.code && cfg.api.benignErrorCodes.has(e.code)) {
        renewalResults.push(`⏭️ ${view.label}: 暂不可续期 (${e.message})`);
      } else {
        renewalResults.push(`❌ ${view.label}: 续期失败 (${e.message})`);
        hasFailure = true;
      }
    }
  }

  // 4. 汇总报告
  const parts = [quotaText, '', '=== 本次续期结果 ==='];
  if (renewalResults.length) {
    parts.push(...renewalResults);
  } else {
    parts.push(`（所有域名剩余天数 >= ${thresholdDays}天，本次无需续期）`);
  }
  if (hasFailure) {
    parts.push('', '⚠️ 存在失败项，请查看 GitHub Actions 日志并人工处理');
  }
  parts.push('', '=== 所有域名到期时间 ===');
  parts.push(...expiryLines);
  parts.push('', `（共 ${expiryLines.length} 个域名；到期时间按 UTC+${cfg.api.tzOffsetHours} 解读）`);

  const message = parts.join('\n');
  logger.info('\n' + message);

  await pushReport(cfg.notify, { title: cfg.notify.pushTitle, content: message });
  return { report: [message], hasProblems: hasFailure, exitCode: hasFailure ? 1 : 0 };
}

module.exports = { runApiRenew };