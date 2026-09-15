'use strict';

/**
 * 推送通知模块（可插拔，失败不影响续期主流程）。
 *
 * 两个通道：
 *  1. Telegram 直推（推荐）：TG_BOT_TOKEN + TG_CHAT_ID。
 *     文本报告 + 续期截图缩略图（sendPhoto 图片消息）。
 *  2. 通用 Webhook：POST <PUSH_URL> { "title": "...", "content": "..." }
 *     （PUSH_HEADERS / PUSH_TEMPLATE 可适配企业微信机器人、Bark 等）。
 *
 * 未配置任何通道时静默跳过，仅输出日志 —— 续期功能不受影响。
 */

const fs = require('fs');
const path = require('path');

const logger = require('./logger');

const DEFAULT_HEADERS = { 'Content-Type': 'application/json' };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 渲染消息体模板：{{title}} / {{content}} / {{timestamp}} */
function renderTemplate(template, title, content) {
  const vars = {
    title,
    content,
    timestamp: new Date().toISOString(),
  };
  return JSON.parse(
    JSON.stringify(template)
      .replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''))
  );
}

/** 带重试的 JSON POST：429 / 5xx / 网络错误最多重试 2 次 */
async function postJson(url, headers, body, what) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(2000 * attempt);
        continue;
      }
      if (res.status >= 400) {
        const respText = (await res.text()).slice(0, 200);
        logger.warn(`[notify] ${what} 返回 HTTP ${res.status}: ${respText}`);
        return true; // 服务端明确拒绝，重试无意义，视为“已送达失败”但不断言网络问题
      }
      logger.ok(`[notify] ${what} 推送成功`);
      return true;
    } catch (e) {
      lastErr = e;
      await sleep(2000 * attempt);
    }
  }
  logger.warn(`[notify] ${what} 推送失败（已重试）: ${lastErr && lastErr.message}`);
  return false;
}

/** Webhook / substracker 通道（纯文本，不支持图片） */
async function sendWebhook(cfg, title, content) {
  const headers = { ...DEFAULT_HEADERS, ...(cfg.pushHeaders || {}) };
  const body = cfg.pushTemplate
    ? renderTemplate(cfg.pushTemplate, title, content)
    : { title, content };
  return postJson(cfg.pushUrl, headers, body, 'Webhook(PUSH_URL)');
}

/** Telegram 通道：文本消息（报告正文） */
async function sendTelegram(cfg, title, content) {
  const url = `https://api.telegram.org/bot${cfg.tgBotToken}/sendMessage`;
  const data = { chat_id: cfg.tgChatId, text: `${title}\n\n${content}` };
  const headers = { 'Content-Type': 'application/json' };
  let ok = true;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(15000),
    });
    const result = await res.json().catch(() => null);
    if (!(result && result.ok)) {
      logger.warn(`[notify] Telegram 未成功: ${result && result.description}`);
      ok = false;
    } else {
      logger.ok('[notify] Telegram 文本推送成功');
    }
  } catch (e) {
    logger.warn(`[notify] Telegram 推送异常: ${e.message}`);
    ok = false;
  }
  return ok;
}

/** 从缩略图文件名提取可读标签，例如 renew_1_success */
function tagFromFilename(file) {
  const base = path.basename(file, path.extname(file));
  return base
    .replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-\d+)?_/, '')
    .replace(/_thumb$/, '')
    .replace(/_/g, ' ');
}

/**
 * Telegram 通道：逐张发送截图缩略图（sendPhoto，multipart 上传）。
 * 开头有 500ms 间隔防止触发 Telegram 同 chat 限流。
 */
async function sendTelegramPhotos(cfg, title, images) {
  let sent = 0;
  const url = `https://api.telegram.org/bot${cfg.tgBotToken}/sendPhoto`;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    try {
      if (!img || !fs.existsSync(img)) {
        logger.warn(`[notify] 截图文件不存在，跳过: ${img}`);
        continue;
      }
      const fd = new FormData();
      fd.append('chat_id', cfg.tgChatId);
      fd.append('photo', new Blob([fs.readFileSync(img)], { type: 'image/png' }), path.basename(img));
      const caption =
        i === 0
          ? `${title}（共 ${images.length} 张缩略图）`.slice(0, 1000)
          : `续期截图 ${i + 1}/${images.length}: ${tagFromFilename(img)}`.slice(0, 1000);
      fd.append('caption', caption);
      const res = await fetch(url, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
      const result = await res.json().catch(() => null);
      if (result && result.ok) {
        sent++;
        logger.ok(`[notify] Telegram 图片推送成功 (${i + 1}/${images.length})`);
      } else {
        logger.warn(
          `[notify] Telegram 图片推送未成功: ${(result && result.description) || `HTTP ${res.status}`}`
        );
      }
    } catch (e) {
      logger.warn(`[notify] Telegram 图片推送异常（${img}）: ${e.message}`);
    }
    if (i < images.length - 1) await sleep(500);
  }
  return sent;
}

/**
 * 推送续期报告（文本正文 + 可选缩略图）。
 * @returns {Promise<boolean>} 未配置通道时视为成功；推送失败不影响主流程退出码，
 *          但会在日志里告警。
 */
async function pushReport(cfg, { title, content, images = [] }) {
  const channels = [];
  if (cfg.pushUrl) channels.push('webhook');
  if (cfg.tgBotToken && cfg.tgChatId) channels.push('telegram');

  if (channels.length === 0) {
    logger.info('[notify] 未配置任何推送通道（PUSH_URL / Telegram），仅输出日志');
    return true;
  }

  const results = [];
  for (const ch of channels) {
    if (ch === 'webhook') {
      results.push(await sendWebhook(cfg, title, content));
    } else {
      // Telegram：先发完整文本报告，再逐张发截图缩略图
      const textOk = await sendTelegram(cfg, title, content);
      let photoOk = true;
      if (images.length > 0) {
        const sent = await sendTelegramPhotos(cfg, title, images);
        photoOk = sent > 0;
      }
      results.push(textOk && photoOk);
    }
  }
  return results.every(Boolean);
}

module.exports = { pushReport };