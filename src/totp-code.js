'use strict';

/**
 * TOTP 验证码生成模块（替代 126 邮箱 IMAP 读取）。
 *
 * DNSHE 后台开启 2FA/TOTP 后，提供一组 base32 密钥（Secret Key）。
 * 将该密钥配置到 Secrets（DNSHE_TOTP_SECRET），脚本即可本地生成
 * 与 Google Authenticator / Microsoft Authenticator 完全一致的 6 位动态码，
 * 无需网络、无次数限制、毫秒级生成。
 *
 * 环境变量:
 *   DNSHE_TOTP_SECRET  TOTP 密钥（base32 编码，如 JBSWY3DPEHPK3PXP）
 */

const speakeasy = require('speakeasy');
const logger = require('./logger');

/**
 * 生成当前时间的 TOTP 验证码。
 *
 * @param {string} secret  base32 编码的 TOTP 密钥
 * @returns {string|null}  6 位验证码，secret 为空时返回 null
 */
function generateTOTP(secret) {
  if (!secret || typeof secret !== 'string') {
    logger.warn('[totp] 未配置 DNSHE_TOTP_SECRET，无法生成 TOTP 验证码');
    return null;
  }

  try {
    const token = speakeasy.totp({
      secret,
      encoding: 'base32',
      digits: 6,
      step: 30,
      algorithm: 'sha1',
    });
    logger.ok(`[totp] 生成验证码: ${token}`);
    return token;
  } catch (e) {
    logger.error(`[totp] 生成失败: ${e.message}`);
    return null;
  }
}

module.exports = { generateTOTP };
