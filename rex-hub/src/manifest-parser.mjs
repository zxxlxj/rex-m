import { parse } from './vendor/acorn.mjs';

const fields=new Set(['id','title','version','requiredVersion','description','author','icon','iconurl','iconURL','iconUrl','contentType','continuousPlay','modules']);
const unknown=Symbol('unknown');

export function rejectEncrypted(source) {
  if (/^\s*(?:\/\/\s*)?REXENC/i.test(source)) throw new Error('加密模块请在 App 内测试');
}
export function parseManifestLiteral(source) {
  rejectEncrypted(source);
  if (source.length > 8 * 1024 * 1024) throw new Error('模块超过 8 MiB');
  const {body}=parse(source,{ecmaVersion:'latest',sourceType:'script',allowHashBang:true});
  const constants=new Map();let manifest;
  function read(node,depth=0){
    if(!node||depth>32)return unknown;
    if(node.type==='Literal'&&!node.regex&&node.bigint===undefined)return node.value;
    if(node.type==='Identifier')return constants.has(node.name)?constants.get(node.name):unknown;
    if(node.type==='TemplateLiteral'&&!node.expressions.length)return node.quasis[0].value.cooked??unknown;
    if(node.type==='BinaryExpression'&&node.operator==='+'){
      const a=read(node.left,depth+1),b=read(node.right,depth+1);
      if(typeof a==='string'&&typeof b==='string'&&a.length+b.length<=16_384)return a+b;
    }
    return unknown;
  }
  function take(node){
    if(manifest||node?.type!=='ObjectExpression')throw Error('WidgetMetadata 需要唯一的顶层对象声明');
    manifest=Object.create(null);
    for(const p of node.properties){
      if(p.type!=='Property'||p.computed||p.kind!=='init'||p.method)continue;
      const key=p.key.type==='Identifier'?p.key.name:p.key.value;
      if(!fields.has(key))continue;
      const v=key==='modules'&&p.value.type==='ArrayExpression'?[]:read(p.value);
      if(v===unknown)delete manifest[key];else manifest[key]=v;
    }
  }
  for(const statement of body){
    if(statement.type==='VariableDeclaration'){
      for(const entry of statement.declarations){
        if(entry.id.type!=='Identifier')continue;
        const name=entry.id.name;
        if(name==='WidgetMetadata'){if(entry.init)take(entry.init);continue;}
        if(!manifest){const value=read(entry.init);if(value===unknown)constants.delete(name);else constants.set(name,value);}
      }
    }else if(statement.type==='ExpressionStatement'){
      const e=statement.expression;
      if(e.type==='AssignmentExpression'&&e.left.type==='Identifier'){
        if(e.left.name==='WidgetMetadata')take(e.operator==='='?e.right:null);
        else constants.delete(e.left.name);
      }else if(e.type==='UpdateExpression'&&e.argument.type==='Identifier'){constants.delete(e.argument.name);}
    }
  }
  if(!manifest||!['id','title','version','requiredVersion'].every(k=>typeof manifest[k]==='string'&&manifest[k].trim())||!Array.isArray(manifest.modules))throw Error('无法静态确定必要的模块元数据');
  return manifest;
}
