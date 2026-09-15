'use strict';

/**
 * 126 邮箱验证码读取模块（IMAP）。
 *
 * 技术要点（网易系邮箱特殊要求）：
 *  1. IMAP 服务器: imap.126.com:993 SSL
 *  2. 登录使用授权码（不是邮箱密码）
 *  3. 登录后必须发送 ID 命令（RFC 2971），否则报 Unsafe Login
 *  4. 搜索当天未读邮件，正则提取 6 位验证码
 *
 * 环境变量:
 *   MAIL_126_USER   126 邮箱地址（如 marklow01@126.com）
 *   MAIL_126_AUTH   126 邮箱授权码（不是登录密码）
 */

const Imap = require('node-imap');
const { simpleParser } = require('mailparser');

const logger = require('./logger');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 从 126 邮箱读取 DNSHE 验证码。
 *
 * @param {string} user      126 邮箱地址
 * @param {string} authCode  126 邮箱授权码
 * @param {object} opts      可选: { maxRetries, retryInterval, imapServer, imapPort }
 * @returns {Promise<string|null>} 6 位验证码，或 null（未找到）
 */
async function getVerificationCode(user, authCode, opts = {}) {
  const maxRetries = opts.maxRetries || 15;
  const retryInterval = opts.retryInterval || 3000; // 3s
  const imapServer = opts.imapServer || 'imap.126.com';
  const imapPort = opts.imapPort || 993;

  logger.info(`[verify] 开始从 ${user} 读取验证码（最多重试 ${maxRetries} 次，间隔 ${retryInterval}ms）...`);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const code = await _fetchCode({ user, authCode, imapServer, imapPort });
      if (code) {
        logger.ok(`[verify] 成功获取验证码: ${code}`);
        return code;
      }
      if (attempt < maxRetries - 1) {
        logger.info(`[verify] 第 ${attempt + 1}/${maxRetries} 次未找到验证码，${retryInterval}ms 后重试...`);
        await sleep(retryInterval);
      }
    } catch (e) {
      logger.warn(`[verify] 第 ${attempt + 1}/${maxRetries} 次读取失败: ${e.message}`);
      if (attempt < maxRetries - 1) {
        await sleep(retryInterval);
      } else {
        throw e;
      }
    }
  }

  logger.error('[verify] 超过最大重试次数，未获取到验证码');
  return null;
}

/** 单次 IMAP 连接读取验证码 */
function _fetchCode({ user, authCode, imapServer, imapPort }) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user,
      password: authCode,
      host: imapServer,
      port: imapPort,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000,
    });

    let resolved = false;

    function finish(err, result) {
      if (resolved) return;
      resolved = true;
      try { imap.end(); } catch (e) { /* ignore */ }
      if (err) {
        // 包装空 message 的错误，确保日志可读
        if (!err || !err.message) {
          err = new Error(String(err) || 'IMAP 未知错误（空 message）');
        }
        reject(err);
      } else {
        resolve(result);
      }
    }

    imap.once('ready', () => {
      logger.info('[verify] IMAP 连接就绪');
      try {
        // 网易系邮箱必须发送 ID 命令（RFC 2971）
        const idInfo = {
          name: user.split('@')[0] || 'dnshe-renew',
          contact: user,
          version: '1.0.0',
          vendor: 'node-imap',
        };
        imap.id(idInfo, (idErr) => {
          if (idErr) {
            logger.warn(`[verify] ID 命令失败: ${idErr.message}`);
            // ID 失败不一定致命，继续尝试
          } else {
            logger.info('[verify] ID 命令发送成功');
          }

          imap.openBox('INBOX', false, (boxErr, box) => {
            if (boxErr) {
              logger.error(`[verify] 打开 INBOX 失败: ${boxErr.message}`);
              return finish(boxErr);
            }
            logger.info(`[verify] 打开 INBOX 成功，共 ${box.messages.total} 封邮件`);

            // 搜索当天邮件（不限制 UNSEEN，防止邮件被其他客户端读过）
            const today = new Date();
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const dateStr = `${today.getDate()}-${monthNames[today.getMonth()]}-${today.getFullYear()}`;

            logger.info(`[verify] 搜索当天邮件: ON ${dateStr}`);
            imap.search([['ON', dateStr]], (searchErr, results) => {
              if (searchErr) {
                logger.error(`[verify] 搜索邮件失败: ${searchErr.message}`);
                return finish(searchErr);
              }
              if (!results || results.length === 0) {
                logger.info('[verify] 未找到当天邮件');
                return finish(null, null);
              }

              logger.info(`[verify] 找到 ${results.length} 封当天邮件`);

              // 从最新邮件开始遍历（results 通常按 seqno 升序，倒序处理）
              let foundCode = null;
              let processed = 0;
              const ordered = (results || []).slice().reverse();

              const f = imap.fetch(ordered, { bodies: '' });

              f.on('message', (msg, seqno) => {
                let bodyBuffer = Buffer.alloc(0);

                msg.on('body', (stream) => {
                  stream.on('data', (chunk) => {
                    bodyBuffer = Buffer.concat([bodyBuffer, chunk]);
                  });
                });

                msg.once('end', async () => {
                  try {
                    const parsed = await simpleParser(bodyBuffer);
                    const bodyText = (parsed.text || parsed.html || '').replace(/<[^>]+>/g, ' ');
                    const subject = parsed.subject || '';
                    const toAddr = parsed.to && parsed.to.text ? parsed.to.text : '';

                    logger.info(`[verify] 处理邮件 #${seqno}: subject="${subject}" to="${toAddr}"`);

                    // 优先匹配验证码类主题（DNSHE / 验证码 / verification / code）
                    const verifySubject = /(dnshe|验证码|verification|verify.?code|安全|登录)/i.test(subject);
                    if (!foundCode && verifySubject) {
                      let code = null;

                      // 策略1: 从原始 HTML 中精确提取（匹配 DNSHE 邮件格式：
                      // <strong>949526</strong> 紧跟在"验证码是"后面）
                      const rawHtml = parsed.html || '';
                      const htmlMatch = rawHtml.match(/验证码是[：:]\s*<[^>]*>\s*(\d{6})\s*<\/[^>]*>/i);
                      if (htmlMatch) {
                        code = htmlMatch[1];
                        logger.info(`[verify] 从 HTML 精确提取验证码: ${code}`);
                      }

                      // 策略2: 从纯文本提取（"验证码是: 949526" 或 "验证码：949526"）
                      if (!code) {
                        const textMatch = bodyText.match(/验证码[是:：]\D*(\d{6})/i);
                        if (textMatch) {
                          code = textMatch[1];
                          logger.info(`[verify] 从文本提取验证码: ${code}`);
                        }
                      }

                      // 策略3: 兜底——避免 6 位数字的域名被误识别
                      if (!code) {
                        const cleanBody = bodyText.replace(user, '');
                        const fallbackMatch = cleanBody.match(/\b\d{6}\b/);
                        if (fallbackMatch) {
                          code = fallbackMatch[0];
                          logger.info(`[verify] 从文本兜底提取验证码: ${code}`);
                        }
                      }

                      if (code) {
                        foundCode = code;
                        // 标记已读（不删除邮件），防止下次重复读取
                        try {
                          imap.addFlags(seqno, '\\Seen', () => {});
                        } catch (e) { /* ignore */ }
                      }
                    } else if (!foundCode) {
                      logger.info(`[verify] 邮件 #${seqno} 主题不匹配，跳过`);
                    }
                    processed++;
                    if (processed >= ordered.length || foundCode) {
                      finish(null, foundCode);
                    }
                  } catch (parseErr) {
                    logger.warn(`[verify] 解析邮件 #${seqno} 失败: ${parseErr.message}`);
                    processed++;
                    if (processed >= ordered.length) {
                      finish(null, foundCode);
                    }
                  }
                });
              });

              f.once('error', (fetchErr) => {
                logger.error(`[verify] 获取邮件内容失败: ${fetchErr.message || fetchErr}`);
                finish(fetchErr);
              });

              f.once('end', () => {
                // 如果所有邮件都处理完但没找到验证码
                if (processed >= results.length && !foundCode) {
                  logger.info('[verify] 所有邮件处理完毕，未找到验证码');
                  finish(null, null);
                }
              });
            });
          });
        });
      } catch (e) {
        logger.error(`[verify] IMAP ready 回调异常: ${e.message || e}`);
        finish(e);
      }
    });

    imap.once('error', (err) => {
      logger.error(`[verify] IMAP 连接错误: ${err && err.message ? err.message : String(err)}`);
      finish(err);
    });

    imap.once('end', () => {
      if (!resolved) {
        logger.warn('[verify] IMAP 连接意外关闭');
        finish(new Error('IMAP 连接意外关闭'));
      }
    });

    logger.info(`[verify] 正在连接 ${imapServer}:${imapPort}...`);
    imap.connect();
  });
}

module.exports = {
  getVerificationCode,
};