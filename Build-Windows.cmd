@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0.runtime\node\node.exe" set "PATH=%~dp0.runtime\node;%PATH%"
where npm >nul 2>nul
if errorlevel 1 (
  echo 请先运行 Setup-Windows.cmd。
  pause
  exit /b 1
)
echo 开始安装 Electron 构建依赖，需要联网下载 Electron 和打包工具。
call npm install --no-audit --no-fund
if errorlevel 1 goto failed
call npm run install:engine
if errorlevel 1 goto failed
call npm run check
if errorlevel 1 goto failed
call npm test
if errorlevel 1 goto failed
call npm run build:win
if errorlevel 1 goto failed
echo.
echo 构建成功。安装程序位于 release 文件夹。本地构建默认未签名。
start "" "%~dp0release"
pause
exit /b 0
:failed
echo.
echo 构建失败，没有把本次结果标记为可用。请检查上方日志。
pause
exit /b 1
