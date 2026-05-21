# Agent 微信小程序开发闭环方案

## 1. 目标

实现一套可被 Cursor / Codex / Claude 等 Agent 使用的微信小程序开发闭环：

```text
需求 / PRD / UI 设计
    ↓
Agent 编写代码
    ↓
本地静态检查
    ↓
微信小程序编译 / 预览
    ↓
运行态调试
    ↓
云函数 / 数据库 / 云端部署
    ↓
日志反馈
    ↓
Agent 自动修复
```

最终目标是让 Agent 不只是“写代码”，而是能基于真实编译结果、运行时日志、云端日志持续修复问题。

---

## 2. 整体架构

推荐组合：

```text
Cursor / Codex / Claude
    ↓
项目内 npm scripts
    ↓
miniprogram-ci
    ↓
编译 / 构建 npm / 预览 / 上传 / 输出日志
    ↓
wechat-devtools-mcp
    ↓
微信开发者工具运行态调试 / Console / 页面状态
    ↓
CloudBase MCP
    ↓
云函数 / 数据库 / 云托管 / 云端日志 / 部署
```

三类工具的职责边界：

| 工具                  | 主要作用                                   | 解决的问题                        |
| --------------------- | ------------------------------------------ | --------------------------------- |
| `miniprogram-ci`      | 小程序编译、预览、上传、构建 npm           | 让 Agent 获得 CLI 级编译验证能力  |
| `wechat-devtools-mcp` | 接入微信开发者工具、页面操作、读取 Console | 让 Agent 获得运行态调试能力       |
| `CloudBase MCP`       | 云函数、数据库、云开发部署、云端日志       | 让 Agent 获得后端和云资源操作能力 |

### 相关链接

- **miniprogram-ci**
  - [npm 包](https://www.npmjs.com/package/miniprogram-ci)
  - [官方 CI 文档](https://developers.weixin.qq.com/miniprogram/dev/devtools/ci.html)
- **wechat-devtools-mcp**
  - [掘金介绍](https://juejin.cn/post/7610692103749042222)
  - [GitHub 仓库](https://github.com/FliPPeDround/wechat-devtools-mcp)
- **CloudBase MCP**
  - [连接 CloudBase MCP](https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/getting-started)

---

## 3. 核心原则

### 3.1 主闭环必须基于 CLI

稳定的主验证链路应该是：

```text
npm scripts
    ↓
miniprogram-ci
    ↓
debug/*.log
    ↓
Agent 读取日志并修复
```

不要把 GUI 自动化作为主闭环。

原因：

```text
1. GUI 不稳定
2. 登录态、弹窗、网络状态容易影响流程
3. 日志难以结构化
4. 不适合 CI / 远程开发环境
5. Agent 更适合处理命令行输出和日志文件
```

### 3.2 `wechat-devtools-mcp` 作为运行态补充

`wechat-devtools-mcp` 适合做：

```text
1. 打开微信开发者工具
2. 进入指定页面
3. 操作页面
4. 获取页面状态
5. 读取 Console 日志
6. 捕获运行时异常
```

它更适合解决“编译成功但运行异常”的问题。

### 3.3 `CloudBase MCP` 负责云开发闭环

CloudBase MCP 适合做：

```text
1. 创建 / 修改云函数
2. 操作云数据库
3. 部署云函数
4. 查看云端日志
5. 分析云端错误
6. 修复后端和部署问题
```

它解决的是小程序后端与云资源自动化问题。

---

## 4. 推荐项目结构

建议在小程序项目中增加：

```text
project-root/
├── miniprogram/
├── cloudfunctions/
├── scripts/
│   ├── wx-check.js
│   ├── wx-preview.js
│   ├── wx-upload.js
│   └── wx-build-npm.js
├── debug/
│   ├── wx-check.log
│   ├── wx-preview.log
│   └── wechat-devtools-error.md
├── project.config.json
├── project.private.config.json
├── package.json
└── README.md
```

其中：

```text
scripts/      放自动化脚本
debug/        放 Agent 可读取的错误日志和调试记录
package.json 统一暴露命令
```

---

## 5. npm scripts 设计

`package.json` 推荐配置：

```json
{
  "scripts": {
    "check": "npm run lint && npm run typecheck",
    "wx:build-npm": "node scripts/wx-build-npm.js",
    "wx:preview": "node scripts/wx-preview.js",
    "wx:upload": "node scripts/wx-upload.js",
    "wx:check": "node scripts/wx-check.js"
  }
}
```

推荐 Agent 每次修改代码后执行：

```bash
npm run wx:check
```

`wx:check` 应该承担主验证职责：

```text
1. 检查依赖
2. 运行 lint
3. 运行 typecheck
4. 构建小程序 npm
5. 调用 miniprogram-ci 预览 / 编译
6. 输出完整日志到 debug/wx-check.log
```

---

## 6. miniprogram-ci 接入

相关链接：[npm 包](https://www.npmjs.com/package/miniprogram-ci) · [官方 CI 文档](https://developers.weixin.qq.com/miniprogram/dev/devtools/ci.html)

### 6.1 安装

```bash
npm install miniprogram-ci --save-dev
```

### 6.2 准备上传密钥

需要在微信公众平台配置：

```text
微信公众平台
  → 开发
  → 开发管理
  → 开发设置
  → 小程序代码上传
  → 下载代码上传密钥
```

通常需要：

```text
1. 小程序 AppID
2. private key 文件
3. IP 白名单
```

建议密钥文件不要提交到 Git：

```gitignore
private.*.key
```

---

## 7. wx-preview.js 示例

```js
// scripts/wx-preview.js
const ci = require("miniprogram-ci");
const path = require("path");
const fs = require("fs");

const appid = process.env.WX_APPID || "你的 appid";
const projectPath = path.resolve(__dirname, "..");
const privateKeyPath =
  process.env.WX_PRIVATE_KEY_PATH ||
  path.resolve(projectPath, `private.${appid}.key`);

const logDir = path.resolve(projectPath, "debug");
const logFile = path.resolve(logDir, "wx-preview.log");

fs.mkdirSync(logDir, { recursive: true });

function appendLog(message) {
  fs.appendFileSync(logFile, `${message}\n`);
}

const project = new ci.Project({
  appid,
  type: "miniProgram",
  projectPath,
  privateKeyPath,
  ignores: ["node_modules/**/*"],
});

async function main() {
  fs.writeFileSync(logFile, "");

  appendLog("[wx-preview] start");

  const result = await ci.preview({
    project,
    desc: "agent preview",
    setting: {
      es6: true,
      minify: false,
    },
    qrcodeFormat: "image",
    qrcodeOutputDest: path.resolve(logDir, "preview-qrcode.jpg"),
    onProgressUpdate: (task) => {
      const line = JSON.stringify(task);
      console.log(line);
      appendLog(line);
    },
  });

  appendLog(JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  const msg = err && err.stack ? err.stack : String(err);
  appendLog(msg);
  console.error(msg);
  process.exit(1);
});
```

---

## 8. wx-check.js 示例

```js
// scripts/wx-check.js
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const projectRoot = path.resolve(__dirname, "..");
const logDir = path.resolve(projectRoot, "debug");
const logFile = path.resolve(logDir, "wx-check.log");

fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(logFile, "");

function run(command, args) {
  const title = `$ ${command} ${args.join(" ")}`;
  console.log(title);
  fs.appendFileSync(logFile, `\n${title}\n`);

  const result = spawnSync(command, args, {
    cwd: projectRoot,
    shell: true,
    encoding: "utf-8",
  });

  if (result.stdout) {
    console.log(result.stdout);
    fs.appendFileSync(logFile, result.stdout);
  }

  if (result.stderr) {
    console.error(result.stderr);
    fs.appendFileSync(logFile, result.stderr);
  }

  if (result.status !== 0) {
    fs.appendFileSync(logFile, `\nCommand failed with code ${result.status}\n`);
    process.exit(result.status);
  }
}

function main() {
  if (fs.existsSync(path.resolve(projectRoot, "package.json"))) {
    run("npm", ["run", "check", "--if-present"]);
  }

  run("npm", ["run", "wx:build-npm", "--if-present"]);
  run("npm", ["run", "wx:preview"]);
}

main();
```

---

## 9. 微信开发者工具日志反馈

如果开发者工具内出现问题，优先复制这些内容给 Agent：

```text
1. Console 完整报错
2. 编译面板完整输出
3. Network 失败请求
4. 当前页面路径
5. 调试基础库版本
6. 微信开发者工具版本
```

建议保存为：

```text
debug/wechat-devtools-error.md
```

模板：

````markdown
# WeChat DevTools Error

## Problem

微信开发者工具编译 / 运行失败。

## Steps

1. 打开项目
2. 点击编译
3. 进入页面：xxx
4. 出现错误

## Console Log

```text
粘贴完整 Console 日志
```

## Compile Log

```text
粘贴完整编译日志
```

## Environment

- 微信开发者工具版本：
- 调试基础库版本：
- 操作系统：
- Node 版本：
- npm / pnpm 版本：
- 项目类型：原生小程序 / Taro / uni-app / 其他

## Related Files

- project.config.json
- app.json
- package.json
- pages/xxx/xxx.js
- pages/xxx/xxx.wxml
- pages/xxx/xxx.wxss

## Task for Agent

请根据以上日志分析问题原因，并直接修改代码。
````

---

## 10. wechat-devtools-mcp 的作用

相关链接：[掘金介绍](https://juejin.cn/post/7610692103749042222) · [GitHub 仓库](https://github.com/FliPPeDround/wechat-devtools-mcp)

`wechat-devtools-mcp` 可以让 Agent 接入本地微信开发者工具。

适合场景：

```text
1. 编译成功，但页面运行异常
2. 需要读取 Console 日志
3. 需要进入指定页面
4. 需要模拟点击、输入、页面跳转
5. 需要查看页面状态
```

它不是替代 `miniprogram-ci` 的工具，而是补充运行态调试能力。

推荐使用方式：

```text
Agent 修改代码
    ↓
npm run wx:check
    ↓
如果编译成功但运行异常
    ↓
使用 wechat-devtools-mcp 打开页面
    ↓
读取 Console / 页面状态
    ↓
继续修复
```

---

## 11. CloudBase MCP 的作用

相关链接：[连接 CloudBase MCP](https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/getting-started)

CloudBase MCP 负责云开发和后端闭环。

适合场景：

```text
1. 云函数开发
2. 云函数部署
3. 云数据库操作
4. 云端日志分析
5. 云开发环境配置
6. 静态托管 / 云托管部署
```

它解决的问题是：

```text
小程序前端代码
    ↓
调用云函数
    ↓
访问云数据库
    ↓
部署云端资源
    ↓
读取云端日志
    ↓
修复后端问题
```

CloudBase MCP 不负责本地微信开发者工具调试。

---

## 12. 推荐 Agent 工作流

### 12.1 前端开发闭环

```text
1. Agent 根据 PRD / UI 规格修改页面代码
2. 运行 npm run wx:check
3. 如果失败，读取 debug/wx-check.log
4. 根据日志修复代码
5. 再次运行 npm run wx:check
6. 成功后使用 wechat-devtools-mcp 做运行态检查
7. 读取 Console
8. 修复运行时错误
```

### 12.2 云开发闭环

```text
1. Agent 修改云函数 / 数据库逻辑
2. 使用 CloudBase MCP 部署云函数
3. 运行小程序前端调用云函数
4. 读取云端日志
5. 如果失败，修复云函数或前端调用代码
6. 再次部署并验证
```

### 12.3 发布闭环

```text
1. npm run wx:check
2. miniprogram-ci preview
3. 人工扫码确认核心路径
4. npm run wx:upload
5. 上传体验版 / 审核版本
6. 记录版本号和 changelog
```

---

## 13. 给 Cursor / Codex 的项目规则

可以在项目中写入 `.cursorrules`、`AGENTS.md` 或类似规则文件。

示例：

````markdown
# Agent Rules for WeChat Mini Program

## Validation

After modifying mini program code, always run:

```bash
npm run wx:check
```

If it fails, read:

```text
debug/wx-check.log
```

Fix the issue based on the log and rerun the check.

## Runtime Debugging

If the CLI check passes but the page has runtime issues, use wechat-devtools-mcp to:

1. Open the target page
2. Read Console logs
3. Inspect page state
4. Reproduce the issue

## Cloud Development

If the task involves cloud functions, database, hosting, or deployment, use CloudBase MCP.

## Do Not

- Do not rely only on static analysis.
- Do not claim the task is done before `npm run wx:check` passes.
- Do not ignore `project.config.json`, `app.json`, or route configuration errors.
- Do not commit private upload keys.
````

---

## 14. Agent 任务提示词模板

### 14.1 修复编译错误

```text
请修复当前微信小程序编译错误。

要求：

1. 先阅读 debug/wx-check.log
2. 检查 project.config.json、app.json、package.json
3. 根据日志定位问题
4. 直接修改代码
5. 修改后运行 npm run wx:check
6. 如果仍失败，继续根据日志修复
```

### 14.2 修复页面运行错误

```text
请修复当前页面运行时错误。

要求：

1. 运行 npm run wx:check，确认编译是否通过
2. 如果编译通过，使用 wechat-devtools-mcp 打开目标页面
3. 读取 Console 日志
4. 根据运行时错误修复代码
5. 再次验证页面是否正常运行
```

### 14.3 开发云函数

```text
请实现这个小程序云函数功能。

要求：

1. 修改 cloudfunctions 下的代码
2. 使用 CloudBase MCP 部署云函数
3. 修改前端调用逻辑
4. 运行 npm run wx:check
5. 读取云端日志确认调用结果
6. 如果失败，继续修复
```

---

## 15. 推荐闭环命令

日常开发：

```bash
npm run wx:check
```

预览：

```bash
npm run wx:preview
```

上传：

```bash
npm run wx:upload
```

查看日志：

```bash
cat debug/wx-check.log
```

---

## 16. 常见问题边界

### 16.1 `miniprogram-ci` 能不能完全替代微信开发者工具？

不能。

它适合自动化编译、预览、上传，但不适合完整模拟开发者工具里的运行态调试体验。

### 16.2 `wechat-devtools-mcp` 能不能替代 `miniprogram-ci`？

不建议。

它依赖本地微信开发者工具和登录态，更适合作为运行态调试补充，不适合作为主验证链路。

### 16.3 CloudBase MCP 是不是小程序前端调试工具？

不是。

它主要负责云函数、数据库、云开发部署、云端日志等后端和云资源能力。

### 16.4 是否需要 MCP？

不一定。

最小可用闭环是：

```text
Agent + npm scripts + miniprogram-ci + debug 日志
```

当需要运行态调试时，再加入：

```text
wechat-devtools-mcp
```

当需要云开发和部署时，再加入：

```text
CloudBase MCP
```

---

## 17. 最小可行方案

如果只想先跑通第一版，建议先实现：

```text
1. package.json 增加 wx:check
2. scripts/wx-preview.js 接入 miniprogram-ci
3. debug/wx-check.log 输出完整日志
4. AGENTS.md 规定 Agent 必须运行 npm run wx:check
```

最小闭环：

```text
Agent 修改代码
    ↓
npm run wx:check
    ↓
失败：Agent 读 debug/wx-check.log 并修复
    ↓
成功：人工或 Agent 继续运行态验证
```

---

## 18. 完整闭环方案

完整方案：

```text
Agent
    ↓
读取 PRD / UI 设计 / 接口文档
    ↓
修改小程序前端代码
    ↓
npm run wx:check
    ↓
miniprogram-ci 编译 / 预览
    ↓
失败：读取 debug/wx-check.log 自动修复
    ↓
成功：wechat-devtools-mcp 打开页面
    ↓
读取 Console / 页面状态
    ↓
发现运行时错误则自动修复
    ↓
涉及后端则使用 CloudBase MCP
    ↓
部署云函数 / 数据库 / 云资源
    ↓
读取云端日志
    ↓
修复云端问题
    ↓
miniprogram-ci upload 上传体验版 / 审核版本
```

---

## 19. 结论

结合：

```text
1. miniprogram-ci
2. wechat-devtools-mcp
3. CloudBase MCP
```

可以基本实现微信小程序 Agent 开发闭环。

其中：

```text
miniprogram-ci      = 编译 / 预览 / 上传主闭环
wechat-devtools-mcp = 本地开发者工具运行态调试
CloudBase MCP       = 云开发后端和部署闭环
```

推荐优先级：

```text
第一优先级：npm scripts + miniprogram-ci
第二优先级：debug 日志规范化
第三优先级：wechat-devtools-mcp
第四优先级：CloudBase MCP
```

一句话：

> 先把 CLI 验证闭环跑通，再用 MCP 增强运行态调试和云开发能力。
