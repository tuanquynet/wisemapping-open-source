import type { CommentWithAuthor } from "../../domain/comment.ts";
import { toIso8601 } from "../../util/iso8601.ts";

/** Wire representation of a single comment. */
export interface RestComment {
  id: number;
  topicId: string;
  body: string;
  createdAt: string;
  author: {
    id: number;
    email: string;
    firstname: string;
    lastname: string;
  };
}

/** Wire representation of a list of comments. */
export interface RestCommentList {
  count: number;
  comments: RestComment[];
}

export function toRestComment(c: CommentWithAuthor): RestComment {
  return {
    id: c.id,
    topicId: c.topicId,
    body: c.body,
    createdAt: toIso8601(c.createdAt),
    author: {
      id: c.authorId,
      email: c.authorEmail,
      firstname: c.authorFirstname,
      lastname: c.authorLastname,
    },
  };
}

export function toRestCommentList(comments: CommentWithAuthor[]): RestCommentList {
  return {
    count: comments.length,
    comments: comments.map(toRestComment),
  };
}
