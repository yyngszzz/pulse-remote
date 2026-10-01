# Pulse

**在手机上遥控电脑上的 DeepSeek Harness。**

不是投屏，也不是阉割版：手机加载的是**官方 Web GUI 本体**，所以电脑上能做的手机上都能做——看会话、读对话、看文件改动、派活、回答审批。Pulse 另外加了两样东西：一个「不在场」时够用的压缩活动流，和一个一按就能决策的待办队列。

```
手机浏览器 → http://<电脑IP>:3199
             │
             ├── 未配对：配对门禁（就一个填写配对码的页面）
             └── 已配对：官方 GUI 本体 ──┐
                                        │  反向代理（loopback）
                                        ▼
                            电脑上的 DSH Web GUI（127.0.0.1:3080）
                                        │
                    额外：/pulse ←── 压缩活动流 + 决策队列
```

## 为什么是代理官方客户端，而不是重写一个手机界面

我调研过 DSH 生态里 130+ 个「远程与移动端」插件，绝大多数是「把桌面网页反代到手机上」。一开始我以为这是红海，就换了个方向做「只推决策相关信息的通知器」——**这是个判断失误**。

通知器能告诉你 agent 在干活，但你看不到它说了什么、改了什么，也就没法真正接着干活。所以现在改成：**让手机跑同一个客户端**。这样功能对齐不靠我追着官方 UI 抄——官方更新我自动跟上，因为它就是同一个东西。压缩流那层保留为附加价值。

## 三个能力

### 1. 完整功能（手机 = 电脑）

配对后手机访问 `/`，拿到的是官方 GUI 外壳，其资源、RPC 通道、下载、以及实时流所需的 **WebSocket** 全部经代理转发。功能范围由客户端自己决定，不由本插件枚举。

### 2. 压缩活动流（`/pulse`）

不在电脑前时，「在干什么、卡在哪、要你决定什么」比完整对话更有用。`lib/distill.js` 是纯函数引擎：

- **意图化**：`read {"file_path":"D:\\a\\b\\c.ts"}` → `读取 b/c.ts`
- **折叠重复**：连续同类动作合成 `读取 ×12`，带样本明细
- **终局摘要**：`任务完成 · 2 分 10 秒 · 18 次工具调用 · 读取12、命令4、修改2`
- **失败可读**：`读取失败：ENOENT: no such file`
- **有界**：折叠计数上限 500，环形缓冲上限可配

可以单独复用：

```js
import { Distiller } from 'dsh-remote-pulse/distill';

const distiller = new Distiller({ onFrame: frame => console.log(frame.text) });
distiller.turnStart({ sessionId: 's1', turn: 1 });
distiller.toolCall({ sessionId: 's1', toolName: 'read', args: { file_path: 'src/a.ts' } });
distiller.turnEnd({ sessionId: 's1', turn: 1 });
```

### 3. 「不在场」决策闭环（`lib/decisions.js`）

agent 阻塞在审批或提问上时，请求推到手机，一按就放行。

**关键设计：手机永远不能把 agent 卡死。**

```
没有手机连接        → 立刻 next()，桌面端一切照旧（零行为变化）
有手机连接          → 挂起 + 推送 + 等待
等待超时 / 手机断开  → 交回桌面端 answerer，卡片照常出现
```

**安全约束**：
- 手机传来无法识别的 outcome（比如 `"trust-me"`）**一律判为拒绝**——校验下沉在决策队列这个唯一收口，绕过 HTTP 也塞不进任意 payload
- 配对码一次性、5 分钟过期，用完即废
- 设备令牌 scrypt 加盐哈希落盘；吊销后即使 cookie 签名合法也不再放行
- 回环地址不触发爆破锁定（锁定是为远程猜测者设计的，不该把本机操作员锁在门外）

## 安装

```sh
dsh plugin --profile web add dsh-remote-pulse
```

重启 DSH 后，Pulse 在 **3199** 端口起自己的监听（默认只绑 `127.0.0.1`）。

<details>
<summary><b>从本地源码安装（开发用，不经过 npm registry）</b></summary>

`dsh plugin add` 在 profile 目录里调用 pnpm。没有 pnpm 时手工完成同样两件事：

```powershell
$profiles = "$env:USERPROFILE\.dsh\profiles"

# 1. 链接到 bundle 解析的父级锚点
New-Item -ItemType Directory -Force -Path "$profiles\node_modules" | Out-Null
New-Item -ItemType Junction -Path "$profiles\node_modules\dsh-remote-pulse" -Target "<源码绝对路径>"

# 2. 编辑 $profiles\web\package.json，把 "dsh-remote-pulse" 追加到 dsh.profile.bundles
```

bundle 名称解析顺序是「dsh 安装目录 → profile 目录」，后者的父级回溯正好命中 `profiles\node_modules`。

**注意**：写 `package.json` 不要带 UTF-8 BOM——DSH 用 `JSON.parse` 读取 manifest，BOM 会让它启动失败。

</details>

### 让手机连上

**同一 WiFi**：把 profile 补丁里的 host 改成 `0.0.0.0`

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: remote-pulse
  name: dsh-remote-pulse
  config:
    host: '0.0.0.0'
    port: 3199
```

重启 DSH，手机浏览器打开 `http://<电脑局域网IP>:3199`。

**人在外面（推荐，已实测）**：用一台有公网 IP 的小服务器做中转。

```
手机 ──HTTPS──> 服务器:443 (nginx) ──127.0.0.1:3199──> SSH 反向隧道 ──> 你的电脑 127.0.0.1:3199
```

1. 服务器上放 nginx 配置（`deploy/nginx-pulse.conf`，含自签证书、SSE 不缓冲、WebSocket upgrade、
   以及**用 `$remote_addr` 覆写 `X-Forwarded-For`**——管理围栏依赖这一条）
2. 电脑上装 SSH 公钥登录，确认 `ssh root@<服务器> true` 不再问密码
3. **让隧道自启**（关键：手动开的 `ssh -R` 会随终端一起消失）

```powershell
# 常驻守护 + 掉线自动重连（指数退避，探测到已有隧道就只观察不抢端口）
pwsh -File scripts/tunnel.ps1 -Server root@<服务器>

# 注册成登录自启的计划任务，这样关掉终端、重启电脑都不会断
pwsh -File scripts/install-tunnel-task.ps1 -Server root@<服务器>
pwsh -File scripts/install-tunnel-task.ps1 -Remove      # 不想要了就删掉
```

4. 自检整条链路（幂等、不改状态，可以挂到定时任务上）

```sh
node scripts/preflight.mjs https://<服务器> --insecure   # 8 项；exit code 非 0 表示有问题
```

实测：杀掉持有隧道的进程后，守护脚本在 **22 秒**内重新建好隧道，公网自检 8 项全部恢复。

> 也可以用 cloudflared / Tailscale / FRP 代替，Pulse 不关心隧道怎么来的。
> 唯一的要求是：**管理端点必须仍然只能从本机够到**。用别人的隧道时要确认它不会把
> `X-Forwarded-For` 丢掉——否则那道闸就只剩令牌一层。令牌仍然有效，但少一层总是更差。

### 配对

配对码只能由**本机**申请。管理端点需要一个只存在于本机文件系统上的令牌，脚本会自动读取：

```sh
node scripts/pair-qr.mjs https://你的公网地址     # 打印二维码 + 配对码 + 倒计时
node scripts/devices.mjs list                    # 看已配对的设备
node scripts/devices.mjs revoke <id|all>         # 手机丢了就撤掉它
node scripts/devices.mjs status                  # 监听地址、在线手机、配对通道
```

在手机页面上填入配对码（扫二维码会连配对码一起带过去，自动填入）。配对成功后浏览器可「添加到主屏幕」，即成为一个 PWA。

> 本机管理令牌位于 `DSH_HOME/remote-pulse/local-token`。脚本自动读取；手动 curl 时用
> `-H "x-pulse-local-token: $(cat ~/.dsh/remote-pulse/local-token)"`。
> 也可以用环境变量 `PULSE_LOCAL_TOKEN` 覆盖。

### 锁屏通知（Web Push）

手机配对后，在 Pulse 控制台点「开启锁屏通知」：任务完成、需要你决策的消息会推到锁屏，不用一直开着页面。

**什么时候推，只有两个时刻：回合结束（`turn/end`）和需要你决定。** 开始执行不推；
工具失败默认也不推（`notifyFailures` 打开才推）—— 一次失败后面通常还有重试和回合结束，
推两次只为同一件事。手机 App 里那条常驻通知用的是同一条规矩。

**每条 frame 都带项目名**（`project`，工作区目录的最后一段，取自会话自己的 `header.cwd`）。
两个会话同时开着的时候「任务完成」这句话没有信息量，所以手机弹窗的标题就是项目名、
正文是那句摘要。拿不到时这个字段**直接不出现**，手机端回落到通用措辞 —— 宁可含糊，也不猜一个。

**委派出去的子任务还会带 `depth`**（同样取自 session header 里不可变的 `delegationDepth`）：
0 是用户自己那条对话，1+ 是跑在它里面的子代理。子代理的回合结束**不是**用户的对话结束 ——
这台机器上 13 个 session 里有 5 个是 depth 1，每一个都在发自己的 turn/end，
所以手机端看到 `depth > 0` 就只更新那一行、绝不弹窗。

**落款是 DeepSeek，不是 Pulse。** 通知标题（`DeepSeek 任务动态`）、App 名字、手机上的通知文案、
证书安装对话框，全都不出现 Pulse —— 那个名字只有开发者见过，出现在锁屏上只会让人疑惑。
内部的 push tag、频道 id、`/pulse` 路径保持不变：tag 一改就等于把"同一条通知替换自己"变成"堆一堆"。

- VAPID 密钥对在首次启动时生成，存在 `DSH_HOME/remote-pulse/push.json`
- 撤销设备会**同时**删掉它的推送订阅，撤掉的手机不会再在锁屏上收到任务内容
- 订阅失效（404/410）自动清理；服务端 5xx 会保留订阅重试
- Service Worker（`/sw.js`）只做推送，**没有** fetch handler，不缓存页面

**一键决策**：需要你决定的推送带两个按钮，不用打开 App。

| 决策 | 通知上的按钮 |
|---|---|
| 权限请求 | 「允许一次」/「拒绝」 |
| 单选提问，且选项 ≤ 2 个 | 那些选项本身 |
| 多选提问，或选项 ≥ 3 个 | **不给按钮**，只给深链 |

最后一行是刻意的：一个按钮表达不了的答案，给了按钮只会让用户以为回答过了。点按钮时由 Service Worker
直接 POST `/api/decisions/resolve`——通知里只放决策 id 和答案 token，**没有任何凭据**，
认证靠的是手机本来就有的会话 cookie（所以撤销设备会同时让这条路失效）。回复成功/失败都会再推一条，
不会静默失败让 agent 一直卡着。普通点按则深链到 `#decision-<id>`，控制台会把那条高亮并滚到中间。

> 自签证书 + 裸 IP 在多数手机浏览器上不算安全上下文，此时浏览器会拒绝推送。
> 想要锁屏通知，需要一个域名 + 受信任证书（见「已知取舍」）。

### 产物中心

手机控制台里直接看 agent 刚生成的文件：图片内联预览，文本点「预览」就地展开，任何文件都能下载。

- **列表来源是事件流，不是扫盘**。Pulse 本来就消费 `session/event`，每次工具调用都带着参数，
  所以「agent 产出了什么」这件事已经在流经这个进程——记录它不需要新的耦合，而且回答的正是
  「agent 做了什么」，而不是「目录里有什么」
- **只认写类工具**（`write`/`edit`/`str_replace_editor`/`apply_patch` 等）。`read` 不算产物：
  让用户看到一个 agent 只是看过的文件是错的
- **内容路由的路径不是指令，而是白名单**。`/api/artifacts/content?path=…` 只在那个路径**已经**
  被记录时才提供字节。所以目录穿越不是被过滤掉了，而是**没有可达路径**——不存在一段代码会打开
  调用方指定的路径。这比「校验路径是否在工作区内」强得多，因为后者很容易写错
- 白名单之上还有一层拒绝名单：`.credentials.yaml`、`.ssh/`、以及 Pulse 自己的状态目录
  （`local-token` 就是管理接口的边界，绝不能镜像到手机上）
- 记录会落盘（`DSH_HOME/remote-pulse/artifacts.json`）：文件本身重启后还在，列表不该失忆
- 新产物通过 SSE 推到手机，不用刷新

## 配置

```yaml
- id: remote-pulse
  name: dsh-remote-pulse
  config:
    host: '127.0.0.1'        # 设成 0.0.0.0 才允许手机连入
    port: 3199
    realm: 'Pulse'           # 手机上显示的名字
    notify: 'none'           # none | webhook | serverchan | bark
    notifyUrl: ''            # webhook / bark 地址
    notifyKey: ''            # serverchan SendKey
    decisionTimeoutMs: 120000   # 手机最多持有决策多久
    pushArmDelayMs: 20000       # 有推送通道时额外宽限
    ringCapacity: 800           # 可续传的帧数
    notifyTurns: true           # 每轮完成都推送
    notifyFailures: false       # 工具失败也推送
    serviceWaitMs: 10000        # 等 webServer/connection 服务多久，超时就先起手机面
```

### 手机端窄屏适配层

手机跑的是**官方客户端**（这正是设计：重写必然持续落后）。所以适配只能是样式表，通过官方支持的
`webserver/index-inject` 以 `{kind:'style'}` 注入到 `<head>`，**每一条规则都在 media query 里**，
桌面窗口不受影响。

官方样式是 CSS Module，类名形如 `_<语义>_<模块哈希>_<行号>`，哈希每次官方构建都会变。所以选择器一律用
`[class*="_paneBody_"]` 这种**语义前缀子串匹配**，重新哈希不会失效；前缀清单记在 `lib/mobile.js` 的
`MOBILE_ANCHORS` 里，官方一旦**改名**就会被 `scripts/verify-mobile-layer.mjs` 报出来——
变成一条可检查的漂移，而不是靠眼睛在手机上发现。

这一层做的是能验证的事：

- iOS 横屏文字自动放大（`text-size-adjust`）
- **iOS 聚焦时整页缩放**：小于 16px 的输入框一聚焦，Safari 会放大且不再缩回——用
  `@media (pointer: coarse)` 把输入类控件抬到 `max(16px, 1em)`
- **触控目标**：官方的图标按钮 28px、标签关闭 20px，都在 44px 指南之下。只放大盒子，图标本身不变
- **宽内容兜住**：`pre` / `img` / `table` 在内容面板里不再把整页顶出横向滚动；flex 子项补 `min-width:0`
- 手机宽度下，弹窗按钮改为均分一行，不再有一个溢出屏幕

### 手机外壳：把侧栏变成抽屉（`lib/mobile-shell.js`）

上面那层只调样式；真正把手机端从「能用」变成「好用」的是这一层，而它的选择器**不是猜的**：
`scripts/verify-mobile-shell.mjs` 用机器上已有的 Edge 以 390×844 渲染官方客户端，把真实的树和几何读出来，
再据此定做法。量出来的三件事决定了设计：

1. 手机宽度下官方侧栏本来就已经是 **56px 图标栏**（带 `_collapsed` 标记），不是桌面面板；
2. 官方**自带「打开侧边栏」按钮**。所以外壳不自己画会话列表，只去按那个按钮——展开的是官方侧栏，
   里面是官方的会话列表、搜索、设置，以后官方加什么功能都免费跟着有；
3. 展开它是**推挤式**：对话列从 334px 掉到 **110px**。这才是手机上真正的毛病。

所以外壳只做一件事：让展开后的侧栏**浮起来**，离开布局流。

**踩到的坑（值得写下来）**：只加 `position: fixed` 是错的。外框不是 flex 行，而是**网格**，
轨道由客户端内联写着（`grid-template-columns: 56px minmax(0px, 1fr) 0px`）。
网格项一旦 `position: fixed` 就**不再占轨道**，于是后面每一列都左移一格：
对话掉进 56px 的侧栏轨道，空着的右栏继承了 `1fr`。真浏览器量到的正是
「56px 对话 + 334px 空白」。所以外壳同时**改写轨道**：

```css
[class*="_frame"] { grid-template-columns: minmax(0px, 1fr) auto 0px !important; }
```

第二轨用 `auto` 而不是百分比：非 `fr` 轨道即使空着也会占满自己的上限，第一版写成
`minmax(0px, 45%)`，结果白白让掉 175px。空右栏另由 JS 打上 `data-pulse-rightbar-empty`
（判据是**内容**：没有按钮/链接/表单/图形且没有文字）并 `display: none`，一旦有内容立刻摘掉标记。

结果：**收起和展开两种状态下对话列都是 390px 满宽**（官方是 110px）。
之所以两种状态都量，是因为抽屉是浮层——打开时它本来就盖住对话，
用户真正在读的宽度是**收起**那一档，只量展开态会把上面那个坑放过去。

自有 UI（汉堡按钮、遮罩、自检面板）全部追加在 `#root` **之外**并 `position: fixed`，
React 重渲染看不到它们。汉堡按钮的可访问名和官方按钮**一样**，所以查找官方按钮时会显式排除
`[data-pulse="chrome"]` 里的节点——否则会点到自己，无限递归。任何时候点右下角 `?` 能看到自检面板，
它把每个探针找到了什么直接写出来：选择器失效是这里最可能的故障，而且天然是无声的 ——
包括页头这一项（「页头模式/任务 chip: 已搬进页签行 ✓（68px 宽，右边距 28px）」）。

手机上的上传入口不另做一个：官方输入框的「+」就是它，外壳只把命中区放大到 44px；
三格来源（拍照 / 相册 / 手机文件）由 App 在 `onShowFileChooser` 里给出。

#### 页头那两行：模式 chip 搬到「对话 / 轨迹」右边（`syncHeaderActions`）

你指着截图说的那句「最上面的有点挤，看不清楚」量出来是这样的 —— 390px，那个**页头塞满**的会话
（4 个子代理 + 1 个后台任务）：

```
titleRow 342 ── titleCluster 182 [ crumbs（标题）0px(!) | headerActions 226 ]
             ── headerUtilities 88
             ── headerCorner    28
tabs     342 ── 对话 26 ＋ gap 36 ＋ 轨迹 26 = 88   ← 同样 342px，只用掉 88px
```

**会话标题的容器宽度是 0** —— 所以手机上只看到「我的…」甚至只剩一个数字，几个 chip 还互相压着。
而下面那一行页签**空着 254px**。所以做法就是把页头的 chip 搬下去。

* 它们住在 `_headerActions` 这个类名下。官方**同一个槽**（`conversation.session.header.actions`）有
  **两个**贡献者 —— 模式 chip（`dsh-client-ui-agent-preset`）和后台任务 chip（`dsh-client-ui-jobs`，
  `id: job-list`）—— 而**每个贡献者各有一层同名的包裹**：页面上量到的是**两个** `_headerActions`
  兄弟节点，都在 `titleCluster` 里。所以"搬容器"必须搬**全部**包裹层，只搬第一个会把另一个留在
  标题行（这是第一版真踩到的：一个进去了、一个没进去，之后 `fits` 还算出一个 362px 的"最后一个页签"）。
  后台任务那个 chip 在**没有后台任务时根本不渲染**（`if (jobs.length === 0) return null`），
  平常就只有一个包裹层。
* **搬法是动 DOM，不是改定位。** 第一版是 `position: fixed` + 按页签行的 rect 算坐标（看起来更"轻"），
  **发出去一小时就被你抓到**：固定定位不理会"页头已经不在屏幕上了"—— 打开右侧面板（文件/预览）时，
  页头被盖住了，chip 却还钉在自己的坐标上，于是**画在别人面板的页头上**。而所有补救都是**监视**
  （命中测试页签行、被盖住时重试、监听 `transitionend`），每个监视都有一个"状态是错的"的窗口。
  现在改成**真的把节点搬进页签行**（`margin-left:auto` 靠右），于是 chip 和页头**画在同一个地方**：
  盖住页头的东西就盖住它们，页头不在屏幕上它们也不在。**这是树的性质，不是对被监视状态的信任。**
  顺带把层叠问题也解决了：作为没有 z-index 的流内节点，后台任务菜单自己的 `z-index:100` 仍然在
  页面的层叠上下文里生效；而 `position: fixed` 的容器**会建立层叠上下文**，把菜单限制在容器自己的
  z-index 上（量到：横幅包裹层 `z-index:6` 盖住了打开的作业菜单）。
* 配对是**要求**出来的，不是假设的：包裹层按自己的类名后缀找，但只有当**装着它的那个 `header` 里同时有
  页签行**时才接受 —— `querySelector` 的命中顺序不是契约。
* 放大到桌面宽度要**还回去**（`clearHeaderActions()`），而且"老家"是**每次按类名重新推导**
  （`_titleCluster`）而不是记住一个节点：客户端会为不同宽度**重建整个页头**，记住的那个父节点会变成
  游离节点 —— 既收不下节点、也认不出它已经失效（这条也是实测出来的：桌面宽度下 marker 没了、
  节点还留在页签行里）。
* **放不下就不搬**：320px 上，两个 chip（约 177px）和页签行放不到一行里，而"把它们收窄"试过 ——
  **收窄的 flex 行会换行**，容器变成 43px 高、从页头下面探出来，更糟。所以这种宽度**保持官方布局**，
  自检面板写明「这一屏太窄」。余量必须按**页签行自己的右边缘**算，不能按视口算：flex 行放不下时是
  往右**溢出**的（320px 实测溢出 11px）。

改完之后同一屏实测：**标题容器 0px → 182px**，chip 落在页签行里、完全在「轨迹」右边；打开右侧面板时
chip 与页头一起被面板盖住；作业菜单打开的浮层在自己那一行是最上面的。
`scripts/verify-header-actions.mjs` 里每一条都有对应的断言，**包括"这条能失败"的自校验**。

#### 挂在页头里的弹层会压住页签（已修：`clampPopovers()` 补上竖直那一半）

你说「那个面板第一行看不清楚」，量出来是官方的**子代理面板**（`ZKlsPq_menu`）：

```
官方定位：top = 触发按钮.bottom + 5        触发按钮在页头**里面**（y=19..47）→ 面板 top = 52
页头到哪结束：87                           → 面板最上面 35px 正好压在「对话 / 轨迹」那一行上
```

原来我们的 `clampPopovers()` **只做水平方向**（那是为另一个菜单加的），竖直方向是空的。现在补上：
面板顶边低于页头底边就往下推，推下去会顶出屏幕底边就贴着页头、让它自己内部滚动；如果它本来就
比"页头到屏幕底"这段还高，就**不动它**——推下去只会把最后几行藏起来。

同一屏实测：面板 `top 52 → 95`（= 页头底 87 + 8），第一行 `top 106`，不再压页签。

**注意**：webserver 注入的内容是**插件进程启动时定格**的。改了 `lib/mobile-shell.js`
之后，运行中的 DSH 仍会下发旧的那份，直到重启。`scripts/verify-mobile-layer.mjs` 会把
磁盘长度和进程里的长度对比，直接报「需要重启 DSH」；而真浏览器验证不受影响，
它自己把旧外壳从页面里剥掉，测的始终是磁盘上这份源码。

**样式表也要比**：只比脚本是不够的——只改 CSS 时脚本长度一模一样，检查会「全绿」而手机
拿到的还是旧规则（真的发生过）。所以两张样式表（窄屏层、外壳）都逐字对比。

### 标签页上的 × 是歪的（已修：是**我们**弄歪的）

用户说「文件」标签右边那个 × "在这个小框里面的位置不够对称"。量了一下，问题出在自己身上：

```
官方：  _tabClose_ { position:absolute; top:4px; right:4px; width:20px; height:20px }  ← 28px 标签里本来就对称
我们的：  min-width:32px; min-height:32px; display:inline-flex; align-items:center …  ← 只往右下长
```

**绝对定位的元素，加宽高不会移动它的锚点** —— 盒子从 20 长到 32，是往右和往下长的，
于是 × 的墨迹落在标签中线下方 **6px**、命中区还伸出标签 8px 之外。`align-items:center` 救不了它，
因为盒子本身就已经偏了。

修法分两步，两步都是"量出来才知道"的：

1. 盒子改成**在标签里按构造对称**：`top:2px; right:2px; width:24px; height:24px`（2+24+2=28），
   多出来的触摸范围交给 `::after{inset:-4px}` —— 它改变手指能点到什么，不改变眼睛看到什么，
   有效目标仍是 32×32。
2. **靠 specificity 赢，而不是靠顺序**：选择器写成 `[class*="_tab_"] [class*="_tabClose_"]`（0,2,0）
   压过官方的（0,1,0）。两个同级选择器的话，结果就取决于我们的样式表有没有恰好排在官方后面 ——
   而失败是静默的：盒子低 2px，× 又歪了。探针**故意把官方规则注入在我们之后**，
   所以这个顺序问题不可能让它蒙过去。

顺带一个测试自己的坑：这条断言原本去 CSS 里找数字，结果先找到了**规则注释里写的官方值**
（`top:4px`），于是它拿旧数字判新规则。现在先把注释剥掉再解析。

### 汉堡按钮的反应慢（已修：不再节流）

用户说点开右边面板时，"三条横杠消失和出现都有延迟"。原因是我们自己的探针：判断"这个角是不是
被官方占了"原来是**把汉堡临时隐藏一次**、`elementFromPoint`、再恢复 —— 隐藏会作废样式、强制重排，
所以整个探针被限流到 **250ms 一次**（带一次 trailing）。那 250ms 就是用户看到的延迟。

现在读的是 `elementsFromPoint(26,33)` 返回的**整摞命中栈**：我们的汉堡和遮罩都在栈里，
跳过属于 `[data-pulse="chrome"]` 的那些，栈里第一个官方的交互元素就是答案。不用隐藏任何东西，
也就没有需要限流的理由。验证脚本**顺便测量了延迟**：

| | 修之前 | 现在 |
|---|---|---|
| 角被占用 → 汉堡让开 | 最多 250ms+ | **6ms** |
| 占用解除 → 汉堡回来 | 最多 250ms+ | **7ms** |

> 探针注入的假控件 `z-index:9` 在汉堡**下面**；`elementsFromPoint` 会把被遮住的元素也返回，
> 所以这条规则仍然能看见它 —— 这是"读命中栈"相对"取最上面那一个"的关键差别。

### 弹层伸出屏幕（已修：`clampPopovers()`）
后台任务那个框（「1 个后台任务」点开）在手机上**右边被切掉**，最右一列（状态、耗时）完全看不到。
量出来是这样：

```
官方的 CSS：  _menu { position: absolute; left: 0; width: 336px; top: calc(100% + 5px) }
390px 手机上： trigger 在 x=144（汉堡 + 模式选择器之后），于是菜单 144 … 480 → 右边超出 90px
```

**这一条 CSS 修不了**：菜单放不放得下取决于它的触发点落在哪，只有量一下才知道。所以在
`mobileShellScript()` 里做了一次测量，把任何**越出视口的弹层**用 `translateX` 拉回来——
只挪刚好够用的距离（右边缘贴到 8px 边距），本来放得下的一个像素都不动，宽度超过阈值时
（外壳退出）位移会被撤销，桌面窗口完全不受影响。它不是只针对这一个菜单：任何
`_menu` / `role="menu"` / `role="listbox"` 且自身定位的弹层都适用。

验证（`scripts/verify-mobile-shell.mjs` 里 6 项，夹具用的是 **jobs 插件自己的类名和样式表**）：

| 检查 | 结果 |
|---|---|
| 夹具在手机上确实伸出屏幕（否则这条检查不可能失败） | 右边缘 480 > 视口 390 |
| 夹回之后完整落在屏幕里 | 46 … 382 |
| 只移动刚好够用的距离 | 移动 −98px，右边缘贴到 382 |
| 本来就放得下的菜单一根手指都不动 | left 8→8，无 transform |
| 拉宽到桌面宽度后位移被撤销 | active=false，夹住 0 个 |
| 缩回手机宽度后重新夹好 | translateX(−98px)，夹住 1 个 |

自检：把 `clampPopovers()` 改成直接 `return`，**3 项立刻变红**。

> 顺带一个真实的坑：这 6 项里"桌面宽度"那两步不能用 `page.setViewport()` 改宽度 ——
> **puppeteer 在 `isMobile` 变化时会重载页面**，注入的外壳和夹具一起没了，
> 检查会变成"什么都没测"却依然通过。现在宽度是在页面里临时替身 `innerWidth` 再调真实的
> `refresh()`，测的还是那两个真函数。

### 设置：从桌面式弹层变成整页
设置是官方弹层，在 390px 下量出来是 **342px 宽，左边 188px 分区导航 + 右边 154px 内容区**，
留给每行的只有 106px——于是标签一字一行竖着排。这么窄的内容区不是靠调 padding 能救的，
手机上它必须变成整页。

外层锚点用 `role="dialog"`（不随官方构建变化），再用 `:has([class*="_navList"])` 限定成
「设置这一个弹层」，免得波及其它对话框。里面**不用类名**，用结构：面板的第一个子节点是分区
导航、最后一个是内容区，改名也不会失效。分区列表变成内容区上方的一条横带，四个分区在当前
字号下正好铺满 366px（官方那套 padding 量出来是 431px 才够，会把最后一个标签切一半）。
字号：面板 16px，内部标签和控件都继承，于是整页跟参考的尺度对齐，而不用逐个去点。

**关闭按钮挪到标题那一行**：官方的 × 在内容区的 header 里，而整页化之后那一行落到了分区横带**下面**，
于是它孤零零飘在屏幕中间。现在用绝对定位提到面板右上角，与「设置」同一行——面板自己 padding 10px、
分区导航再加 22px，所以标题行的盒子从 32px 开始，28px 的按钮要 `top: 30px` 才与它同一中心线。

### 会话里的横向内容会吞掉上下滑动（已修）

**症状**：滚到有宽表格的地方，手指停在表格上就再也上下滑不动了。

**根因**：`overflow-x: auto` 而 `overflow-y` 保持默认 `visible` 的盒子，按 CSS 规则另一轴会被
计算成 `auto`——**它同时是一个纵向滚动容器，尽管纵向没有任何可滚的东西**。正常情况下靠
scroll chaining 把纵向手势交给父级；而 `overscroll-behavior: contain` 会**掐掉这次交接**。
我原来在 `_tableScroll_` 上写的是简写 `overscroll-behavior: contain`，两个轴一起 contain 了。
官方样式表在同一元素上写的是 `overscroll-behavior-x: contain`——只有 X 轴。

**证据**（`scripts/repro-scroll-trap.mjs`，真浏览器 + 合成手势）：

| 内层写法 | 计算值 | 外层滚了多少 |
|---|---|---|
| 默认 | `auto/auto` | 30px ✓ |
| `overscroll-behavior: contain` | `contain/contain` | **0px ✗** |
| `overscroll-behavior-x: contain` | `contain/auto` | 30px ✓ |

脚本里带一个「探针自检」：先证明这个检测**能**在新造的窄栏上报警，再相信它的绿色结论——
第一版检测器因为量的是脱离文档的节点（0×0）而永远不报警，那次「设置页没问题」是假的。

**规则**：横滚盒子只 contain X 轴，永远不要写 `overscroll-behavior` 简写。
`test/mobile.test.js` 有一条不依赖浏览器的用例守着这条。

### 字号与间距

会话正文字号**故意不管**：官方设置里有「字号大小」（默认 14px，写着「仅影响会话内容的字号」），
在这里硬写一个值等于偷偷覆盖用户在设置里做过的选择。所以只管官方没暴露的那部分——行高 1.75、
段落间距 0.85em、列表项 0.35em。设置页的字号则跟着上面的 16px 走。

### 汉堡按钮和页头抢位置（已修）

汉堡是 `position: fixed` 在左上角，而会话页头的标题行也从 x=20 开始，所以它会压住 logo 和会话名——
真浏览器量到的是「汉堡 40x40@8,8 覆盖 svg@16,27 和会话标题@20,11」。

先把「官方页头有没有自己的开关可以替代汉堡」查清楚了，结论是**没有**：抽屉收起时官方把
`打开侧边栏` 挪进了侧栏（在我们的 CSS 下它被推到屏幕外 x=-49），页头里那个 `收起侧边栏` 只在
抽屉**打开**时存在。所以汉堡不能删，只能给它让出角落：给页头那一行加 40px 左内边距，
代价是标题少 40px（本来就省略号截断）。

验证里加了一条常驻断言：汉堡不得覆盖 `header` 里的任何元素。**只算页头**——对话内容滚到浮动按钮
下面是一个浮动按钮的正常行为，把它也算进去会把真正的投诉淹掉（第一版就是这么误报的）。

按钮底色也从半透明改成不透明：内容会从它下面滚过，半透明会把文字糊在一起。

### 页头两行的配比，和汉堡图标

页头是两行：**标题行**（logo、会话名、模式、模型、⋯、右侧栏）和 **对话/轨迹行**。
量出来的问题是配比反了——标题行只有 30px，而 对话/轨迹 那行占了 **35px**
（按钮 25px 加 10px 间隔），小小的 tab 标签反而比装着全部控件的那行更占地方。

| | 原来 | 现在 |
|---|---|---|
| 标题行 | 30px | **46px** |
| 对话/轨迹行（含间隔） | 35px | **约 21px** |
| 页头总高 | 86px | 87px |

多出来的空间给标题行，因为控件和汉堡都在那一行。tab 的类名不是官方样式表里那个
`_tabStrip_`，而是 **`_tabs`**（`_tabStrip_` 属于右侧栏）——量出来才发现，
按猜的类名写会一条都不命中。

**汉堡图标改成画的，不再用 `☰` 字形**：U+2630 的墨迹大小是字体的属性，没法相对旁边
16px 的标题去定尺寸，看起来就是一个不搭的字重。现在是 22×22 的 SVG 三条线，
比标题略大——这才是它该有的关系。按钮也就不能再依赖 `font-size` 居中，改 `line-height: 0`。

### 把电脑上的文件拿到手机（怎么下载）

#### 交付卡片上直接给「下载 / 转发」

对话里每张「本轮文件改动」卡片，**文件那一行现在多一个按钮**：

| | 按钮 | 点了做什么 |
|---|---|---|
| 电脑 | **下载** | 落到浏览器的下载栏（`Content-Disposition: attachment`） |
| 手机 | **转发** | 弹系统分享面板 → 微信 / QQ |

**为什么是注入而不是用官方扩展点**：客户端确实有扩展机制（客户端插件 + `ctx.slots` 插槽），
但那张卡片的 ▾ 菜单项是**写死在 `@deepseek-ai/dsh-client-ui-deliverables` 组件内部的**，
文案在那个插件自己的语言字典里，而它注册到槽里的只有**整张卡片**。要往那个菜单里加一项，唯一的
正规办法是**接管整张卡片的渲染** —— 官方以后每次改它都得重新对齐。所以这里在卡片那一行自己加一个
控件，并配一个观察者：**React 会抹掉外来节点，抹掉就补回来**。

验证（`scripts/verify-deliverable-action.mjs`，34 项）：控件插在那颗药丸里、▾ 之前、沿用「打开」的样式、
电脑端是 `download=1` + `download` 属性、手机端是 `share=1`、**抹掉之后会自己回来**，
外加一组**对着客户端实际收到的官方模块**的契约断言（`data-presented-file`、`_cardPreview`、
`_open`/`_split`/`_menuAnchor`、「在侧边栏打开 {name}」模板、`cwd` prop 都还在）。
同一个脚本现在还管**折叠的 `present` 工具行**（见下一节）。

三个坑**都是验证或用户抓出来的，不是我想出来的**：

1. 我猜那张卡片的可访问名是「打开 `<路径>`」，**真实是「在侧边栏打开 `<路径>`」** ——
   所以改成**从字符串里提取路径**，而不是剥前缀。
2. 用后缀匹配 `_menuAnchor` 时**容器也会命中**（例如 `xxx_menuAnchorRow`），于是同一张卡片被插了
   **两个**控件。现在只取**最内层**那个。
3. **`file.path` 有两种形态，而第一版只认绝对路径。** 这条是被你发现的：那张 APK 卡片上
   一直**没有**「下载 / 转发」。

   原因是它是用**相对路径** `present` 的（`pulse-android/dist/pulse-remote.apk`）。
   卡片渲染的是 `aria-label="在侧边栏打开 {file.path}"`，于是标签里就是
   `在侧边栏打开 pulse-android/dist/pulse-remote.apk` —— 而当时的规则是"必须长得像 `C:\…` 或 `/…`"，
   于是**一声不响地什么都没插**。而用绝对路径 `write`/`edit` 出来的文件，那张卡片一直是好的，
   所以这个洞只在特定的文件上出现，看起来像是"时好时坏"。

   现在按优先级三条路都试：卡片自己的 tooltip（组件用 `resolveWorkspacePath(cwd, file.path)` 填的，
   **已经是绝对路径**）→ 任意可访问名里的绝对路径 → 相对路径 + 组件自己的 `cwd` prop
   （`PresentedFileCard({ file, cwd, … })`）。无论走哪条，**结果的文件名必须和卡片印的那个一致**，
   否则不插。

   > 这也是那句老话的代价：**夹具是我编的，官方源码不是。** 前两轮我一直在用一个
   > `_menuAnchorRow` + 绝对路径的**想象出来的夹具**，它 10 项全绿；而真实卡片是
   > `div[data-presented-file] > button._cardPreview[title] + div._split > button._open + _menuAnchor`，
   > 路径是相对的。现在夹具是**照着官方 JSX 抄的**，并且额外对着**下发给客户端的那份模块**做契约断言：
   > 官方哪天改了结构或改了那串文案，探针会直接报出来，而不是继续对着旧夹具全绿。

> 卡片本身和「本轮文件改动」这个标题**不是我们画的**，是官方交付卡片；我们只在它的文件行上加了按钮。

#### 折叠的「交付文件」那一行也给（不用先展开）

`present` 折起来是**一行**：`交付文件 · 已交付 pulse-android/dist/pulse-remote.apk`。
它和上面那张卡片**是两回事**：

| | 谁画的 | 什么时候在 |
|---|---|---|
| 「本轮文件改动」卡片 | 官方 `Deliverables`，注册在**回合末尾**槽 `conversation.chat.turnTail` | 它那一轮被渲染时 |
| `交付文件` 这一行 | 官方 `PresentRow`，是 `present` 的**工具行** | 同上，但读的是**转写数据** |

之前只有卡片上有按钮，于是**交付的东西如果只在这一行里出现，下载/转发就没有** —— 你当时在手机上
找不到那个 APK 的入口，就是这一条。

现在这一行自己带按钮。官方把路径印在 `span.<hash>_paths` 里，内容就是
`args.files.map(file => file.path).join(", ")`（读的是**下发给客户端的那份模块**，不是猜的），
所以按后缀 `_paths` 找到它，再用和卡片**同一套**规则把相对路径拼成绝对路径
（`cwd` 从工具行自己的 props 里拿），**最后一段文件名对不上就不插**。

四个细节：

1. **一行可能印多个文件。** 官方用 `", "` 拼，所以守卫不能是"这一行有没有我们的控件" ——
   否则第一个文件插上之后，后面每个都永远拿不到按钮。每个控件都记着**自己代表哪个文件**
   （`data-pulse-deliverable-path`），按文件去重。
2. **点一下不会顺手把这一行展开。** 那一行是 `DisclosureRow`（`role="button"` +
   `expandOnRowClick`），落在行内的任何点击都会展开它，所以控件的 click **拦掉冒泡**。
   探针里配了一个**活的计数器**：点控件不涨、点这一行的别处要涨 —— 否则"没涨"什么都证明不了。
3. **样式**来自官方自己：展开时那个「查看」按钮（`_inspect`）出现了就直接沿用它的类；折叠时它
   还没渲染，就按它的那套 token 上色（`--dsw-alias-link`、12px、无下划线）。
4. **上限 4 个**（`LIMIT`）。这一行的路径是**省略号**样式，控件无限加会把文件名挤没。

验证（`scripts/verify-deliverable-action.mjs`，34 项）里这一行是**照着官方 `PresentRow` 抄的夹具**：
一行一个文件 / 一行两个文件 / 已经是绝对路径 / 拿不到 `cwd` / 根本不是路径（**后两种必须不插**）、
点控件不展开、抹掉之后自己回来。另外还有三条**对官方模块**的契约断言：`_paths` 类名还在、
`join(", ")` 还在、它仍然是 `DisclosureRow`。

**真页面也量过**（`scripts/audit-present-row.mjs`：打开真实会话 → 点「加载更早」把那一轮渲染出来 →
扫全表），390px 用 PulseApp UA + 真手机外壳，读到的是：

```
=== ROW._row_luwio_16
text: 交付文件已交付pulse-android/dist/pulse-remote.apk转发
ours: 转发  source=D:\deepseek harness\pulse-android\dist\pulse-remote.apk  share=1  inRow=true
```

#### 为什么那张交付卡片「电脑端弹了、手机端没弹」

这是你问的。量出来的事实（`audit-present-row.mjs`，1400px 和 390px 各一次）：

- **刚打开的客户端只渲染最后一轮。** `data-chat-turn` 只有当前那一个，页面上
  `[data-presented-file]` 是 **0**，旁边有一个「**加载更早**」按钮。
- **点一下「加载更早」**，前面几轮渲染出来，那张 APK 卡片就在那儿；390px 带真手机外壳时它也在屏上
  （`348x60@20,13649`，`display:flex`、`opacity:1`、`withinViewport:true`，我们的「转发」按钮
  `60x42` 可见）。

所以卡片**不是手机端坏了**：它属于它自己那一轮（回合末尾槽），**只有那一轮被渲染时才存在**。
两台客户端停在不同的地方而已 ——

- 电脑那个标签页**从那一轮结束前就一直开着**，卡片出现后就留在屏幕上；
- 手机（WebView 回到前台时重载/重连）回来时落在**最新那一轮**，而 APK 那一轮已经在
  「加载更早」后面了。

**自己验一下最直观**：把电脑那个页面按 **F5**，那张卡片也会消失，点「加载更早」才回来 ——
和手机是同一个行为，跟是不是手机没关系。

> 顺带说一句取舍：现在**即使卡片不在屏上**，那一行自带的「下载/转发」也摸得到交付的文件。
> 如果你要的是"回合结束时手机自己弹一条提到这个文件的通知"，那是另一条线（手机自己的通知正文），
> 说一声我去接。

#### 对话里那条虚线下划线的文件路径也给（`fileLinkActionsScript`）

`读取 dsh-remote-pulse\lib\ui.js` 这种工具行里，文件路径是一条**虚线下划线**，点开是预览。
用户就是在这一行上看见文件名的，所以下载/转发就挂在这里（电脑「下载」、手机「转发」，
样式沿用路径自己的类，看起来是同一条下划线的一部分）。

**难点只有一个：路径是相对工作区的。** DOM 里印的是 `dsh-remote-pulse\lib\ui.js`，
而绝对路径**只存在于 React 组件的 props 里** —— 没有 data 属性，也没有 title。
唯一的办法是读 React 挂在 DOM 节点上的内部键（`__reactFiber$…`），往上走几层拿到 `filePath`，
拿不到就用同一层的 `cwd` 自己拼：

```
d6: filePath=D:\deepseek harness\pulse-android\app\java\com\pulse\remote\Downloader.java
d7: cwd=D:\deepseek harness
```

读别的库的内部结构是要付代价的，所以加了三道闸：

1. **解析结果必须和这一行印的名字对得上**（basename 相等），否则**不加控件** ——
   猜错时退化成"没有按钮"，绝不退化成"下载了另一个文件"；
2. 往上走有层数上限，拿不到就当作没解析出来；
3. 解析不出来的链接会打上 `data-pulse-file-link-unresolved`，所以"没按钮"和"根本没看过"
   永远区分得开 —— 手机上的**自检面板**会直接念出来（「会话文件路径: 37 处已加下载/转发 ✓」）。

验证（`scripts/verify-file-link-action.mjs`，14 项）分两半：

| 一半 | 验什么 |
|---|---|
| 夹具（手工造 fiber props，跑手机的 UA） | 取 prop、只有 cwd 时拼路径、本来就是绝对路径、props 与行文字不符时退回 cwd、什么都没有时拒绝注入、行号后缀不影响、手机端是 `share=1` +「转发」 |
| 真实对话（桌面宽度） | **37 处文件路径，37 处都加上了**，每一条的 href 都逐个核对过文件名 |

自检：把"props 必须和行文字同名"那一句去掉，**1 项立刻变红**。

> 两个诚实的补充。**(a)** 结尾还有一次 basename 兜底检查，单独去掉它**不会**让任何断言变红 ——
> 真正干活的是取 prop 时那次比较，兜底只是让函数在任何分支下都不会返回错的值；这一点是变异
> 测试试出来的，不是设计出来的。**(b)** 真实对话那一半必须在**桌面宽度**下跑：手机宽度下会话是
> 虚拟滚动的，一屏可能根本没挂载任何工具行，探针会数到 0 —— 那是客户端的性质，不是注入器的。
> 所以那一半拿不到工具行时输出 `--` 并说明原因，而不是假装通过。

#### 打开文件之后，在头部给一个鲜艳的按钮

**这里换过两次，两次都是用户说了算。**

第一版把「下载 / 转发」**文字**放在文件树每一行的右边 —— 二十行的侧栏从上到下重复同一个词，
用户的原话是"右边全部是转发的，这个字很难看"。第二版改成图标，好一些，但仍然是**一列重复的记号**
在跟文件名抢位置。第三版（现在的）按用户的要求搬走了：

> "右侧文件里的分享不要直接加，点进去之后在一个鲜艳的地方加一个分享按钮。"

于是：**文件树一行都不加**，改成打开某个文件之后，在**那个文件自己的头部**里放一个按钮。
这也确实是对的时刻 —— 到那时文件已经被选中了，一个明确的按钮胜过二十个含糊的。

```html
<div class="dhJKeW_header">
  <div class="dhJKeW_path" title="D:\deepseek harness\lib\ui.js" data-textpreview-path="true">…</div>
  <span><button class="dhJKeW_tool" aria-label="打开方式">代码</button></span>
  <button class="dhJKeW_tool" data-textpreview-tool="wrap">…</button>
  <button class="dhJKeW_tool" data-textpreview-tool="reload">…</button>
  <!-- 我们插的按钮在这里，头部最后一个 -->
</div>
```

**路径是官方直接给的**：`data-textpreview-path` 标记的元素上，`title` 就是绝对路径，
文字查看器和图片查看器**共用同一个头部**（探针两种都打开验证）。不用 React 内部结构，
也不用从可访问名里猜。

两个细节是**量出来的，不是拍出来的**：

1. **颜色用 `--dsw-alias-link` 而不是 `--dsw-alias-brand-primary`。** 名字上"品牌色"更像正解，
   但在这个客户端里 `--dsw-alias-brand-primary` 解析成 **rgb(15,17,21)**（近黑），
   做出来的药丸就是一枚深色小方块，跟旁边那排灰色图标分不出来。`--dsw-alias-link` 是
   **rgb(65,118,230)**，真正鲜艳；用 token 而不是写死颜色，换主题也跟着换。
2. **390px 下必须让路径缩。** 探针一开始只断言"按钮在 DOM 里、在头部里"，全绿；
   可截图里根本看不见它 —— 头部那行不肯让位，药丸被挤到屏幕外。现在多一条几何断言：
   按钮右边缘必须在视口内、头部 `scrollWidth` 不许溢出。`flex:none` + 头部可缩，
   路径用省略号让位（截图里是 `…cripts\verify-preview-action.mjs`）。

#### 「有的文件要再点一个按钮才出来」（已修：观察器只看了子节点）

用户反馈：**部分文件**点进去没有按钮，得先点一下头部的别的按钮它才出现。原因在自己身上，
而且是同一个坑的两半：

```
头部先带着「传进来的路径」挂载（相对路径）   → 我们判定"解析不出来"，打标记、不加按钮
稍后 React 把 title 就地改成解析好的绝对路径  → 这是**属性写入**，不产生 childList 事件
观察器只监听 childList                       → 不会重跑，标记留着，按钮始终没有
用户点了别的按钮 → React 重渲染 → 终于有 childList 事件 → 按钮才出现
```

修法是把 `title` 也纳入观察：

```js
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });
```

探针为此加了一条**自校验**用例：先给夹具一个相对路径（断言不加按钮、有标记），然后
**只改 title、不动任何节点**，断言按钮自己出现、标记被清掉。旧观察器在这一步永远失败 ——
这正是那个"要点一下才出来"的 bug。另外按查看器种类各点开一次（代码 / 纯文本 / Markdown / 图片）：
这类 bug 的表现就是"有些文件"，所以按种类分别验证，失败时能点名是哪一个。

还有一条**否定式**检查：如果头部里的路径**不是绝对路径**（宿主没能解析这个文件，
头部会退回被传进来的相对路径），就**不给按钮** —— 因为宿主的文件路由对相对路径直接 400，
那样的按钮是个永远点不动的摆设。这种情况会打上 `data-pulse-preview-unresolved` 标记，
所以"没有按钮"和"根本没看过"仍然分得开。

探针（`scripts/verify-preview-action.mjs`，19 项）**真的去点**：点开一个图片、再点开一个文本，
读真实头部。另外几项不是靠点：手机端的差异（文案与 URL）用**覆盖 UA** 在能打开文件的页面上验，
相对路径的拒绝和"标题改了按钮要跟着改"用一个小夹具验（页面必须开着，所以它在 `web.close()` 之前跑
—— 这条一开始写在后面，报的是 "detached Frame"，一个把"没测到"伪装成"测过了"的错误）。

#### 按钮跟着头部走，不是只有"有没有按钮"（真页面上量出来的）

上面那条观察器修好之后还剩一个洞，**是探针自己抓到的**：头部挂载之后还会**再改一次路径** ——
同一份文件先以 `/` 的形式进来、后来被宿主规范成 `\`。原来的守卫是"这一行里已经有我们的按钮了吗"，
有就跳过，于是按钮一直开着**它出生时那个写法**：

```
头部 title：C:\Users\…\dsh-client-ui-deliverables\lib\client.js
按钮 href：…?path=C%3A%2FUsers%2F…%2Fdsh-client-ui-deliverables%2Flib%2Fclient.js   ← 对不上的那个写法
```

功能上"能打开同一个文件"，但那正是**"按钮指向的文件就是头部显示的那个"**这条断言存在的意义，
所以现在按钮自己记着**它当前代表哪个路径**（`data-pulse-preview-source`），标题一变就**就地改指向**
（同一个 DOM 节点，不闪），标题变回**解析不出来**时就把按钮**撤掉**（不能留个点不动的摆设）。
探针为此加了两条断言：换写法之后是**同一个节点**且 href/source 都跟着改；变回相对路径之后按钮消失、
标记回来。

这也是"**一条不能失败的检查没有价值**"的反面例子：这条断言之所以能抓到东西，是因为它比的是**逐字相同**。

#### 走官方 `/api/file`，不是我们自己的白名单

第一版把按钮接到了插件自己的 artifact 路由（**只服务 agent 写出来的文件**）。听起来更安全，
实际是错的：**APK 是脚本构建的，不在白名单里** ——

```
/api/artifacts/content?path=...pulse-remote.apk&download=1  →  403「只能读取 agent 刚生成的文件」
/api/file?path=...pulse-remote.apk                          →  200，41871 字节 ✓
```

现象就是「电脑上说无法下载、没有文件，手机上也分享不过去」，而**图片能成** —— 因为图片被 `present`
过、登记了。所以改成走**官方自己的文件路由**：客户端能打开的文件它就能读，权限模型完全一致，
没有新开口子。下载头由网关补（`downloadDisposition()`，只对自己生成的 `download=1` 生效，
不碰任何内联预览）。

**官方界面里没有这条路，不是漏点，是它本来就没有。** 右侧栏那个「在文件管理器中显示」要靠
**桌面外壳**去调系统文件管理器，浏览器里背后没有这个东西，
所以点了没反应。

能下载的是 **Pulse 自己的界面** `/pulse`，那里的 artifact 列表每条都带「下载」，是真实 https URL
加 `Content-Disposition: attachment`（实测 `status=200`、`filename="index.js"`、字节数正确）。

#### 侧栏那个「文件与下载」入口已经删掉了

它曾经是**唯一**能在手机上找到文件的路径：手机和电脑跑同一份文档，而手机外壳只在 ≤900px 激活，
所以入口只能走**自己一条注入行**（`filesEntryScript()`），不含宽度判断，两端都生效，
位置按侧栏和官方 footer 的实际矩形量出来。

**现在不需要了**：文件树本身每一行都有「下载 / 转发」（见上一节），用户在文件树里直接就能拿文件，
多一个入口只是多一个要维护的浮层。删掉的是它**整条注入行**、`filesEntryScript()` 本身，
以及只为它存在的 `scripts/verify-files-entry.mjs`。注入行从 7 条回到 6 条。

`/pulse` 控制台**没有删**：它还是决策闭环的落点（锁屏推送和常驻通知都深链到它），
只是不再有侧栏入口，需要时直接开 `/pulse`。手机端要真的把文件存下来，
仍然需要 App 侧的 `DownloadListener` —— Android WebView **完全没有下载能力**，
没有它点下载什么都不会发生、也不报错（详见 App 的 README）。

#### 顺手补了一个洞：图片从来没被登记

artifact 是从**工具调用**里认的（`observeToolCall`），而原来只认 `write`/`edit` 这类带单一路径的写工具。
**截图是跑脚本生成的**，唯一提到它的调用是 `present` —— 而 `present` 的文件在 `files: [{path}]`
数组里，**没人读**。实测：artifact 36 条、**图片 0 条**。所以任何文件列表都看不到你要的那张图。

现在 `files` 数组也会读（`artifactPathsFrom`），并要求**绝对路径**：`isServablePath` 回答的是
"是不是我们拒绝服务的位置"，对"要交给用户的文件清单"来说不够 —— 相对路径解析不到任何东西，
只会多一条点开就报错的死行。

### 顶部间距与左右边距（按参考微调）

两条都是先量再改，量出来的来源和直觉不一样：

| | 原来 | 现在 |
|---|---|---|
| 正文左右内缩 | 32 / 42px | **20 / 22px** |
| 正文宽度 | 316px | **348px** |
| 页头高度（条与正文之间的距离） | 76px | **86px** |

- 内缩既不在滚动区上也不在正文上，而在 **`EvIC1a_scroll`** 上（`padding: 16px 32px`），
  它的直接子节点正好是正文列（`_column`）。所以用 `:has(> [class*="_column"])` 按**结构**定位，
  不写模块哈希。
- 左右不对称（32 对 42）不是官方偏心，是**滚动条占位**：滚动区 388px 里只放得下 380px。
  一个只在右侧出现的 10px，看起来就是「右边距比左边宽」。触屏上滚动条不携带信息，隐掉。
- 「太紧凑」补的是**页头的下内边距**，不是滚动区里的间距——滚动区里的间距会跟着内容滚走，
  页头上的不会。

### 一次事故：换行被删掉（已恢复）

我在删两个无用常量时用了 PowerShell 的 `Set-Content -NoNewline`，它**把整个
`lib/mobile-shell.js` 的换行全部吞掉**，46552 字节变成**一行**。

**为什么这比看起来危险**：文件**仍然能被 import**（块注释和模板字面量不需要换行），
13 个导出一个不少 —— 但生成的脚本里 `//` 注释**靠换行结束**，没有换行就把后面的代码全吃掉了，
浏览器里直接 `SyntaxError`。也就是说：**语法检查通过、测试全绿，而线上是坏的**。

没有 git、没有备份。恢复办法是：**运行中的进程里存着上一版有效的注入内容** ——
外壳样式（297 行）、外壳脚本（455 行）、文件入口（82 行）都是完整的，把它们的**字面量还原成插值**、
把反斜杠加倍（它们要放进模板字面量），再补上手写的交付卡片那一段，重建出模块。

**教训写在这里**：永远不要对源码用 `-NoNewline`；带反引号的编辑不要走 PowerShell
（同一晚它还吃掉过一次模板字符串里的反引号）。恢复过程里 `900px → ${TABLET_MAX_PX}`
少了个 `px` 单位，媒体查询变成 `max-width: 900`，**整个手机样式表静默失效** ——
这个是被真浏览器验证抓回来的，不是被测试。

## 安全模型

说清楚这个插件开了什么口子，因为配对后的手机等于拿到了你电脑上的 Harness。

### 凭据是怎么来的（`lib/bootstrap.js`）

官方 GUI 用 HMAC 签名的 cookie 鉴权，密钥在 `~/.dsh/.credentials.yaml`。Pulse 走的是一条**受官方支持的路径**，不是私有后门：

1. 通过 `connection.authenticatedUrl(base)` 拿到本进程带启动 token 的根 URL
2. **从回环**发起换取请求，把 `Host`/`Origin` 改写成内环回 authority——cookie 的 authority 绑定因此正好是代理后续会一直出示的那个
3. 持有的 cookie **只留在本进程**，随每个代理请求服务端附加

**启动 token 从不发给手机**，手机只拿到自己那份签名会话 cookie。

### 未配对时暴露什么

- 只有配对门禁页面（一段静态 HTML）和 `/health`
- 其余一律 401，**连「Harness 是否在跑」都问不出来**
- 配对与管理端点（`/api/local/*`）需要一个只在本机文件系统上的令牌（见下）

### 为什么管理端点不能靠「只允许回环」

推荐部署里，手机是通过 SSH 反向隧道（`ssh -R 3199:127.0.0.1:3199`）打到 Pulse 的。
代价是：**隧道过来的每一个请求，来源地址都是 `127.0.0.1`**，和本机进程完全一样。
所以「来源是回环」在这套部署里等于「全世界都是本机」——曾经真的如此，
任何人只要扫到公网 IP，就能申请一个配对码、配一台自己的设备，然后拿到你电脑上的 Harness。

现在管理端点要同时过三道闸（`lib/server.js#localDenial`）：

| 闸 | 挡住什么 | 攻击者能不能满足 |
|---|---|---|
| socket 是回环 | 误把 host 配成 `0.0.0.0` 的部署 | 隧道下天然满足，所以不算数 |
| `X-Forwarded-For` 最后一跳是回环 | 从公网边缘进来的请求 | 不能：nginx 用 `$remote_addr` 覆写，客户端自己塞的值会被冲掉 |
| `x-pulse-local-token` 正确 | 其余一切 | 不能：令牌只在 `DSH_HOME/remote-pulse/local-token`，从不出现在任何 HTTP 响应里 |

令牌**故意不经过任何 HTTP 路由下发**，也不会被渲染进页面——能被隧道取走的令牌等于没有。
所以本机管理只能由本机脚本做（`scripts/pair-qr.mjs`、`scripts/devices.mjs`）。

`test/server.test.js` 与 `scripts/verify-remote.mjs` 都盯住这条线：**带着正确令牌**从公网边缘打管理端点，
也必须被拒。

### 暴力破解

限流按「边缘看到的客户端」计数，而不是 socket 地址——隧道下 socket 全是回环，
按 socket 计数等于把整个互联网放进同一个桶，还会让一个攻击者把真正的用户锁在门外。

出示**空凭据**不算一次失败：配对后的手机用会话 cookie 鉴权，本来就不带 Bearer 令牌，
早先把「带了空凭据」记成失败，会在几次请求之后把所有正常设备锁掉。

### 已知取舍

- 配对 = 完全信任。这台手机能批准工具调用、读写工作区。只配对你自己控制的设备
- 局域网走 HTTP（非安全上下文），此时浏览器不发 Service Worker，重开页面需重新加载
- 公网务必配隧道，别直接把 3199 暴露出去
- 锁屏通知需要安全上下文：自签证书 + 裸 IP 在多数手机浏览器上不算安全上下文，
  推送会被拒。要这个功能就得买域名 + 用受信任证书
- 本机管理需要一个本机进程（脚本）。这是刻意的：管理动作不该能从公网做

## 开发

```sh
npm test                              # 260 个测试
node scripts/drive-pairing-page.mjs   # 用 jsdom 跑真实页面并点击按钮
node scripts/verify-remote.mjs https://你的地址 --insecure   # 端到端，含公网边缘必须拒绝管理端点
node scripts/verify-push-live.mjs https://你的地址 --insecure # 推送面 + 一键决策 worker + 管理端点围栏
node scripts/verify-mobile-layer.mjs http://127.0.0.1:3199    # 窄屏层已注入 + 官方类名锚点没漂移 + 每一行都是磁盘上那份
node scripts/check-scripts.mjs                                # 每一段注入脚本都能编译、且没有会截断模板的反引号
node scripts/verify-header-actions.mjs                        # 页头模式 chip 搬进页签行 + 弹层不许压页头（18 项）
node scripts/audit-phone-header.mjs --session warden           # 真会话上量一遍：两行各占多宽、子代理面板落在哪（诊断用）
node scripts/verify-preview-action.mjs                        # 打开文件后头部那个下载/转发按钮（19 项）
node scripts/verify-file-link-action.mjs                     # 对话里虚线下划线文件路径的下载/转发（14 项）
node scripts/verify-deliverable-action.mjs                   # 交付卡片 + 折叠的「交付文件」那一行（34 项）
node scripts/audit-present-row.mjs                            # 真会话上量一遍：那一行/那张卡片到底在不在屏上（--ua phone --layer）
node scripts/verify-engine-floor.mjs http://127.0.0.1:3199    # 官方客户端要求的最低浏览器版本 vs App 里声明的
node scripts/verify-real-agent.mjs    # 真实 agent 写真实文件，验证产物被记录（会调一次模型）
node scripts/preflight.mjs https://你的地址 --insecure        # 幂等部署自检，可挂定时任务
node scripts/smoke.mjs                # 真 HTTP：配对、SSE、决策、撤销
```

| 测试 | 覆盖 |
|---|---|
| `test/distill.test.js` | 压缩引擎：折叠、摘要、失败、时长、边界 |
| `test/decisions.test.js` | 决策队列：超时、断开、校验器收口、abort |
| `test/auth.test.js` | 配对、令牌哈希、吊销、限流、空凭据不算失败 |
| `test/local-token.test.js` | 本机管理令牌：随机性、重启后复用、坏文件重建、不可写时降级 |
| `test/artifacts.test.js` | 产物索引：只认写类工具、拒绝名单、**任意路径不可达**、截断与上限、落盘往返 |
| `test/lock-screen.test.js` | 一键决策：哪些决策给按钮、token 边界、worker 与插件必须对同一份答案达成一致 |
| `test/mobile.test.js` | 窄屏层：不会破坏解析、全部规则有 media 作用域、不用模块哈希、锚点都被用到 |
| `test/mobile-shell.test.js` | 手机外壳：抽屉、汉堡、自检面板、页头布局（模式 chip 的落点算术、找不到页签行时不乱搬、放大后要还回去、弹层竖直夹取），以及**折叠的「交付文件」那一行**上的下载/转发（含"点它不会顺手展开那一行"的活计数器） |
| `test/generated-client.test.js` | **编译真正下发的那份产物**：客户端脚本与 worker 必须能解析（模板字面量里的一个反引号就会截断它） |
| `test/ring.test.js` | 环形缓冲、续传、缺口上报 |
| `test/gateway.test.js` | 凭据换取、Header/cookie 改写、**真实 TCP WebSocket 隧道** |
| `test/server.test.js` | 门禁、会话 cookie、代理分流、SSE、whoami、**管理端点三道闸**、产物路由白名单 |
| `test/pairing-client.test.js` | 真实门禁页 + 真实客户端脚本跑在 jsdom 里：扫码自动配对、竞态点击、错码重试 |
| `test/push.test.js` | Web Push：订阅归一化、失效清理、5xx 保留、worker 内容 |
| `test/scripts-encoding.test.js` | 脚本编码：PS 5.1 需要 UTF-8 BOM、禁用 7.x 语法、Node 脚本不带 BOM，以及**注入模板里不许有反引号**（同一个坑踩了七次，第七次是修第六次时踩的，所以现在是**读源码文本**来查，并自带"种一个反引号进去必须能报出来"的自校验） |
| `test/plugin.test.js` | host 插件：answerer 两条路径、指令投递、注入授权、产物记录、**监听器不依赖 web 服务** |

### 一次事故：PowerShell 把整个文件的编码吃掉（已恢复）

改两行观察器配置时用了 `Get-Content` + `WriteAllLines`，于是 PowerShell 按**系统 ANSI 代码页
（GBK）**读了 UTF-8 的源码，又按 UTF-8 写回去 —— 正是这份 README 下面「六个踩过的坑」
里写着的那一条，还是踩了。ASCII 代码没受影响，**所有中文文本变成了乱码**，并且有些字节
被 GBK 解码器吃掉了（`）`、`—`、`'` 这些紧跟其后的字符），模块直接语法错误。

恢复过程（可复现，也值得记）：

1. **反转变换**：把文件按 UTF-8 读成字符串 → 用 GBK 编码回字节 → 再按 UTF-8 解码。
   合法序列一比一还原，所以**除了被吃掉的字节，其余文本逐字回来**（`下载`/`转发` 都在）。
2. **按上下文补回被吃掉的地方**：每个损坏点形如 `<FFFD>?`，它代表"前一个字符的尾字节 +
   紧跟的一个字节"两个字节。全文件共 62 处，每一处都能从句子本身读出来（`— ` / `）'` /
   `时 ` / `按钮'` …），于是写成一个**逐条计数**的替换表：任何一条匹配不到就报错，
   替换完断言文件里不再有 U+FFFD。
3. **用测试验收**，不是用眼睛：`mobile-shell.test.js` 与四个浏览器探针断言的就是那些
   用户可见字符串（自检面板全文、`下载`/`转发`……），250 项测试 + 四个探针全过才算恢复。

教训一句话：**不要让 PowerShell 解码你的文件。** 编辑文本用文件工具；必须用脚本时，
显式指定 `[System.Text.Encoding]::UTF8`，并且只用 `ReadAllBytes`/`ReadAllText`/`WriteAllText`
这类不依赖默认编码的 API —— `Get-Content` 和 `Set-Content`/`WriteAllLines` 都会带上默认代码页。

### 六个踩过的坑（都留了测试或脚本防复发）

1. **`ctx.webServer` 在 `inject` 门禁外读取会静默返回空**，导致内环回端口退化成默认 3080。服务必须在 `ctx.inject(['webServer','connection'], injected => …)` 里捕获，且 authority 要惰性解析（服务在持有者构造之后才可用）。
2. **`proxyUpgrade` 必须显式 `upstream.end()`**。不调用 `end()` 时请求根本没有发出，Node 也不会报错——表现为「界面能开但永远不更新」。
3. **门禁页的 JS 曾一启动就崩**：`setConn()` 无条件写 `el('conn').dataset`，而门禁页没有 `#conn`，异常直接打断了 `init()`，导致 submit 监听器从未挂上（按钮点了毫无反应且无报错）。现在客户端脚本的验证方式是 `scripts/drive-pairing-page.mjs`，不是只测接口。
4. **「来源是回环 = 本机」在反向隧道下是错的**。隧道让公网请求也来自 `127.0.0.1`，
   于是基于来源地址的围栏等于对全世界开门。这个洞是我自己跑验证脚本时撞出来的
   （`POST /api/local/pairing` 从公网返回了 200 和一个真配对码），修法是本机令牌 + 边缘跳数双重判定。
   教训：**地址不是身份**——只要中间隔了一层转发，就该用只有本机拿得到的东西来证明本机。
5. **把监听器注册在 `inject` 门禁里 = 在没有 web 服务的 profile 里静默失效**。Cordis 的门禁没打开时，
   回调不会跑，于是插件加载了、状态目录建好了、然后**什么都没观察**。更糟的是 `servicesReady` 永远不
   settle，`start()` 卡在 `await` 上——`ready` 永不完成，表现为「无声无息」。修法：监听器无条件先注册
   （它本来就不需要任何注入的服务），等服务改为**有上限**的等待 + 明确告警。
6. **生成的脚本才是真正下发的产物**。`lib/ui.js` 用模板字面量拼客户端脚本，模板里一个反引号就会把它
   提前截断——`lib/ui.js` 本身语法没错，手机上却是一段坏脚本。`test/generated-client.test.js` 直接
   **编译生成结果**，而不是只检查源文件。

## 实测记录

### 真机验证（已通过，2026-09-25）

真实手机 + 真实 DSH + 腾讯云服务器 + SSH 反向隧道 + nginx 自签 HTTPS 的完整链路上验证通过：

```
手机浏览器 ──HTTPS──> YOUR_HOST:443 (nginx)
           ──SSH 反向隧道──> 你的电脑 127.0.0.1:3199 (Pulse)
           ──loopback 代理──> 127.0.0.1:3181 (DSH GUI)
```

`scripts/verify-remote.mjs` 对部署后的公网地址验证 26 项，全部通过：

- 未配对根路径是门禁，**不含** Harness 外壳
- **带着正确本机令牌**从公网边缘打管理端点，全部 403，一个配对码都不吐
- 配对返回会话 cookie，用它访问 `/` 拿到的是**真正的 Harness GUI 外壳**
- Harness 自己的 `dsh-auth-*` cookie **不会**转发给手机
- 吊销后立刻退回门禁，且无法再调用 Harness API

`scripts/verify-push-live.mjs` 验证 19 项推送面检查，全部通过：`/health` 报推送就绪、
`/sw.js` 是推送 worker（无 fetch handler、`no-store`）、`/api/push/key` 返回合法 VAPID 公钥（87 字符）、
未授权订阅被拒、管理端点从公网边缘被拒且不产生配对码。

### 真实 agent 会话（已通过）

真实 DSH `0.1.5-rc.3` + 真实模型凭据，实测帧流：

```
{"kind":"session",   "text":"Pulse 已就绪（本机）"}
{"kind":"session",   "text":"开始工作","ref":{"status":"running"}}
{"kind":"turn-start","text":"开始处理","ref":{"turn":1}}
{"kind":"activity",  "text":"执行命令 echo hello","ref":{"group":"command"}}
{"kind":"activity",  "text":"读取 dsh-remote-pulse/package.json","ref":{"group":"read"}}
{"kind":"turn-end",  "text":"任务完成 · 8 秒 · 2 次工具调用 · 执行命令1、读取1",
                     "ref":{"turn":1,"outcome":"done","tools":2}}
```

确认了三件此前只靠类型契约断言的事：`tool/call` 的 `callId` 与 `tool/result` 的 `toolCallId` 正确配对、`turn/end` 的 `reason` 取值落在预期分支、session id 解析出非空值。

### 页面级验证（这是最该早做的一步）

`scripts/drive-pairing-page.mjs` 用 jsdom 加载**服务器实际吐出的 HTML + JS**，模拟点击配对按钮，抓取网络请求和控制台异常。

这个脚本的存在本身是个教训：服务端接口一直是好的，而 bug 在页面上——所以只测接口会得出「一切正常」的错误结论。

它随后就抓到了第二个同类问题：扫码链接会在加载时**自动提交**配对，用户这时再点一下按钮，
第二个请求到达时那个一次性配对码已经被用掉，服务端**正确地**回「配对码已失效」，
于是页面在一个**已经配对成功**的结果上盖了一条失败提示。
现在提交有重入保护（`state.pairing`），失败才释放——`test/pairing-client.test.js` 钉住了这条。
同一个文件还钉住了一个更隐蔽的同类问题：`renderOutbox()` 在门禁页的提前返回**之前**无条件执行，
而门禁页没有那些节点，写 `textContent` 直接抛异常。所有按 id 写入现在都走 `setText()`。

### 尚未验证

- 手机上的**实时流表现**（WebSocket 在移动网络下的稳定性）还没长时间观察
- **锁屏通知的真机到达**没验证：需要域名 + 受信任证书才能拿到安全上下文
- **`approval/request` 与 `user-questions/request` 的真实触发**没跑到。需要 agent 主动请求授权或提问；逻辑有仿真 context 的单测覆盖（含「无手机时零行为变化」和「超时/断开交回桌面端」两条路径）
- 多问题请求目前只回答第一个，其余回空数组由 agent 继续追问
- 官方 GUI 在窄屏上的**排版体验**未评估（官方桌面布局，未做移动端适配）

复现真机回归（需模型凭据）：

```powershell
$liveHome = "D:\deepseek harness\.dsh-pulse-live"
New-Item -ItemType Directory -Force -Path "$liveHome\profiles\web","$liveHome\profiles\node_modules" | Out-Null
Copy-Item "$env:USERPROFILE\.dsh\.credentials.yaml" "$liveHome\.credentials.yaml"
New-Item -ItemType Junction -Path "$liveHome\profiles\node_modules\dsh-remote-pulse" `
  -Target "D:\deepseek harness\dsh-remote-pulse"
# 按上面折叠块说明登记 bundle，然后：
$env:DSH_HOME = $liveHome
dsh --profile web --no-open --port 3171
node dsh-remote-pulse\scripts\verify-remote.mjs http://127.0.0.1:3199
```

`headless` profile 的 bundles 里没有本插件；要在 headless 里跑需用 `--patch` 叠加层注入。

## 许可

MIT
