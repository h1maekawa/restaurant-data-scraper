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
      // 方法1: #js-leftnavi-genre-anchor
      const anchor = document.getElementById('js-leftnavi-genre-anchor');
      if (anchor) {
        anchor.querySelectorAll('a[href]').forEach(a => {
          const href = a.href.split('?')[0].split('#')[0];
          const name = a.textContent.trim().replace(/\s+/g, ' ');
          if (!href || !name) return;
          if (!/tabelog\.com/.test(href)) return;
          if (links.some(l => l.url === href)) return;
          links.push({ name, url: href });
        });
      }

      // 方法2: /rstLst/XX/ パターンで全リンクを探索
      if (links.length === 0) {
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.href.split('?')[0].split('#')[0];
          const name = a.textContent.trim().replace(/\s+/g, ' ');
          if (!href || !name) return;
          if (!/tabelog\.com/.test(href)) return;
          if (!/\/rstLst\/[A-Z]{2}\//.test(href)) return;
          if (links.some(l => l.url === href)) return;
          links.push({ name, url: href });
        });
      }

      // 方法3: leftnavi・sidenav系クラスを広く探索
      if (links.length === 0) {
        const SELECTORS = [
          '[class*="leftnavi"]',
          '[class*="sidenav"]',
          '[class*="side-nav"]',
          '[class*="genre"]',
          '.c-sidenav',
          '.list-condition'
        ];
        for (const sel of SELECTORS) {
          const container = document.querySelector(sel);
          if (!container) continue;
          container.querySelectorAll('a[href]').forEach(a => {
            const href = a.href.split('?')[0].split('#')[0];
            const name = a.textContent.trim().replace(/\s+/g, ' ');
            if (!href || !name) return;
            if (!/tabelog\.com/.test(href)) return;
            if (!/\/rstLst\//.test(href)) return;
            if (links.some(l => l.url === href)) return;
            links.push({ name, url: href });
          });
          if (links.length > 0) break;
        }
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