/**
 * offscreen.js
 * 画面に干渉されず、完全に裏で高速並行 fetch と HTMLパースを行うコアスクリプト。
 * tabId ごとに独立して並行管理されるため、同時実行しても混ざりません。
 */

const activeTasks = new Map();
const CHUNK_SIZE = 3;              // ⚡️ 高速化：3件ずつ詳細ページを同時に並行 fetch
const DELAY_BETWEEN_CHUNKS = 1200; // チャンクごとの安全な待機秒数（ボット判定回避用）
const DELAY_LIST_FETCH = 1000;     // 一覧ページの取得待機秒数

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getSiteType(url) {
  if (/tabelog\.com/.test(url)) return 'tabelog';
  if (/hotpepper\.jp/.test(url)) return 'hotpepper';
  return null;
}

// Background経由で状態を送信
function sendToBackground(tabId, type, payload = {}) {
  chrome.runtime.sendMessage({
    target: 'background',
    tabId,
    type,
    payload
  }).catch(() => { });
}

// 検索条件（エリア・業種）の抽出
function extractMetadata(doc, siteType) {
  const meta = { area: '', industry: '' };
  if (siteType === 'tabelog') {
    meta.area = doc.querySelector('.list-condition__item--area')?.textContent?.trim() ||
      doc.querySelector('.c-link-arrow--back')?.textContent?.trim() || '';
    meta.industry = doc.querySelector('.list-condition__item--genre')?.textContent?.trim() || '';
  } else if (siteType === 'hotpepper') {
    meta.area = doc.querySelector('.current-area')?.textContent?.trim() || '';
    meta.industry = doc.querySelector('.current-genre')?.textContent?.trim() || '';
  }
  return meta;
}

// 食べログ: 店舗リンクの抽出
function tabelogGetLinks(doc) {
  const links = [];
  const RST_URL_RE = /tabelog\.com\/[a-z]+\/A\d+\/A\d+\/\d+\//;
  const primary = doc.querySelectorAll('.list-rst__rst-name-target, .js-rst-cassette-wrap .list-rst__name a, a.list-rst__name-main');
  primary.forEach(a => {
    const href = (a.href || '').split('?')[0];
    if (RST_URL_RE.test(href) && !links.includes(href)) links.push(href);
  });
  if (links.length === 0) {
    doc.querySelectorAll('a[href]').forEach(a => {
      const href = (a.href || '').split('?')[0];
      if (RST_URL_RE.test(href) && !links.includes(href)) links.push(href);
    });
  }
  return links;
}

// 食べログ: 次ページのURL抽出
function tabelogGetNextUrl(doc) {
  const nextBtn = doc.querySelector('a.c-pagination__arrow--next') || doc.querySelector('.c-pagination__arrow--next a');
  return nextBtn && !nextBtn.classList.contains('is-disabled') ? nextBtn.href : null;
}

// ホットペッパー: 店舗リンクの抽出
function hotpepperGetLinks(doc) {
  const links = [];
  const anchors = doc.querySelectorAll('.shopDetailTop a, .shopName a, h3.shopName a, a.shopDetailLink, .list-cassette__unit a');
  anchors.forEach(a => {
    let href = (a.href || '').split('?')[0].split('#')[0];
    if (/^https:\/\/www\.hotpepper\.jp\/(strJ[A-Z0-9]+|A[A-Z0-9]+)\/?$/.test(href)) {
      if (!href.endsWith('/')) href += '/';
      if (!links.includes(href)) links.push(href);
    }
  });
  return links;
}

// ホットペッパー: 次ページのURL抽出
function hotpepperGetNextUrl(doc) {
  const pagerContainers = doc.querySelectorAll('.pageLinkLinearBasic, .pagination, .pager, .page-list, .pageList, .page-link');
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

// 詳細ページのHTMLを直接 fetch して店舗情報を解析
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

    // ==========================================
    // 食べログの解析ロジック
    // ==========================================
    if (siteType === 'tabelog') {
      name = doc.querySelector('.display-name')?.textContent?.trim() || doc.title.split('|')[0].trim();
      address = doc.querySelector('p.rstinfo-table__address')?.textContent?.trim() || '';
      let realPhone = '';
      let reservePhone = '';
      let fallbackPhone = doc.querySelector('.rstinfo-table__tel-num')?.textContent?.trim() || '';

      // 営業時間と定休日を別々の変数で確実にキャッチする（上書きバグの修正）
      let tHours = '';
      let tClosed = '';

      doc.querySelectorAll('th').forEach(th => {
        const t = th.textContent.trim();
        if (t === 'ジャンル') genre = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('住所') && !address) address = th.nextElementSibling?.textContent?.trim() || '';
        if (t === '電話番号') realPhone = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('予約・お問い合わせ') || t.includes('予約')) reservePhone = th.nextElementSibling?.textContent?.trim() || '';
        if (t === '営業時間') tHours = th.nextElementSibling?.textContent?.trim() || '';
        if (t === '定休日') tClosed = th.nextElementSibling?.textContent?.trim() || '';
      });

      phone = realPhone || reservePhone || fallbackPhone;
      address = address.replace(/大きな地図を見る/g, '').replace(/周辺のお店を探す/g, '').replace(/\s+/g, ' ').trim();
      phone = phone.replace(/[^\d\-]/g, '');

      // 正規化フィルターが1発で定休日と時間を分離できるように、明示的な見出しを付けて結合
      let combinedText = '';
      if (tHours) combinedText += `【営業時間】${tHours} `;
      if (tClosed) combinedText += `【定休日】${tClosed}`;
      combinedText = combinedText.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

      return { name, genre, address, phone, business_hours: combinedText, url: link, source: 'tabelog' };
    }

    // ==========================================
    // ホットペッパーの解析ロジック（完全復活）
    // ==========================================
    else if (siteType === 'hotpepper') {
      const shopInner = doc.querySelector('.shopInner.meiryoFont') || doc.querySelector('.shopDetailInnerTop') || doc;
      name = shopInner.querySelector('.shopName')?.textContent?.trim() || doc.querySelector('h1')?.textContent?.trim() || doc.title.split('|')[0].trim();
      let businessHours = '';
      let regularHoliday = '';

      shopInner.querySelectorAll('th').forEach(th => {
        const t = th.textContent.trim();
        if (t === '店名' && (!name || name === doc.title.split('|')[0].trim())) name = th.nextElementSibling?.textContent?.trim() || name;
        if (t.includes('住所') && !address) address = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('電話') && !phone) phone = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('営業時間')) businessHours = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('定休日')) regularHoliday = th.nextElementSibling?.textContent?.trim() || '';
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
        } catch (e) { }
      }
      address = address.replace(/地図を見る/g, '').replace(/\s+/g, ' ').replace(/\n/g, '').trim();
      phone = phone.replace(/[^\d\-]/g, '');
      name = name.replace(/\n/g, '').trim();

      let combinedHours = '';
      if (businessHours) combinedHours += `【営業時間】${businessHours} `;
      if (regularHoliday) combinedHours += `【定休日】${regularHoliday}`;
      combinedHours = combinedHours.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

      return { name, genre, address, phone, business_hours: combinedHours, url: link, source: 'hotpepper' };
    }
  } catch (e) {
    return { name: '', genre: '', address: '', phone: '', business_hours: '', url: link, source: siteType, _error: e.message };
  }
}

// メインクロールタスク
async function runCrawlTask(tabId) {
  const task = activeTasks.get(tabId);
  if (!task) return;

  let collected = 0;
  let pageNum = 1;
  let currentListUrl = task.listUrl;

  try {
    while (task.running && collected < task.maxItems) {
      const siteType = getSiteType(currentListUrl);
      if (!siteType) {
        sendToBackground(tabId, 'ERROR', { message: '対応サイトではありません' });
        break;
      }

      const siteName = siteType === 'tabelog' ? '食べログ' : 'ホットペッパー';
      sendToBackground(tabId, 'PAGE_START', { page: pageNum, collected, siteName });

      // 一覧ページのHTMLを fetch
      await sleep(DELAY_LIST_FETCH);
      const res = await fetch(currentListUrl);
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      // メタデータの抽出（初回のみ）
      if (pageNum === 1) {
        const meta = extractMetadata(doc, siteType);
        if (meta.area || meta.industry) task.metadata = { ...task.metadata, ...meta };
        if (!task.metadata.area || !task.metadata.industry) {
          const parts = doc.title.split(' ');
          if (parts.length >= 2) {
            if (!task.metadata.area) task.metadata.area = parts[0];
            if (!task.metadata.industry) task.metadata.industry = parts[1];
          }
        }
      }

      const getLinks = siteType === 'tabelog' ? tabelogGetLinks : hotpepperGetLinks;
      let links = getLinks(doc) || [];

      const existingUrls = new Set(task.results.map(r => r.url));
      links = links.filter(l => !existingUrls.has(l.split('?')[0]));

      const remaining = task.maxItems - collected;
      links = links.slice(0, remaining);

      if (links.length === 0) {
        sendToBackground(tabId, 'INFO', { message: `${pageNum}ページ目: 新規リンクなし → 終了` });
        break;
      }

      sendToBackground(tabId, 'INFO', { message: `${pageNum}ページ目: ${links.length}件のリンクを並行取得中...` });

      // ⚡️ 複数件（CHUNK_SIZE）を同時に並行 fetch して超高速化
      for (let i = 0; i < links.length; i += CHUNK_SIZE) {
        if (!task.running) break;
        const chunk = links.slice(i, i + CHUNK_SIZE);

        await Promise.all(chunk.map(async (link) => {
          if (!task.running) return;
          try {
            const detail = await fetchAndParseDetail(link, siteType);
            if (detail && detail.name) {
              // 営業時間と定休日の正規化スクリプトを実行
              const normalized = normalizeBusinessHours(detail.business_hours || '');

              // 裏側のシステムで扱う英語のデータ構造（前回の構成を維持）
              const finalDetail = {
                name: detail.name,
                genre: detail.genre,
                address: detail.address,
                phone: detail.phone,
                regular_holiday: normalized.normalized_closed_days || '情報なし',
                opening_hours_details: normalized.normalized_business_hours || '情報なし',
                url: detail.url,
                source: detail.source // 自動的に 'tabelog' または 'hotpepper' が入ります
              };
              task.results.push(finalDetail);
              collected++;

              sendToBackground(tabId, 'PROGRESS', {
                collected,
                maxItems: task.maxItems,
                latest: detail.name,
                page: pageNum,
              });
            }
          } catch (err) {
            console.error('詳細パース失敗:', err);
          }
        }));

        await sleep(DELAY_BETWEEN_CHUNKS);
      }

      if (!task.running || collected >= task.maxItems) break;

      // 画面のタブを遷移させず、HTML内の「次へ」のリンクURLを読み取って次の処理へ
      const getNextUrl = siteType === 'tabelog' ? tabelogGetNextUrl : hotpepperGetNextUrl;
      const nextUrl = getNextUrl(doc);
      if (!nextUrl) {
        sendToBackground(tabId, 'INFO', { message: '最終ページに達しました' });
        break;
      }

      currentListUrl = nextUrl;
      pageNum++;
    }
  } catch (err) {
    console.error('バックグラウンド処理エラー:', err);
    sendToBackground(tabId, 'ERROR', { message: err.message });
  } finally {
    task.running = false;

    // Popupに完了を通知
    sendToBackground(tabId, 'DONE', {
      collected: task.results.length,
      results: task.results,
      metadata: task.metadata
    });

    const mediaName = task.metadata.media === 'tabelog' ? '食べログ' : (task.metadata.media === 'hotpepper' ? 'ホットペッパー' : 'サイト');
    const area = task.metadata.area || '';
    const industry = task.metadata.industry || '';
    const count = task.results.length;

    let title = '取得完了';
    let message = `${area} ${industry} (${mediaName}) の取得が完了しました。計 ${count} 件`;

    if (collected >= task.maxItems) {
      title = '取得完了 (上限到達)';
    } else if (collected < task.maxItems) {
      title = '取得停止';
      message = `${area} ${industry} (${mediaName}) の取得を停止しました。計 ${count} 件取得済み`;
    }

    // ダウンロードとデスクトップ通知をBackgroundに依頼
    chrome.runtime.sendMessage({ target: 'background', type: 'SHOW_NOTIFICATION', title, message });
    if (task.results.length > 0) {
      chrome.runtime.sendMessage({ target: 'background', type: 'DOWNLOAD_CSV', results: task.results, metadata: task.metadata, tabId });
    }
  }
}

// 各種メッセージ受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

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
      maxItems: message.maxItems || Infinity,
      metadata: {
        media: siteType,
        area: '',
        industry: ''
      }
    });

    runCrawlTask(tabId);
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
      sendResponse({ results: [], running: false, metadata: {} });
    }
    return;
  }
});