// popup.js
// No direct import of loadConfig needed here unless popup uses config values directly at init.
// Content script loads its own config.

let map, activeMarkers = [], searchMarker = null, offsetCounts = {}, scanPort = null;

function appendLog(msg) {
  const logEl = document.getElementById('log');
  logEl.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function initMap() {
  if (map) return;
  map = L.map('map').setView([48.9226,24.7111],13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    subdomains:['a','b','c'], maxZoom:19,
    attribution:'© OpenStreetMap contributors'
  }).addTo(map);
  appendLog('🗺️ Map initialized');
}

function addMarkerToMap(m) {
  const key = `${m.lat.toFixed(6)},${m.lng.toFixed(6)}`;
  const count = offsetCounts[key] || 0;
  offsetCounts[key] = count + 1;

  let latlng = L.latLng(m.lat,m.lng);
  if(count>0){
    const angle = count * (Math.PI/4), radius=15;
    const pt = map.latLngToLayerPoint(latlng);
    latlng = map.layerPointToLatLng(
      L.point(pt.x + radius*Math.cos(angle),
              pt.y + radius*Math.sin(angle))
    );
  }

  const color = m.status==='clean' ? '#28a745' : '#dc3545';
  const svg = `
    <svg width="32" height="32" viewBox="0 0 24 24">
      <path fill="${color}"
        d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13
           s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
      <circle fill="#fff" cx="12" cy="9" r="2.5"/>
    </svg>`.trim();

  const icon = L.divIcon({html:svg,iconSize:[32,32],iconAnchor:[12,32],className:''});
  const mk = L.marker(latlng,{icon})
    .addTo(map)
    .bindPopup(
      `<strong>Status:</strong> ${m.status}<br>`+
      `<strong>Key:</strong> ${m.matchedKey}<br>`+
      `<em>${m.fullMessage}</em><br>`+
      `${new Date(m.time).toLocaleString()}`
    );
  activeMarkers.push(mk);
}

async function loadHistoryAndMisses() {
  const data = await new Promise(res=>
    chrome.storage.local.get(
      { history:[], missedGreen:[], missedRed:[], logs: [] },
      res
    )
  );
  if(data.history && data.history.length){
    appendLog(`🔄 Restoring ${data.history.length} markers from history.`);
    data.history.forEach(addMarkerToMap);
  }
  if(data.missedGreen && data.missedGreen.length)
    appendLog(`⚠️ Missed clean messages: ${data.missedGreen.length} (see View Logs for details)`);
  if(data.missedRed && data.missedRed.length)
    appendLog(`⚠️ Missed alert messages: ${data.missedRed.length} (see View Logs for details)`);
}

function viewLogs(){
  chrome.storage.local.get({ logs:[] },({logs})=>{
    if (!logs || logs.length === 0) {
        appendLog("No detailed logs found to view.");
        return;
    }
    const logContent = logs.map(log => {
        const stepsFormatted = log.steps.map(s => {
            let detailStr = '';
            for (const key in s) {
                if (s.hasOwnProperty(key) && key !== 'type') {
                    let valueStr;
                    if (typeof s[key] === 'object' || Array.isArray(s[key])) {
                        valueStr = JSON.stringify(s[key], null, 2);
                    } else {
                        valueStr = s[key] !== undefined ? s[key].toString() : 'undefined';
                    }
                    detailStr += `\n    ${key}: ${valueStr.includes('\n') ? '\n    ' + valueStr.replace(/\n/g, '\n    ') : valueStr}`;
                }
            }
            return `  - Type: ${s.type}${detailStr}`;
        }).join('\n');
        return `Timestamp: ${log.timestamp}\nStatus: ${log.status}\nMessage: ${log.rawMessage}\nFound Markers: ${log.foundMarkers}\nSteps:\n${stepsFormatted}`;
    }).join('\n\n-----------------------------------\n\n');

    const blob = new Blob([logContent], {type: 'text/plain;charset=utf-8'});
    window.open(URL.createObjectURL(blob));
  });
}

async function doSearch(){
    const query = document.getElementById('search-input').value.trim();
    if (!query) return;
    appendLog(`🗺️ Searching for: ${query}`);

    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&accept-language=uk,en`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data && data.length > 0) {
            const item = data[0];
            const lat = parseFloat(item.lat);
            const lon = parseFloat(item.lon);
            if (!isNaN(lat) && !isNaN(lon)) {
                if (searchMarker) {
                    map.removeLayer(searchMarker);
                }
                searchMarker = L.marker([lat, lon], { title: query }).addTo(map)
                    .bindPopup(`<b>Search Result:</b><br>${item.display_name}`)
                    .openPopup();
                map.setView([lat, lon], 15);
                appendLog(`✔️ Found: ${item.display_name}`);
            } else {
                appendLog(`❌ Could not parse coordinates for: ${query}`);
            }
        } else {
            appendLog(`❌ No results found for: ${query}`);
        }
    } catch (e) {
        appendLog(`❌ Search error: ${e.message}`);
        console.error("Search error:", e);
    }
}

document.addEventListener('DOMContentLoaded',async()=>{
  initMap();
  loadHistoryAndMisses();

  document.getElementById('search-btn').addEventListener('click',doSearch);
  document.getElementById('search-input').addEventListener('keydown',e=>{
    if(e.key==='Enter'){ doSearch(); e.preventDefault(); }
  });

  document.getElementById('scan').addEventListener('click',async()=>{
    document.getElementById('log').textContent='Logs will appear here…\n';
    chrome.storage.local.set({ logs:[], missedGreen:[], missedRed:[], history: [] }, () => {
        activeMarkers.forEach(m => map.removeLayer(m));
        activeMarkers = [];
        offsetCounts = {};
        if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
        appendLog('✨ Previous scan data cleared. Starting new scan.');
    });

    appendLog('🕵️ Scan clicked');
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    appendLog(`🌐 Tab URL: ${tab.url}`);
    if(!/https:\/\/web\.telegram\.org\//.test(tab.url)){
      appendLog('❌ Not on Telegram Web. Aborting.'); return;
    }

    appendLog('📥 Attempting to inject content script…');
    try{
      await chrome.scripting.executeScript({
        target:{tabId:tab.id},
        files:['content_script.js']
      });
      appendLog('✅ Content script ready.');
    }catch(e){
      appendLog(`❌ Injection failed: ${e.message}. Please ensure the page is fully loaded or try reloading the extension.`);
      console.error("Injection error:", e);
      return;
    }

    if(scanPort){ scanPort.disconnect(); }
    scanPort = chrome.tabs.connect(tab.id,{name:'scan-channel'});
    appendLog('🔌 Communication channel established.');

    scanPort.onMessage.addListener(msg => {
        if (!msg || !msg.type) { return; }
        switch(msg.type) {
            case 'progress':
                if(msg.message) appendLog(msg.message);
                break;
            case 'marker':
                const markerData = msg.data;
                appendLog(`📍 [${markerData.status}] ${markerData.matchedKey}`);
                addMarkerToMap(markerData);
                chrome.storage.local.get({ history: [] }, (result) => {
                    const updatedHistory = result.history || [];
                    updatedHistory.push(markerData);
                    chrome.storage.local.set({ history: updatedHistory });
                });
                break;
            case 'logEntry':
                chrome.storage.local.get({ logs: [] }, (result) => {
                    const updatedLogs = result.logs || [];
                    updatedLogs.push(msg.data);
                    chrome.storage.local.set({ logs: updatedLogs });
                });
                break;
            case 'missedLocation':
                appendLog(`❓ Missed [${msg.status}]: ${msg.text.substring(0, 70)}...`);
                if (msg.status === 'alert') {
                    chrome.storage.local.get({ missedRed: [] }, (result) => {
                        const updatedMissedRed = result.missedRed || [];
                        updatedMissedRed.push(msg.text);
                        chrome.storage.local.set({ missedRed: updatedMissedRed });
                    });
                } else if (msg.status === 'clean') {
                     chrome.storage.local.get({ missedGreen: [] }, (result) => {
                        const updatedMissedGreen = result.missedGreen || [];
                        updatedMissedGreen.push(msg.text);
                        chrome.storage.local.set({ missedGreen: updatedMissedGreen });
                    });
                }
                break;
        }
    });
    scanPort.onDisconnect.addListener(() => {
        if (scanPort) { appendLog('🔌 Communication channel unexpectedly disconnected.'); }
        scanPort = null;
    });

    appendLog('🚀 Sending SCAN_NOW command to content script.');
    scanPort.postMessage({command:'SCAN_NOW'});
  });

  document.getElementById('view-logs').addEventListener('click',viewLogs);

  document.getElementById('clear').addEventListener('click',()=>{
    if(scanPort){ scanPort.disconnect(); appendLog('🔌 Scan aborted by Clear.'); }
    activeMarkers.forEach(m=>map.removeLayer(m));
    activeMarkers = []; offsetCounts = {};
    if(searchMarker){ map.removeLayer(searchMarker); searchMarker=null; }

    document.getElementById('log').textContent='Logs will appear here…\n';
    chrome.storage.local.get({logs:[]},({logs})=>{
      chrome.storage.local.set({
        history:[], missedGreen:[], missedRed:[],
        logs: logs
      },()=> appendLog('🗑️ Cleared markers from map and history; detailed logs preserved.'));
    });
  });
});