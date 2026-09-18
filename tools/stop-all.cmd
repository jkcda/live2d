@echo off
rem ---------------------------------------------------------------------------
rem Wrapper so this can be run by double-click, from cmd.exe, or from any shell.
rem See start-all.cmd for why a .cmd wrapper is needed for .ps1 scripts.
rem
rem Usage:
rem   stop-all.cmd                 stop everything
rem   stop-all.cmd -Only agent     stop one service
rem   stop-all.cmd -KeepWeb        keep the frontend running
rem ---------------------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-all.ps1" %*
