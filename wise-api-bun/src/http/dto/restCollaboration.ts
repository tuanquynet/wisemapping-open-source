import type { CollaborationWithEmail } from "../../db/repos/collaborations.ts";
import type { HistoryEntry } from "../../db/repos/history.ts";
import type { Role } from "../../domain/roles.ts";
import { toIso8601 } from "../../util/iso8601.ts";

/** `rest/model/RestCollaboration.java` */
export interface RestCollaboration {
  id: number;
  role: Role;
  email: string;
}

export function toRestCollaboration(
  collab: CollaborationWithEmail,
): RestCollaboration {
  return { id: collab.id, role: collab.role, email: collab.email };
}

/**
 * `rest/model/RestCollaborationList.java`.
 *
 * `message` is an inbound field (the optional note included in a share
 * invitation). It has a public getter and no `@JsonInclude`, so it appears as
 * null on reads.
 */
export interface RestCollaborationList {
  count: number;
  collaborations: RestCollaboration[];
  message: string | null;
}

export function toRestCollaborationList(
  collabs: readonly CollaborationWithEmail[],
): RestCollaborationList {
  const collaborations = collabs.map(toRestCollaboration);
  return { count: collaborations.length, collaborations, message: null };
}

/** `rest/model/RestMindmapHistory.java` -- isGetterVisibility NONE, three getters. */
export interface RestMindmapHistory {
  id: number;
  creator: string;
  creationTime: string;
}

export function toRestMindmapHistory(entry: HistoryEntry): RestMindmapHistory {
  return {
    id: entry.id,
    creator: entry.editorEmail,
    creationTime: toIso8601(entry.createdAt),
  };
}

/** `rest/model/RestMindmapHistoryList.java` -- the list key is `changes`. */
export interface RestMindmapHistoryList {
  count: number;
  changes: RestMindmapHistory[];
}

/**
 * `rest/model/RestLockInfo.java`.
 *
 * Only `email`. The Java constructor takes a `LockInfo` and then ignores it
 * entirely, reading the email off the *requesting* user -- so the response tells
 * you who holds the lock only because you have just taken it.
 */
export interface RestLockInfo {
  email: string;
}
