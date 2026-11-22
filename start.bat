@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Discord Quest Runner
node src/index.js run
if errorlevel 1 pause
