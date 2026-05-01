#!/usr/bin/env bash
# 验证新加的 3 个工具
set -e
BIN="$(dirname "$0")/../target/debug/kb-mcp.exe"
DB="C:/Users/yecha/AppData/Roaming/com.agilefr.kb/app.db"

{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0.1"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_folders","arguments":{}}}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_notes_by_folder","arguments":{"folder_id":null,"limit":5}}}'
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_notes_by_folder","arguments":{"folder_id":1,"includeDescendants":false,"limit":5}}}'
  sleep 1
} | "$BIN" --db-path "$DB" 2>/dev/null | grep -oE '"id":[0-9]+,"result":\{[^|]{0,200}' | head -10
