# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM golang:1.26-alpine3.24 AS build

ARG TARGETOS
ARG TARGETARCH
ARG KDNS_VERSION=v0.2.22-gateway-api.1
ARG KDNS_REF=f956ab5d35564ee84e58ba155e78a17423cc835b
ARG BUILD_DATE=unknown

WORKDIR /src
COPY . .

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -trimpath \
      -ldflags="-s -w -extldflags '-static' \
        -X github.com/lab42/kdns/cmd.Version=$KDNS_VERSION \
        -X github.com/lab42/kdns/cmd.Commit=$KDNS_REF \
        -X github.com/lab42/kdns/cmd.Date=$BUILD_DATE" \
      -o /out/kdns .

FROM alpine:3.24 AS setup
RUN addgroup --gid 10000 -S appgroup && \
    adduser --uid 10000 -S appuser -G appgroup

FROM scratch
COPY --from=setup /etc/passwd /etc/passwd
COPY --from=build /out/kdns /kdns
USER appuser
EXPOSE 5353
ENTRYPOINT ["/kdns"]
