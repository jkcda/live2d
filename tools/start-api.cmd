@echo off
rem ---------------------------------------------------------------------------
rem Start everything with the online (API) TTS config from tools\tts-api.env.
rem
rem Why a .cmd wrapper: a .ps1 cannot be run by double-click or from cmd.exe --
rem Windows hands .ps1 to its "Edit" verb, which opens Notepad.
rem See start-all.cmd for the same reason.
rem
rem First time: copy tools\tts-api.env.example to tools\tts-api.env and fill it in.
rem (tts-api.env is gitignored -- it holds the API key and must not be committed.)
rem ---------------------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-api.ps1" %*
