@echo off
chcp 65001 >nul
if not exist node_modules (echo Installing... & call npm install --no-audit --no-fund --legacy-peer-deps)
set /p GITHUB_TOKEN=GitHub token (empty = public only): 
set /p U=GitHub username (empty = token owner): 
if "%U%"=="" (node "%~dp0all-repos.mjs") else (node "%~dp0all-repos.mjs" --user %U%)
pause
