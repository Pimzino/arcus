// Watch folders as the UI knows them: the rules with their live state, and whether all of them are
// paused. The backend (src-tauri watch/) owns the rules and runs them, also while the window is closed;
// this store loads the list once and then follows `watch:status`, `watch:paused` and `watch:removed`.
// Their transfers are followed by the jobs store (`watch:job`), which is what the Transfers page lists.

import { create } from "zustand";
import { api, listen } from "../lib/tauri";
import { errorMessage, type WatchList, type WatchRule, type WatchRun, type WatchStatus } from "../lib/types";

type WatchStore = {
  loaded: boolean;
  /** Why the list could not be loaded; the page shows it instead of the table. */
  error: string | null;
  paused: boolean;
  watches: WatchStatus[];
  load: () => Promise<void>;
  /** Create (empty id) or replace a rule; rejects with the backend's validation message. */
  save: (rule: WatchRule) => Promise<WatchRule>;
  remove: (id: string) => Promise<void>;
  runNow: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
  setEnabled: (rule: WatchRule, enabled: boolean) => Promise<WatchRule>;
  history: (id: string) => Promise<WatchRun[]>;
};

/** The listeners, registered once; awaited before the first read so no change falls between the two. */
let listening: Promise<unknown> | null = null;

/**
 * Events are numbered as they arrive, and each rule (and the pause) remembers the number of the last
 * event about it. The backend sends a rule's status only when it changes, so a list read that was
 * answered before a newer event but arrived after it must not replace that event's news: the newer
 * status would not be sent again until the rule changes once more.
 */
let eventSeq = 0;
const ruleSeq = new Map<string, number>();
let pausedSeq = 0;
/** Rules deleted in this window. A status computed just before the delete can still be on its way. */
const removed = new Set<string>();

export const useWatchStore = create<WatchStore>((set, get) => {
  /** One rule's status replaces the one with its id, or is added after the others (a new rule). */
  const upsert = (status: WatchStatus) => {
    if (removed.has(status.rule.id)) return;
    ruleSeq.set(status.rule.id, ++eventSeq);
    set((s) => {
      const i = s.watches.findIndex((w) => w.rule.id === status.rule.id);
      if (i < 0) return { watches: [...s.watches, status] };
      const watches = s.watches.slice();
      watches[i] = status;
      return { watches };
    });
  };

  const forget = (id: string) => {
    removed.add(id);
    ruleSeq.set(id, ++eventSeq);
    set((s) => ({ watches: s.watches.filter((w) => w.rule.id !== id) }));
  };

  const onPaused = (paused: boolean) => {
    pausedSeq = ++eventSeq;
    set({ paused });
  };

  /**
   * Read the whole list again, as a safety net after every action: a command's answer and its events
   * can arrive in either order. What an event reported after the read was asked for is newer than the
   * read and is kept (see `eventSeq`).
   */
  const refresh = async () => {
    const asked = eventSeq;
    try {
      const list: WatchList = await api.watchList();
      const newer = (id: string) => (ruleSeq.get(id) ?? 0) > asked;
      set((s) => {
        const current = new Map(s.watches.map((w) => [w.rule.id, w]));
        const listed = new Set(list.watches.map((w) => w.rule.id));
        const watches = list.watches
          .filter((w) => !removed.has(w.rule.id))
          .map((w) => (newer(w.rule.id) ? (current.get(w.rule.id) ?? w) : w));
        // A rule the read did not know yet, reported since (a save racing the read), stays.
        for (const w of s.watches) if (!listed.has(w.rule.id) && newer(w.rule.id)) watches.push(w);
        return { paused: pausedSeq > asked ? s.paused : list.paused, watches, loaded: true, error: null };
      });
    } catch (e) {
      set({ loaded: true, error: errorMessage(e) });
    }
  };

  return {
    loaded: false,
    error: null,
    paused: false,
    watches: [],

    async load() {
      // Listen before the first read, so a change between the two is not lost.
      listening ??= Promise.all([
        listen<WatchStatus>("watch:status", upsert),
        listen<{ paused: boolean }>("watch:paused", ({ paused }) => onPaused(paused)),
        listen<{ id: string }>("watch:removed", ({ id }) => forget(id)),
      ]).catch((e) => console.error("could not follow the watch folders' changes", e));
      await listening;
      await refresh();
    },

    async save(rule) {
      const saved = await api.watchSave(rule);
      await refresh();
      return saved;
    },

    async remove(id) {
      await api.watchDelete(id);
      forget(id);
      await refresh();
    },

    async runNow(id) {
      await api.watchRunNow(id);
      await refresh();
    },

    async stop(id) {
      await api.watchStop(id);
      await refresh();
    },

    async setPaused(paused) {
      await api.watchSetPaused(paused);
      onPaused(paused);
      await refresh();
    },

    setEnabled(rule, enabled) {
      return get().save({ ...rule, enabled });
    },

    history(id) {
      return api.watchHistory(id);
    },
  };
});

/** Rules whose folder cannot be watched (missing, no permission): the sidebar's badge. */
export const selectWatchErrorCount = (s: { watches: WatchStatus[] }) => s.watches.filter((w) => w.state === "error").length;
