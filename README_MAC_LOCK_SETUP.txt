FB Media Scraper - Basic MAC Device Lock Setup

Allowed MAC hardcoded in background.js:
D8:43:AE:14:32:81

Modified extension files:
- manifest.json: added nativeMessaging permission
- background.js: added MAC authorization check through native messaging
- content.js: blocks START / GET_RESULTS / direct video commands if device is unauthorized
- popup.js: disables buttons and checks device before Start / Export / Download

New native helper files:
- native_host/device_check_host.cs
- native_host/setup_native_host.ps1
- native_host/com.fb_media_scraper.device_check.json template
- native_host/register_host.reg template

The setup script compiles device_check_host.cs into device_check_host.exe and registers it as the Chrome Native Messaging host.

Setup steps on Windows:

1. Open Chrome:
   chrome://extensions/

2. Turn on Developer mode.

3. Click "Load unpacked" and select this extension folder:
   fb_media_scraper_mac_locked

4. Copy the extension ID shown by Chrome.

5. Open PowerShell in the native_host folder and run:
   powershell -ExecutionPolicy Bypass -File .\setup_native_host.ps1 -ExtensionId YOUR_EXTENSION_ID

   Replace YOUR_EXTENSION_ID with the actual Chrome extension ID.

6. Go back to chrome://extensions/ and click Reload on FB Media Scraper.

7. Open a Facebook page and open the extension popup.

Expected result:
- If this PC has MAC D8:43:AE:14:32:81, popup shows authorized and buttons work.
- If another PC uses it, popup shows Unauthorized device and scraping/download actions are blocked.

Note:
This is a basic lock. Advanced users can still bypass it by editing extension code or spoofing MAC address.
