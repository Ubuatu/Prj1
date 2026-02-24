const state = {
  backStack: [],
  forwardStack: [],
  current: ''
};

const view = document.getElementById('view');
const urlInput = document.getElementById('urlInput');
const historyList = document.getElementById('historyList');
const settingsDialog = document.getElementById('settingsDialog');

function normalize(input) {
  const val = input.trim();
  if (!val) return '';
  return /^https?:\/\//i.test(val) ? val : `https://${val}`;
}

function openUrl(rawUrl, push = true) {
  const target = normalize(rawUrl);
  if (!target) return;

  if (push && state.current) state.backStack.push(state.current);
  if (push) state.forwardStack = [];
  state.current = target;

  urlInput.value = target;
  view.src = `/proxy?url=${encodeURIComponent(target)}`;
  refreshButtons();
  loadHistory();
}

function refreshButtons() {
  document.getElementById('backBtn').disabled = state.backStack.length === 0;
  document.getElementById('forwardBtn').disabled = state.forwardStack.length === 0;
}

async function loadHistory() {
  const items = await fetch('/api/history').then(r => r.json());
  historyList.innerHTML = '';
  for (const item of items.slice(0, 50)) {
    const li = document.createElement('li');
    li.textContent = `${new Date(item.visitedAt).toLocaleString()} — ${item.url}`;
    li.onclick = () => openUrl(item.url, true);
    historyList.appendChild(li);
  }
}

async function loadSettings() {
  const settings = await fetch('/api/settings').then(r => r.json());
  document.getElementById('dnsServer').value = settings.dnsServer;
  document.getElementById('adBlockEnabled').checked = settings.adBlockEnabled;
}

document.getElementById('goBtn').onclick = () => openUrl(urlInput.value, true);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') openUrl(urlInput.value, true);
});

document.getElementById('backBtn').onclick = () => {
  if (!state.backStack.length) return;
  state.forwardStack.push(state.current);
  const prev = state.backStack.pop();
  openUrl(prev, false);
};

document.getElementById('forwardBtn').onclick = () => {
  if (!state.forwardStack.length) return;
  state.backStack.push(state.current);
  const next = state.forwardStack.pop();
  openUrl(next, false);
};

document.getElementById('settingsBtn').onclick = async () => {
  await loadSettings();
  settingsDialog.showModal();
};

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dnsServer: document.getElementById('dnsServer').value,
      adBlockEnabled: document.getElementById('adBlockEnabled').checked
    })
  });
  settingsDialog.close();
});

document.getElementById('clearHistoryBtn').onclick = async () => {
  await fetch('/api/history', { method: 'DELETE' });
  await loadHistory();
};

loadHistory();
openUrl('https://example.com', false);
