/**
 * background.js (Service Worker)
 */

// importScripts はルートからの相対パスで指定する
// background.js が src/ にある場合でも、拡張機能ルート基準になる
try {
  importScripts('src/xlsx.full.min.js');
} catch (e) {
  try {
    // フォールバック: background.js と同じ階層に置いた場合
    importScripts('xlsx.full.min.js');
  } catch (e2) {
    console.warn('[BG] SheetJS 読み込み失敗（xlsx出力はCSVにフォールバックします）:', e2.message);
  }
}

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

// ============================================================
// CSV生成（通常クロール用）
// ============================================================
function generateCSV(data) {
  const headers = ['店名', 'ジャンル', '取得元ジャンル', '住所', '電話番号', '定休日', '営業日', '営業開始', '営業終了', 'URL', '媒体'];
  const keyMapping = {
    '店名': 'name',
    'ジャンル': 'genre',
    '取得元ジャンル': 'source_genre',
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
  const rows = data.map(r => headers.map(h => escapeField(r[keyMapping[h]])).join(','));
  return '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
}

// ============================================================
// Excel生成（人気ジャンル一括用）
// ============================================================
function generateXlsx(results, genreLinks) {
  if (typeof XLSX === 'undefined') {
    console.warn('[BG] SheetJS 未読み込み → CSVにフォールバック');
    return null;
  }

  const headers = ['店名', 'ジャンル', '取得元ジャンル', '住所', '電話番号', '定休日', '営業日', '営業開始', '営業終了', 'URL', '媒体'];
  const keyMapping = {
    '店名': 'name',
    'ジャンル': 'genre',
    '取得元ジャンル': 'source_genre',
    '住所': 'address',
    '電話番号': 'phone',
    '定休日': 'regular_holiday',
    '営業日': 'business_days',
    '営業開始': 'open_time',
    '営業終了': 'close_time',
    'URL': 'url',
    '媒体': 'source'
  };

  const wb = XLSX.utils.book_new();

  // シート1: 全件
  const allRows = [headers, ...results.map(r => headers.map(h => r[keyMapping[h]] ?? ''))];
  const wsAll = XLSX.utils.aoa_to_sheet(allRows);
  XLSX.utils.book_append_sheet(wb, wsAll, '全件');

  // シート2以降: ジャンルごと
  const genreNames = genreLinks
    ? genreLinks.map(g => g.name)
    : [...new Set(results.map(r => r.source_genre).filter(Boolean))];

  genreNames.forEach(genreName => {
    const genreResults = results.filter(r => r.source_genre === genreName);
    if (genreResults.length === 0) return;
    const rows = [headers, ...genreResults.map(r => headers.map(h => r[keyMapping[h]] ?? ''))];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const sheetName = genreName.replace(/[\/\\:*?\[\]]/g, '').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}

// ============================================================
// CSVダウンロード（通常クロール用）
// ============================================================
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

// ============================================================
// Excelダウンロード（人気ジャンル一括用）
// ============================================================
async function triggerXlsxDownload(results, metadata, genreLinks) {
  if (!results || results.length === 0) return;
  const buf = generateXlsx(results, genreLinks);
  if (!buf) {
    console.warn('[BG] xlsx生成失敗 → CSVにフォールバック');
    await triggerDownload(results, metadata);
    return;
  }
  const uint8 = new Uint8Array(buf);
  let binary = '';
  uint8.forEach(b => binary += String.fromCharCode(b));
  const base64 = btoa(binary);
  const dataUrl = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + base64;
  const filename = buildFilename(metadata, 'xlsx');
  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    console.log('[BG] Excelダウンロード成功:', filename);
  } catch (err) {
    console.error('[BG] Excelダウンロード失敗:', err);
  }
}

// ============================================================
// content.js のライブDOMからジャンルリンクを取得
// content.js が未注入でも警告のみでクラッシュしない
// ============================================================
async function getGenreLinksFromContent(tabId, siteType) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { action: 'GET_GENRE_LINKS', siteType },
      (response) => {
        if (chrome.runtime.lastError) {
          // content.js 未注入は想定内 → offscreen の fetchフォールバックに任せる
          resolve([]);
          return;
        }
        resolve((response && response.links) ? response.links : []);
      }
    );
  });
}

// ============================================================
// メッセージリスナー
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.target === 'background') {

    if (message.type === 'OFFSCREEN_READY') {
      isOffscreenReady = true;
      if (offscreenReadyResolver) {
        offscreenReadyResolver();
        offscreenReadyResolver = null;
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'GET_GENRE_LINKS_FROM_CONTENT') {
      getGenreLinksFromContent(message.tabId, message.siteType).then(links => {
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'GENRE_LINKS_FROM_CONTENT_RESULT',
          tabId: message.tabId,
          links
        }).catch(() => { });
      });
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'DOWNLOAD_XLSX') {
      triggerXlsxDownload(message.results, message.metadata, message.genreLinks);
      chrome.storage.local.set({
        [`last_results_${message.tabId}`]: {
          results: message.results,
          metadata: message.metadata,
          timestamp: Date.now()
        }
      });
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'DOWNLOAD_CSV') {
      triggerDownload(message.results, message.metadata);
      chrome.storage.local.set({
        [`last_results_${message.tabId}`]: {
          results: message.results,
          metadata: message.metadata,
          timestamp: Date.now()
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

    // popup への転送
    chrome.runtime.sendMessage({
      tabId: message.tabId,
      type: message.type,
      ...message.payload
    }).catch(() => { });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'GET_GENRE_LINKS') {
    chrome.tabs.sendMessage(
      message.tabId,
      { action: 'GET_GENRE_LINKS', siteType: message.siteType },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ links: [] });
          return;
        }
        sendResponse(response || { links: [] });
      }
    );
    return true;
  }

  if (message.action === 'START_CRAWL') {
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'START_POPULAR_GENRE_CRAWL') {
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'STOP_CRAWL' || message.action === 'GET_RESULTS') {
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message }, (res) => {
        sendResponse(res);
      });
    });
    return true;
  }
});