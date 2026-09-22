import type { MigrationPlan, PlanStep } from '../../core/plan.js';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export type InkState = {
  plan: MigrationPlan | null;
  backupId: string | null;
  steps: { step: PlanStep; status: StepStatus; detail?: string }[];
  notes: string[];
  warnings: string[];
  question: string | null;
  outcome:
    | { kind: 'ok'; durationMs: number }
    | { kind: 'failed'; message: string; rolledBack: boolean }
    | null;
};

export type Store = {
  state: InkState;
  subscribe: (listener: () => void) => () => void;
  set: (patch: Partial<InkState> | ((prev: InkState) => Partial<InkState>)) => void;
  answer: ((value: boolean) => void) | null;
};

export function createStore(): Store {
  const listeners = new Set<() => void>();

  const store: Store = {
    state: {
      plan: null,
      backupId: null,
      steps: [],
      notes: [],
      warnings: [],
      question: null,
      outcome: null,
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(patch) {
      const next = typeof patch === 'function' ? patch(store.state) : patch;
      store.state = { ...store.state, ...next };
      for (const listener of listeners) listener();
    },
    answer: null,
  };

  return store;
}
