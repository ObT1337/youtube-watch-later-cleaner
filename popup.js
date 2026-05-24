// popup.js
'use strict';

let currentTab = null;

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isWatchLaterUrl(url) {
  return url && url.includes('youtube.com') && url.includes('list=WL');
}

function setStatusArea(html) {
  document.getElementById('status-area').innerHTML = html;
}

function getSelectedMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : 'any_watched';
}

function showModeSelector() {
  document.getElementById('mode-selector').style.display = 'flex';
}

function hideModeSelector() {
  document.getElementById('mode-selector').style.display = 'none';
}

function showStartButton(text = 'Start Cleaning') {
  const btn = document.getElementById('start-btn');
  btn.textContent = text;
  btn.style.display = 'block';
  btn.disabled = false;
}

function hideStartButton() {
  const btn = document.getElementById('start-btn');
  btn.style.display = 'none';
}

function showStopButton() {
  const btn = document.getElementById('stop-btn');
  btn.style.display = 'block';
  btn.disabled = false;
  btn.textContent = 'Stop';
}

function hideStopButton() {
  document.getElementById('stop-btn').style.display = 'none';
}

function setButtonBusy(text) {
  const btn = document.getElementById('start-btn');
  btn.textContent = text;
  btn.disabled = true;
}

async function init() {
  currentTab = await getCurrentTab();
  const url = currentTab?.url || '';

  if (!url.includes('youtube.com')) {
    setStatusArea(`<div class="info-msg">Open YouTube first, then navigate to your
      <a href="https://www.youtube.com/playlist?list=WL" target="_blank">Watch Later playlist</a>.</div>`);
    hideStartButton();
    return;
  }

  if (!isWatchLaterUrl(url)) {
    setStatusArea(`<div class="info-msg">
      Go to your <a href="https://www.youtube.com/playlist?list=WL" target="_blank">Watch Later playlist</a>
      and reopen this popup.
    </div>`);
    hideStartButton();
    return;
  }

  // Try to ping the content script
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(currentTab.id, { action: 'ping' });
  } catch (_) {
    // Content script not active — happens when YouTube navigated via SPA (no full
    // page reload) or when the extension was just installed on an already-open tab.
    // Inject the script programmatically.
    try {
      // Reset the guard flag in the MAIN frame only (avoid sandboxed iframes)
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id, allFrames: false },
        func: () => { window.__ytWlCleanerLoaded = false; },
      });
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id, allFrames: false },
        files: ['content.js'],
      });
      // Give the script a moment to register its message listener
      await new Promise((r) => setTimeout(r, 600));
      response = await chrome.tabs.sendMessage(currentTab.id, { action: 'ping' });
    } catch (_2) {
      setStatusArea(`<div class="error-msg">Script could not be loaded. Please reload the YouTube page (F5) and reopen this popup.</div>`);
      return;
    }
  }

  if (response?.alive) {
    setStatusArea(`<div class="info-msg">Select a mode and click Start.</div>`);
    showModeSelector();
    showStartButton();
  }
}

// Receive live progress updates from the content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'progress') {
    const countHtml = message.count > 0
      ? `<div class="count-msg">Removed so far: ${message.count}</div>`
      : '';
    setStatusArea(`<div class="progress-msg">${message.status}</div>${countHtml}`);
  } else if (message.action === 'done') {
    const text = message.count > 0
      ? `Done! Removed ${message.count} watched video${message.count !== 1 ? 's' : ''}.`
      : 'Done! No watched videos were found.';
    setStatusArea(`<div class="done-msg">${text}</div>`);
    hideStopButton();
    showModeSelector();
    showStartButton('Clean Again');
  } else if (message.action === 'stopped') {
    const text = `Stopped. Removed ${message.count} video${message.count !== 1 ? 's' : ''}.`;
    setStatusArea(`<div class="done-msg">${text}</div>`);
    hideStopButton();
    showModeSelector();
    showStartButton('Clean Again');
  }
});

document.getElementById('start-btn').addEventListener('click', async () => {
  const mode = getSelectedMode();
  setButtonBusy('Cleaning…');
  setStatusArea(`<div class="progress-msg">Starting…</div>`);
  hideModeSelector();
  showStopButton();

  try {
    // Step 1: Extract ytInitialData + ytcfg from the page's MAIN JavaScript world.
    // Content scripts live in an isolated world and cannot access page globals directly.
    const [{ result: pageData }] = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: false },
      world: 'MAIN',
      func: () => {
        const videoDataMap = {};
        try {
          const data = window.ytInitialData;
          if (data) {
            const tab      = data.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer;
            const section  = tab?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer;
            const contents = section?.contents?.[0]?.playlistVideoListRenderer?.contents;
            if (Array.isArray(contents)) {
              for (const item of contents) {
                const v = item.playlistVideoRenderer;
                if (!v?.videoId) continue;
                let percent = 0;
                for (const overlay of (v.thumbnailOverlays || [])) {
                  const r = overlay.thumbnailOverlayResumePlaybackRenderer;
                  if (r && typeof r.percentDurationWatched === 'number') {
                    percent = r.percentDurationWatched;
                    break;
                  }
                }
                videoDataMap[v.videoId] = { setVideoId: v.setVideoId || null, percent };
              }
            }
          }
        } catch (_) {}
        const cfg = window.ytcfg?.data_ || {};
        return {
          videoDataMap,
          ytcfg: {
            INNERTUBE_API_KEY:        cfg.INNERTUBE_API_KEY        || '',
            INNERTUBE_CLIENT_NAME:    cfg.INNERTUBE_CLIENT_NAME    || 'WEB',
            INNERTUBE_CLIENT_VERSION: cfg.INNERTUBE_CLIENT_VERSION || '2.20240101.00.00',
            HL: cfg.HL || 'en',
            GL: cfg.GL || 'US',
          },
        };
      },
    });

    // Step 2: Inject a persistent fetch interceptor into the MAIN world so that
    // lazy-loaded continuation pages also yield setVideoId for every video.
    // It fires a CustomEvent the isolated-world content script can hear.
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: false },
      world: 'MAIN',
      func: () => {
        if (window.__ytWlFetchIntercepted) return;
        window.__ytWlFetchIntercepted = true;
        const origFetch = window.fetch;
        window.fetch = async function (...args) {
          const response = await origFetch.apply(this, args);
          try {
            const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';
            if (url.includes('/youtubei/v1/browse') && !url.includes('edit_playlist')) {
              response.clone().json().then((data) => {
                const items = [];
                for (const action of (data.onResponseReceivedActions || [])) {
                  const continuationItems =
                    action.appendContinuationItemsAction?.continuationItems || [];
                  for (const item of continuationItems) {
                    const v = item.playlistVideoRenderer;
                    if (!v?.videoId) continue;
                    let percent = 0;
                    for (const overlay of (v.thumbnailOverlays || [])) {
                      const r = overlay.thumbnailOverlayResumePlaybackRenderer;
                      if (r && typeof r.percentDurationWatched === 'number') {
                        percent = r.percentDurationWatched;
                        break;
                      }
                    }
                    items.push({ videoId: v.videoId, setVideoId: v.setVideoId || null, percent });
                  }
                }
                if (items.length > 0) {
                  document.dispatchEvent(new CustomEvent('__ytWlNewData', { detail: { items } }));
                }
              }).catch(() => {});
            }
          } catch (_) {}
          return response;
        };
      },
    });

    await chrome.tabs.sendMessage(currentTab.id, {
      action: 'start',
      mode,
      videoDataMap: pageData?.videoDataMap || {},
      ytcfg:        pageData?.ytcfg        || {},
    });
  } catch (err) {
    console.error('[WL Cleaner Popup] start error:', err);
    setStatusArea(`<div class="error-msg">Could not reach the page. Try refreshing YouTube and reopening this popup.</div>`);
    hideStopButton();
    showModeSelector();
    showStartButton();
  }
});

document.getElementById('stop-btn').addEventListener('click', async () => {
  const btn = document.getElementById('stop-btn');
  btn.disabled = true;
  btn.textContent = 'Stopping…';
  try {
    await chrome.tabs.sendMessage(currentTab.id, { action: 'stop' });
  } catch {
    // Ignore — content script may already be done
  }
});

// Highlight the selected mode-option card when a radio changes
document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    document.querySelectorAll('.mode-option').forEach((opt) =>
      opt.classList.remove('selected')
    );
    radio.closest('.mode-option').classList.add('selected');
  });
});

// Hide the selector until we know we're on the Watch Later page
hideModeSelector();
hideStartButton();
hideStopButton();

init();
