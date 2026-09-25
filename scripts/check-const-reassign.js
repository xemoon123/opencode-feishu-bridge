#!/usr/bin/env node
// 静态检查：模块级 const 被重新赋值（运行时会抛 TypeError: Assignment to constant variable.）。
//
// 为什么需要它：node --check 只能发现同一作用域内的 const 重赋值；跨函数赋值要到运行时
// 才炸，而且异常发生在副作用之后，表现为功能静默失效。本仓库曾因此在 dist/main.js 的
// cancelDanglingAsks 里埋了一颗雷（每轮问答都抛异常，撤卡逻辑从未生效）。
//
// 策略：只检查「模块顶层（花括号深度 0）声明为 const」且「全文件没有其它声明点或形参」的
// 标识符——这类名字不存在遮蔽歧义，结论可靠。带遮蔽的名字直接跳过（宁可漏报，不要误报）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const BACKTICK = String.fromCharCode(96);

/** 把注释与字符串/模板字面量内容替换为等长空白（保留换行），避免误判花括号与赋值。 */
function blankOutLiterals(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === BACKTICK) {
      const quote = c;
      out += ' ';
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === quote) { out += ' '; i += 1; break; }
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 收集模块顶层（花括号深度 0）的 const 绑定名 -> 声明行号。 */
function topLevelConstNames(code) {
  const names = new Map();
  let depth = 0;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{' || ch === '(' || ch === '[') { depth += 1; continue; }
    if (ch === '}' || ch === ')' || ch === ']') { depth -= 1; continue; }
    if (depth !== 0) continue;
    if (!code.startsWith('const', i)) continue;
    const before = i === 0 ? '' : code[i - 1];
    if (/[\w$]/.test(before)) continue;
    const line = code.slice(0, i).split('\n').length;
    let j = i + 5;
    const decl = [];
    let d = 0;
    for (; j < code.length; j += 1) {
      const cj = code[j];
      if (cj === ';' && d === 0) break;
      if ('([{'.includes(cj)) d += 1;
      if (')]}'.includes(cj)) d -= 1;
      if (cj === '=' && d === 0 && code[j + 1] !== '=') break;
      decl.push(cj);
    }
    let raw = decl.join('').trim();
    const brace = raw.match(/^[\[{]([\s\S]*)[\]}]$/);
    if (brace) raw = brace[1];
    for (const part of raw.split(',')) {
      const nm = part.trim().replace(/^\.\.\./, '').split(/[:=]/)[0].trim();
      if (new RegExp('^' + IDENT + '$').test(nm) && !names.has(nm)) names.set(nm, line);
    }
  }
  return names;
}

/** 该名字的声明点数量（含形参 / catch 参数）。>1 说明存在遮蔽，跳过。 */
function bindingSites(code, name) {
  const esc = name.replace(/\$/g, '\\$');
  const sites = [];
  let m;
  const declRe = new RegExp('\\b(const|let|var|function|class)\\s+' + esc + '\\b', 'g');
  while ((m = declRe.exec(code)) !== null) sites.push(m.index);
  const catchRe = new RegExp('\\bcatch\\s*\\(\\s*' + esc + '\\b', 'g');
  while ((m = catchRe.exec(code)) !== null) sites.push(m.index);
  const funcParamRe = new RegExp('\\bfunction\\b[^(]*\\(([^)]*)\\)', 'g');
  while ((m = funcParamRe.exec(code)) !== null) {
    const items = m[1].split(',').map((s) => s.trim().replace(/^\.\.\./, '').split(/[:=]/)[0].trim());
    if (items.indexOf(name) !== -1) sites.push(m.index);
  }
  // 箭头函数单参：  name =>   /  (a, name) =>
  const arrowRe = new RegExp('(^|[^.\\w$])' + esc + '\\s*=>', 'g');
  while ((m = arrowRe.exec(code)) !== null) sites.push(m.index);
  const parenArrowRe = new RegExp('\\(([^)]*)\\)\\s*=>', 'g');
  while ((m = parenArrowRe.exec(code)) !== null) {
    const items = m[1].split(',').map((s) => s.trim().replace(/^\.\.\./, '').split(/[:=]/)[0].trim());
    if (items.indexOf(name) !== -1) sites.push(m.index);
  }
  return sites;
}

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0) {
  console.error('用法: node scripts/check-const-reassign.js <文件或目录> [...]');
  process.exit(2);
}
// 目录 → 展开为其中的 *.js：不依赖 shell 做 glob（Windows cmd.exe 不展开通配符）
const args = [];
for (const item of rawArgs) {
  let stat = null;
  try { stat = fs.statSync(item); } catch { stat = null; }
  if (stat && stat.isDirectory()) {
    for (const name of fs.readdirSync(item).sort()) {
      if (name.endsWith('.js')) args.push(path.join(item, name));
    }
  } else {
    args.push(item);
  }
}

let bad = 0;
let skipped = 0;
for (const file of args) {
  const code = blankOutLiterals(fs.readFileSync(file, 'utf8'));
  const lines = code.split('\n');
  for (const entry of topLevelConstNames(code)) {
    const name = entry[0];
    const declLine = entry[1];
    if (bindingSites(code, name).length > 1) { skipped += 1; continue; }
    const esc = name.replace(/\$/g, '\\$');
    const assignRe = new RegExp('(^|[^.\\w$])' + esc + '\\s*=(?![=>])', 'g');
    const hits = [];
    for (let ln = 0; ln < lines.length; ln += 1) {
      assignRe.lastIndex = 0;
      let mm;
      while ((mm = assignRe.exec(lines[ln])) !== null) {
        const at = mm.index + mm[1].length;
        const prev = lines[ln].slice(Math.max(0, at - 1), at);
        if ('+-*/%&|^!<>'.indexOf(prev) !== -1) continue;
        if (/\b(const|let|var)\s*$/.test(lines[ln].slice(0, at))) continue;
        hits.push(ln + 1);
      }
    }
    if (hits.length > 0) {
      bad += 1;
      console.error('  const 重赋值  ' + path.basename(file) + '  ' + name +
        '（声明于第 ' + declLine + ' 行，赋值于第 ' + hits.join(', ') + ' 行）');
    }
  }
}
if (bad > 0) {
  console.error('');
  console.error('发现 ' + bad + ' 处模块级 const 重赋值，运行时会抛 TypeError: Assignment to constant variable。');
  process.exit(1);
}
console.log('  const 重赋值检查通过（跳过 ' + skipped + ' 个有遮蔽的名字）');
