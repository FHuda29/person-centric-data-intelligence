import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, AuthStore } from '../core/api';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="wrap">
      <form class="box" (ngSubmit)="submit()">
        <span class="logo">
          <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M8 9 24 8M8 9l12 15M24 8l-4 16M7 23l13 1M8 9 7 23" stroke="rgba(255,255,255,.55)" stroke-width="1.6" fill="none" />
            <circle cx="8" cy="9" r="4" fill="#fff" /><circle cx="24" cy="8" r="3.2" fill="#bfe0ff" />
            <circle cx="20" cy="24" r="4.4" fill="#fff" /><circle cx="7" cy="23" r="2.8" fill="#bfe0ff" />
          </svg>
        </span>
        <div>
          <h1>Sign in to PCDI</h1>
          <p class="muted">Person-Centric Data Intelligence · case-based, evidence-first, audited</p>
        </div>
        <label class="field">Username<input name="u" [(ngModel)]="username" autocomplete="username" required /></label>
        <label class="field">Password<input name="p" type="password" [(ngModel)]="password" autocomplete="current-password" required /></label>
        @if (mfa()) {
          <label class="field">Authenticator code<input name="otp" [(ngModel)]="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" /></label>
        }
        @if (error()) { <div class="notice err">{{ error() }}</div> }
        <button class="primary go" type="submit" [disabled]="busy()">{{ busy() ? 'Signing in…' : 'Sign in' }}</button>
        <p class="legal">
          Access is restricted to authorised analysts. All searches, reveals, exports and reviews are recorded in an immutable audit trail.
          Use only for a documented, lawful purpose.
        </p>
      </form>
    </div>
  `,
  styles: `
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 16px; position: relative; overflow: hidden;
      background: radial-gradient(900px 520px at 50% -10%, rgba(76,141,255,.16), transparent 70%), var(--bg); }
    .wrap::before { content: ''; position: absolute; inset: 0; pointer-events: none;
      background-image: radial-gradient(rgba(148,163,184,.08) 1px, transparent 1px); background-size: 24px 24px;
      mask-image: radial-gradient(600px 420px at 50% 40%, #000, transparent); }
    .box { position: relative; width: min(420px, 100%); display: flex; flex-direction: column; gap: 16px; padding: 32px;
      background: rgba(18,23,31,.88); border: 1px solid var(--border-2); border-radius: 18px; box-shadow: var(--shadow-lg); backdrop-filter: blur(10px); }
    .logo { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px;
      background: linear-gradient(140deg, #5b9bff, #3a5fe0 60%, #6d4ce0); box-shadow: 0 8px 24px -8px rgba(76,141,255,.7), 0 0 0 1px rgba(255,255,255,.12) inset; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    p { margin: 0; font-size: 13px; }
    .go { height: 40px; margin-top: 4px; font-size: 14px; }
    input { height: 40px; }
    .legal { font-size: 11.5px; color: var(--faint); line-height: 1.55; padding-top: 14px; border-top: 1px solid var(--border); }
  `,
})
export class LoginPage {
  private api = inject(Api);
  private auth = inject(AuthStore);
  private router = inject(Router);
  username = '';
  password = '';
  otp = '';
  mfa = signal(false);
  busy = signal(false);
  error = signal('');

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.api.post<any>('/auth/login', { username: this.username, password: this.password, otp: this.otp || undefined });
      if (r.mfaRequired) {
        this.mfa.set(true);
        return;
      }
      this.auth.set(r.token, r.user);
      void this.router.navigate(['/']);
    } catch (e: any) {
      this.error.set(e?.error?.message ?? 'Sign-in failed');
    } finally {
      this.busy.set(false);
    }
  }
}
