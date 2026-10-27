@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-windows.ps1"
if errorlevel 1 (
  echo.
  echo 安装没有完成。请保留上方错误信息，检查网络后重试。
  pause
  exit /b 1
)
echo.
echo 安装完成。现在可以双击 Start.cmd 打开图形工作台。
pause
