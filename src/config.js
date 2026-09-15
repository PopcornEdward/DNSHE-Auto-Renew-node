'use strict';

/**
 * 统一配置：全部来自环境变量（GitHub Actions 通过 Secrets 注入，
 * 本地调试可通过 .env 或直接 export）。
 *
 * 浏览器相关的页面选择器集中放在 SELECTORS 里：若 DNSHE 页面结构
 * 调整，只需修改此处，不需要动引擎代码。
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// DNSHE 相关 URL（官方调整入口时只需改这里）
// ---------------------------------------------------------------------------
const BASE_URL = 'https://api005.dnshe.com/index.php?m=domain_hub';
const LOGIN_URL = 'https://my.dnshe.com/clientarea.php';
const DOMAINS_URL = 'https://my.dnshe.com/index.php?m=domain_hub';

// 列表接口字段（与官方 API 文档 V2.0 一致）
const LIST_FIELDS =
  'id,subdomain,rootdomain,full_domain,status,expires_at,never_expires';

// 续期窗口（天）：到期前 180 天开放续期，剩余天数 >= 阈值则跳过
const DEFAULT_THRESHOLD_DAYS = 180;
const PAGE_SIZE = 200;
const MAX_PAGES = 100;

// 良性错误码：尚未进入续期窗口，属预期结果，不计入失败
const BENIGN_ERROR_CODES = new Set(['renewal_not_yet_available']);

// ---------------------------------------------------------------------------
// 浏览器引擎页面选择器（集中管理）
// ---------------------------------------------------------------------------
const SELECTORS = {
  // ---- 登录页（新版 DNSHE 2026-09） ----
  usernameInputs: [
    'input[name="username"]',
    'input[type="email"]',
    'input[placeholder*="Username" i]',
    'input[placeholder*="Email" i]',
  ],
  passwordInputs: [
    'input[name="password"]',
    'input[type="password"]',
    'input[placeholder*="Password" i]',
  ],
  loginButtons: [
    'button:has-text("登录账户")',
    'button:has-text("Sign In")',
    'button:has-text("登录")',
    'button[type="submit"]',
    'input[type="submit"]',
  ],
  // 登录失败提示
  loginFailedTexts: [
    'Incorrect password',
    'incorrect password or no account',
    '用户名或密码错误',
    '登录失败',
    'Invalid login',
    'Invalid email or password',
  ],

  // ---- 域名列表页 ----
  // "管理域名"按钮（用于提取 domain_id 或点击）
  manageDomainButtons: [
    'a:has-text("管理域名")',
    'button:has-text("管理域名")',
    '.btn:has-text("管理域名")',
    'a[href*="domain_id="]',
  ],

  // ---- 域名详情页 -> "续期和域名详情" tab ----
  renewTabSelectors: [
    'text="续期和域名详情"',
    'text="Renewal and Domain Details"',
    '[role="tab"]:has-text("续期")',
    '.tab:has-text("续期")',
    'a:has-text("续期和域名详情")',
  ],

  // ---- 域名详情页 -> 续期操作 ----
  // "当前不可续期"禁用按钮（跳过）
  notRenewableSelectors: [
    'button:has-text("当前不可续期")',
    '.btn:has-text("当前不可续期")',
    '[disabled]:has-text("当前不可续期")',
  ],
  // 可点击的续期按钮
  renewActionButtons: [
    'button:has-text("续期")',
    '.btn:has-text("续期")',
    'button:has-text("Renew")',
    '.btn:has-text("Renew")',
    'button:has-text("免费续期")',
  ],
  // 确认弹窗按钮
  confirmSelectors: [
    'button:has-text("确认")',
    'button:has-text("确定")',
    'button:has-text("Confirm")',
    '.btn:has-text("确认")',
  ],

  // ---- 邮箱验证码（DNSHE 安全验证弹窗/页面） ----
  // 特征文本：出现则说明 DNSHE 触发邮箱安全验证
  verifyTitleTexts: [
    '安全验证',
    'Security Verification',
    '验证码已发送',
    '请输入验证码',
    '邮件验证码',
    'Verify your identity',
  ],
  // "记住此设备60天" 勾选框（若存在）
  rememberDeviceCheckboxes: [
    'input[type="checkbox"]',
    'input[name*="remember" i]',
    'input[id*="remember" i]',
    'input[type="checkbox"][value="1"]',
  ],
  // 验证码输入框：可能是 6 个独立输入格，也可能是单个输入框
  verifyCodeInputs: [
    'input[inputmode="numeric"]',
    'input[name*="code" i]',
    'input[id*="code" i]',
    'input[data-index]',
    '.otp-input input',
    '.otp-input',
    '.code-input input',
    '.verify-code input',
    'input[placeholder*="验证码" i]',
    'input[placeholder*="code" i]',
    'input[maxlength="6"]',
    'input[autocomplete="one-time-code"]',
  ],
  // 验证码提交按钮
  verifySubmitButtons: [
    'button:has-text("验证并继续")',
    'button:has-text("Verify and Continue")',
    'button:has-text("提交")',
    'button:has-text("确认")',
    'button[type="submit"]',
  ],

  // ---- 退出登录 ----
  // 右上角头像/用户名（触发下拉菜单）
  userMenuTriggers: [
    '[class*="avatar"]',
    '[class*="user-menu"]',
    'header [class*="user"]',
    '.navbar .dropdown-toggle',
    '.user-dropdown',
    '[class*="profile"]',
  ],
  // "退出账户"按钮
  logoutButtons: [
    'text="退出账户"',
    'text="Logout"',
    'text="Sign Out"',
    'a:has-text("退出")',
    'button:has-text("退出")',
  ],

  // ---- 结果判定 ----
  successMarkers: ['Success!', '续期成功', 'renewed successfully', '操作成功', '续期申请已提交'],
  failMarkers: ['续期失败', '操作失败', 'Failed', 'Error', '错误'],
  notReadyMarkers: ['当前不可续期', 'not_yet_available', '暂不可续期', "You can't renew", '尚未开放'],
};

// ---------------------------------------------------------------------------
// 读取辅助
// ---------------------------------------------------------------------------
function text(name) {
  return (process.env[name] || '').trim();
}

function number(name, fallback) {
  const raw = text(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonEnv(name, fallback, what) {
  const raw = text(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    logger_warn(`环境变量 ${name} 不是合法 JSON，已忽略（${what}）`);
    return fallback;
  }
}

// 避免循环依赖：logger 只在异常时使用，此处直接内联打印
function logger_warn(msg) {
  console.warn(`[config] ${msg}`);
}

// ---------------------------------------------------------------------------
// 浏览器引擎配置
// ---------------------------------------------------------------------------
function detectChromePath() {
  const envPath = text('CHROME_PATH');
  if (envPath) return envPath;
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return candidates[0];
  }
  // Linux (GitHub Actions runner 自带 google-chrome)
  return '/usr/bin/google-chrome';
}

function browserConfig() {
  const debugPort = number('CDP_PORT', 9222);
  const headless = text('CHROME_HEADLESS') === 'true';
  return {
    loginUrl: text('DNSHE_LOGIN_URL') || LOGIN_URL,
    domainsUrl: text('DNSHE_DOMAINS_URL') || DOMAINS_URL,
    chromePath: detectChromePath(),
    userDataDir: path.join(process.cwd(), 'ChromeData_DNSHE'),
    debugPort,
    headless,
    selectors: SELECTORS,
    listFields: LIST_FIELDS,
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
    benignErrorCodes: BENIGN_ERROR_CODES,
    // TOTP 密钥（推荐，替代 IMAP 邮件读取）
    totpSecret: text('DNSHE_TOTP_SECRET'),
  };
}

// ---------------------------------------------------------------------------
// 推送通知配置（用户自部署的 substracker / 通用 Webhook / Telegram）
// ---------------------------------------------------------------------------
function notifyConfig() {
  return {
    pushUrl: text('PUSH_URL'), // 形如 https://your-substracker.example.com/api/send/your-key
    pushHeaders: parseJsonEnv('PUSH_HEADERS', null, '自定义请求头'),
    pushTemplate: parseJsonEnv('PUSH_TEMPLATE', null, '自定义消息体模板'),
    pushTitle: text('PUSH_TITLE') || 'DNSHE 域名自动续期报告',
    // Telegram 直推（可选）：TG_BOT_TOKEN + TG_CHAT_ID，未配置则跳过通知
    tgBotToken: text('TG_BOT_TOKEN'),
    tgChatId: text('TG_CHAT_ID'),
  };
}

// ---------------------------------------------------------------------------
// 126 邮箱验证码配置（DNSHE 触发邮箱安全验证时自动读取）
// ---------------------------------------------------------------------------
function mailConfig() {
  return {
    user: text('MAIL_126_USER'),
    auth: text('MAIL_126_AUTH'), // 授权码，不是邮箱登录密码
    server: text('MAIL_IMAP_SERVER') || 'imap.126.com',
    port: number('MAIL_IMAP_PORT', 993),
    maxRetries: number('MAIL_VERIFY_MAX_RETRIES', 15),
    retryInterval: number('MAIL_VERIFY_RETRY_INTERVAL', 3000),
  };
}

// ---------------------------------------------------------------------------
// 汇总导出
// ---------------------------------------------------------------------------
function loadConfig() {
  const mode = text('DNSHE_MODE') || 'browser';
  if (mode !== 'browser' && mode !== 'api') {
    throw new Error(`DNSHE_MODE 取值非法: ${mode}（仅支持 browser / api）`);
  }
  return {
    mode,
    browser: browserConfig(),
    api: apiConfig(),
    notify: notifyConfig(),
    mail: mailConfig(),
  };
}

function getUsers() {
  return browserUsers();
}

module.exports = {
  loadConfig,
  getUsers,
  DEFAULT_THRESHOLD_DAYS,
  BENIGN_ERROR_CODES,
};