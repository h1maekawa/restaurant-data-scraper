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

// CSVの文字列生成（営業システム・日本語ヘッダー完全統一版）
function generateCSV(data) {
  // ============================================================
  // CSVの一行目（見出し）を日本語に翻訳・統一
  // 順番：店名,ジャンル,住所,電話番号,定休日,営業時間,URL,媒体
  // ============================================================
  const headers = ['店名', 'ジャンル', '住所', '電話番号', '定休日', '営業時間', 'URL', '媒体'];

  // ============================================================
  // 裏側のシステム（offscreen.jsの英語キー）とのマッピング定義
  // offscreen.js の finalDetail オブジェクトのキー名と完全一致させること
  // ============================================================
  const keyMapping = {
    '店名':   'name',
    'ジャンル': 'genre',
    '住所':   'address',
    '電話番号': 'phone',
    '定休日':  'regular_holiday',         // offscreen.js: finalDetail.regular_holiday
    '営業時間': 'opening_hours_details',   // offscreen.js: finalDetail.opening_hours_details
    'URL':    'url',
    '媒体':   'source'
  };

  // CSVエスケープ関数（カンマ・改行・ダブルクォートを含む値を安全にエスケープ）
  const escapeField = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('\n') || s.includes('"'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };

  // 日本語ヘッダーの並び順に合わせて、裏側の英語データを抽出して1行にする
  const rows = data.map(r =>
    headers.map(h => escapeField(r[keyMapping[h]])).join(',')
  );

  // BOM付きUTF-8 (Excelでの文字化けを防止)
  return '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
}

// CSV 自動ダウンロードの実行
async function triggerDownload(results, metadata) {
  if (!results || results.length === 0) return;

  const csv = generateCSV(results);
  const base64 = btoa(unescape(encodeURIComponent(csv)));
  const dataUrl = 'data:text/csv;charset=utf-8;base64,' + base64;

  const area     = metadata.area     || '不明';
  const industry = metadata.industry || '飲食店';
  const media    = metadata.media === 'tabelog'
    ? '食べログ'
    : (metadata.media === 'hotpepper' ? 'ホットペッパー' : '媒体不明');

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
          results:   message.results,
          metadata:  message.metadata,
          timestamp: Date.now()
        }
      });
    } else if (message.type === 'SHOW_NOTIFICATION') {
      showNotification(message.title, message.message);
    } else {
      // Popup（画面）が開いていれば進捗を送る
      chrome.runtime.sendMessage({
        tabId: message.tabId,
        type:  message.type,
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