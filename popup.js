let map, activeMarkers = [];

/** Append a line to the log area */
function appendLog(msg) {
  const log = document.getElementById('log');
  log.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  log.scrollTop = log.scrollHeight;
}

/** Initialize the Leaflet map */
function initMap() {
  if (map) return;
  map = L.map('map').setView([48.9226, 24.7111], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    subdomains: ['a','b','c'],
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  appendLog('🗺️ Map initialized');
}

/** Create an inline-SVG marker and place it */
function addMarker(m) {
  // choose color
  const color = m.status === 'clean' ? '#28a745' : '#dc3545';
  // inline SVG pin (32×32) with white center
  const svg = `
    <svg width="32" height="32" viewBox="0 0 24 24">
      <path fill="${color}" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
      <circle fill="#fff" cx="12" cy="9" r="2.5"/>
    </svg>
  `.trim();

  const icon = L.divIcon({
    className: '',
    html: svg,
    iconSize: [32, 32],
    iconAnchor: [12, 32]
  });

  L.marker([m.lat, m.lng], { icon })
    .addTo(map)
    .bindPopup(`${m.word} @ ${new Date(m.time).toLocaleString()}`);

  appendLog(`📍 "${m.word}" (${m.status}) at [${m.lat},${m.lng}]`);
}

/** Load saved history from chrome.storage.local */
function loadHistory() {
  chrome.storage.local.get({ history: [] }, ({ history }) => {
    if (history.length) appendLog(`🔄 Restoring ${history.length} markers`);
    history.forEach(addMarker);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadHistory();

  // Clear History
  document.getElementById('clear').addEventListener('click', () => {
    chrome.storage.local.set({ history: [] }, () => {
      activeMarkers.forEach(mk => map.removeLayer(mk));
      activeMarkers = [];
      appendLog('🗑️ History cleared');
    });
  });

  // Scan Messages
  document.getElementById('scan').addEventListener('click', async () => {
    appendLog('🕵️ Scan clicked');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    appendLog(`🌐 Active tab: ${tab.url}`);
    if (!/https:\/\/web\.telegram\.org\//.test(tab.url)) {
      appendLog('❌ Not on Telegram Web – please switch and retry.');
      return;
    }

    appendLog('📥 Injecting content script…');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content_script.js']
      });
      appendLog('✅ Content script injected');
    } catch (e) {
      appendLog(`❌ Injection failed: ${e.message}`);
      return;
    }

    const port = chrome.tabs.connect(tab.id, { name: 'scan-channel' });
    port.onMessage.addListener(msg => {
      if (msg.progress) appendLog(msg.progress);
      if (msg.marker) {
        addMarker(msg.marker);
        // Persist to history
        chrome.storage.local.get({ history: [] }, ({ history }) => {
          history.push(msg.marker);
          chrome.storage.local.set({ history });
        });
      }
      if (msg.complete) appendLog(`✅ Scan complete: ${msg.scanned} messages`);
    });

    appendLog('🚀 Sending SCAN_NOW');
    port.postMessage({ command: 'SCAN_NOW' });
  });
});
