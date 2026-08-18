# syntax=docker/dockerfile:1.4

FROM golang:1.26.6-bookworm AS build

WORKDIR /src
ENV GOTOOLCHAIN=local
ENV GOPROXY=file:///go/pkg/mod/cache/download
ENV GOSUMDB=off

# Seed the module proxy from the host's local cache for offline builds.
COPY --from=go_mod_download_cache / /go/pkg/mod/cache/download/

# Copy only what we need for this module (and its local replace).
COPY Oracles/CAVSonOCR/ /src/Oracles/CAVSonOCR/
COPY libocr/libocr/ /src/libocr/libocr/

WORKDIR /src/Oracles/CAVSonOCR
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/cavs-oracle .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags queue -o /out/cavs-queue .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/cavs-oracle /cavs-oracle
COPY --from=build /out/cavs-queue /cavs-queue
ENTRYPOINT ["/cavs-oracle"]
