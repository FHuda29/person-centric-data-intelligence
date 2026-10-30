# Person-Centric Data Intelligence & OSINT Graph Platform

Implementasi MVP dari *Paper Teknis v1.0 (September 2026)*: platform investigasi berbasis kasus yang
menjadikan identitas (nama, telepon/WhatsApp, email, alias, organisasi, domain, URL) sebagai titik awal,
dengan pola **Entity → Transform → Entity** (terinspirasi Maltego) di atas knowledge graph yang
setiap relasinya dapat ditelusuri ke evidence.

## Menjalankan

```bash
cp .env.example .env        # ganti semua secret sebelum dipakai di luar mesin lokal
docker compose up -d --build
```

| URL | Keterangan |
| --- | --- |
| http://localhost:8080 | Intelligence Console (Angular 22) |
| http://localhost:8080/health | Health API + status Postgres/Redis/OpenSearch/Neo4j |
| http://127.0.0.1:7474 | Neo4j Browser (user `neo4j`, password dari `.env`) |
| http://127.0.0.1:9001 | MinIO console (evidence object store) |

Akun awal (dibuat hanya bila tabel user kosong): `admin / Admin#12345` (ADMIN, boleh reveal PII)
dan `analyst / Analyst#12345` (ANALYST). Ganti password dan aktifkan MFA di menu **Account**.

**Coba cepat tanpa internet:** di halaman *Cases* klik **Load fictional demo case** → buka tab *Graph
Explorer* → setelah job selesai buka tab *Narrative* → **Run analysis**. Dataset demo sepenuhnya fiktif.

## Arsitektur

```
Angular 22 console (nginx :8080) ──/api/v1──► NestJS 11 API ──► BullMQ (Redis) ──► Worker (connectors)
                                                 │                                    │
                     PostgreSQL (system of record) · OpenSearch (full-text) · Neo4j (graph) · MinIO (evidence)
```

| Komponen | Implementasi |
| --- | --- |
| Frontend | Angular 22, standalone + signals, zoneless, Cytoscape.js (fcose) |
| API | NestJS 11 modular monolith (`services/api`), `/api/v1`, JWT + TOTP MFA, RBAC + case ACL, request-ID, idempotency key |
| Worker | Image yang sama (`dist/worker.js`): rate-limit per source, timeout, retry exponential, dead-letter queue, purge retensi terjadwal |
| Database | PostgreSQL 17, schema `iam, cases, sources, collection, intelligence, evidence, audit`; audit append-only via trigger |
| Search | OpenSearch 2.19 (indeks observasi & entitas); fallback PostgreSQL |
| Graph | Neo4j 5 (projection, neighbourhood, shortest path); fallback BFS PostgreSQL |
| Object storage | MinIO (raw HTML/JSON, dokumen, laporan) dialamatkan SHA-256 |
| Queue | BullMQ di Redis (paper menyebut Kafka/RabbitMQ — BullMQ dipilih agar stack MVP ringan; kontrak job tetap sama) |

Struktur repo mengikuti §15.1: `apps/intelligence-console`, `services/api`, `db/migrations`, `infra/docker`.

## Connector / Transform (Source Registry)

| Tier | Connector | Input → Output |
| --- | --- | --- |
| A | Wikidata (API resmi) | Person/Org → kandidat identitas, employer, keanggotaan, akun publik |
| A | Wikipedia id/en (API resmi) | Person/Org/Event → artikel (diekstrak NER) |
| A | RDAP (rdap.org) · DNS publik | Domain → registrar, nameserver, IP, MX |
| A | GitHub · GitLab/Keybase/HN/DEV · Gravatar | Username/Email → akun & profil publik |
| C | GDELT DOC 2.0 | Person/Org/Phone → berita (timeline & narrative) |
| A | Bluesky (akun) · Mastodon/Fediverse (akun, termasuk Threads yang ber-federasi) · Stack Overflow · GitHub (cari nama) · Hacker News | Person/Username → akun kandidat & postingan |
| A | Reddit · YouTube Data API · X API v2 · Bluesky (postingan) *(butuh kredensial, lihat `.env.example`)* | Person/Org → postingan publik |
| B | SandBase *(butuh `SANDBASE_API_KEY`, berbayar per panggilan, default PENDING)*: X (postingan + akun), Instagram (akun), TikTok (video + akun) | Person/Username → postingan & akun kandidat |
| B | RedditAPIs *(butuh `REDDITAPIS_TOKEN`, pihak ketiga, berbayar per panggilan)* | Person/Org → postingan Reddit |
| B | numverify/APILayer *(butuh `NUMVERIFY_API_KEY`, berbayar per panggilan, default PENDING)* | Phone → validitas, carrier, line type, negara numbering plan |
| C | SearXNG self-hosted: web, **media sosial via indeks mesin pencari** (Facebook, Instagram, Threads, LinkedIn, X, TikTok, YouTube), berita | Search expansion §3.1 → URL, profil kandidat, artikel |
| C | Google News RSS (`NEWS_REGION`, default portal Indonesia) | Person/Org → headline berita |
| C | Brave Search API *(butuh `BRAVE_API_KEY`, default PENDING)* | Search expansion §3.1 → URL kandidat |
| D | Public Web Page Collector | URL/Article → teks, kontak, link sosial (patuh robots.txt) |
| E | Identifier Parser · Analyst Intake · Document Upload · Demo fiktif | normalisasi E.164/email/URL, evidence intake, dokumen internal |

Admin dapat mengubah `policy_state` (APPROVED/PENDING/DISABLED) dan rate limit di **Transform Hub**;
collector menolak source yang tidak APPROVED/READY. Transform dijalankan lewat *Run investigation*
(seed + opsional 1 pivot hop) atau klik-kanan node di Graph Explorer.

**Live sweep** (halaman *Search*): ketik nama/identifier → isi tujuan (wajib, diaudit) → semua source
APPROVED dijalankan paralel dan hasilnya tampil per kelompok (media sosial, portal berita, web,
developer/komunitas) beserta akun kandidat. Hasil disimpan sebagai evidence di case (baru atau yang dipilih).
Platform tidak di-login dan login wall tidak ditembus: Facebook/Instagram/LinkedIn/TikTok hanya terlihat
sejauh halamannya terindeks mesin pencari. Hasil SearXNG yang tidak memuat *semua* token nama diabaikan
(respons mentah tetap tersimpan sebagai evidence); kecocokan nama tetap berstatus kandidat.

## Prinsip yang ditegakkan kode

- **Nama ≠ identitas.** Setiap kandidat person punya kunci diskriminator (`wikidata:Q…`, `github:…`, `mention`);
  skor resolusi memakai bobot §7 (phone .35, email .30, name .15, org .08, lokasi .05, username .05, temporal .02),
  status *review-ready* hanya dengan identifier deterministik, dan tidak ada auto-merge berbasis nama
  (auto-merge deterministik pun default mati — `AUTO_MERGE_DETERMINISTIC`).
- **Evidence-first.** Setiap observasi disimpan sebagai objek ber-hash SHA-256 dengan waktu retrieval,
  metode akses dan versi collector; relasi hanya bisa *CONFIRMED* bila punya evidence; setiap finding wajib ≥1 evidence;
  *CORROBORATED* butuh ≥2 sumber independen.
- **WhatsApp/telepon hanya identifier.** Tidak ada akses pesan, kontak, lokasi, autentikasi, atau bypass kontrol akses.
- **Governance.** Case wajib purpose; PII dimasking di list, reveal butuh izin + alasan dan diaudit; search/reveal/export/review tercatat
  di audit append-only; retensi per case dengan purge (DB, OpenSearch, Neo4j, MinIO).
- **Narrative ≠ koordinasi.** Kemiripan klaim, burst, dan centrality dilabeli sebagai struktur data, bukan bukti motif/koordinasi.

## Pengembangan lokal

```bash
docker compose up -d postgres redis opensearch neo4j minio
cd services/api && npm ci && npm run build && node dist/main.js      # API :3000 (butuh env ke localhost)
cd services/api && node dist/worker.js                               # worker
cd apps/intelligence-console && npm ci && npx ng serve               # :4200, proxy /api → :3000
```

## Batasan MVP / langkah berikut

OIDC/SSO eksternal (saat ini JWT lokal + TOTP), OpenTelemetry/Prometheus, parsing PDF, connector berlisensi (Tier B),
dan integrasi ontology maritim (Vessel/IMO/MMSI, §17.1) belum diimplementasikan. Implementasi produksi harus direview
terhadap UU PDP, terms tiap sumber, dan kebijakan internal — dokumen ini bukan pendapat hukum.


## Akses Production
Admin: `admin / IndonesiaRaya#17`
Analyst: `analyst / IndonsiaRaya#17`

## API Key
https://www.sandbase.ai/docs/developer/usage#api-keys
sk-e46fba24efa6059f8651a820c066297a73155cf094b203beb0a42bfecf0c30bf