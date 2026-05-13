/**
 * content.js
 * 一覧ページ上での補助スクリプト。
 * background.js から executeScript で直接関数を注入するため、
 * このファイルは主にメッセージブリッジとして機能する。
 */

// background.js の executeScript から呼ばれる関数は
// background.js 内に直接定義しているため、ここでは
// 将来的な拡張用のリスナーのみ設置する。

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'PING') {
    sendResponse({ ok: true, url: window.location.href });
  }
  return true;
});
