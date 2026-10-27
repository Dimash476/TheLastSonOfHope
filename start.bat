@echo off
REM Starts a local web server and opens the game in the browser.
REM Browsers do not allow loading JS modules straight from disk, so a server is needed.
cd /d "%~dp0"
echo The Last son of Hope: http://localhost:8000
echo Close this window to stop the server.
start "" http://localhost:8000
python server.py 8000
