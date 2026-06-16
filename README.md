# FB Media Scraper

Facebook-only media scraper extension. It auto-scrolls a Facebook page, collects image and video links, then downloads everything as a single ZIP  file.

## Features
- Auto-scroll scraping for images and videos
- Export scraped results as JSON or TXT
- Single ZIP download (no per-file save prompts)
- Timestamped folder layout inside the ZIP

## Supported Sites
This extension only runs on Facebook domains:
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

## ZIP Layout
The downloaded file is named like:
```
fb_media_YYYYMMDD_HHMMSS.zip
```

Inside the ZIP:
```
images/
  image_0001.jpg
  image_0002.jpg
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

## Disclaimer
This tool is for personal use only. Make sure you comply with Facebook terms of service and local laws.

## License
MIT
