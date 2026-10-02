import { inject, Injectable, OnDestroy, signal } from '@angular/core';
import { Api, Toast } from '../../core/api';

/** Per-workspace state: the open case, its jobs, and a data version bumped whenever collection completes. */
@Injectable()
export class CaseContext implements OnDestroy {
  private api = inject(Api);
  private toast = inject(Toast);
  readonly caseId = signal<string>('');
  readonly data = signal<any | null>(null);
  readonly jobs = signal<any[]>([]);
  readonly activeJobs = signal(0);
  /** Incremented when new data lands (job completed, merge, seed…). Views re-load on change. */
  readonly version = signal(0);
  private timer?: ReturnType<typeof setTimeout>;
  private lastCompleted = -1;

  async open(id: string) {
    if (this.caseId() === id && this.data()) return;
    this.caseId.set(id);
    this.lastCompleted = -1;
    await this.reload();
    await this.pollJobs();
  }

  async reload() {
    try {
      this.data.set(await this.api.get(`/cases/${this.caseId()}`));
    } catch (e) {
      this.toast.error(e);
    }
  }

  bump() {
    this.version.update((v) => v + 1);
    void this.reload();
  }

  canEdit() {
    return this.data()?.access === 'EDIT';
  }

  /** Polls jobs while any are active; bumps the version when completions increase. */
  async pollJobs() {
    clearTimeout(this.timer);
    try {
      const jobs = await this.api.get<any[]>('/jobs', { caseId: this.caseId(), limit: 200 });
      this.jobs.set(jobs);
      const active = jobs.filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING').length;
      const done = jobs.filter((j) => ['COMPLETED', 'DEAD', 'SKIPPED'].includes(j.status)).length;
      if (this.lastCompleted >= 0 && done > this.lastCompleted) this.bump();
      this.lastCompleted = done;
      this.activeJobs.set(active);
      if (active > 0) this.timer = setTimeout(() => void this.pollJobs(), 2500);
    } catch {
      /* transient */
    }
  }

  ngOnDestroy() {
    clearTimeout(this.timer);
  }
}
