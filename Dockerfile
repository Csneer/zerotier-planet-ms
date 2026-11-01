# syntax=docker/dockerfile:1.7

ARG ZT_VERSION=1.16.2
ARG ZTNCUI_COMMIT=1b2284864de48d2dcae22582fff122fe24909c3d
ARG MKWORLD_ZT_VERSION=1.14.2
ARG DEBIAN_MIRROR=mirrors.aliyun.com
ARG SOURCE_REPOSITORY=""
ARG SOURCE_REVISION=unknown

FROM debian:bookworm-slim AS mkworld-builder
ARG MKWORLD_ZT_VERSION
ARG DEBIAN_MIRROR
WORKDIR /src
RUN if [ "$DEBIAN_MIRROR" != default ]; then \
        sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g; s|security.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && git clone --depth 1 --branch "${MKWORLD_ZT_VERSION}" https://github.com/zerotier/ZeroTierOne.git
COPY patch/mkworld_custom.cpp /src/ZeroTierOne/attic/world/mkworld.cpp
RUN cd /src/ZeroTierOne/attic/world \
    && ./build.sh \
    && strip mkworld

FROM node:24-bookworm-slim AS ztncui-builder
ARG ZTNCUI_COMMIT
ARG DEBIAN_MIRROR
WORKDIR /opt
RUN if [ "$DEBIAN_MIRROR" != default ]; then \
        sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g; s|security.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git patch \
    && rm -rf /var/lib/apt/lists/* \
    && git clone https://github.com/key-networks/ztncui.git \
    && cd ztncui \
    && git checkout "${ZTNCUI_COMMIT}" \
    && rm -rf .git
COPY patch/ztncui-modern.patch /tmp/ztncui-modern.patch
COPY patch/ztncui-mtu.patch /tmp/ztncui-mtu.patch
COPY patch/ztncui-downloads.patch /tmp/ztncui-downloads.patch
COPY patch/ztncui-ui.patch /tmp/ztncui-ui.patch
COPY patch/ztncui-static-assets.patch /tmp/ztncui-static-assets.patch
COPY patch/ztncui-monitor.patch /tmp/ztncui-monitor.patch
RUN cd /opt/ztncui \
    && patch -l -p1 < /tmp/ztncui-modern.patch \
    && patch -l -p1 < /tmp/ztncui-mtu.patch \
    && patch -l -p1 < /tmp/ztncui-downloads.patch \
    && patch -l -p1 < /tmp/ztncui-ui.patch \
    && patch -l -p1 < /tmp/ztncui-static-assets.patch \
    && patch -l -p1 < /tmp/ztncui-monitor.patch \
    && cd src \
    && npm install --package-lock-only --ignore-scripts \
    && npm ci --omit=dev \
    && npm cache clean --force
COPY patch/ztncui-network-validation.patch /tmp/ztncui-network-validation.patch
RUN cd /opt/ztncui && patch -l -p1 < /tmp/ztncui-network-validation.patch
COPY patch/networkValidation.js /opt/ztncui/src/public/javascripts/networkValidation.js
COPY patch/ztncui-roots.patch /tmp/ztncui-roots.patch
RUN cd /opt/ztncui && patch -l -p1 < /tmp/ztncui-roots.patch
COPY patch/ztncui-native-http.patch /tmp/ztncui-native-http.patch
COPY patch/ztncui-address-validation.patch /tmp/ztncui-address-validation.patch
RUN cd /opt/ztncui \
    && patch -l -p1 < /tmp/ztncui-native-http.patch \
    && patch -l -p1 < /tmp/ztncui-address-validation.patch
COPY patch/controllerHttp.js /opt/ztncui/src/controllerHttp.js
COPY patch/addressValidation.js /opt/ztncui/src/addressValidation.js
COPY patch/downloadsController.js /opt/ztncui/src/controllers/downloadsController.js
COPY patch/monitoringController.js /opt/ztncui/src/controllers/monitoringController.js
COPY patch/ui-focus.js /opt/ztncui/src/public/javascripts/ui-focus.js
COPY patch/ui-modern.css /opt/ztncui/src/public/stylesheets/ui-modern.css
COPY patch/uiLanguage.js /opt/ztncui/src/uiLanguage.js
COPY patch/uiStatus.js /opt/ztncui/src/uiStatus.js
COPY patch/rootStatus.js /opt/ztncui/src/rootStatus.js
COPY patch/hostDiagnostics.js /opt/ztncui/src/hostDiagnostics.js
COPY patch/communicationStats.js /opt/ztncui/src/communicationStats.js
COPY patch/endpointProbes.js /opt/ztncui/src/endpointProbes.js
COPY patch/uiListen.js /opt/ztncui/src/uiListen.js
COPY patch/www.js /opt/ztncui/src/bin/www
COPY patch/*.pug /opt/ztncui/src/views/
RUN mv /opt/ztncui/src/views/dashboard.pug /opt/ztncui/src/views/index.pug

FROM node:24-bookworm-slim
ARG ZT_VERSION
ARG DEBIAN_MIRROR
ARG SOURCE_REPOSITORY
ARG SOURCE_REVISION

LABEL org.opencontainers.image.title="ZeroTier Planet (optimized)" \
      org.opencontainers.image.description="Private ZeroTier planet and controller" \
      org.opencontainers.image.version="${ZT_VERSION}" \
      org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"

ENV TZ=Asia/Shanghai \
    IP_ADDR4="" \
    IP_ADDR6="" \
    ZT_PORT=9994 \
    API_PORT=3443 \
    DEFAULT_NETWORK_MTU=1280 \
    HTTP_HOST=127.0.0.1 \
    HTTP_EXTRA_HOSTS= \
    CONTROLLER_ONLY=0 \
    NODE_ENV=production

RUN set -eux; \
    if [ "$DEBIAN_MIRROR" != default ]; then \
        sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g; s|security.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gpg iproute2 jq openssl procps tini; \
    install -d -m 0755 /usr/share/keyrings; \
    curl --proto '=https' --tlsv1.2 -fsSL https://download.zerotier.com/contact%40zerotier.com.gpg \
      | gpg --dearmor -o /usr/share/keyrings/zerotier.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/zerotier.gpg] https://download.zerotier.com/debian/bookworm bookworm main" \
      > /etc/apt/sources.list.d/zerotier.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "zerotier-one=${ZT_VERSION}"; \
    rm -rf /var/lib/apt/lists/*; \
    install -d /bak/zerotier-one /bak/ztncui-state /app/config /app/dist /var/lib/ztncui /usr/local/libexec; \
    cp -a /var/lib/zerotier-one/. /bak/zerotier-one/

COPY --from=mkworld-builder /src/ZeroTierOne/attic/world/mkworld /usr/local/libexec/mkworld
COPY --from=ztncui-builder /opt/ztncui /opt/ztncui
COPY third_party/reicon /usr/share/zerotier-planet/reicon
COPY third_party/bootstrap /usr/share/zerotier-planet/bootstrap
COPY patch/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY patch/healthcheck.sh /usr/local/bin/healthcheck.sh
LABEL io.ms-zerotier-planet.controller-standby="1"

RUN set -eux; \
    cp -a /opt/ztncui/src/etc/. /bak/ztncui-state/; \
    rm -rf /opt/ztncui/src/etc; \
    ln -s /var/lib/ztncui /opt/ztncui/src/etc; \
    chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh; \
    chmod 0700 /var/lib/ztncui; \
    chmod 0755 /usr/local/libexec/mkworld

WORKDIR /app
VOLUME ["/app/dist", "/var/lib/zerotier-one", "/app/config", "/var/lib/ztncui"]
EXPOSE 9994/tcp 9994/udp 3443/tcp
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 CMD ["/usr/local/bin/healthcheck.sh"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
