import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseManifestLiteral} from '../src/manifest-parser.mjs';
const sample=`
const fake='var WidgetMetadata = {id:"false"}';
const pattern=/var WidgetMetadata = {}/;
function nested(){const WidgetMetadata={id:'ignored'};}
const host='https://example.com', icon=host+'/icon.png';
const WidgetMetadata={id:'test.music',title:'示例',requiredVersion:'0.0.7',version:'1.2',contentType:'music',iconURL:icon,author:calculateAuthor(),modules:[{value:REMOTE_URL}]};
`;
test('locates top-level metadata and ignores unrelated dynamic expressions',()=>{
 const meta=parseManifestLiteral(sample);
 assert.equal(meta.id,'test.music');assert.equal(meta.iconURL,'https://example.com/icon.png');assert.equal(meta.contentType,'music');assert.ok(Array.isArray(meta.modules));assert.ok(!Object.hasOwn(meta,'author'));
});
test('does not execute initializers or accept unresolved required fields',()=>{
 assert.throws(()=>parseManifestLiteral(sample.replace("title:'示例'","title:run()")),/静态确定/);
 assert.throws(()=>parseManifestLiteral('const decoy=`var WidgetMetadata = {}`;'),/静态确定/);
 assert.throws(()=>parseManifestLiteral('REXENC\nabc'),/加密模块/);
});
