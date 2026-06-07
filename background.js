let downloadInProgress = false;
let imageResolveInProgress = false;
let imageResolveCancel = false;
let batchDownloadInProgress = false;
const imageResolveSessions = new Map();
const activeBatchDownloads = new Set();


// =========================
// Basic MAC Device Lock
// =========================
// This extension can only run on devices whose MAC address exists in this list.
// Current allowed device MAC from your getmac output: D8-43-AE-14-32-81
const DEVICE_HOST_NAME = "com.fb_media_scraper.device_check";
const ALLOWED_MAC_ADDRESSES = [
  "D8:43:AE:14:32:81"
];
const DEVICE_CHECK_CACHE_MS = 5 * 60 * 1000;

let deviceAccessCache = {
  checkedAt: 0,
  allowed: false,
  macs: [],
  error: ""
};

function normalizeMacAddress(mac) {
  return String(mac || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, ":");
}

function isAllowedDeviceMac(macs) {
  const allowedSet = new Set(ALLOWED_MAC_ADDRESSES.map(normalizeMacAddress));
  return (Array.isArray(macs) ? macs : []).some((mac) => allowedSet.has(normalizeMacAddress(mac)));
}

function checkDeviceAccess(force = false) {
  return new Promise((resolve) => {
    const now = Date.now();

    if (
      !force &&
      deviceAccessCache.checkedAt &&
      now - deviceAccessCache.checkedAt < DEVICE_CHECK_CACHE_MS
    ) {
      resolve(deviceAccessCache);
      return;
    }

    if (!chrome.runtime || typeof chrome.runtime.sendNativeMessage !== "function") {
      deviceAccessCache = {
        checkedAt: Date.now(),
        allowed: false,
        macs: [],
        error: "Native messaging is not available. Check manifest permission."
      };
      resolve(deviceAccessCache);
      return;
    }

    chrome.runtime.sendNativeMessage(
      DEVICE_HOST_NAME,
      { type: "GET_MACS" },
      (response) => {
        const err = chrome.runtime.lastError;

        if (err || !response || response.ok === false) {
          deviceAccessCache = {
            checkedAt: Date.now(),
            allowed: false,
            macs: [],
            error: err ? err.message : response && response.error ? response.error : "Device check failed"
          };
          resolve(deviceAccessCache);
          return;
        }

        const macs = Array.isArray(response.macs) ? response.macs : [];
        const allowed = isAllowedDeviceMac(macs);

        deviceAccessCache = {
          checkedAt: Date.now(),
          allowed,
          macs,
          error: allowed ? "" : "Unauthorized device"
        };
        resolve(deviceAccessCache);
      }
    );
  });
}

function sendUnauthorizedResponse(sendResponse, error) {
  sendResponse({
    ok: false,
    allowed: false,
    message: error || "Unauthorized device. This extension is locked to approved devices only."
  });
}

function saveSessions() {
  const sessionsData = {};
  imageResolveSessions.forEach((session, key) => {
    sessionsData[key] = {
      sessionId: session.sessionId,
      pageTitle: session.pageTitle,
      imageBaseName: session.imageBaseName,
      timestamp: session.timestamp,
      batchTotal: session.batchTotal,
      batches: Array.from(session.batches.entries()),
      batchCandidates: Array.from(session.batchCandidates.entries()),
      downloadedBatches: Array.from(session.downloadedBatches)
    };
  });
  chrome.storage.local.set({ imageResolveSessions: sessionsData });
}

function loadSessions() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['imageResolveSessions'], (result) => {
      const sessionsData = result.imageResolveSessions || {};
      Object.keys(sessionsData).forEach((key) => {
        const data = sessionsData[key];
        imageResolveSessions.set(key, {
          sessionId: data.sessionId,
          pageTitle: data.pageTitle,
          imageBaseName: data.imageBaseName,
          timestamp: data.timestamp,
          batchTotal: data.batchTotal,
          batches: new Map(data.batches || []),
          batchCandidates: new Map(data.batchCandidates || []),
          downloadedBatches: new Set(data.downloadedBatches || [])
        });
      });
      resolve();
    });
  });
}

loadSessions();

const VIDEO_FALLBACK_EXTENSION = ".mp4";
const DOWNLOAD_DELAY_MS = 800;
const TAB_LOAD_TIMEOUT_MS = 30000;
const IMAGE_PAGE_DELAY_MS = 1200;
const IMAGE_BATCH_SIZE = 300;
const VIDEO_CONTENT_PREFIX = "video/";
const DOWNLOADABLE_VIDEO_EXTENSIONS = [".mp4", ".m4v", ".webm", ".mov"];
const ZIP_MIME = "application/zip";
const MAX_ZIP_BYTES = 500 * 1024 * 1024;

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

async function buildZip(entries, onProgress) {
  const encoder = new TextEncoder();
  const fileParts = [];
  const centralParts = [];
  const centralRecords = [];
  let offset = 0;
  const totalFiles = entries.length;
  let processedFiles = 0;

  const reportProgress = () => {
    if (typeof onProgress !== "function") return;
    onProgress({ current: processedFiles, total: totalFiles });
  };

  reportProgress();

  for (const entry of entries) {
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const nameBytes = encoder.encode(entry.name);
    const checksum = crc32(data);
    const localHeader = buildLocalHeader(nameBytes.length, data.length, checksum);

    fileParts.push(localHeader, nameBytes, data);
    centralRecords.push({ nameBytes, checksum, size: data.length, offset });
    offset += localHeader.length + nameBytes.length + data.length;
    processedFiles += 1;
    reportProgress();
  }

  let centralSize = 0;
  centralRecords.forEach((record) => {
    const centralHeader = buildCentralHeader(record.nameBytes.length, record.size, record.checksum, record.offset);
    centralParts.push(centralHeader, record.nameBytes);
    centralSize += centralHeader.length + record.nameBytes.length;
  });

  const endHeader = buildEndHeader(centralRecords.length, centralSize, offset);
  processedFiles = totalFiles;
  reportProgress();
  return new Blob([...fileParts, ...centralParts, endHeader], { type: ZIP_MIME });
}

function sendProgress(message) {
  chrome.runtime.sendMessage(message);
}

async function createAndDownloadZip(entries, zipName, progressInfo) {
  if (!entries.length) return { saved: 0, bytes: 0 };

  const zipProgress = Object.assign({}, progressInfo || {});
  sendProgress({ type: "DOWNLOAD_PROGRESS", stage: "zip", current: 0, total: entries.length, ...zipProgress });

  let zipBlob;
  try {
    zipBlob = await buildZip(entries, (progress) => {
      sendProgress({
        type: "DOWNLOAD_PROGRESS",
        stage: "zip",
        current: progress.current || 0,
        total: progress.total || entries.length,
        ...zipProgress
      });
    });
  } catch (err) {
    sendProgress({
      type: "DOWNLOAD_ERROR",
      message: `Zip build failed: ${err && err.message ? err.message : "Unknown error"}`
    });
    return null;
  }

  sendProgress({ type: "DOWNLOAD_PROGRESS", stage: "zip", current: entries.length, total: entries.length, ...zipProgress });

  if (zipBlob.size > MAX_ZIP_BYTES) {
    sendProgress({
      type: "DOWNLOAD_ERROR",
      message: `Zip too large (${Math.round(zipBlob.size / (1024 * 1024))} MB). Reduce selection or disable zip mode.`
    });
    return null;
  }

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
    return null;
  }

  try {
    await downloadFile(zipUrl, zipName);
  } catch (err) {
    sendProgress({
      type: "DOWNLOAD_ERROR",
      message: `Zip download failed: ${err && err.message ? err.message : "Unknown error"}`
    });
    return null;
  } finally {
    if (revokeUrl) {
      setTimeout(() => URL.revokeObjectURL(zipUrl), 60000);
    }
  }

  return { saved: entries.length, bytes: zipBlob.size };
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

function sanitizeBaseName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const ascii = raw.normalize("NFKD").replace(/[^\x20-\x7E]/g, "");
  const cleaned = ascii.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned) return "";
  return cleaned.slice(0, 60);
}

function chunkArray(items, size) {
  const list = Array.isArray(items) ? items : [];
  if (size <= 0) return [list];
  const result = [];
  for (let i = 0; i < list.length; i += size) {
    result.push(list.slice(i, i + size));
  }
  return result;
}

function buildImageZipName(folder, batchIndex, batchTotal) {
  if (batchTotal <= 1) return `${folder}.zip`;
  return `${folder}_part${String(batchIndex).padStart(2, "0")}.zip`;
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

async function extractBestImageFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const IMAGE_EXTENSIONS = [
          ".jpg",
          ".jpeg",
          ".png",
          ".gif",
          ".webp",
          ".bmp",
          ".avif",
          ".heic",
          ".heif",
          ".tif",
          ".tiff",
          ".jfif",
          ".pjpeg",
          ".pjp"
        ];

        const normalizeUrl = (raw) => {
          if (!raw) return "";
          const trimmed = String(raw).trim().replace(/^['"]|['"]$/g, "");
          if (!trimmed) return "";
          const lower = trimmed.toLowerCase();
          if (lower.startsWith("data:") || lower.startsWith("blob:") || lower.startsWith("javascript:")) {
            return "";
          }
          try {
            return new URL(trimmed, window.location.href).toString();
          } catch (err) {
            return "";
          }
        };

        const urlHasExtension = (url, extensions) => {
          try {
            const path = new URL(url).pathname.toLowerCase();
            return extensions.some((ext) => path.endsWith(ext));
          } catch (err) {
            return false;
          }
        };

        const isCandidateUrl = (url) => {
          if (!url) return false;
          const lower = url.toLowerCase();
          if (!lower.includes("fbcdn.net") && !lower.includes("scontent.") && !lower.includes("fbsbx.com")) {
            return false;
          }
          if (lower.includes("static.xx.fbcdn.net") || lower.includes("rsrc.php")) return false;
          if (lower.includes("emoji")) return false;
          if (!urlHasExtension(url, IMAGE_EXTENSIONS)) return false;
          return true;
        };

        const pickLargestFromSrcset = (value) => {
          if (!value) return "";
          const entries = value.split(",");
          let bestUrl = "";
          let bestScore = 0;
          entries.forEach((entry) => {
            const parts = entry.trim().split(/\s+/);
            const url = normalizeUrl(parts[0]);
            if (!url) return;
            const descriptor = parts[1] || "";
            let score = 0;
            if (descriptor.endsWith("w")) {
              score = parseInt(descriptor, 10) || 0;
            } else if (descriptor.endsWith("x")) {
              score = Math.round((parseFloat(descriptor) || 0) * 1000);
            }
            if (score >= bestScore) {
              bestScore = score;
              bestUrl = url;
            }
          });
          return bestUrl;
        };

        const ogImages = [];
        [
          'meta[property="og:image"]',
          'meta[property="og:image:secure_url"]',
          'meta[name="twitter:image"]',
          'link[rel="image_src"]'
        ].forEach((selector) => {
          document.querySelectorAll(selector).forEach((node) => {
            const raw = node.getAttribute("content") || node.getAttribute("href") || "";
            const url = normalizeUrl(raw);
            if (isCandidateUrl(url)) {
              ogImages.push(url);
            }
          });
        });

        const candidates = new Set(ogImages);
        let bestUrl = "";
        let bestArea = 0;

        document.querySelectorAll("img").forEach((img) => {
          const direct = normalizeUrl(img.currentSrc || img.getAttribute("src"));
          if (isCandidateUrl(direct)) {
            const width = img.naturalWidth || img.width || 0;
            const height = img.naturalHeight || img.height || 0;
            const area = width * height;
            if (area >= bestArea) {
              bestArea = area;
              bestUrl = direct;
            }
            candidates.add(direct);
          }

          const srcset = img.getAttribute("srcset") || "";
          const largest = pickLargestFromSrcset(srcset);
          if (isCandidateUrl(largest)) {
            candidates.add(largest);
          }
        });

        if (!bestUrl) {
          bestUrl = ogImages[0] || Array.from(candidates)[0] || "";
        }

        return { bestUrl, candidates: Array.from(candidates), ogImages };
      }
    });

    const entry = Array.isArray(results) ? results[0] : null;
    return entry && entry.result ? entry.result : { bestUrl: "", candidates: [], ogImages: [] };
  } catch (err) {
    return { bestUrl: "", candidates: [], ogImages: [] };
  }
}

async function resolveImageInTab(url) {
  if (!url) return "";
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  if (!tabId) return "";

  try {
    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    await sleep(IMAGE_PAGE_DELAY_MS);
    let data = await extractBestImageFromTab(tabId);
    if (!data.bestUrl) {
      await sleep(IMAGE_PAGE_DELAY_MS);
      data = await extractBestImageFromTab(tabId);
    }
    return data.bestUrl || "";
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch (err) {
      // ignore
    }
  }
}

async function resolveImagesSequential(urls, context) {
  const resolved = new Set();
  let skipped = 0;
  const list = Array.isArray(urls) ? urls : [];
  const batchSize = IMAGE_BATCH_SIZE;
  const batchTotal = batchSize > 0 ? Math.ceil(list.length / batchSize) : 0;
  const tabId = context && context.tabId ? context.tabId : null;
  const sessionId = context && context.sessionId ? context.sessionId : "";

  let batchIndex = 1;
  let batchProcessed = 0;
  let batchResolved = [];

  for (let index = 0; index < list.length; index += 1) {
    if (imageResolveCancel) break;
    batchProcessed += 1;
    const batchSizeTotal = Math.min(batchSize, list.length - (batchIndex - 1) * batchSize);
    sendProgress({
      type: "IMAGE_RESOLVE_PROGRESS",
      current: index + 1,
      total: list.length,
      batchIndex,
      batchTotal,
      batchCurrent: batchProcessed,
      batchSize: batchSizeTotal
    });

    const bestUrl = await resolveImageInTab(list[index]);
    if (bestUrl) {
      resolved.add(bestUrl);
      batchResolved.push(bestUrl);
    } else {
      skipped += 1;
    }

    const isBatchEnd = batchProcessed >= batchSize || index === list.length - 1;
    if (isBatchEnd) {
      const resolvedBatch = batchResolved.slice();
      const candidateCount = batchProcessed;

      let session = null;
      if (sessionId) {
        session = imageResolveSessions.get(sessionId);
        if (session) {
          session.batches.set(batchIndex, resolvedBatch);
          session.batchCandidates.set(batchIndex, candidateCount);
        }
      }

      if (tabId && resolvedBatch.length > 0) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            type: "IMAGE_RESOLVE_BATCH",
            sessionId,
            batchIndex,
            batchTotal,
            images: resolvedBatch
          });
        } catch (err) {
          // ignore
        }
      }

      saveSessions();

      sendProgress({
        type: "IMAGE_BATCH_READY",
        sessionId,
        batchIndex,
        batchTotal,
        resolvedCount: resolvedBatch.length,
        candidateCount,
        pageTitle: session ? session.pageTitle : "",
        imageBaseName: session ? session.imageBaseName : "",
        timestamp: session ? session.timestamp : ""
      });

      batchIndex += 1;
      batchProcessed = 0;
      batchResolved = [];
    }
  }

  sendProgress({
    type: "IMAGE_RESOLVE_PROGRESS",
    current: list.length,
    total: list.length,
    done: true,
    batchIndex: batchTotal,
    batchTotal,
    batchCurrent: 0,
    batchSize
  });

  return { images: Array.from(resolved), skipped };
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
    const pageTitle = sanitizeBaseName(payload.pageTitle || "");
    const imageBaseName = pageTitle || "image";
    const imageBatches = chunkArray(images, IMAGE_BATCH_SIZE);
    const totalImageBatches = imageBatches.length;
    const zipNames = [];
    let totalSaved = 0;
    let totalBytes = 0;

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

    if (images.length > 0) {
      let imageIndex = 1;
      for (let batchIndex = 0; batchIndex < imageBatches.length; batchIndex += 1) {
        const batchImages = imageBatches[batchIndex];
        const entries = [];
        let processed = 0;

        for (const url of batchImages) {
          const ext = getExtension(url, ".jpg");
          const entryName = `images/${imageBaseName}_${imageIndex}${ext}`;
          imageIndex += 1;
          processed += 1;
          try {
            const blob = await fetchAsBlob(url);
            totalBytes += blob.size;
            entries.push({ name: entryName, blob });
          } catch (err) {
            invalidVideos += 1;
          }
          sendProgress({
            type: "DOWNLOAD_PROGRESS",
            stage: "download",
            current: processed,
            total: batchImages.length,
            batchIndex: batchIndex + 1,
            batchTotal: totalImageBatches,
            batchType: "images"
          });
          await sleep(100);
        }

        const zipName = buildImageZipName(folder, batchIndex + 1, totalImageBatches);
        const result = await createAndDownloadZip(entries, zipName, {
          batchIndex: batchIndex + 1,
          batchTotal: totalImageBatches,
          batchType: "images"
        });
        if (result === null) {
          return;
        }
        zipNames.push(zipName);
        totalSaved += result.saved;
      }
    }

    if (resolvedVideos.length > 0) {
      const entries = [];
      let processed = 0;
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
        sendProgress({
          type: "DOWNLOAD_PROGRESS",
          stage: "download",
          current: processed,
          total: resolvedVideos.length,
          batchIndex: 1,
          batchTotal: 1,
          batchType: "videos"
        });
        await sleep(DOWNLOAD_DELAY_MS);
      }

      const zipName = `${folder}_videos.zip`;
      const result = await createAndDownloadZip(entries, zipName, {
        batchIndex: 1,
        batchTotal: 1,
        batchType: "videos"
      });
      if (result === null) {
        return;
      }
      zipNames.push(zipName);
      totalSaved += result.saved;
    }

    if (zipNames.length === 0) {
      sendProgress({
        type: "DOWNLOAD_DONE",
        skippedVideos,
        invalidVideos,
        zipName: `${folder}.zip`,
        saved: 0
      });
      return;
    }

    sendProgress({
      type: "DOWNLOAD_DONE",
      skippedVideos,
      invalidVideos,
      zipName: zipNames[zipNames.length - 1],
      zipNames,
      saved: totalSaved,
      totalBytes
    });
  } catch (err) {
    sendProgress({ type: "DOWNLOAD_ERROR", message: "Download failed" });
  } finally {
    downloadInProgress = false;
  }
}


function handleResolveImagesMessage(message, sender, sendResponse) {
  if (imageResolveInProgress) {
    sendResponse({ ok: false, message: "Image resolve already running" });
    return;
  }

  const sessionId = String(message.sessionId || `${Date.now()}_${Math.floor(Math.random() * 1000000)}`);
  const pageTitle = sanitizeBaseName(message.pageTitle || "");
  const imageBaseName = pageTitle || "image";
  const timestamp = formatTimestamp(new Date());
  const urls = Array.isArray(message.urls) ? message.urls : [];
  const batchTotal = IMAGE_BATCH_SIZE > 0 ? Math.ceil(urls.length / IMAGE_BATCH_SIZE) : 0;

  imageResolveSessions.set(sessionId, {
    sessionId,
    pageTitle,
    imageBaseName,
    timestamp,
    batchTotal,
    batches: new Map(),
    batchCandidates: new Map(),
    downloadedBatches: new Set()
  });

  imageResolveInProgress = true;
  imageResolveCancel = false;
  resolveImagesSequential(urls, { sessionId, tabId: sender && sender.tab ? sender.tab.id : null })
    .then((result) => {
      imageResolveInProgress = false;
      const canceled = imageResolveCancel;
      imageResolveCancel = false;
      sendResponse({ ok: true, images: result.images || [], skipped: result.skipped || 0, canceled });
    })
    .catch(() => {
      imageResolveInProgress = false;
      imageResolveCancel = false;
      sendResponse({ ok: false, images: [], skipped: 0 });
    });
}

function handleDownloadImageBatchMessage(message, sendResponse) {
  const sessionId = String(message.sessionId || "");
  const batchIndex = Number(message.batchIndex) || 0;
  const session = imageResolveSessions.get(sessionId);
  
  if (!session || !batchIndex) {
    sendResponse({ ok: false, message: "Batch not ready" });
    return;
  }

  const batchImages = session.batches.get(batchIndex) || [];
  if (batchImages.length === 0) {
    sendResponse({ ok: false, message: "Batch is empty" });
    return;
  }
  
  const batchKey = `${sessionId}:${batchIndex}`;
  if (activeBatchDownloads.has(batchKey)) {
    sendResponse({ ok: false, message: "This batch is already downloading" });
    return;
  }

  activeBatchDownloads.add(batchKey);
  sendResponse({ ok: true });

  (async () => {
    const entries = [];
    let processed = 0;
    const imageBaseName = session.imageBaseName || "image";
    const startIndex = (batchIndex - 1) * IMAGE_BATCH_SIZE + 1;
    let imageIndex = startIndex;

    for (const url of batchImages) {
      const ext = getExtension(url, ".jpg");
      const entryName = `images/${imageBaseName}_${imageIndex}${ext}`;
      imageIndex += 1;
      processed += 1;
      try {
        const blob = await fetchAsBlob(url);
        entries.push({ name: entryName, blob });
      } catch (err) {
        // ignore failures for this batch
      }
      sendProgress({
        type: "DOWNLOAD_PROGRESS",
        stage: "download",
        current: processed,
        total: batchImages.length,
        batchIndex,
        batchTotal: session.batchTotal || 1,
        batchType: "images"
      });
      await sleep(100);
    }

    const folder = `fb_media_${session.timestamp}`;
    const zipName = buildImageZipName(folder, batchIndex, session.batchTotal || 1);
    const result = await createAndDownloadZip(entries, zipName, {
      batchIndex,
      batchTotal: session.batchTotal || 1,
      batchType: "images"
    });
    if (result === null) {
      activeBatchDownloads.delete(batchKey);
      return;
    }

    session.downloadedBatches.add(batchIndex);
    saveSessions();
    
    sendProgress({
      type: "DOWNLOAD_DONE",
      zipName,
      zipNames: [zipName],
      saved: result.saved,
      sessionId,
      batchIndex,
      batchTotal: session.batchTotal || 1,
      batchType: "images"
    });
  })()
    .catch(() => {
      sendProgress({ type: "DOWNLOAD_ERROR", message: "Batch download failed" });
    })
    .finally(() => {
      activeBatchDownloads.delete(batchKey);
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "CHECK_DEVICE") {
    checkDeviceAccess(true).then((device) => {
      sendResponse({
        ok: true,
        allowed: device.allowed,
        macs: device.macs,
        error: device.error
      });
    });
    return true;
  }

  if (message.type === "RESOLVE_IMAGES") {
    checkDeviceAccess().then((device) => {
      if (!device.allowed) {
        sendUnauthorizedResponse(sendResponse, device.error);
        return;
      }
      handleResolveImagesMessage(message, sender, sendResponse);
    });
    return true;
  }

  if (message.type === "CANCEL_RESOLVE_IMAGES") {
    imageResolveCancel = true;
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "DOWNLOAD_IMAGE_BATCH") {
    checkDeviceAccess().then((device) => {
      if (!device.allowed) {
        sendUnauthorizedResponse(sendResponse, device.error);
        return;
      }
      handleDownloadImageBatchMessage(message, sendResponse);
    });
    return true;
  }

  if (message.type === "DOWNLOAD_MEDIA") {
    checkDeviceAccess().then((device) => {
      if (!device.allowed) {
        sendUnauthorizedResponse(sendResponse, device.error);
        return;
      }
      downloadMedia(message.payload || {});
      sendResponse({ ok: true });
    });
    return true;
  }
});
