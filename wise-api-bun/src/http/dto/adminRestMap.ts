import type { MindmapWithPeople } from "../../domain/types.ts";
import { toIso8601 } from "../../util/iso8601.ts";

/**
 * Mirrors `rest/model/AdminRestMap.java` and frontend `AdminMap`.
 */
export interface AdminRestMap {
  id: number;
  title: string;
  description: string;
  createdBy: string;
  createdById: number;
  creationTime: string;
  lastModificationBy: string;
  lastModificationById: number;
  lastModificationTime: string;
  public: boolean;
  isPublic: boolean;
  isLocked: boolean;
  starred: boolean;
  isSpam: boolean;
  isCreatorSuspended: boolean;
  collaboratorCount: number;
  labels: string[];
}

export function toAdminRestMap(
  map: MindmapWithPeople,
  collaboratorCount = 1,
): AdminRestMap {
  const creationTime = toIso8601(map.createdAt);
  const lastModificationTime = toIso8601(map.editedAt);

  return {
    id: map.id,
    title: map.title,
    description: map.description ?? "",
    createdBy: map.creatorEmail,
    createdById: map.creatorId,
    creationTime,
    lastModificationBy: map.lastEditorEmail,
    lastModificationById: map.lastEditorId,
    lastModificationTime,
    public: map.isPublic,
    isPublic: map.isPublic,
    isLocked: false,
    starred: false,
    isSpam: false,
    isCreatorSuspended: false,
    collaboratorCount,
    labels: [],
  };
}
