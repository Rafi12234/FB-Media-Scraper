// Fetched image Blobs live in IndexedDB until ZIP download is confirmed.
// This allows reopening Chrome and resuming or exporting a partial ZIP.
const RECOVERY_DB_NAME = "fb-media-scraper-recovery";
const RECOVERY_STORE = "images";

function openRecoveryDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RECOVERY_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(RECOVERY_STORE, { keyPath: "id" });
      store.createIndex("batchKey", "batchKey", { unique: false });
    };
    req.onerror = () => reject(req.error || new Error("Cannot open recovery database"));
    req.onsuccess = () => resolve(req.result);
  });
}

async function readSavedImages(batchKey) {
  const db = await openRecoveryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECOVERY_STORE, "readonly");
    const request = tx.objectStore(RECOVERY_STORE).index("batchKey").getAll(batchKey);
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.index - b.index));
    request.onerror = () => reject(request.error || new Error("Cannot read saved images"));
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function countSavedImages(batchKey) {
  const db = await openRecoveryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECOVERY_STORE, "readonly");
    const request = tx.objectStore(RECOVERY_STORE).index("batchKey").count(batchKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Cannot count saved images"));
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function saveImageCheckpoint(batchKey, index, name, blob) {
  const db = await openRecoveryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECOVERY_STORE, "readwrite");
    tx.objectStore(RECOVERY_STORE).put({
      id: batchKey + ":" + index, batchKey, index, name, blob
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error("Cannot save image checkpoint")); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("Image save aborted")); };
  });
}

async function removeSavedImages(batchKey) {
  const db = await openRecoveryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECOVERY_STORE, "readwrite");
    const request = tx.objectStore(RECOVERY_STORE).index("batchKey")
      .openCursor(IDBKeyRange.only(batchKey));
    request.onsuccess = () => {
      if (request.result) {
        request.result.delete();
        request.result.continue();
      }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error("Cannot clear saved images")); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("Saved image removal aborted")); };
  });
}
