@echo off
rem ---------------------------------------------------------------------------
rem Wrapper so this can be run by double-click, from cmd.exe, or from any shell.
rem
rem Why it exists: a .ps1 cannot be executed directly by cmd.exe or by
rem double-clicking in Explorer -- Windows hands .ps1 to its "Edit" verb,
rem which opens Notepad instead of running anything. This .cmd is executable
rem everywhere, so it just forwards to the real script.
rem
rem All real logic and documentation lives in start-all.ps1.
rem
rem Usage:
rem   start-all.cmd                start everything
rem   start-all.cmd -Electron      start with the desktop-pet window
rem   start-all.cmd -Skip web      skip a service
rem ---------------------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1" %*
