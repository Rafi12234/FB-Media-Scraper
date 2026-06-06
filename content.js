const defaultOptions = {
  maxScrolls: 200,
  idleLimit: 5,
  delayMs: 1200,
  includeImages: true,
  includeVideos: true,
  excludeThumbs: true,
  excludeSmall: true
};

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

const VIDEO_EXTENSIONS = [
  ".mp4",
  ".webm",
  ".ogg",
  ".ogv",
  ".mov",
  ".avi",
  ".mkv",
  ".m3u8",
  ".mpd",
  ".flv",
  ".wmv",
  ".3gp",
  ".ts",
  ".m4v",
  ".f4v"
];

const DOWNLOADABLE_VIDEO_EXTENSIONS = [
  ".mp4",
  ".m4v",
  ".webm",
  ".mov"
];

const SMALL_MARKERS = [
  "s24x24",
  "s32x32",
  "s40x40",
  "s50x50",
  "s60x60",
  "s64x64",
  "s80x80",
  "s100x100",
  "s120x120",
  "s128x128",
  "s160x160",
  "s200x200"
];

const state = {
  running: false,
  resolvingImages: false,
  resolveRequestId: 0,
  resolveSessionId: "",
  scrollCount: 0,
  idleCount: 0,
  lastHeight: 0,
  options: Object.assign({}, defaultOptions),
  images: new Set(),
  imageCandidates: new Set(),
  videos: new Set(),
  videoResolved: new Map()
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(raw) {
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
}

function urlHasExtension(url, extensions) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return extensions.some((ext) => path.endsWith(ext));
  } catch (err) {
    return false;
  }
}

function isSmallImageUrl(url) {
  const lower = url.toLowerCase();
  return SMALL_MARKERS.some((marker) => lower.includes(marker));
}

function isVideoThumbnail(url) {
  const lower = url.toLowerCase();
  if (lower.includes("t15.5256")) return true;
  if (lower.includes("/v/t15.")) return true;
  if (lower.includes("_tt") && lower.includes("stp=dst-jpg")) return true;
  return false;
}

function isLikelyImage(url) {
  if (!state.options.includeImages) return false;
  if (!urlHasExtension(url, IMAGE_EXTENSIONS)) return false;
  const lower = url.toLowerCase();
  if (!lower.includes("fbcdn.net") && !lower.includes("scontent.")) return false;
  if (state.options.excludeThumbs && isVideoThumbnail(url)) return false;
  if (state.options.excludeSmall && isSmallImageUrl(url)) return false;
  if (lower.includes("static.xx.fbcdn.net") || lower.includes("rsrc.php")) return false;
  if (lower.includes("emoji")) return false;
  return true;
}

function isFacebookImagePageUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith("facebook.com")) return false;
    const path = parsed.pathname.toLowerCase();
    const params = parsed.searchParams;
    if (path.includes("photo.php") || path.includes("/photo/") || path.includes("/photos/")) return true;
    if (params.has("fbid") || params.has("photo_id")) return true;
    if ((path.includes("/permalink.php") || path.includes("/story.php") || path.includes("/posts/")) &&
      (params.has("story_fbid") || params.has("id"))) {
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
}

function isImageViewerPage() {
  try {
    const path = window.location.pathname.toLowerCase();
    const params = new URLSearchParams(window.location.search);
    if (path.includes("photo.php") || path.includes("/photo/") || path.includes("/photos/")) return true;
    if (params.has("fbid") || params.has("photo_id")) return true;
    if ((path.includes("/permalink.php") || path.includes("/story.php")) && params.has("story_fbid")) return true;
    return false;
  } catch (err) {
    return false;
  }
}

function isLikelyVideo(url) {
  if (!state.options.includeVideos) return false;
  const lower = url.toLowerCase();
  if (urlHasExtension(url, VIDEO_EXTENSIONS)) return true;
  if (lower.includes("/videos/") || lower.includes("/reel/") || lower.includes("/reels/")) return true;
  if (lower.includes("video.php") || lower.includes("watch/?v=")) return true;
  if (lower.includes("fb.watch")) return true;
  return false;
}

function isDirectVideoFile(url) {
  return urlHasExtension(url, DOWNLOADABLE_VIDEO_EXTENSIONS);
}

function decodeEscapes(value) {
  return String(value || "")
    .replace(/\\u0025/g, "%")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003D/g, "=")
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/");
}

function cleanPageTitle(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/^\(\d+\)\s*/, "");
  text = text.replace(/\s*[\-|•]\s*facebook.*$/i, "");
  text = text.replace(/\s*\(\d+\)\s*$/i, "");
  text = text.replace(/\s+messaged you.*$/i, "");
  text = text.replace(/\s+sent you.*$/i, "");
  text = text.replace(/\s+commented on.*$/i, "");
  text = text.replace(/\s+reacted to.*$/i, "");
  text = text.replace(/\s+liked.*$/i, "");
  text = text.replace(/\s+shared.*$/i, "");
  text = text.replace(/\s+posted.*$/i, "");
  return text.trim();
}

function getPageNameFromUrl() {
  try {
    const parsed = new URL(window.location.href);
    const params = parsed.searchParams;
    const path = parsed.pathname || "/";
    const segments = path.split("/").filter(Boolean).map((seg) => seg.trim()).filter(Boolean);
    const reserved = new Set([
      "photo.php",
      "photos",
      "photo",
      "permalink.php",
      "story.php",
      "posts",
      "reel",
      "reels",
      "videos",
      "watch",
      "watch.php",
      "login",
      "people",
      "marketplace",
      "events",
      "saved",
      "hashtag",
      "groups",
      "pages",
      "profile.php",
      "stories",
      "notifications",
      "messages",
      "messaging"
    ]);

    if (segments[0] === "groups" && segments[1]) {
      return `groups_${segments[1]}`;
    }

    if (segments[0] === "messages" && segments[1] === "t" && segments[2]) {
      return segments[2];
    }

    if (segments[0] === "pages" && segments[1]) {
      return segments[1];
    }

    if (segments[0] === "profile.php") {
      const id = params.get("id");
      if (id) return `profile_${id}`;
    }

    for (const segment of segments) {
      if (reserved.has(segment.toLowerCase())) {
        continue;
      }
      return segment;
    }

    const id = params.get("id") || params.get("story_fbid") || params.get("fbid");
    if (id) return `fb_${id}`;
  } catch (err) {
    return "";
  }
  return "";
}

function getStablePageTitle() {
  const fromUrl = getPageNameFromUrl();
  if (fromUrl) {
    return cleanPageTitle(fromUrl);
  }

  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle && ogTitle.content) {
    const cleaned = cleanPageTitle(ogTitle.content);
    if (cleaned) return cleaned;
  }

  const metaTitle = document.querySelector('meta[name="title"], meta[property="title"]');
  if (metaTitle && metaTitle.content) {
    const cleaned = cleanPageTitle(metaTitle.content);
    if (cleaned) return cleaned;
  }

  const h1 = document.querySelector("h1");
  if (h1 && h1.textContent) {
    const cleaned = cleanPageTitle(h1.textContent);
    if (cleaned) return cleaned;
  }

  const cleanedTitle = cleanPageTitle(document.title || "");
  if (cleanedTitle) return cleanedTitle;

  return "";
}

function extractVideoUrlsFromText(text) {
  const found = new Set();
  const patterns = [
    /"playable_url_quality_hd"\s*:\s*"(.*?)"/g,
    /"playable_url"\s*:\s*"(.*?)"/g,
    /"playable_url_dash"\s*:\s*"(.*?)"/g,
    /property=\\"og:video(?:\:url)?\\"\s+content=\\"(.*?)\\"/g,
    /property=\\"og:video(?:\:url)?\\"\s+content=\"(.*?)\"/g
  ];

  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(text))) {
      const decoded = decodeEscapes(match[1]);
      const url = normalizeUrl(decoded);
      if (url && isDirectVideoFile(url)) {
        found.add(url);
      }
    }
  });

  const rawMatches = text.match(/https?:\/\/[^"\s]+/g) || [];
  rawMatches.forEach((raw) => {
    const url = normalizeUrl(raw);
    if (url && isDirectVideoFile(url)) {
      found.add(url);
    }
  });

  const escapedMatches = text.match(/https?:\\\/\\\/[^"\s]+/g) || [];
  escapedMatches.forEach((raw) => {
    const decoded = decodeEscapes(raw);
    const url = normalizeUrl(decoded);
    if (url && isDirectVideoFile(url)) {
      found.add(url);
    }
  });

  return Array.from(found);
}

async function resolveVideoLink(url) {
  if (isDirectVideoFile(url)) {
    return [url];
  }
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
      return [];
    }
    const text = await response.text();
    return extractVideoUrlsFromText(text);
  } catch (err) {
    return [];
  }
}

async function resolveVideoLinks() {
  const directVideos = new Set();
  let skipped = 0;
  const links = Array.from(state.videos);
  for (const link of links) {
    if (!link) continue;
    if (state.videoResolved.has(link)) {
      const cached = state.videoResolved.get(link) || [];
      if (cached.length === 0 && !isDirectVideoFile(link)) {
        skipped += 1;
      }
      cached.forEach((item) => directVideos.add(item));
      continue;
    }

    if (isDirectVideoFile(link)) {
      state.videoResolved.set(link, [link]);
      directVideos.add(link);
      continue;
    }

    const resolved = await resolveVideoLink(link);
    state.videoResolved.set(link, resolved);
    if (resolved.length === 0) {
      skipped += 1;
    } else {
      resolved.forEach((item) => directVideos.add(item));
    }
  }

  return { directVideos: Array.from(directVideos), skipped };
}

function extractDirectVideosFromDom() {
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
  return extractVideoUrlsFromText(chunks.join("\n"));
}

function addImage(url) {
  if (!url) return;
  if (isLikelyImage(url)) {
    state.images.add(url);
  }
}

function addImageCandidate(url) {
  if (!url) return;
  if (isFacebookImagePageUrl(url)) {
    state.imageCandidates.add(url);
  }
}

function addVideo(url) {
  if (!url) return;
  if (isLikelyVideo(url)) {
    state.videos.add(url);
  }
}

function collectFromSrcset(value) {
  if (!value) return;
  const parts = value.split(",");
  parts.forEach((part) => {
    const token = part.trim().split(/\s+/)[0];
    const url = normalizeUrl(token);
    addImage(url);
    addVideo(url);
  });
}

function collectFromStyle(value, allowImages) {
  if (!value) return;
  const matches = value.match(/url\(([^)]+)\)/gi);
  if (!matches) return;
  matches.forEach((entry) => {
    const inner = entry.replace(/^url\(/i, "").replace(/\)$/i, "");
    const url = normalizeUrl(inner);
    if (allowImages) {
      addImage(url);
    }
    addVideo(url);
  });
}

function collectImageCandidateFromImg(img) {
  if (!img || typeof img.closest !== "function") return;
  const anchor = img.closest("a[href]");
  if (!anchor) return;
  const url = normalizeUrl(anchor.getAttribute("href"));
  addImageCandidate(url);
}

function extractAll() {
  const inImageViewer = isImageViewerPage();

  document.querySelectorAll("img").forEach((img) => {
    if (inImageViewer) {
      ["src", "data-src", "data-lazy-src", "data-original", "data-url", "data-image"].forEach((attr) => {
        addImage(normalizeUrl(img.getAttribute(attr)));
      });
      collectFromSrcset(img.getAttribute("srcset"));
      collectFromSrcset(img.getAttribute("data-srcset"));
    }
    collectImageCandidateFromImg(img);
  });

  document.querySelectorAll("video, source").forEach((node) => {
    addVideo(normalizeUrl(node.getAttribute("src")));
    collectFromSrcset(node.getAttribute("srcset"));
  });

  document.querySelectorAll("a[href]").forEach((anchor) => {
    const url = normalizeUrl(anchor.getAttribute("href"));
    addVideo(url);
    addImage(url);
  });

  document.querySelectorAll("[style]").forEach((node) => {
    const style = node.getAttribute("style") || "";
    if (style.includes("url(")) {
      collectFromStyle(style, inImageViewer);
    }
  });
}

function sendProgress() {
  chrome.runtime.sendMessage({
    type: "SCRAPE_PROGRESS",
    running: state.running,
    resolvingImages: state.resolvingImages,
    imageCandidates: state.imageCandidates.size,
    images: state.images.size,
    videos: state.videos.size
  });
}

function sendResolveImages(urls, requestId, sessionId, pageTitle, pageUrl) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "RESOLVE_IMAGES", urls, requestId, sessionId, pageTitle, pageUrl },
      (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ images: [] });
        return;
      }
      resolve(response || {});
      }
    );
  });
}

function cancelResolveImages() {
  state.resolveRequestId += 1;
  state.resolveSessionId = "";
  state.resolvingImages = false;
  chrome.runtime.sendMessage({ type: "CANCEL_RESOLVE_IMAGES" }, () => {
    // ignore
  });
}



function checkDeviceAccessFromContent() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "CHECK_DEVICE" }, (response) => {
      const err = chrome.runtime.lastError;
      resolve(Boolean(!err && response && response.allowed));
    });
  });
}

function sendUnauthorizedContentResponse(sendResponse) {
  sendResponse({
    ok: false,
    allowed: false,
    message: "Unauthorized device. This extension is locked to approved devices only.",
    pageUrl: window.location.href,
    pageTitle: getStablePageTitle(),
    extractedAt: new Date().toISOString(),
    images: [],
    videos: []
  });
}

async function resolveFullSizeImages() {
  if (!state.options.includeImages) return;
  if (state.resolvingImages) return;
  const candidates = Array.from(state.imageCandidates);
  if (candidates.length === 0) return;

  state.resolvingImages = true;
  sendProgress();

  const requestId = state.resolveRequestId + 1;
  state.resolveRequestId = requestId;
  const sessionId = `${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  state.resolveSessionId = sessionId;
  const pageTitle = getStablePageTitle();
  const pageUrl = window.location.href;

  const response = await sendResolveImages(candidates, requestId, sessionId, pageTitle, pageUrl);
  if (requestId !== state.resolveRequestId) {
    return;
  }

  const resolved = Array.isArray(response.images) ? response.images : [];
  resolved.forEach((url) => addImage(url));

  state.resolvingImages = false;
  sendProgress();
}

async function runScrape() {
  if (state.running) return;
  state.running = true;
  state.scrollCount = 0;
  state.idleCount = 0;
  state.lastHeight = document.documentElement.scrollHeight || document.body.scrollHeight;

  while (state.running) {
    extractAll();
    sendProgress();

    const maxScrolls = Number(state.options.maxScrolls) || 0;
    if (maxScrolls > 0 && state.scrollCount >= maxScrolls) {
      break;
    }

    window.scrollTo(0, document.body.scrollHeight);
    await sleep(state.options.delayMs);

    const newHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
    if (newHeight === state.lastHeight) {
      state.idleCount += 1;
    } else {
      state.idleCount = 0;
      state.lastHeight = newHeight;
    }

    state.scrollCount += 1;
    if (state.idleCount >= state.options.idleLimit) {
      break;
    }
  }

  state.running = false;
  extractAll();
  sendProgress();
  resolveFullSizeImages();
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "START") {
    checkDeviceAccessFromContent().then((allowed) => {
      if (!allowed) {
        sendUnauthorizedContentResponse(sendResponse);
        return;
      }

      state.options = Object.assign({}, defaultOptions, message.options || {});
      cancelResolveImages();
      runScrape();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "STOP") {
    state.running = false;
    cancelResolveImages();
    sendProgress();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "RESET") {
    state.images.clear();
    state.imageCandidates.clear();
    state.videos.clear();
    state.running = false;
    cancelResolveImages();
    sendProgress();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "GET_RESULTS") {
    checkDeviceAccessFromContent().then((allowed) => {
      if (!allowed) {
        sendUnauthorizedContentResponse(sendResponse);
        return;
      }

      sendResponse({
        ok: true,
        pageUrl: window.location.href,
        pageTitle: getStablePageTitle(),
        extractedAt: new Date().toISOString(),
        images: Array.from(state.images),
        videos: Array.from(state.videos)
      });
    });
    return true;
  }

  if (message.type === "PING") {
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "EXTRACT_DIRECT_VIDEOS") {
    checkDeviceAccessFromContent().then((allowed) => {
      if (!allowed) {
        sendResponse({ ok: false, allowed: false, directVideos: [], message: "Unauthorized device" });
        return;
      }
      const directVideos = extractDirectVideosFromDom();
      sendResponse({ ok: true, directVideos });
    });
    return true;
  }

  if (message.type === "RESOLVE_VIDEOS") {
    checkDeviceAccessFromContent().then((allowed) => {
      if (!allowed) {
        sendResponse({ ok: false, allowed: false, directVideos: [], skipped: 0, message: "Unauthorized device" });
        return;
      }
      resolveVideoLinks().then((result) => {
        sendResponse(result);
      });
    });
    return true;
  }

  if (message.type === "IMAGE_RESOLVE_BATCH") {
    if (message.sessionId && message.sessionId !== state.resolveSessionId) {
      return;
    }
    const batchImages = Array.isArray(message.images) ? message.images : [];
    batchImages.forEach((url) => addImage(url));
    sendProgress();
    return;
  }

  if (message.type === "GET_STATUS") {
    sendResponse({
      running: state.running,
      resolvingImages: state.resolvingImages,
      imageCandidates: state.imageCandidates.size,
      images: state.images.size,
      videos: state.videos.size
    });
  }
});
