import type { ListedMindmap } from "../db/repos/mindmaps.ts";

/**
 * The `?q=` filter, porting `rest/MindmapFilter.java`.
 *
 * `?q=` is an overloaded namespace and that is not a bug to fix: five reserved
 * names are matched exactly, and ANY other value is treated as a label title. So
 * a user whose label is literally named "public" can never filter by it.
 *
 * `shared_with_me` is defined as `!my_maps`, which means it includes public maps
 * the caller does not own -- not just maps shared with them. Reproduced.
 */

const RESERVED = [
  "all",
  "my_maps",
  "public",
  "starred",
  "shared_with_me",
] as const;
type Reserved = (typeof RESERVED)[number];

export type Filter = { kind: Reserved } | { kind: "label"; title: string };

export function parseFilter(q: string | undefined): Filter {
  if (q === undefined) return { kind: "all" };
  if ((RESERVED as readonly string[]).includes(q))
    return { kind: q as Reserved };
  return { kind: "label", title: q };
}

export interface FilterContext {
  accountId: number;
  /** Label titles attached to each map, for the caller only. */
  labelTitlesByMapId: ReadonlyMap<number, readonly string[]>;
}

export function accepts(
  filter: Filter,
  map: ListedMindmap,
  ctx: FilterContext,
): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "my_maps":
      return map.creatorId === ctx.accountId;
    case "shared_with_me":
      // Literally the negation of my_maps, as in the Java source.
      return map.creatorId !== ctx.accountId;
    case "public":
      return map.isPublic;
    case "starred":
      return map.myStarred;
    case "label":
      return (ctx.labelTitlesByMapId.get(map.id) ?? []).includes(filter.title);
  }
}
