# Deploy ke VPS

Ada dua target, masing-masing di `infra/deploy/targets/<nama>.env`:

| Target | VPS | Direktori | Domain | Caddy bersama (network) |
|---|---|---|---|---|
| `layanan` (default) | `103.93.163.188` (user `sysdev`) | `/opt/pcdi` | https://layanan.onesolusi.id | `hotel-erp-web-1` (`edge`) |
| `cari` | `139.190.104.27` (user `sysadmin`, key `MajuMapan.pem`) | `~/pcdi` | https://cari.onesolusi.web.id | `gamevora-caddy-1` (`gamevora_default`) |

Profil **lean** (tanpa OpenSearch/Neo4j/SearXNG — API pakai fallback PostgreSQL). Lihat `docker-compose.prod.yml`.
Nama network proxy diatur lewat `EDGE_NETWORK` di `.env` server. API punya alias unik `pcdi-api` karena
network proxy bersama juga berisi service `api` milik stack lain.

## Update rutin (sekali perintah)

Dari mesin lokal (Git Bash):

```bash
bash infra/deploy/deploy.sh --target=cari  # target VPS #2 (cari.onesolusi.web.id)
bash infra/deploy/deploy.sh            # target default "layanan": bundle -> transfer -> build -> up -d
bash infra/deploy/deploy.sh --yes      # tanpa konfirmasi
bash infra/deploy/deploy.sh --no-build # redeploy tanpa rebuild
bash infra/deploy/deploy.sh --with-caddy   # sekaligus (re)install site + reload Caddy
```

Override lewat env bila perlu: `VPS_HOST`, `VPS_USER`, `SSH_KEY`, `REMOTE_DIR` (menang atas file target).
Script **tidak** menyentuh `/opt/pcdi/.env` maupun volume data (pgdata/redisdata/miniodata).
Migrasi DB jalan otomatis saat API boot.

## Setup pertama kali (manual, sekali saja)

Contoh untuk target `layanan`. Untuk `cari`: direktori `~/pcdi`, user `sysadmin`, dan tambahkan
`EDGE_NETWORK=gamevora_default` ke `.env`; site Caddy = `infra/deploy/cari.onesolusi.web.id.caddy`
→ `~/gamevora/deploy/sites/`.

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
