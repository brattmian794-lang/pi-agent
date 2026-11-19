#!/bin/sh
# 通过自身路径定位入口；不依赖调用者的当前目录。
set -eu
if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' '未找到 Bun。请从 https://bun.sh 安装后重新打开终端，参见 docs/development.md。' >&2
  exit 127
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bun "$script_dir/start-dev.ts" "$@"
