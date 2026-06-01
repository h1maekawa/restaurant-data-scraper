/**
 * logger.js
 * 媒体別ログ保存 / DEBUGモード管理
 *
 * - chrome.storage.local に媒体別ログバッファを保存
 * - DEBUG=true のとき詳細ログをコンソールに出力
 * - 実行統計（成功/失敗カウント）を管理
 * - ダウンロード可能なテキストログを生成
 */

// ============================================================
// DEBUGフラグ (true にすると詳細ログが出る)
// ============================================================
const DEBUG = true;

// ============================================================
// ログキー定義
// ============================================================
const LOG_KEYS = {
  tabelog:    'log_tabelog',
  hotpepper:  'log_hotpepper',
  googlemaps: 'log_googlemaps',
};

// ログバッファの最大件数 (古いものから削除)
const MAX_LOG_ENTRIES = 500;

// ============================================================
// 統計カウンタ (実行中のみ保持)
// ============================================================
const _stats = {
  tabelog:    _emptyStats(),
  hotpepper:  _emptyStats(),
  googlemaps: _emptyStats(),
};

function _emptyStats() {
  return {
    linksFound:       0,  // 一覧で見つけたリンク数
    detailSuccess:    0,  // 詳細取得成功数
    detailFail:       0,  // 詳細取得失敗数
    hoursSuccess:     0,  // 営業時間取得成功数
    holidaySuccess:   0,  // 定休日取得成功数
    retryCount:       0,  // 再試行回数
  };
}

// ============================================================
// 内部: ログエントリ作成
// ============================================================
function _makeEntry(level, media, message, extra = {}) {
  return {
    ts:      new Date().toISOString(),
    level,   // 'debug' | 'info' | 'warn' | 'error'
    media,   // 'tabelog' | 'hotpepper' | 'googlemaps'
    message,
    ...extra,
  };
}

// ============================================================
// chrome.storage.local へ書き込み
// ============================================================
async function _appendToStorage(media, entry) {
  const key = LOG_KEYS[media];
  if (!key) return;

  try {
    const stored = await chrome.storage.local.get(key);
    const buf = stored[key] || [];
    buf.push(entry);

    // 上限超えたら古いものを削除
    if (buf.length > MAX_LOG_ENTRIES) {
      buf.splice(0, buf.length - MAX_LOG_ENTRIES);
    }

    await chrome.storage.local.set({ [key]: buf });
  } catch (e) {
    // storage 書き込み失敗は握りつぶす（無限ループ防止）
    console.warn('[Logger] storage write failed:', e.message);
  }
}

// ============================================================
// コンソール出力ヘルパー
// ============================================================
function _consoleOut(level, media, message, extra) {
  const tag = `[${media.toUpperCase()}]`;
  const extraStr = Object.keys(extra).length > 0
    ? ' ' + JSON.stringify(extra)
    : '';

  switch (level) {
    case 'error': console.error(tag, message, extraStr); break;
    case 'warn':  console.warn(tag, message, extraStr);  break;
    case 'debug': if (DEBUG) console.debug(tag, message, extraStr); break;
    default:      if (DEBUG) console.log(tag, message, extraStr);   break;
  }
}

// ============================================================
// 公開 API
// ============================================================

/**
 * DEBUGログ (DEBUG=true のときのみコンソール出力 / storage保存はしない)
 */
function logDebug(media, message, extra = {}) {
  if (!DEBUG) return;
  _consoleOut('debug', media, message, extra);
}

/**
 * INFOログ
 */
function logInfo(media, message, extra = {}) {
  _consoleOut('info', media, message, extra);
  const entry = _makeEntry('info', media, message, extra);
  _appendToStorage(media, entry);
}

/**
 * WARNログ
 */
function logWarn(media, message, extra = {}) {
  _consoleOut('warn', media, message, extra);
  const entry = _makeEntry('warn', media, message, extra);
  _appendToStorage(media, entry);
}

/**
 * ERRORログ (必ず storage に保存)
 * @param {string} media
 * @param {string} message
 * @param {Object} extra - { url, storeName, phase, errorDetail } など
 */
function logError(media, message, extra = {}) {
  _consoleOut('error', media, message, extra);
  const entry = _makeEntry('error', media, message, extra);
  _appendToStorage(media, entry);
}

// ============================================================
// 統計操作
// ============================================================
function statsReset(media) {
  if (_stats[media]) _stats[media] = _emptyStats();
}

function statsAdd(media, field, delta = 1) {
  if (_stats[media] && field in _stats[media]) {
    _stats[media][field] += delta;
  }
}

function statsGet(media) {
  return { ...(_stats[media] || _emptyStats()) };
}

/**
 * 実行終了時に統計をログ出力
 */
function statsPrint(media) {
  const s = statsGet(media);
  const lines = [
    `========== [${media.toUpperCase()}] 実行統計 ==========`,
    `  一覧リンク数:         ${s.linksFound}`,
    `  詳細取得成功:         ${s.detailSuccess}`,
    `  詳細取得失敗:         ${s.detailFail}`,
    `  営業時間取得成功:     ${s.hoursSuccess}`,
    `  定休日取得成功:       ${s.holidaySuccess}`,
    `  再試行回数:           ${s.retryCount}`,
    `================================================`,
  ];
  lines.forEach(l => console.log(l));
  logInfo(media, '実行統計', s);
  return s;
}

// ============================================================
// ログ取得 / クリア / ダウンロード
// ============================================================

/**
 * 媒体別ログを chrome.storage.local から取得
 */
async function getLogs(media) {
  const key = LOG_KEYS[media];
  if (!key) return [];
  try {
    const stored = await chrome.storage.local.get(key);
    return stored[key] || [];
  } catch (e) {
    return [];
  }
}

/**
 * 媒体別ログをクリア
 */
async function clearLogs(media) {
  const key = LOG_KEYS[media];
  if (!key) return;
  try {
    await chrome.storage.local.remove(key);
  } catch (e) { /* ignore */ }
}

/**
 * 全媒体ログをテキスト形式で結合して返す（ダウンロード用）
 */
async function buildDownloadableLog(media) {
  const entries = await getLogs(media);
  if (entries.length === 0) return `[${media}] ログなし\n`;

  return entries.map(e => {
    const base = `[${e.ts}] [${e.level.toUpperCase()}] ${e.message}`;
    const extras = [];
    if (e.url)         extras.push(`URL: ${e.url}`);
    if (e.storeName)   extras.push(`店舗: ${e.storeName}`);
    if (e.phase)       extras.push(`フェーズ: ${e.phase}`);
    if (e.errorDetail) extras.push(`詳細: ${e.errorDetail}`);
    return extras.length > 0 ? `${base}\n    ${extras.join(' / ')}` : base;
  }).join('\n') + '\n';
}

// ============================================================
// Service Worker / offscreen.js 両対応エクスポート
// ============================================================
const Logger = {
  DEBUG,
  logDebug,
  logInfo,
  logWarn,
  logError,
  statsReset,
  statsAdd,
  statsGet,
  statsPrint,
  getLogs,
  clearLogs,
  buildDownloadableLog,
};

if (typeof self !== 'undefined') {
  self.Logger = Logger;
}
