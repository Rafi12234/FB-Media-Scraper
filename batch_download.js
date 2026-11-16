// Resumable image batches. Raw downloaded Blobs are checkpointed immediately.
// On interruption, reopen the popup and resume only the missing source indices.
function normalizeBatchItems(session, batchIndex) {
  const raw = session.batches.get(batchIndex) || [];
  return raw.map((item, offset) => {
    if (item && typeof item === "object" && typeof item.url === "string") return item;
    // Old sessions used URL strings; maintain compatibility with their indices.
    return { url: item, index: (batchIndex - 1) * IMAGE_BATCH_SIZE + offset + 1 };
  });
}

async function fetchImageWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, {
        credentials: "include", cache: "no-store", signal: controller.signal
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const blob = await response.blob();
      if (!blob.size) throw new Error("Empty image response");
      return blob;
    } catch (err) {
      lastError = err;
      if (attempt === 0) await sleep(600);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Image fetch failed");
}

async function runImageBatch(session, batchIndex) {
  const key = session.sessionId + ":" + batchIndex;
  if (activeBatchDownloads.has(key)) {
    return { ok: false, message: "Batch is already running" };
  }
  if (session.downloadedBatches.has(batchIndex)) {
    return { ok: false, message: "Batch already downloaded" };
  }
  const items = normalizeBatchItems(session, batchIndex);
  if (!items.length) return { ok: false, message: "Batch is empty" };
  activeBatchDownloads.add(key);
  let savedCount = 0;
  try {
    const existing = await readSavedImages(key);
    const savedIndices = new Set(existing.map((record) => record.index));
    savedCount = savedIndices.size;
    let consecutiveFailures = 0;
    for (let position = 0; position < items.length; position += 1) {
      const item = items[position];
      if (savedIndices.has(item.index)) continue;
      try {
        const blob = await fetchImageWithRetry(item.url);
        const filename = "images/" + (session.imageBaseName || "image") +
          "_" + item.index + getExtension(item.url, ".jpg");
        await saveImageCheckpoint(key, item.index, filename, blob);
        savedIndices.add(item.index);
        savedCount = savedIndices.size;
        consecutiveFailures = 0;
      } catch (err) {
        if (err && /quota|checkpoint|storage|database/i.test(String(err.message))) {
          throw new Error("Recovery storage unavailable or full; free space and resume.");
        }
        consecutiveFailures += 1;
      }
      sendProgress({
        type: "IMAGE_CHECKPOINT", sessionId: session.sessionId,
        batchIndex, savedCount, total: items.length, active: true
      });
      sendProgress({
        type: "DOWNLOAD_PROGRESS", stage: "download",
        current: position + 1, total: items.length,
        batchIndex, batchTotal: session.batchTotal || 1, batchType: "images"
      });
      // Avoid wasting the entire batch when the connection is unavailable.
      if (consecutiveFailures >= 3) break;
      await sleep(100);
    }
    const records = await readSavedImages(key);
    if (!records.length) throw new Error("No images fetched. Retry the batch.");
    const partial = records.length < items.length;
    const normalZip = buildImageZipName(
      "fb_media_" + session.timestamp, batchIndex, session.batchTotal || 1
    );
    const zipName = partial
      ? normalZip.replace(/\.zip$/i, "_partial_" + records.length + "images.zip")
      : normalZip;
    const result = await createAndDownloadZip(
      records.map((record) => ({ name: record.name, blob: record.blob })),
      zipName,
      { batchIndex, batchTotal: session.batchTotal || 1, batchType: "images" }
    );
    if (result === null) {
      throw new Error("ZIP could not be downloaded. Cached images are still available.");
    }
    if (!partial) {
      session.downloadedBatches.add(batchIndex);
      saveSessions();
      await removeSavedImages(key);
    }
    sendProgress({
      type: "DOWNLOAD_DONE", saved: records.length, zipName, zipNames: [zipName],
      partial, sessionId: session.sessionId, batchIndex,
      batchTotal: session.batchTotal || 1, batchType: "images"
    });
    return { ok: !partial, partial, saved: records.length, zipName };
  } catch (err) {
    sendProgress({
      type: "DOWNLOAD_ERROR", message: err.message || "Batch interrupted; cached images are recoverable."
    });
    return { ok: false, message: err.message || "Batch interrupted" };
  } finally {
    activeBatchDownloads.delete(key);
    sendProgress({
      type: "IMAGE_CHECKPOINT", sessionId: session.sessionId, batchIndex,
      savedCount: await countSavedImages(key).catch(() => savedCount),
      total: items.length, active: false,
      downloaded: session.downloadedBatches.has(batchIndex)
    });
  }
}

async function listBatchStatuses() {
  await sessionsReady;
  const statuses = [];
  for (const session of imageResolveSessions.values()) {
    for (const [batchIndex, items] of session.batches) {
      if (!items.length) continue;
      const key = session.sessionId + ":" + batchIndex;
      statuses.push({
        sessionId: session.sessionId, batchIndex,
        batchTotal: session.batchTotal, pageTitle: session.pageTitle,
        resolvedCount: items.length, savedCount: await countSavedImages(key),
        downloaded: session.downloadedBatches.has(batchIndex),
        active: activeBatchDownloads.has(key)
      });
    }
  }
  return statuses;
}

async function savePartialBatch(sessionId, batchIndex) {
  await sessionsReady;
  const session = imageResolveSessions.get(sessionId);
  if (!session || !session.batches.has(batchIndex)) {
    return { ok: false, message: "Batch not found" };
  }
  const records = await readSavedImages(sessionId + ":" + batchIndex);
  if (!records.length) return { ok: false, message: "No recovered images to save yet" };
  const zipName = buildImageZipName(
    "fb_media_" + session.timestamp, batchIndex, session.batchTotal || 1
  ).replace(/\.zip$/i, "_recovered_" + records.length + "images.zip");
  const result = await createAndDownloadZip(
    records.map((record) => ({ name: record.name, blob: record.blob })),
    zipName,
    { batchIndex, batchTotal: session.batchTotal || 1, batchType: "images" }
  );
  return result === null
    ? { ok: false, message: "Recovery ZIP failed; saved images remain available" }
    : { ok: true, saved: records.length, zipName };
}
