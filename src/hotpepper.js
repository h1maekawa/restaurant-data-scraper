/**
 * hotpepper.js
 * ホットペッパー詳細ページ抽出器
 *
 * 改善点:
 *   - セレクタを複数候補化 (新デザイン / 旧デザイン 両対応)
 *   - tel ページ取得失敗時のリトライ
 *   - 一覧ページのリンク抽出セレクタ複数候補化
 *   - 次ページ判定セレクタも複数候補化
 *   - 失敗時は Logger にフェーズ・理由付きで記録
 *   - debugRawHours / debugRawHoliday を保持
 */

const MEDIA = 'hotpepper';

// ============================================================
// ヘルパー
// ============================================================
function resolveUrl(href, baseUrl) {
  if (!href) return '';
  try { return new URL(href, baseUrl).href; } catch (e) { return href; }
}

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/地図を見る/g, '')
    .replace(/ルートを調べる/g, '')
    .trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// セレクタ候補定義
// ============================================================

// 店名セレクタ群
const NAME_SELECTORS = [
  '.shopName',
  '.shopDetailInnerTop .shopName',
  '.shopInner h2.shopName',
  'h1.shopName',
  '.shop-name',
  '.storeName',
  'h1',
];

// 営業時間セレクタ群
const HOURS_SELECTORS = [
  '.openingHours',
  '.businessHour',
  '.shopDetailInfo-openHour',
  '[data-category="open-hour"]',
];

// 定休日セレクタ群
const HOLIDAY_SELECTORS = [
  '.regularHoliday',
  '.closedDay',
  '[data-category="closed-day"]',
];

// 住所セレクタ群
const ADDRESS_SELECTORS = [
  '.shopDetailInfoAddress',
  '.shopAddress',
  '.address',
  '[itemprop="streetAddress"]',
  '.shop-address',
];

// 電話セレクタ群
const PHONE_SELECTORS = [
  '.shopDetailInfoTel',
  '.telephoneNumber',
  '.tel',
  '.telephone',
  '.shop-tel',
  'a[href^="tel:"]',
];

// tel ページ 電話番号セレクタ群
const TEL_PAGE_SELECTORS = [
  '.telephoneNumber',
  '.tel-number',
  '.tel',
  '.telephone',
  'a[href^="tel:"]',
  '.shopDetailInfoTel',
];

// ============================================================
// セレクタ候補から最初にマッチするテキストを返す
// ============================================================
function queryText(root, selectors) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) {
      const text = cleanText(el.textContent);
      if (text) return text;
    }
  }
  return '';
}

// ============================================================
// Phase 1: 直接セレクタ抽出
// ============================================================
function extractFromSelectors(doc) {
  const shopInner =
    doc.querySelector('.shopInner.meiryoFont') ||
    doc.querySelector('.shopDetailInnerTop') ||
    doc.querySelector('.shopDetailContents') ||
    doc;

  const result = {
    name:    queryText(shopInner, NAME_SELECTORS) || queryText(doc, NAME_SELECTORS),
    address: queryText(shopInner, ADDRESS_SELECTORS) || queryText(doc, ADDRESS_SELECTORS),
    phone:   '',
    genre:   '',
    hours:   '',
    holiday: '',
  };

  // 電話 (a[href^=tel] はテキストでなく href から取ることも)
  for (const sel of PHONE_SELECTORS) {
    const el = doc.querySelector(sel);
    if (!el) continue;
    if (el.tagName === 'A' && el.getAttribute('href')?.startsWith('tel:')) {
      const fromHref = el.getAttribute('href').replace('tel:', '').trim();
      const fromText = el.textContent.trim();
      result.phone = /[0-9]/.test(fromText) ? fromText : fromHref;
      if (result.phone) break;
    } else {
      const text = cleanText(el.textContent);
      if (text) { result.phone = text; break; }
    }
  }

  // 営業時間（直接セレクタ）
  result.hours   = queryText(doc, HOURS_SELECTORS);
  result.holiday = queryText(doc, HOLIDAY_SELECTORS);

  return result;
}

// ============================================================
// Phase 2: テーブル抽出 (tr/th/td & dl/dt/dd)
// ============================================================
function extractFromTable(doc) {
  const result = { name: '', address: '', phone: '', genre: '', hours: '', holiday: '' };

  // --- table tr ---
  const rows = doc.querySelectorAll('table tr');
  rows.forEach(tr => {
    const cells = tr.querySelectorAll('td');
    if (cells.length >= 2) {
      const label = cells[0].textContent.trim();
      const valText = cleanText(cells[1].textContent);
      const valFull = cells[1].textContent.replace(/\s+/g, ' ').trim();

      if (label === '店名'   && !result.name)    result.name    = valText;
      if (label === '住所'   && !result.address)  result.address = valFull;
      if ((label === '電話' || label === 'TEL') && !result.phone) result.phone = valText;
      if ((label === 'ジャンル' || label === '料理') && !result.genre) result.genre = valFull;
      if (label === '営業時間' && !result.hours) {
        result.hours = _extractCellLines(cells[1]);
      }
      if (label === '定休日' && !result.holiday) {
        result.holiday = cells[1].textContent.trim().split('\n')[0].trim();
      }
    }
  });

  // --- th/td ---
  doc.querySelectorAll('th').forEach(th => {
    const label = _getThLabel(th);
    const td = th.nextElementSibling;
    if (!td) return;
    const val = cleanText(td.textContent);

    if (label.includes('店名')    && !result.name)    result.name    = val;
    if (label.includes('住所')    && !result.address)  result.address = td.textContent.replace(/\s+/g, ' ').trim();
    if ((label.includes('電話') || label.includes('TEL') || label.includes('問い合わせ')) && !result.phone) result.phone = val;
    if ((label.includes('ジャンル') || label.includes('料理')) && !result.genre) result.genre = td.textContent.replace(/\s+/g, ' ').trim();
    if (label.includes('営業時間') && !result.hours) result.hours = _extractCellLines(td);
    if (label.includes('定休日')  && !result.holiday)  result.holiday = val;
  });

  // --- dl/dt/dd ---
  doc.querySelectorAll('dl').forEach(dl => {
    dl.querySelectorAll('dt').forEach(dt => {
      const label = dt.textContent.trim();
      const dd = dt.nextElementSibling;
      if (!dd) return;
      const val = cleanText(dd.textContent);

      if (label.includes('営業時間') && !result.hours)  result.hours   = _extractCellLines(dd);
      if (label.includes('定休日')   && !result.holiday) result.holiday = dd.textContent.trim().split('\n')[0].trim();
      if (label.includes('住所')     && !result.address)  result.address = val;
      if ((label.includes('ジャンル') || label.includes('料理')) && !result.genre) result.genre = val;
    });
  });

  return result;
}

// th テキストを正規化して返す
function _getThLabel(th) {
  return Array.from(th.childNodes)
    .filter(n => n.nodeType === Node.TEXT_NODE)
    .map(n => n.textContent.trim())
    .join('') ||
    th.firstElementChild?.textContent?.trim() ||
    th.textContent?.split('\n')[0].trim() ||
    '';
}

// セル内の行を「 / 」区切りで結合
function _extractCellLines(cell) {
  const clone = cell.cloneNode(true);
  clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode(' / ')));
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

// ============================================================
// Phase 3: ラベル探索フォールバック
// ============================================================
function extractFromLabels(doc) {
  const result = { hours: '', holiday: '' };
  const HOUR_LABELS    = ['営業時間'];
  const HOLIDAY_LABELS = ['定休日'];

  let prevLabel = '';
  const elements = doc.querySelectorAll('td, dd, span, p, div, li');

  elements.forEach(el => {
    const text = el.textContent.trim();
    if (!text) return;

    if (HOUR_LABELS.includes(text))    { prevLabel = 'hours';   return; }
    if (HOLIDAY_LABELS.includes(text)) { prevLabel = 'holiday'; return; }

    if (prevLabel === 'hours'   && !result.hours   && text.length > 3)  { result.hours   = cleanText(text); prevLabel = ''; }
    if (prevLabel === 'holiday' && !result.holiday && text.length >= 1) { result.holiday = text.trim().split('\n')[0].trim(); prevLabel = ''; }
  });

  return result;
}

// ============================================================
// tel ページ取得（リトライ付き）
// ============================================================
async function fetchTelPhone(baseLink, existingPhone, logger) {
  const log = logger || { logDebug: () => {}, logWarn: () => {}, logError: () => {}, statsAdd: () => {} };

  if (existingPhone && !existingPhone.includes('電話番号を表示する')) return existingPhone;

  const telLinkEl = null; // doc からは呼び出し元で渡す設計
  const telUrl = (baseLink.endsWith('/') ? baseLink : baseLink + '/') + 'tel/';

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log.logDebug(MEDIA, `tel ページ取得試行 ${attempt}/2`, { url: telUrl });
      await sleep(500 * attempt);

      const res = await fetch(telUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const html = await res.text();
      const telDoc = new DOMParser().parseFromString(html, 'text/html');

      for (const sel of TEL_PAGE_SELECTORS) {
        const el = telDoc.querySelector(sel);
        if (!el) continue;
        if (el.tagName === 'A' && el.getAttribute('href')?.startsWith('tel:')) {
          const fromHref = el.getAttribute('href').replace('tel:', '').trim();
          const fromText = el.textContent.trim();
          const phone = /[0-9]/.test(fromText) ? fromText : fromHref;
          if (phone) {
            log.logDebug(MEDIA, `tel ページ取得成功 (試行${attempt})`, { url: telUrl, phone });
            log.statsAdd(MEDIA, attempt > 1 ? 'retryCount' : 'detailSuccess');
            return phone;
          }
        } else {
          const text = el.textContent.trim();
          if (/\d{2,4}-?\d{2,4}-?\d{4}/.test(text)) {
            log.logDebug(MEDIA, `tel ページ取得成功 (試行${attempt})`, { url: telUrl, phone: text });
            return text;
          }
        }
      }
    } catch (e) {
      log.logWarn(MEDIA, `tel ページ取得失敗 (試行${attempt}/2)`, {
        url: telUrl,
        errorDetail: e.message,
      });
    }
  }

  log.logError(MEDIA, `tel ページ取得 全試行失敗`, {
    url: telUrl,
    phase: 'tel-fetch',
    errorDetail: '2回リトライ後も電話番号取得できませんでした',
  });
  return existingPhone || '';
}

// ============================================================
// メイン抽出関数
// ============================================================
/**
 * ホットペッパー詳細ページから店舗情報を抽出する
 *
 * @param {Document} doc
 * @param {string}   url
 * @param {Object}   logger
 * @returns {Object}
 */
async function extractHotpepperDetail(doc, url, logger) {
  const log = logger || {
    logDebug: (m, msg, ex) => console.debug(`[HP] ${msg}`, ex),
    logWarn:  (m, msg, ex) => console.warn(`[HP] ${msg}`, ex),
    logError: (m, msg, ex) => console.error(`[HP] ${msg}`, ex),
    statsAdd: () => {},
  };

  const extracted = {
    name:    '',
    genre:   '',
    address: '',
    phone:   '',
    rawHours:   '',
    rawHoliday: '',
    hoursPhase:   'none',
    holidayPhase: 'none',
    debugRawHours:   '',
    debugRawHoliday: '',
  };

  // --------------------------------------------------------
  // Phase 1: 直接セレクタ
  // --------------------------------------------------------
  log.logDebug(MEDIA, `[Phase1] 直接セレクタ抽出開始`, { url });
  const selData = extractFromSelectors(doc);

  if (selData.name)    extracted.name    = selData.name;
  if (selData.address) extracted.address = selData.address;
  if (selData.phone)   extracted.phone   = selData.phone;
  if (selData.genre)   extracted.genre   = selData.genre;

  if (selData.hours) {
    extracted.rawHours   = selData.hours;
    extracted.hoursPhase = 'selector';
    log.logDebug(MEDIA, `[Phase1] 営業時間 セレクタで取得成功`, { url, val: selData.hours });
  }
  if (selData.holiday) {
    extracted.rawHoliday   = selData.holiday;
    extracted.holidayPhase = 'selector';
    log.logDebug(MEDIA, `[Phase1] 定休日 セレクタで取得成功`, { url, val: selData.holiday });
  }

  // --------------------------------------------------------
  // Phase 2: テーブル抽出
  // --------------------------------------------------------
  log.logDebug(MEDIA, `[Phase2] テーブル抽出開始`, { url });
  const tableData = extractFromTable(doc);

  if (!extracted.name    && tableData.name)    extracted.name    = tableData.name;
  if (!extracted.address && tableData.address) extracted.address = tableData.address;
  if (!extracted.phone   && tableData.phone)   extracted.phone   = tableData.phone;
  if (!extracted.genre   && tableData.genre)   extracted.genre   = tableData.genre;

  if (!extracted.rawHours && tableData.hours) {
    extracted.rawHours   = tableData.hours;
    extracted.hoursPhase = 'table';
    log.logDebug(MEDIA, `[Phase2] 営業時間 テーブルで取得成功`, { url, val: tableData.hours });
  }
  if (!extracted.rawHoliday && tableData.holiday) {
    extracted.rawHoliday   = tableData.holiday;
    extracted.holidayPhase = 'table';
    log.logDebug(MEDIA, `[Phase2] 定休日 テーブルで取得成功`, { url, val: tableData.holiday });
  }

  // --------------------------------------------------------
  // Phase 3: ラベル探索
  // --------------------------------------------------------
  if (!extracted.rawHours || !extracted.rawHoliday) {
    log.logDebug(MEDIA, `[Phase3] ラベル探索開始`, { url });
    const labelData = extractFromLabels(doc);

    if (!extracted.rawHours && labelData.hours) {
      extracted.rawHours   = labelData.hours;
      extracted.hoursPhase = 'label';
      log.logDebug(MEDIA, `[Phase3] 営業時間 ラベルで取得成功`, { url, val: labelData.hours });
    }
    if (!extracted.rawHoliday && labelData.holiday) {
      extracted.rawHoliday   = labelData.holiday;
      extracted.holidayPhase = 'label';
      log.logDebug(MEDIA, `[Phase3] 定休日 ラベルで取得成功`, { url, val: labelData.holiday });
    }
  }

  // --------------------------------------------------------
  // tel ページから電話番号を補完 (セレクタが表示用の場合)
  // --------------------------------------------------------
  const needsTelFetch =
    !extracted.phone ||
    extracted.phone.includes('電話番号を表示する') ||
    doc.querySelector('.telLink, .js-tel-link, [class*="telLink"]');

  if (needsTelFetch) {
    log.logDebug(MEDIA, `tel ページ取得開始`, { url });
    const telPhone = await fetchTelPhone(url, extracted.phone, log);
    if (telPhone) extracted.phone = telPhone;
  }

  // --------------------------------------------------------
  // raw 値をデバッグフィールドに保存
  // --------------------------------------------------------
  extracted.debugRawHours   = extracted.rawHours;
  extracted.debugRawHoliday = extracted.rawHoliday;

  // --------------------------------------------------------
  // 失敗ログ
  // --------------------------------------------------------
  const storeName = extracted.name || '(店名不明)';

  if (!extracted.rawHours) {
    log.logError(MEDIA, `営業時間 取得失敗 (全フェーズ失敗)`, {
      url,
      storeName,
      phase: 'all',
      errorDetail: '全フェーズで営業時間を取得できませんでした',
    });
  } else {
    log.statsAdd(MEDIA, 'hoursSuccess');
  }

  if (!extracted.rawHoliday) {
    log.logError(MEDIA, `定休日 取得失敗 (全フェーズ失敗)`, {
      url,
      storeName,
      phase: 'all',
      errorDetail: '全フェーズで定休日を取得できませんでした',
    });
  } else {
    log.statsAdd(MEDIA, 'holidaySuccess');
  }

  // 店名補完
  if (!extracted.name) {
    extracted.name = doc.title?.split(/[|\-｜]/)[0]?.trim() || '';
  }

  return extracted;
}

// ============================================================
// 一覧ページ: 店舗リンク取得
// ============================================================
function hotpepperGetLinks(doc, baseUrl) {
  const links = [];
  const HP_RST_RE = /^https?:\/\/(www\.)?hotpepper\.jp\/(strJ[A-Z0-9]+|A[A-Z0-9]+)\/?$/;

  // 複数セレクタ (優先順)
  const LINK_SELECTORS = [
    '.shopDetailTop a',
    '.shopName a',
    'h3.shopName a',
    'h2.shopName a',
    'a.shopDetailLink',
    '.list-cassette__unit a',
    '.shopCassette a[href*="/str"]',
    'a[href*="/strJ"]',
  ];

  for (const sel of LINK_SELECTORS) {
    doc.querySelectorAll(sel).forEach(a => {
      const raw = a.getAttribute('href') || '';
      let href = resolveUrl(raw, baseUrl).split('?')[0].split('#')[0];
      if (!href.endsWith('/')) href += '/';
      if (HP_RST_RE.test(href.replace(/\/$/, '')) && !links.includes(href)) {
        links.push(href);
      }
    });
  }

  // フォールバック: 全 a タグ
  if (links.length === 0) {
    doc.querySelectorAll('a[href]').forEach(a => {
      const raw = a.getAttribute('href') || '';
      let href = resolveUrl(raw, baseUrl).split('?')[0].split('#')[0];
      if (!href.endsWith('/')) href += '/';
      if (HP_RST_RE.test(href.replace(/\/$/, '')) && !links.includes(href)) {
        links.push(href);
      }
    });
  }

  return links;
}

// ============================================================
// 一覧ページ: 次ページ URL 取得
// ============================================================
function hotpepperGetNextUrl(doc, baseUrl) {
  // 複数セレクタ
  const NEXT_SELECTORS = [
    'a.pa_next',
    'a[rel="next"]',
    '.pageLinkLinearBasic a',
    '.pagination a',
    '.pager a',
    '.page-list a',
    '.pageList a',
    '.page-link a',
  ];

  for (const sel of NEXT_SELECTORS) {
    const anchors = Array.from(doc.querySelectorAll(sel));
    const nextBtn = anchors.find(a =>
      a.textContent.includes('次') ||
      a.getAttribute('rel') === 'next' ||
      a.classList.contains('pa_next') ||
      a.classList.contains('next')
    );
    if (nextBtn && !nextBtn.classList.contains('disabled') && !nextBtn.classList.contains('is-disabled')) {
      const href = nextBtn.getAttribute('href') || '';
      if (href) return resolveUrl(href, baseUrl);
    }
  }
  return null;
}

// ============================================================
// エクスポート
// ============================================================
const HotpepperExtractor = {
  extractHotpepperDetail,
  hotpepperGetLinks,
  hotpepperGetNextUrl,
  fetchTelPhone,
};

if (typeof self !== 'undefined') self.HotpepperExtractor = HotpepperExtractor;
if (typeof module !== 'undefined') module.exports = HotpepperExtractor;
