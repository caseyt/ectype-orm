// REJECTED designs, kept as evidence for decision D1. This file intentionally does NOT compile.
//   tsc --noEmit --strict rejected-const-thunks.ts
// Candidate A fails with TS7022 ("implicitly has type 'any' ... referenced in its own initializer").
// Candidate C fails with TS2506 ("referenced directly or indirectly in its own base expression").
declare function schema<F>(source: string, fields: F): { source: string; fields: F };
declare function Schema<F>(source: string, fields: F): new () => { fields: F };
declare function hasMany<T>(t: () => T): { kind: "hasMany"; target: () => T };
declare function belongsTo<T>(t: () => T): { kind: "belongsTo"; target: () => T };

// Candidate A: const + association thunks in the same object.
export const UserA = schema("users", { id: 1, posts: hasMany(() => PostA) });
export const PostA = schema("posts", { id: 1, author: belongsTo(() => UserA) });

// Candidate C: association thunks inside the class `extends` expression.
export class UserC extends Schema("users", { id: 1, posts: hasMany(() => PostC) }) {}
export class PostC extends Schema("posts", { id: 1, author: belongsTo(() => UserC) }) {}
