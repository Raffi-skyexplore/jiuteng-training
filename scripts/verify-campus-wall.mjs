import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import app from "../src/index.ts";

class D1PreparedStatementMock {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values.map((value) => normalizeBinding(value));
    return this;
  }

  async first() {
    const statement = this.db.prepare(this.sql);
    const row = statement.get(...this.values);
    return row ?? null;
  }

  async all() {
    const statement = this.db.prepare(this.sql);
    const rows = statement.all(...this.values);
    return { results: rows };
  }

  async run() {
    const statement = this.db.prepare(this.sql);
    const result = statement.run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(result.changes ?? 0),
        last_row_id: Number(result.lastInsertRowid ?? 0)
      }
    };
  }
}

class D1DatabaseMock {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new D1PreparedStatementMock(this.db, sql);
  }
}

function normalizeBinding(value) {
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return value;
}

function parseSetCookie(headerValue) {
  if (!headerValue) return "";
  return headerValue.split(";")[0];
}

function extractCookieJar(headers) {
  const direct = headers.get("set-cookie");
  if (direct) return parseSetCookie(direct);

  const raw = headers.get("Set-Cookie");
  return parseSetCookie(raw);
}

async function request(url, init, env) {
  const response = await app.request(url, init, env);
  const text = await response.text();
  return { response, text };
}

async function main() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (typeof input === "string" && input.includes("/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  confidence: 0.98,
                  review_reason: "内容表述清晰，未发现明显隐私、辱骂或未证实指控风险。",
                  privacy_risk: false,
                  abuse_risk: false,
                  defamation_risk: false,
                  sensitive_risk: false,
                  manual_review: false
                })
              }
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(input, init);
  };

  const db = new DatabaseSync(":memory:");
  const migrationFiles = [
    "../migrations/0001_init.sql",
    "../migrations/0002_campus_wall.sql",
    "../migrations/0003_moderation.sql"
  ];
  for (const file of migrationFiles) {
    const migrationSql = readFileSync(new URL(file, import.meta.url), "utf8");
    db.exec(migrationSql);
  }

  const env = {
    DB: new D1DatabaseMock(db),
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://api.openai.test/v1",
    OPENAI_MODEL: "gpt-4.1-mini",
    ADMIN_BOOTSTRAP_USERNAME: "admin",
    ADMIN_BOOTSTRAP_PASSWORD: "Admin@123456"
  };

  const loginPage = await request("http://local.test/login", undefined, env);
  if (loginPage.response.status !== 200) throw new Error(`login page status ${loginPage.response.status}`);
  if (!loginPage.text.includes("校园墙")) throw new Error("login page missing campus wall copy");
  if (!loginPage.text.includes("/illustrations/login-hero-photo.jpg")) throw new Error("login page missing photo asset");
  if (!loginPage.text.includes("border-radius: 0;")) throw new Error("login page styles not rectangular");

  const registerBody = new URLSearchParams({
    account: "20260001",
    displayName: "测试同学",
    bio: "关注食堂和宿舍问题",
    password: "Passw0rd!",
    confirmPassword: "Passw0rd!"
  });
  const registerResult = await request(
    "http://local.test/register",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: registerBody
    },
    env
  );
  if (registerResult.response.status !== 303) throw new Error(`register status ${registerResult.response.status}`);

  const loginBody = new URLSearchParams({
    account: "20260001",
    password: "Passw0rd!"
  });
  const loginResult = await request(
    "http://local.test/login",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: loginBody
    },
    env
  );
  if (loginResult.response.status !== 303) throw new Error(`login status ${loginResult.response.status}`);
  const cookie = extractCookieJar(loginResult.response.headers);
  if (!cookie.includes("jzib_wall_session=")) throw new Error("login did not set session cookie");

  const feedResult = await request(
    "http://local.test/app",
    {
      headers: { cookie }
    },
    env
  );
  if (feedResult.response.status !== 200) throw new Error(`feed status ${feedResult.response.status}`);
  if (!feedResult.text.includes("校园广场")) throw new Error("feed missing title");
  if (!feedResult.text.includes("点赞榜")) throw new Error("feed missing likes ranking tab");

  const postBody = new URLSearchParams({
    category: "建议反馈",
    title: "宿舍热水晚高峰不稳定",
    body: "这两天 22 点左右热水忽冷忽热，希望后勤能排查一下供水系统。",
    isAnonymous: "on"
  });
  const postResult = await request(
    "http://local.test/app/posts",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie
      },
      body: postBody
    },
    env
  );
  if (postResult.response.status !== 303) throw new Error(`post create status ${postResult.response.status}`);
  const postLocation = postResult.response.headers.get("location") || "";
  const postMatch = postLocation.match(/\/app\/posts\/(post_[^?&#/]+)/);
  const postId = postMatch?.[1];
  if (!postId?.startsWith("post_")) throw new Error("post id missing");

  const detailResult = await request(
    `http://local.test/app/posts/${postId}`,
    {
      headers: { cookie }
    },
    env
  );
  if (detailResult.response.status !== 200) throw new Error(`detail status ${detailResult.response.status}`);
  if (!detailResult.text.includes("宿舍热水晚高峰不稳定")) throw new Error("detail page missing post title");

  const commentBody = new URLSearchParams({
    body: "我们楼层也是这个情况，尤其是 10 栋。",
    isAnonymous: "on"
  });
  const commentResult = await request(
    `http://local.test/app/posts/${postId}/comments`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie
      },
      body: commentBody
    },
    env
  );
  if (commentResult.response.status !== 303) throw new Error(`comment status ${commentResult.response.status}`);

  const likeBody = new URLSearchParams({ returnTo: `/app/posts/${postId}` });
  const likeResult = await request(
    `http://local.test/app/posts/${postId}/like`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie
      },
      body: likeBody
    },
    env
  );
  if (likeResult.response.status !== 303) throw new Error(`like status ${likeResult.response.status}`);
  const likeRedirect = likeResult.response.headers.get("location") || "";
  if (likeRedirect !== `/app/posts/${postId}`) throw new Error(`like redirect mismatch: ${likeRedirect}`);

  const secondPostBody = new URLSearchParams({
    category: "建议反馈",
    title: "图书馆空调这周太冷",
    body: "最近晚上的空调温度偏低，希望能适当调整。",
    isAnonymous: "on"
  });
  const secondPostResult = await request(
    "http://local.test/app/posts",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie
      },
      body: secondPostBody
    },
    env
  );
  if (secondPostResult.response.status !== 303) throw new Error(`second post create status ${secondPostResult.response.status}`);
  const secondLocation = secondPostResult.response.headers.get("location") || "";
  const secondPostId = secondLocation.match(/\/app\/posts\/(post_[^?&#/]+)/)?.[1];
  if (!secondPostId?.startsWith("post_")) throw new Error("second post id missing");

  const secondLikeBody = new URLSearchParams({ returnTo: `/app?sort=likes#post-${secondPostId}` });
  const secondLikeResult1 = await request(
    `http://local.test/app/posts/${secondPostId}/like`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie
      },
      body: secondLikeBody
    },
    env
  );
  if (secondLikeResult1.response.status !== 303) throw new Error(`second like #1 status ${secondLikeResult1.response.status}`);
  if ((secondLikeResult1.response.headers.get("location") || "") !== `/app?sort=likes#post-${secondPostId}`) {
    throw new Error("second like #1 did not preserve anchor returnTo");
  }

  const registerBody2 = new URLSearchParams({
    account: "20260002",
    displayName: "第二位同学",
    bio: "关注图书馆和空调",
    password: "Passw0rd!",
    confirmPassword: "Passw0rd!"
  });
  const registerResult2 = await request(
    "http://local.test/register",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: registerBody2
    },
    env
  );
  if (registerResult2.response.status !== 303) throw new Error(`register #2 status ${registerResult2.response.status}`);

  const loginBody2 = new URLSearchParams({
    account: "20260002",
    password: "Passw0rd!"
  });
  const loginResult2 = await request(
    "http://local.test/login",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: loginBody2
    },
    env
  );
  if (loginResult2.response.status !== 303) throw new Error(`login #2 status ${loginResult2.response.status}`);
  const cookie2 = extractCookieJar(loginResult2.response.headers);
  if (!cookie2.includes("jzib_wall_session=")) throw new Error("login #2 did not set session cookie");

  const secondLikeResult2 = await request(
    `http://local.test/app/posts/${secondPostId}/like`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookie2
      },
      body: secondLikeBody
    },
    env
  );
  if (secondLikeResult2.response.status !== 303) throw new Error(`second like #2 status ${secondLikeResult2.response.status}`);

  const likesFeed = await request(
    "http://local.test/app?sort=likes",
    {
      headers: { cookie }
    },
    env
  );
  if (likesFeed.response.status !== 200) throw new Error(`likes feed status ${likesFeed.response.status}`);
  const firstPostIndex = likesFeed.text.indexOf("宿舍热水晚高峰不稳定");
  const secondPostIndex = likesFeed.text.indexOf("图书馆空调这周太冷");
  if (firstPostIndex === -1 || secondPostIndex === -1) throw new Error("likes feed missing ranked posts");
  if (!(secondPostIndex < firstPostIndex)) throw new Error("likes feed is not ordered by like count");

  const finalDetail = await request(
    `http://local.test/app/posts/${postId}`,
    {
      headers: { cookie }
    },
    env
  );
  if (!finalDetail.text.includes("取消点赞")) throw new Error("like action not reflected");
  if (!finalDetail.text.includes("我们楼层也是这个情况")) throw new Error("comment not rendered");

  const meResult = await request(
    "http://local.test/app/me",
    {
      headers: { cookie }
    },
    env
  );
  if (meResult.response.status !== 200) throw new Error(`profile status ${meResult.response.status}`);
  if (!meResult.text.includes("测试同学")) throw new Error("profile missing display name");

  const counts = {
    users: db.prepare("SELECT COUNT(*) AS total FROM users").get().total,
    posts: db.prepare("SELECT COUNT(*) AS total FROM posts WHERE hidden_at IS NULL").get().total,
    comments: db.prepare("SELECT COUNT(*) AS total FROM comments WHERE hidden_at IS NULL").get().total,
    likes: db.prepare("SELECT COUNT(*) AS total FROM post_likes").get().total
  };

  console.log(
    JSON.stringify(
      {
        ok: true,
        verified: [
          "login_page_photo_layout",
          "rectangular_styles",
          "register",
          "login",
          "feed",
          "create_post",
          "comment_post",
          "like_post",
          "likes_ranking",
          "like_return_anchor",
          "profile_page"
        ],
        counts,
        samplePostId: postId
      },
      null,
      2
    )
  );

  globalThis.fetch = originalFetch;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
