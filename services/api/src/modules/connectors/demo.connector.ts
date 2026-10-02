import { Connector, ConnectorOutput, emptyOutput, TransformInput } from './connector.types';

/**
 * Tier E — fully FICTIONAL offline dataset that mirrors the narrative-network methodology of the paper
 * (origin → common issue package → amplifiers → target → observed pattern → unverified rumour).
 * All names, accounts and organisations are invented; every entity carries properties.demo = true.
 */
export const DEMO_ORIGIN_ORG = 'Forum Pesisir Nusantara';

const ORGS = [
  { key: 'fpn', name: DEMO_ORIGIN_ORG, handle: 'fpn_official', role: 'narrative origin' },
  { key: 'amp', name: 'Aliansi Mahasiswa Pesisir', handle: 'amp_pesisir', claimed: 80 },
  { key: 'ipk', name: 'Ikatan Pemuda Kepulauan', handle: 'ipk_kepulauan', claimed: 100 },
  { key: 'fnb', name: 'Front Nelayan Bersatu', handle: 'fnb_nelayan', claimed: 300 },
  { key: 'sta', name: 'Solidaritas Tanah Adat', handle: 'sta_adat', claimed: 200 },
  { key: 'jalt', name: 'Jaringan Advokasi Lingkungan Timur', handle: 'jalt_env', claimed: 150 },
];
const PEOPLE = [
  { key: 'p1', name: 'Darius Kelanit', org: 'fpn', title: 'Koordinator' },
  { key: 'p2', name: 'Maria Serumena', org: 'amp', title: 'Ketua' },
  { key: 'p3', name: 'Tobias Wairata', org: 'fnb', title: 'Juru bicara' },
  { key: 'p4', name: 'Lukas Ohoitimur', org: 'sta', title: 'Sekretaris' },
];
const TARGET = 'PT Samudra Energi Timur';
const SECONDARY = 'Kementerian Sumber Daya Kelautan';
const PETITION = 'https://petisi.demo.invalid/audit-amdal-pesisir';

const CLAIMS = [
  'Lahan 28,9 hektare milik warga pesisir diambil tanpa persetujuan masyarakat adat.',
  'Dokumen AMDAL proyek gas laut cacat prosedur dan harus diaudit ulang.',
  'Hak masyarakat adat atas wilayah tangkap nelayan diabaikan oleh perusahaan.',
  'Kami menuntut PT Samudra Energi Timur menghentikan kegiatan sampai audit AMDAL selesai.',
];

export class DemoDatasetConnector implements Connector {
  readonly def = {
    key: 'demo.fictional-network',
    name: 'DEMO — Fictional Coastal Protest Network',
    owner: 'Platform (synthetic)',
    category: 'Demo / training',
    tier: 'E' as const,
    accessMethod: 'INTERNAL_SYNTHETIC',
    legalBasis: 'Synthetic data generated locally for training and demonstration. Contains no real persons.',
    authMode: 'INTERNAL' as const,
    rateLimitPerMin: 60,
    allowedFields: ['all (synthetic)'],
    inputTypes: ['ORGANIZATION', 'NARRATIVE', 'EVENT', 'PERSON'] as any,
    outputTypes: ['ORGANIZATION', 'PERSON', 'SOCIAL_ACCOUNT', 'ARTICLE', 'EVENT', 'URL', 'EMAIL'] as any,
    retentionDays: 30,
    defaultPolicy: 'APPROVED' as const,
    autoRun: false,
    description:
      'Loads a fictional narrative network (6 organisations, 4 persons, ~30 posts over 5 days with a burst) to exercise graph, timeline, narrative and resolution features offline.',
  };

  async run(_input: TransformInput): Promise<ConnectorOutput> {
    const out = emptyOutput();
    const demo = { demo: true };
    const day = (d: number, h: number) => {
      const t = new Date();
      t.setUTCHours(h, (d * 7 + h * 13) % 60, 0, 0);
      t.setUTCDate(t.getUTCDate() - d);
      return t.toISOString();
    };
    out.observations.push({ ref: 'manifest', raw: JSON.stringify({ dataset: this.def.name, fictional: true }), contentType: 'application/json', title: 'Demo dataset manifest (fictional)' });
    for (const o of ORGS) {
      out.entities.push({ ref: o.key, type: 'ORGANIZATION', value: o.name, properties: { ...demo, role: o.role ?? 'amplifier', claimed_participants: o.claimed ?? null }, confidence: 0.9, obsRef: 'manifest' });
      out.entities.push({ ref: `${o.key}-acct`, type: 'SOCIAL_ACCOUNT', value: `demo:${o.handle}`, properties: { ...demo, platform: 'demo-social', handle: o.handle, profile_url: `https://social.demo.invalid/${o.handle}` }, confidence: 0.9, obsRef: 'manifest' });
      out.relationships.push({ from: o.key, type: 'HAS_ACCOUNT', to: `${o.key}-acct`, confidence: 0.9, obsRef: 'manifest' });
    }
    out.entities.push({ ref: 'email', type: 'EMAIL', value: 'sekretariat@fpn.demo.invalid', properties: demo, confidence: 0.9, obsRef: 'manifest' });
    out.relationships.push({ from: 'fpn', type: 'HAS_EMAIL', to: 'email', confidence: 0.9, obsRef: 'manifest' });
    for (const p of PEOPLE) {
      out.entities.push({ ref: p.key, type: 'PERSON', value: p.name, hints: { discriminator: `demo:${p.key}` }, properties: { ...demo, title: p.title }, confidence: 0.8, obsRef: 'manifest' });
      out.relationships.push({ from: p.key, type: 'MEMBER_OF', to: p.org, confidence: 0.8, label: p.title, obsRef: 'manifest' });
    }
    // A second, differently-sourced record of the coordinator — a resolution-workbench candidate.
    out.entities.push({ ref: 'p1b', type: 'PERSON', value: 'Darius Kelanit', hints: { discriminator: 'demo:press-list' }, properties: { ...demo, note: 'from press contact list' }, confidence: 0.6, obsRef: 'manifest' });
    out.relationships.push({ from: 'p1b', type: 'HAS_EMAIL', to: 'email', confidence: 0.7, obsRef: 'manifest' });
    out.relationships.push({ from: 'p1', type: 'HAS_EMAIL', to: 'email', confidence: 0.7, obsRef: 'manifest' });
    out.relationships.push({ from: 'p1b', type: 'MEMBER_OF', to: 'fpn', confidence: 0.6, obsRef: 'manifest' });

    out.entities.push({ ref: 'target', type: 'ORGANIZATION', value: TARGET, properties: { ...demo, role: 'primary pressure target' }, confidence: 0.9, obsRef: 'manifest' });
    out.entities.push({ ref: 'secondary', type: 'ORGANIZATION', value: SECONDARY, properties: { ...demo, role: 'secondary target' }, confidence: 0.9, obsRef: 'manifest' });
    out.entities.push({ ref: 'petition', type: 'URL', value: PETITION, properties: { ...demo, title: 'Petisi audit AMDAL pesisir' }, confidence: 0.9, obsRef: 'manifest' });
    out.entities.push({ ref: 'event', type: 'EVENT', value: `Aksi damai di kantor ${TARGET}`, properties: { ...demo, date: day(1, 3).slice(0, 10), location: 'Jakarta' }, confidence: 0.8, obsRef: 'manifest' });

    let n = 0;
    const post = (org: (typeof ORGS)[number], d: number, h: number, text: string, opts: { share?: boolean; mention?: string[] } = {}) => {
      const ref = `post${n}`;
      const url = `https://social.demo.invalid/${org.handle}/status/${1000 + n}`;
      out.observations.push({ ref: `o${ref}`, url, title: `@${org.handle}: ${text.slice(0, 80)}`, text, author: `@${org.handle}`, publishedAt: day(d, h), raw: JSON.stringify({ id: 1000 + n, account: org.handle, text, fictional: true }), contentType: 'application/json', extract: true, entityRef: ref });
      out.entities.push({ ref, type: 'ARTICLE', value: url, properties: { ...demo, title: text.slice(0, 120), publisher: `@${org.handle}`, kind: 'post' }, confidence: 1, obsRef: `o${ref}` });
      out.relationships.push({ from: `${org.key}-acct`, type: 'PUBLISHED', to: ref, confidence: 1, obsRef: `o${ref}` });
      if (opts.share) out.relationships.push({ from: `${org.key}-acct`, type: 'SHARED', to: 'petition', confidence: 1, obsRef: `o${ref}` });
      n++;
    };
    const [fpn, amp, ipk, fnb, sta, jalt] = ORGS;
    // Day -5/-4: origin publishes the issue package.
    post(fpn, 5, 2, `Kajian ${DEMO_ORIGIN_ORG}: ${CLAIMS[0]} ${CLAIMS[1]} #AuditAMDAL #PesisirBersuara`, { share: true });
    post(fpn, 5, 9, `${CLAIMS[2]} Hubungi sekretariat@fpn.demo.invalid untuk dokumen lengkap. #PesisirBersuara`);
    post(fpn, 4, 4, `${CLAIMS[3]} Tanda tangani petisi ${PETITION} #AuditAMDAL`, { share: true });
    // Day -3: early amplifiers.
    post(sta, 3, 1, `${CLAIMS[2]} Solidaritas Tanah Adat berdiri bersama nelayan. #PesisirBersuara`);
    post(jalt, 3, 6, `${CLAIMS[1]} Jaringan Advokasi Lingkungan Timur mendesak ${SECONDARY} turun tangan. #AuditAMDAL`, { share: true });
    // Day -2: burst — near-identical wording across many accounts.
    for (const [i, o] of [amp, ipk, fnb, sta, jalt, amp, ipk, fnb].entries()) {
      const c = CLAIMS[i % CLAIMS.length];
      post(o, 2, 1 + i, `${c} Besok kami turun ke kantor ${TARGET}. #AuditAMDAL #PesisirBersuara`, { share: i % 2 === 0 });
    }
    post(fnb, 2, 11, `Front Nelayan Bersatu siap mengerahkan 300 anggota. ${CLAIMS[0]}`);
    post(amp, 2, 12, `Aliansi Mahasiswa Pesisir: 80 mahasiswa akan hadir. ${CLAIMS[3]}`);
    // Day -1: event day.
    post(ipk, 1, 3, `Aksi damai dimulai di depan kantor ${TARGET}. ${CLAIMS[3]} #AuditAMDAL`);
    post(sta, 1, 4, `Massa aksi membacakan tuntutan: ${CLAIMS[1]}`);
    post(jalt, 1, 5, `Perwakilan diterima pihak ${TARGET}; audit AMDAL akan dibahas. #PesisirBersuara`);
    // Observed pattern + unverified rumour.
    post(ipk, 1, 9, `Warga menyebut jumlah peserta di lapangan jauh lebih sedikit dari klaim 300 orang.`);
    post(amp, 1, 12, `Beredar kabar ada dana Rp30 juta untuk mobilisasi massa — belum ada bukti. #Klarifikasi`);
    post(fpn, 0, 2, `${DEMO_ORIGIN_ORG} membantah isu dana mobilisasi. ${CLAIMS[1]}`);

    for (const o of [amp, ipk, fnb, sta, jalt]) {
      out.relationships.push({ from: o.key, type: 'PARTICIPATED_IN', to: 'event', confidence: 0.7, label: `claimed ${o.claimed} participants`, obsRef: 'manifest' });
      out.relationships.push({ from: o.key, type: 'ASSOCIATED_WITH', to: 'target', confidence: 0.6, label: 'pressure campaign (source claim)', obsRef: 'manifest' });
    }
    out.relationships.push({ from: 'fpn', type: 'ASSOCIATED_WITH', to: 'target', confidence: 0.5, label: 'issue package origin (analytical hypothesis)', obsRef: 'manifest' });
    out.relationships.push({ from: 'jalt', type: 'ASSOCIATED_WITH', to: 'secondary', confidence: 0.5, label: 'secondary target (source claim)', obsRef: 'manifest' });
    out.notes = ['Fictional demo dataset loaded — not real persons or organisations.'];
    return out;
  }
}
