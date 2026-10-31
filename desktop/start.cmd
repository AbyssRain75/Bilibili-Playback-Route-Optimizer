@echo off
rem SPDX-License-Identifier: AGPL-3.0-or-later
rem Double-click to start the desktop app: it starts the Bilibili client and connects to it; closing this window quits the client too.
rem The same file is used in two places: at the root of the release package (uses node\node.exe from the package)
rem and in dev\desktop\ (uses the installed Node, 22 or later).
rem Keep this file ASCII only: cmd parses batch files in the console code page (GBK on Chinese Windows), and UTF-8
rem Chinese text here can swallow a line break and run the rest of the next line as a command. See dev/README.md.
setlocal
cd /d "%~dp0"
if not exist "desktop\main.mjs" cd /d "%~dp0.."
set "NODE=node"
if exist "node\node.exe" set "NODE=node\node.exe"
"%NODE%" desktop\main.mjs %*
if errorlevel 1 pause
