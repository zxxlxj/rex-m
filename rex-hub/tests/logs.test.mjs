import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {appendLog} from '../src/model.mjs';
const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('keep 200 latest logs; render 50 per page and use Shanghai across midnight',()=>{
 const st={logs:[]};for(let i=0;i<211;i++)appendLog(st,`message ${i}`);
 assert.equal(st.logs.length,200);assert.equal(st.logs[0].message,'message 210');assert.equal(st.logs.at(-1).message,'message 11');
 const snippet=js.slice(js.indexOf('function logs(items)'),js.indexOf('function renderSettings()'));
 const formatter=js.slice(js.indexOf('const shanghaiTime'),js.indexOf('function sourceCheck'));
 const state={logs:st.logs.map(l=>({...l,time:'2026-11-19T16:30:00Z'}))};
 const context={state,btn:()=>'',E:x=>x,empty:()=>''};
 runInNewContext(formatter+snippet+'\nglobalThis.draw=n=>{logPage=n;return renderLogs()};',context);
 for(let i=1;i<=4;i++){const output=context.draw(i);assert.equal((output.match(/class="log"/g)||[]).length,50);assert.ok(output.includes(`${i} / 4`));assert.ok(output.includes('2026/11/20 00:30:00'));}
 assert.ok(context.draw(5).includes('message 11'));
});
