import { HttpClient, HttpErrorResponse, HttpInterceptorFn, HttpParams } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, firstValueFrom, throwError } from 'rxjs';

export const API = '/api/v1';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'ADMIN' | 'ANALYST' | 'VIEWER';
  canRevealPii: boolean;
  mfaEnabled?: boolean;
}

const TOKEN_KEY = 'pcdi.token';
const USER_KEY = 'pcdi.user';
const read = (k: string) => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};

@Injectable({ providedIn: 'root' })
export class AuthStore {
  readonly token = signal<string | null>(read(TOKEN_KEY));
  readonly user = signal<User | null>(JSON.parse(read(USER_KEY) ?? 'null'));

  set(token: string, user: User) {
    this.token.set(token);
    this.user.set(user);
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {
      /* storage unavailable */
    }
  }

  clear() {
    this.token.set(null);
    this.user.set(null);
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USER_KEY);
    } catch {
      /* ignore */
    }
  }

  canEdit() {
    return this.user()?.role !== 'VIEWER';
  }
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  const token = auth.token();
  const r = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
  return next(r).pipe(
    catchError((e: HttpErrorResponse) => {
      if (e.status === 401 && !req.url.endsWith('/auth/login')) {
        auth.clear();
        void router.navigate(['/login']);
      }
      return throwError(() => e);
    }),
  );
};

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthStore);
  return auth.token() ? true : inject(Router).createUrlTree(['/login']);
};

@Injectable({ providedIn: 'root' })
export class Toast {
  readonly items = signal<{ id: number; text: string; err: boolean }[]>([]);
  private n = 0;
  show(text: string, err = false) {
    const id = ++this.n;
    this.items.update((l) => [...l, { id, text, err }]);
    setTimeout(() => this.items.update((l) => l.filter((x) => x.id !== id)), err ? 7000 : 3500);
  }
  error(e: unknown) {
    const he = e as HttpErrorResponse;
    const msg = he?.error?.message ?? he?.message ?? String(e);
    this.show(Array.isArray(msg) ? msg.join(', ') : msg, true);
  }
}

/** Thin promise-based API client. */
@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  get<T = any>(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): Promise<T> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p = p.set(k, String(v));
    return firstValueFrom(this.http.get<T>(`${API}${path}`, { params: p }));
  }
  post<T = any>(path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<T> {
    return firstValueFrom(this.http.post<T>(`${API}${path}`, body, { headers }));
  }
  patch<T = any>(path: string, body: unknown = {}): Promise<T> {
    return firstValueFrom(this.http.patch<T>(`${API}${path}`, body));
  }
  upload<T = any>(path: string, form: FormData): Promise<T> {
    return firstValueFrom(this.http.post<T>(`${API}${path}`, form));
  }
  /** Fetches a protected file with the bearer header and returns an object URL. */
  async blobUrl(path: string): Promise<{ url: string; type: string }> {
    const blob = await firstValueFrom(this.http.get(`${API}${path}`, { responseType: 'blob' }));
    return { url: URL.createObjectURL(blob), type: blob.type };
  }
  async text(path: string): Promise<string> {
    return firstValueFrom(this.http.get(`${API}${path}`, { responseType: 'text' }));
  }
}

export const fmtDate = (v: string | Date | null | undefined, withTime = true) => {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  return withTime ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : d.toISOString().slice(0, 10);
};
