# YouTube Watch Later Cleaner

A Chrome extension that automatically removes watched videos from your YouTube **Watch Later** playlist.

## Features

- **Three cleaning modes:**
  - *Angeschaut (alles)* — removes videos with any watch progress (partial or fully watched)
  - *Komplett angeschaut* — removes only videos watched to the end ("Watched" badge)
  - *Alle Videos* — clears the entire Watch Later playlist
- Uses YouTube's internal API for fast, reliable removal (no slow UI clicks)
- Falls back to UI interaction for videos not found in page data
- Live progress overlay on the YouTube page
- Stop button to interrupt at any time
- Works with lazy-loaded continuations (infinite scroll)

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the folder containing `manifest.json`

## Usage

1. Navigate to your [Watch Later playlist](https://www.youtube.com/playlist?list=WL) on YouTube
2. Click the extension icon in the toolbar
3. Select a cleaning mode
4. Click **Start Cleaning**
5. A progress overlay appears on the page — click **Stop** at any time to pause

## Files

| File | Description |
|------|-------------|
| `manifest.json` | Extension configuration (Manifest V3) |
| `content.js` | Core logic — runs on the YouTube page, handles removal |
| `popup.html` | Extension popup UI |
| `popup.js` | Popup logic — extracts page data and communicates with content script |

## Notes

- You must be **logged in** to YouTube for the API-based removal to work
- The extension only activates on `youtube.com` pages
- No data is collected or sent anywhere — everything runs locally in your browser
