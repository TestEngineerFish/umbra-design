---
title: "[chore] 壳内自测：旧实例还活着时新启动被 single-instance 静默吞掉，没有任何读数"
labels: [type:chore, from:radar, p2]
---
<!-- fp: review/umbra-design/src-tauri/src/lib.rs#single-instance-autotest -->
来源：扫测 ｜ 证据：src-tauri/src/lib.rs `tauri_plugin_single_instance::init`；两次 `npx tauri dev --no-watch` 跑完 `UMBRADESIGN_AUTOTEST_LOG` 都没生成，`pkill -f target/debug/app` 之后第三次正常
发现方式：壳内自测连续两次零读数后排查出来。【确证】
状态：待修

### 位置
single-instance 插件让第二个进程把参数发给第一个然后退出；自测的环境变量在第二个进程里，第一个进程不知道要跑自测，也不会写日志。日志文件不存在和「自测全失败」长得一样。

### 为什么是问题
排查时容易误判成前端 boot 坏了（这次就花了两轮）。

### 影响面
开发侧。

### 怎么修
两处：① `doc/00` §三十八 的步骤前加一行 `pkill -f target/debug/app`；② 自测模式启动时若被转发，让第一个实例在 single-instance 回调里往 `UMBRADESIGN_AUTOTEST_LOG`（从 argv 环境拿不到，可改成命令行参数 `--autotest-dir`）写一行「已有实例在跑，本次未执行」。先做 ①。
