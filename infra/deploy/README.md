# Deploy ke VPS

Produksi berjalan di VPS Biznet `103.93.163.188` (user `sysdev`), di `/opt/pcdi`,
di belakang **Caddy bersama** (`hotel-erp-web-1`) via network docker eksternal `edge`.
Domain: **https://layanan.onesolusi.id**. Profil **lean** (tanpa OpenSearch/Neo4j/SearXNG —
API pakai fallback PostgreSQL). Lihat `docker-compose.prod.yml`.

## Update rutin (sekali perintah)

Dari mesin lokal (Git Bash):

```bash
bash infra/deploy/deploy.sh            # bundle -> transfer -> build -> up -d
bash infra/deploy/deploy.sh --yes      # tanpa konfirmasi
bash infra/deploy/deploy.sh --no-build # redeploy tanpa rebuild
bash infra/deploy/deploy.sh --with-caddy   # sekaligus (re)install site + reload Caddy
```

Override lewat env bila perlu: `VPS_HOST`, `VPS_USER`, `SSH_KEY`, `REMOTE_DIR`.
Script **tidak** menyentuh `/opt/pcdi/.env` maupun volume data (pgdata/redisdata/miniodata).
Migrasi DB jalan otomatis saat API boot.

## Setup pertama kali (manual, sekali saja)

```bash
# 1) direktori
ssh -i "$SSH_KEY" sysdev@103.93.163.188 'sudo mkdir -p /opt/pcdi && sudo chown sysdev:sysdev /opt/pcdi'

# 2) .env dengan secret kuat (hex = URL-safe). Isi juga BRAVE/NUMVERIFY bila dipakai.
ssh -i "$SSH_KEY" sysdev@103.93.163.188 'cat > /opt/pcdi/.env <<EOF
POSTGRES_USER=pcdi
POSTGRES_DB=pcdi
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
JWT_TTL=8h
MINIO_ROOT_USER=pcdi
MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$(openssl rand -hex 12)
ANALYST_USERNAME=analyst
ANALYST_PASSWORD=$(openssl rand -hex 12)
DEFAULT_PHONE_REGION=ID
WORKER_CONCURRENCY=2
NEWS_REGION=id-ID
NUMVERIFY_API_KEY=
NUMVERIFY_BASE_URL=http://apilayer.net/api/validate
EOF
chmod 600 /opt/pcdi/.env'

# 3) deploy pertama
bash infra/deploy/deploy.sh --yes

# 4) wiring domain ke Caddy bersama (sekali saja; atau pakai --with-caddy)
#    Snippet: infra/deploy/layanan.caddy  ->  /opt/hotel-erp/deploy/caddy-extra/
```

## Catatan

- **MinIO:** pakai `bitnamilegacy/minio:latest` — image resmi `quay.io/minio/minio` menolak pull anonim.
- Reload Caddy bersifat **atomik**: config invalid otomatis ditolak, config lama tetap jalan (SIMRS/Hotel ERP aman).
- Setelah deploy pertama: login admin, ganti password + aktifkan MFA, dan **approve connector numverify** di halaman Sources (default PENDING).
- Baca kredensial: `ssh ... 'grep -E "ADMIN_|ANALYST_" /opt/pcdi/.env'`.
