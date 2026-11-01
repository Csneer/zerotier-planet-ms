# 安装与运维指南

[项目介绍](../README.md) · [English](operations.en.md) · [Agent 安装指引](agent-install.md)

本指南保留完整的安装参数、配置说明、监控口径与维护流程。以下命令默认在仓库根目录执行；示例公网地址需替换为自己的真实地址。已有数据的部署先阅读[原地升级指南](in-place-upgrade.md)，不要重新执行首次初始化。

**选择版本**：`v1.2.0` 是当前正式发布版；`main` 已包含后续改动（包括成员详情弹窗与风险处理指引），不应把它们视为 `v1.2.0` 已有能力。小规格主机优先拉取已审核镜像；需要主分支功能时，选择已通过 CI 的 Git SHA 镜像或构建对应 checkout，并记录镜像 digest。

**导航**：[环境要求](#环境要求) · [首次安装](#首次安装) · [配置](#配置) · [客户端配置](#客户端配置) · [连接监控](#连接状态与监控) · [日常维护](#日常维护) · [备份与恢复](#备份与恢复) · [密码与卸载](#密码与卸载) · [安全](#安全注意事项)

## 环境要求

- 64 位 Linux，推荐 Debian 12、Ubuntu 22.04+ 或 Rocky Linux 9。
- Docker Engine 24+。
- Docker Compose v2。
- Bash、Git、Python 3、`jq`、`coreutils`。
- 固定或可控的公网 IPv4、IPv6，或两者同时存在；Root 至少需要一个地址族。
- 云安全组和主机防火墙至少放行 `${ZT_PORT}/udp`，默认 `9994/udp`；双栈主机要同时放行 IPv4 和 IPv6。

端口用途：

| 默认端口 | 协议 | 用途 | 建议暴露范围 |
|---:|---|---|---|
| 9994 | UDP | ZeroTier Planet Root 稳定端点 | 公网；每个 Root 的 UDP 端点必须放行 |
| 9994 | TCP | ZeroTier 本地管理 API | 仅回环或受信来源；不要当作公网 HTTPS/业务入口 |
| 3443 | TCP | Web 管理控制台 | 仅可信 IP、ZeroTier 网段或本机反代 |

旧的 `3000/tcp` 文件服务已删除。`planet` 和 `.moon` 只通过登录后的 Web `Downloads` 页面分发。

脚本不会自动安装 Docker、修改内核、改防火墙或写 `/etc/docker/daemon.json`。这些主机级操作不应由应用安装脚本静默执行。

## 首次安装

从源码本地构建（将示例地址换成服务器真实公网地址）：

```bash
git clone https://github.com/Csneer/zerotier-planet-ms.git
cd zerotier-planet-ms
./install.sh --ip 203.0.113.10 --data-dir /srv/zerotier-planet
```

可选参数：

```bash
./install.sh \
  --ip 203.0.113.10 \
  --ipv6 2001:db8::10 \
  --data-dir /srv/zerotier-planet
```

只有 IPv6 的 Root：

```bash
./install.sh --ipv6 2001:db8::10 --data-dir /srv/zerotier-planet
```

以下在备用机的新 checkout 中执行（尚无 `.env`）。不要复用已有客户端或 Controller 数据目录：

```bash
CONTAINER_NAME=myztplanet-root-b ./install.sh --ip 203.0.113.20 \
  --data-dir /srv/zt-root-b \
  --image zerotier-planet:multi-root \
  --planet-mode external --root-only 1 --configure-only
```

该命令只生成配置，不会替你生成多 Root 签名文件。必须先由可信发布者准备并验证 `config/planet`，再执行 `./manage.sh up`。备用 Root 不应运行 Controller，也不能与主 Controller 共享 `one/` 或 `controller.d/`。

生成 B 的独立身份后，再把 `identity.public` 交给签名发布者；不能把 A 的 identity 复制过来：

```bash
./build.sh
(
  set -eu
  test -z "$(find /srv/zt-root-b/one -mindepth 1 -maxdepth 1 -print -quit)"
  docker run --rm --network none --entrypoint zerotier-idtool \
    -v /srv/zt-root-b/one:/work \
    zerotier-planet:multi-root generate /work/identity.secret /work/identity.public
)
```

只生成并检查 `.env`，不启动 Docker：

```bash
./install.sh --ip 203.0.113.10 --data-dir /srv/zerotier-planet --configure-only
```

使用本项目已发布的预构建镜像（适合避免在小规格主机上编译）：

```bash
./install.sh \
  --ip 203.0.113.10 \
  --pull \
  --image ghcr.io/csneer/ms-zerotier-planet:v1.2.0
```

安装器的安全边界：

- 已存在 `.env` 时不会覆盖它。
- 已存在数据目录时不会删除或初始化清空。
- 不会自动拉取任何第三方 `latest` 镜像。
- 新部署默认管理员是 `admin/password`，首次登录后必须立即修改。

Web 默认只监听本机：

```text
http://127.0.0.1:3443
```

如果需要从 ZeroTier 网络访问，把 `HTTP_HOST` 设置为服务器对应的 ZeroTier 地址，例如 `198.51.100.97`。需要同时监听多个明确地址时使用逗号分隔的 `HTTP_EXTRA_HOSTS`，例如 `HTTP_HOST=127.0.0.1`、`HTTP_EXTRA_HOSTS=198.51.100.97`；它不接受网段或 `0.0.0.0`。默认 Compose 未启用 HTTPS；需要 HTTPS 时推荐在受信网络中增加反向代理。

## 配置

运行配置只保存在未纳入 Git 的 `.env`。模板见 [.env.example](../.env.example)。

| 变量 | 说明 |
|---|---|
| `ZT_VERSION` | 构建时安装的 ZeroTier 版本 |
| `ZTNCUI_COMMIT` | 固定的 ztncui 源码提交 |
| `MKWORLD_ZT_VERSION` | 用于构建 `mkworld` 的兼容 ZeroTier 源码版本 |
| `DEBIAN_MIRROR` | Debian 镜像主机；海外环境可设为 `default` |
| `ZT_IMAGE` | 本地或远端镜像名 |
| `IMAGE_SOURCE` | `build` 从本仓库构建；`pull` 从镜像仓库拉取 |
| `SOURCE_REPOSITORY` | 写入 OCI 标签的你自己的仓库 URL |
| `DATA_DIR` | identity、Controller、配置和生成文件的持久化根目录 |
| `ZTNCUI_STATE_DIR` | Web 用户与设备别名目录 |
| `ZT_PROBE_STATE_DIR` | 可选本机 ZeroTier 客户端状态目录，只读挂载供连接监控读取 token |
| `BACKUP_DIR` | 校验备份的保存目录 |
| `CONTAINER_NAME` | 容器名；同机多实例或保留停机旧容器的跨工程接管需避免重名 |
| `IP_ADDR4` / `IP_ADDR6` | Planet 对外发布的稳定 IPv4/IPv6 地址；Root 至少填写一个，双栈可同时填写 |
| `PLANET_MODE` | `generated`：原单 Root 自动生成；`external`：使用 `config/planet` 的统一签名文件 |
| `ROOT_ONLY` | `1`：只启动 Root，不开 Web UI；默认 `0` |
| `CONTROLLER_ONLY` | `1`：external 模式下的人工 Controller 备用；必须有 active standby guard，不承担 Root；默认 `0` |
| `ZT_PORT` | ZeroTier 主端口，默认 `9994` |
| `API_PORT` | Web 管理端口，默认 `3443` |
| `DEFAULT_NETWORK_MTU` | 新建网络默认 MTU，建议 `1280` |
| `HTTP_HOST` | Web 监听地址，默认 `127.0.0.1`；也可绑定服务器的 ZeroTier 地址 |
| `HTTP_EXTRA_HOSTS` | 额外的明确监听 IP，逗号分隔；缺失的局域网 IP 会重试，不会拖停主监听 |
| `ZT_PROBE_ADDR` | 可选探针的本地 ZeroTier API，默认 `http://127.0.0.1:9993` |
| `ZT_ENDPOINT_PROBES_FILE` | 可选端点 TCP 探针配置，默认 `/app/config/endpoint-probes.json`；仅检查明确 IP 和端口 |

Compose 中空值或省略的 `IP_ADDR4` / `IP_ADDR6` 会禁用对应族，不会恢复保存的旧地址。升级前核对手工维护的 `.env`；Root 至少保留一个端点。

单 Root `generated` 模式下，修改 `IP_ADDR4`、`IP_ADDR6` 或 `ZT_PORT` 后执行 `./manage.sh upgrade`。容器会保留原 identity 和 `.c25519` 签名密钥，生成时间戳更高的新 planet；客户端仍需重新下载并替换新的 `planet` 文件。多 Root `external` 模式必须统一签名发布，不能靠改环境变量重新生成，见[部署步骤](multi-root.md)。

建立自己的远程仓库后，请把 `SOURCE_REPOSITORY` 填为该仓库 URL；留空时 OCI source 标签也保持为空，不会冒充原上游发布物。

## 连接状态与监控

登录后进入“连接监控”可看到以下彼此独立的状态：

- `Planet 可达`：Planet 服务器当前观测到该成员的有效路径。这只能说明成员与本服务器之间的状态。
- `到 Planet 直连`：成员到 Planet 服务器有活动的物理路径，不代表成员与其他终端直连。
- 探针 `DIRECT` / `RELAY` / `TCP RELAY`：服务器本机 ZeroTier 客户端到该成员的当前路径。探针只是一个观测点，不是所有终端的两两连接矩阵。
- Planet 包速率与 UDP/TCP 流量：来自 ZeroTier 内置 Prometheus 指标，页面用相邻采样计算速率。
- Planet 文件一致性与未声明 Root 数量：运行文件应与下载文件一致；按配置的公开 Root 清单识别异常上游，正常备用 Root 不会被误报为公共 Root。
- Root 拓扑会分别显示 IPv4 与 IPv6 的声明端点、服务实例近期收包和探针观测；总体 Root 可达只表示至少一条服务端路径近期可用，不能把未观测的 IPv6 解释成客户端或云主机不支持 IPv6。

若要启用探针视角，把主机 ZeroTier 客户端的数据目录配置为 `ZT_PROBE_STATE_DIR`。Compose 会只读挂载该目录，并通过 `ZT_PROBE_ADDR` 查询本机 API。目录为空或 API 不可达时，监控页会显示“探针不可用”，不会影响主服务。

端点业务探针是另一层可选观测：复制 [examples/endpoint-probes.json](../examples/endpoint-probes.json) 到持久化 `config/endpoint-probes.json` 后，监控页会以受限并发执行只读 TCP connect，并在建连后立即关闭。配置只接受字面 IPv4/IPv6 地址（不接受带接口 zone 的 `%` 形式）、1–32 个目标和 100–5000ms 超时；每次采样另有约 10 秒总预算，超出的目标标记为超时。不解析 DNS、不执行 SSH/HTTP 命令，也不会扫描任意端口。TCP 成功只说明本管理实例到目标端口可达，不代表 ZeroTier 端点直连、业务协议健康或流量经过哪个 Root；未配置时不会自动探测。

判断两台具体终端是否直连，仍应在其中一台终端运行 `zerotier-cli peers`，或结合实际端到端传输测试；中央控制器无法可靠推断任意终端对之间的实时路径。

## 从已有 Planet 项目原地升级

本项目提供保留原数据的升级路径，并非对任意旧镜像、任意目录布局的一键兼容。详细命令和验收清单以[原地升级指南](in-place-upgrade.md)为准：

1. 保留独立管理通道，检查旧容器真实挂载；备份 identity、`controller.d/`、签名密钥、Planet 各副本、端点配置、Web 用户和 session key。缺失文件先核查，不能让新实例初始化替代身份或签名链。
2. 当前项目更新源码时保留 `.env`、挂载路径和现有 `PLANET_MODE`，执行 `doctor`、`upgrade`。旧项目跨 checkout 接管需使用绝对路径；旧容器停机后仍占用名字，应使用不同的新容器名或将旧容器改名保留，不能双开同一 identity。
3. 仅在确认单 Root、签名材料及原端点配置完整时沿用 `generated`。已是多 Root 或 external 的实例必须保持 `external`；只有当前可信 Planet、没有签名密钥时可按指南核查后 external 接管，但不能签发新增 Root。不要一律改成 generated。
4. 新增 B 时为它生成独立身份，用原 World 签名链生成含 A/B 的候选，验证签名、时间戳和哈希后预置到各 Root 的 `config/planet`；先准备并验证 B，再滚动更新 A。A 保持 Controller 单活，B 不复制 A 的 `one/`。
5. 分批给客户端安装同一份 Planet，核对原 Network ID、IP 和授权保持，并用隔离客户端验证实际中转及恢复时间。`doctor` 不等于签名验证，签名链和本机 Root 身份匹配在候选校验及容器启动时验证。

热切换不以 Root 列表顺序指定主备，不等于 Controller 多主。镜像回退也不等于 World 拓扑回退：拓扑恢复必须签发更高时间戳的新 World。

完整的签名发布、Controller-only 手动备用、原生 Root-only systemd 部署和隔离切换验证见[原地升级指南](in-place-upgrade.md)、[多 Root 与切换方案](multi-root.md)、[Controller-only 手动备用](controller-standby.md)、[Root 接入指南](root-onboarding.md)及[系统 Root-only 部署](native-root.md)。

## 日常维护

```bash
./manage.sh doctor                 # 配置与依赖检查
./manage.sh status                 # 容器、ZeroTier、World/Root 和网络状态
./manage.sh logs                   # 跟随日志
./manage.sh restart                # 重启并等待 healthy
./manage.sh build                  # 只构建镜像
./manage.sh up                     # 启动已有镜像，不删除数据
./manage.sh upgrade                # 构建/拉取、备份、重建、健康检查（回滚依模式）
```

升级本仓库代码后的推荐流程：

`IMAGE_SOURCE=build` 会构建当前 checkout；`IMAGE_SOURCE=pull` 仍拉取 `.env` 中的 `ZT_IMAGE`。固定版本或 digest 的部署需先审核并更新该镜像引用，`git pull` 不会自动把固定镜像切换到新版本。

```bash
git pull --ff-only
./manage.sh doctor
./manage.sh upgrade
```

`upgrade` 会先准备新镜像，再短暂停止旧容器生成一致性备份。`generated` 模式的新容器未通过健康检查时会尝试恢复上一镜像；`external` 模式只保留回滚标签和备份，必须人工确认镜像仍支持当前 signed World 后恢复。

固定 digest 的 `generated` 部署回滚时，会使用旧镜像 ID 恢复服务，保留原有挂载和配置；`.env` 中的目标 digest 不会被改写。回滚成功后，先把 `ZT_IMAGE` 更新为确认可用的镜像，再执行下一次 `up` 或 `upgrade`，避免重新启动失败的候选版本。

## 备份与恢复

生成一致性备份，过程中会短暂停止并自动恢复容器：

```bash
./manage.sh backup
```

不中断服务的快照：

```bash
./manage.sh backup --online
```

在线快照可能遇到文件正在变化，只适合作为补充。正式备份优先使用默认的一致性模式。

每个备份包含：

- `dist/`：planet 和 moon。
- `one/`：ZeroTier identity、签名密钥和 Controller 数据。
- `config/`：端口、地址和 session key。
- `ztncui-state/`：Web 用户和设备别名。
- `probe-state/` 不在正式备份中：它只是可选的只读本机 ZeroTier 观测客户端状态，可在目标主机重新指定 `ZT_PROBE_STATE_DIR`；其中的 token 不属于 Controller/Root 数据。
- `.env`、Compose 配置、容器信息与 `SHA256SUMS`。

恢复前会先验证校验和并自动备份当前数据：

```bash
./manage.sh restore ./backups/planet-YYYYMMDD-HHMMSS --yes
```

备份包含私钥和密码哈希，目录权限会收紧为 `0700`、文件为 `0600`。不要上传到公开 Git 仓库。

## 密码与卸载

忘记 Web 管理密码：

```bash
./manage.sh reset-password --yes
```

该操作会先备份当前密码文件，再重置为 `admin/password` 并重启；登录后立即修改。

仅删除容器、保留全部数据和镜像：

```bash
./uninstall.sh
```

删除容器和持久化数据：

```bash
./uninstall.sh --purge-data --yes
```

彻底删除前仍会自动生成最后一份校验备份。脚本不会自动删除镜像和备份。

## 客户端配置

以下手动替换步骤适用于桌面和服务器；Android / iOS 按本节下方的移动客户端导入说明操作。

1. 登录 Web 控制台，进入 `Downloads`。
2. 下载 `planet` 并核对页面中的 SHA-256。
3. 停止客户端 ZeroTier 服务。
4. 替换客户端 ZeroTier 数据目录中的 `planet`。
5. 启动 ZeroTier 服务并加入 Web 中创建的网络。
6. 在 Web 中授权成员。
7. 运行 `zerotier-cli peers`，确认自建节点显示为 `PLANET`，路径尽量为 `DIRECT`。

常见 planet 路径：

- Linux：`/var/lib/zerotier-one/planet`
- Windows：`C:\ProgramData\ZeroTier\One\planet`
- macOS：`/Library/Application Support/ZeroTier/One/planet`

| 平台 | 当前验证范围 | 接入要求 |
| --- | --- | --- |
| Linux | 已有容器启动、签名更新和隔离网络回归 | 有权限停止服务并替换数据目录中的 Planet；实际部署仍应验证端到端访问 |
| Windows / macOS | 提供常见文件路径，本轮未做真机回归 | 管理员权限替换 Planet 后，验证加入网络及服务访问 |
| Android | 本项目有 [ZerotierFix](https://github.com/kaaass/ZerotierFix) 在特定设备/部署中的接入验证，非全机型或官方客户端回归 | 官方移动客户端的 Planet 导入见下方上游文档；核对实际安装版本、权限与私有 World，再验证网络授权、IP 和服务访问 |
| iOS | 本项目尚无广泛真机回归；不等于上游没有导入功能 | 官方移动客户端已有文档化导入路径；核对实际安装版本与权限，用自己的私有 World 验证接入 |

根据 [ZeroTier 官方移动端配置文档](https://docs.zerotier.com/roots/#mobile)，官方移动客户端自 `1.16.0` 起支持通过自定义 URL 导入 Planet；同页也介绍了在 Settings 中选择 **Add Planet File** 的方式。两种方式都使用二进制 `planet` 的 Base64 内容，链接形式为 `https://joinzt.com/addplanet?v=1&planet=...`，不要把普通 Network ID 邀请链接当作 Planet 配置。Android/iOS 选型时仍需核对实际安装构建、导入入口与系统权限，并用自己的私有 World 验证授权、IP 和端到端访问；上游功能说明不等于本项目已完成所有设备的验收。

桌面/服务器手动替换文件前必须停止 ZeroTier；具体路径可能因客户端发行版而不同。移动端按所用客户端的导入流程操作，并保留恢复办法。

## 版本与镜像发布

项目采用独立的 SemVer 版本（`vX.Y.Z`）；当前版本为 `v1.2.0`，对应镜像 `ghcr.io/csneer/ms-zerotier-planet:v1.2.0`。它与 ZeroTier `1.16.2` 等运行时版本不同。变更见 [CHANGELOG](../CHANGELOG.md)，维护者的身份配置、打 tag 和 GitHub Release 步骤见[发布约定](releasing.md)。

[image-build.yml](../.github/workflows/image-build.yml) 校验脚本、Compose 和容器回归后，构建 `amd64`/`arm64` 并发布到 GHCR：

- 正式 `vX.Y.Z` tag 使用该 tag 的 `.env.example` 中的 `ZT_VERSION`（`v1.2.0` 为 `1.16.2`），只发布对应项目版本镜像，不更新滚动标签。
- `main`/`master` 推送、每周计划任务和普通手动构建继续采用上游最新稳定 ZeroTier（手动构建可指定版本），生成 `latest`、ZeroTier 版本和 Git SHA 标签。
- 需要固定实际部署内容时，记录并使用镜像 digest；版本 tag 本身不代表全部构建依赖均已锁定。

如果 GHCR 包是私有的，部署主机需要先执行 `docker login ghcr.io`。Dependabot 每周检查 Docker 基础镜像和 GitHub Actions 版本。

## 仓库结构

```text
.
├── Dockerfile
├── docker-compose.yml
├── install.sh              # 首次配置和安装
├── manage.sh               # 日常维护入口
├── uninstall.sh            # 安全卸载入口
├── deploy.sh               # 旧命令兼容层，不再包含旧部署逻辑
├── build.sh                # 本地/多架构镜像构建
├── docs/                   # 原地升级、Controller 备用、Root 接入、多 Root 和 Root-only 运维文档
├── patch/                  # ZeroTier、ztncui 和 Web 定制
└── .github/                # GHCR 发布与依赖更新
```

## 安全注意事项

- 不建议将 `3443/tcp` 直接暴露给整个公网；至少使用云安全组白名单。
- 更推荐 `HTTP_HOST=127.0.0.1`，再由 Caddy/Nginx/Traefik 提供 HTTPS；如需 ZeroTier 访问，再把实际地址加入 `HTTP_EXTRA_HOSTS`。
- 回环和指定 ZeroTier 地址提供同一套账户、会话存储和管理模型；浏览器 Cookie 按主机隔离，换 IP 可能要重新登录。不要使用 `0.0.0.0`，除非有明确的防火墙白名单。
- 不要提交 `.env`、`data/`、`backups/` 或任何 identity、`.c25519`、token 文件。
- ztncui 上游已经停止积极维护；管理面应视为高权限内部服务。

## 来源与许可证

本仓库没有擅自给历史代码重新声明许可证。第三方源代码、补丁基础和运行时组件分别受其各自许可证约束。公开分发或商业使用前，请阅读 [NOTICE.md](../NOTICE.md) 并核对相应许可条款。
