// The reference schemas: the blog domain of fixtures/blog.sql as schema classes. Every
// step tests against these. Between them they cover each association kind (belongsTo,
// hasOne, hasMany, has-through, manyToMany through a table and through a join schema), a
// composite key, a uuid key, an enum, a virtual field, a redacted field, an array column
// and an embed.
//
// The tables use bigserial keys, so keys and foreign keys are t.bigint({ mode: "number" }).
import {
  belongsTo,
  EmbeddedSchema,
  hasMany,
  hasOne,
  manyToMany,
  Schema,
  t,
  timestamps,
} from "../../src/index.js";

/** Stored in users.settings (jsonb). */
export class UserSettings extends EmbeddedSchema({
  theme: t.enum(["light", "dark"]).default("light"),
  emailNotifications: t.boolean().default(true),
}) {}

export class User extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  password: t.string().virtual(),
  passwordHash: t.string().nullable().redact(),
  settings: t.embedOne(() => UserSettings).nullable(),
  lockVersion: t.integer().default(1),
  ...timestamps(),
}) {
  static profile = hasOne(() => Profile, { foreignKey: "userId" });
  static posts = hasMany(() => Post, { foreignKey: "authorId", orderBy: ["createdAt"] });
  static comments = hasMany(() => Comment, { through: ["posts", "comments"] });
  static memberships = hasMany(() => Membership, { foreignKey: "userId" });
  static orgs = manyToMany(() => Org, { joinThrough: () => Membership });

  get displayName(): string {
    return this.name ?? this.email;
  }
}

export class Profile extends Schema("profiles", {
  id: t.bigint({ mode: "number" }).primaryKey(),
  userId: t.bigint({ mode: "number" }),
  bio: t.string().nullable(),
  avatarUrl: t.string().nullable(),
}) {
  static user = belongsTo(() => User);
}

export class Post extends Schema("posts", {
  id: t.bigint({ mode: "number" }).primaryKey(),
  authorId: t.bigint({ mode: "number" }),
  title: t.string(),
  body: t.string().nullable(),
  published: t.boolean().nullable().default(false),
  views: t.integer().nullable().default(0),
  // The column is posts.tags; the name `tags` belongs to the association below.
  tagList: t.array(t.string()).nullable().column("tags"),
  publishedAt: t.timestamp().nullable(),
  ...timestamps(),
}) {
  static author = belongsTo(() => User);
  static comments = hasMany(() => Comment, { foreignKey: "postId", orderBy: ["createdAt"] });
  static tags = manyToMany(() => Tag, {
    joinThrough: "posts_tags",
    joinKeys: { owner: "post_id", target: "tag_id" },
    unique: true,
  });
}

export class Comment extends Schema("comments", {
  id: t.bigint({ mode: "number" }).primaryKey(),
  postId: t.bigint({ mode: "number" }),
  authorId: t.bigint({ mode: "number" }).nullable(),
  body: t.string(),
  ...timestamps({ updatedAt: false }),
}) {
  static post = belongsTo(() => Post);
  static author = belongsTo(() => User);
}

export class Tag extends Schema("tags", {
  id: t.bigint({ mode: "number" }).primaryKey(),
  name: t.string().nullable(),
}) {
  static posts = manyToMany(() => Post, {
    joinThrough: "posts_tags",
    joinKeys: { owner: "tag_id", target: "post_id" },
    unique: true,
  });
}

export class Org extends Schema("orgs", {
  id: t.uuid().primaryKey().autogenerate(),
  name: t.string(),
}) {
  static memberships = hasMany(() => Membership, { foreignKey: "orgId" });
  static users = manyToMany(() => User, { joinThrough: () => Membership });
}

/** The join table of users and orgs, with a composite key and a column of its own. */
export class Membership extends Schema("memberships", {
  orgId: t.uuid().primaryKey(),
  userId: t.bigint({ mode: "number" }).primaryKey({ dbGenerated: false }),
  role: t.enum(["owner", "admin", "member"]).default("member"),
}) {
  static org = belongsTo(() => Org);
  static user = belongsTo(() => User);
}
