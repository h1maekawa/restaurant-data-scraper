/**
 * retry.js
 * fetch リトライ / DOM待機ユーティリティ
 */

/**
 * fetch with リトライ
 * @param {string} url
 * @param {Object} options - fetch オプション + retries / retryDelay
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}) {
  const { retries = 2, retryDelay = 1000, ...fetchOptions } = options;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        await sleep(retryDelay * attempt);
      }
      const res = await fetch(url, {
        signal: AbortSignal.timeout(12000),
        ...fetchOptions,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return res;
    } catch (e) {
      lastErr = e;
      // タイムアウトや一時的なエラーのみリトライ
      if (e.name === 'AbortError' || e.message.startsWith('HTTP 5') || e.message.includes('fetch')) {
        continue;
      }
      // 404など明確なエラーはすぐ投げる
      throw e;
    }
  }
  throw lastErr;
}

/**
 * DOM セレクタが見つかるまで待機
 * Chrome拡張の offscreen.js では waitForSelector が使えないので
 * 解析済み doc に対してポーリングする代替手段
 *
 * @param {Document} doc
 * @param {string} selector
 * @param {number} maxWaitMs
 * @returns {Element|null}
 */
function waitForElement(doc, selector, maxWaitMs = 2000) {
  // offscreen は同期環境なので既存DOMに対して単純に querySelector
  return doc.querySelector(selector);
}

/**
 * 指定ミリ秒 sleep
 */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const Retry = { fetchWithRetry, waitForElement, sleep };

if (typeof self !== 'undefined') self.Retry = Retry;
if (typeof module !== 'undefined') module.exports = Retry;
