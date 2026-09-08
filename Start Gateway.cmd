@echo off
setlocal
set "AILY_DATA_DIR=%LOCALAPPDATA%\AilyOpenAI"
"%~dp0runtime\node.exe" "%~dp0app\cli.mjs" start %*
if errorlevel 1 pause
