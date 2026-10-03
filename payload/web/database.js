const DB_NAME = "mods-for-t3-code-v1";
let opening;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("mods", { keyPath: "manifest.id" });
      request.result.createObjectStore("data");
      request.result.createObjectStore("settings");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = undefined; reject(request.error); };
  });
  return opening;
}

async function operation(store, mode, callback) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    let result;
    const request = callback(transaction.objectStore(store));
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Mod storage transaction cancelled."));
  });
}

export const database = {
  list: () => operation("mods", "readonly", (store) => store.getAll()),
  save: (record) => operation("mods", "readwrite", (store) => store.put(record)),
  async remove(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["mods", "data"], "readwrite");
      transaction.objectStore("mods").delete(id);
      transaction.objectStore("data").delete(id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  },
  getData: (id) => operation("data", "readonly", (store) => store.get(id)).then((value) => value ?? {}),
  setData: (id, value) => operation("data", "readwrite", (store) => store.put(value, id)),
  getSetting: (key) => operation("settings", "readonly", (store) => store.get(key)),
  setSetting: (key, value) => operation("settings", "readwrite", (store) => store.put(value, key)),
};
