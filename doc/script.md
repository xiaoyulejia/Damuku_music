netstat -ano | findstr :8000
taskkill /IM node.exe /F
tasklist | findstr node.exe


taskkill /PID 43660 /F
taskkill /PID 27008 /F