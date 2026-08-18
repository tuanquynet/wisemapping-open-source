import type { Account, MindmapWithPeople } from "../domain/types.ts";

/**
 * Typed Hono context variables.
 *
 * Declaring these centrally is what makes `c.get('user')` and `c.get('map')`
 * compile-checked, which is the property that lets `requireMapAccess` hand a
 * loaded map to its handler without a second SELECT or a cast.
 */
export interface Env {
  Variables: {
    /** Set by the jwt middleware on every request; null when unauthenticated. */
    user: Account | null;
    /** Set by requireMapAccess; absent on routes that do not use it. */
    map: MindmapWithPeople | null;
  };
}
