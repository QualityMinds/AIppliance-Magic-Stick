# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM golang:1.26-alpine3.24 AS build

ARG TARGETOS
ARG TARGETARCH
ARG KDNS_VERSION=v0.2.22-gateway-api.1
ARG KDNS_REF=f956ab5d35564ee84e58ba155e78a17423cc835b
ARG BUILD_DATE=unknown

WORKDIR /src
COPY . .
RUN set -eu; \
    mkdir .magicstick-license-evidence; \
    if [ ! -s LICENSE ]; then \
      if [ ! -f README.md ] || ! grep -Fxq 'This project is licensed under the [MIT License](LICENSE).' README.md; then \
        printf '%s\n' 'ERROR: kdns has neither a nonempty LICENSE nor the verified MIT declaration in README.md.' >&2; \
        exit 1; \
      fi; \
      printf '%s\n' \
        'WARNING: kdns LICENSE is empty or missing; the explicit upstream README MIT declaration is accepted as build evidence.' \
        'The complete upstream copyright/license notice remains an open follow-up. No attribution is invented and this is not legal approval.' \
        > .magicstick-license-evidence/MAGICSTICK-NOTICE.txt; \
      cat .magicstick-license-evidence/MAGICSTICK-NOTICE.txt >&2; \
    fi; \
    for notice in LICENSE README.md; do \
      if [ -f "$notice" ]; then cp "$notice" .magicstick-license-evidence/; fi; \
    done; \
    printf 'Upstream repository: lab42/kdns\nRevision: %s\n' "$KDNS_REF" \
      > .magicstick-license-evidence/UPSTREAM.txt

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
COPY --from=build /src/.magicstick-license-evidence/ /usr/share/licenses/kdns/
USER appuser
EXPOSE 5353
ENTRYPOINT ["/kdns"]
