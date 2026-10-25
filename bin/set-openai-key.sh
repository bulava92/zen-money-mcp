#!/usr/bin/env bash
set -euo pipefail
config_dir="$HOME/.config/zen_money_mcp"
key_file="$config_dir/openai-runtime-key"
install -d -m 700 "$config_dir"
printf "Введи runtime key OpenAI (ввод скрыт): "
IFS= read -r -s key
printf "\n"
if [[ -z "$key" ]]; then
  printf "Ключ пустой; файл не изменён.\n" >&2
  exit 1
fi
tmp_file="$key_file.tmp.$$"
umask 077
printf "%s" "$key" > "$tmp_file"
chmod 600 "$tmp_file"
mv -f "$tmp_file" "$key_file"
unset key
printf "Ключ сохранён с закрытыми правами: %s\n" "$key_file"

