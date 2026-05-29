FROM node:20-slim

# Instalar dependencias del sistema
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar package.json e instalar dependencias de producción
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar el resto del código
COPY . .

# Crear directorio para la DB (se sobreescribe con el volumen en Fly.io)
RUN mkdir -p /data

# Variables de entorno con defaults
ENV PORT=3000 \
    NODE_ENV=production \
    DB_PATH=/data/dungeon.sqlite

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server/index.js"]
