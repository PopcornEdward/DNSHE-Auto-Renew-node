'use strict';

/**
 * Cloudflare Turnstile 绕过核心：通过 CDP 发送"原生"鼠标事件，
 * 点击被 hook 脚本定位到的 checkbox（shadow DOM 内）。
 *
 * 策略来自 katabump 项目（已在 VPS 上部署验证成功）：
 *  1. addInitScript 注入的 hook 会把 checkbox 中心点相对 iframe 视口的
 *     比例坐标写入 window.__turnstile_data；
 *  2. 本模块遍历所有 frame，读取坐标，结合 iframe 在主页面中的 boundingBox
 *     换算为页面绝对坐标；
 *  3. 用 CDP Input.dispatchMouseEvent 发送 mousePressed/mouseReleased，
 *     模拟真实点击，绕过 Playwright "automation" 特征。
 */

const logger = require('./logger');

/** 遍历所有 frame，找到被注入脚本标记的 Turnstile 坐标并 CDP 点击。 */
async function attemptTurnstileCdp(page, maxFrames = 20) {
  const frames = page.frames().slice(0, maxFrames);
  for (const frame of frames) {
    try {
      // hook 脚本只注入 iframe（window.self !== window.top）
      let data = null;
      try {
        data = await frame.evaluate(() => window.__turnstile_data || null);
      } catch (e) {
        continue; // 跨域 frame 读取失败，跳过
      }
      if (!data) continue;

      const iframeElement = await frame.frameElement().catch(() => null);
      if (!iframeElement) continue;
      const box = await iframeElement.boundingBox().catch(() => null);
      if (!box) continue;

      const clickX = box.x + box.width * data.xRatio;
      const clickY = box.y + box.height * data.yRatio;
      logger.info(`[turnstile] 命中 checkbox，CDP 点击 (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);

      await clickViaCdp(page, clickX, clickY);
      return true;
    } catch (e) {
      // 单个 frame 出错不致命
    }
  }
  return false;
}

/** 备用策略：Turnstile checkbox 若渲染在普通 DOM（非 shadow root）中，按元素坐标直接点。 */
async function attemptTurnstileDom(page, maxFrames = 20) {
  const frames = page.frames().slice(0, maxFrames);
  for (const frame of frames) {
    try {
      if (!String(frame.url()).includes('cloudflare')) continue;
      const point = await frame
        .evaluate(() => {
          const cb = document.querySelector(
            'input[type="checkbox"], .cf-turnstile input, [name="cf-turnstile-response"] ~ * input'
          );
          if (!cb) return null;
          const rect = cb.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        })
        .catch(() => null);
      if (!point) continue;

      const iframeElement = await frame.frameElement().catch(() => null);
      if (!iframeElement) continue;
      const box = await iframeElement.boundingBox().catch(() => null);
      if (!box) continue;

      logger.info(`[turnstile] DOM 备用策略命中，CDP 点击 (${box.x + point.x}, ${box.y + point.y})`);
      await clickViaCdp(page, box.x + point.x, box.y + point.y);
      return true;
    } catch (e) {
      continue;
    }
  }
  return false;
}

/** 组合入口：优先 shadow-DOM hook 策略，失败再走 DOM 备用策略。 */
async function attemptTurnstile(page) {
  if (await attemptTurnstileCdp(page)) return true;
  return attemptTurnstileDom(page);
}

/** 通过 CDP 发送原生鼠标点击（按下 -> 人类延迟 -> 抬起）。 */
async function clickViaCdp(page, x, y) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    // 模拟人类点击的按下-抬起间隔（50-150ms）
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  } finally {
    await client.detach().catch(() => {});
  }
}

/** 在任一 cloudflare iframe 里检测是否出现 "Success!" 标志（Turnstile 验证通过）。 */
async function isTurnstileSuccess(page, timeoutMs = 500) {
  const frames = page.frames();
  for (const f of frames) {
    if (!String(f.url()).includes('cloudflare')) continue;
    try {
      const ok = await f
        .getByText('Success!', { exact: false })
        .first()
        .isVisible({ timeout: timeoutMs });
      if (ok) return true;
    } catch (e) {
      // 继续下一个 frame
    }
  }
  return false;
}

module.exports = { attemptTurnstile, attemptTurnstileCdp, clickViaCdp, isTurnstileSuccess };