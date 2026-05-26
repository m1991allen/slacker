function parseInput(input) {
  input = (input || '').trim();
  if (!input) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return { type: 'video', id: input };
  let m = input.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (m) return { type: 'playlist', id: m[1] };
  m = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m) return { type: 'video', id: m[1] };
  m = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m) return { type: 'video', id: m[1] };
  m = input.match(/embed\/([a-zA-Z0-9_-]{11})/);
  if (m) return { type: 'video', id: m[1] };
  m = input.match(/shorts\/([a-zA-Z0-9_-]{11})/);
  if (m) return { type: 'video', id: m[1] };
  m = input.match(/live\/([a-zA-Z0-9_-]{11})/);
  if (m) return { type: 'video', id: m[1] };
  return null;
}

async function sendToContent(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) await chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  } catch (_) {}
}

document.getElementById('playBtn').addEventListener('click', async () => {
  const input = document.getElementById('urlInput').value;
  const parsed = parseInput(input);
  if (!parsed) { alert('找不到有效的 YouTube 影片 ID 或播放清單'); return; }
  await chrome.storage.local.set({ slackerSource: parsed, slackerTriggerVisible: true });
  await sendToContent({ type: 'slacker:pulse' });
  window.close();
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ slackerTriggerVisible: false });
  await sendToContent({ type: 'slacker:hideTrigger' });
  window.close();
});

chrome.storage.local.get(['slackerSource'], (r) => {
  const s = r.slackerSource;
  if (!s) return;
  const inputEl = document.getElementById('urlInput');
  if (s.type === 'video') inputEl.value = 'https://youtu.be/' + s.id;
  else if (s.type === 'playlist') inputEl.value = 'https://www.youtube.com/playlist?list=' + s.id;
});
