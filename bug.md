# Damuku_music 待修复问题

更新时间：2026-08-12

本文件只保留当前准备处理的 8 类问题。每项包含问题原因、影响和建议解决方案。

## BUG-01：自定义端口和外部 API 配置逻辑不一致

### 1.1 自定义端口不一致

- 位置：`scripts/launch.js:6-18`、`app.js:64`、`app.js:94`、`app.js:113-128`
- 现象：服务端最终端口来自 `DAMUKU_PORT || config.web_server_port`，但启动器只使用 `DAMUKU_PORT || 8000`。如果只修改 `config/config.yaml` 中的 `web_server_port`，服务会监听新端口，启动器却继续探测 8000，最后判断启动失败并结束服务。
- 另一个表现：使用 `DAMUKU_PORT` 覆盖端口时，B 站和网易云 API 的启动日志仍打印 `config.web_server_port`，显示的地址与实际监听地址不一致。
- 影响：自定义端口后无法通过启动器正常启动，或者用户按错误日志地址访问。

解决方案：

1. 提取统一的服务端配置加载模块，例如 `src/config.js`，由 `app.js` 和 `scripts/launch.js` 共同使用。
2. 在该模块中只计算一次最终端口：`Number(process.env.DAMUKU_PORT || config.web_server_port || 8000)`。
3. 启动探测、打开浏览器、服务监听及所有日志统一使用这个最终端口。
4. 对端口进行整数和 `1-65535` 范围校验，非法配置应在启动前明确报错，而不是交给 `listen()` 产生难理解的异常。
5. 增加三组启动测试：默认端口、仅修改 YAML、使用 `DAMUKU_PORT` 覆盖 YAML。

### 1.2 外部 API 地址拼接错误

- 位置：`config/default/webapi.js:1-13`、`app.js:39-97`、`src/public/services/musicServers/wy-music-server.js:4`、`src/public/services/danmuServers/bilibili-server.js:5`、`src/public/components/music-player.js:147-151`
- 现象：配置说明允许将 API 写成完整地址，例如 `https://api.example.com`；后端也把完整地址识别为外部服务。但前端始终使用 `BASE_PATH + apiAddress`，会得到 `/orderhttps://api.example.com` 这种无效地址。
- 影响：将 B 站或网易云 API 拆成外部服务后，健康检查、状态同步、歌曲请求和弹幕连接都会失败。

解决方案：

1. 在前端增加唯一的 `resolveApiBase(apiAddress)` 方法，所有模块都调用它，不再各自拼接。
2. `http://`、`https://`、`//`、`ws://`、`wss://` 开头的地址按绝对地址处理，不添加 `BASE_PATH`。
3. 只有 `/bili-api` 这类挂载路径才拼接规范化后的 `BASE_PATH`。
4. 拼接时统一去除重复斜杠，但不能破坏协议中的 `://`。
5. WebSocket 地址应从解析后的 API URL 转换协议和路径，不能固定使用 `window.location.host`。
6. 增加相对挂载路径、完整 HTTP 地址、协议相对地址三组测试。

## BUG-02：部分设置无法同步到 OBS

- 位置：`src/public/components/order-configer.js:79-94`、`src/public/components/order-configer.js:193-231`、`src/public/components/music-player.js:440-468`、`src/routers/bili-router.js:106-134`
- 现象：`getSharedState()` 只返回历史用户、历史歌曲和黑名单，没有返回以下四个真正影响点歌和播放的配置：
  - `userMaxOrder`
  - `globalMaxOrder`
  - `orderMaxDuration`
  - `overLimitSkip`
- 四个 setter 保存到 `localStorage` 后也没有调用 `publishSharedState()`。
- 影响：控制页或设置页显示的是新值，真正接收弹幕和播放歌曲的 OBS 页面仍使用 OBS 浏览器自己的旧 `localStorage`。因此点歌上限、全局上限、歌曲时长限制和超时切歌可能完全不按设置页执行。

解决方案：

1. 将上述四个字段加入 `OrderConfiger.getSharedState()`。
2. `applySharedState()` 接收这些字段时转为数字、校验范围，然后更新实例字段、输入框和本地缓存。
3. 四个 setter 保存成功后调用 `publishSharedState()`，使控制页立即发送 `settings` 命令。
4. 后端 `normalizeRoomState()` 对 `settings.order` 建立完整 schema，不能直接保存任意对象。
5. OBS 页面以服务端房间设置为准；`localStorage` 只作为后端没有状态时的首次默认值，避免旧配置反向覆盖新配置。
6. 建议后端最终也使用这些限制校验 `addOrder`，前端校验只用于快速提示，否则其他客户端仍能绕过限制。

验收方式：在控制页依次修改四个值，不刷新 OBS；OBS 收到的共享状态和实际点歌行为应立即采用新值。重启 OBS 页面后仍应读取同一份后端设置。

## BUG-03：空队列执行“切歌”会抛异常

- 位置：`src/public/components/danmu-configer.js:79-93`
- 现象：处理“切歌”弹幕时，代码直接读取 `musicPlayer.orderList[0].uid`。队列为空时 `orderList[0]` 是 `undefined`，继续访问 `.uid` 会抛出 `TypeError`。
- 触发条件：歌单尚未加载、歌单加载失败、刚播放完最后一首或状态同步暂时返回空队列时收到“切歌”。
- 影响：该条弹幕处理失败，控制台出现未捕获异常，用户得不到正确提示。

解决方案：

1. 先读取当前项并做空值判断：`const current = musicPlayer.orderList[0]`。
2. `current` 不存在时直接提示“当前没有可切换的歌曲”并返回。
3. 后续 `isOwner`、`isAdmin`、`isFree` 全部基于同一个 `current` 计算，避免三次访问不同步的数组。
4. 更稳妥的实现是新增 `musicPlayer.requestNext(user)`，由播放器根据最新服务端状态处理权限和空队列，不让弹幕组件直接读取播放器内部数组。
5. 后端的 `next` 命令应保持幂等：空队列执行时返回正常空状态，而不是报错或产生无意义的播放动作。

验收方式：在无歌单、空队列、最后一首刚结束三个状态下发送“切歌”，页面均不应报错，也不应产生错误队列项。

## BUG-04：歌曲地址获取失败后不会真正切到下一首

- 位置：`src/public/components/music-player.js:793-836`
- 现象：`getSongUrl()` 返回空值时，页面提示“获取歌曲链接失败，即将播放下一首”，但实际代码只释放 `isSwitching` 并调用 `_flushPending()`。正常情况下 `pendingNext` 为 `false`，所以不会发送 `next` 命令。
- 触发条件：歌曲下架、会员限制、版权限制、登录态失效、音乐 API 临时失败或接口返回空 URL。
- 影响：不可播放歌曲一直停留在队首，播放器停止，必须人工切歌；提示文字与实际行为不一致。

解决方案：

1. 确认当前 `requestId` 仍等于 `playbackRequestId` 后，释放切歌锁并主动调用 `playNext()`。
2. 建议延迟 1-2 秒再切歌，让用户看到失败提示，同时保存 timer，切歌或页面销毁时清理。
3. 为同一歌曲记录失败次数或失败键 `${platform}:${sid}`，避免重复状态导致连续提交多个 `next`。
4. 给自动跳过增加一轮上限，例如最多连续跳过当前歌单长度；如果所有歌曲都不可播放，应停止并显示明确错误，避免无限循环。
5. 区分永久不可播和临时网络错误：临时错误可以有限重试 1-2 次，明确不可播则直接下一首。

验收方式：让 `getSongUrl()` 分别返回 `null`、抛异常和返回有效 URL；前两种只发送一次 `next`，后一种正常播放。连续多首不可播时不能形成无限高速切歌。

## BUG-05：点击切换歌单后仍然使用上一个歌单

- 位置：`src/public/components/login-configer.js:259-285`、`src/routers/bili-router.js:156-181`、`src/public/components/music-player.js:392-438`
- 现象一：控制页获取新歌单失败时仍然发送 `loadSongList`，其中 `songList` 是空数组。后端只有新列表非空时才替换 `idleSongList`，却无条件更新 `songListId`。最终状态变成“新歌单 ID + 旧歌单内容”。
- 现象二：即使新歌单成功获取，后端只替换 `idleSongList` 和重置 `idleIndex`。只要旧的 `queue` 或 `currentSong` 还存在，就不会把新歌单第一首放入队列，也不会切换当前播放。因此点击后仍显示和播放旧歌单，用户会认为切换没有生效。
- 现象三：页面提示“OBS 使用共享登录态重试”，但 `login-configer.js` 监听的 `bilibili-ordersong-command` 事件在项目中没有对应的派发位置，这条自动重试链路实际上不会执行。

影响：歌单 ID、空闲歌单内容、当前歌曲和界面状态互相不一致；切换按钮看似成功，实际继续播放旧内容。

解决方案：

1. 明确定义“切换歌单”的产品语义，建议默认采用：立即替换空闲歌单；如果当前是空闲歌单歌曲，则立即切到新歌单第一首；如果当前是用户点歌，则让用户歌曲播放完，之后从新歌单第一首开始。
2. 控制页只有成功拿到有效歌单后才发送 `loadSongList`。请求失败时不要更新 `songListId`，直接保留旧状态并显示失败原因。
3. 后端处理 `loadSongList` 时进行原子更新：同时更新 `songListId`、`idleSongList`、`idleIndex`、必要时的 `queue`、`currentSong` 和 `currentRequester`，不能只更新其中一部分。
4. 如果当前队首 `uid === 0`，应移除旧空闲歌曲，将新歌单第一首作为新的空闲队首，并设置新的 `currentSong`；如果当前是用户点歌，只清理队列中残留的旧空闲歌曲，不动用户点歌顺序。
5. 命令响应应返回明确字段，例如 `switched: true`、`startsImmediately: true/false`、`songListId` 和错误原因；控制页根据后端确认结果显示成功，不能在发送请求前就认定切换成功。
6. 删除无效的 `bilibili-ordersong-command` 监听，或者补齐唯一且不会重复触发的事件派发；不要同时让控制页和 OBS 各自重新拉取并随机打乱同一个歌单。
7. 洗牌应只执行一次。建议控制页提交原始列表，由后端完成洗牌并保存最终顺序，确保 OBS、控制页和重启恢复看到完全相同的队列。

建议的后端处理流程：

1. 校验 `listId` 和 `songList`，空列表直接返回失败，不修改现有状态。
2. 规范化并生成新空闲列表，设置 `idleIndex = -1`。
3. 从当前队列中移除所有 `uid === 0` 的旧空闲歌曲，保留用户点歌。
4. 如果当前正在播放用户点歌，只保存新列表，等待用户队列结束后调用 `appendNextIdleSong()`。
5. 如果当前为空闲歌曲或没有当前歌曲，立即 `appendNextIdleSong()`，同步更新 `currentSong`、`currentRequester` 和播放状态。
6. 一次性持久化完整状态并增加 revision，OBS 收到该命令后调用 `playCanonicalState()` 播放新的权威歌曲。

验收方式：

- 从歌单 A 切到歌单 B，当前为空闲歌曲时应立即开始 B 的歌曲，队列中不能残留 A 的空闲歌曲。
- 当前为用户点歌时切到 B，用户点歌不能被中断；用户队列结束后第一首空闲歌曲必须来自 B。
- B 获取失败或为空时，页面显示失败，`songListId`、当前歌曲和空闲列表全部保持 A。
- OBS 与控制页必须显示同一个歌单 ID、同一首当前歌曲和同一队列顺序。

## BUG-08：新增歌单可以切换，但从历史歌单下拉框选择旧歌单后无法正常回切

- 位置：`src/public/components/login-configer.js:89-102`、`src/public/components/login-configer.js:259-285`、`src/public/components/login-configer.js:288-355`、`src/public/main.js:187-213`、`src/routers/bili-router.js:169-181`
- 已知现象：手动输入一个新歌单 ID 并添加后，软件可以切换到新歌单；之后从历史歌单下拉框选中以前使用过的歌单，点击选择/加载却无法正常回切，仍显示或播放当前歌单。

可能同时参与该问题的现有逻辑：

1. 历史记录只保存 `platform`、`listId` 和作为名称使用的 ID，没有保存已验证的歌单快照。选择历史歌单时必须重新调用音乐 API 获取列表；Cookie、网络或接口失败时会得到空数组。
2. `loadSongList()` 即使获取结果为空，仍会先更新本地 `songListId`、历史记录并发送 `loadSongList` 命令。界面看起来已经选中旧 ID，但没有可供切换的新列表。
3. 后端收到空列表时不会替换 `idleSongList`，却会修改 `songListId`；收到有效列表时也只替换空闲列表，通常保留当前队列和 `currentSong`。因此回切旧歌单后仍继续播放切换前的歌曲。
4. `login-configer.js` 和 `main.js` 都会给加载歌单及历史选择按钮绑定处理函数。后加载的绑定会覆盖前一个；虽然当前调用目标接近，但维护中很容易形成两条参数处理不一致的入口。
5. 前端发送命令后没有等待并检查切换结果，也没有验证后端返回的 `songListId` 和 `idleSongList` 是否确实属于选中的历史歌单，因此失败时仍可能显示成功或被下一次状态同步覆盖。

影响：历史歌单功能只能记录 ID，无法可靠承担“快速切换”；界面选中值、后端歌单 ID、实际空闲列表及当前播放歌曲可能分别属于不同歌单。

解决方案：

1. 将所有歌单切换统一为一个入口，例如 `switchSongList(listId, source)`；手动输入新 ID和选择历史 ID必须走完全相同的请求、校验、提交和结果确认流程。
2. 删除 `main.js` 与 `login-configer.js` 之间重复的按钮绑定，只保留一个模块负责事件。历史选择按钮应读取当前选中 `option.value`，调用统一入口，并在请求期间禁用按钮避免重复提交。
3. 选择历史歌单后先请求音乐 API；只有响应是有效且非空的标准化歌曲数组时，才向后端提交切换。请求失败或空列表时不得修改当前 `songListId`、队列或历史选中状态。
4. `musicPlayer.sendCommand()` 返回 Promise，调用方必须 `await`。后端只有完整切换成功才返回 `switched: true`；前端收到确认后才更新输入框、历史选中项和成功提示。
5. 后端按 BUG-05 的原子切换规则处理历史歌单：清除旧空闲歌曲、安装目标歌单、重置 `idleIndex`，并根据当前是否为用户点歌决定立即播放目标歌单或等待用户队列结束。
6. 命令中增加唯一的 `requestId` 和明确的目标 `listId`；响应必须回传相同 `requestId`、最终 `songListId`、`stateRevision` 和是否立即切歌，防止较慢的旧请求覆盖较新的选择。
7. 在后端本地设置方案完成后，建议为每个历史歌单保存最近一次成功加载的元数据和可选快照，例如 `listId`、平台、名称、更新时间、歌曲数和标准化列表。回切时优先在线刷新；刷新失败可询问是否使用上一次成功快照，不能无提示地继续使用当前歌单。
8. 历史项必须使用复合键 `${platform}:${listId}`，切换前同步设置音乐平台，避免选择 QQ 历史歌单却继续调用网易云服务，或不同平台相同 ID 相互冲突。
9. 切换失败时恢复下拉框到当前权威歌单，显示具体原因，例如“歌单请求失败”“歌单为空”“登录失效”或“后端拒绝切换”，不要只显示笼统提示。

建议的统一切换流程：

1. 用户在历史下拉框选中目标项，读取其 `platform` 和 `listId`。
2. 记录当前后端权威歌单 ID，不提前修改页面状态。
3. 使用目标平台和当前有效登录态获取目标歌单，完成非空校验和歌曲标准化。
4. 向后端提交一次 `loadSongList`，携带 `requestId`、目标平台、目标 ID 和列表。
5. 后端原子更新完整房间状态并返回确认结果。
6. 前端只根据返回的权威状态更新输入框、历史选择、队列和提示；OBS 根据同一 revision 执行播放切换。
7. 任一步失败都保持原歌单不变，并允许用户重试。

验收方式：

- 添加歌单 A，再添加并切换到 B；从历史记录选择 A 后必须能够回切，再选择 B 也能再次切换。
- A 和 B 来自不同音乐平台时，回切会自动使用正确平台服务。
- 回切时目标歌单接口失败，当前歌单、当前歌曲和后端 `songListId` 必须保持不变，并显示真实失败原因。
- 快速连续选择 A、B、A 时，最终状态必须是最后一次选择的 A，较慢的旧请求不能覆盖它。
- 当前播放用户点歌时回切历史歌单，用户歌曲不中断；结束后第一首空闲歌曲来自目标历史歌单。
- 当前播放空闲歌曲时回切历史歌单，应按产品设定立即切到目标歌单，且队列不残留原歌单的空闲歌曲。

## BUG-06：服务重启后浏览器可能继续使用旧页面或旧脚本，但不能清掉网易云登录

- 位置：`app.js:35-37`、`src/public/index.html:9-19`、`src/public/main.js:1-5`、各模块 import 中的固定 `?v=...` 参数。
- 现象：静态资源由 `express.static` 使用默认缓存行为提供；HTML、主脚本和子模块又使用人工填写的固定版本号。修改代码并重启服务后，如果没有同步修改所有 `?v=` 参数，普通浏览器、OBS 浏览器源或直播姬 WebView 仍可能使用旧的 HTML、JavaScript 或 CSS，表现为“代码已经改了但功能还是旧的”。
- 额外限制：服务端无法直接命令浏览器删除全部缓存；浏览器的“清除站点数据”还会删除 `localStorage` 和 Cookie。网易云登录态当前保存在 `localStorage.wycookie`，如果使用全量清理，登录就会丢失。
- 影响：OBS 与控制页可能运行不同版本代码，进而出现状态结构不一致、修复不生效、旧事件逻辑继续执行等问题。

解决方案：

1. 只让浏览器重新验证或放弃 **HTTP 静态资源缓存**，绝对不要在启动时调用 `localStorage.clear()`、删除 `wycookie`、清除浏览器 Cookie 或清除全部站点数据。
2. 最简单可靠的本地运行方案：给 HTML、JavaScript、CSS 和 `webapi.js` 返回 `Cache-Control: no-store, no-cache, must-revalidate`，同时设置 `Pragma: no-cache` 和 `Expires: 0`。这样每次打开或刷新页面都会向当前 Node 服务重新获取文件，网易云 `localStorage` 不受影响。
3. 如果不希望每次请求都禁用缓存，可以在 Node 进程启动时生成唯一 `BUILD_ID`，例如 `${Date.now()}-${process.pid}`；HTML 引用所有入口资源时带上本次启动 ID。子模块 import 也必须由构建工具统一添加内容哈希或版本号，不能继续手工维护多个固定 `?v=`。
4. 推荐本项目优先采用 `no-store`，因为它是本机小型服务，资源很少，性能损失可以忽略，却能避开 OBS/WebView 缓存行为差异。以后部署公网时再改为“HTML 不缓存 + 带内容哈希的 JS/CSS 长缓存”。
5. 对静态中间件设置响应头时要覆盖整个 `BASE_PATH` 下的页面、脚本、样式和运行时 `webapi.js`；仅给 `index.html` 加 no-cache 不够，因为浏览器仍可能复用旧子模块。
6. 启动器打开链接时可以附加本次启动参数，例如 `?server_version=<BUILD_ID>`，作为 WebView 的额外缓存穿透措施；但它不能代替正确的响应缓存头。
7. OBS 浏览器源若长期不刷新，服务重启本身不会强制已经打开的页面自动重载。可增加轻量版本接口，例如 `/live/health` 返回 `buildId`；前端发现 `buildId` 变化后保存必要的当前界面状态并执行一次 `location.reload()`。必须加防循环标记，避免服务抖动时持续刷新。

推荐实现结构：

1. Node 进程启动时创建 `BUILD_ID`，并由 `/live/health` 返回。
2. `express.static` 的 `setHeaders` 给 `.html`、`.js`、`.css` 和运行时配置文件设置 `no-store`。
3. 前端首次健康检查记住 `buildId`；后续检查发现变化时只执行页面 reload。
4. reload 前后均不删除任何 `localStorage` 数据，因此 `wycookie`、歌单历史和显示设置都会保留。
5. 如果确实需要迁移或删除某些旧缓存字段，应按字段名做版本化迁移，禁止使用 `localStorage.clear()`。

验收方式：

- 登录网易云后记录登录状态，修改任意前端脚本文案并重启服务；普通浏览器、OBS 和直播姬页面刷新后都应立即出现新版本。
- 服务重启或页面自动 reload 后，`localStorage.wycookie` 仍存在，网易云仍保持登录。
- 连续重启两次服务时，每次只自动刷新一次，不出现刷新循环。
- 控制页和 OBS 页从健康接口读到同一个 `buildId`，且实际加载的脚本版本一致。

## BUG-07：设置主要保存在浏览器中，应迁移到服务端本地文件，并允许关闭服务时选择清理运行缓存

### 当前存储情况

当前不是所有数据都在同一个位置，而是三套来源混用：

- 浏览器 `localStorage`：点歌数量限制、歌曲时长限制、黑名单、历史记录、歌单 ID、歌单历史、音量、显示主题、自定义 CSS、网易云 `wycookie` 等。
- 服务端本地文件：房间队列、当前歌曲、空闲歌单和命令记录保存在 `logs/order-sync/*.json`。
- Node 进程内存：共享网易云 Cookie 还会放在 `sharedRuntimeCredentials`，服务重启后这份内存数据消失，再由浏览器重新上传。

这会导致控制页、OBS、直播姬使用各自独立的浏览器存储；同一个设置在不同页面可能有不同版本。浏览器缓存、换浏览器、清理站点数据或 WebView 重建后，也容易出现设置丢失或旧值重新覆盖服务端的问题。

### 目标存储模型

将 **Node 服务所在电脑的文件系统** 作为设置和状态的唯一来源，浏览器只负责显示和提交修改，不再把 `localStorage` 当权威数据源。建议按用途拆分目录：

```text
data/
  settings/
    global.json              # 全局显示、点歌规则、默认音量等
    rooms/<roomId>.json      # 房间专属歌单、管理员、房间覆盖项
  history/
    order-history.json       # 用户/歌曲历史及黑名单（也可按房间拆分）
  credentials/
    netease-cookie.dat       # 网易云登录态，持久保留且不参与缓存清理

cache/
  order-sync/                # 当前队列、播放租约、命令日志等可清理运行数据

logs/                        # 普通运行日志，可单独选择是否清理
```

`config/config.yaml` 和 `config/webapi.js` 仍属于人工配置文件，不应被“清理缓存”删除。

### 设置本地化的实现方案

1. 新建统一存储模块，例如 `src/services/local-store.js`，所有 JSON 读写只经过该模块。
2. 写文件采用“同目录临时文件 + rename”原子替换；保存前按 schema 校验，损坏文件应备份为 `.corrupt-时间戳`，然后使用默认值，不能静默覆盖。
3. 文件中加入 `schemaVersion` 和 `updatedAt`，以后字段变化通过迁移函数升级，避免新旧代码读取同一文件时结构错乱。
4. 设置分为全局项和房间项：
   - 全局项：点歌上限、时长限制、黑名单、显示主题、自定义 CSS、默认音量等。
   - 房间项：`songListId`、管理员 UID、房间专属覆盖设置等。
   - 队列、当前歌曲、租约和短期命令属于运行缓存，不放进永久设置文件。
5. 增加设置 API，例如 `GET /live/settings` 和 `PUT /live/settings`。页面启动时先读取服务端设置；用户修改后提交服务端，服务端保存成功后返回带 revision 的完整权威设置。
6. OBS 和控制页都订阅/轮询同一份服务端设置 revision，不再互相复制浏览器 `localStorage`。服务端拒绝旧 revision 覆盖新 revision。
7. 前端可以保留少量仅用于页面启动体验的内存副本，但不能再用它覆盖服务端；正常运行后逐步移除设置相关的 `localStorage.setItem()`。
8. 首次升级时做一次迁移：如果服务端尚无设置文件，控制页读取旧 `localStorage` 中允许迁移的设置并上传；服务端写入成功后记录 `browserStorageMigrated: true`。之后页面不能再次用旧浏览器值初始化服务端。
9. 迁移白名单只包含普通设置，绝不能把任意 `localStorage` 内容整体上传。`wycookie` 使用单独的凭据流程处理。

### 网易云登录状态的保存方案

清理运行缓存时必须保留网易云登录。推荐把凭据和普通设置、运行缓存完全分开：

1. 网易云 Cookie 保存到 `data/credentials/netease-cookie.dat`，此目录永远不包含在默认缓存清理范围内。
2. Windows 环境优先使用当前 Windows 用户的 DPAPI 加密后落盘，避免明文 Cookie 直接保存在 JSON 中；只有启动服务的同一 Windows 用户可以解密。
3. 凭据 API 只返回 `hasNeteaseCookie`、登录昵称和登录状态，不再把完整 Cookie 返回给浏览器。网易云请求尽量由服务端携带 Cookie 完成。
4. 用户主动点击“退出网易云登录”时才删除该凭据文件；停止服务、清理队列、清理日志、刷新页面都不能删除它。
5. 迁移阶段可以从现有 `localStorage.wycookie` 上传一次到受保护的服务端凭据接口；确认服务端成功保存并验证登录后，再逐步停止依赖浏览器中的 Cookie。
6. 如果暂时不实施 DPAPI，最低限度也应让凭据文件位于 Git 忽略目录、限制文件权限，并明确禁止日志输出 Cookie。不能把 Cookie 写入 `settings.json`、`logs` 或 `order-sync`。

### 关闭服务脚本的可选清理方案

扩展 `scripts/stop-project.ps1` 和 `清理点歌台进程.bat`，在进程完全停止后询问：

```text
是否清理本地运行缓存？
[1] 不清理（默认）
[2] 清理队列、播放状态和命令缓存
[3] 在 2 的基础上同时清理普通日志
```

具体规则：

1. 默认选择“不清理”，直接按回车也不得删除任何数据。
2. 选项 2 只删除已经验证位于项目目录内的 `cache/order-sync` 内容；清除后下次启动从空队列开始。
3. 选项 3 额外清理 `logs` 中的普通日志，但仍保留设置和凭据。
4. 以下内容无论选择哪个清理选项都必须保留：
   - `data/settings`
   - `data/history`（除非未来增加单独且明确的“清除历史”选项）
   - `data/credentials/netease-cookie.dat`
   - `config/config.yaml`
   - `config/webapi.js`
5. 删除前必须先解析绝对路径并确认目标严格位于项目的 `cache` 或 `logs` 目录，禁止对项目根目录、变量为空的路径或通配计算结果执行递归删除。
6. 脚本应同时支持非交互参数，例如 `-ClearRuntimeCache` 和 `-ClearLogs`；没有参数时才显示选择菜单，方便以后自动化调用。
7. 清理完成后输出实际删除了哪些目录，并明确显示“网易云登录状态已保留”。

注意：关闭脚本只能清理服务端文件，不能可靠删除 OBS 或其他浏览器内部的 HTTP 缓存。浏览器资源缓存仍应由 BUG-06 的 `Cache-Control: no-store` 和 `buildId` 自动刷新方案解决；不要尝试通过删除浏览器配置目录来处理，否则会同时删除网易云登录和其他站点数据。

### 与现有功能的迁移顺序

1. 先建立 `local-store`、目录边界、schema、原子写入和测试。
2. 将普通设置迁移到 `data/settings`，页面改为服务端读取/保存。
3. 将运行状态从 `logs/order-sync` 移到 `cache/order-sync`，保持现有状态同步接口兼容。
4. 将网易云 Cookie 迁移到受保护的 `data/credentials`，确认重启后仍能登录。
5. 最后移除设置相关的 `localStorage` 权威逻辑，只保留一次性迁移代码。
6. 增加关闭脚本选择菜单和安全路径检查。

验收方式：

- 在控制页修改设置后，换一个浏览器或重新创建 OBS 浏览器源，读取到的设置完全一致。
- 清空浏览器普通站点数据后，重新打开页面仍能从服务端恢复所有非凭据设置。
- 服务重启后设置、黑名单、歌单 ID 和网易云登录仍存在。
- 关闭服务时选择“清理运行缓存”，再次启动后队列和当前播放为空，但设置、历史和网易云登录仍存在。
- 选择清理日志也不能删除 `data/settings`、`data/history`、`data/credentials` 或 `config`。
- 用户主动退出网易云登录后，凭据文件才被删除，下一次启动显示未登录。

## 建议处理顺序

1. BUG-05：歌单无法正常切换。
2. BUG-08：历史歌单选中后无法正常回切。
3. BUG-04：不可播放歌曲卡住队列。
4. BUG-03：空队列切歌异常。
5. BUG-02：设置同步到 OBS。
6. BUG-07：将浏览器设置迁移到服务端本地文件，并提供安全的缓存清理选项。
7. BUG-06：服务重启后加载到旧浏览器缓存。
8. BUG-01：统一端口和外部 API 配置。
