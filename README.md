# Agent CLIs

Agent CLIs is a Windows desktop manager for multiple local Agent CLI sessions.
The left sidebar organizes projects and sessions, while the main area shows the
interactive terminal for the currently active session.

Chinese documentation is available in the [Chinese section](#中文说明) below.

## Features

- Electron + React + TypeScript desktop application
- Create projects first, then add sessions when needed
- Sidebar flows for creating, switching, renaming, and closing sessions
- Dedicated `xterm.js` terminal surface for each session
- `node-pty` PTY management in the Electron main process
- Session state persisted under `%APPDATA%` and restored on relaunch
- Prefers `pwsh.exe` on Windows and falls back to `powershell.exe`

## Scripts

```bash
npm install
npm run dev
npm run lint
npm test
npm run build
npm run dist
```

## Build Output

- App bundles:
  - `dist/`
  - `dist-electron/`
- Windows installer:
  - `release/Agent CLIs-0.1.0-Setup.exe`

## Windows Packaging Notes

- The current packaging config uses `npmRebuild: false` and relies on the
  prebuilt Windows binaries bundled with `node-pty`, so `npm run dist` can run
  without Visual Studio Build Tools.
- If you need to rebuild native modules manually, run:

```bash
npm run rebuild
```

- `npm run rebuild` requires Visual Studio Build Tools. Otherwise `node-gyp`
  will fail because the MSVC toolchain is unavailable.

## 中文说明

Agent CLIs 是一个用于管理多个本地 Agent CLI 会话的 Windows 桌面应用。
左侧边栏用于组织项目和会话，右侧区域显示当前活动会话的交互式终端。

### 功能

- 基于 Electron + React + TypeScript 构建
- 可以先创建项目，再按需添加会话
- 左侧边栏支持新建、切换、重命名和关闭会话
- 每个会话都有独立的 `xterm.js` 终端界面
- Electron 主进程通过 `node-pty` 管理各个会话的 PTY
- 会话状态会持久化到 `%APPDATA%`，并在应用重启后恢复
- Windows 下优先使用 `pwsh.exe`，不存在时回退到 `powershell.exe`

### 常用命令

```bash
npm install
npm run dev
npm run lint
npm test
npm run build
npm run dist
```

### Windows 打包说明

- 当前打包配置使用 `npmRebuild: false`，直接依赖 `node-pty` 自带的
  Windows 预编译二进制，因此 `npm run dist` 不要求预先安装
  Visual Studio Build Tools。
- 如果你需要手动重建原生模块，请运行：

```bash
npm run rebuild
```

- `npm run rebuild` 需要本机安装 Visual Studio Build Tools，否则
  `node-gyp` 会因为缺少 MSVC 工具链而失败。
