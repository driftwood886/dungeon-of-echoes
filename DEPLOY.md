# Guía de Deploy — Dungeon of Echoes

## Backend: Fly.io

### Prerequisitos
- Cuenta en https://fly.io (free tier disponible)
- `flyctl` instalado: https://fly.io/docs/hands-on/install-flyctl/

### Pasos

```bash
# 1. Autenticarse
flyctl auth login

# 2. Crear la app (solo la primera vez)
flyctl apps create dungeon-of-echoes

# 3. Crear volumen persistente para la base de datos SQLite
flyctl volumes create dungeon_data --size 1 --region gru

# 4. Configurar variable de entorno para la BD
flyctl secrets set DB_PATH=/data/dungeon.sqlite

# 5. Deploy
flyctl deploy

# 6. Verificar que funciona
curl https://dungeon-of-echoes.fly.dev/health
```

### Re-deploy (updates)

```bash
flyctl deploy
```

### Comandos útiles

```bash
flyctl status          # Estado de la app
flyctl logs            # Ver logs en tiempo real
flyctl ssh console     # SSH a la instancia
flyctl volumes list    # Ver volúmenes
```

### Reset de BD en producción

```bash
flyctl ssh console
cd /app
node scripts/reset-db.js --yes
exit
```

---

## Frontend: GitHub Pages

### Prerequisitos
- El repo debe ser público en GitHub

### Pasos

1. Ir a **Settings > Pages > Source: GitHub Actions**

2. Agregar la variable con la URL de Fly.io:
   - **Settings > Secrets and variables > Actions > Variables**
   - Nueva variable: `FLY_URL` = `https://dungeon-of-echoes.fly.dev`

3. Ir a **Actions > Deploy cliente a GitHub Pages > Run workflow**

4. El cliente estará disponible en:
   `https://driftwood886.github.io/dungeon-of-echoes/`

### Actualización automática

Cada push a `main` que toque archivos en `client/` dispara automáticamente un re-deploy.

---

## Arquitectura de producción

```
Browser (GitHub Pages)
    │
    ├── HTML/CSS/JS estáticos (driftwood886.github.io)
    │
    └── Socket.io + REST API (dungeon-of-echoes.fly.dev)
                │
                └── SQLite en /data/dungeon.sqlite (Fly.io Volume)
```

---

## Variables de entorno

| Variable | Descripción | Default local | Producción |
|----------|-------------|---------------|------------|
| `PORT` | Puerto del servidor | 3000 | 3000 (configurado en fly.toml) |
| `DB_PATH` | Ruta a la BD SQLite | `db/dungeon.sqlite` | `/data/dungeon.sqlite` |
| `NODE_ENV` | Entorno | - | production |
