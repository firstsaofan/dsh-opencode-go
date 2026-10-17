# 安装与验证

> English version: [install.md](install.md).

给一台从没跑过这个插件的机器：装什么、怎么确认装上了、没装上怎么办。
每条命令都是给人读的，或者给一个替人操作这台机器的 agent 读的，按顺序执行并阅读结果。

覆盖三条安装路径。**A 路是这个 fork 存在的理由**——你要装的是一棵工作树，不是一个发布过的包，
因为你要的改动不在 npm 上。

## 开始之前

| 需要什么 | 怎么确认 | 不满足时 |
|---|---|---|
| Node.js ≥ 20 | `node -v` | 装 Node 20 或更新 |
| `pnpm` 在 harness 的 PATH 上 | `pnpm -v` | `dsh plugin add` 会转发给 pnpm，没有它 add 会失败 |
| OpenCode Go 订阅 | [console](https://opencode.ai/console) | 线路会回 `401`——插件能加载，但没有一个模型能用 |
| 该订阅的 API 密钥 | console 的密钥页 | 见[给它一个密钥](#给它一个密钥) |

## A 路——装这棵工作树（这里通常用这条）

```sh
git clone https://github.com/firstsaofan/dsh-opencode-go.git
cd dsh-opencode-go
dsh plugin --profile web add .
```

末尾的 `.` 就是全部机制：`dsh plugin` 把参数转发给 profile 目录里的 pnpm，
pnpm 把这个 checkout 记成 `link:` 依赖；而因为 `package.json` 声明了
`dsh.bundle.patch`，DSH 会把它追加进 `dsh.profile.bundles`，于是它成了一个配置层，
而不是一个游离的依赖。

这条路径的三点：

- **必须在仓库根目录执行。** 相对路径以你所在的目录为锚点，所以 `add .` 指的是"这个 checkout"。
- **checkout 不能挪走。** `link:` 目标一旦移动，profile 就断了。
- **改代码后要重启才生效**，不是 reload。改代码、重启、完事——边改边用的时候选这条路，
  理由就是这个。

然后**完全重启 profile**：bundle 层只在启动时读。

```sh
dsh --profile web
```

## B 路——从你的 fork 按固定 commit 安装

用在你要一份精确、可复现的副本，而不是一棵活的 checkout 的机器上。

```sh
dsh plugin --profile web add github:firstsaofan/dsh-opencode-go#<40 位 commit>
```

**pin 住 commit。** 用分支引用意味着每次重装都可能解析到不同的代码，
这正好和"固定安装"的目相反。

这条路径不需要构建步骤，这在 DSH 插件里不常见：包把 `lib/` 直接提交进仓库，
也没有声明 `prepare` 脚本，所以 pnpm 在 `allowBuilds` 下没有任何东西需要拒绝。
另外值得知道的是 `github:` 装的是**源码**，所以一个需要构建的包会缺输出——这里不是问题。

## C 路——从 npm 安装

```sh
dsh plugin --profile web add dsh-llm-opencode-go
```

这装的是**已发布**的包，不是这棵工作树。只有当你有意要 upstream 的行为时才选它；
尤其 upstream 的 `healthCheck` 默认是 `off`，而本 fork 默认是 `both`
（见[接口健康](health.zh-CN.md)）。

## 验证

三步检查，从最便宜的开始，三步都是只读的。

**1. 路由注册上了。**

```sh
dsh --profile web --dump-config
```

在 bundle 列表里找 `dsh-llm-opencode-go`，并找一层 patch 指向本仓库的
`cordis.patch.yml`。

**2. 日志里出现了就绪行。** 启动 profile 并读日志：

```
dsh-llm-opencode-go: provider "opencode-go" ready at https://opencode.ai/zen/go/v1 (credential OPENCODE_GO_API_KEY, models discover)
```

其中两个字段要仔细看：**凭据引用**和**接口地址**。引用就是 `apiKeyEnv` 解析出来的那个名字——
下一节会说明为什么模型不回话时第一个该查的就是它。

**3. 接口可达，而且免费。** 在仓库根目录：

```sh
npm run probe
```

它发三个不可能生成任何内容的请求，然后打印每条线路的回答。**不需要密钥，不消耗额度。**
每一行都是 `alive` 就是成功——探针正常工作看起来就是一串拒绝，因为活着的线路和
下线的线路正是这样区分开的。各判定含义见[接口健康](health.zh-CN.md)。

## 给它一个密钥

要么在启动 DSH 的环境里导出变量，要么通过凭据接缝存进去——web 的 Models 页面会写它，
插件自己的设置页也会。插件**按请求**解析这个引用，所以两种都行，而且都不需要重启。

```sh
export OPENCODE_GO_API_KEY=...        # 必须和就绪行里的引用一致
```

**在做任何别的事之前，先核对引用名。** 默认值是 `OPENCODE_GO_API_KEY`，
但它就是个普通字段：

```yaml
config:
  apiKeyEnv: OPENCODEGO_API_KEY
```

**把密钥存在路由读不到的名字下，症状和密钥本身错了完全一样**——每个模型都回 `401`——
而就绪行正是用来区分这两者的。"密钥明明是对的却不生效"，绝大多数是这个原因。

## 首次配置

不需要任何必填项。默认值是：

| 字段 | 默认值 | 对你意味着什么 |
|---|---|---|
| `healthCheck` | `both` | **本 fork** 每六小时盯一次接口地址，并对实时拒绝做出反应。upstream 默认是 `off`，想要就设它 |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | 你的密钥在别的名字下就改这个 |
| `baseURL` | `https://opencode.ai/zen/go/v1` | 一条厂商已不再写进文档、但仍在服务的扁平根地址 |
| `modelSource` | `discover` | 模型列表从服务读取，不用手写 |

其余全部在[配置](configuration.zh-CN.md)。

## 装不上的对照表

| 症状 | 原因 | 怎么办 |
|---|---|---|
| `dsh plugin add` 报 pnpm 错误 | `pnpm` 不在 harness 的 PATH 上 | 把 pnpm 放进 PATH，重试 |
| add 成功了、profile 也起来了，但路由不存在 | 这个包没有被加成 bundle | `package.json` 必须声明 `dsh.bundle`；用 `dsh --profile web --dump-config` 查那一层 |
| 一切正常，`git pull` 之后就坏了 | checkout 被移动或删掉了 | `link:` 目标不能动 |
| 每个模型都回 `401` | 密钥不在路由读取的那个名字下 | 拿就绪行里的凭据引用和你导出的变量名对比 |
| 每个模型都回 `401` 且引用正确 | 密钥属于一个没有 Go 订阅的 workspace | 密钥是按 workspace 的，要在订阅了的那个里生成 |
| 只有部分模型 `404` | 那些模型换到别的协议上去了 | 设置页的**接口健康**一节会指出该用哪个根地址 |
| `400 MissingSessionID` | 网关开始要求 `x-opencode-session` | 不要设 `sessionHeader: off` |
| 长会话之后所有模型 `400` | 输出预算撞上上下文窗口 | `/compact`，或调低该模型的*最大输出* |

前两行是安装问题；之后全是配置问题，而[配置](configuration.zh-CN.md)那一页负责这个。

## 卸载

```sh
dsh plugin --profile web remove dsh-llm-opencode-go
```

然后完全重启 profile。注意 `link:` 方式的卸载**不会**删掉磁盘上的 checkout——
没有任何东西会替你删，也正因如此才不该删。