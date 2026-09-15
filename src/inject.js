'use strict';

/**
 * 注入页面（iframe/Turnstile 内部）的 hook 脚本。
 *
 * 核心思路（继承自 katabump 项目，已在 VPS 上验证可用）：
 * Cloudflare Turnstile 的 checkbox 渲染在 shadow DOM / iframe 内部，
 * Playwright 常规 locator 无法触达。这里 hook 掉 Element.prototype
 * .attachShadow，在 shadowRoot 里查找 <input type="checkbox">，把它的
 * 中心点相对 iframe 视口的比例坐标存入 window.__turnstile_data，
 * 供外层通过 CDP 原生鼠标事件点击。
 *
 * 同时随机化 MouseEvent.screenX/screenY，降低自动化特征。
 */
const TURNSTILE_INJECT_SCRIPT = `
(function () {
    // 只在 iframe 中运行（Turnstile 位于 iframe 内）
    if (window.self === window.top) return;

    // 1. 模拟真实鼠标屏幕坐标（减轻指纹差异）
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        var screenX = getRandomInt(800, 1200);
        var screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { /* 忽略：不阻塞主流程 */ }

    // 2. hook attachShadow，捕获 Turnstile checkbox
    try {
        var originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (init) {
            var shadowRoot = originalAttachShadow.call(this, init);
            if (!shadowRoot) return shadowRoot;

            var reportIfFound = function () {
                var checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                if (checkbox) {
                    var rect = checkbox.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0 &&
                        window.innerWidth > 0 && window.innerHeight > 0) {
                        window.__turnstile_data = {
                            xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                            yRatio: (rect.top + rect.height / 2) / window.innerHeight
                        };
                        return true;
                    }
                }
                return false;
            };

            if (!reportIfFound()) {
                var observer = new MutationObserver(function () {
                    if (reportIfFound()) observer.disconnect();
                });
                observer.observe(shadowRoot, { childList: true, subtree: true });
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[inject] attachShadow hook error:', e);
    }
})();
`;

module.exports = { TURNSTILE_INJECT_SCRIPT };