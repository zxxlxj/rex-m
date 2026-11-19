import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build,applyNewPolicy,republish,publishedConfig,randomKey,keyOK} from '../src/model.mjs';
const module=(id, extra={})=>({id,title:id,version:'1',requiredVersion:'0.0.6',url:`https://raw.githubusercontent.com/example/project/main/${id}.js`,...extra});
const source=(id,modules,extra={})=>({id,label:id,categoryId:'upstream',modules,...extra});
const distribution=(extra={})=>({key:'my-key',title:'照自己的分类',mode:'rules',categoryIds:['film'],sourceIds:[],include:[],exclude:[],enabled:true,...extra});
const origin='https://rex.example.com';
test('individual classifications recombine unrelated upstream sets',()=>{
  const st={sources:[source('a',[module('a1',{categoryId:'film'}),module('a2',{categoryId:'series'})]),source('b',[module('b1',{categoryId:'film'})])]};
  assert.deepEqual(build(st,distribution(),origin).manifest.widgets.map(x=>x.id),['a1','b1']);
  st.sources[0].modules[0].categoryId='series';
  assert.deepEqual(build(st,distribution(),origin).manifest.widgets.map(x=>x.id),['b1']);
});
test('pending modules do not leak even via manual include; category survives refresh',()=>{
  const s=source('a',[module('old',{categoryId:'series'}),module('pending',{categoryId:'film',pending:true})],{newCategoryId:'film',newPolicy:'review'});
  s.modules=applyNewPolicy(s,[module('old',{version:'2'}),module('pending'),module('new')]);
  assert.equal(s.modules[0].categoryId,'series');
  assert.ok(s.modules[1].pending&&s.modules[2].pending);
  const d=distribution({mode:'manual',include:['a:pending','a:new']});
  assert.equal(build({sources:[s]},d,origin).manifest.widgets.length,0);
  s.newPolicy='auto';
  s.modules=applyNewPolicy(s,[...s.modules,module('later')]);
  assert.ok(s.modules[1].pending&&s.modules[2].pending);
  assert.deepEqual(s.modules[3],module('later',{categoryId:'film',pending:false}));
  s.modules[2].pending=false;
  assert.deepEqual(build({sources:[s]},d,origin).manifest.widgets.map(x=>x.id),['new']);
});
test('cron uses published rules and keeps the last good snapshot upon large removal',()=>{
  const s=source('a',[module('old',{categoryId:'film'})]);
  const d=distribution();const st={sources:[s],distributions:[d],logs:[]};
  d.active=publishedConfig(d);d.published=build(st,d,origin).manifest;
  d.title='unpublished draft';
  s.modules=[module('old',{version:'2',categoryId:'film'})];republish(st,origin);
  assert.equal(d.published.title,'照自己的分类');assert.equal(d.published.widgets[0].version,'2');
  s.modules=[];republish(st,origin);assert.equal(d.published.widgets.length,1);assert.match(d.publishWarning,/移除/);
});
test('custom and random distribution keys are both valid',()=>{
  const k=randomKey();assert.ok(keyOK('My_Collection-1')&&keyOK(k));assert.notEqual(randomKey(),k);assert.equal(keyOK('../bad'),false);
});
