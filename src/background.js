/**
 * background.js (Service Worker)
 */

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

let isOffscreenReady = false;
let offscreenReadyResolver = null;

async function setupOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    isOffscreenReady = true;
    return;
  }
  isOffscreenReady = false;
  const readyPromise = new Promise((resolve) => {
    offscreenReadyResolver = resolve;
  });
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'バックグラウンドで非アクティブタブの制限を受けずにHTMLパースとスクレーピングを安定して行うため',
    });
    console.log('[BG] Offscreen document created.');
    await Promise.race([
      readyPromise,
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);
  } catch (e) {
    console.error('[BG] Failed to create offscreen document:', e);
  }
}

function showNotification(title, message) {
  console.log(`[完了通知] ${title}: ${message}`);
}

function generateCSV(data) {
  const headers = ['店名', 'ジャンル', '住所', '電話番号', '定休日', '営業日', '営業開始', '営業終了', 'URL', '媒体'];
  const keyMapping = {
    '店名': 'name',
    'ジャンル': 'genre',
    '住所': 'address',
    '電話番号': 'phone',
    '定休日': 'regular_holiday',
    '営業日': 'business_days',
    '営業開始': 'open_time',
    '営業終了': 'close_time',
    'URL': 'url',
    '媒体': 'source'
  };

  const escapeField = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('\n') || s.includes('"'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };

  const rows = data.map(r =>
    headers.map(h => escapeField(r[keyMapping[h]])).join(',')
  );

  return '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
}

async function triggerDownload(results, metadata) {
  if (!results || results.length === 0) return;

  const csv = generateCSV(results);
  const base64 = btoa(unescape(encodeURIComponent(csv)));
  const dataUrl = 'data:text/csv;charset=utf-8;base64,' + base64;

  const area = metadata.area || '不明';
  const industry = metadata.industry || '飲食店';
  const media = metadata.media === 'tabelog'
    ? '食べログ'
    : (metadata.media === 'hotpepper' ? 'ホットペッパー' : '媒体不明');

  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  let filename = `${area}_${industry}_${media}_${ts}.csv`;
  filename = filename.replace(/[\/\\:*?"<>|]/g, '_');

  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    console.log('[BG] ダウンロード成功:', filename);
  } catch (err) {
    console.error('[BG] ダウンロード失敗:', err);
  }
}

// ============================================================
// メッセージリスナー
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // offscreen → background への各種通知
  if (message.target === 'background') {
    if (message.type === 'OFFSCREEN_READY') {
      isOffscreenReady = true;
      if (offscreenReadyResolver) {
        offscreenReadyResolver();
        offscreenReadyResolver = null;
      }
      sendResponse({ ok: true });
      return true;
    } else if (message.type === 'DOWNLOAD_CSV') {
      triggerDownload(message.results, message.metadata);
      chrome.storage.local.set({
        [`last_results_${message.tabId}`]: {
          results: message.results,
          metadata: message.metadata,
          timestamp: Date.now()
        }
      });
    } else if (message.type === 'SHOW_NOTIFICATION') {
      showNotification(message.title, message.message);
    } else {
      chrome.runtime.sendMessage({
        tabId: message.tabId,
        type: message.type,
        ...message.payload
      }).catch(() => { });
    }
    sendResponse({ ok: true });
    return true;
  }

  // GET_GENRE_LINKS: offscreen → background → content script へ中継
  if (message.action === 'GET_GENRE_LINKS') {
    chrome.tabs.sendMessage(
      message.tabId,
      { action: 'GET_GENRE_LINKS', siteType: message.siteType },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[BG] GET_GENRE_LINKS 中継エラー:', chrome.runtime.lastError.message);
          sendResponse({ links: [] });
          return;
        }
        sendResponse(response || { links: [] });
      }
    );
    return true;
  }

  // 既存: START_CRAWL
  if (message.action === 'START_CRAWL') {
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    });
    sendResponse({ ok: true });
    return true;
  }

  // 追加: START_POPULAR_GENRE_CRAWL
  if (message.action === 'START_POPULAR_GENRE_CRAWL') {
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    });
    sendResponse({ ok: true });
    return true;
  }

  // 既存: STOP_CRAWL / GET_RESULTS
  if (message.action === 'STOP_CRAWL' || message.action === 'GET_RESULTS') {
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message }, (res) => {
        sendResponse(res);
      });
    });
    return true;
  }
});