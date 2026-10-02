import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AuthStore, fmtDate, Toast } from '../core/api';

@Component({
  selector: 'app-admin',
  imports: [FormsModule],
  template: `
    <div class="page" style="max-width:1100px">
      <div class="grid grid-2">
        <div class="card">
          <h2>My account</h2>
          <dl class="kv"><dt>User</dt><dd>{{ me()?.username }} ({{ me()?.displayName }})</dd><dt>Role</dt><dd>{{ me()?.role }}</dd>
            <dt>PII reveal</dt><dd>{{ me()?.canRevealPii ? 'permitted (audited)' : 'not permitted' }}</dd><dt>MFA</dt><dd>{{ me()?.mfaEnabled ? 'enabled' : 'not enabled' }}</dd></dl>
          @if (!me()?.mfaEnabled) {
            <h4 class="mt2">Enable MFA (TOTP)</h4>
            @if (!mfa()) { <button class="sm" (click)="setupMfa()">Generate secret</button> }
            @else {
              <div class="small">Add this secret to an authenticator app (Google Authenticator, Authy, 1Password…):</div>
              <code class="break" style="display:block;margin:6px 0">{{ mfa().secret }}</code>
              <div class="tiny faint break">{{ mfa().otpauthUrl }}</div>
              <div class="row mt"><input [(ngModel)]="otp" placeholder="6-digit code" maxlength="6" style="width:120px" /><button class="sm primary" (click)="enableMfa()">Verify & enable</button></div>
            }
          }
          <h4 class="mt2">Change password</h4>
          <div class="row wrap"><input type="password" [(ngModel)]="pw.current" placeholder="Current" /><input type="password" [(ngModel)]="pw.next" placeholder="New (≥10, Aa1)" />
            <button class="sm" (click)="changePw()">Change</button></div>
        </div>
        @if (isAdmin()) {
          <div class="card">
            <h2>Create user</h2>
            <div class="col">
              <div class="row"><input class="grow" [(ngModel)]="nu.username" placeholder="username" /><input class="grow" [(ngModel)]="nu.displayName" placeholder="Display name" /></div>
              <div class="row"><input class="grow" type="password" [(ngModel)]="nu.password" placeholder="Password (≥10, Aa1)" />
                <select [(ngModel)]="nu.role"><option>ANALYST</option><option>VIEWER</option><option>ADMIN</option></select></div>
              <label class="check"><input type="checkbox" [(ngModel)]="nu.canRevealPii" /> may reveal masked PII (audited)</label>
              <button class="primary sm" (click)="createUser()">Create</button>
            </div>
          </div>
        }
      </div>

      @if (isAdmin()) {
        <div class="card flush mt">
          <div class="card-h"><h4 style="margin:0">Users</h4></div>
          <table class="t"><thead><tr><th>User</th><th>Role</th><th>PII reveal</th><th>MFA</th><th>Active</th><th>Created</th></tr></thead><tbody>
            @for (u of users(); track u.id) {
              <tr><td>{{ u.username }} <span class="muted small">{{ u.display_name }}</span></td>
                <td><select [ngModel]="u.role" (ngModelChange)="patch(u, { role: $event })"><option>ADMIN</option><option>ANALYST</option><option>VIEWER</option></select></td>
                <td><input type="checkbox" [ngModel]="u.can_reveal_pii" (ngModelChange)="patch(u, { canRevealPii: $event })" /></td>
                <td>{{ u.mfa_enabled ? 'yes' : '—' }}</td>
                <td><input type="checkbox" [ngModel]="u.active" (ngModelChange)="patch(u, { active: $event })" /></td>
                <td class="small">{{ fmt(u.created_at, false) }}</td></tr>
            }
          </tbody></table>
        </div>
        <div class="card flush mt">
          <div class="card-h"><h4 class="grow" style="margin:0">Platform audit trail</h4><input [(ngModel)]="action" placeholder="action filter" (keyup.enter)="loadAudit()" /></div>
          <div class="scroll" style="max-height:480px"><table class="t"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Object</th><th>Detail</th></tr></thead><tbody>
            @for (a of audit(); track a.id) {
              <tr><td class="small nowrap">{{ fmt(a.timestamp) }}</td><td class="small">{{ a.actor_name }}</td><td><code>{{ a.action }}</code></td>
                <td class="small">{{ a.object_type }}</td><td class="tiny muted break">{{ json(a.detail) }}</td></tr>
            }
          </tbody></table></div>
        </div>
      }
    </div>
  `,
})
export class AdminPage implements OnInit {
  private api = inject(Api);
  private toast = inject(Toast);
  private auth = inject(AuthStore);
  fmt = fmtDate;
  me = signal<any>(null);
  users = signal<any[]>([]);
  audit = signal<any[]>([]);
  mfa = signal<any>(null);
  otp = '';
  action = '';
  pw = { current: '', next: '' };
  nu = { username: '', displayName: '', password: '', role: 'ANALYST', canRevealPii: false };
  isAdmin = () => this.auth.user()?.role === 'ADMIN';
  json = (d: any) => (d && Object.keys(d).length ? JSON.stringify(d).slice(0, 240) : '');

  ngOnInit() {
    void this.api.get('/auth/me').then((m) => this.me.set(m), (e) => this.toast.error(e));
    if (this.isAdmin()) {
      void this.loadUsers();
      void this.loadAudit();
    }
  }

  async loadUsers() {
    this.users.set(await this.api.get('/users'));
  }
  async loadAudit() {
    try {
      this.audit.set(await this.api.get('/audit', { action: this.action, limit: 300 }));
    } catch (e) {
      this.toast.error(e);
    }
  }
  async setupMfa() {
    try {
      this.mfa.set(await this.api.post('/auth/mfa/setup'));
    } catch (e) {
      this.toast.error(e);
    }
  }
  async enableMfa() {
    try {
      await this.api.post('/auth/mfa/enable', { otp: this.otp });
      this.toast.show('MFA enabled — required at next sign-in');
      this.mfa.set(null);
      this.me.set(await this.api.get('/auth/me'));
    } catch (e) {
      this.toast.error(e);
    }
  }
  async changePw() {
    try {
      await this.api.post('/auth/password', this.pw);
      this.pw = { current: '', next: '' };
      this.toast.show('Password changed');
    } catch (e) {
      this.toast.error(e);
    }
  }
  async createUser() {
    try {
      await this.api.post('/users', this.nu);
      this.nu = { username: '', displayName: '', password: '', role: 'ANALYST', canRevealPii: false };
      this.toast.show('User created');
      await this.loadUsers();
    } catch (e) {
      this.toast.error(e);
    }
  }
  async patch(u: any, body: any) {
    try {
      await this.api.patch(`/users/${u.id}`, body);
      await this.loadUsers();
    } catch (e) {
      this.toast.error(e);
    }
  }
}
