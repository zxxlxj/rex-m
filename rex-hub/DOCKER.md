# Rex Hub Docker 版

Rust + Axum + SQLite。与 Worker 版共用 UI、PWA 和图标，使用独立数据，不需要 Cloudflare、Node.js、Redis 或外置数据库。Docker 版不应用 Cloudflare 的每日请求或 KV 配额；仍有限制网络并发、请求超时和单文件大小。

## 直接运行（推荐，无需编译）

公开成品镜像支持 `linux/amd64` 和 `linux/arm64`，可匿名拉取。建议固定 `0.0.10`，不要依赖会变化的 `latest`。

```bash
docker pull ghcr.io/zxxlxj/rex-hub:0.0.10
umask 077
printf 'SETUP_TOKEN=%s\n' "$(openssl rand -hex 32)" > rex-hub.env

docker run -d --name rex-hub --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  --env-file rex-hub.env \
  -e PUBLIC_ORIGIN=http://localhost:8080 \
  -v rex-hub-data:/data \
  ghcr.io/zxxlxj/rex-hub:0.0.10
```

打开 `http://localhost:8080`，用 `rex-hub.env` 中的初始化令牌设置至少 12 个字符的管理员密码。没有默认密码。默认只监听宿主机回环地址；用手机访问 NAS 请按下节配置。已有环境文件时，不要再次执行生成令牌的命令覆盖它。

### HTTPS 访问、Rex 导入和 PWA

把启动命令里的 `PUBLIC_ORIGIN` 改为 `https://你的域名`（Compose 则在 `.env` 设置），再用反向代理把该域名指向宿主机 `127.0.0.1:8080`（如果反代也是容器，请使用共用 Docker 网络和服务地址）。已启动的容器需按新配置重建并继续挂载同一数据卷；Compose 用户修改 `.env` 后执行 `docker compose up -d`。不带路径，优先在首次导入前配置；已发布的清单会记录绝对地址，换域名需要重新发布并更新客户端链接。iPhone 主屏幕 PWA 和 Rex 的远程导入建议使用 HTTPS。纯内网测试可改为 `-p 8080:8080`、`-e PUBLIC_ORIGIN=http://内网IP:8080` 和 `-e ALLOW_INSECURE_HTTP=1`（Compose 对应设置 `REX_BIND=0.0.0.0`），不要开放到公网，也不要在不可信网络使用 HTTP 登录。

可选变量：`REX_PORT` 为宿主机端口（如改动，同步设置 `PUBLIC_ORIGIN`），`SETUP_TOKEN_FILE` 为容器内的只读令牌文件路径（直接运行镜像时可使用）。初始化成功后可以移除令牌。不要提交 `.env`。

## 数据和升级

- Docker 卷 `rex-data` 挂载到 `/data`，包含 SQLite、上传模块、镜像文件和徽章。升级或重建容器保留卷；不要运行 `docker compose down -v`，否则会删除数据。
- 建议停容器后完整备份 `/data`。如改用宿主机挂载目录，须允许 UID/GID `10001` 读写；优先使用本地存储，勿把 SQLite 放到不支持可靠文件锁的网络盘。
- 此版本面向单实例，不要让多个容器共享同一个数据卷。Worker 实例和 Docker 实例的数据不自动同步；不要把 D1 导出文件直接覆盖本地库。
- 并发下载仍有界；远程来源要求公开 HTTPS，不访问内网主机。私有模块可本地上传。仅托管你有权分发的文件。

## 从源码构建（可选）

`docker build -t rex-hub:0.0.10 .` 使用多阶段构建。最终镜像不含 Rust 工具链。也可在装了 Rust 与 SQLite 开发库的 Linux 上运行 `cargo test --locked --manifest-path docker/Cargo.toml`。
