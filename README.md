# FB Media Scraper

Facebook-only media scraper extension. It auto-scrolls a Facebook page, collects media links, and downloads selected images in resumable ZIP batches.

## Features
- Auto-scroll scraping for images and videos
- Export scraped results as JSON or TXT
- 1-based, inclusive image ranges (e.g. 246–700)
- Optional automatic download of resolved image batches
- Persistent image checkpoints in IndexedDB: resume interrupted batches or save a partial ZIP
- ZIP downloads with no per-image save prompts
- Timestamped folder layout inside the ZIP

## Supported Sites
This extension only  runs on Facebook domains:
- https://facebook.com/*
- https://*.facebook.com/*
- https://fb.watch/*

If you want all-web support, update `manifest.json` to match more sites and grant host permissions accordingly.

## Install (Chrome)
1. Open Chrome and go to `chrome://extensions`.
2. Enable Developer mode (top right).
3. Click "Load unpacked" and select this folder.
4. Pin the extension for quick access.

## How It Works
1. The content script scans the page as it auto-scrolls and collects image and video links.
2. The background service worker resolves Facebook video pages into direct video URLs.
3. All media is fetched and packaged into a ZIP file.
4. The ZIP is downloaded once, so you only see a single save prompt (or none).

## Usage
1. Open a Facebook page with media (posts, reels, watch pages, etc.).
2. Click the extension icon.
3. Click "Start" to begin scraping (auto-scrolls the page).
4. Click "Stop" when you are done.
5. Click "Download Media" to build and download the ZIP.

## Image ranges and interruption recovery

1. Set **Image From #** and optionally **Image To #** in the popup. The range is **1-based and inclusive**: 246–700 skips the first 245 image links and selects at most 455 images. Leave **To** blank to include everything from **From** onward.
2. Click **Start**. The extension first collects Facebook image-page links in insertion order, and then resolves only entries inside the range. With **Auto-download resolved batches** checked (the default), it downloads each ready batch. Uncheck it to download individual batches manually.
3. **Download Media Files** is a separate flow: it applies the same range to the *collected direct-image URL list* and downloads it in resumable batches. Since the two link lists can differ, don't use both flows for the same content unless you want duplicate ZIPs.
4. Every successfully fetched image is persisted to the extension's IndexedDB **before** ZIP creation. If the connection, Chrome or the background worker stops, reopen the popup. Use **Download / Resume Batch** to fetch only missing images.
5. Use **Save partial ZIP (N images)** to create an archive from the successfully fetched images, without waiting for the rest. After repeated fetch failures the extension also tries to download a partial ZIP automatically; checkpoints remain available for retry.
6. Only after Chrome confirms a full ZIP download does the extension mark the batch complete and delete its saved Blobs. Checkpoints for unfinished batches remain available in the same Chrome profile.

Images retain their original selected link numbers in filenames. Facebook changes, removed images, duplicate links, and URL resolution failures can produce fewer files than the numerical range suggests. Ranges use link discovery order, not photo upload date or a Facebook gallery's numbering.

**Limits:** Chrome storage can be removed if you delete extension data, uninstall the extension, run in a temporary profile, or Chrome evicts data. Checkpoints need free disk space and are not an external backup. The current ZIP size limit is 500 MB. Video downloads do **not** yet have resumable checkpoints. Browser service-worker restarts can interrupt automatic processing; manually resume the saved batches.

## ZIP Layout
The downloaded file is named like:
```
fb_media_YYYYMMDD_HHMMSS.zip
```

Inside the ZIP:
```
images/
  page_name_246.jpg
  page_name_247.jpg
videos/
  video_0001.mp4
  video_0002.mp4
```

## Export JSON or TXT
Use the popup buttons to export the scraped list:
- JSON includes page URL, timestamp, and full lists
- TXT includes a readable list of image and video links

## Optional CLI Downloader (Python)
If you prefer downloading from exported JSON/TXT:

### Requirements
- Python 3.8+

### Usage
```
python download_media.py --input facebook_media.json --out fb_media_downloads
```
Optional cookies (for logged-in access):
```
python download_media.py --input facebook_media.json --cookies cookies.txt
```

## Settings
- Max scrolls: how many auto-scroll steps to run
- Idle limit: stop when no new content loads
- Delay: wait time between scrolls
- Image From / To: choose which image links to download (To blank = all remaining)
- Auto-download resolved batches: start ZIPs automatically as batches become ready
- Include images/videos
- Exclude thumbnails and small images

## Permissions
- `downloads`: save the ZIP file to your device
- `tabs` and `scripting`: open and analyze video pages
- `activeTab`: access the current Facebook tab
- `storage`: save options

## Limitations
- Facebook can change their HTML; some videos may fail to resolve.
- Large ZIPs can fail due to memory limits. If it fails, scrape fewer items.
- Chrome extensions cannot auto-extract ZIP files. You must extract it yourself.

## Troubleshooting
- If videos are skipped, try again after the page fully loads.
- Some videos require login or are restricted.
- Make sure the Facebook tab is active when you click "Start".
- If ZIP creation fails, reduce the number of media items.

## Development checks

Node.js 18+ can run the dependency-free regression tests:

```powershell
node --test tests/image_range.test.js tests/resumable_batch.test.js
```

The tests cover inclusive range boundaries and a simulated interruption at image 230 followed by ZIP recovery. For full validation, test a real Facebook page and Chrome native messaging on your authorized Windows machine.

## Disclaimer
This tool is for personal use only. Make sure you comply with Facebook terms of service and local laws.

## License
MIT
