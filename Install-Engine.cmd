@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0.runtime\node\node.exe" set "PATH=%~dp0.runtime\node;%PATH%"
where npm >nul 2>nul
if errorlevel 1 (
  echo 没有找到 npm，请先运行 Setup-Windows.cmd。
  pause
  exit /b 1
)
echo 将从 npm 安装官方 Codex 0.162.1 到本项目 .runtime\codex。
echo 不覆盖你的全局 Codex、不修改原来的 .codex 配置。
call npm install --prefix "%~dp0.runtime\codex" --no-audit --no-fund @openai/codex@0.162.1
if errorlevel 1 (
  echo 内核安装失败，请检查网络和 npm 配置。
  pause
  exit /b 1
)
node scripts\check-engine.mjs
pause
