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

// iOS standalone has no Safari pull-to-refresh chrome.
(() => {
  const app=document.getElementById('app');if(!app)return;
  const standalone=matchMedia('(display-mode: standalone)');
  const active=()=>standalone.matches||navigator.standalone===true;
  const limit=58;let touch=null,busy=false,distance=0;
  const indicator=document.createElement('div');indicator.className='lg-pull';indicator.setAttribute('role','status');indicator.hidden=true;
  const label=document.createElement('span');indicator.append(label);document.body.append(indicator);
  function show(y,text,loading=false){indicator.hidden=false;indicator.classList.toggle('is-refreshing',loading);indicator.style.setProperty('--pull',`${y}px`);label.textContent=text;}
  function reset(){touch=null;distance=0;indicator.hidden=true;indicator.classList.remove('is-refreshing');}
  window.addEventListener('touchstart',e=>{
    if(!active()||busy||e.touches.length!==1||Math.max(scrollY,document.scrollingElement?.scrollTop||0)>1||!app.querySelector('#main')||document.querySelector('dialog[open]'))return;
    if(e.target.closest?.('button,a,input,textarea,select,summary,[contenteditable],.library-modules,.activity-list,.dist-results'))return;
    for(let el=e.target;el instanceof Element&&el!==document.body;el=el.parentElement){if(el.scrollHeight>el.clientHeight+2&&/auto|scroll/.test(getComputedStyle(el).overflowY))return;}
    const p=e.touches[0];touch={x:p.clientX,y:p.clientY,id:p.identifier};
  },{passive:true});
  window.addEventListener('touchmove',e=>{
    if(!touch)return;
    const p=e.touches[0];if(e.touches.length!==1||p.identifier!==touch.id){reset();return;}
    const dy=p.clientY-touch.y,dx=Math.abs(p.clientX-touch.x);
    if(!distance&&(dy<-8||dx>Math.max(12,dy))){reset();return;}
    if(dy<8&&!distance)return;
    if(e.cancelable)e.preventDefault();
    distance=Math.max(0,Math.min(84,dy*.55));show(distance,distance>=limit?'松手刷新':'下拉刷新');
  },{passive:false});
  window.addEventListener('touchend',async()=>{
    if(!touch)return;
    if(distance<limit){reset();return;}
    touch=null;busy=true;show(limit,'正在刷新…',true);
    try{const detail={};app.dispatchEvent(new CustomEvent('rex:pull-refresh',{detail}));if(detail.pending)await detail.pending;}
    finally{busy=false;reset();}
  },{passive:true});
  window.addEventListener('touchcancel',()=>{if(touch)reset();},{passive:true});
})();
