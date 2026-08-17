import type { Label, MindmapWithPeople } from "../../domain/types.ts";
import type { ListedMindmap } from "../../db/repos/mindmaps.ts";
import type { Role } from "../../domain/roles.ts";
import { toIso8601 } from "../../util/iso8601.ts";

/**
 * `rest/model/RestMindmap.java` -- the single-map GET response.
 *
 * !!! The important trap in this file !!!
 * The Java class sets `isGetterVisibility = NONE` and then declares `isPublic()`
 * and `isSpamDetected()` as is-getters with no `@JsonProperty`. Jackson therefore
 * does NOT serialise them: `GET /maps/{id}` has no `public` key and no
 * `spamDetected` key. `getStarred()` is a plain getter, so `starred` IS present.
 *
 * Emitting `public` here would be a superset of the contract -- harmless to a
 * tolerant client, but it would mask the fact that the frontend must be reading
 * public state from `/metadata` or the list endpoint instead. Match the contract.
 */
export interface RestMindmap {
  id: number;
  title: string;
  description: string;
  creator: string;
  owner: string;
  creationTime: string;
  lastModificationTime: string;
  /** An object here, unlike the plain string in RestMindmapInfo. */
  lastModifierUser: { email: string; creationDate: string } | null;
  xml: string;
  properties: string;
  starred: boolean;
}

export function toRestMindmap(
  map: MindmapWithPeople,
  xml: string,
  properties: string,
  starred: boolean,
): RestMindmap {
  return {
    id: map.id,
    title: map.title,
    description: map.description ?? "",
    creator: map.creatorEmail,
    owner: map.creatorEmail,
    creationTime: toIso8601(map.createdAt),
    lastModificationTime: toIso8601(map.editedAt),
    lastModifierUser: {
      email: map.lastEditorEmail,
      creationDate: toIso8601(map.editedAt),
    },
    xml,
    properties,
    starred,
  };
}

/**
 * `rest/model/RestMindmapInfo.java` -- one entry in the list response.
 *
 * Also `isGetterVisibility = NONE`, but every boolean here is declared as a
 * plain getter (`getPublic`, `getSpamDetected`, `getStarred`) precisely so they
 * survive. So this DTO DOES carry `public` and `spamDetected`, where
 * `RestMindmap` carries neither. Note also `lastModifierUser` is a plain string
 * here and an object there.
 *
 * `spamDetected` is hardcoded false: the spam pipeline is out of scope, but the
 * key must exist because the frontend reads it.
 */
export interface RestMindmapInfo {
  id: number;
  title: string;
  description: string;
  creator: string;
  role: Role;
  creationTime: string;
  lastModificationTime: string;
  lastModifierUser: string;
  public: boolean;
  spamDetected: boolean;
  starred: boolean;
  labels: RestLabel[];
}

export function toRestMindmapInfo(
  map: ListedMindmap,
  labels: readonly Label[],
): RestMindmapInfo {
  return {
    id: map.id,
    title: map.title,
    description: map.description ?? "",
    creator: map.creatorEmail,
    role: map.myRole,
    creationTime: toIso8601(map.createdAt),
    lastModificationTime: toIso8601(map.editedAt),
    lastModifierUser: map.lastEditorEmail,
    public: map.isPublic,
    spamDetected: false,
    starred: map.myStarred,
    labels: labels.map(toRestLabel),
  };
}

/** `rest/model/RestMindmapList.java` */
export interface RestMindmapList {
  count: number;
  mindmapsInfo: RestMindmapInfo[];
}

/**
 * `rest/model/RestLabel.java`.
 *
 * `isGetterVisibility = NONE`, and the getters are `getParent`, `getTitle`,
 * `getId`, `getColor`. There is no `@JsonInclude` on the class, so a null parent
 * is serialised as `parent: null` rather than omitted. Label hierarchies are not
 * modelled here, so `parent` is always null -- but the key is present because
 * the Java response has it.
 */
export interface RestLabel {
  id: number;
  title: string;
  color: string;
  parent: null;
}

export function toRestLabel(label: Label): RestLabel {
  return { id: label.id, title: label.title, color: label.color, parent: null };
}

/** `rest/model/RestLabelList.java` -- note: no `count`, unlike the other lists. */
export interface RestLabelList {
  labels: RestLabel[];
}
