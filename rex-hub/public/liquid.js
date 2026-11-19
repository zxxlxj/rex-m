/* Decoration only: app.js owns tab names, activation, routing, data and dialogs. */
(() => {
  const app = document.getElementById('app');
  if (!app) return;
  const ns = 'http://www.w3.org/2000/svg';
  const paths = {
    home:'M3.4 10.8 12 3.8l8.6 7M5.6 9v9.8c0 .8.6 1.4 1.4 1.4h3.1v-5.4h3.8v5.4H17c.8 0 1.4-.6 1.4-1.4V9',
    sources:'M3.5 9h17M3.5 14h17M4 9l2.4-4h11.2L20 9M4 14v3.8c0 .9.7 1.7 1.6 1.7h12.8c.9 0 1.6-.8 1.6-1.7V14M4 9v5m16-5v5M7.5 11.5h.1m-.1 5.3h.1',
    distributions:'m20.7 3.4-6.2 17-3.4-7.5-7.7-3.3 17.3-6.2ZM11.1 12.9l5.1-5.1',
    badges:'M9 5.2 12 4l3 1.2 2.9 1.3 1.1 3-1.1 3-2.9 1.3L12 15l-3-1.2-2.9-1.3L5 9.5l1.1-3L9 5.2ZM8.7 14.1l-1.2 6 4.5-1.9 4.5 1.9-1.2-6M12 7.5v4m-2-2h4',
    logs:'M8.2 3.8h7.6c1.7 0 2.7 1 2.7 2.7v11c0 1.7-1 2.7-2.7 2.7H8.2c-1.7 0-2.7-1-2.7-2.7v-11c0-1.7 1-2.7 2.7-2.7ZM9 8h6m-6 4h6m-6 4h4',
    settings:'M10.3 3.5h3.4l.55 2.44 1.45.84 2.42-.74 1.7 2.94-1.85 1.68v1.68l1.85 1.68-1.7 2.94-2.42-.74-1.45.84-.55 2.44h-3.4l-.55-2.44-1.45-.84-2.42.74-1.7-2.94 1.85-1.68v-1.68L4.18 9l1.7-2.94 2.42.74 1.45-.84.55-2.46ZM14.65 11.5a2.65 2.65 0 1 0-5.3 0 2.65 2.65 0 0 0 5.3 0Z'
  };
  function icon(key) {
    const svg = document.createElementNS(ns, 'svg');
    const path = document.createElementNS(ns, 'path');
    for (const [name,value] of Object.entries({viewBox:'0 0 24 24',class:'lg-nav-icon','aria-hidden':'true',focusable:'false',fill:'none',stroke:'currentColor','stroke-width':'1.65','stroke-linecap':'round','stroke-linejoin':'round'})) svg.setAttribute(name,value);
    path.setAttribute('d',paths[key]);
    svg.append(path);
    return svg;
  }
  const reduction = matchMedia('(prefers-reduced-motion: reduce)');
  let previous, previousTab;
  function enhance() {
    const nav = app.querySelector('.top .nav');
    if (!nav) { previous = previousTab = undefined; return; }
    const tabs = [...nav.querySelectorAll(':scope > button[data-page]')];
    const to = tabs.findIndex(el => el.getAttribute('aria-current') === 'page');
    if (to < 0) return;
    const key = tabs[to].dataset.page;
    const moved = previous !== undefined && previousTab !== key;
    if (!nav.hasAttribute('data-lg-ready')) {
      for (const btn of tabs) if (paths[btn.dataset.page]) btn.prepend(icon(btn.dataset.page));
      const puck = document.createElement('span');
      puck.className = 'lg-nav-puck';
      puck.setAttribute('aria-hidden','true');
      nav.prepend(puck);
      nav.setAttribute('data-lg-ready','');
    }
    nav.style.setProperty('--lg-count',tabs.length);
    nav.style.setProperty('--lg-index',to);
    if (moved && !reduction.matches) {
      const page = app.querySelector('main.page');
      page?.getAnimations?.().forEach(animation=>animation.cancel());
      page?.animate?.([{opacity:.82,transform:'translateY(3px)'},{opacity:1,transform:'translateY(0)'}],{duration:190,easing:'cubic-bezier(.2,.75,.3,1)'});
    }
    previous = to;
    previousTab = key;
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target === app || (record.target instanceof Element && record.target.closest('.top .nav') && record.type === 'attributes'))) enhance();
  });
  observer.observe(app,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-current']});
  enhance();
})();

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load',()=>{void navigator.serviceWorker.register('/sw.js').catch(()=>{});},{once:true});
}
