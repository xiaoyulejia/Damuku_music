# Damuku_music 手动置顶 / 下一首插播功能实现方案

更新时间：2026-08-12

本文只描述实现方案，不修改业务代码。

功能目标：主播在设置页查看当前点歌队列，既可以点击“设为下一首”，也可以像拖拽栏一样自由调整全部待播歌曲的顺序。当前歌曲固定不动，所有排序操作都不打断当前播放。

## 一、先明确“插播”的语义

首版建议只实现一种明确行为：

> **设为下一首：保持当前歌曲继续播放，把目标歌曲移动到队列第 2 位。**

当前服务端队列的约定是：

```text
queue[0] = 当前正在播放或即将播放的歌曲
queue[1] = 下一首
queue[2...] = 后续歌曲
```

例如：

```text
操作前：A（当前） → B → C → D
选择 D 设为下一首
操作后：A（当前） → D → B → C
```

不建议首版把以下行为也混进“插播”按钮：

- 立即中断当前歌曲并播放目标歌曲。
- 复制目标歌曲再插入一份。
- 修改空闲歌单原始顺序。
- 绕过点歌黑名单或歌曲合法性检查，新增一首不在队列中的歌曲。

如果以后需要“立即播放”，应做成独立的高风险按钮，并二次确认；不能与“设为下一首”共用语义。

## 二、页面效果

设置页增加一个“队列管理”区域：

```text
当前播放
  1. A歌曲 - 歌手甲 - 用户甲

待播队列
  ○ 2. B歌曲 - 歌手乙 - 用户乙
  ● 3. C歌曲 - 歌手丙 - 用户丙
  ○ 4. D歌曲 - 歌手丁 - 用户丁

  [设为下一首]  [刷新队列]
```

推荐交互：

1. 当前歌曲单独显示，不允许选择，避免用户误以为可以把正在播放的歌“置顶”。
2. 只允许选择 `queue[1...]` 中的待播歌曲。
3. 已经位于 `queue[1]` 的歌曲显示“已是下一首”，按钮禁用。
4. 点击后按钮进入“处理中”，禁止重复提交。
5. 后端成功后立即用返回的权威队列刷新列表，并提示“已将《歌曲名》设为下一首”。
6. 后端返回冲突时自动刷新队列，提示“队列已变化，请重新选择”。
7. 设置页每 1 秒读取房间状态，或订阅后端状态更新；不能只读取页面打开时的队列。

可以为队列行增加操作按钮，让操作更直接：

```text
B歌曲   用户乙   [下一首]
C歌曲   用户丙   [下一首]
D歌曲   用户丁   [下一首]
```

但在窄屏设置页中，单选列表加统一按钮更容易避免误点。

## 三、必须给每个点歌项增加稳定 `orderId`

不能只用数组下标、歌曲 `sid` 或 `${platform}:${sid}` 识别要移动的队列项：

- 数组下标会在切歌、点歌和其他置顶操作后变化。
- 同一歌曲以后可能允许由不同用户再次点播。
- `sid` 在不同平台可能相同。
- 歌曲键可以识别歌曲，但不能唯一识别“这一次点歌”。

建议每个队列项统一增加：

```js
{
    orderId: 'ord-1786500000000-x7k3m2',
    uid: 123456,
    uname: '用户甲',
    song: {
        platform: 'wy',
        sid: '12345',
        sname: '歌曲名',
        sartist: '歌手'
    },
    requestedAt: 1786500000000,
    source: 'danmu' // danmu | idle | manual
}
```

实现要求：

1. `addOrder` 在后端接受点歌时生成 `orderId`，不信任客户端自带 ID。
2. 空闲歌单歌曲进入播放队列时也生成新的 `orderId`。
3. `normalizeOrder()` 必须保留合法的现有 `orderId`，但新入队时由后端覆盖生成。
4. 服务重启恢复状态后 `orderId` 不变。
5. 老状态文件中没有 `orderId` 的项目，在读取/迁移时补生成一次并持久化。

如果暂时不增加 `orderId`，可以用 `platform + sid + uid + requestedAt` 作为过渡键，但不建议作为最终实现。

## 四、后端命令设计

在房间命令白名单中增加：

```text
promoteNext
```

控制页发送：

```js
musicPlayer.sendCommand('promoteNext', {
    orderId: 'ord-1786500000000-x7k3m2',
    expectedRevision: 87,
    expectedCurrentOrderId: 'ord-current-song'
});
```

字段含义：

- `orderId`：要提升的目标队列项。
- `expectedRevision`：设置页选择歌曲时看到的房间 `stateRevision`。
- `expectedCurrentOrderId`：选择时的当前歌曲，用于防止操作提交前恰好发生切歌。

后端成功响应建议：

```js
{
    code: 0,
    data: canonicalState,
    result: {
        accepted: true,
        command: 'promoteNext',
        moved: true,
        orderId: 'ord-...',
        fromIndex: 3,
        toIndex: 1,
        stateRevision: 88
    }
}
```

如果目标本来就是下一首：

```js
{
    accepted: true,
    moved: false,
    reason: 'already-next'
}
```

这应视为幂等成功，不需要再次改变 revision。

## 五、后端原子调整队列算法

在 `applyRoomCommand()` 中增加 `promoteNext` 分支。核心逻辑必须全部在服务端完成：

```js
function promoteNext(state, value) {
    const targetIndex = state.queue.findIndex(
        item => item.orderId === value.orderId
    );

    if (targetIndex < 0) {
        return { accepted: false, reason: 'order-not-found' };
    }

    const hasCurrent = Boolean(state.currentSong && state.queue[0]);
    const nextIndex = hasCurrent ? 1 : 0;

    if (targetIndex === 0 && hasCurrent) {
        return { accepted: false, reason: 'already-playing' };
    }

    if (targetIndex === nextIndex) {
        return { accepted: true, moved: false, reason: 'already-next' };
    }

    const [target] = state.queue.splice(targetIndex, 1);
    state.queue.splice(nextIndex, 0, target);

    return {
        accepted: true,
        moved: true,
        fromIndex: targetIndex,
        toIndex: nextIndex
    };
}
```

真正实现时还需处理以下规则：

1. 先校验 `expectedRevision` 和当前 `stateRevision`；不一致时返回 409，不进行移动。
2. 校验 `expectedCurrentOrderId`；当前歌曲已变化时返回冲突，避免把目标放到错误位置。
3. 目标必须仍在 `queue` 中，已经播放完或被删除时返回 404/409。
4. 只改变队列顺序，不修改 `currentSong`、`currentRequester`、`audio.src`、播放状态和音频位置。
5. 成功移动后只持久化一次，并且只增加一次 `stateRevision`。
6. 命令日志只保存轻量结果，不嵌入完整歌单状态。
7. 未发生移动的幂等请求可以不增加 revision，避免重复点击制造无意义状态更新。

## 六、用户点歌与空闲歌单的处理规则

当前队列可能同时存在用户点歌和 `uid === 0` 的空闲歌单歌曲，需要明确规则。

### 6.1 推荐首版规则

- 设置页默认只允许提升用户点歌，即 `uid !== 0`。
- 当前是空闲歌曲时，目标用户歌曲移动到 `queue[1]`，当前空闲歌曲播完后立即播放目标。
- 当前是用户歌曲时，目标歌曲同样移动到 `queue[1]`，不影响当前用户歌曲。
- 不允许提升空闲歌单歌曲，因为空闲歌曲本来就由歌单循环逻辑管理，手动提升容易让 `idleIndex` 和队列顺序语义混乱。

### 6.2 如果需要允许空闲歌曲插播

必须额外定义：

- 移动的是已进入 `queue` 的这一个空闲项目，还是从 `idleSongList` 新建一项。
- 播放后 `idleIndex` 是否随之更新。
- 如何避免该歌曲稍后按原索引再次播放。

为降低复杂度，建议首版不开放空闲歌曲置顶。

## 七、设置页实现

### 7.1 HTML

在设置菜单新增“队列管理”页，或在点歌设置页增加：

```html
<section class="queueManager">
    <div class="queueManagerCurrent">
        当前：<strong id="queueManagerCurrentSong">暂无歌曲</strong>
    </div>

    <select id="queueManagerList" size="10"></select>

    <div class="queueManagerActions">
        <button id="promoteNextButton" type="button">设为下一首</button>
        <button id="refreshQueueButton" type="button">刷新队列</button>
    </div>

    <p id="queueManagerStatus" role="status"></p>
</section>
```

每个 option：

```js
option.value = order.orderId;
option.textContent = `${index + 1}. ${songName} - ${artist}（${requester}）`;
```

必须使用 `textContent`，不能把用户名或歌曲名直接拼进 `innerHTML`。

### 7.2 新建独立组件

建议新增：

```text
src/public/components/queue-manager.js
```

职责：

- 从 `musicPlayer` 收到的权威房间状态渲染队列。
- 保存当前渲染使用的 `stateRevision` 和 `currentOrderId`。
- 发送 `promoteNext` 命令。
- 处理加载、成功、冲突和错误状态。
- 不直接修改 `musicPlayer.orderList`，避免先出现假顺序再被服务端覆盖。

`MusicPlayer.applySharedState()` 完成后可派发：

```js
window.dispatchEvent(new CustomEvent('damuku-room-state', {
    detail: state
}));
```

`QueueManager` 监听该事件。这样无需让组件读取播放器私有字段，也可以在未来独立设置页中复用。

### 7.3 提交逻辑

```js
async promoteSelected() {
    const orderId = this.list.value;
    if (!orderId) return;

    this.setBusy(true);
    const response = await musicPlayer.sendCommand('promoteNext', {
        orderId,
        expectedRevision: this.stateRevision,
        expectedCurrentOrderId: this.currentOrderId
    });

    // 只使用后端返回的权威状态更新页面
}
```

发送期间禁用按钮。无论成功或失败都不能直接执行本地数组 `splice()`。

## 八、OBS 播放端如何处理

`promoteNext` 只调整下一首，不应触发当前音频重载。

当前 `MusicPlayer.handleCommand()` 对 `next`、`addOrder`、`loadSongList` 等命令调用 `playCanonicalState()`。新增命令时建议：

```js
if (message.command === 'promoteNext') {
    this.applySharedState(message.state);
    // 不调用 playCanonicalState，不碰 audio
}
```

注意：

- OBS 只订阅或轮询服务端已经保存成功的权威队列，并在 `queueRevision` 变化后刷新点歌列表顺序。
- 当前歌曲名、音频 URL和 `audio.currentTime` 保持不变。
- 当前歌曲自然结束时，现有 `next` 命令移除 `queue[0]`，置顶目标会成为新的 `queue[0]` 并播放。
- 控制页、OBS 队列 Bar 和设置页都从同一 revision 看到新顺序。
- 拖拽只属于控制页面（包括控制页内的队列管理区域）：OBS 播放页和 OBS 队列 Bar 不渲染拖动手柄、置顶按钮、保存按钮或撤销按钮。
- OBS 不加载 Sortable、不维护排序草稿，也不能发送 `promoteNext` 或 `reorderQueue`；它只按控制页保存到服务端后的顺序进行只读展示和后续播放。

## 九、并发和竞态处理

插播最容易遇到的是“点击时队列已经变化”。必须覆盖以下场景：

### 9.1 点击插播时恰好自动切歌

设置页看到 A 为当前、选择 D；提交前 A 播完，B 已成为当前。

处理方式：`expectedCurrentOrderId` 不一致，后端返回 409。设置页刷新后让用户重新确认，不能擅自把 D 放到 B 后面。

### 9.2 两个控制页同时插播

控制页 1 把 D 置顶，控制页 2 仍基于旧 revision 把 C 置顶。

处理方式：第一个成功并增加 revision；第二个因 `expectedRevision` 过期返回 409。刷新后可以再次操作。

### 9.3 重复点击同一首

第一个请求已把 D 放在 `queue[1]`，第二个请求稍后到达。

处理方式：识别为 `already-next`，幂等成功，不重复修改。

### 9.4 目标歌曲已被播放或删除

后端找不到 `orderId`，返回明确错误；设置页刷新并清除旧选择。

## 十、权限与安全

这是队列管理操作，不应该对普通观众开放：

1. `promoteNext` 只允许控制/设置权限令牌调用。
2. OBS 只读 overlay 不允许发送该命令。
3. `roomid` 不能作为权限凭证。
4. 后端必须校验命令白名单和 value schema。
5. 增加操作审计信息：时间、目标 `orderId`、原位置、目标位置和控制端 ID；不要记录 Cookie。
6. 请求做速率限制，例如同一房间每秒最多 2 次队列管理操作。

该功能应与 `bug.md` 中控制接口授权方案一起落地；否则任何能访问本机接口的页面都能篡改队列顺序。

## 十一、状态结构建议

可给队列状态增加轻量管理信息：

```js
{
    queueRevision: 42,
    lastQueueAction: {
        type: 'promoteNext',
        orderId: 'ord-...',
        fromIndex: 4,
        toIndex: 1,
        at: 1786500000000
    }
}
```

如果继续使用统一 `stateRevision` 也可以，不一定要新增 `queueRevision`。但单独的队列版本能减少音量、播放遥测等无关状态更新导致的插播冲突。

推荐：

- `stateRevision`：整个房间状态版本。
- `queueRevision`：仅在入队、切歌、歌单切换、删除和置顶时增加。
- 插播请求校验 `queueRevision + currentOrderId`，比校验每秒变化的全局状态更稳定。

## 十二、与后续功能的兼容

### 独立 OBS 队列 Bar

`overlay/queue.html` 只需要按服务端 queue 顺序重绘，置顶后自动显示新顺序，不承担操作入口。

### 歌词 Bar

插播不改变当前歌曲，因此歌词继续显示当前歌曲；等自然切换到插播歌曲时再加载新歌词。

### 播放进度条

插播不改变当前 `audio.currentTime`，进度条不重置。只有真正切到插播歌曲时才归零。

### 歌单切换

歌单切换可能整体重建空闲歌曲。两者并发时以 `queueRevision` 解决冲突；插播请求不得在旧歌单队列上静默成功。

### 服务重启恢复

置顶后的队列顺序已经写入房间状态，服务重启后应保持该顺序；无需单独保存“插播任务”。

## 十三、拖拽自由排序方案

可以直接把拖拽排序纳入首版。推荐规则如下：

- 当前歌曲固定在顶部，不可拖动。
- `queue[1...]` 的全部待播歌曲可以任意上下拖拽。
- 拖拽只改变待播顺序，不暂停、不切换、不重载当前音频。
- 松开鼠标或触控后只提交一次完整顺序。
- 后端验证成功后原子替换队列；验证失败则恢复为服务端权威顺序。

### 13.1 页面结构

只有控制页面/设置页面使用可拖拽列表，而不是 `<select>`：

```html
<section class="queueManager">
    <article class="queueCurrent" data-locked="true">
        <span class="queuePosition">正在播放</span>
        <strong id="queueCurrentSong"></strong>
    </article>

    <ol id="sortableQueue" class="sortableQueue"></ol>

    <div class="queueManagerActions">
        <button id="saveQueueOrder" type="button" disabled>保存顺序</button>
        <button id="cancelQueueOrder" type="button" disabled>撤销修改</button>
        <button id="refreshQueue" type="button">刷新</button>
    </div>
</section>
```

每个待播项目：

```html
<li class="sortableQueueItem" data-order-id="ord-...">
    <button class="dragHandle" type="button" aria-label="拖动歌曲">☰</button>
    <span class="queuePosition">下一首</span>
    <span class="queueSongName">歌曲名</span>
    <span class="queueArtist">歌手</span>
    <span class="queueRequester">点歌人</span>
    <button class="promoteButton" type="button">设为下一首</button>
</li>
```

`data-order-id` 只保存不可变 `orderId`。歌曲名、歌手和用户名必须通过 `textContent` 渲染。

页面角色必须明确区分：

- 控制页面（包括从控制页打开的队列设置区域）：渲染 `.dragHandle`、“设为下一首”、“保存顺序”和“撤销修改”。
- OBS 播放页面：不创建 Sortable 实例，不绑定拖拽事件，不显示任何拖动手柄或管理按钮。
- 独立 `overlay/queue.html`：纯只读队列，只显示歌曲顺序、歌手和点歌人。
- 普通监控/预览页面默认只读；除非明确持有控制权限，否则也不显示拖动入口。

不能只依靠 CSS `display: none` 隐藏 OBS 的拖动按钮。页面脚本也必须按角色跳过 `QueueManager` 的编辑模式和 `reorderQueue` 发送逻辑，避免通过 DOM 或键盘意外触发管理命令。

### 13.2 拖拽技术选择

有两种方案：

1. 使用原生 Pointer Events 自己实现拖拽。
2. 使用成熟的轻量排序库，例如 SortableJS，并将版本固定、本地提供资源。

推荐使用本地固定版本的 SortableJS，因为它能同时处理鼠标、触摸屏、拖动占位、自动滚动和动画。不要从未固定版本的公网 CDN 加载，否则离线或 CDN 变化会导致设置页无法排序。

如果不想新增依赖，原生实现至少需要处理：

- `pointerdown / pointermove / pointerup / pointercancel`。
- `setPointerCapture()`，避免鼠标移出列表后丢失拖动。
- 计算目标行中点并移动占位元素。
- 页面边缘自动滚动。
- Escape 取消拖动。
- 触屏滚动与拖动手柄冲突。
- 页面失焦后的清理。

不建议只使用旧 HTML5 `dragstart/dragover/drop` API，因为在触摸屏和部分内置 WebView 中行为不稳定。

### 13.3 前端本地草稿

拖动过程中只能修改设置页里的“排序草稿”，不能立即修改 `musicPlayer.orderList`：

```js
originalOrderIds = ['ord-b', 'ord-c', 'ord-d'];
draftOrderIds = ['ord-d', 'ord-b', 'ord-c'];
```

拖动结束后：

- 更新行号与“下一首”标签。
- `draftOrderIds` 与 `originalOrderIds` 不同时启用“保存顺序”和“撤销修改”。
- 默认推荐用户点击“保存顺序”后提交，避免每次小拖动都写服务端。
- 也可以提供“拖动后自动保存”开关，但必须做 300-500ms 防抖，并确保同一时刻只有一个请求在途。

建议首版采用显式保存按钮，行为更容易理解和恢复。

草稿和 OBS 的边界必须固定：

- `draftOrderIds` 只存在于发起拖动的控制页面，尚未保存时 OBS 继续显示旧的服务端权威顺序。
- 不通过 `BroadcastChannel`、`localStorage` 事件或 `musicPlayer.applySharedState()` 把本地草稿提前同步给 OBS。
- 只有后端成功执行 `reorderQueue`、持久化队列并生成新的 `queueRevision` 后，控制页和 OBS 才一起刷新为新顺序。
- 保存失败或 revision 冲突时，控制页丢弃或重建草稿并显示提示；OBS 始终保持原权威顺序，不应先变化再回滚或出现闪烁。

### 13.4 后端 `reorderQueue` 命令

增加命令：

```js
musicPlayer.sendCommand('reorderQueue', {
    expectedQueueRevision: 42,
    expectedCurrentOrderId: 'ord-current',
    pendingOrderIds: [
        'ord-d',
        'ord-b',
        'ord-c'
    ]
});
```

`pendingOrderIds` 只包含待播歌曲，不包含当前 `queue[0]`。

后端必须执行集合校验：

1. 当前歌曲 `orderId` 必须等于 `expectedCurrentOrderId`。
2. 当前 `queueRevision` 必须等于 `expectedQueueRevision`。
3. `pendingOrderIds` 长度必须等于当前待播队列长度。
4. 每个 ID 必须存在且只能出现一次。
5. 新旧 ID 集合必须完全一致，不能缺歌、加歌或重复歌曲。
6. 首版若禁止调整空闲歌曲，则 `pendingOrderIds` 中只允许用户点歌；或者后端将不可移动项固定后再校验可移动子序列。
7. 请求设置最大队列数量和请求体大小，防止异常客户端提交巨大数组。

验证通过后一次性生成：

```js
state.queue = [currentOrder, ...orderedPendingItems];
```

然后只持久化一次、`queueRevision` 加一，并返回完整权威队列。

### 13.5 为什么不能逐行发送 move 命令

例如用户把第 10 首拖到第 2 首，如果前端连续发送多个“上移一位”：

- 中途可能恰好自动切歌或加入新歌曲。
- 请求到达顺序可能变化。
- OBS 会看到多次闪动顺序。
- 任一请求失败都会留下半完成状态。

因此一次拖拽保存必须对应一次 `reorderQueue` 原子操作。

### 13.6 新点歌同时到达时的策略

用户拖动期间可能有新弹幕点歌加入队尾。推荐严格冲突策略：

- 新点歌使 `queueRevision` 增加。
- 保存旧草稿时后端返回 409，不覆盖新队列。
- 设置页重新获取队列，并提示“队列已加入新歌曲，请重新确认排序”。

不要自动把未知的新歌附到草稿末尾并静默保存，因为用户看到的列表与实际提交内容不同。

后续可以实现智能合并：保留用户已排序项目的相对顺序，把新到歌曲追加队尾。但首版使用冲突刷新更安全。

### 13.7 切歌发生时的策略

拖动期间当前歌曲播放结束：

- `expectedCurrentOrderId` 不一致。
- 后端拒绝旧排序。
- 前端取消草稿，重新显示新的当前歌曲和待播队列。

绝不能把旧草稿的第一首覆盖成新的当前歌曲，也不能让已经开始播放的歌曲又回到待播队列。

### 13.8 键盘与无障碍操作

拖拽不能是唯一操作方式。每行建议同时提供：

- “设为下一首”。
- “上移一位”。
- “下移一位”。
- 键盘抓取模式：Space 选中，方向键移动，Enter 保存，Escape 取消。

使用 `aria-live` 宣布“《歌曲名》已移动到第 3 位”。这样键盘用户和拖拽不稳定的直播姬 WebView 仍能管理队列。

### 13.9 样式与反馈

- 拖动行增加 `.is-dragging`，降低透明度并显示阴影。
- 插入位置使用明显占位条。
- 当前歌曲使用锁图标和不同背景。
- `queue[1]` 始终显示“下一首”标签。
- 未保存草稿显示“顺序尚未保存”。
- 保存时锁定列表；成功后绿色提示，冲突时恢复权威队列并显示黄色提示。
- OBS 队列 Bar 只在保存成功后改变，不展示设置页尚未保存的草稿。

建议控制页与 OBS 使用两套独立的只读/可编辑模板，而不是共用模板后仅用 CSS 隐藏按钮：

```text
控制页：.queueManager .sortableQueueItem .dragHandle
OBS：   .queueOverlay .queueOverlayItem
```

这样 OBS DOM 中从一开始就不存在拖动手柄和管理按钮，也不会留下空白占位、可聚焦控件或残余拖拽事件。

## 十四、其他可选的第二阶段功能

拖拽排序稳定后还可以增加：

- 移出队列。
- 锁定下一首，防止其他控制页再次置顶。
- 插播原因备注，例如“主播指定”“活动歌曲”。
- 立即播放，并要求二次确认。

## 十五、最小测试清单

### 正常流程

- `A → B → C → D`，提升 D 后变为 `A → D → B → C`。
- 当前歌曲 A 的音频不重载、播放位置不归零。
- A 结束后下一首确实播放 D。
- 提升已经是下一首的 D，返回幂等成功且 revision 不变。
- 拖动后一次保存可得到任意指定的待播顺序。
- 拖动草稿未保存时，OBS 和其他控制页的队列不变化。
- 点击撤销后恢复最近一次服务端权威顺序。

### 队列边界

- 队列为空时按钮禁用。
- 只有当前歌曲、没有待播歌曲时按钮禁用。
- 目标是当前歌曲时后端拒绝。
- 目标不存在时返回明确错误。
- 当前为空闲歌曲、目标是用户歌曲时能正确移动到下一首。
- 首版选择空闲歌曲时按钮禁用，后端也拒绝绕过前端的请求。

### 并发

- 选择后发生切歌，旧请求返回冲突且不移动任何歌曲。
- 两个控制页同时置顶，只有基于最新 queue revision 的请求成功。
- 快速重复点击只执行一次有效移动。
- 插播与新点歌同时发生时不丢歌、不复制歌曲。
- 插播与切换歌单同时发生时，过期操作不覆盖新歌单队列。
- 拖动期间加入新点歌，保存旧草稿返回冲突且不丢失新歌。
- 拖动期间发生自动切歌，旧排序被拒绝，当前歌曲不会回到待播列表。
- 提交的 ID 缺失、重复、额外增加或属于其他房间时全部被拒绝。

### 同步与恢复

- 设置页、控制页、OBS 播放页和独立队列 Bar 显示相同顺序。
- 只有控制页待播放列表能看到并操作拖动手柄；OBS 播放页和独立队列 Bar 的 DOM 中不存在拖动手柄及任何排序按钮。
- 控制页拖动但尚未保存时，OBS 顺序保持不变。
- 保存成功且 `queueRevision` 更新后，OBS 只刷新一次并显示新顺序。
- 保存冲突或失败时，OBS 不出现临时新顺序、回滚闪烁或重复刷新。
- 服务重启后保持置顶后的顺序。
- 清理运行缓存后队列按设计清空，不残留无目标的插播命令。

### 权限

- 普通只读页面不能调用插播命令。
- 缺少令牌、错误房间权限、非法 `orderId` 和未知字段均被拒绝。
- 操作日志不包含网易云 Cookie 或完整房间状态。

## 十六、推荐实施顺序

1. 给队列项增加并迁移稳定 `orderId`。
2. 增加 `queueRevision`，梳理所有会改变队列的命令。
3. 后端实现并测试 `promoteNext` 原子命令。
4. 后端实现并测试 `reorderQueue` 的集合校验和原子替换。
5. `MusicPlayer` 支持接收排序变化但不重载当前音频。
6. 新增 `queue-manager.js`、设置页拖拽列表、保存和撤销功能。
7. 增加键盘上移/下移作为拖拽替代操作。
8. 加入控制权限、冲突提示和操作审计。
9. 完成多控制页、新点歌、切歌、歌单切换和服务重启测试。

首版可以同时实现“设为下一首”和“自由拖拽待播队列”。暂不实现立即打断播放、空闲歌单原始列表重排和跨房间拖动，可以控制复杂度并避免影响当前音频。
