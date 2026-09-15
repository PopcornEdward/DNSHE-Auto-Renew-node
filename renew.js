#!/usr/bin/env node
'use strict';

/**
 * DNSHE 免费域名自动续期 —— 入口。
 *
 * 两种引擎（DNSHE_MODE 环境变量选择）：
 *   browser（默认）：Playwright + 原生 Chrome CDP，stealth + Turnstile
 *                    hook + CDP 原生鼠标点击绕过 Cloudflare 盾，网页续期。
 *   api（备选）    ：DNSHE 官方 REST API 直连续期，无需浏览器，稳定快速。
 *
 * 退出码：0 = 全部正常；1 = 存在失败项 / 登录失败 / 配置缺失 / 异常。
 */

const logger = require('./src/logger');
const { loadConfig, getUsers } = require('./src/config');
const { pushReport } = require('./src/notify');

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    logger.error(`配置加载失败: ${e.message}`);
    process.exit(1);
  }

  // 自动兜底：若配置了 API 凭据则优先用 api（更稳定），否则 fallback 到 browser
  const effectiveMode =
    cfg.mode || (cfg.api.apiKey && cfg.api.apiSecret ? 'api' : 'browser');

  logger.info(`== DNSHE Auto Renew (${effectiveMode === 'browser' ? '浏览器引擎 CDP' : '官方 API 引擎'}) ==`);

  if (effectiveMode === 'browser') {
    const users = getUsers();
    if (users.length === 0) {
      const msg =
        '❌ 未配置任何账号：请在 Secrets 中设置 USERS_JSON（多账号）或\n' +
        '   DNSHE_USERNAME + DNSHE_PASSWORD（单账号），或放置本地 users.json。';
      logger.error(msg.replace(/\n/g, ' '));
      await pushReport(cfg.notify, { title: cfg.notify.pushTitle, content: msg });
      process.exit(1);
    }
    logger.info(`共 ${users.length} 个账号待处理`);
    const { runBrowserRenew } = require('./src/browser-engine');
    return runBrowserRenew(cfg, users);
  }

  const { runApiRenew } = require('./src/api-engine');
  return runApiRenew(cfg);
}

main()
  .then((result) => {
    if (result && typeof result.report === 'string') {
      logger.info(result.report);
    }
    process.exit(result && result.exitCode ? result.exitCode : 0);
  })
  .catch((e) => {
    const detail = (e && e.stack) || String(e);
    logger.error(`❌ 续期脚本异常中断:\n${detail}`);
    Promise.resolve()
      .then(() => {
        const cfg = loadConfig().catch ? null : loadConfig();
        return cfg
          ? pushReport(cfg.notify, {
              title: 'DNSHE 续期异常',
              content: `⚠️ 续期脚本异常中断，本次续期未完成\n\n${detail.slice(-1500)}`,
            })
          : true;
      })
      .finally(() => process.exit(1));
  });