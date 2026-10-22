# Multi-stage Dockerfile for opencode-share application

# Stage 1: Builder
FROM rust:latest as builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy Cargo files
COPY Cargo.toml Cargo.lock ./

# Create dummy main.rs to cache dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs

# Build dependencies (this layer is cached unless Cargo.toml changes)
RUN cargo build --release && rm -rf src

# Copy source code
COPY src ./src/
COPY migrations ./migrations/
COPY static ./static/
COPY templates ./templates/

# Build the application
RUN touch src/main.rs && cargo build --release

# Stage 2: Runtime
FROM debian:bookworm-slim

# Set working directory
WORKDIR /app

# Copy the binary from builder stage
COPY --from=builder /app/target/release/opencode-share ./opencode-share

# Copy migrations and static files
COPY --from=builder /app/migrations ./migrations/
COPY --from=builder /app/static ./static/
COPY --from=builder /app/templates ./templates/

# Expose port
EXPOSE 3006

# Set environment variables
ENV RUST_LOG=opencode_share=info,tower_http=info

# Run as unprivileged user
RUN useradd --system --no-create-home --uid 10001 app
USER app

# Run the application
CMD ["./opencode-share"]