const defaultOptions = {
  maxScrolls: 200,
  idleLimit: 5,
  delayMs: 1200,
  includeImages: true,
  includeVideos: true,
  excludeThumbs: true,
  excludeSmall: true
};

const statusEl = document.getElementById("status");
const imageCountEl = document.getElementById("imageCount");
const videoCountEl = document.getElementById("videoCount");

const fields = {
  maxScrolls: document.getElementById("maxScrolls"),
  idleLimit: document.getElementById("idleLimit"),
  delayMs: document.getElementById("delayMs"),
  includeImages: document.getElementById("includeImages"),
  includeVideos: document.getElementById("includeVideos"),
  excludeThumbs: document.getElementById("excludeThumbs"),
  excludeSmall: document.getElementById("excludeSmall")
};

function setStatus(text) {
  statusEl.textContent = text;
}

function updateCounts(images, videos) {
  imageCountEl.textContent = String(images || 0);
  videoCountEl.textContent = String(videos || 0);
}

function readOptions() {
  return {
    maxScrolls: Number(fields.maxScrolls.value) || defaultOptions.maxScrolls,
    idleLimit: Number(fields.idleLimit.value) || defaultOptions.idleLimit,
    delayMs: Number(fields.delayMs.value) || defaultOptions.delayMs,
    includeImages: fields.includeImages.checked,
    includeVideos: fields.includeVideos.checked,
    excludeThumbs: fields.excludeThumbs.checked,
    excludeSmall: fields.excludeSmall.checked
  };
}

function applyOptions(options) {
  fields.maxScrolls.value = options.maxScrolls;
  fields.idleLimit.value = options.idleLimit;
  fields.delayMs.value = options.delayMs;
  fields.includeImages.checked = options.includeImages;
  fields.includeVideos.checked = options.includeVideos;
  fields.excludeThumbs.checked = options.excludeThumbs;
  fields.excludeSmall.checked = options.excludeSmall;
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] || null);
    });
  });
}

function sendToActiveTab(message) {
  return getActiveTab().then((tab) => {
    if (!tab || !tab.id) {
      throw new Error("No active tab found");
    }
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(response || {});
      });
    });
  });
}

function saveOptions(options) {
  chrome.storage.local.set({ options });
}

function loadOptions() {
  chrome.storage.local.get(["options"], (result) => {
    const options = Object.assign({}, defaultOptions, result.options || {});
    applyOptions(options);
  });
}

function downloadFile(fileName, content, mime) {
  const dataUrl = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  chrome.downloads.download({ url: dataUrl, filename: fileName, saveAs: true });
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

document.getElementById("startBtn").addEventListener("click", async () => {
  const options = readOptions();
  saveOptions(options);
  try {
    await sendToActiveTab({ type: "START", options });
    setStatus("Running");
  } catch (err) {
    setStatus("Open a Facebook page tab");
  }
});

document.getElementById("stopBtn").addEventListener("click", async () => {
  try {
    await sendToActiveTab({ type: "STOP" });
    setStatus("Stopped");
  } catch (err) {
    setStatus("Open a Facebook page tab");
  }
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  try {
    await sendToActiveTab({ type: "RESET" });
    updateCounts(0, 0);
    setStatus("Idle");
  } catch (err) {
    setStatus("Open a Facebook page tab");
  }
});

document.getElementById("downloadJson").addEventListener("click", async () => {
  try {
    const data = await sendToActiveTab({ type: "GET_RESULTS" });
    const timestamp = formatTimestamp(new Date());
    downloadFile(`facebook_media_${timestamp}.json`, JSON.stringify(data, null, 2), "application/json");
  } catch (err) {
    setStatus("Open a Facebook page tab");
  }
});

document.getElementById("downloadTxt").addEventListener("click", async () => {
  try {
    const data = await sendToActiveTab({ type: "GET_RESULTS" });
    const lines = [];
    lines.push(`Source URL : ${data.pageUrl || ""}`);
    lines.push(`Images     : ${data.images.length}`);
    lines.push(`Videos     : ${data.videos.length}`);
    lines.push("");
    lines.push("IMAGES");
    lines.push("----------------------------------------");
    data.images.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`);
    });
    lines.push("");
    lines.push("VIDEOS");
    lines.push("----------------------------------------");
    data.videos.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`);
    });
    const timestamp = formatTimestamp(new Date());
    downloadFile(`facebook_media_${timestamp}.txt`, lines.join("\n"), "text/plain");
  } catch (err) {
    setStatus("Open a Facebook page tab");
  }
});

document.getElementById("copyJson").addEventListener("click", async () => {
  try {
    const data = await sendToActiveTab({ type: "GET_RESULTS" });
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setStatus("Copied JSON to clipboard");
  } catch (err) {
    setStatus("Open a Facebook page tab");
  }
});

document.getElementById("downloadMedia").addEventListener("click", async () => {
  try {
    const data = await sendToActiveTab({ type: "GET_RESULTS" });
    const options = readOptions();
    const timestamp = formatTimestamp(new Date());
    const payload = {
      pageUrl: data.pageUrl || "",
      timestamp,
      options,
      images: options.includeImages ? data.images : [],
      videos: options.includeVideos ? data.videos : []
    };

    chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", payload }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        setStatus("Failed to start downloads");
        return;
      }
      if (!response || !response.ok) {
        setStatus(response && response.message ? response.message : "Download already running");
        return;
      }
      setStatus("Downloading media...");
    });
  } catch (err) {
    setStatus("Open a Facebook page tab");
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SCRAPE_PROGRESS") {
    updateCounts(message.images, message.videos);
    setStatus(message.running ? "Running" : "Idle");
  }

  if (message.type === "DOWNLOAD_PROGRESS") {
    if (message.stage === "resolve") {
      setStatus(`Resolving videos ${message.current}/${message.total}`);
    } else if (message.stage === "download") {
      setStatus(`Downloading media ${message.current}/${message.total}`);
    } else if (message.stage === "zip") {
      setStatus(`Creating zip ${message.current}%`);
    }
  }

  if (message.type === "DOWNLOAD_DONE") {
    const skipped = message.skippedVideos || 0;
    const invalid = message.invalidVideos || 0;
    const saved = message.saved || 0;
    const zipName = message.zipName || "zip";
    const suffix = `Saved ${saved} files to ${zipName}`;
    if (skipped > 0 || invalid > 0) {
      setStatus(`Done (skipped ${skipped}, invalid ${invalid}). ${suffix}`);
    } else {
      setStatus(`Done. ${suffix}`);
    }
  }

  if (message.type === "DOWNLOAD_ERROR") {
    setStatus(message.message || "Download failed");
  }
});

loadOptions();
sendToActiveTab({ type: "GET_STATUS" })
  .then((data) => {
    updateCounts(data.images, data.videos);
    setStatus(data.running ? "Running" : "Idle");
  })
  .catch(() => {
    setStatus("Open a Facebook page tab");
  });
