import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, AuthStore } from '../core/api';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="wrap">
      <section class="hero" aria-hidden="true">
        <div class="hero-in">
          <span class="logo">
            <svg width="24" height="24" viewBox="0 0 32 32">
              <path d="M8 9 24 8M8 9l12 15M24 8l-4 16M7 23l13 1M8 9 7 23" stroke="rgba(255,255,255,.55)" stroke-width="1.6" fill="none" />
              <circle cx="8" cy="9" r="4" fill="#fff" /><circle cx="24" cy="8" r="3.2" fill="#bfe0ff" />
              <circle cx="20" cy="24" r="4.4" fill="#fff" /><circle cx="7" cy="23" r="2.8" fill="#bfe0ff" />
            </svg>
          </span>
          <h2>Person-Centric<br /><span class="grad">Data Intelligence</span></h2>
          <p>Case-based OSINT graph platform — collect lawfully, resolve identities, and explain every finding with evidence.</p>
          <ul class="feats">
            <li><b>Graph explorer</b><span>Entities, relationships and centrality in one canvas</span></li>
            <li><b>Evidence-first</b><span>Every observation is hashed, sourced and reviewable</span></li>
            <li><b>Fully audited</b><span>Searches, reveals and exports land in an immutable trail</span></li>
          </ul>
        </div>
        <svg class="net" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">
          <g stroke="rgba(140,170,255,.18)" stroke-width="1" fill="none">
            <path d="M40 60 150 40 260 110 360 70M150 40 120 170 260 110 300 230M120 170 40 240 200 270 300 230M200 270 260 110" />
          </g>
          <g fill="rgba(140,170,255,.5)">
            <circle cx="40" cy="60" r="4" /><circle cx="150" cy="40" r="6" /><circle cx="260" cy="110" r="8" /><circle cx="360" cy="70" r="3" />
            <circle cx="120" cy="170" r="5" /><circle cx="300" cy="230" r="5" /><circle cx="40" cy="240" r="3" /><circle cx="200" cy="270" r="4" />
          </g>
        </svg>
      </section>

      <div class="side">
        <form class="box" (ngSubmit)="submit()">
          <span class="logo m">
            <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
              <path d="M8 9 24 8M8 9l12 15M24 8l-4 16M7 23l13 1M8 9 7 23" stroke="rgba(255,255,255,.55)" stroke-width="1.6" fill="none" />
              <circle cx="8" cy="9" r="4" fill="#fff" /><circle cx="24" cy="8" r="3.2" fill="#bfe0ff" />
              <circle cx="20" cy="24" r="4.4" fill="#fff" /><circle cx="7" cy="23" r="2.8" fill="#bfe0ff" />
            </svg>
          </span>
          <div>
            <h1>Welcome back</h1>
            <p class="muted">Sign in to the PCDI Intelligence Console</p>
          </div>
          <label class="field">Username<input name="u" [(ngModel)]="username" autocomplete="username" autocapitalize="none" required /></label>
          <label class="field">Password
            <span class="pw">
              <input name="p" [type]="showPw() ? 'text' : 'password'" [(ngModel)]="password" autocomplete="current-password" required />
              <button type="button" class="ghost sm" (click)="showPw.set(!showPw())" [attr.aria-label]="showPw() ? 'Hide password' : 'Show password'">{{ showPw() ? 'Hide' : 'Show' }}</button>
            </span>
          </label>
          @if (mfa()) {
            <label class="field">Authenticator code<input name="otp" [(ngModel)]="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" /></label>
          }
          @if (error()) { <div class="notice err">{{ error() }}</div> }
          <button class="primary go" type="submit" [disabled]="busy()">
            @if (busy()) { <span class="spin"></span> Signing in… } @else { Sign in }
          </button>
          <p class="legal">
            Access is restricted to authorised analysts. All searches, reveals, exports and reviews are recorded in an immutable audit trail.
            Use only for a documented, lawful purpose.
          </p>
        </form>
      </div>
    </div>
  `,
  styles: `
    .wrap { min-height: 100vh; min-height: 100dvh; display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(400px, 1fr); background: var(--bg); }
    .hero { position: relative; overflow: hidden; display: flex; align-items: center; padding: 56px;
      background: radial-gradient(700px 500px at 20% 10%, rgba(91,140,255,.22), transparent 65%),
        radial-gradient(600px 500px at 90% 100%, rgba(123,92,255,.18), transparent 60%), #080b14;
      border-right: 1px solid var(--border); }
    .hero-in { position: relative; z-index: 1; max-width: 480px; }
    .hero h2 { font-size: 40px; line-height: 1.1; letter-spacing: -.03em; margin: 28px 0 16px; }
    .grad { background: var(--accent-grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .hero p { color: var(--text-2); font-size: 15px; line-height: 1.6; margin-bottom: 28px; }
    .feats { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
    .feats li { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; border-radius: 14px;
      background: rgba(255,255,255,.03); border: 1px solid var(--border); backdrop-filter: blur(6px); }
    .feats b { font-size: 13.5px; } .feats span { font-size: 12.5px; color: var(--muted); }
    .net { position: absolute; inset: 0; width: 100%; height: 100%; opacity: .9; }
    .side { display: grid; place-items: center; padding: 32px 24px; }
    .box { width: min(400px, 100%); display: flex; flex-direction: column; gap: 16px; }
    .logo { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 14px;
      background: var(--accent-grad); box-shadow: 0 10px 28px -8px rgba(79,107,255,.75), 0 0 0 1px rgba(255,255,255,.14) inset; }
    .logo.m { display: none; }
    h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -.02em; }
    p { margin: 0; font-size: 13.5px; }
    .pw { position: relative; display: flex; }
    .pw input { flex: 1; padding-right: 64px; }
    .pw button { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); }
    .go { height: 44px; margin-top: 4px; font-size: 14.5px; border-radius: 12px; }
    .go .spin { border-color: rgba(255,255,255,.35); border-top-color: #fff; }
    input { height: 44px; border-radius: 12px; }
    .legal { font-size: 11.5px; color: var(--faint); line-height: 1.55; padding-top: 14px; border-top: 1px solid var(--border); }
    @media (max-width: 960px) {
      .wrap { grid-template-columns: 1fr;
        background: radial-gradient(700px 420px at 50% -10%, rgba(91,140,255,.2), transparent 70%), var(--bg); }
      .hero { display: none; }
      .logo.m { display: grid; }
      .box { padding: 28px 22px; border-radius: 20px; background: rgba(16,21,31,.85); border: 1px solid var(--border-2); box-shadow: var(--shadow-lg); backdrop-filter: blur(10px); }
    }
    @media (max-width: 480px) {
      .side { padding: 16px; place-items: start center; padding-top: max(10vh, 24px); }
      .box { background: transparent; border: 0; box-shadow: none; padding: 8px 4px; backdrop-filter: none; }
      input { font-size: 16px; }
    }
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
  showPw = signal(false);
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
