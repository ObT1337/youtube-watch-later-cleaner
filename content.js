// content.js — YouTube Watch Later Cleaner
(function () {
  'use strict';

  // Guard: prevent running multiple instances if the script is injected more than once
  if (window.__ytWlCleanerLoaded) return;
  window.__ytWlCleanerLoaded = true;

  let isRunning = false;
  let stopRequested = false;

  // Shared state — populated when 'start' is received and kept up-to-date
  // by the fetch interceptor (MAIN world → CustomEvent → isolated world).
  let videoDataMap = new Map(); // videoId → { setVideoId, percent }
  let innertubeConfig = {};

  // Merge items arriving from the MAIN-world fetch interceptor.
  document.addEventListener('__ytWlNewData', (e) => {
    const items = e.detail?.items;
    if (!Array.isArray(items)) return;
    for (const { videoId, setVideoId, percent } of items) {
      if (!videoDataMap.has(videoId)) {
        videoDataMap.set(videoId, { setVideoId: setVideoId || null, percent: percent || 0 });
      }
    }
    console.log(`[WL Cleaner] map updated via continuation → ${videoDataMap.size} total`);
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Returns true if the video has the "Watched" badge (fully watched).
   */
  function isFullyWatched(videoEl) {
    const statusOverlay = videoEl.querySelector(
      'ytd-thumbnail-overlay-playback-status-renderer'
    );
    if (statusOverlay) {
      // overlay-style attribute is more stable than textContent
      if (statusOverlay.getAttribute('overlay-style') === 'WATCHED') return true;
      if (statusOverlay.textContent.toLowerCase().includes('watch')) return true;
    }
    // Fallback: progress bar at or near 100 %
    const progress = videoEl.querySelector('#progress');
    if (progress) {
      const w = parseFloat(progress.style?.width || '0');
      if (w >= 95) return true;
    }
    return false;
  }

  /**
   * Returns true if the video has any watch progress — partial or fully watched.
   */
  function isAnyWatched(videoEl) {
    if (videoEl.querySelector('ytd-thumbnail-overlay-resume-playback-renderer')) {
      return true;
    }
    const progress = videoEl.querySelector('#progress');
    if (progress) {
      const w = parseFloat(progress.style?.width || '0');
      if (w > 0) return true;
    }
    // aria-label on the thumbnail sometimes encodes watch time
    const thumbnail = videoEl.querySelector('ytd-thumbnail, a#thumbnail');
    if (thumbnail) {
      const label = (thumbnail.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('watched') || label.includes('angeschaut')) return true;
    }
    return isFullyWatched(videoEl);
  }

  /**
   * Returns the right DOM filter function for the chosen mode (used as fallback
   * for videos not found in ytInitialData).
   */
  function getDomFilter(mode) {
    if (mode === 'all')           return () => true;
    if (mode === 'fully_watched') return isFullyWatched;
    return isAnyWatched;
  }

  // parseInitialData() removed — ytInitialData is inaccessible from the isolated
  // world. Data is now extracted in the MAIN world by popup.js and passed via message.

  function videoMatchesMode(data, mode) {
    if (mode === 'all')           return true;
    if (mode === 'fully_watched') return data.percent >= 95;
    return data.percent > 0; // any_watched
  }

  // ─── API-based removal (primary) ──────────────────────────────────────────

  /**
   * Computes the SAPISID hash YouTube requires for authenticated API calls.
   * Chrome sends session cookies automatically (credentials:'include'), but
   * YouTube also wants this header for CSRF protection.
   */
  async function getSapisidhash() {
    const now = Math.floor(Date.now() / 1000);
    // YouTube may use any of these cookie names depending on the account/region
    for (const name of ['__Secure-3PAPISID', '__Secure-1PAPISID', 'SAPISID']) {
      const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
      if (!m) continue;
      const msg = `${now} ${m[1]} https://www.youtube.com`;
      const buf  = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(msg));
      const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      return `SAPISIDHASH ${now}_${hash}`;
    }
    return null;
  }

  /**
   * Calls YouTube's internal browse/edit_playlist endpoint to remove the video.
   * This is the same call the YouTube web app makes when a user clicks
   * "Remove from Watch Later" — fully reliable, no UI interaction needed.
   */
  async function removeViaApi(setVideoId) {
    if (!setVideoId) return false;

    // Use innertubeConfig extracted from the MAIN world by popup.js.
    const cfg  = innertubeConfig;
    const key  = cfg.INNERTUBE_API_KEY;
    const url  = `/youtubei/v1/browse/edit_playlist?prettyPrint=false${key ? `&key=${key}` : ''}`;
    const auth = await getSapisidhash();

    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers['Authorization'] = auth;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          context: {
            client: {
              clientName:    cfg.INNERTUBE_CLIENT_NAME    || 'WEB',
              clientVersion: cfg.INNERTUBE_CLIENT_VERSION || '2.20240101.00.00',
              hl:            cfg.HL || 'en',
              gl:            cfg.GL || 'US',
            },
          },
          actions:    [{ action: 'ACTION_REMOVE_VIDEO', setVideoId }],
          playlistId: 'WL',
        }),
      });

      if (resp.status === 401 || resp.status === 403) {
        console.warn('[WL Cleaner] API auth error:', resp.status, '— session expired or not logged in');
        return false;
      }
      if (!resp.ok) {
        console.warn('[WL Cleaner] API HTTP error:', resp.status);
        return false;
      }
      const data = await resp.json();
      const ok = data.status === 'STATUS_SUCCEEDED';
      if (!ok) console.warn('[WL Cleaner] API unexpected status:', data.status, JSON.stringify(data).slice(0, 200));
      else console.log('[WL Cleaner] API remove ✓', setVideoId);
      return ok;
    } catch (e) {
      console.warn('[WL Cleaner] API call failed:', e);
      return false;
    }
  }

  /**
   * Fallback: open the three-dot menu and click "Remove from Watch Later".
   * Used for videos that have no setVideoId in ytInitialData.
   * Returns true only when the DOM element actually disappears (verified).
   */
  async function removeViaUI(videoEl) {
    videoEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(500);

    ['mouseenter', 'mouseover', 'mousemove'].forEach((type) =>
      videoEl.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true }))
    );
    await sleep(400);

    const menuRenderer = videoEl.querySelector('ytd-menu-renderer');
    if (!menuRenderer) return false;

    const menuBtn =
      menuRenderer.querySelector('yt-icon-button button') ||
      menuRenderer.querySelector('button.yt-icon-button') ||
      menuRenderer.querySelector('button[aria-label]') ||
      menuRenderer.querySelector('button');
    if (!menuBtn) return false;

    menuBtn.click();

    // Poll until the popup has rendered its items (up to 2 s)
    let popup = null;
    for (let i = 0; i < 8; i++) {
      await sleep(250);
      popup = document.querySelector('ytd-menu-popup-renderer');
      if (popup && popup.querySelector('ytd-menu-service-item-renderer, tp-yt-paper-item')) break;
    }

    if (!popup) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }

    const items = popup.querySelectorAll('ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer');
    for (const item of items) {
      const text      = (item.textContent || '').toLowerCase();
      const ariaLabel = (item.getAttribute('aria-label') || '').toLowerCase();
      // Match English "Remove", German "Entfernen", or Polymer data-key attribute
      const isRemove  = text.includes('remove') ||
                        text.includes('entfernen') ||
                        ariaLabel.includes('remove') ||
                        ariaLabel.includes('entfernen') ||
                        !!item.querySelector('[data-key*="remove"]');
      if (isRemove) {
        // Click the inner tp-yt-paper-item so Polymer's tap handler fires properly
        const target = item.querySelector('tp-yt-paper-item') || item;
        target.click();

        // Confirm the DOM element is actually removed (up to 3 s)
        for (let i = 0; i < 10; i++) {
          await sleep(300);
          if (!document.body.contains(videoEl)) return true;
        }
        // Still in DOM → the click didn't work
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return false;
      }
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    return false;
  }

  // ─── Main cleaning loop ───────────────────────────────────────────────────

  /**
   * Iterates over all visible videos in the Watch Later playlist, removes each
   * watched one, then scrolls to load more until none remain.
   *
   * @param {(status: string, count: number) => void} onStatus  Progress callback.
   * @param {(count: number) => void}                 onDone    Completion callback.
   */
  async function cleanWatchLater(onStatus, onDone, mode = 'any_watched') {
    if (isRunning) { onStatus('Already running…', 0); return; }
    isRunning = true;
    stopRequested = false;

    const domFilter = getDomFilter(mode);

    let totalRemoved = 0;
    const failedVideos = new WeakSet();
    let idleScrolls = 0;
    const MAX_IDLE_SCROLLS = 6;

    try {
      while (idleScrolls < MAX_IDLE_SCROLLS) {
        if (stopRequested) break;

        const allVideos = Array.from(document.querySelectorAll('ytd-playlist-video-renderer'));

        const targets = allVideos.filter((videoEl) => {
          if (failedVideos.has(videoEl)) return false;
          if (mode === 'all') return true;

          const id = getVideoId(videoEl);
          if (id && videoDataMap.has(id)) {
            return videoMatchesMode(videoDataMap.get(id), mode);
          }
          // Not in initial data → DOM fallback
          return domFilter(videoEl);
        });

        console.log(`[WL Cleaner] ${allVideos.length} rows in DOM, ${targets.length} match mode="${mode}"`);

        if (targets.length === 0) {
          const prevH = document.documentElement.scrollHeight;
          window.scrollTo(0, prevH);
          await sleep(1800);
          if (document.documentElement.scrollHeight === prevH) {
            idleScrolls++;
          } else {
            idleScrolls = 0; // fetch interceptor handles new data via CustomEvent
          }
          continue;
        }

        idleScrolls = 0;
        const videoEl = targets[0];
        const id      = getVideoId(videoEl);
        const data    = id ? videoDataMap.get(id) : null;

        const fullTitle = videoEl.querySelector('#video-title')?.textContent?.trim() || 'Unknown';
        const title = fullTitle.length > 50 ? fullTitle.slice(0, 47) + '…' : fullTitle;
        onStatus(`Removing: "${title}"`, totalRemoved);

        let removed = false;

        // ── Primary: direct API call (instant, no UI interaction) ──
        if (data?.setVideoId) {
          removed = await removeViaApi(data.setVideoId);
          if (removed) {
            // Give YouTube's reactive DOM time to remove the element
            await sleep(1000);
          }
        }

        // ── Fallback: UI menu interaction ──
        if (!removed) {
          removed = await removeViaUI(videoEl);
        }

        if (removed) {
          totalRemoved++;
          if (id) videoDataMap.delete(id);
          onStatus(`Removed ${totalRemoved} video${totalRemoved !== 1 ? 's' : ''} so far…`, totalRemoved);
        } else {
          failedVideos.add(videoEl);
          onStatus('Skipped one video (could not remove)', totalRemoved);
        }

        await sleep(400);
      }
    } finally {
      isRunning = false;
    }

    onDone(totalRemoved, stopRequested);
  }

  // helper used by both modes
  function getVideoId(videoEl) {
    const link = videoEl.querySelector('a[href*="watch?v="]');
    if (!link) return null;
    const m = (link.getAttribute('href') || '').match(/[?&]v=([^&]+)/);
    return m ? m[1] : null;
  }

  // ─── In-page overlay UI ───────────────────────────────────────────────────

  let overlayEl = null;

  function showOverlay(modeLabel) {
    if (overlayEl) overlayEl.remove();

    overlayEl = document.createElement('div');
    overlayEl.id = '__yt-wl-cleaner-overlay';
    overlayEl.style.cssText = [
      'position:fixed',
      'top:70px',
      'right:20px',
      'background:#212121',
      'color:#fff',
      'padding:14px 16px',
      'border-radius:10px',
      'z-index:2147483647',
      'font-family:Roboto,Arial,sans-serif',
      'font-size:14px',
      'min-width:280px',
      'max-width:360px',
      'box-shadow:0 4px 24px rgba(0,0,0,.6)',
      'border:1px solid #444',
    ].join(';');

    overlayEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <span style="font-weight:700;font-size:15px;color:#ff0000;">▶ WL Cleaner</span>
        <div style="display:flex;gap:8px;align-items:center;">
          <button id="__yt-wl-stop"
            style="background:#b00020;border:none;color:#fff;font-size:12px;font-weight:600;padding:3px 10px;border-radius:4px;cursor:pointer;">
            Stop
          </button>
          <button id="__yt-wl-close"
            style="background:none;border:none;color:#aaa;font-size:22px;cursor:pointer;line-height:1;padding:0;">
            &times;
          </button>
        </div>
      </div>
      <div style="font-size:11px;color:#777;margin-bottom:8px;">${modeLabel}</div>
      <div id="__yt-wl-status" style="font-size:13px;color:#ccc;">Starting…</div>
      <div id="__yt-wl-count"  style="font-size:12px;color:#aaa;margin-top:4px;"></div>
    `;

    document.body.appendChild(overlayEl);
    document.getElementById('__yt-wl-close').addEventListener('click', () =>
      overlayEl.remove()
    );
    document.getElementById('__yt-wl-stop').addEventListener('click', () => {
      stopRequested = true;
      document.getElementById('__yt-wl-stop').disabled = true;
      document.getElementById('__yt-wl-stop').textContent = 'Stopping…';
    });
  }

  function updateOverlay(statusText, count, isDone = false) {
    if (!overlayEl || !document.body.contains(overlayEl)) return;
    const statusEl = document.getElementById('__yt-wl-status');
    const countEl = document.getElementById('__yt-wl-count');
    if (statusEl) {
      statusEl.textContent = statusText;
      statusEl.style.color = isDone ? '#4caf50' : '#ccc';
    }
    if (countEl) {
      countEl.textContent = count > 0 ? `Total removed: ${count}` : '';
    }
  }

  // ─── Message listener (popup → content script) ────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'ping') {
      sendResponse({
        alive: true,
        onWatchLater: window.location.href.includes('list=WL'),
      });
      return true;
    }

    if (message.action === 'stop') {
      stopRequested = true;
      sendResponse({ stopping: true });
      return true;
    }

    if (message.action === 'start') {
      const mode = message.mode || 'any_watched';

      // Populate shared state from page-context data extracted in popup.js (MAIN world).
      videoDataMap.clear();
      const rawMap = message.videoDataMap || {};
      for (const [vid, entry] of Object.entries(rawMap)) {
        videoDataMap.set(vid, entry);
      }
      innertubeConfig = message.ytcfg || {};
      console.log(`[WL Cleaner] start: ${videoDataMap.size} videos from page context`, innertubeConfig);

      const modeLabels = {
        all:           'Remove all videos',
        fully_watched: 'Fully watched only',
        any_watched:   'Any watched (partial + full)',
      };
      showOverlay(modeLabels[mode] || mode);
      updateOverlay('Starting…', 0);

      cleanWatchLater(
        (statusText, count) => {
          updateOverlay(statusText, count);
          chrome.runtime.sendMessage({ action: 'progress', status: statusText, count }).catch(() => {});
        },
        (finalCount, wasStopped) => {
          const msg = wasStopped
            ? `Stopped. Removed ${finalCount} video${finalCount !== 1 ? 's' : ''} before stopping.`
            : finalCount > 0
              ? `Done! Removed ${finalCount} video${finalCount !== 1 ? 's' : ''}.`
              : 'Done! No matching videos found.';
          updateOverlay(msg, finalCount, true);
          chrome.runtime.sendMessage({
            action: wasStopped ? 'stopped' : 'done',
            count: finalCount,
          }).catch(() => {});
        },
        mode
      );

      sendResponse({ started: true });
      return true;
    }
  });
})();
