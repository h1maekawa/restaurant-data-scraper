/**
 * background.js (Service Worker)
 * 拡張機能全体の司令塔。Offscreen Document を管理し、システムAPIを実行します。
 */

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

// Offscreen Document の立ち上げ・維持
async function setupOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'バックグラウンドで非アクティブタブの制限を受けずにHTMLパースとスクレーピングを安定して行うため',
    });
    console.log('[BG] Offscreen document created.');
  } catch (e) {
    console.error('[BG] Failed to create offscreen document:', e);
  }
}

// デスクトップ通知の表示
function showNotification(title, message) {
  const notificationId = 'tabelog_crawl_' + Date.now();
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: title,
    message: message
  });
}

// CSVの文字列生成
function generateCSV(data) {
  const headers = ['name', 'genre', 'address', 'phone', 'raw_business_hours', 'normalized_business_hours', 'normalized_closed_days', 'business_hours_note', 'url', 'source'];
  const ef = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('\n') || s.includes('"'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };
  const rows = data.map(r => headers.map(h => ef(r[h])).join(','));
  return '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
}

// CSV 自動ダウンロードの実行
async function triggerDownload(results, metadata) {
  if (!results || results.length === 0) return;

  const csv = generateCSV(results);
  const base64 = btoa(unescape(encodeURIComponent(csv)));
  const dataUrl = 'data:text/csv;charset=utf-8;base64,' + base64;

  const area = metadata.area || '不明';
  const industry = metadata.industry || '飲食店';
  const media = metadata.media === 'tabelog' ? '食べログ' : (metadata.media === 'hotpepper' ? 'ホットペッパー' : '媒体不明');
  
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const filename = `${area}_${industry}_${media}_${ts}.csv`;

  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false // 自動保存
    });
    console.log('[BG] ダウンロードに成功しました:', filename);
  } catch (err) {
    console.error('[BG] ダウンロードに失敗しました:', err);
  }
}

// メッセージ中継ロジック
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 1. Offscreen から Background (ここ) へのシステムリクエスト、またはPopupへの進捗転送
  if (message.target === 'background') {
    if (message.type === 'DOWNLOAD_CSV') {
      triggerDownload(message.results, message.metadata);
      // Popupが閉じている場合を想定してローカルストレージにも結果を保存
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
      // Popup（画面）が開いていれば進捗を送る
      chrome.runtime.sendMessage({
        tabId: message.tabId,
        type: message.type,
        ...message.payload
      }).catch(() => { /* Popupが閉じている場合はスキップ */ });
    }
    sendResponse({ ok: true });
    return true;
  }

  // 2. Popup からの指示を Offscreen へ右から左に中継
  if (message.action === 'START_CRAWL') {
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
    return true; // 非同期レスポンスを有効化
  }
});
