const env = (key: string, fallback?: string): string => {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${key}`);
    return fallback;
  }
  return v;
};

export const config = {
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL', 'postgres://pcdi:pcdi@localhost:5432/pcdi'),
  migrationsDir: env('MIGRATIONS_DIR', 'db/migrations'),
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  opensearchUrl: env('OPENSEARCH_URL', 'http://localhost:9200'),
  neo4jUrl: env('NEO4J_URL', 'bolt://localhost:7687'),
  neo4jUser: env('NEO4J_USER', 'neo4j'),
  neo4jPassword: env('NEO4J_PASSWORD', 'pcdi-neo4j-pass'),
  minio: {
    endPoint: env('MINIO_ENDPOINT', 'localhost'),
    port: Number(env('MINIO_PORT', '9000')),
    useSSL: env('MINIO_USE_SSL', 'false') === 'true',
    accessKey: env('MINIO_ACCESS_KEY', 'pcdi'),
    secretKey: env('MINIO_SECRET_KEY', 'pcdi-minio-secret'),
    bucket: env('MINIO_BUCKET', 'pcdi-evidence'),
  },
  jwtSecret: env('JWT_SECRET', 'change-me-in-production-please'),
  jwtTtl: env('JWT_TTL', '8h'),
  adminUsername: env('ADMIN_USERNAME', 'admin'),
  adminPassword: env('ADMIN_PASSWORD', 'Admin#12345'),
  analystUsername: env('ANALYST_USERNAME', 'analyst'),
  analystPassword: env('ANALYST_PASSWORD', 'Analyst#12345'),
  defaultPhoneRegion: env('DEFAULT_PHONE_REGION', 'ID'),
  autoMergeDeterministic: env('AUTO_MERGE_DETERMINISTIC', 'false') === 'true',
  braveApiKey: env('BRAVE_API_KEY', ''),
  /** numverify / APILayer phone-number validation API (carrier, line type, country). Empty disables it. */
  numverifyApiKey: env('NUMVERIFY_API_KEY', ''),
  /** numverify HTTPS endpoint is paid-plan only; the free plan must use the http host. */
  numverifyBaseUrl: env('NUMVERIFY_BASE_URL', 'http://apilayer.net/api/validate'),
  githubToken: env('GITHUB_TOKEN', ''),
  /** Self-hosted SearXNG metasearch (web, social search-index and news connectors). Empty disables them. */
  searxngUrl: env('SEARXNG_URL', ''),
  /** Google News RSS locale, "<language>-<REGION>". */
  newsRegion: env('NEWS_REGION', 'id-ID'),
  mastodonInstance: env('MASTODON_INSTANCE', 'mastodon.social'),
  redditClientId: env('REDDIT_CLIENT_ID', ''),
  redditClientSecret: env('REDDIT_CLIENT_SECRET', ''),
  youtubeApiKey: env('YOUTUBE_API_KEY', ''),
  xBearerToken: env('X_BEARER_TOKEN', ''),
  blueskyHandle: env('BLUESKY_HANDLE', ''),
  blueskyAppPassword: env('BLUESKY_APP_PASSWORD', ''),
  /** SandBase unified data API (licensed provider for public X / Instagram data). */
  sandbaseApiKey: env('SANDBASE_API_KEY', ''),
  /** RedditAPIs (redditapis.com) third-party Reddit read API token. */
  redditapisToken: env('REDDITAPIS_TOKEN', ''),
  httpUserAgent: env(
    'HTTP_USER_AGENT',
    'PCDI-OSINT-Platform/1.0 (+case-based research; respects robots.txt)',
  ),
  workerConcurrency: Number(env('WORKER_CONCURRENCY', '4')),
  collectorVersion: '1.0.0',
};
