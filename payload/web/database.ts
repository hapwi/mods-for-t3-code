import type { Json, ModBundle, ModRecord } from "../../sdk.d.ts";

const DB_NAME = "mods-for-t3-code-v1";
type StoreName = "mods" | "data" | "settings";
type JsonObject = { [key: string]: Json };
let opening: Promise<IDBDatabase> | undefined;
/** Where a bundle waiting for review came from. */
export type PendingSource = "chat" | "inbox" | "file" | "paste";
/** A bundle that arrived but has not been installed or dismissed yet. Re-validated on load. */
export interface PendingRecord { bundle: ModBundle; hash: string; source: PendingSource; receivedAt: number; threadId?: string; messageId?: string }
type SettingValue = boolean | { [key: string]: number } | readonly PendingRecord[];

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("mods", { keyPath: "manifest.id" });
      request.result.createObjectStore("data");
      request.result.createObjectStore("settings");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = undefined; reject(request.error ?? new Error("Could not open mod storage.")); };
  });
  return opening;
}

async function operation<T>(store: StoreName, mode: IDBTransactionMode, callback: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    let result: T | undefined;
    const request = callback(transaction.objectStore(store));
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result as T);
    transaction.onerror = () => reject(transaction.error ?? new Error("Mod storage failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Mod storage transaction cancelled."));
  });
}

function jsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

export const database = {
  async list(): Promise<ModRecord[]> {
    const records = await operation<ModRecord[]>("mods", "readonly", (store) => store.getAll() as IDBRequest<ModRecord[]>);
    return Array.isArray(records) ? records : [];
  },
  save(record: ModRecord): Promise<void> {
    return operation("mods", "readwrite", (store) => store.put(record)).then(() => undefined);
  },
  async remove(id: string): Promise<void> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["mods", "data"], "readwrite");
      transaction.objectStore("mods").delete(id);
      transaction.objectStore("data").delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Mod storage failed."));
    });
  },
  async getData(id: string): Promise<JsonObject> {
    return jsonObject(await operation<unknown>("data", "readonly", (store) => store.get(id) as IDBRequest<unknown>));
  },
  setData(id: string, value: JsonObject): Promise<void> {
    return operation("data", "readwrite", (store) => store.put(value, id)).then(() => undefined);
  },
  getSetting(key: string): Promise<unknown> {
    return operation<unknown>("settings", "readonly", (store) => store.get(key) as IDBRequest<unknown>);
  },
  setSetting(key: string, value: SettingValue): Promise<void> {
    return operation("settings", "readwrite", (store) => store.put(value, key)).then(() => undefined);
  },
};
