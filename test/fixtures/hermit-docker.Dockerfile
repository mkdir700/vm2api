# 复用固定槽位镜像，只补齐 Hermit 已声明的 tmux 依赖。
ARG BASE_IMAGE=vm2api/kin-slot-ubuntu-24.04:71943fdb6fc0
FROM ${BASE_IMAGE}
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux=3.4-1build1 \
 && echo '88e9b027bbe0dd11b6e7ea39fd9a6489f97addd751e25ed6a54f1607f42ad4df  /usr/bin/tmux' | sha256sum -c - \
 && rm -rf /var/lib/apt/lists/*
USER kincli
