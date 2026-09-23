/** 稿件模板管理：把稿存为模板，新建时能选。
 *
 * 模板存在项目的 .umbrastudio/templates/ 目录下。
 */

import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Project } from "./project.js";

const TEMPLATES_DIR = ".umbrastudio/templates";

export interface TemplateInfo {
  /** 模板名 */
  name: string;
  /** 文件名 */
  file: string;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 稿的元素数 */
  elementCount: number;
}

/** 模板目录的绝对路径 */
function templatesDir(p: Project): string {
  return join(p.dir, TEMPLATES_DIR);
}

/** 列出项目的所有模板 */
export async function listTemplates(p: Project): Promise<TemplateInfo[]> {
  const dir = templatesDir(p);
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  const templates: TemplateInfo[] = [];

  for (const file of files) {
    if (!file.endsWith(".dc.html")) continue;
    const abs = join(dir, file);
    try {
      const content = await readFile(abs, "utf-8");
      // 解析 meta 信息（如果有的话）
      const createdAtMatch = content.match(/<!--\s*template-created-at:\s*(.+?)\s*-->/);
      const elementMatch = content.match(/<!--\s*template-element-count:\s*(\d+)\s*-->/);
      templates.push({
        name: file.replace(/\.dc\.html$/, ""),
        file,
        createdAt: createdAtMatch?.[1] ?? "unknown",
        elementCount: parseInt(elementMatch?.[1] ?? "0", 10),
      });
    } catch {
      // 读不到跳过
    }
  }

  return templates;
}

/** 把一份稿存为模板 */
export async function saveAsTemplate(
  p: Project,
  draftPath: string,
  templateName: string,
): Promise<{ saved: boolean; path: string }> {
  const dir = templatesDir(p);
  await mkdir(dir, { recursive: true });

  // 读原稿
  const abs = join(p.dir, draftPath);
  const content = await readFile(abs, "utf-8");

  // 加模板元数据注释
  const now = new Date().toISOString();
  const elementCount = (content.match(/<[\w-]+/g) ?? []).length;
  const metaComment = `<!-- template-created-at: ${now} -->\n<!-- template-element-count: ${elementCount} -->\n`;

  // 如果源稿没有 meta，加到开头
  let finalContent = content;
  if (!content.includes("template-created-at:")) {
    finalContent = metaComment + content;
  }

  const templateFile = `${templateName.replace(/[\/\\]/g, "_")}.dc.html`;
  const templatePath = join(dir, templateFile);

  await writeFile(templatePath, finalContent, "utf-8");

  return { saved: true, path: templatePath };
}

/** 删除一个模板 */
export async function deleteTemplate(
  p: Project,
  templateName: string,
): Promise<{ deleted: boolean }> {
  const dir = templatesDir(p);
  const file = `${templateName}.dc.html`;
  const abs = join(dir, file);

  if (!existsSync(abs)) {
    return { deleted: false };
  }

  await rm(abs);
  return { deleted: true };
}
