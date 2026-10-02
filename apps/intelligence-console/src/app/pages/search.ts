import { Component, computed, effect, inject, OnDestroy, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { DomSanitizer } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api, AuthStore, fmtDate, Toast } from '../core/api';
import { ENTITY_TYPES, TYPE_LABEL } from '../core/entity-style';
import { EntChip, UiIcon } from '../shared/ui';

type Group = 'social' | 'news' | 'web' | 'community';

interface Platform {
  label: string;
  abbr: string;
  color: string;
  group: Group;
}

const PLATFORMS: Record<string, Platform> = {
  facebook: { label: 'Facebook', abbr: 'f', color: '#1877f2', group: 'social' },
  instagram: { label: 'Instagram', abbr: 'IG', color: '#d62976', group: 'social' },
  threads: { label: 'Threads', abbr: '@', color: '#6b7280', group: 'social' },
  linkedin: { label: 'LinkedIn', abbr: 'in', color: '#0a66c2', group: 'social' },
  x: { label: 'X / Twitter', abbr: 'X', color: '#525252', group: 'social' },
  tiktok: { label: 'TikTok', abbr: 'TT', color: '#ee1d52', group: 'social' },
  youtube: { label: 'YouTube', abbr: '▶', color: '#ff0000', group: 'social' },
  bluesky: { label: 'Bluesky', abbr: 'B', color: '#1185fe', group: 'social' },
  mastodon: { label: 'Mastodon', abbr: 'M', color: '#6364ff', group: 'social' },
  reddit: { label: 'Reddit', abbr: 'r/', color: '#ff4500', group: 'social' },
  github: { label: 'GitHub', abbr: 'GH', color: '#6e7681', group: 'community' },
  stackoverflow: { label: 'Stack Overflow', abbr: 'SO', color: '#f48024', group: 'community' },
  hackernews: { label: 'Hacker News', abbr: 'Y', color: '#ff6600', group: 'community' },
  news: { label: 'News portal', abbr: 'N', color: '#0ea5e9', group: 'news' },
  wikipedia: { label: 'Wikipedia', abbr: 'W', color: '#8b949e', group: 'web' },
  web: { label: 'Web', abbr: '◎', color: '#64748b', group: 'web' },
};

const HOSTS: [RegExp, string][] = [
  [/(^|\.)(facebook|fb)\.com$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)threads\.(net|com)$/, 'threads'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)(twitter|x)\.com$/, 'x'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)bsky\.app$/, 'bluesky'],
  [/(^|\.)reddit\.com$/, 'reddit'],
  [/(^|\.)github\.com$/, 'github'],
  [/(^|\.)stackoverflow\.com$/, 'stackoverflow'],
  [/(^|\.)ycombinator\.com$/, 'hackernews'],
  [/(^|\.)wikipedia\.org$/, 'wikipedia'],
];
const NEWS_SOURCES = new Set(['gnews.rss', 'searxng.news', 'gdelt.news']);

const GROUPS: { key: Group | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'social', label: 'Social media' },
  { key: 'news', label: 'News portals' },
  { key: 'web', label: 'Web' },
  { key: 'community', label: 'Developer & community' },
];

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

function platformOf(url: string, sourceKey: string): string {
  if (sourceKey === 'mastodon.accounts') return /threads\./.test(url) ? 'threads' : 'mastodon';
  const host = hostOf(url);
  for (const [re, p] of HOSTS) if (re.test(host)) return p;
  if (NEWS_SOURCES.has(sourceKey)) return 'news';
  return 'web';
}

@Component({
  selector: 'app-search',
  imports: [FormsModule, RouterLink, EntChip, UiIcon],
  template: `
    <div class="page">
      <div class="page-head">
        <div class="grow">
          <h1>Search</h1>
          <div class="muted">Sweep public web, social media and news portals for a person or identifier — or search data already collected in your cases.</div>
        </div>
      </div>

      <form class="qbar card" (ngSubmit)="submit()">
        <div class="seg" role="tablist">
          <button type="button" [class.on]="mode() === 'sweep'" (click)="setMode('sweep')" [disabled]="!auth.canEdit()"><ui-icon name="sparkle" [size]="14" />Live sweep</button>
          <button type="button" [class.on]="mode() === 'collected'" (click)="setMode('collected')"><ui-icon name="layers" [size]="14" />Collected data</button>
        </div>
        <div class="qwrap">
          <ui-icon name="search" [size]="17" />
          <input name="q" [(ngModel)]="query" autocomplete="off"
            [placeholder]="mode() === 'sweep' ? 'Full name, @handle, email, +62… phone, domain…' : 'Full-text query — supports &quot;exact phrase&quot;, -exclude, OR'" />
        </div>
        <button class="primary go" [disabled]="query.trim().length < 3">{{ mode() === 'sweep' ? 'Start sweep' : 'Search' }}</button>
        @if (mode() === 'collected') {
          <div class="filters">
            <select name="case" [(ngModel)]="caseId"><option value="">All my cases</option>@for (c of cases(); track c.id) { <option [value]="c.id">{{ c.code }} — {{ c.title }}</option> }</select>
            <select name="et" [(ngModel)]="entityType"><option value="">Any entity type</option>@for (t of types; track t) { <option [value]="t">{{ label[t] }}</option> }</select>
            <input name="from" type="date" [(ngModel)]="from" aria-label="From" /><input name="to" type="date" [(ngModel)]="to" aria-label="To" />
          </div>
        }
      </form>

      @if (mode() === 'sweep') {
        @if (sweep(); as s) {
          <div class="sweep-head">
            <div class="grow">
              <h2>{{ running() ? 'Sweeping' : 'Sweep results for' }} “{{ sweepQ() }}”</h2>
              <div class="small muted">{{ counts()["all"] }} result(s) · {{ s.accounts.length }} candidate account(s) · every query and result is recorded as evidence in the case
                @if (caseCode()) { <a [routerLink]="['/cases', sweepCase()]">{{ caseCode() }}</a> }</div>
            </div>
            <a class="btn" [routerLink]="['/cases', sweepCase(), 'graph']"><ui-icon name="graph" [size]="15" />Open graph</a>
          </div>

          <div class="sources">
            @for (j of s.jobs; track $index) {
              <span class="src {{ j.status }}" [title]="j.error || (j.result_summary?.notes?.[0] ?? '')">
                @if (j.status === 'QUEUED' || j.status === 'RUNNING') { <span class="spin"></span> }
                @else if (j.status === 'COMPLETED') { <span class="ok">✓</span> }
                @else { <span class="bad">!</span> }
                {{ j.source_name }}
                @if (j.result_summary) { <b>{{ j.result_summary.observations ?? 0 }}</b> }
              </span>
            }
          </div>
          @if (blocked().length) {
            <div class="notice info small">Not queried (needs API credentials or approval): {{ blocked().join(', ') }} — see Transform Hub.</div>
          }

          <div class="cols">
            <section>
              <div class="gtabs">
                @for (g of groups; track g.key) {
                  <button [class.on]="group() === g.key" (click)="group.set(g.key)">{{ g.label }} <span>{{ counts()[g.key] ?? 0 }}</span></button>
                }
              </div>
              <div class="results">
                @for (r of shown(); track r.id) {
                  <article class="res">
                    <span class="pf" [style.background]="pf(r.platform).color">{{ pf(r.platform).abbr }}</span>
                    <div class="grow">
                      <div class="meta"><b>{{ pf(r.platform).label }}</b><span class="faint">· {{ host(r.url) }}</span>
                        @if (r.published_at) { <span class="faint">· {{ fmt(r.published_at, false) }}</span> }</div>
                      <a class="title" [href]="r.url" target="_blank" rel="noopener noreferrer">{{ r.title || r.url }}</a>
                      @if (snippet(r); as sn) { <p class="snip">{{ sn }}</p> }
                      <div class="tiny faint">via {{ r.source_name }} ·
                        <a [routerLink]="['/cases', sweepCase(), 'evidence']" [queryParams]="{ id: r.evidence_id }">evidence</a></div>
                    </div>
                  </article>
                } @empty {
                  <div class="empty">{{ running() ? 'Collecting… results appear here as each source finishes.' : 'No results in this group.' }}</div>
                }
              </div>
            </section>

            <aside class="card acc">
              <h3>Candidate accounts <span class="count">{{ s.accounts.length }}</span></h3>
              <p class="tiny faint">Accounts whose name or handle matches the query. A name match is a lead, not proof that the account belongs to the person — verify in the case before relying on it.</p>
              @for (a of s.accounts.slice(0, accLimit()); track a.id) {
                <div class="acct">
                  <span class="pf sm" [style.background]="pf(a.properties?.platform).color">{{ pf(a.properties?.platform).abbr }}</span>
                  <div class="grow">
                    <div class="ellipsis"><b>{{ a.properties?.display_name || a.properties?.handle || a.label }}</b></div>
                    <div class="tiny muted ellipsis" [title]="a.properties?.search_title ?? ''">{{ pf(a.properties?.platform).label }}
                      @if (a.properties?.display_name) { · {{ a.properties?.handle }} } @else if (a.properties?.search_title) { · “{{ a.properties.search_title }}” }</div>
                  </div>
                  @if (a.properties?.profile_url) { <a class="btn sm" [href]="a.properties.profile_url" target="_blank" rel="noopener noreferrer">Open</a> }
                </div>
              } @empty { <div class="empty">{{ running() ? 'Looking for accounts…' : 'No candidate accounts.' }}</div> }
              @if (s.accounts.length > accLimit()) { <button class="ghost sm" (click)="accLimit.set(accLimit() + 30)">Show more</button> }
            </aside>
          </div>
        } @else {
          <div class="intro card">
            <h3>What a sweep covers</h3>
            <div class="cov">
              <div><b>Social media</b><span>Facebook, Instagram, Threads, LinkedIn, X, TikTok, YouTube (via search-engine index) · Bluesky, Mastodon/Fediverse (official APIs) · Reddit, X, YouTube, Bluesky posts (official APIs with keys)</span></div>
              <div><b>News portals</b><span>Google News (Indonesian portals), news search engines, GDELT</span></div>
              <div><b>Web</b><span>Public web search, Wikipedia / Wikidata</span></div>
              <div><b>Developer & community</b><span>GitHub, Stack Overflow, Hacker News, GitLab, Keybase</span></div>
            </div>
            <p class="tiny faint">Platforms are never logged into and login walls are not bypassed; content behind a login is out of scope. Every sweep runs inside a case with a documented purpose and is audited.</p>
          </div>
        }
      } @else {
        @if (res(); as r) {
          <div class="small muted mb">{{ r.total }} content hit(s) · engine {{ r.engine }} · query is audited
            @if (r.facets?.sources?.length) { · @for (f of r.facets.sources; track f.key) { <a (click)="source = f.key; runCollected()" style="cursor:pointer">{{ f.key }} ({{ f.doc_count }})</a>&ngsp;} }
            @if (source) { · <a (click)="source = ''; runCollected()" style="cursor:pointer">clear source filter</a> }</div>
          <div class="grid" style="grid-template-columns: minmax(0, 2fr) minmax(0, 1fr)">
            <div class="card flush">
              <div class="card-h"><h4>Collected content</h4></div>
              @for (h of r.content; track h.id) {
                <div class="hit">
                  <div><a [routerLink]="['/cases', h.case_id, 'evidence']" [queryParams]="{ id: h.evidence_id }"><b>{{ h.title || h.url }}</b></a></div>
                  <div class="tiny faint">{{ h.source_key }} · {{ h.author }} · {{ fmt(h.published_at) }}</div>
                  @for (frag of h.highlight?.content ?? []; track $index) { <div class="small muted" [innerHTML]="safe(frag)"></div> }
                </div>
              } @empty {
                <div class="empty">No collected content matches.
                  @if (auth.canEdit()) { <div class="mt"><button class="primary sm" (click)="setMode('sweep'); submit()">Run a live sweep for “{{ query }}”</button></div> }
                </div>
              }
            </div>
            <div class="card flush">
              <div class="card-h"><h4>Entities</h4></div>
              @for (e of r.entities; track e.id) {
                <div class="hit"><a [routerLink]="['/cases', e.caseId, 'entities', e.id]"><ent-chip [type]="e.type" [label]="e.label" /></a></div>
              } @empty { <div class="empty">No entities match.</div> }
            </div>
          </div>
        } @else { <div class="empty">Search across the content and entities of cases you can access. Filter by case, source, time and entity type.</div> }
      }
    </div>

    @if (ask()) {
      <div class="modal-bg" (click)="ask.set(false)">
        <form class="modal col" (click)="$event.stopPropagation()" (ngSubmit)="startSweep()">
          <h2>Sweep “{{ query.trim() }}”</h2>
          <p class="small muted">All approved sources run against this identifier. Results are stored as evidence in a case, so the purpose must be documented and is audited.</p>
          <label class="field">Purpose (required)
            <textarea name="purpose" rows="3" [(ngModel)]="purpose" placeholder="e.g. Background check of a prospective business partner under agreement 12/2026"></textarea></label>
          <label class="field">Legal / access basis
            <input name="legal" [(ngModel)]="legalBasis" placeholder="e.g. Consent of the subject / contract clause / internal policy" /></label>
          <label class="field">Store results in
            <select name="target" [(ngModel)]="targetCase">
              <option value="">New case “Sweep — {{ query.trim().slice(0, 40) }}”</option>
              @for (c of cases(); track c.id) { @if (c.status === 'OPEN') { <option [value]="c.id">{{ c.code }} — {{ c.title }}</option> } }
            </select></label>
          <div class="row"><span class="spacer"></span>
            <button type="button" class="ghost" (click)="ask.set(false)">Cancel</button>
            <button class="primary" [disabled]="busy() || (!targetCase && purpose.trim().length < 10)">{{ busy() ? 'Starting…' : 'Start sweep' }}</button>
          </div>
        </form>
      </div>
    }
  `,
  styles: `
    .qbar { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px; }
    .seg { display: flex; gap: 2px; padding: 3px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px; }
    .seg button { height: 32px; border: 0; background: transparent; color: var(--muted); }
    .seg button.on { background: var(--panel-3); color: var(--text); }
    .qwrap { position: relative; display: flex; align-items: center; color: var(--faint); }
    .qwrap ui-icon { position: absolute; left: 13px; pointer-events: none; }
    .qwrap input { width: 100%; height: 42px; padding-left: 40px; font-size: 15px; border-radius: 10px; }
    .go { height: 42px; padding: 0 20px; }
    .filters { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) 160px 160px; gap: 8px; }
    .sweep-head { display: flex; align-items: flex-end; gap: 12px; margin: 26px 0 12px; }
    .sweep-head h2 { margin: 0 0 4px; }
    .sources { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .src { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border-2); background: var(--panel); color: var(--text-2); }
    .src b { color: var(--text); } .src .ok { color: var(--ok); } .src .bad { color: var(--danger); font-weight: 700; }
    .src.DEAD, .src.FAILED { border-color: rgba(239,68,68,.35); } .src.SKIPPED { opacity: .55; }
    .cols { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; align-items: start; margin-top: 8px; }
    .gtabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px; }
    .gtabs button { height: 32px; border-radius: 999px; background: transparent; }
    .gtabs button.on { background: var(--accent-soft); border-color: rgba(76,141,255,.4); color: var(--accent-text); }
    .gtabs span { font-size: 11px; color: var(--muted); }
    .results { display: flex; flex-direction: column; gap: 8px; }
    .res { display: flex; gap: 14px; padding: 14px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; }
    .res:hover { border-color: var(--border-2); }
    .pf { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; flex: none; color: #fff; font: 700 12px var(--sans); }
    .pf.sm { width: 28px; height: 28px; font-size: 11px; }
    .meta { display: flex; gap: 6px; font-size: 12px; color: var(--text-2); margin-bottom: 2px; min-width: 0; }
    .title { font-size: 15px; font-weight: 600; line-height: 1.35; color: var(--accent-text); word-break: break-word; }
    .snip { margin: 4px 0 6px; font-size: 13px; color: var(--text-2); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .acc { position: sticky; top: 12px; }
    .acc h3 { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .count { font-size: 11.5px; font-weight: 600; color: var(--muted); background: var(--panel-3); border-radius: 999px; padding: 1px 8px; }
    .acct { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid var(--border); min-width: 0; }
    .intro { margin-top: 20px; }
    .cov { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 24px; margin: 10px 0 14px; }
    .cov div { display: flex; flex-direction: column; gap: 3px; font-size: 13px; } .cov span { color: var(--muted); }
    .hit { padding: 11px 20px; border-bottom: 1px solid var(--border); }
    .hit ::ng-deep em { background: rgba(245,158,11,.28); font-style: normal; color: var(--text); }
    @media (max-width: 1100px) { .cols { grid-template-columns: 1fr; } .acc { position: static; } .filters { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 700px) { .qbar { grid-template-columns: 1fr; } .cov { grid-template-columns: 1fr; } }
  `,
})
export class SearchPage implements OnDestroy {
  private params = toSignal(inject(ActivatedRoute).queryParamMap);
  q = computed(() => this.params()?.get('q') ?? undefined);
  sweepId = computed(() => this.params()?.get('sweep') ?? undefined);
  private api = inject(Api);
  private toast = inject(Toast);
  private router = inject(Router);
  private s = inject(DomSanitizer);
  auth = inject(AuthStore);
  types = ENTITY_TYPES;
  label = TYPE_LABEL;
  groups = GROUPS;
  fmt = fmtDate;
  query = '';
  caseId = '';
  entityType = '';
  source = '';
  from = '';
  to = '';
  purpose = '';
  legalBasis = '';
  targetCase = '';
  mode = signal<'sweep' | 'collected'>('sweep');
  res = signal<any | null>(null);
  cases = signal<any[]>([]);
  ask = signal(false);
  busy = signal(false);
  sweep = signal<{ items: any[]; accounts: any[]; jobs: any[] } | null>(null);
  sweepCase = signal('');
  sweepQ = signal('');
  group = signal<Group | 'all'>('all');
  accLimit = signal(30);
  private timer?: ReturnType<typeof setTimeout>;

  running = computed(() => (this.sweep()?.jobs ?? []).some((j) => j.status === 'QUEUED' || j.status === 'RUNNING'));
  caseCode = computed(() => this.cases().find((c) => c.id === this.sweepCase())?.code ?? '');
  blocked = signal<string[]>([]);
  private items = computed(() => {
    // the same page is often found by several sources (e.g. social and web search): show it once
    const seen = new Set<string>();
    const out: any[] = [];
    for (const r of this.sweep()?.items ?? []) {
      const key = String(r.url).replace(/^https?:\/\/(www\.|[a-z]{2}\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const platform = platformOf(r.url, r.source_key);
      out.push({ ...r, platform, group: PLATFORMS[platform]?.group ?? 'web' });
    }
    return out;
  });
  counts = computed(() => {
    const c: Record<string, number> = { all: this.items().length };
    for (const r of this.items()) c[r.group] = (c[r.group] ?? 0) + 1;
    return c;
  });
  shown = computed(() => {
    const g = this.group();
    const list = this.items().filter((r) => g === 'all' || r.group === g);
    // social first within "all", so profiles are not buried under web pages
    const rank: Record<string, number> = { social: 0, news: 1, community: 2, web: 3 };
    return g === 'all' ? [...list].sort((a, b) => rank[a.group] - rank[b.group]) : list;
  });

  constructor() {
    if (!this.auth.canEdit()) this.mode.set('collected');
    void this.loadCases();
    effect(() => {
      const q = this.q();
      const sw = this.sweepId();
      untracked(() => {
        if (q) this.query = q;
        if (sw) {
          this.mode.set('sweep');
          this.sweepQ.set(q ?? '');
          this.openSweep(sw);
        } else if (q) {
          // arriving from the top-bar search: show what is already collected, with a one-click sweep
          this.mode.set('collected');
          void this.runCollected();
        }
      });
    });
  }

  ngOnDestroy() {
    clearTimeout(this.timer);
  }

  private async loadCases() {
    try {
      this.cases.set(await this.api.get<any[]>('/cases'));
    } catch {
      /* listed lazily */
    }
  }

  pf(p: string | undefined): Platform {
    return PLATFORMS[p ?? ''] ?? { ...PLATFORMS['web'], label: p ?? 'Web', abbr: (p ?? 'W').slice(0, 2).toUpperCase() };
  }
  host = hostOf;

  /** Drops the title that connectors prepend to the stored text so the snippet adds information. */
  snippet(r: any): string {
    let s = String(r.snippet ?? '');
    if (r.title && s.startsWith(r.title)) s = s.slice(r.title.length).replace(/^[.\s]+/, '');
    return s;
  }

  setMode(m: 'sweep' | 'collected') {
    this.mode.set(m);
  }

  submit() {
    if (this.query.trim().length < 3) return;
    if (this.mode() === 'collected') {
      void this.router.navigate([], { queryParams: { q: this.query.trim() } });
      void this.runCollected();
      return;
    }
    this.ask.set(true);
  }

  async startSweep() {
    this.busy.set(true);
    try {
      const r = await this.api.post<any>('/cases/sweep', {
        q: this.query.trim(),
        caseId: this.targetCase || undefined,
        purpose: this.purpose.trim() || undefined,
        legalBasis: this.legalBasis.trim() || undefined,
      });
      this.ask.set(false);
      this.blocked.set((r.blockedSources ?? []).map((b: any) => b.source));
      this.toast.show(`Sweep started — ${r.queued} source job(s) queued`);
      void this.loadCases();
      void this.router.navigate([], { queryParams: { q: this.query.trim(), sweep: r.caseId } });
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  private openSweep(caseId: string) {
    if (this.sweepCase() !== caseId) {
      this.sweep.set(null);
      this.group.set('all');
      this.accLimit.set(30);
    }
    this.sweepCase.set(caseId);
    void this.poll();
  }

  private async poll() {
    clearTimeout(this.timer);
    const id = this.sweepCase();
    if (!id) return;
    try {
      const r = await this.api.get<any>(`/cases/${id}/sweep-results`);
      if (id !== this.sweepCase()) return;
      this.sweep.set(r);
      if (this.running() || !r.jobs.length) this.timer = setTimeout(() => void this.poll(), 3000);
    } catch (e) {
      this.toast.error(e);
    }
  }

  // OpenSearch highlights only wrap matches in <em>; everything else is escaped before rendering.
  safe(frag: string) {
    const esc = frag.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&lt;em&gt;/g, '<em>').replace(/&lt;\/em&gt;/g, '</em>');
    return this.s.bypassSecurityTrustHtml(esc);
  }

  async runCollected() {
    if (!this.query.trim()) return;
    try {
      this.res.set(
        await this.api.get('/search', {
          q: this.query,
          caseId: this.caseId,
          entityType: this.entityType,
          source: this.source,
          from: this.from ? `${this.from}T00:00:00Z` : null,
          to: this.to ? `${this.to}T23:59:59Z` : null,
        }),
      );
    } catch (e) {
      this.toast.error(e);
    }
  }
}
