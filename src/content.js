/**
 * content.js
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'PING') {
    sendResponse({ ok: true, url: window.location.href });
    return true;
  }

  if (message.action === 'GET_GENRE_LINKS') {
    const siteType = message.siteType;
    const links = [];

    if (siteType === 'tabelog') {
      // 確定セレクタ: #js-leftnavi-genre-scroll 内の .list-balloon__btn-list の a[href]
      const scroll = document.getElementById('js-leftnavi-genre-scroll');
      if (scroll) {
        scroll.querySelectorAll('.list-balloon__btn-list a[href]').forEach(a => {
          const href = a.href.split('?')[0].split('#')[0];
          const name = a.textContent.trim().replace(/\s+/g, ' ');
          if (!href || !name) return;
          if (!/tabelog\.com/.test(href)) return;
          if (links.some(l => l.url === href)) return;
          links.push({ name, url: href });
        });
      }

      // フォールバック: 上記で取れなかった場合
      if (links.length === 0) {
        document.querySelectorAll('.list-balloon__btn-list a[href]').forEach(a => {
          const href = a.href.split('?')[0].split('#')[0];
          const name = a.textContent.trim().replace(/\s+/g, ' ');
          if (!href || !name) return;
          if (!/tabelog\.com/.test(href)) return;
          if (links.some(l => l.url === href)) return;
          links.push({ name, url: href });
        });
      }

    } else if (siteType === 'hotpepper') {
      const SELECTORS = [
        '#genreSearch',
        '.genreLink',
        '.searchGenreList',
        '.searchResultGenre',
        '.genreList'
      ];
      let container = null;
      for (const sel of SELECTORS) {
        container = document.querySelector(sel);
        if (container) break;
      }
      if (container) {
        container.querySelectorAll('a[href]').forEach(a => {
          const href = a.href.split('?')[0].split('#')[0];
          const name = a.textContent.trim().replace(/\s+/g, ' ');
          if (!href || !name) return;
          if (!/hotpepper\.jp/.test(href)) return;
          if (links.some(l => l.url === href)) return;
          links.push({ name, url: href });
        });
      }
    }

    sendResponse({ links });
    return true;
  }
});