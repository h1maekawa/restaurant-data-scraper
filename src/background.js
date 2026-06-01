/**
 * background.js (Service Worker)
 * ※ SheetJS は offscreen.html で読み込むため importScripts 不要
 */

// Service Worker をスリープさせない keepAlive
function keepAlive() {
  chrome.runtime.getPlatformInfo(() => { });
  setTimeout(keepAlive, 20000);
}
keepAlive();

const crawlState = new Map();
// crawlState[tabId] = {
//   running: bool,
//   logs: [ { time, msg, type } ],
//   collected: number,
//   maxItems: number,
//   page: number,
//   metadata: {}
// }

function getState(tabId) {
  if (!crawlState.has(tabId)) {
    crawlState.set(tabId, {
      running: false,
      logs: [],
      collected: 0,
      maxItems: 0,
      page: 1,
      metadata: {}
    });
  }
  return crawlState.get(tabId);
}

function pushLog(tabId, msg, type = 'info') {
  const state = getState(tabId);
  const time = new Date().toLocaleTimeString('ja-JP', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  state.logs.push({ time, msg, type });
  // ログは最大300件
  if (state.logs.length > 300) state.logs.shift();
}

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen.html';
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

function buildFilename(metadata, ext) {
  const area = metadata.area || '不明';
  const industry = metadata.industry || '飲食店';
  const media = metadata.media === 'tabelog'
    ? '食べログ'
    : (metadata.media === 'hotpepper' ? 'ホットペッパー' : '媒体不明');
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  return `${area}_${industry}_${media}_${ts}.${ext}`.replace(/[\/\\:*?"<>|]/g, '_');
}

function generateCSV(data) {
  const headers = ['店名', 'ジャンル', '取得元ジャンル', '住所', '電話番号', '定休日', '営業日', '営業開始', '営業終了', 'URL', '媒体'];
  const keyMapping = {
    '店名': 'name', 'ジャンル': 'genre', '取得元ジャンル': 'source_genre',
    '住所': 'address', '電話番号': 'phone', '定休日': 'regular_holiday',
    '営業日': 'business_days', '営業開始': 'open_time', '営業終了': 'close_time',
    'URL': 'url', '媒体': 'source'
  };
  const escapeField = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('\n') || s.includes('"'))
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = data.map(r => headers.map(h => escapeField(r[keyMapping[h]])).join(','));
  return '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
}

async function triggerDownload(results, metadata) {
  if (!results || results.length === 0) return;
  const csv = generateCSV(results);
  const base64 = btoa(unescape(encodeURIComponent(csv)));
  const dataUrl = 'data:text/csv;charset=utf-8;base64,' + base64;
  const filename = buildFilename(metadata, 'csv');
  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    console.log('[BG] CSVダウンロード成功:', filename);
  } catch (err) {
    console.error('[BG] CSVダウンロード失敗:', err);
  }
}

// offscreen側でxlsx生成済み → base64を受け取るだけ
async function triggerXlsxDownload(base64, metadata) {
  if (!base64) {
    console.warn('[BG] xlsx base64データなし');
    return;
  }
  const dataUrl = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + base64;
  const filename = buildFilename(metadata, 'xlsx');
  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    console.log('[BG] Excelダウンロード成功:', filename);
  } catch (err) {
    console.error('[BG] Excelダウンロード失敗:', err);
  }
}

async function getGenreLinksFromContent(tabId, siteType) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'GET_GENRE_LINKS', siteType }, (response) => {
      if (chrome.runtime.lastError) { resolve([]); return; }
      resolve((response && response.links) ? response.links : []);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.target === 'background') {

    if (message.type === 'OFFSCREEN_READY') {
      isOffscreenReady = true;
      if (offscreenReadyResolver) { offscreenReadyResolver(); offscreenReadyResolver = null; }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'GET_GENRE_LINKS_FROM_CONTENT') {
      getGenreLinksFromContent(message.tabId, message.siteType).then(links => {
        chrome.runtime.sendMessage({
          target: 'offscreen', type: 'GENRE_LINKS_FROM_CONTENT_RESULT',
          tabId: message.tabId, links
        }).catch(() => { });
      });
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'DOWNLOAD_XLSX') {
      // base64はoffscreen側で生成済み
      triggerXlsxDownload(message.base64, message.metadata);
      chrome.storage.local.set({
        [`last_results_${message.tabId}`]: {
          results: message.results, metadata: message.metadata, timestamp: Date.now()
        }
      });
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'DOWNLOAD_CSV') {
      triggerDownload(message.results, message.metadata);
      chrome.storage.local.set({
        [`last_results_${message.tabId}`]: {
          results: message.results, metadata: message.metadata, timestamp: Date.now()
        }
      });
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'SHOW_NOTIFICATION') {
      showNotification(message.title, message.message);
      sendResponse({ ok: true });
      return true;
    }

    // ログ・状態をメモリに記録してからpopupへ転送
    const tabId = message.tabId;
    const payload = message.payload || {};
    const state = getState(tabId);

    switch (message.type) {
      case 'PAGE_START':
        state.running = true;
        state.page = payload.page || state.page;
        state.collected = payload.collected || state.collected;
        pushLog(tabId, `📄 ${payload.siteName || ''}${payload.page}ページ目 開始 (取得済み: ${payload.collected}件)`, 'info');
        break;
      case 'PROGRESS':
        state.running = true;
        state.collected = payload.collected || state.collected;
        state.maxItems = payload.maxItems || state.maxItems;
        state.page = payload.page || state.page;
        pushLog(tabId, `✅ ${payload.latest}`, 'good');
        break;
      case 'INFO':
        pushLog(tabId, `ℹ️ ${payload.message}`, 'info');
        break;
      case 'ERROR':
        state.running = false;
        pushLog(tabId, `❌ ${payload.message}`, 'err');
        break;
      case 'DONE':
        state.running = false;
        state.collected = payload.collected || state.collected;
        state.metadata = payload.metadata || state.metadata;
        pushLog(tabId, `🎉 完了！ 合計 ${payload.collected} 件取得`, 'good');
        break;
    }

    chrome.runtime.sendMessage({
      tabId, type: message.type, ...payload
    }).catch(() => { });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'GET_GENRE_LINKS') {
    chrome.tabs.sendMessage(message.tabId, { action: 'GET_GENRE_LINKS', siteType: message.siteType }, (response) => {
      if (chrome.runtime.lastError) { sendResponse({ links: [] }); return; }
      sendResponse(response || { links: [] });
    });
    return true;
  }

  if (message.action === 'START_CRAWL') {
    const state = getState(message.tabId);
    state.running = true;
    state.logs = [];
    state.collected = 0;
    state.maxItems = message.maxItems || 0;
    state.page = 1;
    state.metadata = {};
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'START_POPULAR_GENRE_CRAWL') {
    const state = getState(message.tabId);
    state.running = true;
    state.logs = [];
    state.collected = 0;
    state.maxItems = message.maxItems || 0;
    state.page = 1;
    state.metadata = {};
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'GET_STATE') {
    const state = getState(message.tabId);
    sendResponse({ ok: true, state });
    return true;
  }

  if (message.action === 'STOP_CRAWL') {
    const state = getState(message.tabId);
    state.running = false;
    pushLog(message.tabId, '⏹ 停止リクエスト送信', 'warn');
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message }, (res) => { sendResponse(res); });
    });
    return true;
  }

  if (message.action === 'GET_RESULTS') {
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message }, (res) => { sendResponse(res); });
    });
    return true;
  }
});