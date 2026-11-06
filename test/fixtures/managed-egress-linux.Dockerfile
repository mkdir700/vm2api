FROM docker:27-cli AS docker-cli
FROM --platform=linux/amd64 ghcr.io/dofastted/kin-os-ubuntu:24.04@sha256:5b22b8179ee7b88e85c4e331e37bb883ab9fd6602697a909f28088dbfc109d7a AS amd64-runtime
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iptables iproute2 curl openssl git ca-certificates openssh-client openssh-sftp-server && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=amd64-runtime /usr/lib/x86_64-linux-gnu/ /usr/lib/x86_64-linux-gnu/
COPY --from=amd64-runtime /usr/lib64/ /usr/lib64/
RUN test -e /lib64 || ln -s usr/lib64 /lib64
