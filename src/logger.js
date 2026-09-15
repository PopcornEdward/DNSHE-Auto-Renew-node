'use strict';

/** 轻量日志：统一时间戳 + 级别，方便阅读与排查。 */
function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level, args) {
  const prefix = `[${stamp()}] [${level}]`;
  console.log(prefix, ...args);
}

const logger = {
  info(...args) { log('INFO ', args); },
  warn(...args) { log('WARN ', args); },
  error(...args) { log('ERROR', args); },
  ok(...args) { log('OK   ', args); },
};

module.exports = logger;