# Agent CLIs

Windows 本地 Agent CLI 管理器。左侧显示已打开的会话列表，右侧显示对应的交互式终端；点击左侧项即可切换当前会话。

## Features

- Electron + React + TypeScript 桌面应用
- 左侧会话列表支持新增、切换、关闭、重命名
- 右侧使用 `xterm.js` 显示独立终端
- 主进程使用 `node-pty` 管理每个会话的独立 PTY
- 会话配置持久化到 `%APPDATA%`，重启应用后自动恢复并重建 tab
- Windows 下优先使用 `pwsh.exe`，不存在时回退到 `powershell.exe`

## Scripts

```bash
npm install
npm run dev
npm run lint
npm test
npm run build
npm run dist
```

## Output

- 生产构建输出：
  - `dist/`
  - `dist-electron/`
- Windows 安装包输出：
  - `release/Agent CLIs-0.1.0-Setup.exe`

## Windows Notes

- 当前打包配置默认 `npmRebuild: false`，直接使用 `node-pty` 自带的 Windows 预编译二进制，因此 `npm run dist` 可以在未安装 Visual Studio Build Tools 的环境下完成。
- 如果你要强制重建原生模块，可手动运行：

```bash
npm run rebuild
```

- `npm run rebuild` 需要本机安装 Visual Studio Build Tools；否则会因为 `node-gyp` 找不到可用的 MSVC 工具链而失败。
