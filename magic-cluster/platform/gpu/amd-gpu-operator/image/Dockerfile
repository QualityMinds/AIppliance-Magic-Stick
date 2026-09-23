# Build context: ROCm/k8s-gpu-dra-driver at the reviewed v1.0.1 commit,
# with ../patches/reboot-cdi-recovery.patch applied. Tests run natively.
FROM --platform=$BUILDPLATFORM golang:1.26.5-bookworm AS build
WORKDIR /src
COPY . .
ENV CGO_ENABLED=0
RUN go test ./cmd/gpu-kubeletplugin
ARG TARGETARCH
RUN GOOS=linux GOARCH=$TARGETARCH go build -trimpath -o /gpu-kubeletplugin ./cmd/gpu-kubeletplugin

FROM rocm/k8s-gpu-dra-driver:v1.0.1@sha256:f173c8e78bc819e2b8adc15192afefaf69a11307d49fca5382bda82885975830
COPY --from=build /gpu-kubeletplugin /usr/bin/gpu-kubeletplugin
LABEL org.opencontainers.image.source="https://github.com/QualityMinds/AIppliance-Magic-Stick"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="v1.0.1-cdi-recovery.2"
