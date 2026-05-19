/**
 * popup.js
 * クロール制御 UI ロジック
 */

// ============================================================
// DOM
// ============================================================
const maxSlider     = document.getElementById('maxSlider');
const maxVal        = document.getElementById('maxVal');
const dot           = document.getElementById('dot');
const statusMain    = document.getElementById('statusMain');
const statusSub     = document.getElementById('statusSub');
const progressBar   = document.getElementById('progressBar');
const logScroll     = document.getElementById('logScroll');
const startBtn      = document.getElementById('startBtn');
const stopBtn       = document.getElementById('stopBtn');
const dlBtn         = document.getElementById('dlBtn');
const previewSection= document.getElementById('previewSection');
const previewList   = document.getElementById('previewList');

// ============================================================
// 状態
// ============================================================
let allResults   = [];
let isRunning    = false;
let maxItems     = Infinity;
let currentTabId = null;
let metadata     = { area: '', industry: '', media: '' };

// ============================================================
// スライダー
// ============================================================
maxSlider.addEventListener('input', () => {
  maxItems = parseInt(maxSlider.value);
  maxVal.textContent = maxItems + '件';
});

// ============================================================
// ログ出力
// ============================================================
function addLog(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = `[${time}] ${msg}`;
  logScroll.appendChild(line);
  logScroll.scrollTop = logScroll.scrollHeight;
  while (logScroll.children.length > 300) logScroll.removeChild(logScroll.firstChild);
}

// ============================================================
// ステータス更新
// ============================================================
function setStatus(state, main, sub = '') {
  dot.className = `dot ${state}`;
  statusMain.textContent = main;
  statusSub.textContent  = sub;
}

function updateProgress(collected, total) {
  if (total === Infinity) {
    progressBar.style.width = '100%';
    return;
  }
  const pct = total > 0 ? Math.min(100, Math.round(collected / total * 100)) : 0;
  progressBar.style.width = pct + '%';
}

// ============================================================
// プレビュー描画
// ============================================================
function renderPreview(data) {
  previewList.innerHTML = '';
  const items = data.slice(-30).reverse();
  items.forEach(r => {
    const el = document.createElement('div');
    el.className = 'preview-item';
    
    let hoursPreview = '';
    if (r.normalized_business_hours) {
      hoursPreview += `<div class="pi-hours" style="font-size: 10px; color: var(--muted); margin-top: 3px;">🕒 ${esc(r.normalized_business_hours.replace(/\n/g, ' | '))}</div>`;
    }
    if (r.normalized_closed_days) {
      hoursPreview += `<div class="pi-closed" style="font-size: 10px; color: var(--red); margin-top: 1px;">📅 定休日: ${esc(r.normalized_closed_days)}</div>`;
    }
    if (r.business_hours_note) {
      hoursPreview += `<div class="pi-note" style="font-size: 9px; color: var(--yellow); margin-top: 1px; opacity: 0.8;">📝 ${esc(r.business_hours_note.replace(/\n/g, ' | '))}</div>`;
    }

    el.innerHTML = `
      <div class="pi-name">${esc(r.name)}</div>
      <div class="pi-meta">
        ${r.address ? esc(r.address) : '<span style="opacity:.5">住所なし</span>'}
        ${r.phone ? `<span class="pi-phone"> · 📞 ${esc(r.phone)}</span>` : ''}
        ${hoursPreview}
      </div>
    `;
    previewList.appendChild(el);
  });
  previewSection.style.display = 'block';
}

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
// CSV 生成・ダウンロード
// ============================================================
function toCSV(data) {
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

function downloadCSV() {
  if (!allResults.length) return;
  const csv  = toCSV(allResults);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  
  const area = metadata.area || '不明';
  const industry = metadata.industry || '飲食店';
  const media = metadata.media === 'tabelog' ? '食べログ' : (metadata.media === 'hotpepper' ? 'ホットペッパー' : '媒体不明');
  
  const now  = new Date();
  const ts   = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${area}_${industry}_${media}_${ts}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  addLog(`CSV ダウンロード: ${allResults.length}件`, 'good');
}

// ============================================================
// ボタン状態切り替え
// ============================================================
function setButtons(running) {
  isRunning        = running;
  startBtn.disabled = running;
  stopBtn.disabled  = !running;
  maxSlider.disabled = running;
}

// ============================================================
// background からのメッセージ受信
// ============================================================
chrome.runtime.onMessage.addListener((msg) => {
  // タブIDが一致しないメッセージは無視
  if (msg.tabId !== currentTabId) return;

  switch (msg.type) {
    case 'PAGE_START':
      addLog(`📄 ${msg.siteName ? msg.siteName + ' ' : ''}${msg.page}ページ目 開始 (取得済み: ${msg.collected}件)`, 'info');
      setStatus('running', `${msg.page}ページ目をクロール中...`, `取得済み ${msg.collected} 件`);
      break;

    case 'PROGRESS':
      addLog(`✅ ${msg.latest}`, 'good');
      setStatus('running', `取得中... ${msg.collected} 件`, `${msg.page}ページ目`);
      updateProgress(msg.collected, msg.maxItems);
      chrome.runtime.sendMessage({ action: 'GET_RESULTS', tabId: currentTabId }, res => {
        if (res?.results) {
          allResults = res.results;
          metadata = res.metadata || metadata;
          renderPreview(allResults);
          if (allResults.length > 0) dlBtn.disabled = false;
        }
      });
      break;

    case 'INFO':
      addLog(`ℹ️ ${msg.message}`, 'info');
      break;

    case 'ERROR':
      addLog(`❌ ${msg.message}`, 'err');
      setStatus('error', 'エラーが発生しました', msg.message);
      setButtons(false);
      break;

    case 'DONE':
      allResults = msg.results || allResults;
      metadata = msg.metadata || metadata;
      addLog(`🎉 完了！ 合計 ${allResults.length} 件取得`, 'good');
      setStatus('done', `取得完了 ${allResults.length} 件`, 'CSVダウンロードできます');
      updateProgress(allResults.length, maxItems);
      setButtons(false);
      renderPreview(allResults);
      if (allResults.length > 0) dlBtn.disabled = false;
      break;
  }
});

// ============================================================
// 取得開始
// ============================================================
function detectSite(url) {
  if (/tabelog\.com/.test(url)) return 'tabelog';
  if (/hotpepper\.jp/.test(url)) return 'hotpepper';
  return null;
}

startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    addLog('アクティブタブが見つかりません', 'err');
    return;
  }

  const url = tab.url || '';
  const siteType = detectSite(url);

  if (!siteType) {
    addLog('対応サイトの検索結果ページを開いてください', 'warn');
    setStatus('error', '対応サイトではありません', '食べログ・ホットペッパー専用です');
    return;
  }

  allResults = [];
  logScroll.innerHTML = '';
  previewList.innerHTML = '';
  previewSection.style.display = 'none';
  dlBtn.disabled = true;
  updateProgress(0, maxItems);

  const siteName = siteType === 'tabelog' ? '食べログ' : 'ホットペッパー';
  addLog(`${siteName} クロール開始 (上限なし)`, 'good');
  setStatus('running', `${siteName} をクロール中...`, `上限なし`);
  setButtons(true);

  chrome.runtime.sendMessage({
    action:   'START_CRAWL',
    tabId:    tab.id,
    listUrl:  tab.url,
    maxItems: maxItems,
  }, res => {
    if (!res?.ok) {
      addLog('クロール開始失敗: ' + (res?.error || '不明'), 'err');
      setButtons(false);
    }
  });
});

// ============================================================
// 停止
// ============================================================
stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'STOP_CRAWL', tabId: currentTabId });
  addLog('⏹ 停止リクエスト送信', 'warn');
  setStatus('idle', '停止中...', '');
  setButtons(false);
});

// ============================================================
// CSV ダウンロード
// ============================================================
dlBtn.addEventListener('click', downloadCSV);

// ============================================================
// 起動時
// ============================================================
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
    chrome.runtime.sendMessage({ action: 'GET_RESULTS', tabId: currentTabId }, res => {
      if (res?.results?.length) {
        allResults = res.results;
        metadata = res.metadata || metadata;
        renderPreview(allResults);
        dlBtn.disabled = false;
        if (!res.running) {
          setStatus('done', `前回の結果 ${allResults.length} 件`, 'CSVダウンロード可能');
          addLog(`前回の取得結果を復元: ${allResults.length} 件`, 'info');
        } else {
          setButtons(true);
          setStatus('running', 'クロール実行中...', '');
          addLog('クロール状況を復旧しました', 'info');
        }
        updateProgress(allResults.length, maxItems);
      }
    });
  }
})();
