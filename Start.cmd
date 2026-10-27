@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0.runtime\node\node.exe" set "PATH=%~dp0.runtime\node;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto missing
node -e "if(Number(process.versions.node.split('.')[0])<22)process.exit(1)"
if errorlevel 1 goto missing
node server\index.mjs --open
if errorlevel 1 (
  echo.
  echo 启动失败。请查看上方错误，或先运行 Setup-Windows.cmd。
  pause
)
exit /b
:missing
echo 需要 Node.js 22 或更高版本。
echo 请先双击 Setup-Windows.cmd，它会在本文件夹内安装运行环境。
echo 不需要管理员权限，也不会修改系统 Node.js。
pause
exit /b 1
