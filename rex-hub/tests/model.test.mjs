import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build,applyNewPolicy,republish,publishedConfig,randomKey,keyOK,effectiveCategory,normalizeAutoRule} from '../src/model.mjs';
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
  assert.deepEqual(s.modules[3],module('later',{categoryId:'',autoCategoryFallbackId:'film',pending:false}));
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

test('normalized rules apply in category order with AND fields and OR terms',()=>{
  const empty=normalizeAutoRule({enabled:true,contentTypes:['bad',null],moduleName:' ，,\r\n'});
  assert.deepEqual(empty,{enabled:true,contentTypes:[],moduleName:'，,',moduleAuthor:'',sourceName:'',sourceAuthor:''});
  const rule=normalizeAutoRule({enabled:true,contentTypes:[' music ','video','music','bad'],moduleName:' Missing ，  Road\nAnother  ',moduleAuthor:'ali',sourceName:'music',sourceAuthor:'No One,BOB'});
  assert.deepEqual(rule.contentTypes,['music','video']);
  const m=module('road',{title:'On the ROAD',author:'Alice',contentType:'video',autoCategoryFallbackId:'arrival'});
  const s=source('a',[m,module('other',{author:'bOB'}),module('another',{author:'bob'})],{label:'Our MuSiC Library',kind:'online-index'});
  const state={sources:[s],categories:[{id:'empty',autoRule:empty},{id:'disabled',autoRule:{...rule,enabled:false}},{id:'wrong',autoRule:{...rule,sourceName:'does not match'}},{id:'film',autoRule:rule},{id:'later',autoRule:rule}]};
  assert.equal(effectiveCategory(state,s,m),'film');
  assert.equal(effectiveCategory(state,s,{...m,categoryId:'explicit'}),'explicit');
  assert.deepEqual(build(state,distribution(),origin).manifest.widgets.map(x=>x.id),['road']);
  s.author='Explicit Curator';
  assert.equal(effectiveCategory(state,s,m),'arrival');
  delete m.autoCategoryFallbackId;
  assert.equal(effectiveCategory(state,s,m),'upstream');
  state.categories[3].autoRule.sourceAuthor='CURATOR';
  assert.equal(effectiveCategory(state,s,m),'film');
});

test('category type matches the published mirror, not unused snapshots',()=>{
  const m=module('audio',{contentType:'video',mirror:{url:`${origin}/files/audio.js`,contentMetadataVersion:1,contentType:'music'}});
  const s=source('a',[m]);
  const state={origin,sources:[s],settings:{defaultDelivery:'mirror'},categories:['music','video','unspecified'].map(type=>({id:type,autoRule:{enabled:true,contentTypes:[type]}}))};
  assert.equal(effectiveCategory(state,s,m),'music');
  assert.equal(build(state,distribution({categoryIds:['music']}),origin).manifest.widgets[0].contentType,'music');
  assert.equal(effectiveCategory(state,s,{...m,delivery:'link'}),'video');
  assert.equal(effectiveCategory(state,s,{...m,url:`${origin}/files/local.js` }),'video');
  delete m.mirror.contentType;
  assert.equal(effectiveCategory(state,s,m),'unspecified');
  assert.ok(!Object.hasOwn(build(state,distribution({categoryIds:['unspecified']}),origin).manifest.widgets[0],'contentType'));
});
