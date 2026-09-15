# DNSHE Auto Renew (Node.js)

DNSHE 免费域名自动续期 —— **Node.js** 实现，运行于 **GitHub Actions + cron**。

本项目的思路借鉴自 [DNSHE-Auto-Renew (Python)](https://github.com/PopcornEdward/DNSHE-Auto-Renew) 与
katabump（VPS 续期项目，已验证的 Playwright + CDP 绕过 Cloudflare 盾方案），并用
**Playwright + 原生 Chrome 的 CDP 控制**替代 Python 方案的 Selenium 式二段法。

---

## 特性

- ✂️ **不需要 PushPlus**：通知默认走 **Telegram 直推**（BotFather token + Chat ID，
  可与你的 substracker 共用同一个 bot），另支持任意 POST JSON 的 webhook 网关。
- 🌐 **双引擎**：
  - `browser`（默认）：Playwright + 原生 Chrome CDP，注入 stealth + Turnstile hook，
    用 CDP 原生鼠标事件点击验证码复选框 + "Success!" 检测 + 失败自动刷新重试，
    基本可稳定跳过 Cloudflare 盾。依靠**无头外渲染**（GitHub Actions 里用 xvfb 模拟有头）提高通过率。
  - `api`（备选）：直接调 DNSHE 官方 REST API 续期，无需浏览器，速度快、稳、抗盾，
    缺点是依赖 API 额度（免费领取的 API 密钥每天有调用配额）。
- 🔁 多用户（`USERS_JSON` 数组）与单用户两种账号来源，逐个登录、逐个续期。
- 🧠 与 Python 版保持一致的续期判定规则：剩余天数 ≥ 180 跳过、`never_expires` 跳过、
  `renewal_not_yet_available` 视为良性跳过、续期成功报告新到期时间。
- 📸 **每次续期必定截图**：无论续期成功 / 失败 / 跳过，都会输出两张图 ——
  **缩略图**（随 Telegram 报告以图片消息推送）＋ **整页全图**（上传至 Actions Artifacts 存档核对）；
  登录失败、超时等异常同样截图留痕。
- 🕐 cron 默认每月 1 日 00:00 UTC（北京 8:00）执行，同时保留手动触发按钮。

---

## 快速开始（GitHub Actions 部署）

1. **Fork 本仓库**
2. 到 **Settings → Secrets and variables → Actions → New repository secret** 添加：

| Secret | 必填 | 说明 |
|---|---|---|
| `DNSHE_MODE` | 可选 | `browser`（默认）或 `api` |
| `DNSHE_USERNAME` | 见下 | 浏览器引擎：账号邮箱（单账号模式） |
| `DNSHE_PASSWORD` | 见下 | 浏览器引擎：密码 |
| `USERS_JSON` | 见下 | 多账号模式，如 `[{"email":"a@x.com","password":"p1"},{"email":"b@x.com","password":"p2"}]` |
| `DNSHE_API_KEY` | api 模式必填 | DNSHE 后台 → API 管理 → 创建密钥 |
| `DNSHE_API_SECRET` | api 模式必填 | 同上 |
| `PUSH_URL` | 可选 | Webhook 网关 URL（配合下条；详见"通知方式"） |
| `PUSH_TITLE` | 可选 | Webhook 推送标题模板，默认 `DNSHE 域名续期报告`，可用 `{{date}}` 变量 |
| `PUSH_HEADERS` | 可选 | Webhook 附加 Header（JSON 字符串，如自定义鉴权头），默认 `{"Content-Type":"application/json"}` |
| `PUSH_TEMPLATE` | 可选 | 自定义 Webhook body 模板（JSON 字符串，支持 `{{title}}`/`{{content}}` 变量） |
| `TG_BOT_TOKEN` | 可选 | **推荐**：Telegram 直推。`@BotFather` 创建/管理的机器人 token（可与 substracker 共用同一个 bot） |
| `TG_CHAT_ID` | 可选 | **推荐**：你的 TG 数字 user id（= substracker 里配置 Telegram 时生成的绑定码值；未配置时可用 `@userinfobot` 查询） |
| `DNSHE_RENEW_THRESHOLD_DAYS` | 可选 | 续期阈值天数，默认 `180` |

   > 单账号与多账号互斥：同时配置时 **`USERS_JSON` 优先**。
   > API 密钥获取：登录 DNSHE → 免费域名管理 → API 管理 → 创建 API 密钥
   > （免费密钥每日配额有限，`api` 模式一天只跑一次足够；若提示超配额请换回 `browser` 模式）。

3. **Actions → 选中 `DNSHE Domain Auto Renew` → Run workflow** 手动跑一次。
4. 下载 **Artifacts → dnshe-renew-screenshots** 核对登录与续期截图。

> 域名续期窗口在到期前 180 天打开，每月跑一次不会错过。
> 后续按需修改 `.github/workflows/renew.yml` 的 cron 即可，例如每 15 天一次：`'0 0 */15 * *'`。

---

## 通知方式（替代 PushPlus，推荐 Telegram 直推）

**本项目不需要 PushPlus。** 通知模块 `src/notify.js` 支持两条互相独立的通道，配置其一即可，两条都配则都发：

### 方式一（推荐）：Telegram 直推

完全复用你 substracker 已配好的推送链路，同一个 BotFather 机器人即可：

1. **Bot Token**：在 Telegram 里找 `@BotFather` → `/newbot` 创建机器人（或使用已有的），
   BotFather 会返回形如 `123456:ABC-xxxx` 的 token → 填入 Secret `TG_BOT_TOKEN`。
   （与 substracker 里配置的 Bot Token 相同即可，两者共用互不干扰。）
2. **Chat ID**：就是你 substracker 里"Telegram 通知"渠道配置时生成的绑定码值
   （即你的 TG 数字 user id）。未配置过的话，给 `@userinfobot` 发任意一条消息，
   回复中 `Your id` 后面的数字串即为 Chat ID → 填入 Secret `TG_CHAT_ID`。

配好后每次续期运行结束，报告会直接推送到你的 TG 机器人会话里：
**文本报告优先，随后逐张发送续期截图缩略图**（每次运行最多 6 张，按发生顺序）。
`TG_BOT_TOKEN` / `TG_CHAT_ID` 未配置时脚本自动跳过通知发送，不影响续期，截图仍会存入 Actions Artifacts。

### 方式二（可选）：通用 Webhook

把报告 POST 到任意接受 JSON 的地址：

```
POST {PUSH_URL}
{ "title": "...", "content": "..." }   ← body 可用 PUSH_TEMPLATE 自定义
```

例如 substracker 的**自定义 Webhook 渠道**、企业微信机器人 URL 等都能直接接。
substracker 作者默认网关形态：`PUSH_URL=https://push.wangwangit.com/api/send/你的key`。

> 若两个通道都没配置，报告仅写入日志与 GitHub Actions 输出 —— 续期功能不受影响。

---

## 本地调试（Windows）

```bash
npm install
x npx playwright install chromium        # 安装浏览器运行时
# 1) 双击 start_chrome.bat（带 --remote-debugging-port=9222 启动 Chrome）
# 2) 另开终端：
cp .env.example .env                      # 填入 DNSHE_USERNAME/PASSWORD
npm start                                 # 默认浏览器引擎，连 9222 端口运行
```

> macOS/Linux 本地调试：手动用 `--remote-debugging-port=9222` 起 Chrome 后 `npm start` 即可；
> 或参考 `start_chrome.bat` 的等价命令行。

---

## 目录结构

```
.
├── renew.js                     # 入口：按 DNSHE_MODE 选引擎
├── package.json                 # 依赖（playwright / playwright-extra / stealth）
├── .env.example                 # 环境变量示例
├── start_chrome.bat             # Windows 本地调试启动 CDP Chrome
├── .github/workflows/renew.yml  # GitHub Actions：cron + 手动触发
└── src/
    ├── config.js                # 配置加载、URL 常量、DOM 选择器集中管理
    ├── logger.js                # 带时间戳分级日志
    ├── notify.js                # 通用 webhook 推送 + 可选 Telegram
    ├── inject.js                # stealth + attachShadow hook（原样移植 katabump）
    ├── turnstile.js             # Turnstile 点击：CDP 原生鼠标 + DOM 备用策略
    ├── browser-engine.js        # 浏览器引擎：登录、续期循环、截图、汇总
    └── api-engine.js            # 官方 API 引擎（对应 Python list/quota/renew 逻辑）
```

---

## 常见问题

- **登录后提示验证码/被识别**：GitHub Actions 环境跑一次截图确认；若 Cloudflare 升级
  防线，先尝试：① 换 `api` 模式兜底；② 调高 `turnstile` 重试轮数（`src/browser-engine.js`
  的 `maxTurnstileRetries`）；③ 等待 DNSHE 网页改版后调整选择器。
- **续期按钮没有点到（截图里仍显示 Free Renewal）**：DNSHE 网页版偶尔改版。
  所有选择器集中在 `src/config.js` 的 `SELECTORS`，按截图微调即可，无需改业务逻辑。
- **`renewal_not_yet_available`**：该域名尚未进入续期窗口（剩余 > 180 天），
  良性结果，不计失败。
- **api 模式报 429 / 配额**：免费 API 密钥限每分钟 30 次、每日有限次数，`api` 引擎已内置
  限流与重试；仍超配额说明当天跑多了，下个周期自动恢复，或改用 `browser` 模式。
- **推送没收到**：检查 `PUSH_URL` 是否可访问、是否要求额外鉴权头（用 `PUSH_HEADERS` 配置）、
  body 格式是否匹配（用 `PUSH_TEMPLATE` 改写）。推送失败不影响续期主流程，问题会体现在日志。

---

## LICENSE

本仓库为原 Python 项目功能层面的重实现（Node.js），仅供个人学习与自动化使用，请遵守
DNSHE 平台的使用条款。涉及 Cloudflare 绕过仅用于本人账号的正常续期操作。