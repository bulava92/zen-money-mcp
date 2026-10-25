import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { ZenMoneyClient, ZenMoneyError } from "./zenmoney.mjs";

const api = new ZenMoneyClient();
const mcp = new McpServer({ name: "zen-money-mcp", version: "1.0.0" });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().min(1);
const amount = z.number().finite().nonnegative();
const allTagId = "00000000-0000-0000-0000-000000000000";

function result(data) { return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }; }
function register(name, description, inputSchema, fn) {
  mcp.registerTool(name, { description, inputSchema }, async (args) => {
    try { return result(await fn(args)); }
    catch (error) {
      const message = error?.publicMessage || "Операция Дзен-мани не выполнена.";
      console.error("zen_money_mcp: request failed (" + (error?.name || "Error") + ")");
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  });
}
async function refresh() { await api.sync(); }
function user() {
  const row = api.list("user")[0];
  if (!row) throw new ZenMoneyError("В Дзен-мани не найден профиль пользователя.");
  return row;
}
function find(collection, query, label) {
  const rows = api.list(collection);
  const byId = rows.find((row) => String(row.id).toLowerCase() === query.toLowerCase());
  if (byId) return byId;
  const sameTitle = rows.filter((row) => String(row.title ?? "").toLocaleLowerCase("ru") === query.toLocaleLowerCase("ru"));
  if (sameTitle.length === 1) return sameTitle[0];
  if (sameTitle.length > 1) throw new ZenMoneyError("Название «" + query + "» неоднозначно; передай ID " + label + ".");
  throw new ZenMoneyError(label + " «" + query + "» не найден.");
}
function catName(tagId) { return tagId ? api.get("tag", tagId)?.title ?? null : null; }
function instrumentName(instrumentId) {
  const row = api.list("instrument").find((item) => String(item.id) === String(instrumentId));
  return row?.shortTitle || row?.title || (instrumentId == null ? null : String(instrumentId));
}
function accountName(accountId) { return accountId ? api.get("account", accountId)?.title ?? null : null; }
function userId() {
  const value = Number(user().id);
  if (!Number.isFinite(value)) throw new ZenMoneyError("Не удалось определить ID пользователя.");
  return value;
}
function resolveAccount(value) {
  const row = find("account", value, "счёт");
  if (row.archive) throw new ZenMoneyError("Счёт «" + row.title + "» находится в архиве.");
  return row;
}
function resolveTags(single, many) {
  const values = many ?? (single ? [single] : []);
  return [...new Set(values.map((value) => find("tag", value, "категория").id))];
}
function resolveBudgetTag(value) {
  if (value === undefined || value === null || value === "__uncategorized__") return null;
  if (value === "__overall__") return allTagId;
  return find("tag", value, "категория").id;
}
function monthStart(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ZenMoneyError("Месяц укажи в формате ГГГГ-ММ.");
  return month + "-01";
}
function currencyOf(tx) {
  const account = api.get("account", tx.outcomeAccount) || api.get("account", tx.incomeAccount);
  return instrumentName(account?.instrument ?? tx.outcomeInstrument ?? tx.incomeInstrument);
}
function txType(tx) {
  if (Number(tx.income) > 0 && Number(tx.outcome) > 0) return "transfer";
  if (Number(tx.income) > 0) return "income";
  if (Number(tx.outcome) > 0) return "expense";
  return "other";
}
function txView(tx) {
  return {
    ...tx,
    type: txType(tx),
    outcomeAccountTitle: accountName(tx.outcomeAccount),
    incomeAccountTitle: accountName(tx.incomeAccount),
    categoryTitles: (tx.tag ?? []).map(catName).filter(Boolean),
    currency: currencyOf(tx)
  };
}
function accountView(row) {
  return {
    id: row.id, title: row.title, type: row.type, instrument: row.instrument,
    currency: instrumentName(row.instrument), balance: row.balance, startBalance: row.startBalance,
    creditLimit: row.creditLimit, archive: Boolean(row.archive),
    inBalance: Boolean(row.inBalance), savings: Boolean(row.savings)
  };
}
function budgetFor(dateValue, tagValue, uid) {
  return api.list("budget").find((row) =>
    row.date === dateValue && String(row.user) === String(uid) && (row.tag ?? null) === tagValue);
}
function merchantId(payee) {
  if (!payee) return null;
  return api.list("merchant").find((row) =>
    String(row.title ?? "").toLocaleLowerCase("ru") === payee.toLocaleLowerCase("ru"))?.id ?? null;
}

const apiEntityNames = ["instrument", "company", "user", "account", "tag", "merchant", "budget", "reminder", "reminderMarker", "transaction"];
const diffEntityNames = ["account", "tag", "merchant", "budget", "reminder", "reminderMarker", "transaction"];
const diffDeleteNames = ["account", "tag", "merchant", "reminder", "reminderMarker", "transaction"];
const rawRecord = z.record(z.string(), z.unknown());
const rawRecords = z.array(rawRecord).max(1000).optional();

register("sync_zenmoney", "Синхронизировать состояние с Дзен-мани через /v8/diff/. Можно запросить полную повторную загрузку выбранных сущностей.",
  z.object({ forceFetch: z.array(z.enum(apiEntityNames)).optional() }),
  async ({ forceFetch = [] }) => ({ ok: true, ...(await api.sync(forceFetch.length ? { forceFetch } : {})) }));

register("get_zenmoney_entities", "Получить полные исходные записи любой сущности ZenMoney API, включая reminderMarker. Используй для доступа ко всем полям и фильтров, которых нет в кратких инструментах.",
  z.object({
    entity: z.enum(apiEntityNames),
    fromDate: date.optional(), toDate: date.optional(), search: z.string().optional(),
    includeDeleted: z.boolean().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional()
  }),
  async ({ entity, fromDate, toDate, search, includeDeleted = false, limit = 100, offset = 0 }) => {
    await refresh();
    let rows = api.list(entity);
    if (entity === "transaction" && !includeDeleted) rows = rows.filter((row) => !row.deleted);
    if (fromDate || toDate) rows = rows.filter((row) => {
      const value = String(row.date ?? row.startDate ?? "");
      return Boolean(value) && (!fromDate || value >= fromDate) && (!toDate || value <= toDate);
    });
    if (search) {
      const needle = search.toLocaleLowerCase("ru");
      rows = rows.filter((row) => JSON.stringify(row).toLocaleLowerCase("ru").includes(needle));
    }
    rows.sort((a, b) => String(b.date ?? b.startDate ?? b.changed ?? "").localeCompare(String(a.date ?? a.startDate ?? a.changed ?? "")));
    return { entity, total: rows.length, offset, limit, records: rows.slice(offset, offset + limit) };
  });

register("apply_zenmoney_diff", "Полный низкоуровневый доступ к /v8/diff/: создаёт и изменяет любые поля счетов, категорий, контрагентов, бюджетов, напоминаний, маркеров напоминаний и операций; принимает массивы записей для пакетных изменений. Частичная запись объединяется с текущей, чтобы сохранить пропущенные поля. Для удаления обязательно confirmDeletes: true. Системные сущности user, instrument и company доступны только для чтения. Для бюджета передавай date первого числа месяца и tag (ID категории, null для без категории или нулевой UUID для общего бюджета).",
  z.object({
    account: rawRecords, tag: rawRecords, merchant: rawRecords, budget: rawRecords,
    reminder: rawRecords, reminderMarker: rawRecords, transaction: rawRecords,
    deletion: z.array(z.object({ object: z.enum(diffDeleteNames), id })).max(1000).optional(),
    confirmDeletes: z.literal(true).optional()
  }),
  async (args) => {
    const uid = userId();
    const changes = {};
    const submitted = {};
    for (const entity of diffEntityNames) {
      const rows = args[entity] ?? [];
      if (!rows.length) continue;
      submitted[entity] = rows.length;
      changes[entity] = rows.map((row) => {
        if (row.user !== undefined && String(row.user) !== String(uid)) {
          throw new ZenMoneyError("Можно изменять только данные текущего профиля.");
        }
        if (entity === "budget") {
          if (typeof row.date !== "string" || !/^\d{4}-\d{2}-01$/.test(row.date)) {
            throw new ZenMoneyError("Для бюджета укажи дату первого числа месяца в формате ГГГГ-ММ-01.");
          }
          if (!Object.hasOwn(row, "tag")) {
            throw new ZenMoneyError("Для бюджета явно укажи tag: ID категории, null или нулевой UUID.");
          }
          if (row.tag !== null && typeof row.tag !== "string") {
            throw new ZenMoneyError("Поле tag бюджета должно быть ID категории, null или нулевым UUID.");
          }
          const existing = api.list("budget").find((item) =>
            item.date === row.date && String(item.user) === String(uid) && (item.tag ?? null) === row.tag);
          return { ...(existing ?? {}), ...row, user: uid, changed: api.nextChanged(existing) };
        }
        if (row.id !== undefined && typeof row.id !== "string") {
          throw new ZenMoneyError("Поле id должно быть строкой UUID.");
        }
        const existing = row.id ? api.get(entity, row.id) : null;
        const next = { ...(existing ?? {}), ...row, id: row.id || randomUUID(), user: uid };
        next.changed = api.nextChanged(existing);
        if (entity === "transaction" && !existing) {
          next.created = Number.isFinite(Number(next.created)) ? Number(next.created) : Math.floor(Date.now() / 1000);
          if (next.deleted === undefined) next.deleted = false;
        }
        return next;
      });
    }

    const deletions = args.deletion ?? [];
    if (deletions.length && args.confirmDeletes !== true) {
      throw new ZenMoneyError("Для удаления передай confirmDeletes: true.");
    }
    if (deletions.length) {
      changes.deletion = deletions.map(({ object, id: objectId }) => {
        const existing = api.get(object, objectId);
        if (!existing) throw new ZenMoneyError("Запись для удаления не найдена: " + object + " " + objectId + ".");
        if (existing.user !== undefined && String(existing.user) !== String(uid)) {
          throw new ZenMoneyError("Можно удалять только данные текущего профиля.");
        }
        if (object === "tag") {
          const referenced = api.list("transaction").some((row) => (row.tag ?? []).map(String).includes(objectId))
            || api.list("budget").some((row) => String(row.tag ?? "") === objectId)
            || api.list("reminder").some((row) => (row.tag ?? []).map(String).includes(objectId))
            || api.list("reminderMarker").some((row) => (row.tag ?? []).map(String).includes(objectId));
          if (referenced) throw new ZenMoneyError("Категория используется в данных. Сначала скрой её, чтобы сохранить историю.");
        }
        if (object === "account") {
          const referenced = (row) => row.incomeAccount === objectId || row.outcomeAccount === objectId;
          if (existing.type === "debt" || api.list("transaction").some(referenced)
            || api.list("reminder").some(referenced) || api.list("reminderMarker").some(referenced)) {
            throw new ZenMoneyError("Счёт используется или является системным. Архивируй его, чтобы сохранить историю.");
          }
        }
        if (object === "reminder" && api.list("reminderMarker").some((row) => String(row.reminder) === objectId && row.state === "planned")) {
          throw new ZenMoneyError("У напоминания есть запланированные маркеры. Сначала обработай или удали их.");
        }
        return { id: objectId, object, stamp: api.nextChanged(existing), user: uid };
      });
    }

    if (!Object.keys(changes).length) throw new ZenMoneyError("Передай хотя бы одну запись для изменения.");
    const resultValue = await api.sync(changes);
    return { ok: true, submitted, deleted: deletions.length, counts: resultValue.counts, serverTimestamp: resultValue.serverTimestamp };
  });

register("get_zenmoney_profile", "Показать ID профиля и основную валюту Дзен-мани.", z.object({}),
  async () => {
    await refresh();
    const row = user();
    return { id: row.id, login: row.login ?? null, currencyId: row.currency,
      currency: instrumentName(row.currency), serverTimestamp: api.serverTimestamp };
  });

register("list_accounts", "Показать счета, валюты и балансы.",
  z.object({ includeArchived: z.boolean().optional() }),
  async ({ includeArchived = false }) => {
    await refresh();
    return api.list("account").filter((row) => includeArchived || !row.archive).map(accountView);
  });

register("list_categories", "Показать категории доходов и расходов и их родительские категории.",
  z.object({ includeHidden: z.boolean().optional() }),
  async ({ includeHidden = true }) => {
    await refresh();
    return api.list("tag").filter((row) => includeHidden || row.showIncome || row.showOutcome)
      .map((row) => ({ ...row, parentTitle: row.parent ? catName(row.parent) : null }))
      .sort((a, b) => String(a.title).localeCompare(String(b.title), "ru"));
  });

register("list_merchants", "Показать сохранённых контрагентов и получателей.", z.object({}),
  async () => {
    await refresh();
    return api.list("merchant").sort((a, b) => String(a.title).localeCompare(String(b.title), "ru"));
  });

register("list_transactions", "Найти операции по датам, счёту и категории; результат разбит на страницы.",
  z.object({
    fromDate: date.optional(), toDate: date.optional(), account: id.optional(), category: id.optional(),
    includeDeleted: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional()
  }),
  async ({ fromDate, toDate, account, category, includeDeleted = false, limit = 100, offset = 0 }) => {
    await refresh();
    const accountId = account ? find("account", account, "счёт").id : null;
    const categoryId = category ? find("tag", category, "категория").id : null;
    const rows = api.list("transaction").filter((tx) => includeDeleted || !tx.deleted)
      .filter((tx) => (!fromDate || tx.date >= fromDate) && (!toDate || tx.date <= toDate))
      .filter((tx) => !accountId || tx.incomeAccount === accountId || tx.outcomeAccount === accountId)
      .filter((tx) => !categoryId || (tx.tag ?? []).includes(categoryId))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.created ?? 0) - Number(a.created ?? 0));
    return { total: rows.length, offset, limit, hasMore: offset + limit < rows.length,
      transactions: rows.slice(offset, offset + limit).map(txView) };
  });

register("summarize_spending", "Свести доходы и расходы за период по валюте и категории. Валюты не складываются между собой.",
  z.object({ fromDate: date, toDate: date }),
  async ({ fromDate, toDate }) => {
    if (toDate < fromDate) throw new ZenMoneyError("Конец периода раньше начала.");
    await refresh();
    const totals = new Map();
    for (const tx of api.list("transaction").filter((row) =>
      !row.deleted && row.date >= fromDate && row.date <= toDate)) {
      const currency = currencyOf(tx) || "unknown";
      if (!totals.has(currency)) totals.set(currency, { currency, income: 0, outcome: 0, byCategory: {} });
      const item = totals.get(currency);
      item.income += Number(tx.income || 0);
      item.outcome += Number(tx.outcome || 0);
      if (Number(tx.outcome) > 0) {
        const labels = (tx.tag ?? []).map((tagId) => catName(tagId) || "Без категории");
        const label = labels.length ? labels.join(" / ") : "Без категории";
        item.byCategory[label] = (item.byCategory[label] || 0) + Number(tx.outcome);
      }
    }
    return { fromDate, toDate, totals: [...totals.values()] };
  });

register("list_budgets", "Показать бюджеты за месяц, включая общий и безкатегорийный бюджет.",
  z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
  async ({ month }) => {
    await refresh();
    const dateValue = monthStart(month);
    return api.list("budget").filter((row) => row.date === dateValue).map((row) => ({
      ...row,
      categoryTitle: row.tag === allTagId ? "Общий бюджет" : row.tag ? catName(row.tag) : "Без категории"
    }));
  });

const suggestionInput = z.object({
  payee: z.string().optional(), comment: z.string().optional(),
  amount: amount.optional(), date: date.optional()
});
register("suggest_transactions", "Получить подсказки Дзен-мани сразу для нескольких операций через пакетный /v8/suggest/.",
  z.object({ transactions: z.array(suggestionInput).min(1).max(100) }),
  async ({ transactions }) => {
    await refresh();
    const queries = transactions.map(({ payee, comment, amount: value, date: dateValue }) => {
      const query = {};
      if (payee !== undefined) query.payee = payee;
      if (comment !== undefined) query.comment = comment;
      if (value !== undefined) query.outcome = value;
      if (dateValue !== undefined) query.date = dateValue;
      return query;
    });
    const answers = await api.suggest(queries);
    if (!Array.isArray(answers)) throw new ZenMoneyError("Пакетный API подсказок вернул неожиданный ответ.");
    return answers.map((answer) => ({
      ...answer,
      categoryTitles: (answer.tag ?? []).map(catName).filter(Boolean),
      merchantTitle: answer.merchant ? api.get("merchant", answer.merchant)?.title ?? null : null
    }));
  });

register("suggest_transaction", "Запросить у Дзен-мани подсказку категории и контрагента.",
  z.object({ payee: z.string().optional(), comment: z.string().optional(), amount: amount.optional(), date: date.optional() }),
  async ({ payee, comment, amount: value, date: dateValue }) => {
    await refresh();
    const query = {};
    if (payee !== undefined) query.payee = payee;
    if (comment !== undefined) query.comment = comment;
    if (value !== undefined) query.outcome = value;
    if (dateValue !== undefined) query.date = dateValue;
    const answer = await api.suggest(query);
    return { ...answer, categoryTitles: (answer.tag ?? []).map(catName).filter(Boolean),
      merchantTitle: answer.merchant ? api.get("merchant", answer.merchant)?.title ?? null : null };
  });

register("create_transaction", "Создать расход, доход или перевод. Запишет финансовую операцию в Дзен-мани.",
  z.object({
    type: z.enum(["expense", "income", "transfer"]), amount: amount.refine((v) => v > 0),
    account: id, toAccount: id.optional(), receivedAmount: amount.optional(),
    category: id.optional(), categories: z.array(id).optional(),
    payee: z.string().optional(), comment: z.string().optional(), date
  }),
  async (args) => {
    await refresh();
    const profile = user();
    const source = resolveAccount(args.account);
    const destination = args.type === "transfer" ? resolveAccount(args.toAccount || "") : source;
    if (args.type === "transfer" && source.id === destination.id) throw new ZenMoneyError("Для перевода нужны два разных счёта.");
    const tags = resolveTags(args.category, args.categories);
    if (args.type === "transfer" && tags.length) throw new ZenMoneyError("Для перевода категории не задаются.");
    const now = Math.floor(Date.now() / 1000);
    const transactionId = randomUUID().toUpperCase();
    const transfer = args.type === "transfer";
    const income = args.type === "income" ? args.amount : transfer ? (args.receivedAmount ?? args.amount) : 0;
    const outcome = args.type === "income" ? 0 : args.amount;
    const tx = {
      id: transactionId, changed: now, created: now, user: Number(profile.id), deleted: false, hold: false,
      incomeInstrument: Number(destination.instrument ?? profile.currency), incomeAccount: destination.id, income,
      outcomeInstrument: Number(source.instrument ?? profile.currency), outcomeAccount: source.id, outcome,
      tag: tags.length ? tags : null, merchant: merchantId(args.payee), payee: args.payee || null,
      originalPayee: null, comment: args.comment || null, date: args.date, mcc: null, reminderMarker: null,
      opIncome: null, opIncomeInstrument: null, opOutcome: null, opOutcomeInstrument: null,
      latitude: null, longitude: null
    };
    await api.sync({ transaction: [tx] });
    return txView(api.get("transaction", transactionId) || tx);
  });

register("update_transaction", "Изменить сумму, дату, описание, получателя или категорию операции.",
  z.object({
    id, amount: amount.refine((v) => v > 0).optional(), receivedAmount: amount.optional(),
    date: date.optional(), payee: z.string().nullable().optional(),
    comment: z.string().nullable().optional(), category: id.nullable().optional()
  }),
  async ({ id: transactionId, amount: value, receivedAmount, date: dateValue, payee, comment, category }) => {
    await refresh();
    const old = api.get("transaction", transactionId);
    if (!old || old.deleted) throw new ZenMoneyError("Активная операция с таким ID не найдена.");
    const tx = { ...old, changed: api.nextChanged(old) };
    const kind = txType(old);
    if (value !== undefined) {
      if (kind === "income") tx.income = value;
      else {
        tx.outcome = value;
        if (kind === "transfer") tx.income = receivedAmount ?? value;
      }
    } else if (receivedAmount !== undefined && kind === "transfer") tx.income = receivedAmount;
    if (dateValue !== undefined) tx.date = dateValue;
    if (payee !== undefined) { tx.payee = payee; tx.merchant = merchantId(payee); }
    if (comment !== undefined) tx.comment = comment;
    if (category !== undefined) tx.tag = category === null ? null : [find("tag", category, "категория").id];
    await api.sync({ transaction: [tx] });
    return txView(api.get("transaction", transactionId) || tx);
  });

register("delete_transaction", "Пометить операцию удалённой в Дзен-мани. Изменит финансовую запись.",
  z.object({ id }),
  async ({ id: transactionId }) => {
    await refresh();
    const old = api.get("transaction", transactionId);
    if (!old || old.deleted) throw new ZenMoneyError("Активная операция с таким ID не найдена.");
    await api.sync({ transaction: [{ ...old, changed: api.nextChanged(old), deleted: true }] });
    return { ok: true, id: transactionId, deleted: true };
  });

register("create_category", "Создать категорию доходов, расходов или обоих типов.",
  z.object({
    title: z.string().min(1).max(100), kind: z.enum(["expense", "income", "both"]).optional(),
    parent: id.optional(), required: z.boolean().optional()
  }),
  async ({ title, kind = "expense", parent, required = false }) => {
    await refresh();
    let parentId = null;
    if (parent) {
      const parentRow = find("tag", parent, "родительская категория");
      if (parentRow.parent) throw new ZenMoneyError("Разрешён только один уровень вложенности категорий.");
      parentId = parentRow.id;
    }
    const showIncome = kind !== "expense";
    const showOutcome = kind !== "income";
    const tag = {
      id: randomUUID().toUpperCase(), changed: Math.floor(Date.now() / 1000), user: userId(),
      title, parent: parentId, icon: null, picture: null, color: null, showIncome, showOutcome,
      budgetIncome: showIncome, budgetOutcome: showOutcome, required
    };
    await api.sync({ tag: [tag] });
    return tag;
  });

register("update_category", "Изменить название, родителя и настройки категории.",
  z.object({
    id, title: z.string().min(1).max(100).optional(), parent: id.nullable().optional(),
    showIncome: z.boolean().optional(), showOutcome: z.boolean().optional(),
    budgetIncome: z.boolean().optional(), budgetOutcome: z.boolean().optional(),
    required: z.boolean().nullable().optional()
  }),
  async ({ id: tagId, ...patch }) => {
    await refresh();
    const old = api.get("tag", tagId);
    if (!old) throw new ZenMoneyError("Категория с таким ID не найдена.");
    const tag = { ...old, ...patch, changed: api.nextChanged(old) };
    if (patch.parent !== undefined && patch.parent !== null) {
      const parent = find("tag", patch.parent, "родительская категория");
      if (parent.id === tagId || parent.parent) throw new ZenMoneyError("Разрешён один уровень вложенности; циклическая вложенность запрещена.");
      tag.parent = parent.id;
    }
    await api.sync({ tag: [tag] });
    return tag;
  });

register("hide_category", "Скрыть категорию для новых операций, сохранив прошлую историю.",
  z.object({ id }),
  async ({ id: tagId }) => {
    await refresh();
    const old = api.get("tag", tagId);
    if (!old) throw new ZenMoneyError("Категория с таким ID не найдена.");
    const tag = { ...old, changed: api.nextChanged(old), showIncome: false, showOutcome: false,
      budgetIncome: false, budgetOutcome: false };
    await api.sync({ tag: [tag] });
    return { ok: true, category: tag };
  });

register("delete_category", "Безвозвратно удалить неиспользуемую категорию после явного подтверждения.",
  z.object({ id, confirm: z.literal(true) }),
  async ({ id: tagId }) => {
    await refresh();
    if (!api.get("tag", tagId)) throw new ZenMoneyError("Категория с таким ID не найдена.");
    const uses = api.list("transaction").filter((tx) => !tx.deleted && (tx.tag ?? []).includes(tagId)).length;
    if (uses) throw new ZenMoneyError("Категория используется в " + uses + " операциях. Переназначь их или скрой категорию.");
    await api.sync({ deletion: [{ id: tagId, object: "tag", stamp: Math.floor(Date.now() / 1000), user: userId() }] });
    return { ok: true, id: tagId, deleted: true };
  });

register("create_account", "Создать наличный, банковский, карточный или электронный счёт.",
  z.object({
    title: z.string().min(1).max(100), type: z.enum(["cash", "ccard", "checking", "emoney"]),
    instrument: id, openingBalance: z.number().finite().optional(),
    creditLimit: amount.optional(), savings: z.boolean().optional()
  }),
  async ({ title, type, instrument, openingBalance = 0, creditLimit, savings = false }) => {
    await refresh();
    const profile = user();
    const currency = api.list("instrument").find((row) =>
      String(row.id).toLowerCase() === instrument.toLowerCase() ||
      String(row.shortTitle ?? "").toLowerCase() === instrument.toLowerCase() ||
      String(row.title ?? "").toLocaleLowerCase("ru") === instrument.toLocaleLowerCase("ru"));
    if (!currency) throw new ZenMoneyError("Валюта «" + instrument + "» не найдена.");
    const account = {
      id: randomUUID().toUpperCase(), changed: Math.floor(Date.now() / 1000), user: Number(profile.id),
      role: null, instrument: Number(currency.id), company: null, type, title, syncID: null,
      balance: openingBalance, startBalance: openingBalance,
      creditLimit: type === "ccard" || type === "checking" ? (creditLimit ?? null) : null,
      inBalance: true, savings, enableCorrection: false, enableSMS: false, archive: false,
      capitalization: null, percent: null, startDate: null, endDateOffset: null,
      endDateOffsetInterval: null, payoffStep: null, payoffInterval: null
    };
    await api.sync({ account: [account] });
    return accountView(api.get("account", account.id) || account);
  });

register("update_account", "Изменить название, учёт баланса, накопительный статус или SMS-настройки счёта.",
  z.object({
    id, title: z.string().min(1).max(100).optional(), inBalance: z.boolean().optional(),
    savings: z.boolean().optional(), enableCorrection: z.boolean().optional(), enableSMS: z.boolean().optional()
  }),
  async ({ id: accountId, ...patch }) => {
    await refresh();
    const old = api.get("account", accountId);
    if (!old) throw new ZenMoneyError("Счёт с таким ID не найден.");
    const row = { ...old, ...patch, changed: api.nextChanged(old) };
    await api.sync({ account: [row] });
    return accountView(api.get("account", accountId) || row);
  });

register("archive_account", "Архивировать счёт, сохранив его операции и историю.", z.object({ id }),
  async ({ id: accountId }) => {
    await refresh();
    const old = api.get("account", accountId);
    if (!old) throw new ZenMoneyError("Счёт с таким ID не найден.");
    const row = { ...old, changed: api.nextChanged(old), archive: true };
    await api.sync({ account: [row] });
    return accountView(api.get("account", accountId) || row);
  });

register("create_merchant", "Добавить контрагента для операций и подсказок.",
  z.object({ title: z.string().min(1).max(100) }),
  async ({ title }) => {
    await refresh();
    const row = { id: randomUUID().toUpperCase(), changed: Math.floor(Date.now() / 1000), user: userId(), title };
    await api.sync({ merchant: [row] });
    return row;
  });

register("update_merchant", "Переименовать сохранённого контрагента.",
  z.object({ id, title: z.string().min(1).max(100) }),
  async ({ id: merchantIdValue, title }) => {
    await refresh();
    const old = api.get("merchant", merchantIdValue);
    if (!old) throw new ZenMoneyError("Контрагент с таким ID не найден.");
    const row = { ...old, title, changed: api.nextChanged(old) };
    await api.sync({ merchant: [row] });
    return row;
  });

register("set_budget", "Установить месячный бюджет дохода или расхода. Изменит бюджет в Дзен-мани.",
  z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), type: z.enum(["income", "outcome"]),
    amount, category: id.optional()
  }),
  async ({ month, type, amount: value, category }) => {
    await refresh();
    const dateValue = monthStart(month);
    const uid = userId();
    const tag = resolveBudgetTag(category);
    const old = budgetFor(dateValue, tag, uid);
    const row = old ? { ...old, changed: api.nextChanged(old) } : {
      changed: Math.floor(Date.now() / 1000), user: uid, tag, date: dateValue,
      income: 0, incomeLock: false, outcome: 0, outcomeLock: false
    };
    row[type] = value;
    row[type + "Lock"] = true;
    await api.sync({ budget: [row] });
    return { ...row, categoryTitle: tag === allTagId ? "Общий бюджет" : tag ? catName(tag) : "Без категории" };
  });

register("delete_budget", "Убрать бюджет категории за месяц, сняв фиксацию и обнулив сумму.",
  z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), type: z.enum(["income", "outcome"]),
    category: id.optional()
  }),
  async ({ month, type, category }) => {
    await refresh();
    const dateValue = monthStart(month);
    const tag = resolveBudgetTag(category);
    const old = budgetFor(dateValue, tag, userId());
    if (!old) throw new ZenMoneyError("Бюджет за этот месяц не найден.");
    const row = { ...old, changed: api.nextChanged(old), [type]: 0, [type + "Lock"]: false };
    await api.sync({ budget: [row] });
    return { ok: true, budget: row };
  });


register("list_instruments", "Показать доступные валюты и курсы.",
  z.object({}),
  async () => {
    await refresh();
    return api.list("instrument").map((row) => ({
      id: row.id, title: row.title, code: row.shortTitle, symbol: row.symbol, rate: row.rate
    }));
  });

register("list_companies", "Показать банки и платёжные организации из Дзен-мани.",
  z.object({}),
  async () => {
    await refresh();
    return api.list("company");
  });

register("list_reminder_markers", "Показать конкретные запланированные операции (ReminderMarker), включая planned, processed и deleted.",
  z.object({ fromDate: date.optional(), toDate: date.optional(), state: z.enum(["planned", "processed", "deleted"]).optional() }),
  async ({ fromDate, toDate, state }) => {
    await refresh();
    const reminders = new Map(api.list("reminder").map((row) => [String(row.id), row]));
    return api.list("reminderMarker")
      .filter((row) => (!fromDate || row.date >= fromDate) && (!toDate || row.date <= toDate) && (!state || row.state === state))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((row) => ({ ...row, reminderPayee: reminders.get(String(row.reminder))?.payee ?? null }));
  });

register("list_reminders", "Показать запланированные операции и их состояния.",
  z.object({ fromDate: date.optional(), toDate: date.optional() }),
  async ({ fromDate, toDate }) => {
    await refresh();
    const reminders = api.list("reminder").map((row) => ({
      ...row,
      type: Number(row.income) > 0 && Number(row.outcome) > 0 ? "transfer" :
        Number(row.income) > 0 ? "income" : "expense",
      outcomeAccountTitle: accountName(row.outcomeAccount),
      incomeAccountTitle: accountName(row.incomeAccount),
      categoryTitles: (row.tag ?? []).map(catName).filter(Boolean)
    }));
    const markers = api.list("reminderMarker")
      .filter((row) => (!fromDate || row.date >= fromDate) && (!toDate || row.date <= toDate))
      .map((row) => ({
        ...row,
        outcomeAccountTitle: accountName(row.outcomeAccount),
        incomeAccountTitle: accountName(row.incomeAccount),
        categoryTitles: (row.tag ?? []).map(catName).filter(Boolean)
      }));
    return { reminders, markers };
  });

register("create_reminder", "Создать запланированный расход, доход или перевод, в том числе повторяющийся.",
  z.object({
    type: z.enum(["expense", "income", "transfer"]),
    amount: amount.refine((v) => v > 0),
    account: id,
    toAccount: id.optional(),
    receivedAmount: amount.optional(),
    categories: z.array(id).optional(),
    payee: z.string().optional(),
    comment: z.string().optional(),
    startDate: date,
    endDate: date.nullable().optional(),
    interval: z.enum(["day", "week", "month", "year"]).nullable().optional(),
    step: z.number().int().min(1).optional(),
    points: z.array(z.number().int().min(0)).optional(),
    notify: z.boolean().optional()
  }),
  async (args) => {
    await refresh();
    const profile = user();
    const source = resolveAccount(args.account);
    const transfer = args.type === "transfer";
    const destination = transfer ? resolveAccount(args.toAccount || "") : source;
    if (transfer && source.id === destination.id) throw new ZenMoneyError("Для перевода нужны два разных счёта.");
    const tags = args.categories ? resolveTags(undefined, args.categories) : [];
    const interval = args.interval ?? null;
    const step = interval ? (args.step ?? 1) : 0;
    const points = interval ? (args.points ?? [0]) : null;
    if (interval && points.some((point) => point >= step)) {
      throw new ZenMoneyError("Каждая точка повтора должна быть меньше шага.");
    }
    const income = args.type === "income" ? args.amount :
      transfer ? (args.receivedAmount ?? args.amount) : 0;
    const outcome = args.type === "income" ? 0 : args.amount;
    const reminder = {
      id: randomUUID().toUpperCase(),
      changed: Math.floor(Date.now() / 1000),
      user: Number(profile.id),
      incomeInstrument: Number(destination.instrument ?? profile.currency),
      incomeAccount: destination.id,
      income,
      outcomeInstrument: Number(source.instrument ?? profile.currency),
      outcomeAccount: source.id,
      outcome,
      tag: tags.length ? tags : null,
      merchant: merchantId(args.payee),
      payee: args.payee || null,
      comment: args.comment || null,
      interval,
      step,
      points,
      startDate: args.startDate,
      endDate: args.endDate ?? null,
      notify: args.notify ?? true
    };
    await api.sync({ reminder: [reminder] });
    return reminder;
  });

register("update_reminder", "Изменить сумму, счета, категорию, дату или повторение напоминания.",
  z.object({
    id,
    amount: amount.refine((v) => v > 0).optional(),
    receivedAmount: amount.optional(),
    account: id.optional(),
    toAccount: id.optional(),
    category: id.nullable().optional(),
    payee: z.string().nullable().optional(),
    comment: z.string().nullable().optional(),
    startDate: date.optional(),
    endDate: date.nullable().optional(),
    interval: z.enum(["day", "week", "month", "year"]).nullable().optional(),
    step: z.number().int().min(1).optional(),
    points: z.array(z.number().int().min(0)).optional(),
    notify: z.boolean().optional()
  }),
  async ({ id: reminderId, ...patch }) => {
    await refresh();
    const old = api.get("reminder", reminderId);
    if (!old) throw new ZenMoneyError("Напоминание с таким ID не найдено.");
    const kind = Number(old.income) > 0 && Number(old.outcome) > 0 ? "transfer" :
      Number(old.income) > 0 ? "income" : "expense";
    const row = { ...old, changed: api.nextChanged(old) };
    if (patch.account !== undefined) {
      const account = resolveAccount(patch.account);
      if (kind === "income") {
        row.incomeAccount = account.id;
        row.incomeInstrument = Number(account.instrument ?? user().currency);
        row.outcomeAccount = account.id;
        row.outcomeInstrument = row.incomeInstrument;
      } else {
        row.outcomeAccount = account.id;
        row.outcomeInstrument = Number(account.instrument ?? user().currency);
      }
    }
    if (patch.toAccount !== undefined) {
      if (kind !== "transfer") throw new ZenMoneyError("Счёт-получатель задаётся только для перевода.");
      const account = resolveAccount(patch.toAccount);
      row.incomeAccount = account.id;
      row.incomeInstrument = Number(account.instrument ?? user().currency);
    }
    if (patch.amount !== undefined) {
      if (kind === "income") row.income = patch.amount;
      else {
        row.outcome = patch.amount;
        if (kind === "transfer") row.income = patch.receivedAmount ?? patch.amount;
      }
    } else if (patch.receivedAmount !== undefined && kind === "transfer") {
      row.income = patch.receivedAmount;
    }
    if (patch.category !== undefined) {
      row.tag = patch.category === null ? null : [find("tag", patch.category, "категория").id];
    }
    if (patch.payee !== undefined) {
      row.payee = patch.payee;
      row.merchant = merchantId(patch.payee);
    }
    if (patch.comment !== undefined) row.comment = patch.comment;
    if (patch.startDate !== undefined) row.startDate = patch.startDate;
    if (patch.endDate !== undefined) row.endDate = patch.endDate;
    if (patch.notify !== undefined) row.notify = patch.notify;
    const interval = patch.interval === undefined ? (row.interval ?? null) : patch.interval;
    row.interval = interval;
    if (interval) {
      row.step = patch.step ?? row.step ?? 1;
      row.points = patch.points ?? row.points ?? [0];
      if (row.points.some((point) => point >= row.step)) {
        throw new ZenMoneyError("Каждая точка повтора должна быть меньше шага.");
      }
    } else {
      row.step = 0;
      row.points = null;
    }
    await api.sync({ reminder: [row] });
    return row;
  });

register("delete_reminder", "Удалить напоминание. Нужно явно подтвердить удаление.",
  z.object({ id, confirm: z.literal(true) }),
  async ({ id: reminderId }) => {
    await refresh();
    if (!api.get("reminder", reminderId)) throw new ZenMoneyError("Напоминание с таким ID не найдено.");
    await api.sync({
      deletion: [{
        id: reminderId,
        object: "reminder",
        stamp: Math.floor(Date.now() / 1000),
        user: userId()
      }]
    });
    return { ok: true, id: reminderId, deleted: true };
  });


async function main() {
  await mcp.connect(new StdioServerTransport());
}
main().catch((error) => {
  console.error("zen_money_mcp: startup failed (" + (error?.name || "Error") + ")");
  process.exitCode = 1;
});

