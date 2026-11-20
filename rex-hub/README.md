# Rex Hub · 模块聚合与分发

**当前版本：`0.0.9`**

可选 **[Docker 自托管](./DOCKER.md)** 或 **[Cloudflare Worker](#一键部署到-cloudflare)**。下面的免费额度提示只适用于 Cloudflare 版。

> [!WARNING]
> **部署前看免费额度，避免超支。** Workers Free：每账号 **100,000 次 Worker 请求/日**（上海时间每日 08:00 重置，即 UTC 午夜），每次调用最多 **50 个子请求、10 ms CPU**。Workers KV Free：每天 **100,000 次读取、1,000 次写入、1,000 次删除、1,000 次列表操作**，存储 **1 GB**。这些不是每套 Rex Hub 单独拥有的额度；模块、徽章图片、PWA 访问和账号的其他项目会消耗相应配额。`pppboom-adult.json` 含 1,556 条图片规则，大包首次托管可能跨日。免费方案到限额时请求可能失败；如果账号是付费方案，超出包含量可能计费。建议先用上游直链、降低检查频率，并在 Cloudflare 控制台查看用量，别把应用内批次当成账单上限。[Workers 限额](https://developers.cloudflare.com/workers/platform/limits/) · [KV 定价和免费额度](https://developers.cloudflare.com/kv/platform/pricing/)

把多个 Rex 模块或 `.rex` 合集拆开、重新分类，再生成一个或多个固定分发链接。支持上传文件、上游直链或下载托管、按来源和模块设刷新间隔、发布预览，以及在后台修改管理员密码。

[在线界面展示](https://zxxlxj.github.io/rex-m/)（模拟数据，仅供展示）

## Docker 成品镜像

公开镜像，无需登录 GHCR，支持 `linux/amd64` 和 `linux/arm64`：

```bash
docker pull ghcr.io/zxxlxj/rex-hub:0.0.9
```

启动命令和 NAS／HTTPS 配置见 [Docker 部署说明](./DOCKER.md)。

## 一键部署到 Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fzxxlxj%2Frex-m%2Ftree%2Fmain%2Frex-hub)

1. 点击按钮并登录 Cloudflare，授权连接 GitHub。Cloudflare 会把 `rex-hub/` 作为独立项目复制到**你自己的仓库**，不会改动原仓库或共用别人的数据。
2. 确认 Worker 名称、D1 数据库及 Workers KV 命名空间。资源由 Cloudflare 自动创建并绑定，**无需开通 R2**。保留部署命令 `npm run deploy`，它会先应用 D1 迁移，再部署 Worker。
3. 如页面要求 `SETUP_TOKEN`，填入你自己生成的随机令牌（例如在终端运行 `openssl rand -hex 32`）。如果部署页没显示该项，部署后到 **Workers & Pages → 你的 Worker → Settings → Variables and Secrets**，添加一个名为 `SETUP_TOKEN` 的 **Secret**。不要使用示例值，也不要把令牌提交到 GitHub。
4. 部署完成后打开 `workers.dev` 地址，粘贴初始化令牌，并设置至少 **12 个字符**的管理员密码。**没有默认密码**。初始化成功后，可删除 `SETUP_TOKEN`；之后只用管理员密码登录。

## 发布一个合集

1. 在「来源」导入公开 HTTPS 地址，或上传 `.js` / `.rex.js` / `.rex`。展开来源即可给每个模块单独分类。上传的 `.rex` 是清单，不包含脚本；相对路径需要原始基础 URL 或同时上传对应脚本。
2. 选择「上游直链」或「下载托管」。选托管时，Hub 实际下载模块文件；首次下载完成后才可发布。上游失败时保留上次成功的文件。只镜像你有权重新分发的模块，勿上传凭据或私人脚本。
3. 在「分发」按分类、来源或模块选入内容，设置图标，可自行指定 key，也可留空随机生成。点「保存并发布」，复制 `/s/<key>.rex` 链接到 Rex 的模块导入入口。
4. 已启用并发布过的分发会自动跟随已发布规则：符合规则的导入、分类调整、审核通过、检查和删除都会更新链接，无需再次点发布。待审核、首次下载未完成或存在冲突的内容不会强行发布。来源列表右侧可立即检查，顶部多选可批量检查或删除；超出单次处理上限的检查会排队，由定时任务继续完成。
5. 更新频率、审核策略与默认图标可在「设置」调整，来源和托管模块可单独覆盖。Worker 每 5 分钟分批检查到期任务；这是服务端检查，不等于 Rex App 会自动重拉合集。短 key 可被猜到，不要把分发当成私密存储。

## 来源分类与 Rex 内容类型

来源页可切换到「分类」，点「全部」「未分类」或其他分类小标签，并结合模块声明和关键词筛选，可多选或全选筛选结果，一次调整分类，也可在这里新增、重命名或删除分类。Hub 保留 [Rex 官方声明](https://modules.rexnow.app/guide/#content-type) `video`、`music`、`audiobook`、`shortDrama` 和可选的 `continuousPlay`，不改写上游脚本或最低引擎版本。未声明类型的模块保持未指定；仅旧清单直链且没有提供类型时，Hub 不猜测脚本内容。依赖这些类型的模块需要 Rex 0.0.7 脚本引擎支持。


### 自动分类

在「来源 → 分类 → 管理分类」展开某个分类，开启自动分类并保存规则。可多选 Rex 声明类型，也可填写模块名称、模块作者、来源名称和来源作者。不同字段同时满足才算命中；同一字段内用逗号分隔的关键词满足任意一个即可，不区分大小写。启用后立即重算原有和新增模块。手动指定的分类优先，其次取列表里第一个命中的自动分类，最后才沿用新增模块的默认分类或来源默认分类。清除模块的手动分类可恢复自动匹配。

在线导入、同步及托管下载的单个模块或合集上限为 8 MiB；上传单文件上限为 8 MiB，同批文件总计最多 16 MiB。

## 徽章包

在「徽章」中粘贴多个 JSON 地址（每行一个），或一次选择多个本地 JSON 文件。可用页面内唯一的「戏精俱乐部 · 普通版」预设，也可以在 [xijing-club](../xijing-club/README.md) 复制资源卡片配置地址。`icons.json` 是图标库，不是徽章包。

- 可改别名、按分组和关键词预览，并选择一套生效。发布地址始终为 `https://你的域名/badge.json`；直链模式重定向到上游，托管模式返回原格式 JSON，并将图片地址改为本 Worker。到 **Rex → 设置 → 外观与交互** 导入资源卡片配置，切换后如客户端没有刷新功能，重新导入固定链接。
- 托管会分批下载图片，全部就绪后才能启用；失败项可重试。大包可能受账户 KV 日配额影响，需要跨日完成。删除会立即撤下该包，并在后台分批删除 JSON 和已下载图片；切回直链也会清理旧托管图片。
- 删除模块来源会立即从已发布合集撤下该来源的条目；不再被其他来源或已发布快照引用的托管脚本会同步删除或在后台补清理。已被客户端下载的文件不会从客户端移除。

## 手动部署（可选）

安装 Node.js 22+，进入本目录：

```sh
npm ci
npx wrangler login
npx wrangler d1 create rex-hub
npx wrangler kv namespace create rex-hub-files
```

把创建结果中的 D1 `database_id` 和 KV `id` 填到 `wrangler.toml`。如 `rex-hub` 已有其他用途，请改用新 Worker 名及新的资源名称，不要覆盖原实例。然后执行：

```sh
npm run deploy
npx wrangler secret put SETUP_TOKEN
```

最后用 `wrangler secret put` 交互输入自己生成的令牌。若使用自定义域名，建议在**第一次导入前**设置 Worker 变量 `PUBLIC_ORIGIN` 为该域名的 HTTPS 源站地址（不带路径）。Cloudflare 用量和收费以你的账号方案及配额为准。

## 时间与日志

后台时间统一显示为上海时间（UTC+8）。同步日志保留最新 200 条，每页 50 条。Cloudflare 的配额仍按其官方重置时间计算。

## 安装到 iPhone 主屏幕

用 Safari 打开自己的 Rex Hub：**分享 → 添加到主屏幕**，如有「作为网页 App 打开」则保持开启。支持独立窗口、顶部状态栏和底部安全区。PWA 只缓存界面外壳，不缓存密码、管理 API、分发或徽章；管理和同步仍需要联网。

## 本地开发

```sh
npm ci
npm test
npm run db:local
npm run dev
```

将 `.dev.vars.example` 复制为 `.dev.vars`，填写本地 `SETUP_TOKEN`；本地 HTTP 开发需要时可以另外设 `AUTH_ALLOW_INSECURE_LOCALHOST=1`。不要将 `.dev.vars` 提交到仓库。

Rex Hub 自有代码采用 [MIT 许可证](./LICENSE)，允许在保留版权与许可声明的前提下使用、修改、分发及商用。第三方依赖、Rex 标志及参考角色素材不因本许可改变原有权利。这份许可不覆盖仓库内其他项目。

Rex 标志来自 [Rex 官方模块站](https://modules.rexnow.app/)，用于标识兼容平台；Rex Hub 并非 Rex 官方产品。
