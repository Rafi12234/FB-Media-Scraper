let downloadInProgress = false;

const VIDEO_FALLBACK_EXTENSION = ".mp4";
const DOWNLOAD_DELAY_MS = 800;
const TAB_LOAD_TIMEOUT_MS = 30000;
const VIDEO_CONTENT_PREFIX = "video/";
const DOWNLOADABLE_VIDEO_EXTENSIONS = [".mp4", ".m4v", ".webm", ".mov"];
const ZIP_MIME = "application/zip";
const MAX_ZIP_BYTES = 300 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = createCrcTable();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const index = (crc ^ bytes[i]) & 0xff;
    crc = (crc >>> 8) ^ CRC_TABLE[index];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildLocalHeader(nameLength, size, crc) {
  const buffer = new ArrayBuffer(30);
  const view = new DataView(buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameLength, true);
  view.setUint16(28, 0, true);
  return new Uint8Array(buffer);
}

function buildCentralHeader(nameLength, size, crc, offset) {
  const buffer = new ArrayBuffer(46);
  const view = new DataView(buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  return new Uint8Array(buffer);
}

function buildEndHeader(entries, centralSize, centralOffset) {
  const buffer = new ArrayBuffer(22);
  const view = new DataView(buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entries, true);
  view.setUint16(10, entries, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return new Uint8Array(buffer);
}

async function buildZip(entries) {
  const encoder = new TextEncoder();
  const fileParts = [];
  const centralParts = [];
  const centralRecords = [];
  let offset = 0;

  for (const entry of entries) {
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const nameBytes = encoder.encode(entry.name);
    const checksum = crc32(data);
    const localHeader = buildLocalHeader(nameBytes.length, data.length, checksum);

    fileParts.push(localHeader, nameBytes, data);
    centralRecords.push({ nameBytes, checksum, size: data.length, offset });
    offset += localHeader.length + nameBytes.length + data.length;
  }

  let centralSize = 0;
  centralRecords.forEach((record) => {
    const centralHeader = buildCentralHeader(record.nameBytes.length, record.size, record.checksum, record.offset);
    centralParts.push(centralHeader, record.nameBytes);
    centralSize += centralHeader.length + record.nameBytes.length;
  });

  const endHeader = buildEndHeader(centralRecords.length, centralSize, offset);
  return new Blob([...fileParts, ...centralParts, endHeader], { type: ZIP_MIME });
}

function sendProgress(message) {
  chrome.runtime.sendMessage(message);
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "_" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function getExtension(url, fallback) {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf(".");
    if (dot !== -1 && dot < path.length - 1) {
      return path.slice(dot).toLowerCase();
    }
  } catch (err) {
    // ignore
  }
  return fallback || "";
}

function decodeEscapes(value) {
  return String(value || "")
    .replace(/\\u0025/g, "%")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003D/g, "=")
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectDirectVideoMatches(text) {
  const matches = [];
  const patterns = [
    /"playable_url_quality_hd"\s*:\s*"(.*?)"/g,
    /"playable_url"\s*:\s*"(.*?)"/g,
    /"progressive_url"\s*:\s*"(.*?)"/g,
    /"hd_src_no_ratelimit"\s*:\s*"(.*?)"/g,
    /"sd_src_no_ratelimit"\s*:\s*"(.*?)"/g,
    /"hd_src"\s*:\s*"(.*?)"/g,
    /"sd_src"\s*:\s*"(.*?)"/g,
    /"browser_native_hd_url"\s*:\s*"(.*?)"/g,
    /"browser_native_sd_url"\s*:\s*"(.*?)"/g,
    /property=\\"og:video(?:\\:url)?\\"\s+content=\\"(.*?)\\"/g,
    /property=\\"og:video(?:\\:url)?\\"\s+content=\"(.*?)\"/g
  ];

  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(text))) {
      const decoded = decodeEscapes(match[1]);
      if (decoded) {
        matches.push({ url: decoded, index: match.index });
      }
    }
  });

  return matches;
}

function extractDirectVideosFromText(text) {
  const found = new Set();
  collectDirectVideoMatches(text).forEach((match) => {
    found.add(match.url);
  });
  const cleaned = text.replace(/\\"/g, '"');
  if (cleaned !== text) {
    collectDirectVideoMatches(cleaned).forEach((match) => {
      found.add(match.url);
    });
  }
  return Array.from(found);
}

function extractOgVideoFromText(text) {
  const found = new Set();
  const patterns = [
    /property=\\"og:video(?:\\:url)?\\"\s+content=\\"(.*?)\\"/g,
    /property=\\"og:video(?:\\:url)?\\"\s+content=\"(.*?)\"/g,
    /property="og:video(?:\:url)?"\s+content="(.*?)"/g
  ];

  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(text))) {
      const decoded = decodeEscapes(match[1]);
      if (decoded) {
        found.add(decoded);
      }
    }
  });

  return Array.from(found);
}

function extractVideoIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname || "";
    const parts = pathname.split("/").filter(Boolean);

    if (parsed.hostname.endsWith("fb.watch") && parts[0]) {
      return parts[0];
    }

    const vParam = parsed.searchParams.get("v");
    if (vParam) {
      return vParam;
    }

    const videosIndex = parts.indexOf("videos");
    if (videosIndex !== -1 && parts[videosIndex + 1]) {
      return parts[videosIndex + 1];
    }

    const reelIndex = parts.indexOf("reel");
    if (reelIndex !== -1 && parts[reelIndex + 1]) {
      return parts[reelIndex + 1];
    }

    const reelsIndex = parts.indexOf("reels");
    if (reelsIndex !== -1 && parts[reelsIndex + 1]) {
      return parts[reelsIndex + 1];
    }

    return "";
  } catch (err) {
    return "";
  }
}

function extractDirectVideosForId(text, videoId) {
  if (!videoId) return [];
  const safeId = escapeRegExp(videoId);
  const idPattern = new RegExp(
    `(?:"|\\")video_id(?:"|\\")\\s*:\\s*(?:"|\\")?${safeId}(?:"|\\")?` +
      `|(?:"|\\")videoID(?:"|\\")\\s*:\\s*(?:"|\\")?${safeId}(?:"|\\")?`,
    "g"
  );
  const idIndexes = [];
  let match;
  while ((match = idPattern.exec(text))) {
    idIndexes.push(match.index);
  }

  if (idIndexes.length === 0) {
    return [];
  }

  const matches = collectDirectVideoMatches(text);
  if (matches.length === 0) {
    return [];
  }

  const scored = matches.map((item) => {
    let minDist = Infinity;
    idIndexes.forEach((idx) => {
      const dist = Math.abs(item.index - idx);
      if (dist < minDist) {
        minDist = dist;
      }
    });
    return { url: item.url, dist: minDist };
  });

  scored.sort((a, b) => a.dist - b.dist);
  const bestDist = scored[0].dist;
  const found = new Set();
  scored.forEach((item) => {
    if (item.dist <= bestDist + 2000) {
      found.add(item.url);
    }
  });

  return Array.from(found);
}

function pickBestVideo(urls) {
  if (!urls.length) return "";
  const hd = urls.find((url) => url.includes("hd"));
  return hd || urls[0];
}

function isDirectVideoFile(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return DOWNLOADABLE_VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext));
  } catch (err) {
    return false;
  }
}

async function verifyVideoUrl(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-1" },
      credentials: "include",
      cache: "no-store"
    });
    if (!(response.status === 200 || response.status === 206)) {
      return false;
    }
    const contentType = response.headers.get("content-type") || "";
    return contentType.startsWith(VIDEO_CONTENT_PREFIX);
  } catch (err) {
    return false;
  }
}

function downloadFile(url, fileName) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename: fileName, saveAs: false }, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err || !downloadId) {
        reject(new Error(err ? err.message : "Download failed"));
        return;
      }
      resolve(downloadId);
    });
  });
}

async function blobToDataUrl(blob) {
  if (typeof FileReaderSync !== "undefined") {
    const reader = new FileReaderSync();
    return reader.readAsDataURL(blob);
  }

  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed to read blob"));
      reader.readAsDataURL(blob);
    });
  }

  throw new Error("No FileReader available");
}

async function fetchAsBlob(url) {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }
  return response.blob();
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timeoutId;

    const listener = (updatedTabId, info) => {
      if (updatedTabId !== tabId) {
        return;
      }
      if (info.status === "complete") {
        cleanup();
        resolve(true);
      }
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
    };

    chrome.tabs.onUpdated.addListener(listener);

    timeoutId = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response || {});
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    await sendMessageToTab(tabId, { type: "PING" });
    return true;
  } catch (err) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
      await sendMessageToTab(tabId, { type: "PING" });
      return true;
    } catch (err2) {
      return false;
    }
  }
}

async function getPageTextFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const chunks = [];
        if (document.documentElement && document.documentElement.innerHTML) {
          chunks.push(document.documentElement.innerHTML);
        }
        document.querySelectorAll("script").forEach((script) => {
          const text = script.textContent || "";
          if (text) {
            chunks.push(text);
          }
        });
        return chunks.join("\n");
      }
    });
    const entry = Array.isArray(results) ? results[0] : null;
    return entry && typeof entry.result === "string" ? entry.result : "";
  } catch (err) {
    return "";
  }
}

async function resolveVideoInTab(url) {
  if (!url) {
    return [];
  }
  if (isDirectVideoFile(url)) {
    return [url];
  }
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  if (!tabId) {
    return [];
  }

  await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
  const text = await getPageTextFromTab(tabId);
  await chrome.tabs.remove(tabId);

  if (!text) {
    return [];
  }

  const videoId = extractVideoIdFromUrl(url);
  const scoped = extractDirectVideosForId(text, videoId);
  if (scoped.length > 0) {
    return scoped;
  }

  const ogOnly = extractOgVideoFromText(text);
  if (ogOnly.length > 0) {
    return ogOnly;
  }

  const allDirect = Array.from(new Set(extractDirectVideosFromText(text)));
  if (allDirect.length === 1) {
    return allDirect;
  }

  return [];
}

async function downloadMedia(payload) {
  if (downloadInProgress) {
    sendProgress({ type: "DOWNLOAD_ERROR", message: "Download already running" });
    return;
  }

  downloadInProgress = true;

  try {
    const timestamp = payload.timestamp || formatTimestamp(new Date());
    const folder = `fb_media_${timestamp}`;

    const images = Array.isArray(payload.images) ? payload.images : [];
    const videos = Array.isArray(payload.videos) ? payload.videos : [];

    let skippedVideos = 0;
    let invalidVideos = 0;
    const resolvedVideos = [];
    if (videos.length > 0) {
      let videoIndex = 1;
      let current = 0;

      for (const link of videos) {
        current += 1;
        sendProgress({ type: "DOWNLOAD_PROGRESS", stage: "resolve", current, total: videos.length });
        const directVideos = await resolveVideoInTab(link);
        const chosen = pickBestVideo(directVideos);
        if (!chosen) {
          skippedVideos += 1;
          continue;
        }
        resolvedVideos.push({ url: chosen, index: videoIndex });
        videoIndex += 1;
      }
    }

    const totalItems = images.length + resolvedVideos.length;
    const entries = [];
    let totalBytes = 0;
    let processed = 0;

    if (images.length > 0) {
      let imageIndex = 1;
      for (const url of images) {
        const ext = getExtension(url, ".jpg");
        const entryName = `images/image_${String(imageIndex).padStart(4, "0")}${ext}`;
        imageIndex += 1;
        processed += 1;
        try {
          const blob = await fetchAsBlob(url);
          totalBytes += blob.size;
          entries.push({ name: entryName, blob });
        } catch (err) {
          invalidVideos += 1;
        }
        sendProgress({ type: "DOWNLOAD_PROGRESS", stage: "download", current: processed, total: totalItems });
        await sleep(100);
      }
    }

    if (resolvedVideos.length > 0) {
      for (const item of resolvedVideos) {
        const ext = getExtension(item.url, VIDEO_FALLBACK_EXTENSION);
        const entryName = `videos/video_${String(item.index).padStart(4, "0")}${ext}`;
        processed += 1;
        try {
          const blob = await fetchAsBlob(item.url);
          totalBytes += blob.size;
          entries.push({ name: entryName, blob });
        } catch (err) {
          invalidVideos += 1;
        }
        sendProgress({ type: "DOWNLOAD_PROGRESS", stage: "download", current: processed, total: totalItems });
        await sleep(DOWNLOAD_DELAY_MS);
      }
    }

    if (entries.length === 0) {
      sendProgress({ type: "DOWNLOAD_DONE", skippedVideos, invalidVideos, zipName: `${folder}.zip`, saved: 0 });
      return;
    }

    sendProgress({ type: "DOWNLOAD_PROGRESS", stage: "zip", current: 0, total: 100 });
    let zipBlob;
    try {
      zipBlob = await buildZip(entries);
    } catch (err) {
      sendProgress({
        type: "DOWNLOAD_ERROR",
        message: `Zip build failed: ${err && err.message ? err.message : "Unknown error"}`
      });
      return;
    }
    sendProgress({ type: "DOWNLOAD_PROGRESS", stage: "zip", current: 100, total: 100 });

    if (zipBlob.size > MAX_ZIP_BYTES) {
      sendProgress({
        type: "DOWNLOAD_ERROR",
        message: `Zip too large (${Math.round(zipBlob.size / (1024 * 1024))} MB). Reduce selection or disable zip mode.`
      });
      return;
    }

    const zipName = `${folder}.zip`;
    let zipUrl = "";
    let revokeUrl = false;
    try {
      if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        zipUrl = URL.createObjectURL(zipBlob);
        revokeUrl = true;
      } else {
        zipUrl = await blobToDataUrl(zipBlob);
      }
    } catch (err) {
      sendProgress({
        type: "DOWNLOAD_ERROR",
        message: `Zip URL failed: ${err && err.message ? err.message : "Unknown error"}`
      });
      return;
    }
    try {
      await downloadFile(zipUrl, zipName);
    } catch (err) {
      sendProgress({
        type: "DOWNLOAD_ERROR",
        message: `Zip download failed: ${err && err.message ? err.message : "Unknown error"}`
      });
      return;
    } finally {
      if (revokeUrl) {
        setTimeout(() => URL.revokeObjectURL(zipUrl), 60000);
      }
    }

    sendProgress({
      type: "DOWNLOAD_DONE",
      skippedVideos,
      invalidVideos,
      zipName,
      saved: entries.length,
      totalBytes
    });
  } catch (err) {
    sendProgress({ type: "DOWNLOAD_ERROR", message: "Download failed" });
  } finally {
    downloadInProgress = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "DOWNLOAD_MEDIA") {
    downloadMedia(message.payload || {});
    sendResponse({ ok: true });
    return true;
  }
});
