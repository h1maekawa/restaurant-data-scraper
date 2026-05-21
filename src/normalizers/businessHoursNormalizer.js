/**
 * businessHoursNormalizer.js
 *
 * 営業時間・定休日を正規化し、CSVやプレビュー向けに整形・分離するユーティリティ。
 * TypeScriptで実装された設計をVanilla JS/ESM互換で実装し、JSDocで型定義を行っています。
 */

// ============================================================
// 定数定義
// ============================================================
const DAYS_ORDER = ['月', '火', '水', '木', '金', '土', '日'];
const DAY_INDEX = { '月': 0, '火': 1, '水': 2, '木': 3, '金': 4, '土': 5, '日': 6 };

/**
 * 曜日の範囲を展開します (例: 火〜土 -> ['火', '水', '木', '金', '土'])
 * @param {string} startDay 
 * @param {string} endDay 
 * @returns {string[]}
 */
function expandDayRange(startDay, endDay) {
  const startIndex = DAY_INDEX[startDay];
  const endIndex = DAY_INDEX[endDay];
  if (startIndex === undefined || endIndex === undefined) return [];

  const result = [];
  let curr = startIndex;
  while (true) {
    result.push(DAYS_ORDER[curr]);
    if (curr === endIndex) break;
    curr = (curr + 1) % 7;
  }
  return result;
}

/**
 * テキストから曜日範囲・単発の曜日・祝日等の特殊営業日をパースします
 * @param {string} text 
 * @returns {{ days: string[], hasHoliday: boolean, hasEveOfHoliday: boolean }}
 */
function parseDaysAndSpecial(text) {
  const days = new Set();
  let hasHoliday = false;
  let hasEveOfHoliday = false;

  // 曜日範囲 (例: 月〜金, 火〜土) の抽出
  const rangeRegex = /([月火水木金土日])\s*〜\s*([月火水木金土日])/g;
  let match;
  let tempText = text;

  while ((match = rangeRegex.exec(text)) !== null) {
    const rangeDays = expandDayRange(match[1], match[2]);
    rangeDays.forEach(d => days.add(d));
    tempText = tempText.replace(match[0], ''); // 処理済み部分を除去
  }

  // 個別の曜日 (例: 月・火・水 または 月曜日, 火曜日)
  const dayRegex = /[月火水木金土日](?:曜日)?/g;
  while ((match = dayRegex.exec(tempText)) !== null) {
    const dayChar = match[0].charAt(0);
    days.add(dayChar);
  }

  // 特殊営業日 (祝日・祝前日) の判定
  if (text.includes('祝前日') || text.includes('祝前')) {
    hasEveOfHoliday = true;
  } else if (text.includes('祝日') || text.includes('祝')) {
    hasHoliday = true;
  }

  return {
    days: Array.from(days),
    hasHoliday,
    hasEveOfHoliday
  };
}

/**
 * 表記を統一し、グルメサイト特有の「定型文長文ノイズ」を徹底排除します
 * @param {string} text 
 * @returns {string}
 */
function cleanText(text) {
  if (!text) return '';
  let s = text;

  // グルメサイト特有の「営業リストに不要な定型文」を完全に消去
  const junkPhrases = [
    /新型コロナウイルス感染拡大.*場合がございます/g,
    /ご来店時は事前に店舗にご確認ください/g,
    /営業時間・定休日が記載と異なる場合がございます/g,
    /現在の営業時間と異なる場合があります/g,
    /営業時間は変更となる場合がございます/g,
    /店休日は変更となる場合がございます/g,
    /詳しくは店舗までお問い合わせください/g,
    /※店舗へご確認ください/g
  ];
  junkPhrases.forEach(regex => { s = s.replace(regex, ''); });

  // 波ダッシュ・ハイフン類の統一
  s = s.replace(/[~\-ー－─━~～]/g, '〜');
  // コロンを全角「：」に統一
  s = s.replace(/：/g, '：');
  s = s.replace(/:/g, '：');
  // 全角スペースを半角スペースに
  s = s.replace(/　/g, ' ');
  // 連続するスペースを1つに
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

/**
 * 補足情報 (L.O. や注意事項など) を抽出・分離します
 * @param {string} text 
 * @returns {{ notes: string, remainingText: string }}
 */
function extractBusinessHourNotes(text) {
  const notes = [];
  const remainingParts = [];

  // 改行、読点、セミコロン等で分割して各パーツを評価
  const parts = text.split(/[\n\r、。;]+/);

  const noteKeywords = [
    'L.O', 'LO', 'l.o', 'ラストオーダー', 'ラストオータ', 'ラストオオダ',
    '公式', 'HP', '最新情報', '参照', '確認', '変更', '可能性',
    '混雑', '前後', '了承', '注意', '備考', '完売', '無くなり次第', '売り切れ',
    '前後する', '前後いたします', '※', '＊', '臨時', '特別営業', '料理', 'ドリンク'
  ];

  for (let part of parts) {
    part = part.trim();
    if (!part) continue;

    // キーワードマッチ
    const isNote = noteKeywords.some(kw => part.toLowerCase().includes(kw.toLowerCase()));

    if (isNote) {
      notes.push(part);
    } else {
      remainingParts.push(part);
    }
  }

  return {
    notes: notes.join('\n'),
    remainingText: remainingParts.join(' ')
  };
}

/**
 * テキストから純粋な「定休日」の情報だけを切り出して整理します
 * @param {string} text 
 * @returns {string}
 */
function extractClosedDays(text) {
  // 1. 【定休日】月 などの明確なパターン (ホットペッパーおよび修正後の食べログ形式)
  const explicitMatch = text.match(/【定休日】\s*([^\s【】]+)/);
  if (explicitMatch) {
    let res = explicitMatch[1].trim();
    // もし定休日の中に時間やL.O.などのノイズが残っていたら後ろを削る
    res = res.split(/[（(]?[0-9０-９]/)[0];
    return res.replace(/[：:、。,;\.]+$/, '').trim() || '不定休';
  }

  // 2. 「定休日：月曜日」などのパターン
  const generalMatch = text.match(/定休日\s*[\s：:]\s*([^\s＊※（()）]+)/);
  if (generalMatch) {
    return generalMatch[1].trim();
  }

  // 3. 不定休や年中無休の直接チェック
  if (text.includes('不定休')) return '不定休';
  if (text.includes('年中無休')) return '年中無休';
  if (text.includes('無休')) return '年中無休';

  // 4. 定休日という単語の後ろの曜日をスキャン
  const closedMatch = text.match(/(?:定休日|休業日)[^\s]*[\s：:]*([月火水木金土日祝・、,]+)/);
  if (closedMatch) {
    return closedMatch[1].trim();
  }

  return '';
}

/**
 * テキストから時間帯ブロックとそれに紐づく曜日を抽出します
 * @param {string} text 
 * @returns {Array<{daysText: string, timeRange: string, parsed: {days: string[], hasHoliday: boolean, hasEveOfHoliday: boolean}}>}
 */
function extractTimeBlocks(text) {
  // 時間帯を表す正規表現
  const timeRegex = /(\d{1,2}[:：]\d{2})\s*[〜\-~]\s*(\d{1,2}[:：]\d{2})/g;

  const blocks = [];
  const matches = [];
  let match;

  while ((match = timeRegex.exec(text)) !== null) {
    matches.push({
      start: match.index,
      end: timeRegex.lastIndex,
      text: match[0],
      startTime: match[1],
      endTime: match[2]
    });
  }

  if (matches.length === 0) {
    // 24時間営業などの特殊表記判定
    if (text.includes('24時間営業') || text.includes('24時間')) {
      return [{
        daysText: text,
        timeRange: '24時間営業',
        parsed: parseDaysAndSpecial(text)
      }];
    }
    return [];
  }

  for (let i = 0; i < matches.length; i++) {
    const curr = matches[i];

    // 直前のテキストを検索範囲とする
    let searchStart = i === 0 ? 0 : matches[i - 1].end;
    let prevText = text.substring(searchStart, curr.start).trim();

    // 直後のテキストも確認範囲とする
    let searchEnd = i === matches.length - 1 ? text.length : matches[i + 1].start;
    let nextText = text.substring(curr.end, searchEnd).trim();

    let daysText = prevText;
    let parsed = parseDaysAndSpecial(prevText);

    // 直前のテキストに曜日指定がなく、直後に存在する場合
    if (parsed.days.length === 0 && !parsed.hasHoliday && !parsed.hasEveOfHoliday) {
      const nextParsed = parseDaysAndSpecial(nextText);
      if (nextParsed.days.length > 0 || nextParsed.hasHoliday || nextParsed.hasEveOfHoliday) {
        daysText = nextText;
        parsed = nextParsed;
      }
    }

    // 曜日が一切見つからない場合は「全日」と判定
    if (parsed.days.length === 0 && !parsed.hasHoliday && !parsed.hasEveOfHoliday) {
      parsed.days = [...DAYS_ORDER];
    }

    blocks.push({
      daysText,
      timeRange: curr.text.replace(/:/g, '：'), // 表示統一
      parsed
    });
  }

  return blocks;
}

/**
 * 曜日配列から連続する部分を検出し、「月〜金」や「月・水・金」のような表記を生成します
 * @param {string[]} daysArr 
 * @returns {string}
 */
function getFormattedDaysString(daysArr) {
  if (daysArr.length === 0) return '';
  if (daysArr.length === 7) return '月〜日';
  if (daysArr.length === 1) return daysArr[0];

  const segments = [];
  let startIdx = 0;

  while (startIdx < daysArr.length) {
    let endIdx = startIdx;

    while (endIdx + 1 < daysArr.length &&
      DAY_INDEX[daysArr[endIdx + 1]] === DAY_INDEX[daysArr[endIdx]] + 1) {
      endIdx++;
    }

    const count = endIdx - startIdx + 1;
    if (count >= 3) {
      segments.push(`${daysArr[startIdx]}〜${daysArr[endIdx]}`);
    } else {
      for (let i = startIdx; i <= endIdx; i++) {
        segments.push(daysArr[i]);
      }
    }
    startIdx = endIdx + 1;
  }

  return segments.join('・');
}

/**
 * 同一の営業時間を持つ曜日グループをまとめ、整形された営業時間文字列を返します
 * @param {Array<{daysText: string, timeRange: string, parsed: {days: string[], hasHoliday: boolean, hasEveOfHoliday: boolean}}>} blocks 
 * @returns {string}
 */
function groupBusinessDays(blocks) {
  const timeGroups = new Map();

  for (const block of blocks) {
    const time = block.timeRange;
    if (!timeGroups.has(time)) {
      timeGroups.set(time, {
        days: new Set(),
        hasHoliday: false,
        hasEveOfHoliday: false
      });
    }
    const group = timeGroups.get(time);
    block.parsed.days.forEach(d => group.days.add(d));
    if (block.parsed.hasHoliday) group.hasHoliday = true;
    if (block.parsed.hasEveOfHoliday) group.hasEveOfHoliday = true;
  }

  const resultLines = [];

  timeGroups.forEach((info, time) => {
    const daysArr = Array.from(info.days);

    // 曜日の順序に並び替え
    daysArr.sort((a, b) => DAY_INDEX[a] - DAY_INDEX[b]);

    const formattedDays = getFormattedDaysString(daysArr);

    const specialTags = [];
    if (info.hasHoliday) specialTags.push('祝日');
    if (info.hasEveOfHoliday) specialTags.push('祝前日');

    let daysPart = '';
    if (formattedDays && specialTags.length > 0) {
      daysPart = `${formattedDays}・${specialTags.join('・')}`;
    } else if (formattedDays) {
      daysPart = formattedDays;
    } else if (specialTags.length > 0) {
      daysPart = specialTags.join('・');
    }

    if (daysPart) {
      resultLines.push(`${daysPart}：${time}`);
    } else {
      resultLines.push(time);
    }
  });

  return resultLines.join('\n');
}

/**
 * 営業時間・定休日の正規化および分割処理を行うメインエントリーポイント
 * @param {string} rawText 媒体から取得した生の営業時間テキスト
 * @returns {{
 * raw_business_hours: string,
 * normalized_business_hours: string,
 * normalized_closed_days: string,
 * business_hours_note: string
 * }}
 */
function normalizeBusinessHours(rawText) {
  try {
    if (!rawText) {
      return {
        raw_business_hours: '',
        normalized_business_hours: '',
        normalized_closed_days: '',
        business_hours_note: ''
      };
    }

    // 1. テキストの前処理とクレンジング
    let cleaned = cleanText(rawText);

    // 2. 補足情報 (Notes) の抽出と分離
    const noteData = extractBusinessHourNotes(cleaned);
    let businessHoursNote = noteData.notes;
    let mainHoursText = noteData.remainingText;

    // 3. 定休日の抽出と分離
    let closedDays = extractClosedDays(cleaned);
    // 定休日が抽出された場合、メインテキストから定休日関連の記述を消去
    mainHoursText = mainHoursText.replace(/【?定休日】?[^\s]*/g, '');
    mainHoursText = mainHoursText.replace(/不定休/g, '');
    mainHoursText = mainHoursText.replace(/年中無休/g, '');
    mainHoursText = cleanText(mainHoursText); // 再クレンジング

    // 4. 営業時間の抽出と曜日マッピング
    const blocks = extractTimeBlocks(mainHoursText);

    // 5. 曜日グルーピングと整形
    let normalizedHours = '';
    if (blocks.length > 0) {
      normalizedHours = groupBusinessDays(blocks);
    } else {
      // 時間帯ブロックが解析できなかった場合のフォールバック
      normalizedHours = mainHoursText;
    }

    return {
      raw_business_hours: rawText,
      normalized_business_hours: normalizedHours,
      normalized_closed_days: closedDays || '無休',
      business_hours_note: businessHoursNote
    };
  } catch (error) {
    console.error('Error during business hours normalization:', error);
    // エラー時もCSV出力を継続するため、フォールバックデータを返す (try-catch & null安全)
    return {
      raw_business_hours: rawText || '',
      normalized_business_hours: rawText || '',
      normalized_closed_days: '不定休',
      business_hours_note: `解析エラー: ${error.message}`
    };
  }
}

// Service Worker (background.js) からのグローバル呼出に対応できるようエクスポート
if (typeof self !== 'undefined') {
  self.normalizeBusinessHours = normalizeBusinessHours;
}