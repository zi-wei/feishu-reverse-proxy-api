@echo off
setlocal
set "AILY_DATA_DIR=%LOCALAPPDATA%\AilyOpenAI"
"%~dp0runtime\node.exe" "%~dp0app\cli.mjs" connect --agent agent_4kgf4uygwpt75n5
if errorlevel 1 pause
