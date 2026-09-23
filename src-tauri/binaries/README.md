# src-tauri/binaries/

Tauri 打包时捆绑进 `.app` 的 Node 运行时（`tauri.conf.json` → `bundle.externalBin: ["binaries/node"]`）。
文件名必须带目标三元组：`node-aarch64-apple-darwin`（macOS ARM64）。

**它不进仓库**：106 MB，GitHub 拒收 100 MB 以上的文件（2026-09-23 push 被 GH001 拦下，已从历史里清掉）。
本地生成一次即可，`tauri build` / `tauri dev` 之前跑：

```bash
cp "$(which node)" src-tauri/binaries/node-aarch64-apple-darwin
chmod +x src-tauri/binaries/node-aarch64-apple-darwin
src-tauri/binaries/node-aarch64-apple-darwin --version   # M3-5 用的是 v22.19.0；>=20 都行
```

其他平台按 `rustc -vV` 里的 host 三元组命名（如 `node-x86_64-pc-windows-msvc.exe`）。
