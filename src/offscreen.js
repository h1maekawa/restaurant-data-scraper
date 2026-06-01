/**
 * offscreen.js
 */

const activeTasks = new Map();
const CHUNK_SIZE = 5;
const DELAY_BETWEEN_CHUNKS = 800;
const DELAY_LIST_FETCH = 600;

const genreLinksResolvers = new Map();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getSiteType(url) {
  if (/tabelog\.com/.test(url)) return 'tabelog';
  if (/hotpepper\.jp/.test(url)) return 'hotpepper';
  return null;
}

function resolveUrl(href, baseUrl) {
  if (!href) return '';
  try {
    return new URL(href, baseUrl).href;
  } catch (e) {
    return href;
  }
}

function sendToBackground(tabId, type, payload = {}) {
  chrome.runtime.sendMessage({
    target: 'background',
    tabId,
    type,
    payload
  }).catch(() => { });
}

function extractMetadata(doc, siteType) {
  const meta = { area: '', industry: '' };
  if (siteType === 'tabelog') {
    meta.area = doc.querySelector('.list-condition__item--area')?.textContent?.trim()
      || doc.querySelector('.c-link-arrow--back')?.textContent?.trim() || '';
    meta.industry = doc.querySelector('.list-condition__item--genre')?.textContent?.trim() || '';
  } else if (siteType === 'hotpepper') {
    meta.area = doc.querySelector('.current-area')?.textContent?.trim() || '';
    meta.industry = doc.querySelector('.current-genre')?.textContent?.trim() || '';
  }
  return meta;
}

const DAY_MAP = {
  '月曜日':'月','火曜日':'火','水曜日':'水','木曜日':'木',
  '金曜日':'金','土曜日':'土','日曜日':'日',
  'Monday':'月','Tuesday':'火','Wednesday':'水','Thursday':'木',
  'Friday':'金','Saturday':'土','Sunday':'日',
  'Mon':'月','Tue':'火','Wed':'水','Thu':'木','Fri':'金','Sat':'土','Sun':'日'
};

const ALL_DAYS = ['月','火','水','木','金','土','日'];

// 定休日フィールドに出力してはいけない不要文言パターン
const HOLIDAY_NOISE_PATTERNS = [
  /お問い?合わせ(ください|下さい)?/g,
  /詳細はお電話(にて)?/g,
  /コロナ.*?(\n|$)/g,
  /感染症.*?(\n|$)/g,
  /変更(に)?なる場合.*?(\n|$)/g,
  /変更の可能性.*?(\n|$)/g,
  /ご確認ください/g,
  /店舗にお問い?合わせ/g,
  /予告なく.*?(\n|$)/g,
  /※.*?(\n|$)/g,
  /\(※.*?\)/g,
  /（※.*?）/g,
];

function normalizeDayText(text) {
  if (!text) return '';
  let result = text;
  for (const [long, short] of Object.entries(DAY_MAP)) {
    result = result.replaceAll(long, short);
  }
  return result;
}

function extractDaySet(text) {
  if (!text) return new Set();
  const normalized = normalizeDayText(text);
  const daySet = new Set();

  // パターン1: 月〜金、月-金 などの範囲指定
  const rangePattern = /([月火水木金土日])[〜~－\-ー]([月火水木金土日])/g;
  let m;
  while ((m = rangePattern.exec(normalized)) !== null) {
    const start = ALL_DAYS.indexOf(m[1]);
    const end   = ALL_DAYS.indexOf(m[2]);
    if (start !== -1 && end !== -1) {
      for (let i = start; i <= end; i++) daySet.add(ALL_DAYS[i]);
    }
  }

  // パターン2: 範囲部分を除いた残りから個別曜日を抽出
  const withoutRange = normalized.replace(/[月火水木金土日][〜~－\-ー][月火水木金土日]/g, '  ');
  const listPattern = /[月火水木金土日]/g;
  let m2;
  while ((m2 = listPattern.exec(withoutRange)) !== null) {
    daySet.add(m2[0]);
  }

  return daySet;
}

function cleanHolidayText(text) {
  if (!text) return '';
  let result = text;
  for (const pattern of HOLIDAY_NOISE_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.trim();
}

function resolveFinalHoliday(rawHolidayText, businessDaySet) {
  const cleaned = cleanHolidayText(rawHolidayText);

  if (/無休|年中無休/.test(cleaned)) return '無休';
  if (/^[\-－ー\s]+$/.test(cleaned)) return '-';

  const holidayDaySet = extractDaySet(cleaned);
  if (holidayDaySet.size > 0) {
    const holidayDays = ALL_DAYS.filter(d => holidayDaySet.has(d));
    // 定休日と営業日が完全一致している場合は逆転の可能性 → 逆算で上書き
    if (businessDaySet && businessDaySet.size > 0) {
      const overlap = holidayDays.filter(d => businessDaySet.has(d));
      if (overlap.length === holidayDays.length) {
        const calculated = ALL_DAYS.filter(d => !businessDaySet.has(d));
        if (calculated.length > 0 && calculated.length < 7) return calculated.join('・');
        if (calculated.length === 0) return '無休';
      }
    }
    return holidayDays.join('・');
  }

  if (businessDaySet && businessDaySet.size > 0) {
    const calculated = ALL_DAYS.filter(d => !businessDaySet.has(d));
    if (calculated.length > 0 && calculated.length < 7) {
      return calculated.join('・');
    }
    if (calculated.length === 0) return '無休';
  }

  return '';
}

// 営業日の最終出力値を確定する関数
function resolveFinalBusinessDays(rawBusinessDayText) {
  const daySet = extractDaySet(rawBusinessDayText);
  if (daySet.size > 0) {
    return ALL_DAYS.filter(d => daySet.has(d)).join('・');
  }
  return '';
}

function normalizeBusinessHours(hoursText) {
  if (!hoursText) {
    return { holiday: '', businessDays: '', openTime: '', closeTime: '' };
  }

  const text = hoursText.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

  let rawHolidayText = '';
  const closedMatch = text.match(/【定休日】([^【]+)/);
  if (closedMatch) {
    rawHolidayText = closedMatch[1].trim();
  } else {
    const closedPatterns = [
      /定休日[：:]\s*([^\s。、]+)/,
      /休み[：:]\s*([^\s。、]+)/,
      /定休[：:]\s*([^\s。、]+)/,
    ];
    for (const pat of closedPatterns) {
      const m = text.match(pat);
      if (m) { rawHolidayText = m[1].trim(); break; }
    }
  }

  let hoursBlock = '';
  const hoursMatch = text.match(/【営業時間】([^【]+)/);
  if (hoursMatch) {
    hoursBlock = hoursMatch[1].trim();
  } else {
    hoursBlock = text;
  }

  let rawBusinessDayText = '';
  const dayPatterns = [
    /([月火水木金土日・〜～\-–―,、]+曜日?[^0-9（(（：:〜～\-–―]{0,10})/,
    /(月[〜～\-–―]金|月[〜～\-–―]土|月[〜～\-–―]日|火[〜～\-–―]日)/,
    /([月火水木金土日]+[〜～\-–―][月火水木金土日]+)/,
  ];
  for (const pat of dayPatterns) {
    const m = hoursBlock.match(pat);
    if (m) { rawBusinessDayText = m[1].trim(); break; }
  }

  let finalOpenTime = '';
  let finalCloseTime = '';

  const timeRangePattern = /(\d{1,2}[：:]\d{2})\s*[〜～\-–―]\s*(\d{1,2}[：:]\d{2})/;
  const timeMatch = hoursBlock.match(timeRangePattern);
  if (timeMatch) {
    finalOpenTime = timeMatch[1].replace('：', ':');
    finalCloseTime = timeMatch[2].replace('：', ':');
  } else {
    const singleTime = hoursBlock.match(/(\d{1,2}[：:]\d{2})/);
    if (singleTime) {
      finalOpenTime = singleTime[1].replace('：', ':');
    }
  }

  if (finalCloseTime === '24:00' || finalCloseTime === '0:00') finalCloseTime = '24:00';

  // 定休日・営業日の最終値を確定
  const businessDaySet   = extractDaySet(rawBusinessDayText);
  const finalHoliday     = resolveFinalHoliday(rawHolidayText, businessDaySet);
  const finalBusinessDays = ALL_DAYS.filter(d => businessDaySet.has(d)).join('・');

  return {
    holiday:      finalHoliday,      // 定休日（曜日 or 無休 or - or 空欄）
    businessDays: finalBusinessDays, // 営業日（曜日 or 空欄）
    openTime:     finalOpenTime,     // 営業開始時間（既存のまま）
    closeTime:    finalCloseTime,    // 営業終了時間（既存のまま）
  };
}

function tabelogGetLinks(doc, baseUrl) {
  const links = [];
  const RST_URL_RE = /tabelog\.com\/[a-z]+\/A\d+\/A\d+\/\d+\//;
  const primary = doc.querySelectorAll('.list-rst__rst-name-target, .js-rst-cassette-wrap .list-rst__name a, a.list-rst__name-main');
  primary.forEach(a => {
    const rawHref = a.getAttribute('href') || '';
    const href = resolveUrl(rawHref, baseUrl).split('?')[0];
    if (RST_URL_RE.test(href) && !links.includes(href)) links.push(href);
  });
  if (links.length === 0) {
    doc.querySelectorAll('a[href]').forEach(a => {
      const rawHref = a.getAttribute('href') || '';
      const href = resolveUrl(rawHref, baseUrl).split('?')[0];
      if (RST_URL_RE.test(href) && !links.includes(href)) links.push(href);
    });
  }
  return links;
}

function tabelogGetNextUrl(doc, baseUrl) {
  const nextBtn = doc.querySelector('a.c-pagination__arrow--next')
    || doc.querySelector('.c-pagination__arrow--next a');
  if (nextBtn && !nextBtn.classList.contains('is-disabled')) {
    const rawHref = nextBtn.getAttribute('href') || '';
    return resolveUrl(rawHref, baseUrl);
  }
  return null;
}

function hotpepperGetLinks(doc, baseUrl) {
  const links = [];
  const anchors = doc.querySelectorAll('.shopDetailTop a, .shopName a, h3.shopName a, a.shopDetailLink, .list-cassette__unit a');
  anchors.forEach(a => {
    const rawHref = a.getAttribute('href') || '';
    let href = resolveUrl(rawHref, baseUrl).split('?')[0].split('#')[0];
    if (/^https?:\/\/(www\.)?hotpepper\.jp\/(strJ[A-Z0-9]+|A[A-Z0-9]+)\/?$/.test(href)) {
      if (!href.endsWith('/')) href += '/';
      if (!links.includes(href)) links.push(href);
    }
  });
  if (links.length === 0) {
    doc.querySelectorAll('a[href]').forEach(a => {
      const rawHref = a.getAttribute('href') || '';
      let href = resolveUrl(rawHref, baseUrl).split('?')[0].split('#')[0];
      if (/^https?:\/\/(www\.)?hotpepper\.jp\/(strJ[A-Z0-9]+|A[A-Z0-9]+)\/?$/.test(href)) {
        if (!href.endsWith('/')) href += '/';
        if (!links.includes(href)) links.push(href);
      }
    });
  }
  return links;
}

function hotpepperGetNextUrl(doc, baseUrl) {
  const pagerContainers = doc.querySelectorAll('.pageLinkLinearBasic, .pagination, .pager, .page-list, .pageList, .page-link');
  let nextBtn = null;
  for (const container of pagerContainers) {
    const anchors = Array.from(container.querySelectorAll('a'));
    nextBtn = anchors.find(a => a.textContent.includes('次') || a.getAttribute('rel') === 'next');
    if (nextBtn) break;
  }
  if (!nextBtn) {
    const anchors = Array.from(doc.querySelectorAll('a.pa_next, a[rel="next"]'));
    nextBtn = anchors.find(a =>
      a.textContent.includes('次') ||
      a.getAttribute('rel') === 'next' ||
      a.classList.contains('pa_next')
    );
  }
  if (nextBtn) {
    const rawHref = nextBtn.getAttribute('href') || '';
    return resolveUrl(rawHref, baseUrl);
  }
  return null;
}

async function fetchAndParseDetail(link, siteType, signal = null) {
  try {
    const res = await fetch(link, { signal: signal || AbortSignal.timeout(10000) });
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    let name = '', genre = '', address = '', phone = '';

    if (siteType === 'tabelog') {
      name = doc.querySelector('.display-name')?.textContent?.trim() || doc.title.split('|')[0].trim();
      address = doc.querySelector('p.rstinfo-table__address')?.textContent?.trim() || '';

      let realPhone = doc.querySelector('.rstinfo-table__tel-num')?.textContent?.trim() || '';
      let reservePhone = '';
      let fallbackPhone = '';
      let tHours = '';
      let tClosed = '';

      const businessItems = doc.querySelectorAll('.rstinfo-table__business-item');
      if (businessItems.length > 0) {
        const itemsArray = [];
        businessItems.forEach(item => {
          const txt = item.textContent.trim().replace(/\s+/g, ' ');
          if (txt) itemsArray.push(txt);
        });
        tHours = itemsArray.join(' | ');
      }

      doc.querySelectorAll('.rstinfo-table__table th, table th').forEach(th => {
        const t = th.textContent.trim();
        if (t.includes('ジャンル')) genre = th.nextElementSibling?.textContent?.trim() || genre;
        if (t.includes('住所') && !address) address = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('電話番号') && !realPhone) realPhone = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('予約') || t.includes('お問い合わせ')) reservePhone = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('営業時間') && !tHours) tHours = th.nextElementSibling?.textContent?.trim() || '';
        if (t.includes('定休日')) tClosed = th.nextElementSibling?.textContent?.trim() || '';
      });

      if (!realPhone && !reservePhone) {
        const telAnchor = doc.querySelector('a[href^="tel:"]');
        if (telAnchor) fallbackPhone = telAnchor.getAttribute('href').replace('tel:', '').trim();
      }

      phone = realPhone || reservePhone || fallbackPhone;
      address = address.replace(/大きな地図を見る/g, '').replace(/周辺のお店を探す/g, '').replace(/\s+/g, ' ').trim();
      phone = phone.replace(/[^\d\-]/g, '');

      let combinedText = '';
      if (tHours) combinedText += `【営業時間】${tHours} `;
      if (tClosed) combinedText += `【定休日】${tClosed}`;
      combinedText = combinedText.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

      return { name, genre, address, phone, business_hours: combinedText, url: link, source: 'tabelog' };
    }

    else if (siteType === 'hotpepper') {
      const shopInner = doc.querySelector('.shopInner.meiryoFont') || doc.querySelector('.shopDetailInnerTop') || doc;
      name = shopInner.querySelector('.shopName')?.textContent?.trim()
        || doc.querySelector('h1')?.textContent?.trim()
        || doc.title.split('|')[0].trim();

      let businessHours = '';
      let regularHoliday = '';

      doc.querySelectorAll('table tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 2) return;
        const label = cells[0].textContent.trim();
        const valFirstLine = cells[1].textContent.trim().split('\n')[0].replace(/\s+/g, ' ').trim();
        const valFull = cells[1].textContent.replace(/\s+/g, ' ').trim();

        if (label === '店名' && (!name || name === doc.title.split('|')[0].trim())) name = valFirstLine || name;
        if (label === '住所' && !address) address = valFull;
        if ((label === '電話' || label === 'TEL') && !phone) phone = valFirstLine;
        if ((label === 'ジャンル' || label === '料理') && !genre) genre = valFull;
        if (label === '営業時間' && !businessHours) {
          businessHours = Array.from(cells[1].childNodes)
            .map(n => n.textContent.trim()).filter(Boolean).join(' ');
        }
        if (label === '定休日' && !regularHoliday) regularHoliday = valFirstLine;
      });

      shopInner.querySelectorAll('th').forEach(th => {
        const t = Array.from(th.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent.trim()).join('')
          || th.firstElementChild?.textContent?.trim()
          || th.textContent?.split('\n')[0].trim();

        const td = th.nextElementSibling;
        if (!td) return;
        const tdText = td.textContent.trim().split('\n')[0].trim();
        const tdFull = td.textContent.replace(/\s+/g, ' ').trim();

        if (t.includes('店名') && (!name || name === doc.title.split('|')[0].trim())) name = tdText || name;
        if (t.includes('住所') && !address) address = tdFull || '';
        if ((t.includes('電話') || t.includes('TEL') || t.includes('問い合わせ')) && !phone) phone = tdText || '';
        if ((t.includes('ジャンル') || t.includes('料理')) && !genre) genre = tdFull || '';
        if (t.includes('営業時間') && !businessHours) {
          businessHours = Array.from(td.childNodes)
            .map(n => n.textContent.trim()).filter(Boolean).join(' ');
        }
        if (t.includes('定休日') && !regularHoliday) regularHoliday = tdText || '';
      });

      if (!businessHours && !regularHoliday) {
        doc.querySelectorAll('dl').forEach(dl => {
          const dt = dl.querySelector('dt');
          const dd = dl.querySelector('dd');
          if (!dt || !dd) return;
          const t = dt.textContent.trim();
          const val = dd.textContent.replace(/\s+/g, ' ').trim();
          if (t.includes('営業時間') && !businessHours) businessHours = val;
          if (t.includes('定休日') && !regularHoliday) regularHoliday = dd.textContent.trim().split('\n')[0].trim();
          if (t.includes('住所') && !address) address = val;
          if ((t.includes('ジャンル') || t.includes('料理')) && !genre) genre = val;
        });
      }

      if (!businessHours || !regularHoliday) {
        const allElements = doc.querySelectorAll('td, dd, span, p, div');
        let prevLabel = '';
        allElements.forEach(el => {
          const t = el.textContent.trim();
          if (['営業時間', '定休日', '住所', '電話', 'ジャンル'].includes(t)) { prevLabel = t; return; }
          if (prevLabel === '営業時間' && !businessHours && t.length > 3) { businessHours = t.replace(/\s+/g, ' ').trim(); prevLabel = ''; }
          if (prevLabel === '定休日' && !regularHoliday && t.length >= 1) { regularHoliday = t.trim().split('\n')[0].trim(); prevLabel = ''; }
          if (prevLabel === '住所' && !address && t.length > 3) { address = t.replace(/\s+/g, ' ').trim(); prevLabel = ''; }
          if (prevLabel === '電話' && !phone && t.length > 5) { phone = t.trim().split('\n')[0].trim(); prevLabel = ''; }
          if (prevLabel === 'ジャンル' && !genre && t.length >= 2) { genre = t.replace(/\s+/g, ' ').trim(); prevLabel = ''; }
        });
      }

      if (!address) {
        address = shopInner.querySelector('.shopDetailInfoAddress')?.textContent?.trim()
          || shopInner.querySelector('.address')?.textContent?.trim() || '';
      }
      if (!phone) {
        phone = shopInner.querySelector('.shopDetailInfoTel')?.textContent?.trim()
          || shopInner.querySelector('.tel')?.textContent?.trim()
          || shopInner.querySelector('a[href^="tel:"]')?.textContent?.trim() || '';
      }

      const telLinkNode = doc.querySelector('.telLink');
      if (telLinkNode || !phone || phone.includes('電話番号を表示する')) {
        try {
          let telUrl = telLinkNode ? telLinkNode.getAttribute('href') : '';
          if (telUrl && !telUrl.startsWith('http')) {
            if (telUrl.startsWith('/')) {
              const urlObj = new URL(link);
              telUrl = urlObj.origin + telUrl;
            } else {
              const baseUrl = link.endsWith('/') ? link.slice(0, -1) : link;
              telUrl = baseUrl + '/' + telUrl;
            }
          }
          if (!telUrl) telUrl = (link.endsWith('/') ? link : link + '/') + 'tel/';

          await sleep(500);
          const telRes = await fetch(telUrl, { signal: signal || AbortSignal.timeout(8000) });
          const telHtml = await telRes.text();
          const telDoc = new DOMParser().parseFromString(telHtml, 'text/html');
          const telNode = telDoc.querySelector('.telephoneNumber')
            || telDoc.querySelector('.tel')
            || telDoc.querySelector('.telephone')
            || telDoc.querySelector('a[href^="tel:"]');
          if (telNode) {
            let rawTel = telNode.textContent.trim();
            if (telNode.tagName === 'A' && telNode.getAttribute('href')?.startsWith('tel:')) {
              const telHref = telNode.getAttribute('href').replace('tel:', '').trim();
              phone = /[0-9]/.test(rawTel) ? rawTel : telHref;
            } else {
              phone = rawTel;
            }
          }
        } catch (e) { }
      }

      address = address.replace(/地図を見る/g, '').replace(/\s+/g, ' ').replace(/\n/g, '').trim();
      phone = phone.replace(/[^\d\-]/g, '');
      name = name.replace(/\n/g, '').trim();
      genre = genre.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

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
      const genreLabel = task.metadata?.industry ? `「${task.metadata.industry}」` : '';
      sendToBackground(tabId, 'PAGE_START', { page: pageNum, collected, siteName, genreLabel });

      await sleep(DELAY_LIST_FETCH);
      const res = await fetch(currentListUrl);
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

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
      let links = getLinks(doc, currentListUrl) || [];

      const existingUrls = new Set(task.results.map(r => r.url));
      links = links.filter(l => !existingUrls.has(l.split('?')[0]));

      const remaining = task.maxItems - collected;
      links = links.slice(0, remaining);

      if (links.length === 0) {
        sendToBackground(tabId, 'INFO', { message: `${genreLabel} ${pageNum}ページ目: 新規リンクなし → 終了` });
        break;
      }

      sendToBackground(tabId, 'INFO', { message: `📋 ${genreLabel} ${pageNum}ページ目: ${links.length}件を取得中...` });

      for (let i = 0; i < links.length; i += CHUNK_SIZE) {
        if (!task.running) break;
        const chunk = links.slice(i, i + CHUNK_SIZE);

        for (const link of chunk) {
          if (!task.running) break;
          try {
            const detail = await fetchAndParseDetail(link, siteType, task.abortController?.signal);
            if (detail && detail.name) {
              const normalized = normalizeBusinessHours(detail.business_hours || '');
              const finalDetail = {
                name: detail.name,
                genre: detail.genre,
                address: detail.address,
                phone: detail.phone || '',
                regular_holiday: normalized.holiday,
                business_days: normalized.businessDays || '',
                open_time: normalized.openTime || '',
                close_time: normalized.closeTime || '',
                url: detail.url,
                source: detail.source
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
            if (err.name === 'AbortError') break;
            console.error('詳細パース失敗:', err);
          }
        }

        await sleep(DELAY_BETWEEN_CHUNKS);
      }

      if (!task.running || collected >= task.maxItems) break;

      const getNextUrl = siteType === 'tabelog' ? tabelogGetNextUrl : hotpepperGetNextUrl;
      const nextUrl = getNextUrl(doc, currentListUrl);
      if (!nextUrl) {
        sendToBackground(tabId, 'INFO', { message: `${genreLabel} 最終ページに達しました` });
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

    sendToBackground(tabId, 'DONE', {
      collected: task.results.length,
      results: task.results,
      metadata: task.metadata
    });

    const mediaName = task.metadata.media === 'tabelog'
      ? '食べログ'
      : (task.metadata.media === 'hotpepper' ? 'ホットペッパー' : 'サイト');
    const area = task.metadata.area || '';
    const industry = task.metadata.industry || '';
    const count = task.results.length;

    let title = '取得完了';
    let message = `${area} ${industry} (${mediaName}) の取得が完了しました。計 ${count} 件`;

    if (collected >= task.maxItems) title = '取得完了 (上限到達)';
    else if (collected < task.maxItems) {
      title = '取得停止';
      message = `${area} ${industry} (${mediaName}) の取得を停止しました。計 ${count} 件取得済み`;
    }

    chrome.runtime.sendMessage({ target: 'background', type: 'SHOW_NOTIFICATION', title, message });
    if (task.results.length > 0) {
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'DOWNLOAD_CSV',
        results: task.results,
        metadata: task.metadata,
        tabId
      });
    }
  }
}

// ============================================================
// メッセージリスナー
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  const tabId = message.tabId;

  if (message.type === 'GENRE_LINKS_FROM_CONTENT_RESULT') {
    const resolver = genreLinksResolvers.get(message.tabId);
    if (resolver) {
      resolver(message.links || []);
      genreLinksResolvers.delete(message.tabId);
    }
    sendResponse && sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'START_CRAWL') {
    if (activeTasks.get(tabId)?.running) {
      sendResponse({ ok: false, error: 'このタブで既に実行中です' });
      return;
    }
    const siteType = getSiteType(message.listUrl);
    const controller = new AbortController();
    activeTasks.set(tabId, {
      running: true,
      tabId,
      listUrl: message.listUrl,
      results: [],
      maxItems: message.maxItems || Infinity,
      metadata: { media: siteType, area: '', industry: '' },
      abortController: controller
    });
    runCrawlTask(tabId);
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'STOP_CRAWL') {
    const task = activeTasks.get(tabId);
    if (task) {
      task.running = false;
      task.abortController?.abort();
    }
    const popularTask = activeTasks.get(tabId + '_popular');
    if (popularTask) {
      popularTask.running = false;
      popularTask.abortController?.abort();
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'GET_RESULTS') {
    const popularTask = activeTasks.get(tabId + '_popular');
    const task = popularTask || activeTasks.get(tabId);
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

  if (message.action === 'START_POPULAR_GENRE_CRAWL') {
    if (activeTasks.get(tabId)?.running || activeTasks.get(tabId + '_popular')?.running) {
      sendResponse({ ok: false, error: 'このタブで既に実行中です' });
      return;
    }
    runPopularGenreCrawl(tabId, message.listUrl, message.maxItems || Infinity);
    sendResponse({ ok: true });
    return;
  }
});

// ============================================================
// extractGenreLinks()
// ============================================================
async function extractGenreLinks(listUrl, siteType, tabId) {
  if (tabId != null) {
    try {
      const liveLinks = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          genreLinksResolvers.delete(tabId);
          resolve([]);
        }, 5000);

        genreLinksResolvers.set(tabId, (links) => {
          clearTimeout(timer);
          resolve(links);
        });

        chrome.runtime.sendMessage({
          target: 'background',
          type: 'GET_GENRE_LINKS_FROM_CONTENT',
          tabId,
          siteType
        }).catch(() => {
          clearTimeout(timer);
          genreLinksResolvers.delete(tabId);
          resolve([]);
        });
      });

      if (liveLinks.length > 0) return liveLinks;
    } catch (e) {
      console.warn('[extractGenreLinks] ライブDOM問い合わせ失敗:', e);
    }
  }

  // fetchフォールバック
  try {
    const res = await fetch(listUrl);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const links = [];

    if (siteType === 'tabelog') {
      const scroll = doc.getElementById('js-leftnavi-genre-scroll');
      if (scroll) {
        scroll.querySelectorAll('.list-balloon__btn-list a[href]').forEach(a => {
          const href = resolveUrl(a.getAttribute('href') || '', listUrl).split('?')[0].split('#')[0];
          const name = a.textContent.trim().replace(/\s+/g, ' ');
          if (href && name && /tabelog\.com/.test(href) && !links.some(l => l.url === href)) {
            links.push({ name, url: href });
          }
        });
      }
      if (links.length === 0) {
        doc.querySelectorAll('.list-balloon__btn-list a[href]').forEach(a => {
          const href = resolveUrl(a.getAttribute('href') || '', listUrl).split('?')[0].split('#')[0];
          const name = a.textContent.trim().replace(/\s+/g, ' ');
          if (href && name && /tabelog\.com/.test(href) && !links.some(l => l.url === href)) {
            links.push({ name, url: href });
          }
        });
      }

    } else if (siteType === 'hotpepper') {
      doc.querySelectorAll('.reselectionList li a[href]').forEach(a => {
        const href = resolveUrl(a.getAttribute('href') || '', listUrl).split('?')[0].split('#')[0];
        const name = a.textContent.trim().replace(/\s+/g, ' ');
        if (!href || !name) return;
        if (!/hotpepper\.jp/.test(href)) return;
        if (!/\/G\d+/.test(href)) return;
        if (links.some(l => l.url === href)) return;
        links.push({ name, url: href });
      });
    }

    return links;
  } catch (e) {
    console.error('[extractGenreLinks] fetchフォールバック失敗:', e);
    return [];
  }
}

// ============================================================
// runPopularGenreCrawl()
// ============================================================
async function runPopularGenreCrawl(tabId, listUrl, maxItemsPerGenre) {
  const siteType = getSiteType(listUrl);
  if (!siteType) {
    sendToBackground(tabId, 'ERROR', { message: '対応サイトではありません' });
    return;
  }

  const parentTaskKey = tabId + '_popular';
  activeTasks.set(parentTaskKey, {
    running: true,
    results: [],
    metadata: { media: siteType, area: '', industry: '人気ジャンル一括' }
  });

  try {
    sendToBackground(tabId, 'INFO', { message: 'ジャンルリンクを抽出中...' });
    let genreLinks = [];
    try {
      genreLinks = await extractGenreLinks(listUrl, siteType, tabId);
    } catch (e) {
      sendToBackground(tabId, 'ERROR', { message: `ジャンルリンク取得失敗: ${e.message}` });
      activeTasks.delete(parentTaskKey);
      return;
    }

    if (genreLinks.length === 0) {
      const reason = siteType === 'tabelog'
        ? 'ジャンルリンクが見つかりません。食べログの検索結果ページを開いた状態で実行してください。'
        : 'ジャンルリンクが見つかりません。ホットペッパーのエリアページを開いた状態で実行してください。';
      sendToBackground(tabId, 'ERROR', { message: reason });
      activeTasks.delete(parentTaskKey);
      return;
    }

    sendToBackground(tabId, 'INFO', {
      message: `${genreLinks.length}ジャンルを検出: ${genreLinks.map(g => g.name).join('、')}`
    });

    const allResults = [];

    for (let i = 0; i < genreLinks.length; i++) {
      const parentTask = activeTasks.get(parentTaskKey);
      if (!parentTask || !parentTask.running) {
        sendToBackground(tabId, 'INFO', { message: '停止リクエストにより中断しました' });
        break;
      }

      const { name, url } = genreLinks[i];
      sendToBackground(tabId, 'INFO', {
        message: `🏷️ [ジャンル ${i + 1}/${genreLinks.length}]「${name}」の取得を開始します`
      });

      const tempId = `${tabId}_pg_${i}`;
      const subController = new AbortController();
      activeTasks.set(tempId, {
        running: true,
        tabId,
        listUrl: url,
        results: [],
        maxItems: maxItemsPerGenre,
        metadata: { media: siteType, area: '', industry: name },
        abortController: subController
      });

      await runCrawlTask(tempId);

      const finishedTask = activeTasks.get(tempId);
      if (finishedTask?.results?.length) {
        const taggedResults = finishedTask.results.map(r => ({
          ...r,
          source_genre: name
        }));
        allResults.push(...taggedResults);
      }
      activeTasks.delete(tempId);

      sendToBackground(tabId, 'INFO', {
        message: `✅ [ジャンル ${i + 1}/${genreLinks.length}]「${name}」完了 → 累計 ${allResults.length} 件`
      });

      if (i < genreLinks.length - 1) {
        const pt = activeTasks.get(parentTaskKey);
        if (pt && pt.running) await sleep(2000);
      }
    }

    const pt = activeTasks.get(parentTaskKey);
    if (pt) {
      pt.results = allResults;
      pt.running = false;
    }

    const metaArea = allResults[0]?.address?.replace(/\s+/g, '').slice(0, 6) || '';
    const finalMetadata = { media: siteType, area: metaArea, industry: '人気ジャンル一括' };

    sendToBackground(tabId, 'DONE', {
      collected: allResults.length,
      results: allResults,
      metadata: finalMetadata
    });

    if (allResults.length > 0) {
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'DOWNLOAD_CSV',
        results: allResults,
        metadata: finalMetadata,
        tabId
      });
    }

    chrome.runtime.sendMessage({
      target: 'background',
      type: 'SHOW_NOTIFICATION',
      title: '人気ジャンル一括取得 完了',
      message: `計 ${allResults.length} 件取得しました`
    });

  } catch (err) {
    console.error('[runPopularGenreCrawl] エラー:', err);
    sendToBackground(tabId, 'ERROR', { message: `人気ジャンル一括取得エラー: ${err.message}` });
  } finally {
    activeTasks.delete(parentTaskKey);
  }
}

chrome.runtime.sendMessage({ target: 'background', type: 'OFFSCREEN_READY' }).catch(() => { });