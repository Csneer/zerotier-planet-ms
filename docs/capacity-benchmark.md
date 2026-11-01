# 小规格云主机基准

这份记录把“2 vCPU / 2 GiB 可以运行”限定为资源起点，不承诺固定成员数量、吞吐或延迟。ZeroTier 的实际容量还受云主机带宽、地域、NAT、直连比例、中转流量和客户端版本影响。

## 已完成的基础实测

在隔离 Docker 容器中使用本仓库镜像启动单 Root + Web，容器限制为 2 CPU、2 GiB 内存、4 GiB memory+swap 和 256 PID。容器使用匿名 Docker 卷，没有挂载仓库或宿主正式部署目录。

| 项目 | 结果 |
| --- | --- |
| 镜像 | `ms-zerotier-planet:audit-d3efb3b` |
| 容器状态 | `healthy`，0 次重启 |
| Web 入口 | `127.0.0.1:13443` 映射到容器 `3443/tcp` |
| ZeroTier UDP | 未发布到宿主，仅用于验证 Web/进程基线 |
| 空载内存 | 约 `52 MiB / 2 GiB` |
| 空载 CPU | 约 `0.06%`（单次采样） |

这次实测只证明基础进程能够在限制下健康运行，不能推导中转吞吐、丢包率或支持的成员数。容器和匿名卷已在实测结束后删除。

另一次完整浏览器回归使用 `ms-zerotier-planet:review-final`（ZeroTier 1.16.2），限制为 **2 vCPU、2 GiB、禁用 swap、256 PID**。登录、创建网络、配置地址池、成员授权与改名、移动端导航全部通过；流程结束时单次采样为 CPU `0.99%`、内存 `69.36 MiB / 2 GiB`、61 个 PID。这是功能回归期间的运行开销，同样不能代表中转容量。测试容器、匿名卷和网络均已清理。

2026-11-01 的 Node.js 24 维护构建再次使用上述资源限制运行浏览器回归。测试镜像为本地 `ms-zerotier-planet:maintenance-audit`（Node.js `24.22.2`、ZeroTier `1.16.2`），增加了成员详情与风险弹窗、多语言四视口、12 个网络/成员的搜索分页与保存回滚覆盖；全部通过。结束时单次采样为 CPU `0.26%`、内存 `135.8 MiB / 2 GiB`、61 个 PID。该样本来自本次本地候选镜像，不代表已发布版本；测试范围与早期样本不同，不能直接据此计算运行时升级的内存增幅。测试容器、匿名卷和网络均已清理。

可对本地构建的镜像重复该流程，参见 [浏览器回归说明](../tests/browser/README.md)。测试脚本自动创建隔离实例，并输出资源采样。

## 可复现实测流程

正式容量数据应在与生产接近的主机和网络上执行，并记录镜像 digest、ZeroTier 版本、云主机带宽、客户端数量和测试时间。建议至少分开记录以下三组：

1. **运行基线**：无成员、1 个成员和 10 个成员，记录 `docker stats` 的 CPU、RSS、网络字节和重启次数。
2. **直连传输**：两台客户端确认 `zerotier-cli peers` 为 `DIRECT` 后，用 `iperf3` 测 TCP/UDP 吞吐、延迟和丢包。
3. **中转传输**：阻断客户端之间的直连，只保留通过 Root 的路径，重复相同流量测试；同时记录 Root 出口带宽、CPU 和 UDP 丢包。

最小记录命令示例：

```bash
docker stats --no-stream myztplanet
docker inspect myztplanet --format '{{.State.Status}} {{.State.Health.Status}} {{.RestartCount}}'
zerotier-cli peers
iperf3 -c ZEROTIER_PEER -t 60 -P 4
iperf3 -c ZEROTIER_PEER -u -b 50M -t 60 --get-server-output
```

不要把单次空载 RSS 当作“可支持 N 个成员”的承诺。每次更新 ZeroTier、基础镜像、云厂商带宽或网络拓扑后，应重新执行直连和中转两组测试。
