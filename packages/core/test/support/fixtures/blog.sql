-- Reference schema: the blog domain used by all tests, docs and benchmarks.
-- PostgreSQL dialect. Schema classes for these tables arrive in step 04
-- (packages/core/test/support/blog.ts); MySQL and SQLite variants arrive in step 17.
--
-- Load with loadFixture(db, "blog") from ../db.ts. Keep in sync with
-- docs/plan/01-foundation.md, deliverable 9.

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text,
  age           integer,
  role          text NOT NULL DEFAULT 'member',
  password_hash text,
  settings      jsonb,
  lock_version  integer NOT NULL DEFAULT 1,
  inserted_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- has_one: users -> profiles
CREATE TABLE profiles (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  bio        text,
  avatar_url text
);

-- has_many / belongs_to: users -> posts
CREATE TABLE posts (
  id           bigserial PRIMARY KEY,
  author_id    bigint NOT NULL REFERENCES users (id),
  title        text NOT NULL,
  body         text,
  published    boolean DEFAULT false,
  views        integer DEFAULT 0,
  tags         text[],
  published_at timestamptz,
  inserted_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_author_id_index ON posts (author_id);

CREATE TABLE comments (
  id          bigserial PRIMARY KEY,
  post_id     bigint NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  author_id   bigint REFERENCES users (id),
  body        text NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_post_id_index ON comments (post_id);
CREATE INDEX comments_author_id_index ON comments (author_id);

-- many_to_many: posts <-> tags through posts_tags
CREATE TABLE tags (
  id   bigserial PRIMARY KEY,
  name text UNIQUE
);

CREATE TABLE posts_tags (
  post_id bigint NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  tag_id  bigint NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

-- uuid primary key
CREATE TABLE orgs (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

-- composite primary key
CREATE TABLE memberships (
  org_id  uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role    text NOT NULL DEFAULT 'member',
  PRIMARY KEY (org_id, user_id)
);
