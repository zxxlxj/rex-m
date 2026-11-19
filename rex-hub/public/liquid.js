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
  const limit=58;let touch=null,busy=false,distance=0,note='',last='',pool=[];
  const notes=[
    '松手松手，快松手！','可以松了，别舍不得。','到站啦，请松手。','别拽啦，已经够了！',
    '手指辛苦了，可以休息了。','松手吧，我接得住。','这一拉，刚刚好。','手指请有序离场。',
    '库存管理员已就位，请松手。','再拉下去，仓库要搬家了。','门开了，松手就进。','到这儿就行，不用拉到楼下。',
    '刷新键：终于轮到我了。','手指下班，刷新上班。','松手，剩下的交给我。','你拉得很稳，现在松手。',
    '就差最后一步：松手。','准备好了，放手一搏。','再拽也没有隐藏关卡。大概。','拉得够远了，回来吧。',
    '检测到超认真下拉，准许松手。','别客气，松手就是。','刷新组已到齐，请松手。','请放开屏幕，它想刷新。',
    '一拉一松，配合愉快。','这里不是拔河比赛，可以松了。','进度满格，手指自由。','已经拉满，不必加班。',
    '恭喜解锁：松手刷新。','松手吧，屏幕不会跑。','这一单我来处理，请松手。','停停停，正好可以刷新！',
    '仓库卷帘门已开，松手收货！','库存盘点完毕，就等你放手。','刷新件已打包，请松手签收。','再拉就要按体积收费了，松手！',
    '手指的绩效已达标，请松手。','拇指辛苦了，申请换班。','本次下拉不计步，可以松了。','再拉就要给拇指发加班费了。',
    '刷新火箭倒数：三、二、松手！','已经在轨道上了，请松手。','不是发射失败，是你还没松手。','控制台呼叫拇指：允许松手。',
    '别拉到明天，今天就能刷新。','你负责松手，我负责假装很忙。','松手领一份刚出炉的数据。','小心，下面没有第二层彩蛋。',
    '小恐龙在门口等你松手。','小恐龙说：我的尾巴不是拉杆。','小恐龙举牌：可以了！','小恐龙已系好安全带，松手吧。',
    '到站了，本次不提供续拉。','电梯到了，请放开开门键。','到站不停？那也得先松手。','车门已开，请拇指先下。',
    '听劝，松手。','拉得漂亮，收工！','我数到三。三！','放手吧，不扣分。',
    '刷新正在等一个松手的机会。','别和进度条较劲，它已经满了。','请释放这只被扣押的屏幕。','你已经拉出了刷新键的自尊。'
  ];
  function nextNote(){
    if(!pool.length){pool=notes.slice();for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}if(pool.at(-1)===last)[pool[0],pool[pool.length-1]]=[pool.at(-1),pool[0]];}
    last=pool.pop();return last;
  }
  const indicator=document.createElement('div');indicator.className='lg-pull';indicator.setAttribute('role','status');indicator.hidden=true;
  const icon=document.createElement('span');icon.className='lg-pull-icon';icon.setAttribute('aria-hidden','true');
  const label=document.createElement('span');label.className='lg-pull-copy';indicator.append(icon,label);document.body.append(indicator);
  const glyphs=['👋','🛎️','✨','🎈','📦','🧤','🚀','🪄','🦖','🚋','🎯','🔓'];
  function armedIcon(text){const i=notes.indexOf(text);return i<32?glyphs[i%8]:glyphs[4+Math.floor((i-32)/4)];}
  function show(y,text,phase){
    indicator.hidden=false;if(indicator.dataset.phase!==phase)indicator.dataset.phase=phase;
    indicator.style.setProperty('--pull',`${y}px`);
    const glyph=phase==='armed'?armedIcon(text):phase==='done'?'✓':phase==='pulling'?'↓':'';
    if(icon.textContent!==glyph)icon.textContent=glyph;
    if(label.textContent!==text)label.textContent=text;
  }
  function reset(){touch=null;distance=0;note='';indicator.hidden=true;delete indicator.dataset.phase;}
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
    distance=Math.max(0,Math.min(84,dy*.55));
    if(distance>=limit){note ||= nextNote();show(distance,note,'armed');}
    else show(distance,'再拉一点…','pulling');
  },{passive:false});
  window.addEventListener('touchend',async()=>{
    if(!touch)return;
    if(distance<limit){reset();return;}
    touch=null;busy=true;show(limit,'正在刷新…','loading');
    try{
      const detail={};app.dispatchEvent(new CustomEvent('rex:pull-refresh',{detail}));
      if(detail.pending){if(await detail.pending===true){show(limit,'新鲜出炉！','done');await new Promise(resolve=>setTimeout(resolve,500));}}
    }finally{busy=false;reset();}
  },{passive:true});
  window.addEventListener('touchcancel',()=>{if(touch)reset();},{passive:true});
})();
