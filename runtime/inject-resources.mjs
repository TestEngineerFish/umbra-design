#!/usr/bin/env node
/* Umbra Studio · 离线资源注入器（过渡工具）
 *
 * 做什么：给目录下每一份 .dc.html 注入 window.__resources 映射，
 *         让 support.js 里硬编码的 React CDN 走同层的本地副本。
 *         顺带做归一化落盘（UTF-8 无 BOM / LF / 末尾单换行）。
 *
 * 为什么是独立脚本：这件事本该由 MCP 的 write_draft 在落盘时做（doc/00 §5.2）。
 *         server 还没写，所以先用它顶。write_draft 一上线，这个脚本就废弃。
 *
 * 幂等：重复跑不会叠加 —— 先删掉上一次注入的块，再写新的。
 *
 * 用法：node runtime/inject-resources.mjs <目录> [--check]
 *       --check 只报告不改写（退出码 1 表示有稿缺注入）
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const MARK_OPEN = "<!-- umbradesign:resources -->";
const MARK_CLOSE = "<!-- /umbradesign:resources -->";

const MAP = {
  "https://unpkg.com/react@18.3.1/umd/react.production.min.js":
    "./react.production.min.js",
  "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js":
    "./react-dom.production.min.js",
};

function block() {
  const json = JSON.stringify(MAP, null, 2).replace(/\n/g, "\n  ");
  return `${MARK_OPEN}\n<script>window.__resources = ${json};</script>\n${MARK_CLOSE}\n`;
}

function stripOld(src) {
  const re = new RegExp(
    `${MARK_OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?` +
      `${MARK_CLOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
    "g"
  );
  return src.replace(re, "");
}

function normalize(s) {
  return s.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
}

/** 注入点：第一个引 support.js 的 <script> 之前。找不到就报错，不猜。 */
function inject(src) {
  const body = stripOld(src);
  const m = body.match(/[ \t]*<script[^>]*\bsrc\s*=\s*["'][^"']*support\.js["'][^>]*>\s*<\/script>/i);
  if (!m) return { ok: false, reason: "找不到引 support.js 的 script 标签" };
  const at = m.index;
  return { ok: true, out: body.slice(0, at) + block() + body.slice(at) };
}

const dir = process.argv[2];
const checkOnly = process.argv.includes("--check");
if (!dir) {
  console.error("用法：node runtime/inject-resources.mjs <目录> [--check]");
  process.exit(2);
}

async function walk(d, acc = []) {
  for (const e of await readdir(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (e.name.endsWith(".dc.html")) acc.push(p);
  }
  return acc;
}

const files = await walk(dir);
if (!files.length) {
  console.log("没有 .dc.html");
  process.exit(0);
}

let changed = 0, missing = 0, failed = 0;
for (const f of files) {
  const raw = await readFile(f, "utf8");
  const src = normalize(raw);
  const has = src.includes(MARK_OPEN);
  const r = inject(src);
  const name = relative(dir, f);
  if (!r.ok) {
    console.error(`✗ ${name} —— ${r.reason}`);
    failed++;
    continue;
  }
  if (checkOnly) {
    if (!has) { console.log(`· ${name} 缺注入`); missing++; }
    continue;
  }
  if (r.out !== raw) {
    await writeFile(f, r.out, "utf8");
    console.log(`${has ? "↻" : "+"} ${name}`);
    changed++;
  } else {
    console.log(`= ${name}`);
  }
}

if (checkOnly) {
  console.log(`\n${files.length} 份稿，${missing} 份缺注入，${failed} 份注入点找不到`);
  process.exit(missing || failed ? 1 : 0);
}
console.log(`\n${files.length} 份稿，改写 ${changed} 份，注入点找不到 ${failed} 份`);
process.exit(failed ? 1 : 0);
