# syntax=docker/dockerfile:1.7
FROM ubuntu:24.04@sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b

ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      bash \
      bison \
      build-essential \
      ca-certificates \
      cmake \
      curl \
      file \
      flex \
      gawk \
      git \
      autoconf \
      automake \
      jq \
      libtool \
      lz4 \
      make \
      patch \
      perl \
      pkg-config \
      python3 \
      rsync \
      sqlite3 \
      tar \
      tcl \
      unzip \
      wget \
      xz-utils \
      zstd

ENV HOME=/opt/wasixcc-home
ENV WASIX_HOME=/opt/wasixcc-home/.wasixcc
ENV PATH=/opt/wasixcc-home/.wasixcc/bin:$PATH

RUN bash -euxo pipefail <<'EOF'
mkdir -p /opt/wasixcc-home
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  rm -rf /opt/wasixcc-home/.wasixcc /tmp/wasixcc-install.sh
  if curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 https://wasix.cc -o /tmp/wasixcc-install.sh \
    && HOME=/opt/wasixcc-home sh /tmp/wasixcc-install.sh \
    && wasixcc --version; then
    exit 0
  fi
  if [ "$attempt" -lt 6 ]; then
    sleep_seconds="$((attempt * 10))"
  else
    sleep_seconds=60
  fi
  sleep "$sleep_seconds"
done
exit 1
EOF

WORKDIR /work
