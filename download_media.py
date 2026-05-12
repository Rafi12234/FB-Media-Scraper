#!/usr/bin/env python3
"""
Download Facebook media from direct links (or resolve video page links) into one folder.

Usage:
  python download_media.py --input facebook_media.json --out fb_media_downloads
  python download_media.py --input facebook_media.json --cookies cookies.txt
"""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime
from typing import List, Optional, Tuple
from urllib.parse import urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener
from http.cookiejar import MozillaCookieJar

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

DOWNLOADABLE_VIDEO_EXTENSIONS = (".mp4", ".m4v", ".webm", ".mov")
IMAGE_EXTENSIONS = (
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
    ".pjp",
)


def decode_escapes(value: str) -> str:
    if not value:
        return value
    return (
        value.replace("\\u0025", "%")
        .replace("\\u0026", "&")
        .replace("\\u003D", "=")
        .replace("\\u002F", "/")
        .replace("\\/", "/")
    )


def get_extension(url: str, fallback: str) -> str:
    try:
        path = urlparse(url).path
        dot = path.rfind(".")
        if dot != -1 and dot < len(path) - 1:
            return path[dot:].lower()
    except Exception:
        pass
    return fallback


def is_direct_video(url: str) -> bool:
    lower = url.lower()
    return any(lower.endswith(ext) for ext in DOWNLOADABLE_VIDEO_EXTENSIONS)


def is_direct_image(url: str) -> bool:
    lower = url.lower()
    return any(lower.endswith(ext) for ext in IMAGE_EXTENSIONS)


def load_urls(input_path: str) -> Tuple[List[str], List[str]]:
    if input_path.lower().endswith(".json"):
        with open(input_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        images = data.get("images") or []
        videos = data.get("videos") or []
        return list(dict.fromkeys(images)), list(dict.fromkeys(videos))

    images: List[str] = []
    videos: List[str] = []
    with open(input_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if is_direct_image(line):
                images.append(line)
            else:
                videos.append(line)
    return list(dict.fromkeys(images)), list(dict.fromkeys(videos))


def build_session(cookie_path: Optional[str]) -> object:
    cj = MozillaCookieJar()
    if cookie_path:
        try:
            cj.load(cookie_path, ignore_discard=True, ignore_expires=True)
        except Exception as exc:
            raise RuntimeError(f"Failed to load cookies: {exc}")
    opener = build_opener(HTTPCookieProcessor(cj))
    opener.addheaders = [("User-Agent", USER_AGENT), ("Referer", "https://www.facebook.com/")]
    return opener


def download_file(opener, url: str, dest_path: str) -> None:
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    req = Request(url, headers={"User-Agent": USER_AGENT, "Referer": "https://www.facebook.com/"})
    with opener.open(req) as response, open(dest_path, "wb") as out:
        while True:
            chunk = response.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)


def extract_direct_videos_from_html(html_text: str) -> List[str]:
    patterns = [
        r'"playable_url_quality_hd"\s*:\s*"(.*?)"',
        r'"playable_url"\s*:\s*"(.*?)"',
        r'property=\\"og:video(?:\:url)?\\"\s+content=\\"(.*?)\\"',
        r'property=\\"og:video(?:\:url)?\\"\s+content=\"(.*?)\"',
    ]
    found: List[str] = []
    for pattern in patterns:
        for match in re.findall(pattern, html_text):
            decoded = decode_escapes(match)
            if is_direct_video(decoded):
                found.append(decoded)

    for match in re.findall(r"https?:\\/\\/[^\"\s]+", html_text):
        decoded = decode_escapes(match)
        if is_direct_video(decoded):
            found.append(decoded)

    # dedupe
    unique: List[str] = []
    for url in found:
        if url not in unique:
            unique.append(url)
    return unique


def resolve_video_url(opener, page_url: str) -> Optional[str]:
    if is_direct_video(page_url):
        return page_url
    req = Request(page_url, headers={"User-Agent": USER_AGENT, "Referer": "https://www.facebook.com/"})
    try:
        with opener.open(req) as response:
            html_text = response.read().decode("utf-8", errors="ignore")
    except Exception:
        return None
    direct = extract_direct_videos_from_html(html_text)
    return direct[0] if direct else None


def main() -> None:
    parser = argparse.ArgumentParser(description="Download Facebook media from direct links.")
    parser.add_argument("--input", required=True, help="Path to JSON/TXT exported from the extension")
    parser.add_argument("--out", default="fb_media_downloads", help="Output folder")
    parser.add_argument("--cookies", help="Optional cookies.txt (Netscape format) for logged-in access")
    args = parser.parse_args()

    images, videos = load_urls(args.input)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    root = os.path.join(args.out, f"fb_media_{timestamp}")
    image_dir = os.path.join(root, "images")
    video_dir = os.path.join(root, "videos")

    try:
        opener = build_session(args.cookies)
    except Exception as exc:
        print(f"Failed to initialize cookies: {exc}")
        raise SystemExit(1)

    if images:
        print(f"Downloading {len(images)} images...")
        for index, url in enumerate(images, 1):
            ext = get_extension(url, ".jpg")
            dest = os.path.join(image_dir, f"image_{index:04d}{ext}")
            try:
                download_file(opener, url, dest)
            except Exception as exc:
                print(f"  (skip image) {exc}")

    if videos:
        print(f"Resolving {len(videos)} video links...")
        resolved: List[str] = []
        for url in videos:
            direct = resolve_video_url(opener, url)
            if not direct:
                print(f"  (skip video) {url}")
                continue
            if direct not in resolved:
                resolved.append(direct)

        print(f"Downloading {len(resolved)} videos...")
        for index, url in enumerate(resolved, 1):
            ext = get_extension(url, ".mp4")
            dest = os.path.join(video_dir, f"video_{index:04d}{ext}")
            try:
                download_file(opener, url, dest)
            except Exception as exc:
                print(f"  (skip video download) {exc}")

    print(f"Done. Saved to: {root}")


if __name__ == "__main__":
    main()
