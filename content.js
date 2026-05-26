(function () {
  if (window.__slackerInjected) return;
  window.__slackerInjected = true;

  let source = null;            // 從彈窗存進來的「預設影片」
  let lastYTVideo = null;       // 跨分頁共享：最近一次在 YouTube 上看的影片
  let currentPlaySource = null; // 當前 PiP 真正播放的影片
  let opacity = 1;
  let triggerVisible = false;
  let triggerPos = null;
  let pipWindow = null;

  // YouTube 桌面版 header 高度，向上位移 iframe 把它切掉
  const YT_HEADER_OFFSET = 56;

  // chrome.* 在擴充功能重新載入後會失效；包成防呆版本
  function ctxValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (_) { return false; }
  }
  function safeSet(obj) {
    if (!ctxValid()) return;
    try { chrome.storage.local.set(obj, () => void chrome.runtime.lastError); }
    catch (_) {}
  }
  function safeGet(keys, cb) {
    if (!ctxValid()) { cb({}); return; }
    try { chrome.storage.local.get(keys, (r) => cb(r || {})); }
    catch (_) { cb({}); }
  }

  // PiP 標準 icon：外框矩形 + 右下角小矩形
  const PIP_ICON_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">'
    + '<rect x="1" y="2.5" width="14" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>'
    + '<rect x="9" y="8" width="5" height="3.5" rx="0.5" fill="currentColor"/>'
    + '</svg>';

  // ---- floating launcher button ----
  const root = document.createElement('div');
  root.id = 'slacker-root';
  root.innerHTML = `<button id="slacker-trigger" type="button" title="開啟畫中畫" aria-label="開啟畫中畫">${PIP_ICON_SVG}</button>`;
  document.documentElement.appendChild(root);
  const trigger = root.querySelector('#slacker-trigger');

  function buildPlayUrl(s) {
    if (s.type === 'playlist') {
      return 'https://www.youtube.com/playlist?list=' + encodeURIComponent(s.id);
    }
    return 'https://www.youtube.com/watch?v=' + encodeURIComponent(s.id) + '&autoplay=1';
  }

  function buildWatchUrl(s) {
    if (s.type === 'playlist') {
      return 'https://www.youtube.com/playlist?list=' + encodeURIComponent(s.id);
    }
    return 'https://www.youtube.com/watch?v=' + encodeURIComponent(s.id);
  }

  // 從當前頁面 URL 自動抓 YouTube 影片
  function getCurrentPageVideo() {
    try {
      const u = window.location;
      const host = u.hostname;
      if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) return null;

      if (/youtu\.be$/.test(host)) {
        const id = u.pathname.replace(/^\//, '').split(/[/?#]/)[0];
        return /^[a-zA-Z0-9_-]{11}$/.test(id) ? { type: 'video', id } : null;
      }

      const params = new URLSearchParams(u.search);
      const v = params.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return { type: 'video', id: v };

      const m = u.pathname.match(/^\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
      if (m) return { type: 'video', id: m[2] };

      const list = params.get('list');
      if (list) return { type: 'playlist', id: list };

      return null;
    } catch (_) {
      return null;
    }
  }

  // 在 YouTube 頁面時把當前影片寫進 storage，讓其他分頁的觸發鈕也能用
  function syncCurrentVideoToStorage() {
    const v = getCurrentPageVideo();
    if (!v) return;
    if (lastYTVideo && lastYTVideo.id === v.id && lastYTVideo.type === v.type) return;
    lastYTVideo = v;
    safeSet({ slackerLastYTVideo: v });
  }

  function applyTriggerStyle() {
    const hasPlayable = !!source || !!getCurrentPageVideo() || !!lastYTVideo;
    if (!triggerVisible || !hasPlayable) {
      trigger.style.display = 'none';
      return;
    }
    trigger.style.display = 'flex';
    if (triggerPos) {
      trigger.style.left = triggerPos.x + 'px';
      trigger.style.top = triggerPos.y + 'px';
      trigger.style.right = 'auto';
      trigger.style.bottom = 'auto';
    } else {
      trigger.style.left = 'auto';
      trigger.style.top = 'auto';
      trigger.style.right = '16px';
      trigger.style.bottom = '16px';
    }
  }

  function updateTriggerTitle() {
    const isOpen = !!(pipWindow && !pipWindow.closed);
    trigger.title = isOpen ? '關閉畫中畫' : '開啟畫中畫';
    trigger.classList.toggle('is-open', isOpen);
  }

  async function togglePip() {
    // 已開啟 → 關閉（老闆鍵）
    if (pipWindow && !pipWindow.closed) {
      try { pipWindow.close(); } catch (_) {}
      pipWindow = null;
      updateTriggerTitle();
      return;
    }

    // 優先順序：1) 當前頁面正在看的 YouTube 影片
    //         2) 任何 YouTube 分頁最近一次看的影片
    //         3) 彈窗設定的預設值
    currentPlaySource = getCurrentPageVideo() || lastYTVideo || source;

    if (!currentPlaySource) {
      alert('還沒設定影片。\n請開啟一個 YouTube 影片分頁，或在擴充功能彈窗貼上 YouTube 網址。');
      return;
    }
    if (!('documentPictureInPicture' in window)) {
      if (!window.isSecureContext) {
        alert(
          '此頁面不是安全環境，瀏覽器不允許在此開啟畫中畫。\n\n'
          + '目前頁面：' + location.origin + '\n'
          + '（HTTP / 內網 IP / file:// 都不算安全環境）\n\n'
          + '請切到任何 HTTPS 分頁（例如 youtube.com、github.com）再點觸發鈕，\n'
          + '影片會自動同步過去。'
        );
      } else {
        alert('您的瀏覽器不支援 Document Picture-in-Picture API\n請更新 Chrome 到 116 或以上版本。');
      }
      return;
    }

    try {
      pipWindow = await documentPictureInPicture.requestWindow({
        width: 480,
        height: 290
      });
    } catch (e) {
      alert('無法開啟畫中畫：' + (e && e.message ? e.message : e));
      return;
    }

    buildPipContent(pipWindow);
    updateTriggerTitle();

    pipWindow.addEventListener('pagehide', () => {
      pipWindow = null;
      updateTriggerTitle();
    });
  }

  function buildPipContent(win) {
    const doc = win.document;
    doc.documentElement.style.cssText = 'margin:0;padding:0;height:100%;';
    doc.body.style.cssText = 'margin:0;padding:0;height:100vh;background:#000;overflow:hidden;font-family:-apple-system,"Segoe UI","Microsoft JhengHei",sans-serif;color:#fff;';

    const style = doc.createElement('style');
    style.textContent = `
      .wrap {
        position: absolute; inset: 0;
        overflow: hidden; background: #000;
      }
      #slacker-iframe {
        position: absolute; left: 0;
        top: -${YT_HEADER_OFFSET}px;
        width: 100%;
        height: calc(100% + ${YT_HEADER_OFFSET}px);
        border: 0; display: block;
        background: #000;
        transition: opacity 0.08s linear;
      }
      #slacker-overlay {
        position: fixed; top: 0; left: 0; right: 0;
        padding: 4px 8px;
        display: flex; align-items: center; gap: 6px;
        background: linear-gradient(rgba(0,0,0,0.72), rgba(0,0,0,0));
        color: rgba(255,255,255,0.9);
        font-size: 11px; line-height: 1;
        transition: opacity 0.25s ease;
        z-index: 1000;
      }
      #slacker-overlay.hidden { opacity: 0; pointer-events: none; }
      #slacker-overlay input[type=range] {
        flex: 1; max-width: 200px; min-width: 60px; height: 3px;
        accent-color: rgba(255,255,255,0.8); cursor: pointer;
      }
      #slacker-overlay #opv {
        min-width: 32px; text-align: right;
        font-variant-numeric: tabular-nums; opacity: 0.7;
      }
      #slacker-overlay button {
        background: transparent;
        border: none;
        color: rgba(255,255,255,0.7);
        cursor: pointer;
        padding: 2px 6px; border-radius: 2px;
        font-size: 12px; font-family: inherit;
      }
      #slacker-overlay button:hover {
        background: rgba(255,255,255,0.12);
        color: #fff;
      }
    `;
    doc.head.appendChild(style);

    const wrap = doc.createElement('div');
    wrap.className = 'wrap';
    doc.body.appendChild(wrap);

    const iframe = doc.createElement('iframe');
    iframe.id = 'slacker-iframe';
    iframe.src = buildPlayUrl(currentPlaySource);
    iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    iframe.setAttribute('scrolling', 'no');
    iframe.style.opacity = opacity;
    wrap.appendChild(iframe);

    const overlay = doc.createElement('div');
    overlay.id = 'slacker-overlay';
    const opPct = Math.round(opacity * 100);
    overlay.innerHTML = `
      <input type="range" id="op" min="15" max="100" value="${opPct}" title="透明度">
      <span id="opv">${opPct}%</span>
      <button id="openyt" title="在 YouTube 新分頁開啟">↗</button>
      <button id="hide" title="立即關閉（老闆鍵 Esc 也可）">✕</button>
    `;
    doc.body.appendChild(overlay);

    const slider = overlay.querySelector('#op');
    const opVal = overlay.querySelector('#opv');
    slider.addEventListener('input', () => {
      opacity = slider.value / 100;
      iframe.style.opacity = opacity;
      opVal.textContent = slider.value + '%';
      safeSet({ slackerOpacity: opacity });
    });

    overlay.querySelector('#openyt').addEventListener('click', () => {
      try { window.open(buildWatchUrl(currentPlaySource), '_blank', 'noopener,noreferrer'); }
      catch (_) {}
    });

    overlay.querySelector('#hide').addEventListener('click', () => {
      try { win.close(); } catch (_) {}
    });

    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        try { win.close(); } catch (_) {}
      }
    });

    let hideTimer;
    const showOverlay = () => {
      overlay.classList.remove('hidden');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => overlay.classList.add('hidden'), 1800);
    };
    doc.addEventListener('mousemove', showOverlay);
    doc.addEventListener('pointerdown', showOverlay);
    doc.addEventListener('keydown', showOverlay);
    win.addEventListener('focus', showOverlay);
    showOverlay();
  }

  // ---- trigger drag ----
  let dragMoved = false;
  trigger.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragMoved = false;
    const startX = e.clientX, startY = e.clientY;
    const rect = trigger.getBoundingClientRect();
    const offX = startX - rect.left;
    const offY = startY - rect.top;
    try { trigger.setPointerCapture(e.pointerId); } catch (_) {}

    const move = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragMoved = true;
      if (!dragMoved) return;
      const x = Math.max(0, Math.min(window.innerWidth - rect.width, ev.clientX - offX));
      const y = Math.max(0, Math.min(window.innerHeight - rect.height, ev.clientY - offY));
      triggerPos = { x, y };
      applyTriggerStyle();
    };
    const up = () => {
      try { trigger.releasePointerCapture(e.pointerId); } catch (_) {}
      trigger.removeEventListener('pointermove', move);
      trigger.removeEventListener('pointerup', up);
      trigger.removeEventListener('pointercancel', up);
      if (dragMoved) safeSet({ slackerTriggerPos: triggerPos });
    };
    trigger.addEventListener('pointermove', move);
    trigger.addEventListener('pointerup', up);
    trigger.addEventListener('pointercancel', up);
  });

  trigger.addEventListener('click', (e) => {
    if (dragMoved) { e.preventDefault(); e.stopPropagation(); return; }
    togglePip();
  });

  // ---- state load + sync ----
  safeGet(
    ['slackerSource', 'slackerOpacity', 'slackerTriggerVisible', 'slackerTriggerPos', 'slackerLastYTVideo'],
    (r) => {
      source = r.slackerSource || null;
      lastYTVideo = r.slackerLastYTVideo || null;
      if (typeof r.slackerOpacity === 'number') opacity = r.slackerOpacity;
      triggerVisible = r.slackerTriggerVisible !== false;
      triggerPos = r.slackerTriggerPos || null;
      // 如果這個分頁本身就是 YouTube 影片頁，立刻寫進 storage
      syncCurrentVideoToStorage();
      applyTriggerStyle();
    }
  );

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.slackerSource) source = changes.slackerSource.newValue || null;
      if (changes.slackerLastYTVideo) lastYTVideo = changes.slackerLastYTVideo.newValue || null;
      if (changes.slackerOpacity && typeof changes.slackerOpacity.newValue === 'number') {
        opacity = changes.slackerOpacity.newValue;
      }
      if (changes.slackerTriggerVisible) triggerVisible = !!changes.slackerTriggerVisible.newValue;
      if (changes.slackerTriggerPos) triggerPos = changes.slackerTriggerPos.newValue || null;
      if (changes.slackerSource || changes.slackerLastYTVideo || changes.slackerTriggerVisible || changes.slackerTriggerPos) {
        applyTriggerStyle();
      }
    });
  } catch (_) {}

  // YouTube 內部用 pushState 切影片時觸發 yt-navigate-finish 事件；
  // 一般網頁則靠 popstate / hashchange，再加一道輪詢兜底
  let lastHref = location.href;
  function onUrlChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    syncCurrentVideoToStorage();
    applyTriggerStyle();
  }
  window.addEventListener('yt-navigate-finish', onUrlChange);
  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('hashchange', onUrlChange);
  setInterval(onUrlChange, 1500);

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'slacker:pulse') {
        triggerVisible = true;
        applyTriggerStyle();
        trigger.classList.add('pulse');
        setTimeout(() => trigger.classList.remove('pulse'), 1500);
      } else if (msg.type === 'slacker:hideTrigger') {
        triggerVisible = false;
        applyTriggerStyle();
      }
    });
  } catch (_) {}
})();
