# ==========================================
# ESTÁGIO 1: A Fábrica (Compilação)
# ==========================================
FROM ubuntu:24.04 AS builder
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get upgrade -y && apt-get install -y \
    build-essential cmake git pkg-config \
    libpq-dev libpqxx-dev libssl-dev libsodium-dev nlohmann-json3-dev libasio-dev libzip-dev libcurl4-openssl-dev

WORKDIR /src
COPY . .

# 2. Compila o projeto
WORKDIR /src/backend

RUN rm -rf build 
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=OFF
RUN cmake --build build --config Release --parallel $(nproc)

# ==========================================
# ESTÁGIO 2: O Servidor (Produção)
# ==========================================
FROM ubuntu:24.04 AS runtime
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    libpq5 libpqxx-dev libssl3 libsodium23 libzip4 libcurl4 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Remove pacotes desnecessarios para reduzir superficie de ataque
RUN apt-get purge -y --auto-remove gnupg2 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /src/backend/build/savebox_server /app/savebox_server
COPY --from=builder /src/docs /app/docs

RUN mkdir -p /app/savebox_storage
RUN useradd -m savebox && chown -R savebox:savebox /app
USER savebox
EXPOSE 8080

CMD ["./savebox_server"]