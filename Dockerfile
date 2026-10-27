# ---- 1. 编译 sim.wasm（单机模式）与服务端 ----
FROM rust:1-bookworm AS rust
WORKDIR /app
RUN rustup target add wasm32-unknown-unknown
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY config ./config
RUN cargo build --release -p server \
 && cargo build -p sim-wasm --target wasm32-unknown-unknown --profile wasm

# ---- 2. 构建前端 ----
FROM node:22-bookworm AS client
WORKDIR /app/apps/client
COPY apps/client/package*.json ./
RUN npm ci
COPY apps/client ./
COPY --from=rust /app/target/wasm32-unknown-unknown/wasm/sim_wasm.wasm ./public/sim.wasm
RUN npm run build

# ---- 3. 运行镜像 ----
FROM debian:bookworm-slim
RUN useradd -m game && apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=rust /app/target/release/server /usr/local/bin/server
COPY --from=rust /app/target/release/replay /usr/local/bin/replay
COPY --from=client /app/apps/client/dist ./apps/client/dist
COPY config ./config
RUN mkdir logs && chown game:game logs
USER game
ENV RUST_LOG=info
EXPOSE 8080
CMD ["server"]
