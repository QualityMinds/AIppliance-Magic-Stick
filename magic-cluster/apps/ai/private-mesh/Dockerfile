# Mesh's native backend libraries and model weights are not bundled. This adds
# the endpoint/role policy to the pinned transport, not a second model runtime.
FROM rust:1.98.1-bookworm@sha256:828077e0f5ed0401fbd9cb5b4d5dedca23bd13c7fe032f3e8b7313e7acd2a57f AS transport
RUN apt-get update && apt-get install -y --no-install-recommends clang cmake protobuf-compiler python3 libssl-dev pkg-config && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v0.76.2 https://github.com/Mesh-LLM/mesh-llm.git /src/mesh
COPY core/magicstick_core/private_mesh/native /policy
RUN python3 /policy/apply_policy.py /src/mesh
WORKDIR /src/mesh
ENV CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/mesh/target \
    cargo build --locked -p mesh-llm --no-default-features --features dynamic-native-runtime && cp target/debug/mesh-llm /mesh-llm && strip /mesh-llm
RUN git clone --depth 1 --branch v0.2.0 https://github.com/Mesh-LLM/openai-endpoint.git /src/plugin && test "$(git -C /src/plugin rev-parse HEAD)" = 9166c6a918cda73fe4c05912ed9b06446bb95e60
WORKDIR /src/plugin
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --locked --release && cp target/release/openai-endpoint /openai-endpoint

FROM python:3.13-slim-bookworm
LABEL org.opencontainers.image.licenses="BUSL-1.1"
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=transport /mesh-llm /openai-endpoint /usr/local/bin/
COPY --from=transport /src/mesh/LICENSE /usr/local/share/licenses/mesh-llm/LICENSE
COPY --from=transport /src/plugin/LICENSE /usr/local/share/licenses/openai-endpoint/LICENSE
RUN mkdir -p /usr/local/share && sha256sum /usr/local/bin/mesh-llm > /usr/local/share/magicstick-mesh.sha256
WORKDIR /app
COPY magic-cluster/apps/ai/private-mesh/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY core/magicstick_core ./magicstick_core
COPY LICENSE LICENSING.md THIRD_PARTY_NOTICES.md /usr/local/share/licenses/
COPY licenses /usr/local/share/licenses/licenses
COPY LICENSE-RELEASE.json /usr/local/share/licenses/
COPY tools/collect_python_notices.py /tmp/collect_python_notices.py
RUN python /tmp/collect_python_notices.py --all-installed --output /usr/local/share/licenses/runtime-python.txt && rm /tmp/collect_python_notices.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MESH_STATE_DIR=/state PYTHONPATH=/app
USER 65532:65532
ENTRYPOINT ["python", "/app/magicstick_core/private_mesh/server.py"]
