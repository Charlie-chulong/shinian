# 拾念 / Shinian 架构说明

拾念是基于 Electron、React、TypeScript 和 Vite 的离线灵感与待办应用，首次启动为空工作区。

## 目录与职责

- `electron/main.ts`：生命周期、窗口、托盘、快捷键、原生对话框与 IPC。
- `electron/preload.ts`、`channels.ts`：固定的 `window.shinian` 桥接接口。
- `electron/store.ts`：串行读写、备份和恢复。
- `src/shared/types.ts`、`domain.ts`：数据契约、运行时验证、纯 reducer、合并及 Markdown 转换。
- `src/renderer/`：主界面、编辑器、快捷记录和设置；`assets/` 为本地资源，`tests/` 为领域、存储、界面及原生集成测试。

## 状态与保存

桌面工作区唯一持久化入口是主进程 `StateStore`，主文件为 `app.getPath('userData')` 下的 `shinian.json`。页面提交命令，不能替换整个工作区。`applyCommand` 严格验证命令、字段与引用，以不可变方式产生状态；实际变化推进 `revision`。

命令、导入和恢复由同一队列串行执行。保存先写同目录临时文件并同步，再原子重命名；支持时同步目录。提交成功才更新内存、向所有窗口广播。提交前失败不推进状态；主文件已保存但后续备份失败时，返回成功状态并报告告警。`AppInfo.storageWarning` 承载存储、恢复及启动异常，`systemNotice` 单独承载托盘、快捷键等系统提示。

## 草稿与多窗口

主窗口和 `?quick=1` 快捷窗口共享页面与存储；单实例锁保护同一用户目录。界面按修订号接收状态，丢弃旧响应。编辑器跟踪脏字段及保存版本，自动提交局部补丁，保留请求期间的新输入和失败草稿。主输入框、快捷记录另有本地草稿缓存，缓存不代表工作区已保存。快捷记录保存成功才清空并隐藏；关闭和退出结合 `beforeunload` 确认、队列排空保护待写内容。

## 备份与恢复

`latest-good.json` 提供恢复副本，`backups/` 保存每日自动快照，按 14 天保留期轮转。导入和恢复前先备份当前工作区。JSON 导入经验证、原生确认后合并，重复去重、冲突保留双方、本地设置不变。恢复采用确认时读取的快照；桥接 `restoreBackup()` 返回 `null` 表示取消，仅实际恢复才返回状态。

恢复前先将损坏文件的原始字节保存在 `preserved-corrupt/`，再写入已验证的有效副本；无有效副本则保留原文件并报错，不清空覆盖。JSON 和 Markdown 导出使用原生保存对话框。

## 安全与构建

窗口启用上下文隔离、沙箱，禁用页面 Node。preload 仅开放 `DesktopBridge`；主进程核验 IPC 来源窗口、主框架和页面地址，阻止权限请求、远程导航、远程请求及新窗口。托盘可用才允许关闭后隐藏，系统设置按平台能力处理。

`npm run build` 先类型检查，再由 Vite 输出 `dist/`、esbuild 输出 `dist-electron/main.cjs` 与 `preload.cjs`。`npm start` 启动 Electron，加载 `dist/index.html`；Windows 打包入口为 `npm run package:win`。

`npm run dev` 为明确标记的浏览器预览，使用独立 localStorage。未打包时可显式设置本机 `SHINIAN_DEV_URL` 或隔离数据目录 `SHINIAN_DATA_DIR`；桌面桥接缺失会报错，不回退到预览存储。
