# Telegram Location Mapper

Annotates mentions of Ivano-Frankivsk streets, places, and villages in a Telegram Web chat by placing markers on a Leaflet map.

## Files

- **manifest.json**
- **config.json** – all your lists, correction maps, popular streets/places/villages
- **content_script.js** – parses messages, geocodes, streams markers
- **popup.html** / **popup.js** – map UI, logs, persistence
- **loadConfig.js** – shared loader for `config.json`
- **leaflet.js** / **leaflet.css** – map library
- **icons/** (optional) – only if you still use PNG markers

> **Note**: `content_script.js` is **not** a module, so it inlines its own `loadConfigCS()`.

## Usage

1. Go to `chrome://extensions` → enable **Developer mode**.
2. Click **Load unpacked** and select this directory.
3. Open **Telegram Web**.
4. Click the extension icon → **Scan Messages**.
5. Watch markers appear on the map.
6. **Clear History** to remove stored markers.

## Configuration

Edit **config.json** to tweak:

- `ignore_words`
- `green_words` / `red_words`
- `corrections_map`
- `popular_streets`, `popular_places`, `popular_villages`
- `city` and `batch_size`

Reload the extension after any changes.

---

Enjoy mapping your Telegram feed!