@echo off
setlocal
set "AILY_DATA_DIR=%LOCALAPPDATA%\AilyOpenAI"
"%~dp0runtime\node.exe" "%~dp0app\cli.mjs" stop %*
if errorlevel 1 pause
