# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM ubuntu:24.04@sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b

ENV DEBIAN_FRONTEND=noninteractive

# The base filesystem and Ubuntu package view are immutable inputs. The helper
# writes a minimal fail-closed snapshot source, retries complete transactions,
# and verifies every request with the committed snapshot-service trust root.
# Rotate the trust root before the manifest-declared expiry boundary.
ARG OLIPHAUNT_UBUNTU_APT_SNAPSHOT=20260715T000000Z
ARG OLIPHAUNT_UBUNTU_SNAPSHOT_TLS_ROOT_SHA256=22b557a27055b33606b6559f37703928d3e4ad79f110b407d04986e1843543d1
LABEL dev.oliphaunt.ubuntu-apt-snapshot="${OLIPHAUNT_UBUNTU_APT_SNAPSHOT}" \
      dev.oliphaunt.ubuntu-snapshot-tls-root-sha256="${OLIPHAUNT_UBUNTU_SNAPSHOT_TLS_ROOT_SHA256}"

COPY --chmod=0444 isrg-root-x1.pem /usr/local/share/oliphaunt/isrg-root-x1.pem
COPY --chmod=0555 install-pinned-apt-packages.sh /usr/local/libexec/oliphaunt/install-pinned-apt-packages.sh

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    printf '%s  %s\n' \
      "$OLIPHAUNT_UBUNTU_SNAPSHOT_TLS_ROOT_SHA256" \
      /usr/local/share/oliphaunt/isrg-root-x1.pem \
      | sha256sum --check --strict - \
    && install -D -m 0444 \
      /usr/local/share/oliphaunt/isrg-root-x1.pem \
      /etc/ssl/certs/ca-certificates.crt \
    && /usr/local/libexec/oliphaunt/install-pinned-apt-packages.sh \
      --snapshot "$OLIPHAUNT_UBUNTU_APT_SNAPSHOT" \
      -- \
      bash \
      bison \
      build-essential \
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
ARG OLIPHAUNT_WASIXCC_ASSET_MANIFEST_SHA256=9b0ee1aabcfecda1be72c94a9f14a16c9d8a2fc020f3dc471394d5335766c519
LABEL dev.oliphaunt.wasixcc.asset-manifest-sha256="${OLIPHAUNT_WASIXCC_ASSET_MANIFEST_SHA256}"

COPY --chmod=0444 pinned-wasixcc-assets.tsv /usr/local/share/oliphaunt-wasixcc/pinned-wasixcc-assets.tsv
COPY --chmod=0555 install-pinned-wasixcc.sh /usr/local/libexec/oliphaunt/install-pinned-wasixcc.sh

RUN printf '%s  %s\n' \
      "$OLIPHAUNT_WASIXCC_ASSET_MANIFEST_SHA256" \
      /usr/local/share/oliphaunt-wasixcc/pinned-wasixcc-assets.tsv \
      | sha256sum --check --strict - \
    && /usr/local/libexec/oliphaunt/install-pinned-wasixcc.sh \
      --manifest /usr/local/share/oliphaunt-wasixcc/pinned-wasixcc-assets.tsv \
      --install-root "$WASIX_HOME" \
    && wasixcc --version \
    && "$WASIX_HOME/llvm/bin/clang" --version \
    && "$WASIX_HOME/binaryen/bin/wasm-opt" --version

WORKDIR /work
