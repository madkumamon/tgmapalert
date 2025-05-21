// loadConfig.js
export async function loadConfig() {
  // Fetch and parse the raw JSON
  const url = chrome.runtime.getURL('config.json');
  const res = await fetch(url);
  const raw = await res.json();

  // Shallow clone to avoid mutating the original
  const cfg = { ...raw };

  // Lowercase simple word lists
  ['ignore_words', 'green_words', 'red_words', 'fallback_tokens'].forEach(key => {
    if (Array.isArray(cfg[key])) {
      cfg[key] = cfg[key].map(w => w.toLowerCase());
    } else {
      cfg[key] = [];
    }
  });

  // Normalize location_phrases: lowercase every variant
  if (Array.isArray(cfg.location_phrases)) {
    cfg.location_phrases = cfg.location_phrases.map(entry => ({
      key: entry.key,
      variants: Array.isArray(entry.variants)
        ? entry.variants.map(v => v.toLowerCase())
        : []
    }));
  } else {
    cfg.location_phrases = [];
  }

  // Lowercase corrections_map keys and values
  const cm = {};
  if (cfg.corrections_map && typeof cfg.corrections_map === 'object') {
    for (const [canon, aliases] of Object.entries(cfg.corrections_map)) {
      cm[canon.toLowerCase()] = Array.isArray(aliases)
        ? aliases.map(a => a.toLowerCase())
        : [];
    }
  }
  cfg.corrections_map = cm;

  // Ensure fuzzy settings exist
  if (!cfg.fuzzy || typeof cfg.fuzzy !== 'object') {
    cfg.fuzzy = { maxDistanceRatio: 0.3, minLength: 4 };
  }

  return cfg;
}
