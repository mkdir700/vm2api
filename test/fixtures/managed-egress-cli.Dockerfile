ARG CONTROL_IMAGE=vm2api-managed-egress-control:candidate-amd64
FROM ${CONTROL_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl git openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
