# TypeScript 渐进迁移方案

## 1. 背景与结论

本项目适合引入 TypeScript，但不适合一次性将所有 `.js` 文件改写为 `.ts`。

推荐采用“保持现有功能和运行方式稳定，逐步类型化高价值模块”的方式：先建立类型检查和核心领域模型，再迁移边界清晰的模块，最后拆分并迁移 `bili-router.js`、`music-player.js` 等大型文件。

迁移期间必须遵守以下原则：

- 不在同一个提交中同时进行功能修改和大批量类型迁移。
- 不为了通过编译而大面积使用 `any`、非空断言或双重类型断言。
- 外部请求、文件内容和浏览器事件仍需运行时校验；TypeScript 不能代替数据校验。
- 每个阶段都必须保持 `npm test` 通过，并补足该阶段涉及模块的测试。
- 生产环境运行编译后的 JavaScript，不依赖 `ts-node` 或 `tsx` 直接执行源码。
- 前端和服务端分别配置 TypeScript，避免混用 DOM、Node 和模块解析规则。

## 2. 当前项目基线

当前运行结构：

- 服务端入口：`app.js`，使用 Node.js、Express 和 CommonJS。
- 前端入口：`src/public/main.js`，由浏览器直接加载原生 ES Module。
- 静态资源：由 Express 直接提供 `src/public`。
- 测试：Node.js 内置测试运行器，命令为 `npm test`。
- 启动：开发环境执行 `node app.js`，生产环境由 PM2 执行 `app.js`。
- 当前没有 TypeScript、构建器、打包器或 lint 流程。

迁移前先保存以下基线结果：

```powershell
node --version
npm --version
npm test
npm run dev
```

手工检查至少包括：

- 播放页能够打开并播放歌曲。
- 网易云和 QQ 音乐的搜索、点歌、歌词及播放地址请求正常。
- 普通播放页、OBS 页面和直播姬 WebView 的状态同步正常。
- B 站历史弹幕与 `realtime=1` WebSocket 模式正常。
- 配置保存、Cookie 保存、启动器和 PM2 启动正常。

## 3. 目标结构

迁移完成后建议形成以下边界：

```text
项目根目录
├─ app.ts                         # 服务端入口，最后阶段再迁移
├─ src/
│  ├─ types/                     # 跨模块领域类型和外部数据边界
│  │  ├─ song.ts
│  │  ├─ order.ts
│  │  ├─ sync.ts
│  │  ├─ settings.ts
│  │  └─ browser-events.ts
│  ├─ routers/
│  ├─ services/
│  └─ public/
│     ├─ main.ts
│     ├─ components/
│     └─ services/
├─ test/
├─ dist/                         # 编译产物，不手工修改
├─ tsconfig.base.json
├─ tsconfig.server.json
└─ tsconfig.client.json
```

这只是目标形态，不要求在第一阶段移动现有文件。

## 4. 核心类型边界

优先建立下列领域类型。类型名称可以在实现时调整，但不应继续让这些数据以无约束对象在模块间传播。

### 4.1 歌曲与点歌队列

- `MusicPlatform`
- `SongId`
- `Song`
- `OrderItem`
- `OrderUser`
- `LyricLine`
- `LyricResult`
- `MusicServer`

`MusicServer` 应统一搜索、歌曲详情、播放地址和歌词方法的输入输出。网易云和 QQ 音乐的原始响应类型不得直接扩散到播放器组件。

### 4.2 房间状态与同步协议

- `RoomId`
- `PlayerStatus`
- `PlaybackState`
- `RoomState`
- `PublisherInfo`
- `PublisherLease`
- `StateRevision`
- `SyncCommand`
- `SyncCommandType`
- `SyncStateResponse`

同步命令优先使用可辨识联合类型，例如：

```ts
type SyncCommand =
    | { type: 'play'; song: Song }
    | { type: 'pause' }
    | { type: 'seek'; positionMs: number }
    | { type: 'volume'; value: number }
    | { type: 'settings'; order: OrderSettings; login: LoginSettings };
```

实际命令名称必须以现有协议为准，迁移不能顺便改变线上字段。

### 4.3 配置与浏览器事件

- `RuntimeConfig`
- `WebApiConfig`
- `DisplaySettings`
- `OrderSettings`
- `LoginSettings`
- `DanmuSettings`
- 自定义 `Window` 属性声明
- 自定义事件 `detail` 映射

所有 `window.__xxx` 属性应集中声明，不能分散在组件中各自断言。自定义事件的事件名和 `detail` 类型也应集中管理。

## 5. 分阶段迁移步骤

### 阶段 0：冻结行为并补充迁移保障

目标：在改变工具链之前建立可靠的回归基线。

步骤：

1. 确认现有测试全部通过。
2. 为 `/live/sync-state`、`/live/sync-command` 和关键状态归一化函数补充测试。
3. 为网易云及 QQ 音乐响应适配层增加最小样例测试。
4. 至少增加一条浏览器冒烟测试，覆盖页面加载、播放器初始化和点歌队列渲染。
5. 记录启动器、PM2、OBS 和直播姬的手工验证清单。

验收标准：

- `npm test` 全部通过。
- 同步协议和外部音乐响应至少有固定样例测试。
- 已有一份可重复执行的手工冒烟检查表。

### 阶段 1：只引入类型检查，不改变生产运行方式

目标：让 TypeScript 先成为检查工具，而不是立即成为运行时依赖。

建议开发依赖：

```powershell
npm install --save-dev typescript @types/node @types/express @types/ws
```

新增：

- `tsconfig.base.json`
- `tsconfig.server.json`
- `tsconfig.client.json`
- `typecheck:server`、`typecheck:client` 和 `typecheck` npm scripts

建议初始策略：

- 开启 `strict`。
- JavaScript 迁移期允许 `allowJs`。
- 不要第一天对全仓启用 `checkJs`；使用独立 include 范围或逐文件添加 `// @ts-check`。
- 服务端使用 Node 模块解析和 Node 类型。
- 前端使用 DOM 类型和 ESM 模块解析，不加载 Node 全局类型。
- 类型检查阶段使用 `noEmit`，避免尚未建立构建流程时生成半成品。

验收标准：

- `npm run typecheck` 可稳定执行。
- 新增的类型配置不会改变 `npm run dev` 和 `npm test`。
- 没有通过全局关闭 `strict` 或大面积添加 `any` 来消除错误。

### 阶段 2：建立领域模型和运行时校验边界

目标：先固定模块之间的数据契约，再开始改扩展名。

步骤：

1. 建立歌曲、订单、房间状态、同步命令和设置类型。
2. 给现有 JavaScript 添加 JSDoc 类型，让运行代码先消费这些模型。
3. 在以下不可信输入处做运行时解析：
   - Express 的 `req.body` 和 `req.query`。
   - B 站 HTTP/WebSocket 消息。
   - 网易云及 QQ 音乐响应。
   - JSON/JSONL 持久化文件。
   - 浏览器 `CustomEvent.detail` 和跨页面同步结果。
4. 评估使用轻量手写类型守卫还是 schema 库。若引入 Zod 等库，应先测量浏览器包体和 Node 启动影响。
5. 归一化函数应返回明确类型，业务层只处理归一化后的对象。

验收标准：

- 核心业务对象不再使用无约束的 `object` 或隐式结构传播。
- 外部数据解析失败时有明确的错误或降级行为。
- 类型守卫和归一化函数有测试。

### 阶段 3：迁移低风险模块

目标：验证 TS 编译、测试和发布链路，避免先碰大型模块。

推荐顺序：

1. `src/public/services/lyric-parser.mjs`
2. `src/public/services/lyric-service.js`
3. `src/config.js`
4. `src/services/local-store.js`
5. `src/utils/encrypt.js`

每次只迁移一个模块：

1. 先补全输入输出测试。
2. 将模块改为 `.ts`。
3. 消除隐式 `any`，但不改变功能。
4. 调整引用和测试入口。
5. 运行类型检查和全部测试。
6. 手工验证与模块有关的页面或启动流程。

在第一个 `.ts` 运行模块落地前，必须完成正式构建流程：

- `npm run build:server`
- `npm run build:client`
- `npm run build`
- `npm run clean`
- 编译结果写入 `dist`。
- HTML、CSS、图片和必要配置脚本被复制到对应静态目录。
- 开发命令可以监听源码变化，但生产命令必须运行 `dist` 中的 JavaScript。

验收标准：

- 从一个干净工作区执行安装、构建、测试和启动全部成功。
- PM2 和启动器能够运行编译产物。
- 构建后页面资源路径、版本 query 和动态生成的 `webapi.js`、`version.js` 正常。

### 阶段 4：迁移服务和协议层

目标：类型化收益高、但涉及外部协议和二进制处理的模块。

推荐顺序：

1. `src/services/bili-session.js`
2. `src/services/bili-live-ws.js`
3. 网易云 API 动态路由适配层
4. QQ/网易云音乐服务实现

注意事项：

- `Buffer`、WebSocket 数据帧和压缩结果必须使用准确类型，不能统一转成 `any`。
- B 站数组位置型消息先解析为原始协议类型，再归一化为项目内部事件。
- `NeteaseCloudMusicApi[apiPath]` 保留动态能力，但应包在一个类型明确的适配器里。
- 每个第三方响应只在适配器内部出现，播放器和路由不直接依赖第三方原始结构。
- 不在类型迁移提交中更改重连、去重、ACK、租约或 Cookie 行为。

验收标准：

- 现有 WebSocket、Cookie 和协议测试全部通过。
- 新增错误响应、缺字段和未知消息类型测试。
- 服务层导出的公共 API 不包含隐式 `any`。

### 阶段 5：拆分并迁移大型文件

目标：在已有类型和测试保护下处理最高风险模块。

#### `src/routers/bili-router.js`

先拆分，再迁移。建议提取：

- 房间 ID 和请求参数解析。
- 歌曲、订单和房间状态归一化。
- 发布者租约与 fencing 规则。
- 状态持久化和命令日志。
- B 站 HTTP API 客户端。
- Express 路由注册。

路由层只负责 HTTP 输入输出，业务规则放入可单测服务。

#### `src/public/components/music-player.js`

先拆分，再迁移。建议提取：

- 音频播放控制。
- 播放位置和歌词同步。
- 队列状态。
- 房间发布者/镜像页同步。
- 显示设置。
- DOM 渲染和事件绑定。

DOM 元素应在明确的初始化方法中查询并检查，不要依靠类字段初始化时的非空断言。

#### `src/public/main.js`

最后迁移入口文件。入口只负责组装模块、读取页面参数和启动应用，不继续承载业务状态转换。

验收标准：

- 大型文件按职责拆分，单个模块有清楚的公共接口。
- 没有因迁移而改变现有 HTTP/WebSocket 协议字段。
- 浏览器冒烟测试、同步接口测试和手工多页面验证全部通过。

### 阶段 6：收紧规则和清理兼容层

目标：结束迁移期，而不是永久维持半 JS、半 TS 的宽松状态。

步骤：

1. 将剩余 JavaScript 文件列入明确清单，决定迁移或保留原因。
2. 逐步移除临时 JSDoc、重复声明和过渡适配器。
3. 将 `noImplicitAny`、`strictNullChecks` 等严格规则保持为强制要求。
4. 在 CI 或提交检查中固定执行构建、类型检查和测试。
5. 检查 `dist` 是否应加入 `.gitignore`，并统一发布方式。
6. 更新 README、启动脚本、PM2 配置和故障排查文档。

验收标准：

- 干净安装后可重复构建。
- 类型检查、测试和生产启动使用同一套编译配置。
- 生产代码没有未经说明的大面积 `any` 或 `@ts-ignore`。
- 文档中的开发和部署命令与实际行为一致。

## 6. 提交与回滚策略

建议按以下粒度提交：

1. TypeScript 依赖和配置。
2. 核心类型定义。
3. 某一个模块的测试补充。
4. 该模块的 TS 迁移。
5. 构建或启动脚本调整。

每个提交应满足：

- 可独立通过测试和类型检查。
- 不包含无关格式化。
- 不混入新功能。
- 能通过回退单个提交恢复迁移前行为。

## 7. 明确不推荐的做法

- 一次性把所有 `.js` 重命名成 `.ts`。
- 使用全局 `strict: false` 作为长期配置。
- 给外部响应统一标记成 `any`。
- 使用大量 `as unknown as SomeType` 绕过边界解析。
- 用非空断言隐藏 DOM 初始化顺序问题。
- 生产环境直接通过 `tsx` 或 `ts-node` 启动。
- 在迁移过程中顺便更改同步协议、文件格式或播放器行为。
- 在没有浏览器验证的情况下迁移整个前端入口和播放器。

## 8. 每个阶段的统一检查清单

```powershell
npm run typecheck
npm test
npm run build
npm run dev
```

然后检查：

- 控制台没有新增错误或未处理 Promise。
- 页面可以加载全部 JS/CSS/配置资源。
- 点歌、切歌、暂停、进度、音量和歌词正常。
- 控制页与播放页同步正常。
- OBS 和直播姬场景切换后发布者租约正常。
- 历史弹幕和实时 WebSocket 弹幕正常。
- 配置和凭据持久化正常。
- 启动器和 PM2 能正确启动、停止及查看日志。

## 9. 建议的第一批实际工作

首次实施建议只完成以下内容，不立即迁移大型业务文件：

1. 补充同步状态与命令接口测试。
2. 添加 TypeScript 开发依赖和两套 `tsconfig`。
3. 添加 `typecheck` scripts。
4. 创建歌曲、订单、同步状态和浏览器事件类型。
5. 用 JSDoc 将类型接入现有 JavaScript。
6. 迁移歌词解析器作为第一块 TS 试点。
7. 建立可从干净工作区验证的编译与静态资源复制流程。

完成这批工作后再评估错误数量、构建复杂度和浏览器兼容情况，决定下一批迁移范围。
