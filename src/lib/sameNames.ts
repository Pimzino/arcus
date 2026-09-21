// Some backends (Google Drive, for one) let a folder hold several items with the same name. rclone
// finds items by path, so it cannot tell those apart; the explorer still has to.

import type { ListItem } from "./types";

/** A listing entry with a key that no other entry of the same listing has. */
export type KeyedItem = ListItem & { key: string };

/**
 * Key each entry of a folder listing by its path, plus the backend's ID where it has one, so that
 * same-named entries keep their keys when the folder is listed again; entries that would still share
 * a key are numbered in listing order.
 */
export function withKeys(items: ListItem[]): KeyedItem[] {
  const used = new Set<string>();
  return items.map((item) => {
    const base = item.ID ? `${item.Path}\0${item.ID}` : item.Path;
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}\0${n}`;
    used.add(key);
    return { ...item, key };
  });
}

/**
 * The ID that Google Drive's `copyid` and `moveid` backend commands can find `item` by. They refuse
 * folders, and a shortcut is listed under a composite ID (the target's, a tab, then the shortcut's)
 * that Drive can't look up.
 */
export function driveFileId(item: ListItem): string | null {
  return !item.IsDir && item.ID && !item.ID.includes("\t") ? item.ID : null;
}

/** The names that more than one entry of a listing has, with how many entries have each. */
export function sharedNames(items: ListItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.Name, (counts.get(item.Name) ?? 0) + 1);
  for (const [name, count] of counts) if (count < 2) counts.delete(name);
  return counts;
}
