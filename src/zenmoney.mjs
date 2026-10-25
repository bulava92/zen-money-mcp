import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const names = ["instrument", "company", "user", "account", "tag", "merchant", "budget", "reminder", "reminderMarker", "transaction"];

export class ZenMoneyError extends Error {
  constructor(message) { super(message); this.name = "ZenMoneyError"; this.publicMessage = message; }
}

function entityKey(row) {
  if (row?.id !== undefined && row.id !== null) return String(row.id);
  if (row?.date !== undefined) return [row.user ?? "", row.date, row.tag ?? "__null__"].join(":");
  return null;
}

async function tokenFromFile() {
  const file = process.env.ZENMONEY_TOKEN_FILE || join(homedir(), ".config", "zen_money_mcp", "access-token");
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error?.code === "ENOENT") throw new ZenMoneyError("Токен не настроен. Запусти /var/www/zen-money-mcp/bin/set-token.sh на сервере.");
    throw new ZenMoneyError("Не удалось прочитать файл токена Дзен-мани.");
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new ZenMoneyError("Файл токена должен быть обычным файлом с правами только владельца (600).");
  }
  let token;
  try { token = (await readFile(file, "utf8")).trim(); }
  catch { throw new ZenMoneyError("Не удалось прочитать файл токена Дзен-мани."); }
  token = token.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new ZenMoneyError("Файл токена Дзен-мани пуст.");
  return token;
}

export class ZenMoneyClient {
  constructor() {
    this.serverTimestamp = 0;
    this.collections = new Map(names.map((name) => [name, new Map()]));
    this.queue = Promise.resolve();
  }
  list(name) { return [...(this.collections.get(name)?.values() ?? [])]; }
  get(name, id) { return this.collections.get(name)?.get(String(id)); }
  nextChanged(old) { return Math.max(Math.floor(Date.now() / 1000), Number(old?.changed ?? 0) + 1); }
  sync(changes = {}) {
    const task = () => this.performSync(changes);
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }
  merge(name, row) {
    if (!row || typeof row !== "object") return;
    const key = entityKey(row);
    if (key === null) return;
    const map = this.collections.get(name);
    const old = map.get(key);
    if (!old || Number(row.changed ?? -1) >= Number(old.changed ?? -1)) map.set(key, row);
  }
  async performSync(changes) {
    const token = await tokenFromFile();
    const request = { ...changes, currentClientTimestamp: Math.floor(Date.now() / 1000), serverTimestamp: this.serverTimestamp };
    let data;
    try {
      const response = await fetch("https://api.zenmoney.ru/v8/diff/", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(30000)
      });
      if (response.status === 401) throw new ZenMoneyError("Дзен-мани отверг токен (401). Проверь токен.");
      if (response.status === 403) throw new ZenMoneyError("У токена нет доступа к Дзен-мани (403).");
      if (!response.ok) throw new ZenMoneyError("API Дзен-мани вернул HTTP " + response.status + ".");
      try { data = await response.json(); }
      catch { throw new ZenMoneyError("API Дзен-мани вернул некорректный ответ."); }
    } catch (error) {
      if (error instanceof ZenMoneyError) throw error;
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new ZenMoneyError("Истекло время ожидания API Дзен-мани.");
      throw new ZenMoneyError("Не удалось связаться с API Дзен-мани.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ZenMoneyError("API Дзен-мани вернул неожиданный ответ.");

    for (const [name, rows] of Object.entries(changes)) {
      if (names.includes(name) && Array.isArray(rows)) for (const row of rows) this.merge(name, row);
    }
    for (const name of names) if (Array.isArray(data[name])) for (const row of data[name]) this.merge(name, row);
    for (const deletion of [
      ...(Array.isArray(changes.deletion) ? changes.deletion : []),
      ...(Array.isArray(data.deletion) ? data.deletion : [])
    ]) {
      const map = this.collections.get(deletion?.object);
      if (map && deletion?.id !== undefined) map.delete(String(deletion.id));
    }
    if (Number.isFinite(data.serverTimestamp)) this.serverTimestamp = data.serverTimestamp;
    const counts = Object.fromEntries(names.map((name) => [name, this.collections.get(name).size]));
    return {
      serverTimestamp: this.serverTimestamp,
      received: names.reduce((n, name) => n + (Array.isArray(data[name]) ? data[name].length : 0), 0),
      counts
    };
  }
  async suggest(transaction) {
    const token = await tokenFromFile();
    try {
      const response = await fetch("https://api.zenmoney.ru/v8/suggest/", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(transaction),
        signal: AbortSignal.timeout(30000)
      });
      if (response.status === 401) throw new ZenMoneyError("Дзен-мани отверг токен (401). Проверь токен.");
      if (response.status === 403) throw new ZenMoneyError("У токена нет доступа к Дзен-мани (403).");
      if (!response.ok) throw new ZenMoneyError("API подсказок Дзен-мани вернул HTTP " + response.status + ".");
      try { return await response.json(); }
      catch { throw new ZenMoneyError("API подсказок Дзен-мани вернул некорректный ответ."); }
    } catch (error) {
      if (error instanceof ZenMoneyError) throw error;
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new ZenMoneyError("Истекло время ожидания API Дзен-мани.");
      throw new ZenMoneyError("Не удалось связаться с API Дзен-мани.");
    }
  }
}

