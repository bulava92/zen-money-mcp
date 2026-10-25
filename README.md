ZenMoney MCP

Самостоятельный MCP-сервер для API Дзен-мани. Код, зависимости и конфигурация находятся отдельно от других приложений.

Инструменты: синхронизация /v8/diff/; профиль; счета; категории; контрагенты; валюты и банки; операции; напоминания и запланированные операции; сводка доходов и расходов по валютам и категориям; месячные бюджеты; подсказки /v8/suggest/; создание, изменение и удаление операций; создание, изменение, скрытие и удаление неиспользуемых категорий; создание, изменение и архивация счетов; создание и изменение контрагентов.

Токен вводится на сервере скрытым вводом:
    /var/www/zen-money-mcp/bin/set-token.sh
Файл сохраняется отдельно от проекта в ~/.config/zen_money_mcp/access-token с правами только владельца. Не передавай токен в сообщения, аргументы команд или журналы.

Для локального запуска:
    cd /var/www/zen-money-mcp
    npm start
Сервер использует stdio. Обычный вывод зарезервирован под MCP-протокол, диагностика идёт в stderr.

Данные Дзен-мани остаются в памяти процесса; транзакционная история не записывается в файлы. Для ChatGPT подготовлены отдельные шаблоны профиля и systemd-службы в deploy/. Новый tunnel ID и runtime API key нужно будет внести в профиль; runtime key вводится скрытым вводом через bin/set-openai-key.sh.

## Full API coverage

The high-level tools cover common finance tasks. For complete access to API fields and batch changes, use get_zenmoney_entities to read full raw records and apply_zenmoney_diff to create or patch records across all writable entities, including reminder markers. apply_zenmoney_diff merges partial updates with the current record, updates the sync timestamp, binds writes to the current profile, and requires confirmDeletes: true for deletions. Budgets are removed by unlocking and setting the relevant amount to zero. sync_zenmoney accepts forceFetch to reload selected entities. user, instrument, and company remain read-only system entities.
