/**
 * background.js  (Service Worker)
 *
 * クロール全体の司令塔。
 * - popup.js からの START / STOP メッセージを受け取る
 * - content.js に一覧取得・詳細取得・次ページ遷移を順番に指示
 * - 取得済みデータを chrome.storage.session に蓄積
 * - 進捗を popup.js にブロードキャスト
 */

// ============================================================
// 定数
// ============================================================
const DELAY_DETAIL = 1500;  // 詳細ページ滞在時間 (ms)
const DELAY_LIST = 1500;  // 一覧ページ読み込み待機 (ms)
const DELAY_NAVIGATE = 2000;  // ページ遷移後の安定待機 (ms)
const MAX_DEFAULT = Infinity;   // デフォルト最大取得件数

// ============================================================
// 状態 (タブごとのタスク管理)
// ============================================================
const activeTasks = new Map();

// ============================================================
// ユーティリティ
// ============================================================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 指定タブでスクリプトを実行して結果を返す */
async function execInTab(tabId, func, args = []) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func,
      args,
    });
    return results?.[0]?.result;
  } catch (e) {
    console.error('[BG] execInTab error:', e);
    return null;
  }
}

/** タブが完全にロードされるまで待機 */
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // タイムアウトしても続行
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Popup へ進捗を送信 (tabId を含める) */
function broadcast(tabId, type, payload = {}) {
  chrome.runtime.sendMessage({ tabId, type, ...payload }).catch(() => {
    // popup が閉じている場合は無視
  });
}

/** 通知を表示 */
function showNotification(title, message) {
  const notificationId = 'tabelog_crawl_' + Date.now();
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'), // More reliable in MV3
    title: title,
    message: message,
    priority: 2
  }, (id) => {
    if (chrome.runtime.lastError) {
      console.error('[BG] Notification Error:', chrome.runtime.lastError);
    } else {
      console.log('[BG] Notification shown:', id);
    }
  });
}

/** CSV 生成 */
function generateCSV(data) {
  const headers = ['name', 'genre', 'address', 'phone', 'url', 'source'];
  const ef = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('\n') || s.includes('"'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };
  const rows = data.map(r => headers.map(h => ef(r[h])).join(','));
  return '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
}

/** 自動ダウンロード実行 */
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
    console.log('[BG] 自動ダウンロード開始:', filename);
  } catch (err) {
    console.error('[BG] ダウンロード失敗:', err);
  }
}

// ============================================================
// メタデータ抽出 (エリア・業種)
// ============================================================
function extractPageMetadata() {
  const meta = {
    area: '',
    industry: ''
  };

  if (location.hostname.includes('tabelog.com')) {
    // 食べログ
    meta.area = document.querySelector('.list-condition__item--area')?.textContent?.trim() || 
                document.querySelector('.c-link-arrow--back')?.textContent?.trim() || '';
    meta.industry = document.querySelector('.list-condition__item--genre')?.textContent?.trim() || '';
    
    // title からの補完 (例: 銀座 カレー 検索結果一覧)
    if (!meta.area || !meta.industry) {
      const parts = document.title.split(' ');
      if (parts.length >= 2) {
        if (!meta.area) meta.area = parts[0];
        if (!meta.industry) meta.industry = parts[1];
      }
    }
  } else if (location.hostname.includes('hotpepper.jp')) {
    // ホットペッパー
    meta.area = document.querySelector('.current-area')?.textContent?.trim() || '';
    meta.industry = document.querySelector('.current-genre')?.textContent?.trim() || '';
    
    if (!meta.area || !meta.industry) {
      const parts = document.title.split(' ');
      if (parts.length >= 2) {
        if (!meta.area) meta.area = parts[0];
        if (!meta.industry) meta.industry = parts[1];
      }
    }
  }
  
  return meta;
}

// ============================================================
// 食べログ: 一覧ページから店舗URLリストを収集
// ============================================================
function tabelogGetLinks() {
  const links = [];
  const RST_URL_RE = /tabelog\.com\/[a-z]+\/A\d+\/A\d+\/\d+\//;
  const primary = document.querySelectorAll(
    '.list-rst__rst-name-target, ' +
    '.js-rst-cassette-wrap .list-rst__name a, ' +
    'a.list-rst__name-main'
  );
  primary.forEach(a => {
    const href = (a.href || '').split('?')[0];
    if (RST_URL_RE.test(href) && !links.includes(href)) links.push(href);
  });
  if (links.length === 0) {
    document.querySelectorAll('a[href]').forEach(a => {
      const href = (a.href || '').split('?')[0];
      if (RST_URL_RE.test(href) && !links.includes(href)) links.push(href);
    });
  }
  return links;
}

/** 詳細ページのHTMLをfetchして解析 */
async function fetchAndParseDetail(link, siteType) {
  try {
    const res = await fetch(link);
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    let name = '';
    let genre = '';
    let address = '';
    let phone = '';

    if (siteType === 'tabelog') {
      name = doc.querySelector('.display-name')?.textContent?.trim() || doc.title.split('|')[0].trim();
      address = doc.querySelector('p.rstinfo-table__address')?.textContent?.trim() || '';
      let realPhone = '';
      let reservePhone = '';
      let fallbackPhone = doc.querySelector('.rstinfo-table__tel-num')?.textContent?.trim() || '';
      doc.querySelectorAll('th').forEach(th => {
        const t = th.textContent.trim();
        if (t === 'ジャンル') genre = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('住所') && !address) address = th.nextElementSibling?.textContent?.trim() || '';
        if (t === '電話番号') realPhone = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('予約・お問い合わせ') || t.includes('予約')) reservePhone = th.nextElementSibling?.textContent?.trim() || '';
      });
      phone = realPhone || reservePhone || fallbackPhone;
      address = address.replace(/大きな地図を見る/g, '').replace(/周辺のお店を探す/g, '').replace(/\s+/g, ' ').trim();
      phone = phone.replace(/[^\d\-]/g, '');
      return { name, genre, address, phone, url: link, source: 'tabelog' };
    } else if (siteType === 'hotpepper') {
      const shopInner = doc.querySelector('.shopInner.meiryoFont') || doc.querySelector('.shopDetailInnerTop') || doc;
      name = shopInner.querySelector('.shopName')?.textContent?.trim() || doc.querySelector('h1')?.textContent?.trim() || doc.title.split('|')[0].trim();
      shopInner.querySelectorAll('th').forEach(th => {
        const t = th.textContent.trim();
        if (t === '店名' && (!name || name === doc.title.split('|')[0].trim())) name = th.nextElementSibling?.textContent?.trim() || name;
        if (t.includes('住所') && !address) address = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('電話') && !phone) phone = th.nextElementSibling?.textContent?.trim() || '';
      });
      if (!address) address = shopInner.querySelector('.shopDetailInfoAddress')?.textContent?.trim() || shopInner.querySelector('.address')?.textContent?.trim() || '';
      if (!phone) {
        phone = shopInner.querySelector('.shopDetailInfoTel')?.textContent?.trim() || shopInner.querySelector('.tel')?.textContent?.trim() || shopInner.querySelector('a[href^="tel:"]')?.textContent?.trim() || '';
      }
      if (!phone || phone.includes('電話番号を表示する')) {
        try {
          const telUrl = (link.endsWith('/') ? link : link + '/') + 'tel/';
          const telRes = await fetch(telUrl);
          const telHtml = await telRes.text();
          const telDoc = new DOMParser().parseFromString(telHtml, "text/html");
          const telNode = telDoc.querySelector('.telephoneNumber') || telDoc.querySelector('.tel');
          if (telNode) phone = telNode.textContent.trim();
        } catch(e) {}
      }
      address = address.replace(/地図を見る/g, '').replace(/\s+/g, ' ').replace(/\n/g, '').trim();
      phone = phone.replace(/[^\d\-]/g, '');
      name = name.replace(/\n/g, '').trim();
      return { name, genre, address, phone, url: link, source: 'hotpepper' };
    }
  } catch(e) {
    return { name: '', genre: '', address: '', phone: '', url: link, source: siteType, _error: e.message };
  }
}

function tabelogClickNext() {
  const nextBtn = document.querySelector('a.c-pagination__arrow--next') || document.querySelector('.c-pagination__arrow--next a');
  return nextBtn && !nextBtn.classList.contains('is-disabled') ? nextBtn.href : null;
}

function hotpepperGetLinks() {
  const links = [];
  const anchors = document.querySelectorAll('.shopDetailTop a, .shopName a, h3.shopName a, a.shopDetailLink, .list-cassette__unit a');
  anchors.forEach(a => {
    let href = (a.href || '').split('?')[0].split('#')[0];
    if (/^https:\/\/www\.hotpepper\.jp\/(strJ[A-Z0-9]+|A[A-Z0-9]+)\/?$/.test(href)) {
      if (!href.endsWith('/')) href += '/';
      if (!links.includes(href)) links.push(href);
    }
  });
  return links;
}

function hotpepperClickNext() {
  const pagerContainers = document.querySelectorAll('.pageLinkLinearBasic, .pagination, .pager, .page-list, .pageList, .page-link');
  let nextBtn = null;
  for (const container of pagerContainers) {
    const anchors = Array.from(container.querySelectorAll('a'));
    nextBtn = anchors.find(a => a.textContent.includes('次') || a.getAttribute('rel') === 'next');
    if (nextBtn) break;
  }
  if (!nextBtn) {
    const anchors = Array.from(document.querySelectorAll('a.pa_next, a[rel="next"]'));
    nextBtn = anchors.find(a => a.textContent.includes('次') || a.getAttribute('rel') === 'next' || a.classList.contains('pa_next'));
  }
  return nextBtn ? nextBtn.href : null;
}

function getSiteType(url) {
  if (/tabelog\.com/.test(url)) return 'tabelog';
  if (/hotpepper\.jp/.test(url)) return 'hotpepper';
  return null;
}

// ============================================================
// メインクロールループ
// ============================================================
async function runCrawl(tabId) {
  const task = activeTasks.get(tabId);
  if (!task) return;

  let collected = 0;
  let pageNum = 1;

  try {
    // メタデータ抽出
    const meta = await execInTab(tabId, extractPageMetadata);
    if (meta) task.metadata = { ...task.metadata, ...meta };

    while (task.running && collected < task.maxItems) {
      const tab = await chrome.tabs.get(tabId);
      const siteType = getSiteType(tab.url);
      if (!siteType) {
        broadcast(tabId, 'ERROR', { message: '対応サイトではありません' });
        break;
      }

      const siteName = siteType === 'tabelog' ? '食べログ' : 'ホットペッパー';
      broadcast(tabId, 'PAGE_START', { page: pageNum, collected, siteName });

      await sleep(DELAY_LIST);
      const getLinks = siteType === 'tabelog' ? tabelogGetLinks : hotpepperGetLinks;
      let links = await execInTab(tabId, getLinks) || [];

      const existingUrls = new Set(task.results.map(r => r.url));
      links = links.filter(l => !existingUrls.has(l.split('?')[0]));

      const remaining = task.maxItems - collected;
      links = links.slice(0, remaining);

      if (links.length === 0) {
        broadcast(tabId, 'INFO', { message: `${pageNum}ページ目: 新規リンクなし → 終了` });
        break;
      }

      broadcast(tabId, 'INFO', { message: `${pageNum}ページ目: ${links.length}件のリンクを取得` });

      for (const link of links) {
        if (!task.running) break;
        try {
          const detail = await execInTab(tabId, fetchAndParseDetail, [link, siteType]);
          if (detail && detail.name) {
            task.results.push(detail);
            collected++;
            broadcast(tabId, 'PROGRESS', {
              collected,
              maxItems: task.maxItems,
              latest: detail.name,
              page: pageNum,
            });
          }
          await sleep(500);
        } catch (err) {
          console.error('[BG] 詳細ページエラー:', link, err);
        }
      }

      if (!task.running || collected >= task.maxItems) break;

      const clickNext = siteType === 'tabelog' ? tabelogClickNext : hotpepperClickNext;
      const nextUrl = await execInTab(tabId, clickNext);
      if (!nextUrl) {
        broadcast(tabId, 'INFO', { message: '最終ページに達しました' });
        break;
      }

      await chrome.tabs.update(tabId, { url: nextUrl });
      await waitForTabLoad(tabId);
      await sleep(DELAY_NAVIGATE);
      pageNum++;
    }
  } catch (err) {
    console.error('[BG] クロールエラー:', err);
    broadcast(tabId, 'ERROR', { message: err.message });
  } finally {
    task.running = false;
    
    // UI更新用のブロードキャスト
    broadcast(tabId, 'DONE', {
      collected: task.results.length,
      results: task.results,
      metadata: task.metadata
    });
    
    // 通知
    const mediaName = task.metadata.media === 'tabelog' ? '食べログ' : (task.metadata.media === 'hotpepper' ? 'ホットペッパー' : 'サイト');
    const area = task.metadata.area || '';
    const industry = task.metadata.industry || '';
    const count = task.results.length;
    
    let title = 'クロール完了';
    let message = `${area} ${industry} (${mediaName}) の取得が完了しました。計 ${count} 件`;
    
    if (collected >= task.maxItems) {
      title = 'クロール完了 (上限到達)';
    } else if (!task.running && collected < task.maxItems) {
      // 途中で止まった場合 (ユーザー操作またはエラー)
      title = 'クロール停止';
      message = `${area} ${industry} (${mediaName}) の取得を停止しました。計 ${count} 件取得済み`;
    }

    showNotification(title, message);

    // 自動ダウンロード実行
    if (task.results.length > 0) {
      triggerDownload(task.results, task.metadata);
      
      // ストレージに保存 (再起動時の復元用)
      chrome.storage.local.set({
        [`last_results_${tabId}`]: {
          results: task.results,
          metadata: task.metadata,
          timestamp: Date.now()
        }
      });
    }
  }
}

// ============================================================
// メッセージリスナー
// ============================================================
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const tabId = message.tabId;

  if (message.action === 'START_CRAWL') {
    if (activeTasks.get(tabId)?.running) {
      sendResponse({ ok: false, error: 'このタブで既に実行中です' });
      return;
    }
    const siteType = getSiteType(message.listUrl);
    activeTasks.set(tabId, {
      running: true,
      tabId: tabId,
      listUrl: message.listUrl,
      results: [],
      maxItems: message.maxItems || MAX_DEFAULT,
      metadata: {
        media: siteType,
        area: '',
        industry: ''
      }
    });
    runCrawl(tabId);
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'STOP_CRAWL') {
    const task = activeTasks.get(tabId);
    if (task) task.running = false;
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'GET_RESULTS') {
    const task = activeTasks.get(tabId);
    if (task) {
      sendResponse({ 
        results: task.results || [], 
        running: task.running || false,
        metadata: task.metadata || {}
      });
    } else {
      // メモリにない場合はストレージから取得を試みる
      chrome.storage.local.get([`last_results_${tabId}`], (data) => {
        const saved = data[`last_results_${tabId}`];
        sendResponse({
          results: saved?.results || [],
          running: false,
          metadata: saved?.metadata || {}
        });
      });
      return true; // 非同期レスポンス
    }
    return;
  }

  return true;
});
