/** 项目导出与导入：打包成可移植的 .tar.gz，含快照与 changelog。
 *
 * 用系统 `tar` 命令打包，不需要额外依赖。
 */

import { execFile } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export interface ExportResult {
  exportPath: string;
  projectName: string;
  draftCount: number;
  versionCount: number;
  sizeBytes: number;
}

/** 导出项目为 .tar.gz */
export async function exportProject(
  projectDir: string,
  outputPath: string,
): Promise<ExportResult> {
  if (!existsSync(projectDir)) {
    throw new Error(`项目目录不存在：${projectDir}`);
  }

  // 用系统 tar 打包
  await new Promise<void>((resolve, reject) => {
    execFile("tar", ["-czf", outputPath, "-C", projectDir, "."], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const sizeStat = statSync(outputPath);
  const projectName = basename(projectDir);

  const drafts = readdirSync(projectDir).filter((f) => f.endsWith(".dc.html"));
  const snapDir = join(projectDir, ".umbrastudio/snapshots");
  let versionCount = 0;
  if (existsSync(snapDir)) {
    for (const sub of readdirSync(snapDir)) {
      const subPath = join(snapDir, sub);
      if (statSync(subPath).isDirectory()) {
        versionCount += readdirSync(subPath).filter((f) => f.endsWith(".json")).length;
      }
    }
  }

  return {
    exportPath: outputPath,
    projectName,
    draftCount: drafts.length,
    versionCount,
    sizeBytes: sizeStat.size,
  };
}

/** 导入项目：从 .tar.gz 解压到目标目录 */
export async function importProject(
  tarPath: string,
  targetDir: string,
): Promise<{ imported: boolean; projectName: string; draftCount: number }> {
  if (!existsSync(tarPath)) {
    throw new Error(`导出文件不存在：${tarPath}`);
  }

  await mkdir(targetDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    execFile("tar", ["-xzf", tarPath, "-C", targetDir], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const projectName = basename(targetDir);
  const drafts = readdirSync(targetDir).filter((f) => f.endsWith(".dc.html"));

  return {
    imported: true,
    projectName,
    draftCount: drafts.length,
  };
}
