from pathlib import Path
import shutil,sys
root=Path(__file__).resolve().parent.parent
out=Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/rex-hub-pages/site')
out.mkdir(parents=True,exist_ok=True)
for p in (root/'public').iterdir():
 if p.is_file() and p.name not in {'sw.js','manifest.webmanifest'}: shutil.copyfile(p,out/p.name)
shutil.copyfile(root/'demo/mock.js',out/'demo.js')
shutil.copyfile(root/'LICENSE',out/'LICENSE')
p=out/'index.html';s=p.read_text();s='\n'.join(line for line in s.splitlines() if 'rel="manifest"' not in line and not ('apple-mobile-web-app-' in line));s=s.replace('href="/pwa-180.png','href="./pwa-180.png').replace('REX Hub · 管理控制台','REX Hub · 界面展示');s=s.replace('<script defer src="./badges.js','<script defer src="./demo.js"></script>\n<script defer src="./badges.js');s=s.replace('</head>','<link rel="stylesheet" href="./demo.css">\n</head>').replace('</body>','<footer class="demo-footer">模拟数据，仅供展示</footer>\n</body>');p.write_text(s+'\n')
p=out/'liquid.js';s=p.read_text();start=s.index("if ('serviceWorker' in navigator");end=s.index('\n(() => {',start);p.write_text(s[:start]+s[end:]);
p=out/'app.js';s=p.read_text().replace('const fallback=`/rex-dino-', 'const fallback=`./rex-dino-').replace('src="/rex-dino-', 'src="./rex-dino-').replace('`/s/${encodeURIComponent(d.key)}.rex`','`./s/${encodeURIComponent(d.key)}.rex`');p.write_text(s)
p=out/'badges.js';s=p.read_text().replace("new URL('/badge.json', location.href)","new URL('./badge.json', location.href)");p.write_text(s)
(out/'.nojekyll').touch()
(out/'demo.css').write_text('body{display:flex;min-height:100dvh;flex-direction:column}#app{flex:1;min-width:0}.demo-footer{padding:0 12px 20px;text-align:center;font-size:11px;color:var(--lg-secondary,#666)}@media(max-width:760px){#app .page{padding-bottom:24px}.demo-footer{padding-bottom:calc(92px + env(safe-area-inset-bottom))}}\n')
