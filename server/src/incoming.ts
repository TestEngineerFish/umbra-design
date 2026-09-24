/** 接设计侧回来的稿。doc/00 §二十七
 *
 * 用法：设计侧交回来的文件**原样**丢进 `ui/_incoming/`，然后
 *
 *     npm --prefix server run incoming
 *
 * 它回答三个问题，不用人去读 700 行：
 *
 *  1. 这是新文件还是要覆盖现有的？
 *  2. 如果要覆盖 —— **我们的接线还在吗**（`LIVE` 门控、本地 API 调用、
 *     点选桥注入、属性面板落盘…）。这是 `doc/10` §一 唯一真正要紧的事
 *  3. 这份稿本身合不合法（error / warning），以及 renderVals 的键数变了多少
 *
 * 判据是「标记还在不在」，不是「逐行 diff 对得上」——
 * 设计侧改样式会动很多行，那不该报警；接线消失才该报警。
 *
 * 校验要在一个**落盘后的样子**里做，不能就地校验 `_incoming/`：
 * `dc-import` 是按引用方文件所在目录做文件系统解析的（validate.ts §import），
 * 所以同批交付里的 `IconGlyph` 在 `_incoming/` 里能找到、落到 `ui/` 后也能找到，
 * 但拿两边任一单独当基准都会误报。做法是先把 `ui/` 铺一层、再把 `_incoming/`
 * 盖上去，在这个临时叠加目录里校验 —— 这才是「真放进去之后」的判据。
 */
import { existsSync } from "node:fs";
import { readFile, readdir, cp, mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { TOOL_ROOT, loadProject, listProjectDirs, buildProject, type Project } from "./project.js";
import { parseDraft, auditRenderVals } from "./draft.js";
import { validateDraft } from "./validate.js";
import { readBaseline, shaOf, stripBaseline } from "./baseline.js";

/** 每份壳稿必须保住的接线标记。少一个就是被覆盖掉了。 */
const WIRING: Record<string, Array<{ mark: string; what: string }>> = {
  "S1-稿件索引.dc.html": [
    { mark: "const LIVE", what: "LIVE 门控" },
    { mark: "window.__UD_INDEX", what: "读索引数据" },
    { mark: "index_status", what: "索引过期提示" },
    { mark: "barRef", what: "顶栏吸顶高度实测" },
  ],
  "S2-单稿预览壳.dc.html": [
    { mark: "const LIVE", what: "LIVE 门控" },
    { mark: "window.__UD_API", what: "本地 API" },
    { mark: "select-bridge", what: "点选桥注入" },
    { mark: "applyProp", what: "属性面板落盘" },
    { mark: "previewStyle", what: "样式覆盖通道" },
    { mark: "doRevert", what: "版本回退" },
    { mark: "check_status", what: "重跑体检（作业轮询）" },
    { mark: "syncFrame", what: "iframe 地址由逻辑类设" },
  ],
  "S3-诊断面板.dc.html": [
    { mark: "const LIVE", what: "LIVE 门控" },
    { mark: "window.__UD_API", what: "本地 API" },
    { mark: "checkStale", what: "体检读数过期" },
  ],
  "S4-变更清单.dc.html": [
    { mark: "const LIVE", what: "LIVE 门控" },
    { mark: "hasApi", what: "项目级形态判据" },
    { mark: "project_changes", what: "项目级汇总" },
  ],
  "S5-设计系统浏览器.dc.html": [
    { mark: "hasApi", what: "API 门控（项目级，不看 ?file=）" },
    { mark: "debouncedPull", what: "token 检索走服务端 + 防抖" },
    // 不列 data-icon-d：§2.8 已撤回，S5 已改回 d="{{ i.d }}"（doc/00 §二十七）
  ],
};

async function anyProject(): Promise<Project> {
  const dirs = await listProjectDirs();
  if (!dirs.length) throw new Error("projects/ 下没有租户，校验需要一个（拿 designSystem 配置）");
  return buildProject(dirs[0] as string);
}

const dim = (s: string) => `[2m${s}[0m`;
const red = (s: string) => `[31m${s}[0m`;
const grn = (s: string) => `[32m${s}[0m`;
const ylw = (s: string) => `[33m${s}[0m`;

async function main(): Promise<void> {
  const inDir = join(TOOL_ROOT, "ui", "_incoming");
  if (!existsSync(inDir)) {
    console.log(`没有 ${inDir}\n把设计侧交回来的文件原样丢进去，再跑一次。`);
    return;
  }
  const files = (await readdir(inDir)).filter((f) => f.endsWith(".dc.html") || f.endsWith(".css"));
  if (!files.length) { console.log("ui/_incoming/ 是空的。"); return; }

  const p = await anyProject();
  const apply = process.argv.includes("--apply");
  let blocking = 0;
  /** 过关后可直接并入的稿：baseline 正确（或新文件）、零 error、接线齐全 */
  const ready: Array<{ f: string; body: string }> = [];

  // 落盘后的样子：ui/ 铺底，_incoming/ 盖上去。只为校验用，跑完就删。
  const stage = await mkdtemp(join(tmpdir(), "ud-incoming-"));
  await cp(join(TOOL_ROOT, "ui"), stage, {
    recursive: true,
    filter: (src) => !src.includes(`${sep}_incoming`),
  });
  await cp(inDir, stage, { recursive: true });
  const pStage: Project = { ...p, dir: stage };

  for (const f of files.sort()) {
    const incoming = await readFile(join(inDir, f), "utf8");
    const curPath = join(TOOL_ROOT, "ui", f);
    const isNew = !existsSync(curPath);
    console.log(`\n──── ${f} ${isNew ? grn("【新文件，直接放进去就行】") : ylw("【会覆盖现有文件】")}`);

    if (f.endsWith(".css")) {
      console.log(dim(`     ${incoming.length} 字节${isNew ? "" : `（现有 ${(await readFile(curPath, "utf8")).length} 字节）`}`));
      ready.push({ f, body: incoming });
      continue;
    }
    let fileOk = true;

    /* ⓪ 底稿对不对 —— 这是其余所有检查的前提（doc/00 §三十二）。
       设计侧在云端，只拥有我们上传过的东西。它若在自己那份旧底稿上改，
       交回来的文件形制也许很好，但我们这边后来加的一切都不在里面 ——
       而且它自己不可能知道缺了什么（它会真心地说「接线原样保留」）。
       所以先问「你是在哪一版上改的」，答不上来就别往下看了。 */
    if (!isNew) {
      const base = readBaseline(incoming);
      const cur = await readFile(curPath, "utf8");
      if (base && base.sha === shaOf(cur)) {
        console.log(`     ${grn(`底稿正确 —— 基于 ${base.sent ?? "?"} 发出的现版`)}`);
      } else {
        /* baseline 对不上（没有、或戳是旧的）。**先别急着拦** —— 换一条直接盯要害的判据。
         *
         * 这道检查的真正目的不是「知道它基于哪一版」，而是「**确保我们的改动没被丢掉**」。
         * §三十二 那次事故的症状就是 S1 少 27 个键、S2 少 54 个键 ——
         * 形制看着好好的，我们后加的接线全没了，而设计侧自己不可能知道缺了什么。
         *
         * `renderVals` 的键就是接线本身。**现版的键一个都没少 = 我们的东西都还在**，
         * 这比一行 baseline 注释更直接：注释可能忘了更新（S9 这次就是，戳还停在第三轮，
         * 而正文实测是在现版上改的），键却骗不了人。
         *
         * 所以：键零丢失 → 放行，但**用黄色说清是"按内容认可"而不是"底稿正确"**，
         * 并把 baseline 的实际情况一起打出来，让人能复核。
         * 键有丢失 → 照旧拦住，且这时 baseline 对不上就是很强的佐证。
         *
         * 2026-09-24 加这条的由来：新屏（设计侧自己建的 S11/S12）**从来没有过 baseline**，
         * 因为它们没经过我们的 outgoing 打包。只认 baseline 的话，每个新屏第一次交回都会被拦。
         */
        const gone = auditRenderVals(parseDraft(cur, f)).union
          .filter((k) => !auditRenderVals(parseDraft(incoming, f)).union.includes(k));
        const why = !base
          ? "没有 baseline 标记（新屏没经过 outgoing 打包时就是这样）"
          : `baseline 戳是 ${base.sent ?? "?"}（${base.sha}），我们现版是 ${shaOf(cur)}`;
        if (gone.length === 0) {
          console.log(`     ${ylw("按内容认可 —— baseline 对不上，但我们现版的接线一个键都没少")}`);
          console.log(dim(`       ${why}`));
          console.log(dim("       判据：renderVals 的键零丢失。丢键才是 §三十二 那次事故的症状，baseline 只是它的代理指标"));
        } else {
          blocking++; fileOk = false;
          console.log(`     ${red(`底稿不对 —— 少了 ${gone.length} 个键，我们的接线被丢了`)}`);
          console.log(dim(`       ${why}`));
          console.log(dim(`       少的键：${gone.slice(0, 12).join(" · ")}${gone.length > 12 ? " …" : ""}`));
          console.log(dim("       做法：先 outgoing 打包发过去，请设计侧在那个包的底稿上重做，别在这份上移植"));
        }
      }
    }

    // ① 合法性（baseline 注释不算稿的内容，校验前拿掉）
    const v = validateDraft(pStage, f, stripBaseline(incoming), f);
    const errs = v.diags.filter((d) => d.level === "error");
    const warns = v.diags.filter((d) => d.level === "warning");
    console.log(`     校验：${errs.length ? red(`error ${errs.length}`) : grn("error 0")} · warning ${warns.length}` +
      ` · 元素 ${v.stats.elements} · 洞审计 ${v.stats.holeAuditSkipped ? ylw("放弃") : "已做"}`);
    for (const d of errs) {
      console.log(`       ${red("✗")} ${d.code} ${d.locator?.name ?? ""} — ${d.message}`);
      if (d.fix) console.log(dim(`         改法：${d.fix}`));
    }
    if (errs.length) { blocking++; fileOk = false; }

    // ② 接线还在吗
    const need = WIRING[f];
    if (need && !isNew) {
      const lost = need.filter((x) => !incoming.includes(x.mark));
      if (lost.length) {
        blocking++; fileOk = false;
        console.log(`     ${red(`接线丢了 ${lost.length}/${need.length} 处 —— 不要直接覆盖`)}`);
        for (const x of lost) console.log(`       ${red("✗")} ${x.what}（找不到 ${x.mark}）`);
        console.log(dim("       做法：拿它的**形制**、保我们的接线，逐块移植；别整文件替换"));
      } else {
        console.log(`     ${grn(`接线齐全 ${need.length}/${need.length}`)}`);
      }
    }

    // ③ 规模变化，给个直觉
    if (!isNew) {
      const cur = await readFile(curPath, "utf8");
      const a = auditRenderVals(parseDraft(cur, f));
      const b = auditRenderVals(parseDraft(incoming, f));
      const dl = incoming.split("\n").length - cur.split("\n").length;
      console.log(dim(`     行数 ${cur.split("\n").length} → ${incoming.split("\n").length}（${dl >= 0 ? "+" : ""}${dl}）` +
        ` · renderVals 键 ${a.union.length} → ${b.union.length}`));
      const goneKeys = a.union.filter((k) => !b.union.includes(k));
      if (goneKeys.length) console.log(`     ${ylw(`少了 ${goneKeys.length} 个键`)}：${goneKeys.slice(0, 12).join(" · ")}${goneKeys.length > 12 ? " …" : ""}`);
    }
    if (fileOk) ready.push({ f, body: stripBaseline(incoming) });
  }

  await rm(stage, { recursive: true, force: true });

  console.log(`\n${blocking ? red(`⚠️ ${blocking} 处要先处理，别急着覆盖`) : grn("✓ 没有拦路的问题")}`);

  /* ④ 并入（--apply）。底稿正确 + 零 error + 接线齐全的稿，整文件就是「我们的现版 + 它的改动」，
     不需要逐块移植 —— 逐块移植是底稿不对时的补救，不是常规路径（doc/00 §三十二）。
     并入时剥掉 baseline 行：正本里永远不能有它（outgoing 会拒绝打包）。 */
  if (!apply) {
    console.log(dim(blocking
      ? "   处理完再跑一次；全部过关后加 --apply 并入 ui/。"
      : "   加 --apply 把这些稿并入 ui/（剥掉 baseline 行，原件从 _incoming/ 移除）。"));
    return;
  }
  if (blocking) {
    console.log(red("   有拦路问题，--apply 不执行。"));
    process.exitCode = 1;
    return;
  }
  for (const { f, body } of ready) {
    await writeFile(join(TOOL_ROOT, "ui", f), body);
    await unlink(join(inDir, f));
    console.log(`   ${grn("并入")} ui/${f}`);
  }
  console.log(dim("   接着跑 selftest + rendertest，再真开浏览器看一次。"));
}

void main().catch((e) => { console.error(e); process.exitCode = 1; });
