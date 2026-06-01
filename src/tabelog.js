/**
 * tabelog.js
 * 食べログ詳細ページ抽出器
 *
 * 抽出優先順位:
 *   Phase1: application/ld+json の構造化データ
 *   Phase2: rstinfo-table 系テーブル (新旧デザイン両対応)
 *   Phase3: ラベル探索 (dt/dd, th/td, span+隣接テキスト)
 *   Phase4: テキスト全文解析フォールバック
 *
 * - 営業時間・定休日を独立して抽出
 * - raw値を debugRawHours / debugRawHoliday に保持
 * - 失敗時は Logger にフェーズ・理由付きで記録
 */

// ============================================================
// 定数
// ============================================================
const MEDIA = 'tabelog';

// 食べログ店舗URLパターン
const RST_URL_RE = /tabelog\.com\/[a-z]+\/A\d+\/A\d+\/\d+\//;

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
    .replace(/大きな地図を見る/g, '')
    .replace(/周辺のお店を探す/g, '')
    .replace(/地図を見る/g, '')
    .trim();
}

// ============================================================
// Phase 1: JSON-LD 抽出
// ============================================================
function extractFromJsonLd(doc) {
  const result = { hours: '', holiday: '', name: '', address: '', phone: '', genre: '' };

  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);

      // 配列の場合は展開
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        const type = (item['@type'] || '').toLowerCase();
        if (!['restaurant', 'foodestablishment', 'localBusiness', 'cafeoricecreamshop'].some(t => type.includes(t.toLowerCase()))) {
          // @type がなくても openingHours があれば使う
          if (!item.openingHours && !item.openingHoursSpecification && !item.name) continue;
        }

        // 店名
        if (item.name && !result.name) result.name = item.name;

        // 住所
        if (item.address && !result.address) {
          if (typeof item.address === 'string') {
            result.address = item.address;
          } else if (item.address.streetAddress) {
            const addr = item.address;
            result.address = [
              addr.addressRegion || '',
              addr.addressLocality || '',
              addr.streetAddress || '',
            ].filter(Boolean).join('');
          }
        }

        // 電話番号
        if (item.telephone && !result.phone) {
          result.phone = item.telephone.replace(/[^\d\-]/g, '');
        }

        // ジャンル
        if (item.servesCuisine && !result.genre) {
          result.genre = Array.isArray(item.servesCuisine)
            ? item.servesCuisine.join('・')
            : item.servesCuisine;
        }

        // ---- 営業時間 ----
        // openingHoursSpecification (構造化)
        if (item.openingHoursSpecification && !result.hours) {
          const specs = Array.isArray(item.openingHoursSpecification)
            ? item.openingHoursSpecification
            : [item.openingHoursSpecification];

          const lines = specs.map(spec => {
            const days = Array.isArray(spec.dayOfWeek) ? spec.dayOfWeek : [spec.dayOfWeek || ''];
            const dayStr = days.map(d => _schemaToJpDay(d)).filter(Boolean).join('・');
            const opens  = (spec.opens  || '').replace(':', '：');
            const closes = (spec.closes || '').replace(':', '：');
            return dayStr
              ? `${dayStr} ${opens}〜${closes}`
              : `${opens}〜${closes}`;
          }).filter(Boolean);

          if (lines.length > 0) result.hours = lines.join(' / ');
        }

        // openingHours (文字列配列)
        if (item.openingHours && !result.hours) {
          const oh = Array.isArray(item.openingHours) ? item.openingHours : [item.openingHours];
          result.hours = oh.join(' / ');
        }
      }
    } catch (e) {
      // JSON parse 失敗は無視して次へ
    }
  }

  return result;
}

// Schema.org dayOfWeek URI → 日本語曜日
function _schemaToJpDay(uri) {
  if (!uri) return '';
  const map = {
    Monday: '月', Tuesday: '火', Wednesday: '水', Thursday: '木',
    Friday: '金', Saturday: '土', Sunday: '日',
  };
  const key = (uri.split('/').pop() || '').replace('Day', '');
  return map[key] || map[uri] || '';
}

// ============================================================
// Phase 2: rstinfo-table 系テーブル (新旧デザイン対応)
// ============================================================
function extractFromTable(doc) {
  const result = { hours: '', holiday: '', name: '', address: '', phone: '', genre: '' };

  // ---- 店名 ----
  result.name =
    cleanText(doc.querySelector('.display-name, .rstinfo-table__name-main, h1.display-name')?.textContent) ||
    cleanText(doc.querySelector('h1[class*="name"]')?.textContent) ||
    '';

  // ---- 住所 ----
  result.address =
    cleanText(doc.querySelector('p.rstinfo-table__address, .rstinfo-table__address')?.textContent) ||
    '';

  // ---- 電話番号 ----
  // 「掲載している電話番号」の実電話を優先
  result.phone =
    cleanText(doc.querySelector('.rstinfo-table__tel-num')?.textContent) ||
    '';

  // ---- th/td ループ (複数テーブルに対応) ----
  const rows = doc.querySelectorAll(
    '.rstinfo-table__table tr, ' +      // 新デザイン
    '.p-shop-detail-info-list tr, ' +   // 別バリアント
    'table.rstinfo-table tr, ' +        // 旧デザイン
    '.c-table-rst tr'                   // さらに旧
  );

  rows.forEach(tr => {
    const th = tr.querySelector('th');
    const td = tr.querySelector('td');
    if (!th || !td) return;

    const label = th.textContent.trim();
    const val   = cleanText(td.textContent);
    const valFull = td.innerHTML; // 改行を含む生HTML

    if (label.includes('ジャンル') && !result.genre) {
      result.genre = val;
    }
    if (label.includes('住所') && !result.address) {
      result.address = val;
    }
    if ((label.includes('電話番号') || label.includes('TEL')) && !result.phone) {
      result.phone = val.replace(/[^\d\-]/g, '');
    }
    if (label.includes('営業時間') && !result.hours) {
      // tdの内部テキストを改行保持で取得
      result.hours = _extractCellText(td);
    }
    if (label.includes('定休日') && !result.holiday) {
      result.holiday = _extractCellText(td);
    }
  });

  // ---- business-item ブロック (新デザイン: 営業時間が複数ブロック) ----
  if (!result.hours) {
    const items = doc.querySelectorAll('.rstinfo-table__business-item');
    if (items.length > 0) {
      const texts = [];
      items.forEach(item => {
        const t = item.textContent.trim().replace(/\s+/g, ' ');
        if (t) texts.push(t);
      });
      result.hours = texts.join(' | ');
    }
  }

  return result;
}

/**
 * td セルのテキストを改行を「 / 」に変換して取得
 */
function _extractCellText(td) {
  // br タグを改行に変換してから取得
  const clone = td.cloneNode(true);
  clone.querySelectorAll('br').forEach(br => {
    br.replaceWith(document.createTextNode(' / '));
  });
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

// ============================================================
// Phase 3: ラベル探索 (dt/dd, span, p)
// ============================================================
function extractFromLabels(doc) {
  const result = { hours: '', holiday: '' };

  // dt/dd ペア
  doc.querySelectorAll('dl').forEach(dl => {
    dl.querySelectorAll('dt').forEach(dt => {
      const label = dt.textContent.trim();
      const dd    = dt.nextElementSibling;
      if (!dd) return;
      const val = cleanText(dd.textContent);
      if (label.includes('営業時間') && !result.hours)  result.hours   = val;
      if (label.includes('定休日')   && !result.holiday) result.holiday = val;
    });
  });

  // span / p ラベル探索
  if (!result.hours || !result.holiday) {
    const HOUR_LABELS    = ['営業時間', 'お店の営業時間'];
    const HOLIDAY_LABELS = ['定休日', '定休'];

    const all = doc.querySelectorAll('span, p, div, li');
    all.forEach(el => {
      const text = el.textContent.trim();
      if (!text) return;

      // ラベルとして機能する短いノード
      if (text.length > 20) return;

      if (HOUR_LABELS.some(l => text.includes(l)) && !result.hours) {
        const next = el.nextElementSibling;
        if (next && next.textContent.trim().length > 2) {
          result.hours = cleanText(next.textContent);
        }
        // 親ノードの次の兄弟
        const parentNext = el.parentElement?.nextElementSibling;
        if (!result.hours && parentNext) {
          result.hours = cleanText(parentNext.textContent);
        }
      }

      if (HOLIDAY_LABELS.some(l => text.includes(l)) && !result.holiday) {
        const next = el.nextElementSibling;
        if (next && next.textContent.trim().length > 0) {
          result.holiday = cleanText(next.textContent);
        }
        const parentNext = el.parentElement?.nextElementSibling;
        if (!result.holiday && parentNext) {
          result.holiday = cleanText(parentNext.textContent);
        }
      }
    });
  }

  return result;
}

// ============================================================
// Phase 4: テキスト全文解析フォールバック
// ============================================================
function extractFromFullText(doc) {
  const result = { hours: '', holiday: '' };

  const bodyText = doc.body?.textContent || '';

  // 営業時間
  const hourMatch = bodyText.match(
    /営業時間[\s：:]*([^\n定休閉]{3,80})/
  );
  if (hourMatch) result.hours = hourMatch[1].trim().replace(/\s+/g, ' ');

  // 定休日
  const holidayMatch = bodyText.match(
    /定休日[\s：:]*([^\n営業]{1,40})/
  );
  if (holidayMatch) result.holiday = holidayMatch[1].trim().replace(/\s+/g, ' ');

  return result;
}

// ============================================================
// メイン抽出関数
// ============================================================
/**
 * 食べログ詳細ページから店舗情報を抽出する
 *
 * @param {Document} doc パース済みDOM
 * @param {string}   url 取得元URL
 * @param {Object}   logger Logger インスタンス
 * @returns {Object} 抽出結果
 */
function extractTabelogDetail(doc, url, logger) {
  const log = logger || {
    logDebug: (m, msg, ex) => console.debug(`[TABELOG] ${msg}`, ex),
    logError: (m, msg, ex) => console.error(`[TABELOG] ${msg}`, ex),
    statsAdd: () => {},
  };

  const extracted = {
    name:    '',
    genre:   '',
    address: '',
    phone:   '',
    // 営業時間・定休日は独立保持
    rawHours:   '',   // raw (抽出直後)
    rawHoliday: '',   // raw (抽出直後)
    // フェーズ記録
    hoursPhase:   'none',
    holidayPhase: 'none',
    // デバッグ用 raw 保持フィールド (仕様要件)
    debugRawHours:   '',
    debugRawHoliday: '',
  };

  // --------------------------------------------------------
  // Phase 1: JSON-LD
  // --------------------------------------------------------
  log.logDebug(MEDIA, `[Phase1] JSON-LD 抽出開始`, { url });
  const ldData = extractFromJsonLd(doc);

  if (ldData.name)    extracted.name    = ldData.name;
  if (ldData.address) extracted.address = ldData.address;
  if (ldData.phone)   extracted.phone   = ldData.phone;
  if (ldData.genre)   extracted.genre   = ldData.genre;

  if (ldData.hours) {
    extracted.rawHours   = ldData.hours;
    extracted.hoursPhase = 'json-ld';
    log.logDebug(MEDIA, `[Phase1] 営業時間 JSON-LD で取得成功`, { url, val: ldData.hours });
  }
  // 食べログの JSON-LD には定休日が入らないことが多いので Phase2 へ

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
  // Phase 4: テキスト全文解析
  // --------------------------------------------------------
  if (!extracted.rawHours || !extracted.rawHoliday) {
    log.logDebug(MEDIA, `[Phase4] テキスト全文解析開始`, { url });
    const textData = extractFromFullText(doc);

    if (!extracted.rawHours && textData.hours) {
      extracted.rawHours   = textData.hours;
      extracted.hoursPhase = 'fulltext';
      log.logDebug(MEDIA, `[Phase4] 営業時間 フルテキストで取得成功`, { url, val: textData.hours });
    }
    if (!extracted.rawHoliday && textData.holiday) {
      extracted.rawHoliday   = textData.holiday;
      extracted.holidayPhase = 'fulltext';
      log.logDebug(MEDIA, `[Phase4] 定休日 フルテキストで取得成功`, { url, val: textData.holiday });
    }
  }

  // --------------------------------------------------------
  // raw 値をデバッグフィールドに保存 (仕様要件)
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

  // 店名が取れなかった場合はタイトルから補完
  if (!extracted.name) {
    extracted.name = doc.title?.split(/[|\-｜]/)[0]?.trim() || '';
  }

  return extracted;
}

// ============================================================
// 一覧ページ: 店舗リンク取得
// ============================================================
function tabelogGetLinks(doc, baseUrl) {
  const links = [];

  // ① JSON-LD の ItemList から抽出 (React化後の食べログ対応: 最優先)
  // 現在の食べログはサーバーサイドのHTMLに店舗リンクを含まず、
  // <script type="application/ld+json"> の ItemList に URL が入っている
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const data = JSON.parse(s.textContent);
      if (data['@type'] === 'ItemList' && Array.isArray(data.itemListElement)) {
        data.itemListElement.forEach(item => {
          const url = (item.url || '').split('?')[0];
          if (RST_URL_RE.test(url) && !links.includes(url)) links.push(url);
        });
      }
    } catch (e) { /* JSON parse 失敗は無視 */ }
  });

  if (links.length > 0) return links;

  // ② DOM セレクタ群 (旧デザイン向けフォールバック: 新→旧の順)
  const SELECTORS = [
    '.list-rst__rst-name-target',
    '.js-rst-cassette-wrap .list-rst__name a',
    'a.list-rst__name-main',
    '.list-rst__name a[href]',
    'h3.list-rst__name a',
    'a.c-cstmReviewsList__rst-name-link',
  ];

  for (const sel of SELECTORS) {
    doc.querySelectorAll(sel).forEach(a => {
      const href = resolveUrl(a.getAttribute('href') || '', baseUrl).split('?')[0];
      if (RST_URL_RE.test(href) && !links.includes(href)) links.push(href);
    });
  }

  // ③ 全 a タグスキャン (最終フォールバック)
  if (links.length === 0) {
    doc.querySelectorAll('a[href]').forEach(a => {
      const href = resolveUrl(a.getAttribute('href') || '', baseUrl).split('?')[0];
      if (RST_URL_RE.test(href) && !links.includes(href)) links.push(href);
    });
  }

  return links;
}

// ============================================================
// 一覧ページ: 次ページ URL 取得
// ============================================================
function tabelogGetNextUrl(doc, baseUrl) {
  // 複数セレクタ対応
  const SELECTORS = [
    'a.c-pagination__arrow--next:not(.is-disabled)',
    '.c-pagination__arrow--next a:not(.is-disabled)',
    'a[rel="next"]',
    '.pagination .next a',
    'a.next:not(.disabled)',
  ];

  for (const sel of SELECTORS) {
    const btn = doc.querySelector(sel);
    if (btn) {
      const href = btn.getAttribute('href') || '';
      if (href) return resolveUrl(href, baseUrl);
    }
  }
  return null;
}

// ============================================================
// エクスポート
// ============================================================
const TabelogExtractor = {
  extractTabelogDetail,
  tabelogGetLinks,
  tabelogGetNextUrl,
};

if (typeof self !== 'undefined') self.TabelogExtractor = TabelogExtractor;
if (typeof module !== 'undefined') module.exports = TabelogExtractor;
