import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, fmtDate, Toast } from '../../core/api';
import { colorOf, ENTITY_TYPES, TYPE_LABEL } from '../../core/entity-style';
import { EntChip, EntIcon, UiIcon } from '../../shared/ui';
import { CaseContext } from './case-context';

@Component({
  selector: 'app-case-dashboard',
  imports: [FormsModule, RouterLink, EntIcon, EntChip, UiIcon],
  template: `
    @if (ctx.data(); as c) {
      <div class="page dash">
        <section class="stats">
          @for (s of statTiles(c.stats); track s.label) {
            <div class="tile">
              <div class="tile-h"><span class="ti" [style.color]="s.color"><ui-icon [name]="s.icon" [size]="15" /></span><span class="ellipsis">{{ s.label }}</span></div>
              <b>{{ s.value }}</b>
            </div>
          }
        </section>

        <div class="cols">
          <div class="card seeds">
            <div class="card-title">
              <h3>Seeds <span class="count">{{ c.seeds.length }}</span></h3>
              <span class="spacer"></span>
              @if (ctx.canEdit()) {
                <label class="check small"><input type="checkbox" [(ngModel)]="depth2" /> +1 pivot hop</label>
                <button class="primary sm" (click)="run()" [disabled]="busy() || !c.seeds.length"><ui-icon name="play" [size]="13" />Run investigation</button>
              }
            </div>

            @if (ctx.canEdit()) {
              <form class="seed-form" (ngSubmit)="addSeed()">
                <select name="st" [(ngModel)]="seed.type">
                  <option value="">Auto-detect type</option>
                  @for (t of seedTypes; track t) { <option [value]="t">{{ label[t] }}</option> }
                </select>
                <input name="sv" [(ngModel)]="seed.value" placeholder="Name, +62… phone/WhatsApp, email, @alias, domain, URL…" />
                <button [disabled]="!seed.value.trim() || busy()"><ui-icon name="plus" [size]="15" />Add seed</button>
              </form>
              @for (s of secondary; track $index) {
                <div class="seed-form sec">
                  <select [(ngModel)]="s.type"><option value="PHONE">Phone / WhatsApp</option><option value="EMAIL">Email</option><option value="USERNAME">Alias / Username</option><option value="ORGANIZATION">Organization</option></select>
                  <input [(ngModel)]="s.value" placeholder="Secondary identifier lawfully held for this case" />
                  <button class="ghost" (click)="secondary.splice($index, 1)" aria-label="Remove">✕</button>
                </div>
              }
              <div class="row seed-actions">
                <button type="button" class="ghost sm" (click)="addSecondary()"><ui-icon name="plus" [size]="14" />Secondary identifier</button>
                @if (detected()) {
                  <span class="small muted ellipsis">Detected <b>{{ detected()!.type }}</b> → <code>{{ detected()!.canonicalKey }}</code>
                    @for (q of detected()!.queries; track q) { <code class="q">{{ q }}</code> }</span>
                }
              </div>
            }

            <div class="list">
              @for (s of c.seeds; track s.id) {
                <a class="li" [routerLink]="['entities', s.entity_id]">
                  <ent-chip class="grow" [type]="s.type" [label]="s.label ?? s.type" [size]="26" />
                  <span class="muted small">{{ label[s.type] ?? s.type }}</span>
                  <ui-icon name="chevron" [size]="14" />
                </a>
              } @empty { <div class="empty">No seeds yet — add one above to start the investigation.</div> }
            </div>
            @if (runResult()) {
              <div class="notice info mt small">
                Queued {{ runResult().queued.length }} transform(s); skipped {{ runResult().skipped.length }} (recently collected).
                @if (runResult().blockedSources.length) {
                  <br />Blocked by source policy: @for (b of runResult().blockedSources; track b.source) { <code>{{ b.source }}</code> ({{ b.reason }}) }
                }
              </div>
            }
            @if (ctx.canEdit()) {
              <div class="hint">Phone/WhatsApp numbers are normalised to E.164 and used only as identifiers/pivots on public or licensed sources — never to access messages, contacts or location.</div>
            }
          </div>

          <div class="card">
            <div class="card-title"><h3>Purpose & scope</h3></div>
            <p class="purpose">{{ c.purpose }}</p>
            <dl class="kv">
              <dt>Scope</dt><dd>{{ c.scope || '—' }}</dd>
              <dt>Legal basis</dt><dd>{{ c.legal_basis || '—' }}</dd>
              <dt>Owner</dt><dd>{{ c.owner_name }}</dd>
              <dt>Retention until</dt><dd>{{ fmt(c.retention_until, false) }}</dd>
              <dt>Created</dt><dd>{{ fmt(c.created_at) }}</dd>
            </dl>
            @if (ctx.canEdit()) {
              <div class="manage">
                <label class="field">Case status
                  <select [ngModel]="c.status" (ngModelChange)="setStatus($event)"><option>OPEN</option><option>ON_HOLD</option><option>CLOSED</option></select></label>
                <label class="field">Share with analyst
                  <div class="share">
                    <input placeholder="Username" [(ngModel)]="member" />
                    <select [(ngModel)]="memberAccess"><option>READ</option><option>EDIT</option></select>
                    <button (click)="addMember()" [disabled]="!member">Share</button>
                  </div>
                </label>
              </div>
            }
          </div>
        </div>

        <div class="cols bottom">
          <div class="card">
            <div class="card-title"><h3>Entities by type</h3><span class="muted small">{{ c.stats.entities }} total</span></div>
            @for (t of c.byType; track t.type) {
              <div class="bt">
                <ent-icon [type]="t.type" [size]="18" />
                <span class="grow">{{ label[t.type] ?? t.type }}</span>
                <span class="bar"><i [style.width.%]="(t.count / maxType(c.byType)) * 100" [style.background]="color(t.type)"></i></span>
                <b>{{ t.count }}</b>
              </div>
            } @empty { <div class="empty">No entities yet.</div> }
          </div>

          <div class="card flush jobs">
            <div class="card-h"><h3 class="grow" style="margin:0">Collection jobs</h3><span class="small muted">{{ jobSummary() }}</span></div>
            <div class="scroll" style="max-height:420px">
              <table class="t">
                <thead><tr><th>Status</th><th>Transform</th><th>Result</th><th>Created</th></tr></thead>
                <tbody>
                  @for (j of ctx.jobs(); track j.id) {
                    <tr>
                      <td class="nowrap"><span class="badge {{ j.status }}">{{ j.status }}</span>@if (j.attempts > 1) { <span class="tiny faint"> ×{{ j.attempts }}</span> }</td>
                      <td>
                        <div class="row nowrap"><span class="badge tier">{{ j.tier }}</span><span class="ellipsis">{{ j.source_name }}</span></div>
                        <div class="tiny faint ellipsis in">{{ j.input_type }} · {{ j.input_type === 'PHONE' || j.input_type === 'EMAIL' ? '•••' : j.input_value }}</div>
                      </td>
                      <td class="small">
                        @if (j.result_summary; as r) { {{ r.observations }} obs · {{ r.entities }} ent · {{ r.relationships }} rel · {{ r.mentions }} mentions
                          @if (r.notes?.length) { <div class="faint tiny">{{ r.notes[0] }}</div> } }
                        @if (j.error) { <div class="tiny" style="color:#fca5a5">{{ j.error }}</div> }
                      </td>
                      <td class="small nowrap muted">{{ fmt(j.created_at) }}</td>
                    </tr>
                  } @empty { <tr><td colspan="4" class="empty">No collection jobs yet.</td></tr> }
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    .dash { display: flex; flex-direction: column; gap: 16px; padding-top: 24px; }
    .stats { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
    .tile { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); min-width: 0; }
    .tile-h { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--muted); min-width: 0; }
    .tile > b { font-size: 26px; font-weight: 600; letter-spacing: -.02em; line-height: 1; font-variant-numeric: tabular-nums; }
    .ti { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; flex: none; background: color-mix(in srgb, currentColor 15%, transparent); }
    .cols { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(340px, 1fr); gap: 16px; align-items: start; }
    .bottom { grid-template-columns: minmax(300px, 1fr) minmax(0, 2.2fr); align-items: start; }
    .seeds { display: flex; flex-direction: column; }
    .card-title { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; min-height: 28px; }
    .card-title h3 { margin: 0; display: flex; align-items: center; gap: 8px; }
    .count { font-size: 11.5px; font-weight: 600; color: var(--muted); background: var(--panel-3); border-radius: 999px; padding: 1px 8px; }
    .seed-form { display: grid; grid-template-columns: 180px minmax(0, 1fr) auto; gap: 8px; }
    .seed-form.sec { margin-top: 8px; }
    .seed-actions { margin: 6px 0 10px -8px; min-width: 0; }
    .q { margin-left: 6px; }
    .list { display: flex; flex-direction: column; margin: 0 -8px; padding-top: 8px; border-top: 1px solid var(--border); }
    .li { display: flex; align-items: center; gap: 12px; padding: 10px 8px; border-radius: 8px; color: var(--text); }
    .li:hover { background: var(--panel-2); color: var(--text); }
    .li ui-icon { color: var(--faint); }
    .hint { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--faint); }
    .purpose { color: var(--text); margin-bottom: 16px; }
    .manage { display: grid; gap: 12px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
    .share { display: grid; grid-template-columns: minmax(0, 1fr) 96px auto; gap: 8px; }
    .bt { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 13px; }
    .bt .bar { width: 90px; flex: none; }
    .bt b { width: 28px; text-align: right; font-variant-numeric: tabular-nums; }
    .jobs { min-width: 0; }
    .jobs td { max-width: 320px; }
    .jobs .in { margin-top: 4px; }
    @media (max-width: 1280px) { .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-width: 1000px) { .cols, .bottom { grid-template-columns: 1fr; } .seed-form { grid-template-columns: 1fr; } }
    @media (max-width: 600px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `,
})

export class CaseDashboard {
  ctx = inject(CaseContext);
  private api = inject(Api);
  private toast = inject(Toast);
  fmt = fmtDate;
  label = TYPE_LABEL;
  seedTypes = ENTITY_TYPES.filter((t) => !['NARRATIVE', 'ARTICLE', 'DOCUMENT'].includes(t));
  seed = { type: '', value: '' };
  secondary: { type: string; value: string }[] = [];
  depth2 = false;
  member = '';
  memberAccess = 'READ';
  busy = signal(false);
  detected = signal<any | null>(null);
  runResult = signal<any | null>(null);
  jobSummary = computed(() => {
    const by: Record<string, number> = {};
    for (const j of this.ctx.jobs()) by[j.status] = (by[j.status] ?? 0) + 1;
    return Object.entries(by).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ');
  });

  color = colorOf;

  statTiles(st: any) {
    return [
      { label: 'Entities', value: st.entities, icon: 'layers', color: '#6ea8ff' },
      { label: 'Relationships', value: st.relationships, icon: 'graph', color: '#22d3ee' },
      { label: 'Evidence objects', value: st.evidence, icon: 'evidence', color: '#a78bfa' },
      { label: 'Findings', value: st.findings, icon: 'finding', color: '#4ade80' },
      { label: 'Pending resolution', value: st.pending_resolution, icon: 'merge', color: '#fbbf24' },
      { label: 'Narrative clusters', value: st.narratives, icon: 'narrative', color: '#f472b6' },
    ];
  }

  maxType(rows: { count: number }[]) {
    return Math.max(1, ...rows.map((r) => r.count));
  }

  addSecondary() {
    this.secondary.push({ type: 'PHONE', value: '' });
  }

  async addSeed() {
    this.busy.set(true);
    try {
      const cls = await this.api.post<any>('/identity/classify', { value: this.seed.value, type: this.seed.type || undefined });
      this.detected.set(cls);
      await this.api.post(`/cases/${this.ctx.caseId()}/seeds`, {
        type: cls.type,
        value: this.seed.value,
        secondary_identifiers: this.secondary.filter((s) => s.value.trim()),
      });
      this.toast.show(`Seed added as ${cls.type}`);
      this.seed = { type: '', value: '' };
      this.secondary = [];
      this.ctx.bump();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  async run() {
    this.busy.set(true);
    try {
      const key = crypto.randomUUID();
      const r = await this.api.post(`/investigations/${this.ctx.caseId()}/run`, { depth: this.depth2 ? 2 : 1 }, { 'Idempotency-Key': key });
      this.runResult.set(r);
      await this.ctx.pollJobs();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  async setStatus(status: string) {
    try {
      await this.api.patch(`/cases/${this.ctx.caseId()}`, { status });
      await this.ctx.reload();
    } catch (e) {
      this.toast.error(e);
    }
  }

  async addMember() {
    try {
      await this.api.post(`/cases/${this.ctx.caseId()}/members`, { username: this.member, access: this.memberAccess });
      this.toast.show(`Shared with ${this.member}`);
      this.member = '';
    } catch (e) {
      this.toast.error(e);
    }
  }
}
