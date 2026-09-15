'use strict';

/**
 * 浏览器引擎：DNSHE 域名自动续期（Playwright + 原生 Chrome CDP 控制）。
 *
 * 新版 DNSHE 流程（基于用户提供的 2026-09 截图）：
 *  1. 登录 https://my.dnshe.com/clientarea.php（用户名/密码 + Sign In）
 *  2. 进入域名列表 https://my.dnshe.com/index.php?m=domain_hub
 *  3. 提取每行域名的 domain_id（从"管理域名"按钮 href 或 data-domain-id）
 *  4. 逐个访问域名详情页：https://my.dnshe.com/index.php?m=domain_hub&view=domain&domain_id={id}
 *  5. 点击"续期和域名详情" tab
 *  6. 检查续期按钮：文本为"当前不可续期"且 disabled → 跳过
 *     否则点击续期，等待结果
 *  7. 返回列表继续下一个域名
 *  8. 全部完成后：点击右上角头像 → 点击"退出账户"
 *  9. 等待 8s，若未跳转到 clientarea.php 则强制访问
 * 10. 处理下一个 USERS_JSON 账号
 *
 * CDP 绕 Cloudflare 盾逻辑（stealth + Turnstile hook）保持不变。
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
    '--lang=zh-CN',
    '--accept-lang=zh-CN,zh',
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
// 语言切换（DNSHE 支持中英文，若页面为英文则切回中文使选择器生效）
// ---------------------------------------------------------------------------

/** 安全追加语言参数到 URL（DNSHE 格式: autolang=1&language=chinese） */
function appendLangParam(url) {
  if (!url) return url;
  // 先清除已有的语言参数，避免重复
  const clean = url
    .replace(/[?&]autolang=[^&]*/g, '')
    .replace(/[?&]language=[^&]*/g, '');
  const sep = clean.includes('?') ? '&' : '?';
  return `${clean}${sep}autolang=1&language=chinese`;
}

async function switchToChinese(page) {
  try {
    // Step 1: 检测当前是否为英文界面
    const englishMarkers = [
      { sel: 'text="English"', name: 'English 按钮' },
      { sel: 'button:has-text("Sign In")', name: 'Sign In 按钮' },
      { sel: 'text="Welcome Back"', name: 'Welcome Back 文本' },
      { sel: 'text="Client Area"', name: 'Client Area 文本' },
    ];
    let isEnglish = false;
    for (const m of englishMarkers) {
      try {
        if (await page.locator(m.sel).first().isVisible({ timeout: 1000 })) {
          isEnglish = true;
          logger.info(`[lang] 检测到英文界面特征: ${m.name}`);
          break;
        }
      } catch (e) { /* 继续 */ }
    }
    if (!isEnglish) {
      logger.info('[lang] 未检测到英文界面特征，假设已是中文');
      return;
    }

    // Step 2: 直接通过 URL 参数切换语言（不依赖 UI 点击）
    const newUrl = appendLangParam(page.url());

    logger.info(`[lang] 通过 URL 参数切换语言: ${newUrl}`);
    await page.goto(newUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // Step 3: 确认是否已切换
    const chineseMarkers = [
      { sel: 'text="简体中文"', name: '语言按钮显示简体中文' },
      { sel: 'button:has-text("登录")', name: '登录按钮' },
      { sel: 'text="欢迎回来"', name: '欢迎回来' },
      { sel: 'text="我的域名"', name: '我的域名' },
      { sel: 'text="注册新域名"', name: '注册新域名' },
    ];
    let isChinese = false;
    for (const m of chineseMarkers) {
      try {
        if (await page.locator(m.sel).first().isVisible({ timeout: 1500 })) {
          isChinese = true;
          logger.info(`[lang] 检测到中文界面特征: ${m.name}`);
          break;
        }
      } catch (e) { /* 继续 */ }
    }
    if (isChinese) {
      logger.ok('[lang] 页面已切换为中文');
    } else {
      logger.warn('[lang] 语言切换后未检测到中文特征');
    }
  } catch (e) {
    logger.warn(`[lang] 语言切换异常: ${e.message}`);
  }
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

/** 页面是否存在登录表单 */
async function detectLoginForm(page, browserCfg) {
  const loc = await findVisible(page, browserCfg.selectors.usernameInputs, 2000);
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

/**
 * 截图留痕：每次同时输出两张图
 *   - 缩略图 viewport 截图（供 Telegram 图片消息推送）
 *   - 整页 full 截图（供 Actions Artifacts 存档）
 * @returns {Promise<string|null>} 缩略图绝对路径
 */
async function shoot(page, tag) {
  try {
    ensureDir(SCREENSHOT_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const thumbFile = path.join(SCREENSHOT_DIR, `${stamp}_${tag}_thumb.png`);
    const fullFile = path.join(SCREENSHOT_DIR, `${stamp}_${tag}_full.png`);
    await page.screenshot({ path: thumbFile });
    await page.screenshot({ path: fullFile, fullPage: true });
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

async function ensureLoggedIn(page, browserCfg, user) {
  const loginUrlWithLang = appendLangParam(browserCfg.loginUrl);
  await page.goto(loginUrlWithLang, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  await switchToChinese(page);

  // 如果已经在 dashboard（没有登录表单），可能是 cookie 未过期
  if (!(await detectLoginForm(page, browserCfg))) {
    // 再确认下是否真的是登录态（检查 dashboard 特征元素）
    const dashboardIndicators = ['欢迎回来', '我的域名', '控制台概览', 'Welcome back'];
    const onDashboard = await anyTextVisible(page, dashboardIndicators, 1500);
    if (onDashboard) {
      logger.ok(`[${user.username}] 已处于登录态（cookie 未过期）`);
      return { ok: true };
    }
  }

  logger.info(`[${user.username}] 检测到登录表单，执行登录...`);

  const sels = browserCfg.selectors;
  await fillFirstVisible(page, sels.usernameInputs, user.username, '用户名');
  await fillFirstVisible(page, sels.passwordInputs, user.password, '密码');

  // 登录前若出现 Turnstile，CDP 点击绕过
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
    if (!(await detectLoginForm(page, browserCfg))) {
      // 确认是否真的登录成功（检查 dashboard 特征）
      const onDashboard = await anyTextVisible(page, ['欢迎回来', '我的域名', '控制台概览', 'Welcome back'], 500);
      if (onDashboard) {
        logger.ok(`[${user.username}] 登录成功`);
        await switchToChinese(page);
        await shoot(page, 'after_login');
        return { ok: true };
      }
    }
    await sleep(1000);
  }
  const thumb = await shoot(page, 'login_timeout');
  return { ok: false, reason: '登录后未确认跳转（超时），请查看截图', thumb };
}

// ---------------------------------------------------------------------------
// 域名列表提取
// ---------------------------------------------------------------------------

async function fetchDomainList(page, browserCfg, user) {
  const domainsUrlWithLang = appendLangParam(browserCfg.domainsUrl);
  await page.goto(domainsUrlWithLang, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);

  await switchToChinese(page);

  // 截图：域名列表页
  await shoot(page, 'domain_list');

  // 在页面上下文中提取域名列表（从"管理域名"按钮的 href 中提取 domain_id）
  const domains = await page.evaluate((selectors) => {
    const results = [];
    const seen = new Set();

    // 策略1：找所有包含 domain_id 的链接
    document.querySelectorAll('a[href*="domain_id="]').forEach((a) => {
      const match = a.href.match(/domain_id=(\d+)/);
      if (!match) return;
      const domainId = match[1];
      if (seen.has(domainId)) return;
      seen.add(domainId);

      // 找同行/父容器里的域名名称
      const row = a.closest('tr') || a.closest('.domain-item') || a.closest('[class*="domain"]') || a.parentElement?.parentElement;
      let name = '';
      if (row) {
        const nameEl = row.querySelector('td:first-child, .domain-name, [class*="domain-name"], h3, h4, .name, [class*="name"]');
        if (nameEl) name = nameEl.textContent.trim();
      }
      // 如果 row 里没找到，尝试在 a 的前一个兄弟或父容器里找
      if (!name) {
        const prev = a.previousElementSibling;
        if (prev) name = prev.textContent.trim();
      }
      results.push({ domainId, name });
    });

    // 策略2：找 data-domain-id 属性
    if (results.length === 0) {
      document.querySelectorAll('[data-domain-id]').forEach((el) => {
        const domainId = el.getAttribute('data-domain-id');
        if (!domainId || seen.has(domainId)) return;
        seen.add(domainId);
        const row = el.closest('tr') || el.closest('.domain-item') || el.parentElement?.parentElement;
        let name = '';
        if (row) {
          const nameEl = row.querySelector('td:first-child, .domain-name, [class*="domain-name"], h3, h4');
          if (nameEl) name = nameEl.textContent.trim();
        }
        results.push({ domainId, name });
      });
    }

    return results;
  }, browserCfg.selectors);

  logger.info(`[${user.username}] 提取到 ${domains.length} 个域名`);
  if (domains.length === 0) {
    // 再次截图方便排查
    await shoot(page, 'domain_list_empty');
  }
  return domains;
}

// ---------------------------------------------------------------------------
// 单个域名续期
// ---------------------------------------------------------------------------

async function renewOneDomain(page, browserCfg, user, domain) {
  const detailUrl = `https://my.dnshe.com/index.php?m=domain_hub&view=domain&domain_id=${domain.domainId}`;
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // 截图：进入域名详情页
  const detailThumb = await shoot(page, `domain_detail_${domain.domainId}`);

  const sels = browserCfg.selectors;

  // 点击"续期和域名详情" tab
  let tabClicked = false;
  for (const sel of sels.renewTabSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 2000 })) {
        await loc.click();
        tabClicked = true;
        logger.info(`[${user.username}] 已点击"续期和域名详情"tab（${domain.name}）`);
        await page.waitForTimeout(2000);
        break;
      }
    } catch (e) {
      /* 继续 */
    }
  }

  if (!tabClicked) {
    const thumb = await shoot(page, `domain_renew_tab_not_found_${domain.domainId}`);
    return { status: 'failed', detail: `${domain.name}: 找不到"续期和域名详情"tab`, thumb };
  }

  // 截图：点击 tab 后
  await shoot(page, `domain_renew_tab_${domain.domainId}`);

  // 检查"当前不可续期"禁用按钮
  for (const sel of sels.notRenewableSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 2000 })) {
        const isDisabled = await loc.evaluate((el) => el.disabled || el.getAttribute('disabled') || el.classList.contains('disabled')).catch(() => false);
        if (isDisabled) {
          const thumb = await shoot(page, `domain_not_renewable_${domain.domainId}`);
          return { status: 'notReady', detail: `${domain.name}: 当前不可续期（按钮已禁用）`, thumb };
        }
      }
    } catch (e) {
      /* 继续 */
    }
  }

  // 查找可点击的续期按钮
  let renewBtn = null;
  for (const sel of sels.renewActionButtons) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 2000 })) {
        const isDisabled = await loc.evaluate((el) => el.disabled || el.getAttribute('disabled') || el.classList.contains('disabled')).catch(() => false);
        if (!isDisabled) {
          renewBtn = loc;
          break;
        }
      }
    } catch (e) {
      /* 继续 */
    }
  }

  if (!renewBtn) {
    const thumb = await shoot(page, `domain_no_renew_btn_${domain.domainId}`);
    return { status: 'notReady', detail: `${domain.name}: 未找到可点击的续期按钮`, thumb };
  }

  // 点击续期按钮
  try {
    await renewBtn.scrollIntoViewIfNeeded().catch(() => {});
    await renewBtn.click();
    logger.info(`[${user.username}] 已点击续期按钮（${domain.name}）`);
  } catch (e) {
    const thumb = await shoot(page, `domain_renew_click_failed_${domain.domainId}`);
    return { status: 'failed', detail: `${domain.name}: 点击续期按钮失败: ${e.message}`, thumb };
  }

  await sleep(2000);

  // 处理可能的确认弹窗
  for (const sel of sels.confirmSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        await loc.click();
        logger.info(`[${user.username}] 已点击确认按钮（${domain.name}）`);
        await sleep(1000);
        break;
      }
    } catch (e) {
      /* 继续 */
    }
  }

  // 处理 Turnstile
  for (let i = 0; i < 15; i++) {
    if (await attemptTurnstile(page)) break;
    await sleep(1000);
  }
  await sleep(3000);

  // 截图：续期操作后
  const afterThumb = await shoot(page, `domain_renew_after_${domain.domainId}`);

  // 判定结果
  const hitSuccess = await anyTextVisible(page, sels.successMarkers, 1000);
  if (hitSuccess) {
    return { status: 'success', detail: `${domain.name}: 续期成功（提示: ${hitSuccess}）`, thumb: afterThumb };
  }

  const hitFail = await anyTextVisible(page, sels.failMarkers, 1000);
  if (hitFail) {
    return { status: 'failed', detail: `${domain.name}: 续期失败（提示: ${hitFail}）`, thumb: afterThumb };
  }

  const hitNotReady = await anyTextVisible(page, sels.notReadyMarkers, 1000);
  if (hitNotReady) {
    return { status: 'notReady', detail: `${domain.name}: 尚未进入续期窗口（提示: ${hitNotReady}）`, thumb: afterThumb };
  }

  return { status: 'unconfirmed', detail: `${domain.name}: 续期结果未确认，请查看截图`, thumb: afterThumb };
}

// ---------------------------------------------------------------------------
// 退出登录
// ---------------------------------------------------------------------------

async function logoutAccount(page, browserCfg, user) {
  try {
    // 策略 1：直接访问 logout.php（最可靠，不依赖 UI 选择器）
    const logoutUrl = 'https://my.dnshe.com/logout.php';
    try {
      await page.goto(logoutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      logger.info(`[${user.username}] 已访问 logout.php 退出`);
      await sleep(4000);
    } catch (e) {
      logger.warn(`[${user.username}] 访问 logout.php 失败: ${e.message}，回退到 UI 点击`);
    }

    // 策略 2：若 logout.php 未生效，尝试 UI 点击退出
    const currentUrl = page.url();
    if (!currentUrl.includes('clientarea.php')) {
      // 点击右上角头像/用户名，打开下拉菜单
      let clicked = false;
      for (const sel of browserCfg.selectors.userMenuTriggers) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 2000 })) {
            await loc.click();
            clicked = true;
            await sleep(1500);
            break;
          }
        } catch (e) {
          /* 继续 */
        }
      }

      // 点击"退出账户"
      for (const sel of browserCfg.selectors.logoutButtons) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 2000 })) {
            await loc.click();
            logger.info(`[${user.username}] 已点击退出账户`);
            break;
          }
        } catch (e) {
          /* 继续 */
        }
      }

      await sleep(6000);
    }

    // 策略 3：仍未退出则强制访问登录页
    const finalUrl = page.url();
    if (!finalUrl.includes('clientarea.php')) {
      logger.info(`[${user.username}] 未自动跳转到登录页，强制访问 clientarea.php`);
      await page.goto(browserCfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
    }

    // 截图：退出后
    await shoot(page, 'after_logout');
  } catch (e) {
    logger.warn(`[${user.username}] 退出登录异常: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function runBrowserRenew(cfg, users) {
  process.env.NO_PROXY = 'localhost,127.0.0.1';
  const browserCfg = cfg.browser;

  await launchNativeChrome(browserCfg);

  const { chromium } = require('playwright-extra');
  const stealth = require('puppeteer-extra-plugin-stealth')();
  chromium.use(stealth);

  let browser;
  for (let k = 0; k < 5; k++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${browserCfg.debugPort}`);
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
  const pushImages = []; // 汇总所有截图缩略图

  try {
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      logger.info(`\n===== 处理账号 ${i + 1}/${users.length}: ${user.username} =====`);

      // 每个账号独立 context
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
        // 1. 登录
        const login = await ensureLoggedIn(page, browserCfg, user);
        if (!login.ok) {
          logger.error(`[${user.username}] ${login.reason}`);
          report.push(`❌ ${user.username}: ${login.reason}`);
          hasProblems = true;
          if (login.thumb) pushImages.push(login.thumb);
          continue;
        }

        // 2. 获取域名列表
        const domains = await fetchDomainList(page, browserCfg, user);
        if (domains.length === 0) {
          report.push(`⏭️ ${user.username}: 未找到任何域名`);
          logger.info(`[${user.username}] 无域名需要处理`);
        }

        // 3. 逐个续期
        for (let idx = 0; idx < domains.length; idx++) {
          const domain = domains[idx];
          logger.info(`[${user.username}] 处理域名 ${idx + 1}/${domains.length}: ${domain.name} (id=${domain.domainId})`);

          const result = await renewOneDomain(page, browserCfg, user, domain);
          if (result.thumb) pushImages.push(result.thumb);

          if (result.status === 'success') {
            report.push(`✅ ${user.username} / ${domain.name}: ${result.detail}`);
          } else if (result.status === 'notReady') {
            report.push(`⏭️ ${user.username} / ${domain.name}: ${result.detail}`);
          } else if (result.status === 'failed') {
            report.push(`❌ ${user.username} / ${domain.name}: ${result.detail}`);
            hasProblems = true;
          } else {
            report.push(`⚠️ ${user.username} / ${domain.name}: ${result.detail}`);
            hasProblems = true;
          }

          // 返回域名列表页（为下一个域名做准备）
          if (idx < domains.length - 1) {
            await page.goto(browserCfg.domainsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(2000);
          }
        }

        // 4. 退出登录
        await logoutAccount(page, browserCfg, user);

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

  // 汇总推送
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