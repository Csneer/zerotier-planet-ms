# Agent 安装与验收指引

这份文档面向执行安装、升级和故障初筛的编码 Agent。它描述本仓库当前真实的脚本入口和持久化边界，适用于一台全新的 Linux 主机。已有 Planet、Controller 或多 Root 数据时，先阅读[原地升级指南](in-place-upgrade.md)，不要把首次安装命令套在旧数据上。

## 先确认部署目标

项目把 ZeroTier Planet、Controller 和 Web 管理台运行在一个 Compose 服务中。它适合把云服务器作为自己的内网穿透入口：客户端安装同一份 `planet` 后，可以通过自建 Root 建立 ZeroTier 网络，再从 Web 管理台管理网络和成员。

2 vCPU/2 GiB 内存的小型云主机可以运行单 Root 实例和少量网络成员。对于这类主机，优先使用已发布镜像，避免在业务机上编译 ZeroTier；源码构建需要额外的临时 CPU、内存、磁盘和稳定的上游下载链路。安装过程不会替主机安装 Docker、修改防火墙或开放端口。

普通首次安装使用 `PLANET_MODE=generated`、`ROOT_ONLY=0`。备用 Root、Controller-only 备用实例和统一签名 Planet 属于 `external` 模式，必须先准备独立 identity 和已验证的 `config/planet`，不能只修改一个环境变量。

## Agent 执行边界

执行命令前将工作目录切到仓库根目录，并确认目标是全新的数据目录。Agent 应遵守以下边界：

- 不打印、提交或上传 `.env`、`data/`、`backups/`、`identity.secret`、`.c25519`、`authtoken.secret` 和 Web 密码哈希。
- 不复制另一台 Root、客户端或 Controller 的 `one/` 目录；每个独立 Root 必须有自己的 identity。
- 不对已有 `.env` 继续传 `--ip`、`--data-dir` 等初始化参数。脚本会拒绝这种组合，以避免静默改配置；需要变更时先人工审查并显式编辑 `.env`。
- 不使用 `docker compose down -v`，不删除 bind mount，不把 `planet` 当作普通文本编辑。
- 任何升级或恢复前先确认有独立管理通道和可用备份；不要把管理台端口当成公网业务代理。

如果命令需要 Registry 凭据、云安全组权限、SSH 或 DNS 权限，Agent 应停在需要人工授权的边界，不把凭据写入命令行、日志或文档。

## 主机预检

在仓库根目录执行以下只读检查。Docker Engine 24+、Docker Compose v2、Bash、Git、Python 3、`jq` 和 GNU coreutils 是脚本要求；`curl` 用于本地健康端点验收。不要求 Agent 修改主机配置。

```bash
docker version
docker compose version
bash --version | head -n 1
git --version
python3 --version
jq --version
curl --version | head -n 1
free -h
df -h .
./install.sh --help
./manage.sh help
```

云安全组和主机防火墙至少要允许 `ZT_PORT/udp`（默认 `9994/udp`）到达每个 Root；双栈 Root 要同时放行 IPv4 和 IPv6。`9994/tcp` 是 ZeroTier 本地管理 API，默认不应暴露公网；Web 管理台默认监听 `127.0.0.1:3443`，若要从 ZeroTier 网段访问，应设置服务器实际 ZeroTier 地址或使用受信反向代理。

## 首次安装：小云主机优先拉取镜像

使用已审核的项目版本或 digest。下面的 `IMAGE_REF` 只是变量，不要原样当作镜像名提交：

```bash
git clone https://github.com/Csneer/zerotier-planet-ms.git /opt/ms-zerotier-planet
cd /opt/ms-zerotier-planet

IMAGE_REF=ghcr.io/csneer/ms-zerotier-planet:v1.3.0
./install.sh \
  --ip 203.0.113.10 \
  --data-dir /srv/zerotier-planet \
  --pull \
  --image "$IMAGE_REF"
```

将示例地址替换为服务器真实公网 IPv4。需要 IPv6 时增加 `--ipv6 2001:db8::10`；IPv6-only Root 可以省略 `--ip`，直接使用 `./install.sh --ipv6 2001:db8::10 ...`。如果 GHCR 包是私有的，先用已有凭据执行 `docker login ghcr.io`；不要把令牌放进 `IMAGE_REF` 或 shell 历史。

`install.sh` 会创建权限为 `0600` 的 `.env` 和持久化目录，随后运行 `manage.sh doctor`、启动服务并等待健康检查。它不会覆盖已有 `.env` 或清空已有数据目录。首次登录 Web 管理台使用 `admin/password`，登录后立即修改密码。

如果要从仓库源码构建镜像（例如需要审查本地改动），省略 `--pull` 和 `--image` 即可：

```bash
./install.sh --ip 203.0.113.10 --data-dir /srv/zerotier-planet
```

`v1.3.0` 包含 IPv6-only、成员详情与风险指引、Node.js 24 和严格网络输入校验；如需审查该版本之后的未发布修改，再使用当前源码构建。当前源码安装：

```bash
./install.sh \
  --ipv6 2001:db8::10 \
  --data-dir /srv/zerotier-planet
```

源码构建会下载并编译 ZeroTier 依赖。在 2 vCPU/2 GiB 主机上若构建资源不足或上游下载不稳定，应改用已审核的预构建镜像；不要关闭 TLS 校验或把临时构建文件提交进仓库。

默认镜像为 `mirrors.aliyun.com`，适合相应地域的主机。其他地域或该镜像不可达时，使用 `DEBIAN_MIRROR=default`：

```bash
DEBIAN_MIRROR=default ./install.sh --ip 203.0.113.10 --data-dir /srv/zerotier-planet
```

## 只配置、不启动

Agent 需要先把配置交给人工审核，或等待外部 Root 文件到位时，使用 `--configure-only`：

```bash
./install.sh \
  --ip 203.0.113.10 \
  --data-dir /srv/zerotier-planet \
  --configure-only
./manage.sh doctor --staged
```

此模式只生成 `.env` 和目录，不启动容器。普通 `./manage.sh doctor` 会检查 Docker daemon、Compose、挂载路径和运行文件；`PLANET_MODE=external` 还要求 `config/planet` 与独立 `one/identity.secret` 已准备好。`doctor` 不替代签名链、Root 身份和公网 UDP 的人工核验。

## 安装后的验收

安装完成后按顺序执行：

```bash
./manage.sh doctor
./manage.sh status
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:3443/healthz
```

预期结果：Compose 服务为 `running`/`healthy`，健康端点返回 `ok`。`./manage.sh status` 还会显示 ZeroTier 状态、Planet/World 信息和已观测的 Planet peer。不要只凭容器为 `running` 判定成功；若要确认内网穿透路径，应在独立网络的客户端安装同一份 `planet`，加入测试网络，并运行客户端 `zerotier-cli peers` 与实际端到端传输测试。

Web 管理台默认只监听服务器的 `127.0.0.1:3443`。从 Agent 所在电脑访问云服务器时，在电脑本地建立 SSH 隧道，再打开浏览器：

```bash
ssh -N -L 3443:127.0.0.1:3443 user@server
```

登录后进入 `Downloads` 下载 `planet`，核对页面显示的 SHA-256。桌面/服务器客户端先停止 ZeroTier 服务、替换数据目录中的 `planet`，再启动服务；Linux、Windows、macOS 的常见目录见[运维指南的客户端配置](operations.md#客户端配置)。移动端按 [ZeroTier 官方文档](https://docs.zerotier.com/roots/#mobile)核对导入入口：官方移动客户端自 `1.16.0` 起支持自定义 URL，文档也提供 Settings → Add Planet File 的 Base64 导入方式。Android/iOS 的实际安装构建、权限和私有 World 仍须逐项验收；Agent 不得把上游功能说明当作本次设备接入已验证。

## 日常升级与备份

升级当前 checkout 前先保留管理通道：

```bash
git pull --ff-only
./manage.sh doctor
./manage.sh upgrade
```

`upgrade` 会按 `.env` 的 `IMAGE_SOURCE` 构建或拉取镜像，生成一致性备份，重建容器并等待健康检查。正式备份可单独执行：

```bash
./manage.sh backup
```

`IMAGE_SOURCE=pull` 时由 `ZT_IMAGE` 指定镜像；`IMAGE_SOURCE=build`（默认）从当前 checkout 构建。单 Root `generated` 模式失败时脚本可尝试旧镜像回滚；`external` 模式不会自动激活旧镜像，必须由 Agent 汇报备份、回滚标签和失败日志，交给维护者审查。

IPv6-only/双栈部署需核对宿主机 IPv6 路由、对应 UDP 安全组及必要 ICMPv6。Compose 空值或省略的地址会禁用该族，不继承旧值；先确认 `.env` 再升级。实际收包与业务验证步骤见 [IPv6 Root 指南](ipv6-roots.md)。

## 常见失败与处理

| 现象 | 处理方式 |
| --- | --- |
| `--ip or --ipv6 is required when creating .env` | 新部署没有提供可达的公网 IPv4 或 IPv6；至少补充一个真实地址，不要填文档保留地址。Controller-only 备用实例按其专用指南配置。 |
| `.env already exists; edit it explicitly...` | 这是保护机制。停止重复初始化，先读取并人工审查 `.env`，再按维护流程操作。 |
| `cannot connect to the Docker daemon` 或 Compose 版本错误 | 由主机管理员安装/启动 Docker Engine 和 Compose v2；安装脚本不会静默修改主机。 |
| 安装在依赖、拉取或构建阶段失败 | `.env` 和数据目录会保留；修复环境后运行 `./manage.sh doctor && ./manage.sh up`，不要再次给已有 `.env` 传 `--ip` 或 `--data-dir`。 |
| `IP_ADDR4 still contains the example address` | `.env` 仍是 `203.0.113.10`，改成真实公网地址后重新执行 `./manage.sh doctor`。 |
| `External mode requires config/planet` 或 `prepared Root identity` | 这是 `external` 的强制前置条件。准备并验证签名 Planet 和独立 Root identity，不要复制其他实例的 `one/`。 |
| 健康检查失败、端口已占用或 `HTTP_HOST` 不可用 | 执行 `./manage.sh logs --tail 200`、`ss -lntup` 和 `./manage.sh status`；确认 `ZT_PORT`/`API_PORT` 不冲突，Web 地址是本机真实 IP。 |
| 源码构建在上游 GitHub 下载阶段失败 | 保留原始错误和构建版本，优先改用已审核镜像；不要关闭 TLS 校验、替换未知源码或提交临时 Dockerfile。 |

2 vCPU / 2 GiB 的空载实测、运行限制和中转容量测试方法见[小规格云主机基准](capacity-benchmark.md)。空载内存不能作为成员数量或中转吞吐承诺。

## Agent 完成回报

完成后报告以下可复核事实，不要附带秘密：

1. 使用的 checkout 提交、镜像引用（最好是 digest）和 `.env` 中的模式（`generated`/`external`）。
2. `./manage.sh doctor`、`./manage.sh status`、健康端点和客户端路径测试的结果。
3. `DATA_DIR`、备份位置、开放的 UDP/TCP 端口，以及仍需人工完成的云安全组、反向代理、密码或客户端分发步骤。
4. 若失败，报告首次失败命令、关键错误、是否改变数据、备份路径和建议的下一步；不要声称“容器 running”就等于内网穿透已验证。
