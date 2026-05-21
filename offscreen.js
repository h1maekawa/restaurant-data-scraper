/**
 * offscreen.js
 * 画面に干渉されず、完全に裏で高速並行 fetch と HTMLパースを行うコアスクリプト。
 * tabId ごとに独立して並行管理されるため、同時実行しても混ざりません。
 *
 * 【修正履歴】
 * - hotpepperGetNextUrl: document.querySelectorAll → doc.querySelectorAll (致命的バグ修正)
 * - fetchAndParseDetail (hotpepper): genre 抽出ロジックを追加
 * - fetchAndParseDetail (tabelog): .rstinfo-table__business-item の全件ループ処理を強化
 * - fetchAndParseDetail (hotpepper): .telLink 二段階遷移 fetch に sleep(500) を確実に挿入
 */

const activeTasks = new Map();
const CHUNK_SIZE = 3;              // 3件ずつ詳細ページを同時に並行 fetch
const DELAY_BETWEEN_CHUNKS = 1500; // 安全性強化：ボット判定を確実に回避する待機秒数
const DELAY_LIST_FETCH = 1200;     // 一覧ページの取得待機秒数

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

// ============================================================
// 食べログ: 店舗リンクの抽出
// ============================================================
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

// ============================================================
// 食べログ: 次ページのURL抽出
// ============================================================
function tabelogGetNextUrl(doc) {
  const nextBtn = doc.querySelector('a.c-pagination__arrow--next') || doc.querySelector('.c-pagination__arrow--next a');
  return nextBtn && !nextBtn.classList.contains('is-disabled') ? nextBtn.href : null;
}

// ============================================================
// ホットペッパー: 店舗リンクの抽出
// ============================================================
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

// ============================================================
// ホットペッパー: 次ページのURL抽出
// 【バグ修正】document.querySelectorAll → doc.querySelectorAll
// ============================================================
function hotpepperGetNextUrl(doc) {
  const pagerContainers = doc.querySelectorAll('.pageLinkLinearBasic, .pagination, .pager, .page-list, .pageList, .page-link');
  let nextBtn = null;
  for (const container of pagerContainers) {
    const anchors = Array.from(container.querySelectorAll('a'));
    nextBtn = anchors.find(a => a.textContent.includes('次') || a.getAttribute('rel') === 'next');
    if (nextBtn) break;
  }
  if (!nextBtn) {
    // 修正前: document.querySelectorAll (グローバルDOMを参照していた致命的バグ)
    // 修正後: doc.querySelectorAll (パース済みのHTMLドキュメントを正しく参照)
    const anchors = Array.from(doc.querySelectorAll('a.pa_next, a[rel="next"]'));
    nextBtn = anchors.find(a =>
      a.textContent.includes('次') ||
      a.getAttribute('rel') === 'next' ||
      a.classList.contains('pa_next')
    );
  }
  return nextBtn ? nextBtn.href : null;
}

// ============================================================
// 詳細ページのHTMLを直接 fetch して店舗情報を解析（超高精度・鉄壁仕様）
// ============================================================
async function fetchAndParseDetail(link, siteType) {
  try {
    const res = await fetch(link);
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    let name = '';
    let genre = '';
    let address = '';
    let phone = '';

    // ============================================================
    // 1. 食べログの解析ロジック（曜日ごとの営業カレンダー・新構造テーブル完全対応）
    // ============================================================
    if (siteType === 'tabelog') {
      name    = doc.querySelector('.display-name')?.textContent?.trim() || doc.title.split('|')[0].trim();
      address = doc.querySelector('p.rstinfo-table__address')?.textContent?.trim() || '';

      // ① 電話番号の最優先狙い撃ち（指定クラス名: rstinfo-table__tel-num）
      let realPhone    = doc.querySelector('.rstinfo-table__tel-num')?.textContent?.trim() || '';
      let reservePhone = '';
      let fallbackPhone = '';

      let tHours  = '';
      let tClosed = '';

      // ② 曜日ごとの営業時間カレンダー（rstinfo-table__business-item）を querySelectorAll で全件ループ処理
      //    食べログ新UIでは、営業時間がテーブルではなくこの独立ブロックに分散して配置されている
      const businessItems = doc.querySelectorAll('.rstinfo-table__business-item');
      if (businessItems.length > 0) {
        const itemsArray = [];
        businessItems.forEach(item => {
          // 各ブロック内の余分な空白・改行を正規化して連結
          const txt = item.textContent.trim().replace(/\s+/g, ' ');
          if (txt) itemsArray.push(txt);
        });
        // 全曜日分の日にちと時間を1つの文字列に結合して格納
        tHours = itemsArray.join(' | ');
      }

      // ③ テーブルスキャン（ジャンル・定休日の取得 & 営業時間の強力フォールバック）
      doc.querySelectorAll('.rstinfo-table__table th, table th').forEach(th => {
        const t = th.textContent.trim();
        if (t.includes('ジャンル'))            genre   = th.nextElementSibling?.textContent?.trim() || genre;
        if (t.includes('住所') && !address)    address = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('電話番号') && !realPhone) realPhone = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('予約') || t.includes('お問い合わせ')) reservePhone = th.nextElementSibling?.textContent?.trim() || '';
        // 上記クラス名から時間が取れなかった旧ページ構造の場合のみ、テーブルからフォールバック取得
        if (t.includes('営業時間') && !tHours)  tHours  = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('定休日'))               tClosed = th.nextElementSibling?.textContent?.trim() || '';
      });

      // 電話番号の最終バックアップ（tel:リンクから抽出）
      if (!realPhone && !reservePhone) {
        const telAnchor = doc.querySelector('a[href^="tel:"]');
        if (telAnchor) {
          fallbackPhone = telAnchor.getAttribute('href').replace('tel:', '').trim();
        }
      }

      phone   = realPhone || reservePhone || fallbackPhone;
      address = address.replace(/大きな地図を見る/g, '').replace(/周辺のお店を探す/g, '').replace(/\s+/g, ' ').trim();
      phone   = phone.replace(/[^\d\-]/g, '');

      // 見出しを明示的に付与してノーマライザーにデータ転送
      let combinedText = '';
      if (tHours)  combinedText += `【営業時間】${tHours} `;
      if (tClosed) combinedText += `【定休日】${tClosed}`;
      combinedText = combinedText.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

      return {
        name,
        genre,
        address,
        phone,
        business_hours: combinedText,
        url: link,
        source: 'tabelog'
      };
    }

    // ============================================================
    // 2. ホットペッパーの解析ロジック（class="telLink" の二段階遷移完全対応版）
    // ============================================================
    else if (siteType === 'hotpepper') {
      const shopInner = doc.querySelector('.shopInner.meiryoFont') || doc.querySelector('.shopDetailInnerTop') || doc;
      name = shopInner.querySelector('.shopName')?.textContent?.trim() ||
             doc.querySelector('h1')?.textContent?.trim() ||
             doc.title.split('|')[0].trim();

      let businessHours = '';
      let regularHoliday = '';

      // 「営業時間」「定休日」「ジャンル」のテーブル項目（th/td）から部分一致で正確にテキストを回収
      shopInner.querySelectorAll('th').forEach(th => {
        const t = th.textContent.trim();
        const td = th.nextElementSibling;

        if (t.includes('店名') && (!name || name === doc.title.split('|')[0].trim())) {
          name = td?.textContent?.trim() || name;
        }
        if (t.includes('住所') && !address) {
          address = td?.textContent?.trim() || '';
        }
        if (t.includes('電話') && !phone) {
          phone = td?.textContent?.trim() || '';
        }
        // 「ジャンル」「業種」「料理ジャンル」などを部分一致で取得（ホットペッパー追加修正）
        if (t.includes('ジャンル') || t.includes('料理') && !genre) {
          genre = td?.textContent?.trim() || '';
        }
        if (t.includes('営業時間')) {
          businessHours = td?.textContent?.trim() || '';
        }
        if (t.includes('定休日')) {
          regularHoliday = td?.textContent?.trim() || '';
        }
      });

      // 住所・電話番号のフォールバック
      if (!address) {
        address = shopInner.querySelector('.shopDetailInfoAddress')?.textContent?.trim() ||
                  shopInner.querySelector('.address')?.textContent?.trim() || '';
      }
      if (!phone) {
        phone = shopInner.querySelector('.shopDetailInfoTel')?.textContent?.trim() ||
                shopInner.querySelector('.tel')?.textContent?.trim() ||
                shopInner.querySelector('a[href^="tel:"]')?.textContent?.trim() || '';
      }

      // ③ 電話番号リンク（class="telLink"）の二段階遷移・完全取得処理
      //    HTML上に直接電話番号がなく、別ページに本物の番号がある構造に対応
      const telLinkNode = doc.querySelector('.telLink');
      if (telLinkNode || !phone || phone.includes('電話番号を表示する')) {
        try {
          let telUrl = telLinkNode ? telLinkNode.getAttribute('href') : '';

          // 相対URLを絶対URLに変換
          if (telUrl && !telUrl.startsWith('http')) {
            if (telUrl.startsWith('/')) {
              const urlObj = new URL(link);
              telUrl = urlObj.origin + telUrl;
            } else {
              const baseUrl = link.endsWith('/') ? link.slice(0, -1) : link;
              telUrl = baseUrl + '/' + telUrl;
            }
          }

          // telLink が存在しない場合は /tel/ エンドポイントを推定して試行
          if (!telUrl) {
            telUrl = (link.endsWith('/') ? link : link + '/') + 'tel/';
          }

          // ボット判定・アクセスブロックを避けるため、遷移フェッチの直前に500msの安全ウェイトを挿入
          await sleep(500);

          const telRes  = await fetch(telUrl);
          const telHtml = await telRes.text();
          const telDoc  = new DOMParser().parseFromString(telHtml, 'text/html');

          // 取得先ページから電話番号要素を探索（複数セレクターでフォールバック）
          const telNode = telDoc.querySelector('.telephoneNumber') ||
                          telDoc.querySelector('.tel') ||
                          telDoc.querySelector('.telephone');

          if (telNode && telNode.textContent.trim()) {
            phone = telNode.textContent.trim();
          }
        } catch (e) {
          console.error('[Hotpepper Tel Link Fetch Error]:', e);
        }
      }

      // テキストのクレンジング
      address = address.replace(/地図を見る/g, '').replace(/\s+/g, ' ').replace(/\n/g, '').trim();
      phone   = phone.replace(/[^\d\-]/g, '');
      name    = name.replace(/\n/g, '').trim();
      genre   = genre.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

      // 見出しを明示的に付与してノーマライザーにデータ転送
      let combinedHours = '';
      if (businessHours)  combinedHours += `【営業時間】${businessHours} `;
      if (regularHoliday) combinedHours += `【定休日】${regularHoliday}`;
      combinedHours = combinedHours.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

      return {
        name,
        genre,
        address,
        phone,
        business_hours: combinedHours,
        url: link,
        source: 'hotpepper'
      };
    }

  } catch (e) {
    return {
      name: '', genre: '', address: '', phone: '',
      business_hours: '', url: link, source: siteType, _error: e.message
    };
  }
}

// ============================================================
// クロールメインタスク
// ============================================================
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
      const res  = await fetch(currentListUrl);
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // メタデータの抽出（初回のみ）
      if (pageNum === 1) {
        const meta = extractMetadata(doc, siteType);
        if (meta.area || meta.industry) task.metadata = { ...task.metadata, ...meta };
        if (!task.metadata.area || !task.metadata.industry) {
          const parts = doc.title.split(' ');
          if (parts.length >= 2) {
            if (!task.metadata.area)     task.metadata.area     = parts[0];
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

      // 複数件（CHUNK_SIZE）を同時に並行 fetch して超高速化
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

              // ============================================================
              // 【キー名完全統一】background.js の keyMapping と完全に対応させること
              //   'regular_holiday'        ← keyMapping['定休日']
              //   'opening_hours_details'  ← keyMapping['営業時間']
              // ============================================================
              const finalDetail = {
                name:                  detail.name,
                genre:                 detail.genre,
                address:               detail.address,
                phone:                 detail.phone || '',
                regular_holiday:       normalized.normalized_closed_days    || '無休',   // background.js: '定休日'
                opening_hours_details: normalized.normalized_business_hours || '掲載なし', // background.js: '営業時間'
                url:                   detail.url,
                source:                detail.source  // 'tabelog' または 'hotpepper'
              };
              task.results.push(finalDetail);
              collected++;

              sendToBackground(tabId, 'PROGRESS', {
                collected,
                maxItems: task.maxItems,
                latest:   detail.name,
                page:     pageNum,
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
      results:   task.results,
      metadata:  task.metadata
    });

    const mediaName = task.metadata.media === 'tabelog'
      ? '食べログ'
      : (task.metadata.media === 'hotpepper' ? 'ホットペッパー' : 'サイト');
    const area     = task.metadata.area     || '';
    const industry = task.metadata.industry || '';
    const count    = task.results.length;

    let title   = '取得完了';
    let message = `${area} ${industry} (${mediaName}) の取得が完了しました。計 ${count} 件`;

    if (collected >= task.maxItems) {
      title = '取得完了 (上限到達)';
    } else if (collected < task.maxItems) {
      title   = '取得停止';
      message = `${area} ${industry} (${mediaName}) の取得を停止しました。計 ${count} 件取得済み`;
    }

    // ダウンロードとデスクトップ通知をBackgroundに依頼
    chrome.runtime.sendMessage({ target: 'background', type: 'SHOW_NOTIFICATION', title, message });
    if (task.results.length > 0) {
      chrome.runtime.sendMessage({
        target:   'background',
        type:     'DOWNLOAD_CSV',
        results:  task.results,
        metadata: task.metadata,
        tabId
      });
    }
  }
}

// ============================================================
// 各種メッセージ受信
// ============================================================
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
      running:  true,
      tabId:    tabId,
      listUrl:  message.listUrl,
      results:  [],
      maxItems: message.maxItems || Infinity,
      metadata: {
        media:    siteType,
        area:     '',
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
        results:  task.results  || [],
        running:  task.running  || false,
        metadata: task.metadata || {}
      });
    } else {
      sendResponse({ results: [], running: false, metadata: {} });
    }
    return;
  }
});