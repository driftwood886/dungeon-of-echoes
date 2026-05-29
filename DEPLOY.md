# Guía de Deploy — Dungeon of Echoes

## Backend: Render.com ✅ (opción recomendada — gratuito)

### ¿Por qué Render y no Fly.io?
Fly.io requiere tarjeta de crédito y tiene costo para uso real. Render.com ofrece un tier
gratuito genuino para web services Node.js (750 horas/mes) sin tarjeta.

### ⚠️ Limitación importante del free tier
El free tier de Render **no incluye disco persistente**. La base de datos SQLite se guarda
en `/tmp` y se **pierde en cada redeploy o reinicio**. Para un juego demo esto es aceptable
(el dungeon se regenera automáticamente). Para producción real, agregar un disco persistente
($7/mes) o migrar a una base de datos externa.

### Pasos para deploy en Render.com

1. Ir a https://dashboard.render.com y crear cuenta (gratis, sin tarjeta)

2. Hacer clic en **New → Web Service**

3. Conectar el repositorio GitHub: `driftwood886/dungeon-of-echoes`

4. Render detecta automáticamente `render.yaml` — confirmar la configuración:
   - **Runtime:** Node
   - **Build Command:** `npm ci --omit=dev`
   - **Start Command:** `node server/index.js`
   - **Instance Type:** Free
   - **Region:** Oregon

5. Hacer clic en **Create Web Service**

6. Esperar el primer deploy (2-3 minutos). La URL será:
   `https://dungeon-of-echoes.onrender.com` (o similar con sufijo aleatorio)

7. Verificar que funciona:
   ```
   curl https://dungeon-of-echoes.onrender.com/health
   ```

### Variables de entorno en Render
El `render.yaml` ya configura las variables. Si querés cambiarlas desde el dashboard:
- `NODE_ENV` = `production`
- `PORT` = `10000` (Render usa este puerto por defecto)
- `DB_PATH` = `/tmp/dungeon.sqlite`

### Re-deploys automáticos
Cada push a `main` dispara un redeploy automático.

### Spin-down en idle
El free tier se "duerme" después de 15 minutos sin tráfico. El primer request tarda ~60 segundos
en despertar el servidor. Render muestra una pantalla de carga durante este tiempo.

---

## Frontend: GitHub Pages

### Prerequisitos
- El repo debe ser público en GitHub
- El backend ya debe estar deployado y tener su URL

### Pasos

1. Ir a **Settings > Pages > Source: GitHub Actions**

2. Agregar la variable con la URL de Render:
   - **Settings > Secrets and variables > Actions > Variables**
   - Nueva variable: `SERVER_URL` = `https://dungeon-of-echoes.onrender.com`
   - (Reemplazar con la URL real que te dio Render)

3. Ir a **Actions > Deploy cliente a GitHub Pages > Run workflow**

4. El cliente estará disponible en:
   `https://driftwood886.github.io/dungeon-of-echoes/`

### Actualización automática
Cada push a `main` que toque archivos en `client/` dispara automáticamente un re-deploy.

---

## Arquitectura de producción

```
Browser (GitHub Pages — gratis, estático)
    │
    ├── HTML/CSS/JS estáticos (driftwood886.github.io)
    │
    └── Socket.io + REST API (dungeon-of-echoes.onrender.com)
                │
                └── SQLite en /tmp/dungeon.sqlite (ephemeral en free tier)
```

---

## Variables de entorno

| Variable | Descripción | Default local | Producción (Render) |
|----------|-------------|---------------|---------------------|
| `PORT` | Puerto del servidor | 3000 | 10000 |
| `DB_PATH` | Ruta a la BD SQLite | `db/dungeon.sqlite` | `/tmp/dungeon.sqlite` |
| `NODE_ENV` | Entorno | - | production |

---

## Alternativa: Render con disco persistente ($7/mes)

Si querés persistencia real de la BD entre restarts:

1. En el dashboard de Render, ir al servicio → **Disks → Add Disk**
2. Nombre: `dungeon-data`, Mount path: `/data`, Size: 1 GB
3. Cambiar la variable `DB_PATH` a `/data/dungeon.sqlite`

O descomentar la sección `disk:` en `render.yaml`.

---

## Alternativa descartada: Fly.io

Config en `fly.toml` disponible si en el futuro se quiere usar Fly.io.
Requiere tarjeta de crédito verificada y tiene costo después del free tier limitado.
