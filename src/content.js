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
      const inner = document.querySelector('.jscDropDownSideInner.boxSide');
      const root = inner || document;
      root.querySelectorAll('.reselectionList li a[href]').forEach(a => {
        const href = a.href.split('?')[0].split('#')[0];
        const name = a.textContent.trim().replace(/\s+/g, ' ');
        if (!href || !name) return;
        if (!/hotpepper\.jp/.test(href)) return;
        if (!/\/G\d+\/$/.test(href)) return;
        if (links.some(l => l.url === href)) return;
        links.push({ name, url: href });
      });
    }

    sendResponse({ links });
    return true;
  }
});