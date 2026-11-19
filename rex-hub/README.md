# Rex Hub · 模块聚合与分发

把多个 Rex 模块或 `.rex` 合集拆开、重新分类，再生成一个或多个固定分发链接。支持上传文件、上游直链或下载托管、按来源和模块设刷新间隔、发布预览，以及在后台修改管理员密码。

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
4. 更新频率、审核策略与默认图标可在「设置」调整，来源和托管模块可单独覆盖。Worker 每 5 分钟分批检查到期任务；这是服务端检查，不等于 Rex App 会自动重拉合集。短 key 可被猜到，不要把分发当成私密存储。

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

## 本地开发

```sh
npm ci
npm test
npm run db:local
npm run dev
```

将 `.dev.vars.example` 复制为 `.dev.vars`，填写本地 `SETUP_TOKEN`；本地 HTTP 开发需要时可以另外设 `AUTH_ALLOW_INSECURE_LOCALHOST=1`。不要将 `.dev.vars` 提交到仓库。

Rex 标志来自 [Rex 官方模块站](https://modules.rexnow.app/)，用于标识兼容平台；Rex Hub 并非 Rex 官方产品。
