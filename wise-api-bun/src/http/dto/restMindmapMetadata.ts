import type { MindmapWithPeople } from "../../domain/types.ts";
import type { Role } from "../../domain/roles.ts";
import { toIso8601 } from "../../util/iso8601.ts";

/**
 * `rest/model/RestMindmapMetadata.java`.
 *
 * Second serialisation trap, same shape as RestMindmap's: the class sets
 * `isGetterVisibility = NONE`, so of its three is-getters only `isPublic()`
 * survives -- because it alone carries `@JsonProperty("public")`. `isLocked()`
 * and `isStarred()` are therefore NOT in the response.
 *
 * That means a client determines lock state from `isLockedBy` being non-null,
 * not from a boolean. `getIsLockedBy()` keeps its `is` prefix because Jackson
 * only strips `is` from boolean is-getters, and this one returns a String.
 */
export interface RestMindmapMetadata {
  title: string;
  description: string;
  jsonProps: string;
  /** The OTHER holder's full name, or null. Never set for your own lock. */
  isLockedBy: string | null;
  creatorFullName: string;
  createdBy: string;
  role: Role | null;
  creationTime: string;
  lastModificationBy: string;
  lastModificationTime: string;
  public: boolean;
  xml?: string;
}

export interface MetadataInput {
  map: MindmapWithPeople;
  properties: string;
  role: Role | null;
  /**
   * Set only when someone ELSE holds the lock. `MindmapController
   * .retrieveMetadata` computes `isLocked && !isLockedBy(user)`, so the holder
   * sees their own map as unlocked.
   */
  lockedByFullName: string | null;
  xml?: string;
}

export function toRestMindmapMetadata(
  input: MetadataInput,
): RestMindmapMetadata {
  const { map } = input;
  const creatorFullName =
    `${map.creatorFirstname} ${map.creatorLastname}`.trim();

  const result: RestMindmapMetadata = {
    title: map.title,
    description: map.description ?? "",
    jsonProps: input.properties,
    isLockedBy: input.lockedByFullName,
    creatorFullName,
    createdBy: map.creatorEmail,
    role: input.role,
    creationTime: toIso8601(map.createdAt),
    lastModificationBy: map.lastEditorEmail,
    lastModificationTime: toIso8601(map.editedAt),
    public: map.isPublic,
  };

  // Only present when ?xml=true, as in the Java handler.
  if (input.xml !== undefined) result.xml = input.xml;

  return result;
}
