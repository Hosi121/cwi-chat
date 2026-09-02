#!/usr/bin/env bash
# index.html / style.css / scenarios.js / cwi-chat.js を 1 ファイルに束ねる
#   ./build.sh            -> dist/cwi-chat.html（単体で開ける完全な HTML）
#   ./build.sh --artifact -> dist/cwi-chat.artifact.html（<html>/<head>/<body> なし。Artifact 公開用）
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
FONT='<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=M+PLUS+2:wght@100..900&display=swap" rel="stylesheet">'
head_part() { echo '<title>CwI Chat</title>'; echo "$FONT"; echo '<style>'; cat style.css; echo '</style>'; }
body_part() {
  sed -n '/<!-- BODY:START -->/,/<!-- BODY:END -->/p' index.html
  echo '<script>'; cat scenarios.js; echo; cat prompt.js; echo; cat cwi-chat.js; echo '</script>'
}
if [[ "${1:-}" == "--artifact" ]]; then
  { head_part; body_part; } > dist/cwi-chat.artifact.html
  echo "wrote dist/cwi-chat.artifact.html"
else
  { echo '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    head_part; echo '</head><body>'; body_part; echo '</body></html>'; } > dist/cwi-chat.html
  echo "wrote dist/cwi-chat.html"
fi
