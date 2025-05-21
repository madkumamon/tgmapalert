console.log('✈️ content_script.js loaded on', location.href);

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const BATCH_SIZE = 10;

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'scan-channel') return;

  port.onMessage.addListener(async msg => {
    if (msg.command !== 'SCAN_NOW') return;
    port.postMessage({ progress: '🔍 Starting scan…' });

    const groups = document.querySelectorAll('[id^="message-group-"]');
    const texts = [];
    groups.forEach(group => {
      group.querySelectorAll('.content-inner .text-content').forEach(el => {
        const clone = el.cloneNode(true);
        clone.querySelector('.MessageMeta')?.remove();
        const txt = clone.textContent.trim();
        if (txt && !txt.toLowerCase().includes('як ')) {
          texts.push(txt);
        }
      });
    });
    port.postMessage({ progress: `📥 Found ${texts.length} messages` });

    let totalMarkers = 0;

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async text => {
        const tokens = [...text.matchAll(/\p{L}{3,}/gu)]
          .map(m => m[0].toLowerCase());
        const hasClean = tokens.includes('чисто');

        for (const token of tokens.filter(t => t !== 'чисто')) {
          const query = `Ivano-Frankivsk ${token}`;
          const url = `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=json&limit=5`;

          let data;
          try {
            data = await fetch(url).then(r => r.json());
          } catch {
            port.postMessage({ progress: `❌ Network error for "${token}"` });
            continue;
          }

          if (!Array.isArray(data) || data.length === 0) {
            port.postMessage({ progress: `⚠️ No geocode for "${token}"` });
            continue;
          }

          // pick best by Levenshtein
          let best = data[0], bestDist = Infinity;
          data.forEach(e => {
            const name = e.display_name.split(',')[0].toLowerCase();
            const d = levenshtein(token, name);
            if (d < bestDist) {
              bestDist = d;
              best = e;
            }
          });

          const lat = parseFloat(best.lat), lng = parseFloat(best.lon);
          if (isNaN(lat) || isNaN(lng)) {
            port.postMessage({
              progress: `⚠️ Bad coords for "${token}": ${best.lat},${best.lon}`
            });
            continue;
          }

          const marker = {
            word: token,
            lat,
            lng,
            status: hasClean ? 'clean' : 'alert',
            time: Date.now()
          };

          port.postMessage({ marker });
          totalMarkers++;
        }
      }));

      port.postMessage({
        progress: `✅ Processed ${Math.min(i + BATCH_SIZE, texts.length)}/${
          texts.length
        }`
      });
    }

    port.postMessage({
      progress: `💾 Done streaming ${totalMarkers} markers`,
      complete: true,
      scanned: texts.length
    });
  });
});
