
export function rejectEncrypted(source) {
  if (/^\s*(?:\/\/\s*)?REXENC/i.test(source)) throw new Error('加密模块请在 App 内测试');
}
export function parseManifestLiteral(source) {
  rejectEncrypted(source);
  if (source.length > 8 * 1024 * 1024) throw new Error('模块超过 8 MiB');
  let i = 0, depth = 0;
  function ws() {
    for (;;) {
      while (/\s/.test(source[i] || '') && i < source.length) i++;
      if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; }
      else if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); if (end < 0) throw Error('注释未闭合'); i = end + 2; }
      else break;
    }
  }
  function str() {
    const q = source[i++]; let out = '';
    while (i < source.length) {
      const c = source[i++]; if (c === q) return out;
      if (c !== '\\') { out += c; continue; }
      const e = source[i++];
      if (e === 'u' || e === 'x') {
        const n = e === 'u' ? 4 : 2, hex = source.slice(i, i+n);
        if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) throw Error('非法字符转义');
        out += String.fromCharCode(parseInt(hex, 16)); i += n;
      } else out += ({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0'}[e] ?? e);
    }
    throw Error('字符串未闭合');
  }
  function ident() { const m = /^[A-Za-z_$][\w$]*/.exec(source.slice(i)); if (!m) throw Error(`需要字面量，位置 ${i}`); i += m[0].length; return m[0]; }
  function value() {
    ws(); if (++depth > 64) throw Error('声明嵌套过深');
    let v;
    if (source[i] === '"' || source[i] === "'") v = str();
    else if (source[i] === '{' || source[i] === '[') {
      const array = source[i++] === '[', close = array ? ']' : '}'; v = array ? [] : Object.create(null); ws();
      while (source[i] !== close) {
        if (array) v.push(value());
        else { ws(); const k = /["']/.test(source[i] || '') ? str() : ident(); ws(); if (source[i++] !== ':') throw Error('静态声明不支持计算属性或简写'); v[k] = value(); }
        ws(); if (source[i] === close) break;
        if (source[i++] !== ',') throw Error(`需要逗号，位置 ${i}`); ws();
      }
      i++;
    } else {
      const m = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(i));
      if (m) { v = Number(m[0]); i += m[0].length; }
      else { const k = ident(); if (!['true','false','null'].includes(k)) throw Error('静态校验只支持字面量 WidgetMetadata；表达式请在隔离运行环境解析'); v = {true:true,false:false,null:null}[k]; }
    }
    depth--; return v;
  }

  ws(); if (source.startsWith('"use strict"',i) || source.startsWith("'use strict'",i)) { str(); ws(); if(source[i]===';') i++; ws(); }
  let name = ident(); if (['var','let','const'].includes(name)) { ws(); name = ident(); }
  ws(); if (name !== 'WidgetMetadata' || source[i++] !== '=') throw Error('静态校验要求文件开头为 WidgetMetadata 字面量声明（可含注释）');
  return value();
}
