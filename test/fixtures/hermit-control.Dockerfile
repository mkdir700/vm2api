# 在固定控制镜像上运行当前后端、实际入口及固定实验 helper。
ARG BASE_IMAGE=ghcr.io/dofastted/vm2api:commit-94df6a23
FROM ${BASE_IMAGE}
COPY src /opt/vm2api/src
COPY scripts /opt/vm2api/scripts
COPY docker-compose.yml /opt/vm2api/image-deploy/docker-compose.yml
COPY scripts/docker-entrypoint.sh /usr/local/bin/vm2api-entrypoint
COPY inputs/kin-api-kernel inputs/kin-egress /opt/vm2api/image-bin/
RUN rm -f /opt/vm2api/src/lib/oauth/auth.js \
 && chmod 755 /usr/local/bin/vm2api-entrypoint /opt/vm2api/image-bin/kin-api-kernel /opt/vm2api/image-bin/kin-egress
