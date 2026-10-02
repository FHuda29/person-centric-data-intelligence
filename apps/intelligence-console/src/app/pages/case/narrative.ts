import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, fmtDate, Toast } from '../../core/api';
import { EntIcon } from '../../shared/ui';
import { CaseContext } from './case-context';

@Component({
  selector: 'app-narrative',
  imports: [RouterLink, EntIcon],
  template: `
    <div class="page">
      <div class="row mb">
        <div class="grow"><h1>Narrative & network intelligence</h1>
          <div class="small muted">Narrative origin → common claim cluster → amplifying actors → target → observed pattern → evidence / contradiction / unverified.</div></div>
        @if (ctx.canEdit()) { <button class="primary" (click)="analyze()" [disabled]="busy()">{{ busy() ? 'Analysing…' : 'Run analysis' }}</button> }
      </div>
      @if (d(); as n) {
        <div class="notice mb">{{ n.disclaimer }}</div>

        <div class="card">
          <h4>Content volume per day</h4>
          @if (n.volume.length) {
            <svg [attr.viewBox]="'0 0 ' + chartW() + ' 130'" class="chart" role="img" aria-label="Daily content volume">
              @for (v of n.volume; track v.day; let i = $index) {
                <g [attr.transform]="'translate(' + i * bw() + ',0)'">
                  <rect [attr.x]="(bw() - barW()) / 2" [attr.y]="110 - (v.count / maxVol()) * 96" [attr.height]="(v.count / maxVol()) * 96" [attr.width]="barW()" rx="3" [attr.fill]="v.burst ? '#f59e0b' : '#4c8dff'"><title>{{ v.day }}: {{ v.count }}{{ v.burst ? ' (burst)' : '' }}</title></rect>
                  <text [attr.x]="bw() / 2" y="124" text-anchor="middle">{{ v.day.slice(5) }}</text>
                  <text [attr.x]="bw() / 2" [attr.y]="106 - (v.count / maxVol()) * 96" text-anchor="middle" class="n">{{ v.count }}</text>
                </g>
              }
            </svg>
            <div class="tiny muted"><span class="dot" style="background:#f59e0b"></span> temporal burst (volume &gt; mean + 2σ, or dominant peak)</div>
          } @else { <div class="muted small">No textual content collected yet.</div> }
        </div>

        <div class="grid grid-2 mt">
          <div class="card">
            <h4>Repeated claim clusters ({{ n.claims.length }})</h4>
            @for (c of n.claims; track c.id) {
              <div class="cl">
                <div class="row"><b class="grow">“{{ c.representative }}”</b></div>
                <div class="tiny muted">{{ c.observation_ids.length }} items · {{ c.source_count }} distinct actors · {{ fmt(c.first_seen) }} → {{ fmt(c.last_seen) }}</div>
                <details><summary class="small">Propagation timeline</summary>
                  @for (p of c.propagation; track p.observationId) {
                    <div class="prop small"><span class="mono tiny faint">{{ p.time.slice(0, 16).replace('T', ' ') }}</span> <b>{{ p.actor }}</b>
                      <span class="muted"> {{ p.text }}</span> @if (p.evidenceId) { <a class="tiny" [routerLink]="['../evidence']" [queryParams]="{ id: p.evidenceId }">evidence</a> }</div>
                  }
                </details>
              </div>
            } @empty { <div class="muted small">No repeated claims across ≥2 actors. Run analysis after collection.</div> }
          </div>
          <div class="col" style="gap:12px">
            <div class="card">
              <h4>Topic clusters ({{ n.topics.length }})</h4>
              @for (t of n.topics; track t.id) {
                <div class="row small" style="padding:4px 0;border-bottom:1px solid var(--border)">
                  <span class="grow">@for (k of t.keywords.slice(0, 6); track k) { <code class="kw">{{ k }}</code> }</span>
                  <span class="faint nowrap">{{ t.observation_ids.length }} items · {{ t.source_count }} actors</span>
                </div>
              } @empty { <div class="muted small">—</div> }
            </div>
            <div class="card">
              <h4>Publishing actors</h4>
              @for (a of n.actors; track a.actor) {
                <div class="row small" style="padding:2px 0"><ent-icon [type]="a.type" [size]="15" /><span class="grow">{{ a.actor }}</span><b>{{ a.published }}</b></div>
              } @empty { <div class="muted small">—</div> }
            </div>
            <div class="card">
              <h4>URL-sharing network</h4>
              @for (u of n.urlSharing; track u.url) {
                <div class="small" style="padding:3px 0;border-bottom:1px solid var(--border)"><div class="mono tiny break">{{ u.url }}</div>
                  <div class="muted">shared by {{ u.n }} accounts: {{ u.accounts.join(', ') }}</div></div>
              } @empty { <div class="muted small">No URL shared by ≥2 accounts.</div> }
            </div>
            <div class="card">
              <h4>Co-mention network (≥2 shared items)</h4>
              @for (c of n.coMention; track $index) {
                <div class="row small" style="padding:2px 0"><ent-icon [type]="c.a_type" [size]="14" />{{ c.a }} <span class="faint">↔</span> <ent-icon [type]="c.b_type" [size]="14" />{{ c.b }}<span class="spacer"></span><b>{{ c.weight }}</b></div>
              } @empty { <div class="muted small">—</div> }
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .chart { display: block; width: 100%; height: auto; } .chart text { fill: var(--muted); font-size: 9px; } .chart text.n { fill: var(--text-2); font-size: 10px; font-weight: 600; }
    .cl { padding: 8px 0; border-bottom: 1px solid var(--border); }
    .prop { padding: 3px 0 3px 10px; border-left: 2px solid var(--border-2); margin: 3px 0 3px 4px; }
    .kw { background: var(--bg-2); padding: 1px 5px; border-radius: 4px; margin-right: 4px; }
    details summary { cursor: pointer; color: var(--accent); margin-top: 4px; }
  `,
})
export class NarrativePage {
  private api = inject(Api);
  private toast = inject(Toast);
  ctx = inject(CaseContext);
  fmt = fmtDate;
  d = signal<any | null>(null);
  busy = signal(false);
  maxVol = computed(() => Math.max(1, ...(this.d()?.volume ?? []).map((v: any) => v.count)));
  /** Chart spans a fixed 1000-unit width: one slot per day, bars capped so few days don't render as slabs. */
  chartW = computed(() => 1000);
  bw = computed(() => 1000 / Math.max(1, this.d()?.volume.length ?? 1));
  barW = computed(() => Math.max(4, Math.min(56, this.bw() * 0.62)));

  constructor() {
    effect(() => {
      this.ctx.version();
      if (this.ctx.caseId()) untracked(() => void this.load());
    });
  }

  async load() {
    try {
      this.d.set(await this.api.get('/narratives', { caseId: this.ctx.caseId() }));
    } catch (e) {
      this.toast.error(e);
    }
  }

  async analyze() {
    this.busy.set(true);
    try {
      const r = await this.api.post<any>('/narratives/analyze', { caseId: this.ctx.caseId() });
      this.toast.show(`Analysed ${r.documents} items: ${r.claims} claim clusters, ${r.topics} topics`);
      this.ctx.bump();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}
