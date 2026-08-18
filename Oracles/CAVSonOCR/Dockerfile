# syntax=docker/dockerfile:1.4

ARG GO_VERSION=1.26.6
ARG CAVS_SOURCE_SHA256=unversioned
FROM golang:${GO_VERSION}-bookworm AS build

ARG LIBOCR_SOURCE=libocr/libocr
ARG CAVS_MODFILE=go.mod

WORKDIR /src
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
ENV GOPROXY=file:///go/pkg/mod/cache/download,https://proxy.golang.org,direct
ENV GOSUMDB=off

# Seed the module proxy from the host's local cache for offline builds.
COPY --from=go_mod_download_cache / /seed/go-mod-cache/download/

ARG ORT_VERSION=1.23.0
ARG MINILM_VERSION=v0.0.9
ARG MINILM_MODEL_SHA256=994a58868f7abacacbf2192aa0aae8f56da8c4505dbde2740c861b24426ede6b
RUN mkdir -p /usr/local/include /usr/local/lib \
 && wget -q https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-linux-x64-${ORT_VERSION}.tgz \
 && tar -xzf onnxruntime-linux-x64-${ORT_VERSION}.tgz \
 && cp -r onnxruntime-linux-x64-${ORT_VERSION}/include/* /usr/local/include/ \
 && cp -r onnxruntime-linux-x64-${ORT_VERSION}/lib/* /usr/local/lib/ \
 && rm -rf onnxruntime-linux-x64-${ORT_VERSION}*
RUN --mount=type=cache,target=/var/cache/minilm,sharing=locked \
    bash -euxo pipefail -c '\
      mkdir -p /usr/local/share/minilm /var/cache/minilm; \
      cached=/var/cache/minilm/model-${MINILM_VERSION}.onnx; \
      if [ ! -s "$cached" ] || ! echo "${MINILM_MODEL_SHA256}  $cached" | sha256sum -c -; then \
        rm -f "$cached"; \
        urls="\
          https://github.com/clems4ever/all-minilm-l6-v2-go/raw/${MINILM_VERSION}/all_minilm_l6_v2/model.onnx \
          https://raw.githubusercontent.com/clems4ever/all-minilm-l6-v2-go/${MINILM_VERSION}/all_minilm_l6_v2/model.onnx"; \
        for url in $urls; do \
          for attempt in 1 2 3 4 5; do \
            echo "downloading MiniLM model from $url attempt ${attempt}/5"; \
            if wget --tries=3 --timeout=30 --waitretry=5 -O "$cached.tmp" "$url" \
              && echo "${MINILM_MODEL_SHA256}  $cached.tmp" | sha256sum -c -; then \
              mv "$cached.tmp" "$cached"; \
              break 2; \
            fi; \
            rm -f "$cached.tmp"; \
            sleep $((attempt * 5)); \
          done; \
        done; \
      fi; \
      echo "${MINILM_MODEL_SHA256}  $cached" | sha256sum -c -; \
      cp "$cached" /usr/local/share/minilm/model.onnx \
    '

# Copy only what we need for this module (and its local replace).
COPY Oracles/CAVSonOCR/ /src/Oracles/CAVSonOCR/
COPY ${LIBOCR_SOURCE}/ /src/${LIBOCR_SOURCE}/

WORKDIR /src/Oracles/CAVSonOCR
RUN test -f "${CAVS_MODFILE}"
RUN --mount=type=cache,target=/go/pkg/mod/cache/download,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    bash -euxo pipefail -c '\
      cp -a /seed/go-mod-cache/download/. /go/pkg/mod/cache/download/ 2>/dev/null || true; \
      for proxy in "$GOPROXY" "https://proxy.golang.org,direct" "https://goproxy.io,direct" "direct"; do \
        for attempt in 1 2 3; do \
          echo "go mod download via GOPROXY=${proxy} attempt ${attempt}/3"; \
          if GOPROXY="${proxy}" go mod download -modfile="${CAVS_MODFILE}"; then \
            exit 0; \
          fi; \
          sleep $((attempt * 5)); \
        done; \
      done; \
      exit 1 \
    '
RUN --mount=type=cache,target=/go/pkg/mod/cache/download,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -modfile="${CAVS_MODFILE}" -o /out/cavs-oracle .
RUN --mount=type=cache,target=/go/pkg/mod/cache/download,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -modfile="${CAVS_MODFILE}" -tags queue -o /out/cavs-queue .
RUN --mount=type=cache,target=/go/pkg/mod/cache/download,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -modfile="${CAVS_MODFILE}" -o /out/cavs-malicious-proxy ./malicious

FROM debian:bookworm-slim
ARG CAVS_SOURCE_SHA256
LABEL org.opencontainers.image.cavs-source-sha256="${CAVS_SOURCE_SHA256}"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl iproute2 libstdc++6 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/lib/libonnxruntime.so* /usr/local/lib/
COPY --from=build /usr/local/share/minilm/model.onnx /usr/local/share/minilm/model.onnx
COPY --from=build /out/cavs-oracle /cavs-oracle
COPY --from=build /out/cavs-queue /cavs-queue
COPY --from=build /out/cavs-malicious-proxy /cavs-malicious-proxy
ENV LD_LIBRARY_PATH=/usr/local/lib
ENV ONNXRUNTIME_LIB_PATH=/usr/local/lib/libonnxruntime.so
ENV MINILM_MODEL_PATH=/usr/local/share/minilm/model.onnx
ENTRYPOINT ["/cavs-oracle"]
