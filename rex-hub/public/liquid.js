
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


(() => {
  const app=document.getElementById('app');if(!app)return;
  const standalone=matchMedia('(display-mode: standalone)');
  const active=()=>standalone.matches||navigator.standalone===true;
  const limit=58;let touch=null,busy=false,distance=0,note='',last='',pool=[];
  const notes=[
      "松手松手快松手！我还没买保险 😭",
      "已读。已下拉。就差你松手了 🙃",
      "此处没有隐藏关卡，只有一个被拉长的后台 🫠",
      "可以松了，屏幕已经认输 🏳️",
      "别拽了，我不是卷帘门 😫",
      "你松手，我马上装作一切尽在掌握 😎",
      "手指请有序离场，数据即将登台 🎭",
      "拉得很好，下次不用拉这么认真 🤝",
      "仓管：谁把我从午睡里拉出来的 😴",
      "快松手！再拉下去仓库要算违建了 🏚️",
      "包裹已打包，请用一个松手签收 📦",
      "库存没跑，但仓管已经跑了 💨",
      "松手，给数据一个上架的机会 🛒",
      "仓管看了一眼工单，默默推回给你：松手 🧾",
      "你拉的是页面，不是仓库的房租 💸",
      "卷帘门：我已经开了，你倒是进去啊 😩",
      "小恐龙：我的尾巴不是下拉手柄 🦖",
      "小恐龙说：你再不松手，我就要灭绝第二次了 ☄️",
      "恐龙已就位，但它不会替你松手 🦖",
      "小恐龙把刷新键藏起来了。骗你的，松手 🤫",
      "恐龙发来一条语音：吼——可以松了 🎙️",
      "小恐龙：这不是我想象中的牵手 🥲",
      "化石都等新数据等活了，你还没松手 🦴",
      "松手吧，小恐龙的短手够不到屏幕 🦖",
      "三，二，一……导演喊松手了 🎬",
      "我数到三。三。你怎么还在拉 😂",
      "发射台报告：不是火箭没油，是拇指没松 🚀",
      "地面指挥中心：允许拇指撤离 🎧",
      "再拉也到不了火星，这里是 Rex Hub 🪐",
      "火箭已经热好，司机还在等你松手 🚀",
      "拇指控制台提示：起飞，不是拔河 🛰️",
      "宇航员都系好安全带了，你还握着发射按钮 😬",
      "工单已流转至「请你松手」部门 🗂️",
      "刷新组刚开完会，结论是：松手 📋",
      "谁拉了工单？哦，是你。请松手 😶",
      "再拉三秒，系统就要给拇指开加班单 🧑‍💻",
      "松手。以上就是本次会议纪要。📝",
      "实习生提议：要不我们先松个手？🙋",
      "本次刷新不需要领导审批，松手就行 😌",
      "刷新键交了申请，拇指是唯一审批人 📮",
      "下一站：松手。请勿坐过站 🚇",
      "车门已开，拇指请先下车 🚋",
      "电梯到了，开门键真的不用一直按 🛗",
      "乘客朋友们，别再把站台往下拉了 🎙️",
      "这不是直达楼下的电梯，可以松手 🏢",
      "司机问：你要刷新，还是要开到终点站？🚌",
      "已到目的地。坚持下拉不送积分 🎫",
      "本次不换乘，直接松手 🚉",
      "别再拉了，冰箱门都没你拽得久 🧊",
      "数据出锅前最后一步：盖子松开 🍳",
      "刷新还没开始，围观群众瓜子都磕完了 🍿",
      "就等你松手，我好把数据端上来 🍜",
      "松手，没熟我再回锅（数据，不是手指）🥘",
      "这一拉够一碗拉面了，收手吧 🍜",
      "暂停拔河，先吃颗糖再松手 🍬",
      "这不是抓娃娃，松手也不会掉币 🕹️",
      "屏幕：我只是来上班，怎么就成橡皮筋了 🫠",
      "放开这个屏幕，它只是想更新一下 🥺",
      "你赢了。奖品是一次刷新 🎁",
      "进度条：我都满了，你还卷什么 😵‍💫",
      "这位玩家，长按不加伤害，松手刷新 🎮",
      "你已经拉出了刷新键的自尊，请给它个台阶 🥹",
      "拇指：这一下我能吹到明天。现在松手 😏",
      "可以放手了，我们的关系不必这么紧张 🫶"
  ];
  function nextNote(){
    if(!pool.length){pool=notes.slice();for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}if(pool.at(-1)===last)[pool[0],pool[pool.length-1]]=[pool.at(-1),pool[0]];}
    last=pool.pop();return last;
  }
  const indicator=document.createElement('div');indicator.className='lg-pull';indicator.setAttribute('role','status');indicator.hidden=true;
  const dial=document.createElement('div');dial.className='lg-pull-dial';dial.setAttribute('aria-hidden','true');
  const icon=document.createElement('span');icon.className='lg-pull-icon';dial.append(icon);
  const label=document.createElement('span');label.className='lg-pull-copy';indicator.append(dial,label);document.body.append(indicator);
  const mascots=['🦖','🐙','👻','🐈','🦝','🛸','🐸','📦','🦆','🤖','🦥','🐧'];
  let mascotIndex=-1;
  function show(y,text,phase){
    indicator.hidden=false;if(indicator.dataset.phase!==phase)indicator.dataset.phase=phase;
    indicator.style.setProperty('--pull',`${y}px`);
    indicator.style.setProperty('--pull-progress',`${Math.min(1,y/limit)*360}deg`);
    const glyph=phase==='done'?'✓':mascots[mascotIndex];
    if(icon.textContent!==glyph)icon.textContent=glyph;
    if(label.textContent!==text)label.textContent=text;
    label.hidden=!text;
  }
  function reset(){touch=null;distance=0;note='';indicator.hidden=true;delete indicator.dataset.phase;}
  window.addEventListener('touchstart',e=>{
    if(!active()||busy||e.touches.length!==1||Math.max(scrollY,document.scrollingElement?.scrollTop||0)>1||!app.querySelector('#main')||document.querySelector('dialog[open]'))return;
    if(e.target.closest?.('button,a,input,textarea,select,summary,[contenteditable],.library-modules,.activity-list,.dist-results'))return;
    for(let el=e.target;el instanceof Element&&el!==document.body;el=el.parentElement){if(el.scrollHeight>el.clientHeight+2&&/auto|scroll/.test(getComputedStyle(el).overflowY))return;}
    const p=e.touches[0];touch={x:p.clientX,y:p.clientY,id:p.identifier};
    mascotIndex=(mascotIndex+1+Math.floor(Math.random()*(mascots.length-1)))%mascots.length;
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
    else show(distance,'','pulling');
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
