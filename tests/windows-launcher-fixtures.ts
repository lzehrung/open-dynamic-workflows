/**
 * The text of Cursor's Windows `agent.cmd`. It starts a PowerShell script, so
 * odw cannot run it: it is not an npm shim. Tests write it into a temp PATH
 * directory.
 */
export const CURSOR_AGENT_CMD = [
  "@echo off",
  "setlocal enabledelayedexpansion",
  'set "CURSOR_INVOKED_AS=%~nx0"',
  'set "SCRIPT_DIR=%~dp0"',
  'if "%SCRIPT_DIR:~-1%"=="\\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"',
  "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile " +
    '-ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*',
  "",
].join("\r\n");
