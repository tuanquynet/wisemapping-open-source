/**
 * Domain types for comments.
 *
 * Distinct from the snake_case row shapes in `db/rows.ts`: the repo converts
 * at the boundary so no raw millisecond integer escapes into a service.
 */

export interface Comment {
  id: number;
  mindmapId: number;
  topicId: string;
  authorId: number;
  body: string;
  createdAt: Date;
}

/**
 * Comment with the author's display name and email joined in.
 * Used for API responses so callers never need a second query.
 */
export interface CommentWithAuthor extends Comment {
  authorEmail: string;
  authorFirstname: string;
  authorLastname: string;
}
