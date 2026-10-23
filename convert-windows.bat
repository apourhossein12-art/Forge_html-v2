@echo off
chcp 65001 >nul
if not exist node_modules (echo Installing... & call npm install --no-audit --no-fund --legacy-peer-deps)
if "%~1"=="" (echo Drag a .zip or folder onto this file. & pause & exit /b)
node "%~dp0anyhtml.mjs" "%~1" "%~dpn1.html"
pause
