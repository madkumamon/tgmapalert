// content_script.js
// guard against double‐injection
if (!window._telegramMapperAttached) {
  window._telegramMapperAttached = true;
  console.log('%c TELEGRAM LOCATION MAPPER: Content Script ATTACHED', 'color: blue; font-weight: bold;', location.href);

  async function loadConfiguration() {
    // console.log('[CS] Loading configuration...');
    const res = await fetch(chrome.runtime.getURL('config.json'));
    if (!res.ok) throw new Error(`[CS] Failed to fetch config.json: ${res.statusText}`);
    const cfg = await res.json();

    ['ignore_words','green_words','red_words','fallback_tokens'].forEach(k => {
      cfg[k] = (Array.isArray(cfg[k]) ? cfg[k] : []).map(w => String(w).toLowerCase());
    });
    cfg.location_phrases = (Array.isArray(cfg.location_phrases) ? cfg.location_phrases : []).map(entry => ({
      key: String(entry.key || "").toLowerCase(),
      variants: (Array.isArray(entry.variants) ? entry.variants : []).map(v => String(v).toLowerCase())
    }));
    const cm = {};
    if (typeof cfg.corrections_map === 'object' && cfg.corrections_map !== null) {
        for (const [k,arr] of Object.entries(cfg.corrections_map)) {
          cm[String(k).toLowerCase()] = (Array.isArray(arr) ? arr : []).map(v => String(v).toLowerCase());
        }
    }
    cfg.corrections_map = cm;
    cfg.fuzzy = cfg.fuzzy || {};
    cfg.fuzzy.maxDistanceRatio = typeof cfg.fuzzy.maxDistanceRatio === 'number' ? cfg.fuzzy.maxDistanceRatio : 0.35;
    cfg.fuzzy.minLength = typeof cfg.fuzzy.minLength === 'number' ? cfg.fuzzy.minLength : 3;
    return cfg;
  }

  function levenshtein(a,b){
    const m=a.length,n=b.length;
    const dp=Array(m+1).fill(0).map(_=>Array(n+1).fill(0));
    for(let i=0;i<=m;i++) dp[i][0]=i;
    for(let j=0;j<=n;j++) dp[0][j]=j;
    for(let i=1;i<=m;i++){
      for(let j=1;j<=n;j++){
        const cost = a[i-1]===b[j-1]?0:1;
        dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
      }
    }
    return dp[m][n];
  }

  async function geocode(query, cfg, recordSteps) {
    const cleanedQuery = String(query || "").trim().toLowerCase();
    if (!cleanedQuery) {
        recordSteps?.push({ type: 'geocodeAttempt', query: query, result: 'empty_query_skipped' });
        return null;
    }

    recordSteps?.push({ type: 'geocodeAttempt', queryForNominatim: `${cfg.city} ${cleanedQuery}`, originalQuery: query });
    const url = `https://nominatim.openstreetmap.org/search`
      + `?q=${encodeURIComponent(cfg.city+' '+cleanedQuery)}`
      + `&format=json&limit=5&accept-language=uk,en`;
    try {
      const data = await fetch(url).then(r=>r.json());
      if (!Array.isArray(data)||!data.length) {
        recordSteps?.push({ type: 'geocodeResult', query: cleanedQuery, success: false, reason: 'no_results_from_nominatim', data: [] });
        return null;
      }
      const { maxDistanceRatio, minLength } = cfg.fuzzy;
      let best = null, bd = Infinity;
      for (const e of data) {
        const primaryNameComponent = String(e.display_name || "").split(',')[0].toLowerCase();
        let nameWithoutPrefix = primaryNameComponent;
        const commonStreetPrefixes = ["вулиця ", "вул ", "просп ", "проспект ", "площа ", "пл ", "село ", "с "];
        for (const p of commonStreetPrefixes) {
            if (primaryNameComponent.startsWith(p)) {
                nameWithoutPrefix = primaryNameComponent.substring(p.length);
                break;
            }
        }
        const dFullName = levenshtein(cleanedQuery, primaryNameComponent);
        const dWithoutStreetPrefix = levenshtein(cleanedQuery, nameWithoutPrefix);
        const d = Math.min(dFullName, dWithoutStreetPrefix);

        if ((cleanedQuery.length >= minLength && (!maxDistanceRatio || d/cleanedQuery.length <= maxDistanceRatio) && d < bd) ||
            (cleanedQuery.length < minLength && d === 0 && d < bd) ){
          bd = d;
          best = e;
        }
      }
      if (!best) {
        recordSteps?.push({ type: 'geocodeResult', query: cleanedQuery, success: false, reason: 'fuzzy_match_failed', data: data.map(d => ({name: d.display_name, lat: d.lat, lon: d.lon})) });
        return null;
      }
      const lat = parseFloat(best.lat), lon = parseFloat(best.lon);
      const result = isNaN(lat)||isNaN(lon) ? null : { lat, lon };
      recordSteps?.push({ type: 'geocodeResult', query: cleanedQuery, success: !!result, geocodedName: best.display_name, lat: result?.lat, lon: result?.lon, levenshteinDistance: bd });
      return result;
    } catch (e) {
      recordSteps?.push({ type: 'geocodeResult', query: cleanedQuery, success: false, reason: `network_error: ${e.message}` });
      return null;
    }
  }

  function parseDateGroupHeader(headerText, now) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    if (!headerText) return today;
    const lowerHeaderText = headerText.toLowerCase();
    if (lowerHeaderText === 'сьогодні' || lowerHeaderText === 'today') return today;
    if (lowerHeaderText === 'вчора' || lowerHeaderText === 'yesterday') {
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        return yesterday;
    }
    const currentYear = now.getFullYear();
    try {
        let parsedDate = new Date(`${headerText} ${currentYear}`);
        if (!isNaN(parsedDate.getTime())) {
            if (parsedDate.getFullYear() === currentYear && parsedDate.getMonth() > now.getMonth()) {
                parsedDate.setFullYear(currentYear - 1);
            }
            parsedDate.setHours(0,0,0,0);
            return parsedDate;
        }
    } catch(e) { /* fall through */ }
    // console.warn(`[CS] Could not parse date group header: "${headerText}", defaulting to today.`);
    return today;
  }

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'scan-channel') return;
    let alive = true;
    port.onDisconnect.addListener(() => { alive = false; });

    let extensionConfig = null;

    port.onMessage.addListener(async msg => {
      if (msg.command !== 'SCAN_NOW') return;
      console.log('[CS] Received SCAN_NOW command.');

      if (!extensionConfig) {
        try {
            if (alive) port.postMessage({ type: 'progress', message: '⚙️ Loading configuration...' });
            // console.log('[CS] Attempting to load configuration...');
            extensionConfig = await loadConfiguration();
            if (alive) port.postMessage({ type: 'progress', message: '⚙️ Configuration loaded.' });
            // console.log('[CS] Configuration successfully loaded.');
        } catch (err) {
            console.error("[CS] Failed to load extension configuration:", err);
            if (alive) port.postMessage({ type: 'progress', message: `❌ Error: Failed to load config - ${err.message}. Scan aborted.` });
            return;
        }
      }
      const cfg = extensionConfig;

      const now = new Date();
      const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
      if (alive) port.postMessage({ type: 'progress', message: `🔍 Scanning messages (up to 6 hours old, from ${sixHoursAgo.toLocaleString()})` });
      console.log(`[CS] Time window: After ${sixHoursAgo.toISOString()}`);

      const messageListContainer = document.querySelector('.ChatMessages-container .Transition_inner') ||
                                 document.querySelector('#MiddleColumn .messages-list') ||
                                 document.querySelector('.messages-list') ||
                                 document.querySelector('.messages-container div[data-messages-container-element="root"]') ||
                                 document.querySelector('.messages-container') ||
                                 document.body;

      console.log('[CS] Using message list container:', messageListContainer.className || messageListContainer.tagName);
      if (alive) port.postMessage({ type: 'progress', message: `ℹ️ Using message list container: ${messageListContainer.className || messageListContainer.tagName}` });

      const dateGroupElements = Array.from(messageListContainer.querySelectorAll('div.message-date-group')); // More specific
      console.log(`[CS] Found ${dateGroupElements.length} date groups with selector "div.message-date-group".`);
      if (alive) port.postMessage({ type: 'progress', message: `ℹ️ Found ${dateGroupElements.length} date groups.` });

      if (dateGroupElements.length === 0 && alive) {
         port.postMessage({ type: 'progress', message: `⚠️ No date groups found. Ensure chat is active and selectors are correct.` });
      }

      let processedMessagesCount = 0;
      let consideredMessagesCount = 0;
      let stoppedDueToTimeLimitOverall = false;

      for (const dateGroupElement of dateGroupElements.reverse()) {
        if (!alive || stoppedDueToTimeLimitOverall) {
            console.log(`[CS] Breaking date group loop. Alive: ${alive}, StoppedOverall: ${stoppedDueToTimeLimitOverall}`);
            break;
        }

        const dateHeaderEl = dateGroupElement.querySelector('.sticky-date > .content > span, .sticky-date > span');
        let currentDateGroupDate = now;
        const dateHeaderText = dateHeaderEl ? dateHeaderEl.textContent?.trim() : "Unknown Date Header";
        if (dateHeaderEl && dateHeaderEl.textContent) {
            currentDateGroupDate = parseDateGroupHeader(dateHeaderText, now);
        }
        // console.log(`[CS] Processing Date Group: "${dateHeaderText}", Parsed Date for group context: ${currentDateGroupDate.toISOString()}`);

        // ***** MODIFIED: Using .message-list-item *****
        const messageListItems = Array.from(dateGroupElement.querySelectorAll('div.message-list-item'));
        // console.log(`[CS] Found ${messageListItems.length} message-list-items in date group: "${dateHeaderText}"`);
        if (alive && messageListItems.length === 0) {
             port.postMessage({ type: 'progress', message: `ℹ️ Date group "${dateHeaderText}" has 0 message-list-items.` });
        }

        let stoppedProcessingThisDateGroup = false;

        for (const messageListItem of messageListItems.reverse()) {
          consideredMessagesCount++;
          if (!alive) { stoppedProcessingThisDateGroup = true; break; }
          const messageId = messageListItem.id || `msg-item-${consideredMessagesCount}`;
          // console.log(`[CS] --- Examining message-list-item ${messageId} ---`);

          const record = {
              timestamp: new Date().toISOString(),
              rawMessage: "N/A",
              status: 'unknown',
              steps: [{type: 'initialProcessing', messageId: messageId, dateGroupContext: currentDateGroupDate.toISOString()}],
              foundMarkers: 0
          };

          // ***** MODIFIED: Time element selector based on new structure *****
          let timeElement = messageListItem.querySelector('.text-content .MessageMeta .message-time');
          if (!timeElement) { // Fallback to other common locations
            timeElement = messageListItem.querySelector('.message-info .message-time, .MessageMeta .message-time, .message-meta .message-time, .message-status-content .time');
          }
          // ***** END MODIFIED Time element selector *****

          let messageDate = null;
          let rawTimeTitle = "N/A";
          let rawTimeText = "N/A";

          if (timeElement) {
              rawTimeTitle = timeElement.getAttribute('title');
              rawTimeText = timeElement.textContent?.trim();
              record.steps.push({type: 'timeElementRawInfo', title: rawTimeTitle, text: rawTimeText});
              if (rawTimeTitle) {
                  messageDate = new Date(rawTimeTitle); // This should parse "May 21, 2025, 23:17:46"
                  if (isNaN(messageDate.getTime())) {
                      messageDate = null;
                      record.steps.push({type: 'timeParseWarning', source: 'title', rawTime: rawTimeTitle, reason: "Failed to parse title attribute"});
                  } else {
                      record.steps.push({type: 'timeExtracted', source: 'title', rawTime: rawTimeTitle, parsedDate: messageDate.toISOString()});
                  }
              }
              if (!messageDate && rawTimeText) { // Fallback to text content if title failed or missing
                  const timeMatch = rawTimeText.match(/^(\d{1,2}):(\d{2})$/);
                  if (timeMatch) {
                      messageDate = new Date(currentDateGroupDate);
                      messageDate.setHours(parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), 0, 0);
                      record.steps.push({type: 'timeExtracted', source: 'textContentHHMM', rawTime: rawTimeText, parsedDate: messageDate.toISOString()});
                  } else {
                      record.steps.push({type: 'timeParseSkipped', source: 'textContent', rawTime: rawTimeText, reason: "Only HH:MM supported as fallback"});
                  }
              }
          } else {
              record.steps.push({type: 'timeExtractionError', reason: "time_element_not_found for msg " + messageId});
              if (alive) port.postMessage({ type: 'logEntry', data: record });
              continue;
          }

          if (!messageDate || isNaN(messageDate.getTime())) {
              record.steps.push({type: 'timeParseCriticalFail', reason: "could_not_determine_message_date for msg " + messageId});
              if (alive) port.postMessage({ type: 'logEntry', data: record });
              continue;
          }

          if (messageDate < sixHoursAgo) {
              record.steps.push({type: "messageSkippedOld", messageDate: messageDate.toISOString(), threshold: sixHoursAgo.toISOString()});
              stoppedProcessingThisDateGroup = true;
              stoppedDueToTimeLimitOverall = true;
              break;
          }

          processedMessagesCount++;

          // ***** MODIFIED: Text Content Extraction based on new structure *****
          let textContentSource = "[No text content found by specific path]";
          let raw = "";
          const contentWrapperEl = messageListItem.querySelector('.message-content-wrapper');
          let textEl = null;

          if (contentWrapperEl) {
              const innerContentEl = contentWrapperEl.querySelector('.content-inner');
              if (innerContentEl) {
                  textEl = innerContentEl.querySelector('.text-content:not(.is-hidden)');
                  if (textEl) textContentSource = ".message-content-wrapper .content-inner .text-content";
              }
              if ((!textEl || !textEl.textContent?.trim()) && contentWrapperEl) { // Check caption if main text empty/not found in wrapper
                  const captionEl = contentWrapperEl.querySelector('.message-caption .text-content:not(.is-hidden), .message-caption');
                  if (captionEl && captionEl.textContent?.trim()) {
                      textEl = captionEl; textContentSource = ".message-content-wrapper .message-caption";
                  }
              }
          }
          // Broader fallbacks if the specific path failed
          if (!textEl || !textEl.textContent?.trim()) {
            const fallbackSelectors = [
                '.text-content:not(.is-hidden)',
                '.message-bubble > .text-with-entities',
                '.reply-markup .text-content:not(.is-hidden)',
                '.forwarded-message .text-content:not(.is-hidden)'
            ];
            for (const selector of fallbackSelectors) {
                const fallbackTextEl = messageListItem.querySelector(selector);
                if (fallbackTextEl && fallbackTextEl.textContent?.trim()) {
                    textEl = fallbackTextEl; textContentSource = `fallback: messageListItem > ${selector}`; break;
                }
            }
          }
          // ***** END MODIFIED Text Content Extraction *****

          if (textEl && textEl.textContent?.trim()) {
              const clonedTextEl = textEl.cloneNode(true);
              const metaElInCloned = clonedTextEl.querySelector('.MessageMeta'); // Query within the cloned text element
              if (metaElInCloned) {
                  metaElInCloned.remove();
                  record.steps.push({type: 'textMetaRemoved', removedElementClass: '.MessageMeta'});
              }
              raw = clonedTextEl.textContent.trim();
              record.rawMessage = raw;
              record.steps.push({type: 'textExtracted', source: textContentSource, text: record.rawMessage});
          } else {
              record.rawMessage = textContentSource;
              record.status = 'skipped_no_text';
              record.steps.push({type: "textExtractionError", reason: `text_element_not_found_or_empty. Final attempt source: ${textContentSource}`});
              if (alive) port.postMessage({ type: 'logEntry', data: record });
              continue;
          }

          if (!raw) { // If after meta removal, text is empty
            record.status = 'skipped_empty_after_meta_removal';
            record.steps.push({type: "textProcessingError", reason: "Text became empty after removing .MessageMeta"});
            if (alive) port.postMessage({ type: 'logEntry', data: record });
            continue;
          }

          let lower = record.rawMessage.toLowerCase();
          let determinedStatus = 'unknown';
          const hasGreenWord = cfg.green_words.some(w => lower.includes(w));
          const hasRedWord = cfg.red_words.some(w => lower.includes(w));

          if (hasGreenWord) determinedStatus = 'clean';
          else if (hasRedWord) determinedStatus = 'alert';

          record.steps.push({type: 'statusWordCheck', hasGreen: hasGreenWord, hasRed: hasRedWord, determinedInitialStatus: determinedStatus});

          if (determinedStatus === 'unknown') {
              record.status = 'skipped_no_status_words';
              if (alive) port.postMessage({ type: 'logEntry', data: record });
              continue;
          }
          record.status = determinedStatus;

          if (alive) port.postMessage({ type: 'progress', message: `📝 [${record.status}] (Time: ${messageDate.toLocaleTimeString()}) ${record.rawMessage.substring(0,50)}...` });

          let text = lower;
          record.steps.push({type: 'lowercaseText', text: text});

          const initialTextForIgnore = text;
          let tokensFromTextForIgnore = text.split(/\s+/);
          let keptTokensForIgnore = [];
          let removedTokensLog = [];
          for (const token of tokensFromTextForIgnore) {
              if (!token) continue;
              const cleanedTokenForCheck = token.replace(/^[.,!?;:"“”«»()\[\]{}]+|[.,!?;:"“”«»()\[\]{}]+$/g, '').toLowerCase();
              if (cleanedTokenForCheck && !cfg.ignore_words.includes(cleanedTokenForCheck)) {
                  keptTokensForIgnore.push(token);
              } else if (cleanedTokenForCheck) {
                  removedTokensLog.push({ original: token, cleaned: cleanedTokenForCheck, reason: 'ignored' });
              } else {
                  keptTokensForIgnore.push(token);
              }
          }
          text = keptTokensForIgnore.join(' ').replace(/\s+/g, ' ').trim();
          record.steps.push({type: 'afterIgnoreWords', originalText: initialTextForIgnore, remainingText: text, removedTokensDetail: removedTokensLog});

          for (const [canon, aliases] of Object.entries(cfg.corrections_map)) {
            for (const a of aliases) {
              const aliasRegex = new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'giu');
              if (aliasRegex.test(text)) {
                  const oldText = text;
                  text = text.replace(aliasRegex, canon);
                  record.steps.push({type: 'correctionApplied', from: a, to: canon, oldText: oldText, newText:text});
              }
            }
          }
          text = text.replace(/\s+/g, ' ').trim();
          record.steps.push({type: 'afterCorrections', text: text});

          const markers = [];
          let textForFallbacks = text;

          // --- Location finding phases (Full logic) ---
            record.steps.push({type: 'phaseStart', name: 'location_phrases', currentText: textForFallbacks});
            for (const entry of cfg.location_phrases) {
                if (!alive) break;
                for (const v of entry.variants) {
                    const variantRegex = new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'iu');
                    if (variantRegex.test(textForFallbacks)) {
                        record.steps.push({type: 'locationPhraseMatchAttempt', entryKey: entry.key, variant: v});
                        let loc = await geocode(entry.key, cfg, record.steps);
                        if (!loc && entry.key !== v && entry.key !== entry.variants[0]) { loc = await geocode(v, cfg, record.steps); }
                        else if (!loc && entry.key !== entry.variants[0]) { loc = await geocode(entry.variants[0], cfg, record.steps); }
                        if (loc) {
                            markers.push({ key: entry.key, lat: loc.lat, lng: loc.lon });
                            const oldText = textForFallbacks; textForFallbacks = textForFallbacks.replace(variantRegex, ' '); textForFallbacks = textForFallbacks.replace(/\s+/g, ' ').trim();
                            record.steps.push({type: 'textModifiedAfterMatch', ruleSource: 'location_phrase', removed: v, oldText: oldText, newText: textForFallbacks});
                            break;
                        }
                    }
                }
            }
            record.steps.push({type: 'phaseEnd', name: 'location_phrases', markersFound: markers.length});

            if(!markers.length) {
                record.steps.push({type: 'phaseStart', name: 'fallback_tokens', currentText: textForFallbacks});
                const currentTokens = textForFallbacks.match(/[\p{L}\d'-]+/gu) || [];
                for (const t of currentTokens.map(tok => tok.toLowerCase())) {
                    if (!alive) break;
                    if (cfg.fallback_tokens.includes(t)) {
                        if (cfg.ignore_words.includes(t) || cfg.green_words.includes(t) || cfg.red_words.includes(t)) { record.steps.push({type: 'fallbackTokenSkipped', token: t, reason: 'is_status_or_ignore_word'}); continue; }
                        record.steps.push({type: 'fallbackTokenAttempt', token: t});
                        const loc = await geocode(t, cfg, record.steps);
                        if (loc) {
                            markers.push({ key: t, lat: loc.lat, lng: loc.lon });
                            const oldText = textForFallbacks; const tokenRegex = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'iu'); textForFallbacks = textForFallbacks.replace(tokenRegex, ' '); textForFallbacks = textForFallbacks.replace(/\s+/g, ' ').trim();
                            record.steps.push({type: 'textModifiedAfterMatch', ruleSource: 'fallback_token', removed: t, oldText: oldText, newText: textForFallbacks});
                        }
                    }
                }
                record.steps.push({type: 'phaseEnd', name: 'fallback_tokens', markersFound: markers.length});
            }

            const textForIntersectionTest = record.steps.find(s => s.type === 'afterCorrections')?.text || text;
            if (!markers.length && textForIntersectionTest.toLowerCase().includes("перехрестя")) {
                record.steps.push({type: 'phaseStart', name: 'intersectionParser', currentText: textForIntersectionTest});
                const intersectionRegex = /перехрестя\s+([\p{L}\d\s.'-]+)(?:\s*[\/\u0026\u0456\u002B]\s*|\s+та\s+|\s+і\s+)([\p{L}\d\s.'-]+)/iu;
                const match = textForIntersectionTest.match(intersectionRegex);
                record.steps.push({type: 'intersectionRegexAttempt', regex: intersectionRegex.source, textUsed: textForIntersectionTest, matchResult: match ? {...match} : null});
                if (match && match[1] && match[2]) {
                    const street1Raw = match[1].trim();const street2Raw = match[2].trim();
                    const cleanStreetName = (sName) => sName.replace(/^(вулиця|вул\.?|просп\.?|проспект|пл\.?|площа)\s+/i, '').trim();
                    const street1Clean = cleanStreetName(street1Raw); const street2Clean = cleanStreetName(street2Raw);
                    if (street1Clean && street2Clean) {
                        const intersectionQuery = `${street1Clean} та ${street2Clean}`; const matchedKey = `перехрестя ${street1Clean} / ${street2Clean}`;
                        if(port && alive) port.postMessage({ type: 'progress', message: `INTERSECTION?: ${intersectionQuery}` });
                        const loc = await geocode(intersectionQuery, cfg, record.steps);
                        if (loc) {
                            markers.push({ key: matchedKey, lat: loc.lat, lng: loc.lon });
                            const oldText = textForFallbacks; textForFallbacks = textForFallbacks.replace(new RegExp(match[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' '); textForFallbacks = textForFallbacks.replace(/\s+/g, ' ').trim();
                            record.steps.push({type: 'textModifiedAfterMatch', ruleSource: 'intersection', removed: match[0], oldText: oldText, newText: textForFallbacks});
                        }
                    }
                }
                record.steps.push({type: 'phaseEnd', name: 'intersectionParser', markersFound: markers.length});
            }

            if(!markers.length){
                record.steps.push({type: 'phaseStart', name: 'generalTokenFallback', currentText: textForFallbacks});
                let generalTokens = (textForFallbacks.match(/[\p{L}\d'-]+/gu) || []).map(m => m.toLowerCase());
                const tempIgnoreList = new Set([...cfg.ignore_words, ...cfg.green_words, ...cfg.red_words, ...cfg.fallback_tokens, "перехрестя"]);
                generalTokens = generalTokens.filter(t => !tempIgnoreList.has(t) );
                generalTokens.sort((a, b) => b.length - a.length);
                record.steps.push({type: 'generalTokensToTry', tokens: [...generalTokens]});
                for (const t of generalTokens) {
                    if (!alive) break;
                    if (t.length < cfg.fuzzy.minLength) { record.steps.push({type: 'generalTokenSkipped', token: t, reason: 'too_short'}); continue; }
                    await new Promise(r => setTimeout(r, 200));
                    const loc = await geocode(t, cfg, record.steps);
                    if (loc) {
                        markers.push({ key: t, lat: loc.lat, lng: loc.lon });
                        const oldText = textForFallbacks; const tokenRegex = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'iu'); textForFallbacks = textForFallbacks.replace(tokenRegex, ' '); textForFallbacks = textForFallbacks.replace(/\s+/g, ' ').trim();
                        record.steps.push({type: 'textModifiedAfterMatch', ruleSource: 'general_token', removed: t, oldText: oldText, newText: textForFallbacks});
                        break;
                    }
                }
                record.steps.push({type: 'phaseEnd', name: 'generalTokenFallback', markersFound: markers.length});
            }
            if(!markers.length){
                record.steps.push({type: 'phaseStart', name: 'entireTextFallback', currentText: textForFallbacks});
                const trimmedText = textForFallbacks.trim();
                const isJustStatusWord = cfg.green_words.includes(trimmedText) || cfg.red_words.includes(trimmedText) || cfg.ignore_words.includes(trimmedText);
                if (trimmedText.length >= cfg.fuzzy.minLength && !isJustStatusWord) {
                    const loc = await geocode(trimmedText, cfg, record.steps);
                    if (loc) { markers.push({ key: trimmedText, lat: loc.lat, lng: loc.lon }); }
                } else {
                    record.steps.push({type: 'entireTextSkipped', text: trimmedText, reason: isJustStatusWord ? 'is_status_word' : (trimmedText.length < cfg.fuzzy.minLength ? 'too_short' : 'empty')});
                }
                record.steps.push({type: 'phaseEnd', name: 'entireTextFallback', markersFound: markers.length});
            }
          // --- End of location finding phases ---

          record.foundMarkers = markers.length;
          if (markers.length === 0) {
              if (alive) port.postMessage({ type: 'missedLocation', text: raw, status: record.status });
              record.steps.push({type: 'finalOutcome', outcome: 'no_markers_found'});
          } else {
              record.steps.push({type: 'finalOutcome', outcome: `${markers.length}_marker(s)_found`, markers: markers.map(m => ({key: m.key, lat: m.lat, lon: m.lon}))});
          }

          if (alive) port.postMessage({ type: 'logEntry', data: record });

          for (const m of markers) {
            if (!alive) break;
            port.postMessage({
              type: 'marker',
              data: { fullMessage: raw, matchedKey: m.key, lat: m.lat, lng: m.lng, status: record.status, time: Date.now() }
            });
          }
        }
        if (stoppedProcessingThisDateGroup) {
            // console.log(`[CS] Stopped processing current date group ("${dateHeaderText}") due to 6hr limit or disconnect.`);
            if (alive) port.postMessage({ type: 'progress', message: `ℹ️ Stopped date group "${dateHeaderText}" (6hr limit).`});
        }
      }

      if (alive) port.postMessage({ type: 'progress', message: `✅ Scan complete. Considered ${consideredMessagesCount} messages, processed ${processedMessagesCount} within time limit.` , complete: true });
      console.log(`[CS] Scan complete. Considered ${consideredMessagesCount}, Processed ${processedMessagesCount} messages within time limit.`);
    });
  });
}