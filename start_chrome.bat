@echo off
rem ============================================================
rem DNSHE Auto Renew - 本地调试辅助脚本（Windows）
rem 
rem 用法：
rem   1. 先运行本脚本，启动带 CDP 调试端口的 Chrome
rem      （首次会询问是否允许访问 --user-data-dir，选"允许"）
rem   2. 另开一个终端执行：npm install && npm start
rem
rem 说明：
rem   - --remote-debugging-port=9222 开出 CDP 端口，renew.js 直接连它，
rem     等同于 GitHub Actions 中 xvfb-run 的效果（真实渲染 bypass CF）
rem   - --user-data-dir 独立用户目录，与日常浏览器隔离，登录态持久化
rem   - 若 Chrome 不在默认路径，请手动修改下方路径
rem ============================================================

set CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe

if not exist "%CHROME_PATH%" (
  echo [ERROR] 未找到 Chrome: %CHROME_PATH%
  echo 请修改本脚本顶部的 CHROME_PATH 为你的 Chrome 安装路径。
  pause
  exit /b 1
)

"%CHROME_PATH%" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="D:\DNSHE-Auto-Renew-node\ChromeData_DNSHE" ^
  --disable-blink-features=AutomationControlled ^
  --start-maximized