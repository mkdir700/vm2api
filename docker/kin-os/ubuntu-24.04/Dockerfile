FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
ENV PATH=/usr/local/lib/nodejs/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tzdata python3 bash procps tmux=3.4-1build1 \
 && echo '88e9b027bbe0dd11b6e7ea39fd9a6489f97addd751e25ed6a54f1607f42ad4df  /usr/bin/tmux' | sha256sum -c - \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 987 kincli \
 && useradd -u 999 -g 987 -d /home/kincli -m -s /bin/bash kincli \
 && echo "ubuntu-24.04" > /etc/kin-os \
 && echo "claude-code=2.1.293" > /etc/kin-claude
WORKDIR /home/kincli
USER kincli
CMD ["sleep", "infinity"]
