FROM oven/bun:1 AS base
WORKDIR /app

# Install system dependencies (curl for proxy health check)
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Install all dependencies (including dev for build)
COPY package.json ./
RUN bun install

# Copy source + pre-built dashboard
COPY . .

# Expose ports
EXPOSE 1930

# Run production script (dashboard already built, will skip)
CMD ["bun", "run", "start:fast"]
