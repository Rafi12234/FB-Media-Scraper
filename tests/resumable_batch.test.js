const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "batch_download.js"), "utf8");

function makeFixture(saved, failFrom = null) {
  const records = new Map(saved.map((index) => [index, { index, name: "images/img_" + index + ".jpg", blob: { size: 100 } }]));
  let requested = 0;
  let zipped = 0;
  let cleaned = 0;
  const session = {
    sessionId: "session-1", pageTitle: "Test", timestamp: "20261116_160000",
    imageBaseName: "img", batchTotal: 1, downloadedBatches: new Set(),
    batches: new Map([[1, Array.from({ length: 300 }, (_, i) => ({
      url: "https://fbcdn.net/" + (i + 1) + ".jpg", index: i + 1
    }))]])
  };
  const sandbox = {
    activeBatchDownloads: new Set(),
    readSavedImages: async () => [...records.values()].sort((a, b) => a.index - b.index),
    saveImageCheckpoint: async (_, index, name, blob) => { records.set(index, { index, name, blob }); },
    fetch: async (url) => {
      requested += 1;
      const index = Number(url.split("/").pop().split(".")[0]);
      if (failFrom !== null && index >= failFrom) throw new Error("Connection lost");
      return { ok: true, blob: async () => ({ size: 100 }) };
    },
    AbortController, setTimeout, clearTimeout,
    sleep: async () => {},
    getExtension: () => ".jpg",
    IMAGE_BATCH_SIZE: 300,
    createAndDownloadZip: async (entries) => { zipped += 1; return { saved: entries.length }; },
    sendProgress: () => {},
    countSavedImages: async () => records.size,
    removeSavedImages: async () => { cleaned += 1; records.clear(); },
    saveSessions: () => {},
    buildImageZipName: (name) => name + ".zip",
    imageResolveSessions: new Map([["session-1", session]]),
    sessionsReady: Promise.resolve(),
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    session, sandbox, records,
    get requested() { return requested; },
    get zipped() { return zipped; },
    get cleaned() { return cleaned; }
  };
}

test("resume 230 cached images by fetching only the remaining 70", async () => {
  const fixture = makeFixture(Array.from({ length: 230 }, (_, i) => i + 1));
  const result = await fixture.sandbox.runImageBatch(fixture.session, 1);
  assert.equal(result.ok, true);
  assert.equal(fixture.requested, 70);
  assert.equal(fixture.cleaned, 1);
  assert.equal(fixture.records.size, 0);
});

test("offline after 230 images retains them for partial ZIP export", async () => {
  const fixture = makeFixture([], 231);
  const result = await fixture.sandbox.runImageBatch(fixture.session, 1);
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.saved, 230);
  assert.equal(fixture.records.size, 230);
  const recovery = await fixture.sandbox.savePartialBatch("session-1", 1);
  assert.equal(recovery.ok, true);
  assert.equal(recovery.saved, 230);
  assert.equal(fixture.cleaned, 0);
});
