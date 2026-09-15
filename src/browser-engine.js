'use strict';

/**
 * 浏览器引擎：DNSHE 域名自动续期（Playwright + 原生 Chrome CDP 控制）。
 *
 * 整体流程（继承自 katabump 项目并适配 DNSHE）：
 *  1. 以 --remote-debugging-port 启动原生 Chrome（GitHub Actions 上配合
 *     xvfb 模拟有头环境，降低 Cloudflare 识别度）；
 *  2. Playwright connectOverCDP 直连 Chrome，建立真实浏览器会话；
 *  3. 注入 stealth 插件 + Turnstile hook 脚本（src/inject.js）；
 *  4. 逐账号：登录 my.dnshe.com -> 打开免费域名管理页 -> 逐个点击
 *     "Free Renewal" 续期按钮 -> 若触发 Cloudflare Turnstile，用 CDP
 *     原生鼠标事件点击绕过 -> 判定结果；
 *  5. 汇总报告并推送（notify.js），全程截图留痕。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const logger = require('./logger');
const { TURNSTILE_INJECT_SCRIPT } = require('./inject');
const { attemptTurnstile, isTurnstileSuccess } = require('./turnstile');
const { pushReport } = require('./notify');

const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 检查 CDP 调试端口是否已就绪 */
function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/json/version`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 启动原生 Chrome（若端口已被占用则直接复用） */
async function launchNativeChrome(cfg) {
  if (await checkPort(cfg.debugPort)) {
    logger.info(`[browser] CDP 端口 ${cfg.debugPort} 已有 Chrome，直接复用`);
    return;
  }

  logger.info(`[browser] 启动原生 Chrome: ${cfg.chromePath}`);
  ensureDir(cfg.userDataDir);

  const args = [
    `--remote-debugging-port=${cfg.debugPort}`,
    `--user-data-dir=${cfg.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=AutomationControlled',
    '--window-size=1280,900',
  ];
  if (cfg.headless) args.push('--headless=new');

  const chrome = spawn(cfg.chromePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  chrome.unref();

  for (let i = 0; i < 30; i++) {
    if (await checkPort(cfg.debugPort)) {
      logger.ok(`[browser] Chrome 已就绪（端口 ${cfg.debugPort}）`);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`Chrome 启动失败（端口 ${cfg.debugPort} 未就绪），请检查 CHROME_PATH`);
}

// ---------------------------------------------------------------------------
// 页面辅助
// ---------------------------------------------------------------------------

/** 依次尝试候选选择器，返回第一个可见元素（无则 null） */
async function findVisible(page, selectors, timeoutMs = 3000) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: timeoutMs });
      return loc;
    } catch (e) {
      /* 尝试下一个 */
    }
  }
  return null;
}

async function fillFirstVisible(page, selectors, value, what) {
  const loc = await findVisible(page, selectors);
  if (!loc) {
    throw new Error(`找不到${what}输入框（已尝试: ${selectors.join(' | ')}）`);
  }
  await loc.fill(value);
  return loc;
}

async function clickFirstVisible(page, selectors, what) {
  const loc = await findVisible(page, selectors);
  if (!loc) {
    throw new Error(`找不到${what}（已尝试: ${selectors.join(' | ')}）`);
  }
  await loc.click();
}

/** 页面是否存在登录表单（任一用户名字段可见） */
async function detectLoginForm(page, cfg) {
  const loc = await findVisible(page, cfg.selectors.usernameInputs, 2000);
  return loc !== null;
}

/** 页面是否出现任一候选文本 */
async function anyTextVisible(page, texts, timeoutMs = 600) {
  for (const t of texts) {
    try {
      const loc = page.getByText(t, { exact: false }).first();
      if (await loc.isVisible({ timeout: timeoutMs })) return t;
    } catch (e) {
      /* 继续 */
    }
  }
  return null;
}

/** 找页面上第一个可见的续期按钮（button / link / 任意可点击元素） */
async function findRenewButton(page, cfg) {
  const texts = cfg.selectors.renewTexts;
  for (const t of texts) {
    for (const role of ['button', 'link', 'menuitem']) {
      try {
        const loc = page.getByRole(role, { name: t, exact: false }).first();
        if (await loc.isVisible({ timeout: 1500 })) return loc;
      } catch (e) {
        /* 继续 */
      }
    }
    // 兜底：任意标签文本命中（可能导致误点，用于页面结构非标准的情况）
    try {
      const loc = page.getByText(t, { exact: false }).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
        if (tag !== 'body' && tag !== 'html') return loc;
      }
    } catch (e) {
      /* 继续 */
    }
  }
  return null;
}

/** 续期后可能弹出确认框：出现确认/确定类按钮则点击 */
async function clickConfirmIfAppears(page, cfg, timeoutMs = 3000) {
  const candidates = ['Confirm Renewal', 'Confirm', '确认续期', '确定', '确认', 'Yes'];
  for (const c of candidates) {
    try {
      for (const role of ['button', 'link']) {
        const loc = page.getByRole(role, { name: c, exact: false }).first();
        if (await loc.isVisible({ timeout: 600 })) {
          logger.info(`[renew] 检测到确认按钮 "${c}"，点击`);
          await loc.click();
          return true;
        }
      }
    } catch (e) {
      /* 继续 */
    }
  }
  return false;
}

/**
 * 截图留痕：每次同时输出两张图
 *   - 缩略图 viewport 截图（供 Telegram 图片消息推送 / 快速预览）
 *   - 整页 full 截图（供 Actions Artifacts 完整存档）
 * @returns {Promise<string|null>} 缩略图绝对路径，失败返回 null
 */
async function shoot(page, tag) {
  try {
    ensureDir(SCREENSHOT_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const thumbFile = path.join(SCREENSHOT_DIR, `${stamp}_${tag}_thumb.png`);
    const fullFile = path.join(SCREENSHOT_DIR, `${stamp}_${tag}_full.png`);
    await page.screenshot({ path: thumbFile }); // viewport 缩略
    await page.screenshot({ path: fullFile, fullPage: true }); // 整页存档
    logger.info(`[browser] 截图已保存(缩略+整页): ${path.basename(thumbFile)}`);
    return thumbFile;
  } catch (e) {
    logger.warn(`[browser] 截图失败: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

async function ensureLoggedIn(page, cfg, user) {
  await page.goto(cfg.domainsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  if (!(await detectLoginForm(page, cfg))) {
    logger.ok(`[${user.username}] 已处于登录态（免登录表单）`);
    return { ok: true };
  }

  logger.info(`[${user.username}] 检测到登录表单，执行登录...`);
  await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  const sels = cfg.selectors;
  await fillFirstVisible(page, sels.usernameInputs, user.username, '用户名');
  await fillFirstVisible(page, sels.passwordInputs, user.password, '密码');

  // 登录前若出现 Turnstile，CDP 点击绕过（最多尝试 15 次）
  let cdpClicked = false;
  for (let i = 0; i < 15; i++) {
    if (await attemptTurnstile(page)) {
      cdpClicked = true;
      break;
    }
    await sleep(1000);
  }
  if (cdpClicked) {
    logger.info('[login] 已点击 Turnstile，等待 Cloudflare 验证（最多 10s）...');
    for (let i = 0; i < 10; i++) {
      if (await isTurnstileSuccess(page)) break;
      await sleep(1000);
    }
  }

  await clickFirstVisible(page, sels.loginButtons, '登录按钮');

  // 登录结果判定（最多 15s）
  for (let i = 0; i < 15; i++) {
    const failedText = await anyTextVisible(page, sels.loginFailedTexts, 500);
    if (failedText) {
      const thumb = await shoot(page, 'login_failed');
      return { ok: false, reason: `登录失败（页面提示: ${failedText}）`, thumb };
    }
    if (!(await detectLoginForm(page, cfg))) {
      logger.ok(`[${user.username}] 登录成功`);
      await shoot(page, 'after_login');
      return { ok: true };
    }
    await sleep(1000);
  }
  const thumb = await shoot(page, 'login_timeout');
  return { ok: false, reason: '登录后未确认跳转（超时），请查看截图', thumb };
}

// ---------------------------------------------------------------------------
// 单个域名续期
// ---------------------------------------------------------------------------

async function renewOneButton(page, cfg, user, btn) {
  let detail = '';
  try {
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click();
    logger.info(`[${user.username}] 续期按钮已点击`);
  } catch (e) {
    return { status: 'failed', detail: `点击续期按钮失败: ${e.message}` };
  }

  await sleep(1000);
  await clickConfirmIfAppears(page, cfg, 2500);

  // Turnstile 检测与点击（最多 30 次，每次间隔 1s）
  let cdpClicked = false;
  for (let i = 0; i < 30; i++) {
    if (await attemptTurnstile(page)) {
      cdpClicked = true;
      break;
    }
    await sleep(1000);
  }
  if (cdpClicked) {
    logger.info(`[${user.username}] Turnstile 已点击，等待 Cloudflare 判定（最多 10s）...`);
    for (let i = 0; i < 10; i++) {
      if (await isTurnstileSuccess(page)) break;
      await sleep(1000);
    }
  }

  // 结果判定
  const sels = cfg.selectors;
  let hit = await anyTextVisible(page, sels.successMarkers);
  if (hit) return { status: 'success', detail: `检测到成功提示: ${hit}` };

  hit = await anyTextVisible(page, sels.notReadyMarkers);
  if (hit) return { status: 'notReady', detail: `尚未进入续期窗口（提示: ${hit}）` };

  hit = await anyTextVisible(page, sels.captchaErrorMarkers);
  if (hit) return { status: 'captcha', detail: `人机验证未通过（提示: ${hit}），需要刷新重试` };

  return {
    status: 'unconfirmed',
    detail: '未检测到明确的成功 / 失败提示，请查看截图人工核对',
  };
}

/** 循环处理页面上全部可续期域名 */
async function renewAllDomains(page, cfg, user) {
  const results = [];
  const images = []; // 缩略图路径（用于 Telegram 图片推送）
  for (let round = 0; round < 50; round++) {
    const btn = await findRenewButton(page, cfg);
    if (!btn) break; // 页面已无续期按钮

    let verdict = { status: 'retry', detail: '' };
    for (let retry = 1; retry <= 5 && verdict.status === 'retry'; retry++) {
      if (retry > 1) {
        logger.info(`[${user.username}] captcha 未通过，刷新页面重试（第 ${retry} 次）`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3500);
      }
      const btnNow = await findRenewButton(page, cfg);
      if (!btnNow) {
        verdict = { status: 'none', detail: '刷新后未再发现续期按钮' };
        break;
      }
      verdict = await renewOneButton(page, cfg, user, btnNow);
      if (verdict.status === 'captcha') {
        verdict = { status: 'retry', detail: verdict.detail };
      }
    }
    if (verdict.status === 'retry') {
      verdict = { status: 'failed', detail: '连续 5 次因验证码失败，已放弃（可能需人工处理滑块）' };
    }

    results.push(verdict);
    logger.info(
      `[${user.username}] 域名 #${results.length} 续期结果: ${verdict.status} - ${verdict.detail}`
    );
    // 无论续期成功 / 失败 / 跳过，都截图留痕（缩略图 + 整页）
    const thumb = await shoot(page, `renew_${results.length}_${verdict.status}`);
    if (thumb) images.push(thumb);
    await sleep(2000); // 页面状态稳定
  }

  if (results.length === 0) {
    results.push({ status: 'none', detail: '页面未发现可续期的 "Free Renewal" 按钮（可能均已续期 / 未进入续期窗口 / 页面结构变化）' });
    // "没有可续期项"同样要截图，方便人工确认页面状态
    const thumb = await shoot(page, 'renew_0_none');
    if (thumb) images.push(thumb);
  }
  return { results, images };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function runBrowserRenew(cfg, users) {
  process.env.NO_PROXY = 'localhost,127.0.0.1';
  await launchNativeChrome(cfg.browser);

  const { chromium } = require('playwright-extra');
  const stealth = require('puppeteer-extra-plugin-stealth')();
  chromium.use(stealth);

  let browser;
  for (let k = 0; k < 5; k++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${cfg.browser.debugPort}`);
      logger.ok('[browser] 已通过 CDP 连接 Chrome');
      break;
    } catch (e) {
      logger.warn(`[browser] CDP 连接失败（第 ${k + 1} 次），2s 后重试...`);
      await sleep(2000);
    }
  }
  if (!browser) {
    throw new Error('无法连接 Chrome CDP，放弃执行');
  }

  const report = [];
  let hasProblems = false;
  const pushImages = []; // 汇总所有续期截图缩略图，随 Telegram 报告推送

  try {
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      logger.info(`\n===== 处理账号 ${i + 1}/${users.length}: ${user.username} =====`);

      // 每个账号独立 context：避免上一个账号的登录态串用到下个账号，
      // 导致误判"已登录"而跳过登录（多账号模式下必需）
      let context;
      try {
        context = await browser.newContext();
      } catch (e) {
        context = browser.contexts()[0] || (await browser.newContext());
      }
      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(60000);
      await page.addInitScript(TURNSTILE_INJECT_SCRIPT);

      try {
        const login = await ensureLoggedIn(page, cfg, user);
        if (!login.ok) {
          logger.error(`[${user.username}] ${login.reason}`);
          report.push(`❌ ${user.username}: ${login.reason}`);
          hasProblems = true;
          // 登录失败截图一并推送，便于人工核对
          if (login.thumb) pushImages.push(login.thumb);
          continue;
        }

        // 回到域名管理页
        await page.goto(cfg.browser.domainsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3500);

        // 可选：点击确认框之外的“续期”入口已处理，直接扫描按钮
        const { results: domainResults, images: domainImages } = await renewAllDomains(page, cfg, user);
        for (const img of domainImages) pushImages.push(img);
        for (const r of domainResults) {
          if (r.status === 'success') {
            report.push(`✅ ${user.username}: ${r.detail}`);
          } else if (r.status === 'notReady' || r.status === 'none') {
            report.push(`⏭️ ${user.username}: ${r.detail}`);
          } else {
            report.push(`⚠️ ${user.username}: ${r.detail}`);
            hasProblems = true;
          }
        }
      } catch (err) {
        logger.error(`[${user.username}] 处理异常: ${err.message}`);
        report.push(`❌ ${user.username}: 异常 ${err.message}`);
        hasProblems = true;
        const thumb = await shoot(page, 'user_error').catch(() => null);
        if (thumb) pushImages.push(thumb);
      }
    }
  } finally {
    try {
      await browser.close();
    } catch (e) {
      /* 忽略关闭异常 */
    }
  }

  // 汇总推送到 Telegram（文本报告 + 截图缩略图，最多 6 张防止刷屏）
  const message = report.join('\n');
  logger.info('\n' + message);
  await pushReport(cfg.notify, {
    title: cfg.notify.pushTitle,
    content: message,
    images: pushImages.slice(0, 6),
  });

  return { report, hasProblems, exitCode: hasProblems ? 1 : 0 };
}

module.exports = { runBrowserRenew };