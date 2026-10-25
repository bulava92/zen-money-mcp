#!/usr/bin/env bash
set -euo pipefail
config_dir="$HOME/.config/zen_money_mcp"
token_file="$config_dir/access-token"
install -d -m 700 "$config_dir"
printf "Введи токен Дзен-мани (ввод скрыт): "
IFS= read -r -s token
printf "\n"
if [[ -z "$token" ]]; then
  printf "Токен пустой; файл не изменён.\n" >&2
  exit 1
fi
tmp_file="$token_file.tmp.$$"
umask 077
printf "%s" "$token" > "$tmp_file"
chmod 600 "$tmp_file"
mv -f "$tmp_file" "$token_file"
unset token
printf "Токен сохранён с закрытыми правами: %s\n" "$token_file"

