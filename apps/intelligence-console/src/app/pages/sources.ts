import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AuthStore, Toast } from '../core/api';
import { TYPE_LABEL } from '../core/entity-style';
import { EntIcon } from '../shared/ui';

const TIER: Record<string, string> = { A: 'Official API', B: 'Licensed provider', C: 'Search index', D: 'Public web', E: 'Internal authorized' };

@Component({
  selector: 'app-sources',
  imports: [FormsModule, EntIcon],
  template: `
    <div class="page">
      <h1>Transform Hub · Source Registry</h1>
      <div class="small muted mb">Each source is registered with owner, access method, legal/access basis, rate limit, allowed fields and retention.
        The collector only executes sources that are <b>APPROVED</b> and <b>READY</b>. Priority: official API → licensed provider → search index → permitted public web.</div>
      <div class="row mb wrap">
        @for (t of tiers; track t) { <button class="sm" [class.primary]="tier() === t" (click)="tier.set(tier() === t ? '' : t)">Tier {{ t }} · {{ tierName[t] }}</button> }
      </div>
      <div class="grid grid-2">
        @for (s of shown(); track s.id) {
          <div class="card">
            <div class="row">
              <span class="badge tier">{{ s.tier }}</span><b class="grow">{{ s.name }}</b>
              <span class="badge {{ s.policy_state }}">{{ s.policy_state }}</span>
              <span class="badge {{ s.connector_status }}">{{ s.connector_status }}</span>
            </div>
            <div class="small muted mt">{{ s.description }}</div>
            <dl class="kv mt">
              <dt>Connector</dt><dd class="mono">{{ s.connector_key }}</dd>
              <dt>Owner</dt><dd>{{ s.owner }} · {{ s.category }}</dd>
              <dt>Access method</dt><dd>{{ s.access_method }} @if (s.base_url) { · <span class="mono tiny">{{ s.base_url }}</span> }</dd>
              <dt>Legal / access basis</dt><dd>{{ s.legal_basis }}</dd>
              <dt>Allowed fields</dt><dd>{{ s.allowed_fields.join(', ') }}</dd>
              <dt>Rate limit</dt><dd>{{ s.rate_limit_per_min }}/min · auth {{ s.auth_mode }} · retention {{ s.retention_days }} d</dd>
              <dt>Run mode</dt><dd>{{ s.auto_run ? 'auto (investigation run)' : 'analyst-initiated only' }}</dd>
            </dl>
            @if (s.input_types.length) {
              <div class="row mt small wrap"><span class="muted">In</span>@for (t of s.input_types; track t) { <ent-icon [type]="t" [size]="16" /> }
                <span class="muted" style="margin-left:8px">Out</span>@for (t of s.output_types; track t) { <ent-icon [type]="t" [size]="16" /> }</div>
            }
            @if (auth.user()?.role === 'ADMIN') {
              <div class="row mt">
                <select [ngModel]="s.policy_state" (ngModelChange)="update(s, { policy_state: $event })"><option>APPROVED</option><option>PENDING</option><option>DISABLED</option></select>
                <input type="number" min="1" style="width:90px" [ngModel]="s.rate_limit_per_min" (change)="update(s, { rate_limit_per_min: +$any($event.target).value })" /> <span class="small muted">/min</span>
              </div>
            }
          </div>
        }
      </div>
    </div>
  `,
})
export class SourcesPage implements OnInit {
  private api = inject(Api);
  private toast = inject(Toast);
  auth = inject(AuthStore);
  label = TYPE_LABEL;
  tierName = TIER;
  tiers = Object.keys(TIER);
  items = signal<any[]>([]);
  tier = signal('');
  shown = computed(() => this.items().filter((s) => !this.tier() || s.tier === this.tier()));

  ngOnInit() {
    void this.load();
  }

  async load() {
    try {
      this.items.set(await this.api.get('/sources'));
    } catch (e) {
      this.toast.error(e);
    }
  }

  async update(s: any, patch: any) {
    try {
      await this.api.patch(`/sources/${s.id}`, patch);
      this.toast.show(`${s.name} updated`);
      await this.load();
    } catch (e) {
      this.toast.error(e);
    }
  }
}
