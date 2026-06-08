import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  ADMIN_BOOTSTRAP_USERNAME?: string;
  ADMIN_BOOTSTRAP_PASSWORD?: string;
};

type Variables = {
  currentUser: CurrentUser | null;
};

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;
type QueryDB = Pick<D1Database, "prepare">;

type CurrentUser = {
  id: string;
  account: string;
  role: "student" | "admin";
  displayName: string;
  bio: string | null;
  createdAt: number;
};

type PostListItem = {
  id: string;
  author_id: string;
  title: string;
  body: string;
  category: string;
  is_anonymous: number;
  has_image: number;
  created_at: number;
  updated_at: number;
  author_name: string;
  like_count: number;
  comment_count: number;
  viewer_liked: number;
  hot_score: number;
  ai_status: string;
  review_status: string;
  review_reason: string | null;
  rejection_reason: string | null;
};

type PostDetail = PostListItem & {
  image_mime: string | null;
  author_account: string;
  author_role: "student" | "admin";
  author_display_name: string;
  author_bio: string | null;
  hidden_at: number | null;
  reviewed_at: number | null;
};

type CommentItem = {
  id: string;
  post_id: string;
  author_id: string;
  body: string;
  is_anonymous: number;
  created_at: number;
  author_name: string;
  author_account: string;
  ai_status: string;
  review_status: string;
  review_reason: string | null;
  rejection_reason: string | null;
};

type ProfileSummary = {
  id: string;
  account: string;
  display_name: string;
  bio: string | null;
  created_at: number;
  post_count: number;
  comment_count: number;
  received_like_count: number;
};

type RecentComment = {
  id: string;
  post_id: string;
  post_title: string;
  body: string;
  created_at: number;
};

type WallStats = {
  postCount: number;
  commentCount: number;
  userCount: number;
  recentPostCount: number;
  myPostCount: number;
  myCommentCount: number;
};

type CategoryStat = {
  category: string;
  count: number;
};

type ReviewQueueItem = {
  item_type: "post" | "comment";
  id: string;
  post_id: string | null;
  title: string;
  summary: string;
  category: string | null;
  author_id: string;
  author_name: string;
  has_image: number;
  ai_status: string;
  review_status: string;
  review_reason: string | null;
  rejection_reason: string | null;
  privacy_risk: number;
  abuse_risk: number;
  defamation_risk: number;
  sensitive_risk: number;
  manual_review_by_ai: number;
  confidence: number | null;
  risk_score: number;
  created_at: number;
  image_mime: string | null;
};

type ContentRiskAnalysis = {
  confidence: number;
  reviewReason: string;
  privacyRisk: boolean;
  abuseRisk: boolean;
  defamationRisk: boolean;
  sensitiveRisk: boolean;
  manualReviewByAI: boolean;
  rawResponse: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const SESSION_COOKIE = "jzib_wall_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const AUTO_APPROVE_CONFIDENCE = 0.92;
const MAX_POST_IMAGE_BYTES = 1_500_000;
const MAX_POST_TITLE = 72;
const MAX_POST_BODY = 2_400;
const MAX_COMMENT_BODY = 600;
const MAX_BIO = 140;
const LOW_REVIEW_RISK_SCORE = 24;
const AUTH_IMAGE_SRC = "/illustrations/login-hero-photo.jpg";
const FEED_ART_SOURCES = [
  { src: "/photography/feed-campus-discussion.jpg", alt: "同学在校园公共空间讨论交流的实拍图" },
  { src: "/photography/library-research.jpg", alt: "同学在图书馆查资料交流的实拍图" },
  { src: "/photography/classroom-group-study.jpg", alt: "同学在课堂小组协作讨论的实拍图" }
] as const;
const COMPOSE_ART_SOURCES = [
  { src: "/photography/compose-campus-table.jpg", alt: "同学在校园里整理内容准备发帖的实拍图" },
  { src: "/photography/classroom-study.jpg", alt: "同学围绕电脑和笔记整理观点的实拍图" },
  { src: "/photography/library-research.jpg", alt: "同学在学习空间准备资料的实拍图" }
] as const;
const PROFILE_ART_SOURCES = [
  { src: "/photography/profile-campus-classroom.jpg", alt: "课堂讨论与个人成长氛围的校园实拍图" },
  { src: "/photography/classroom-interaction.jpg", alt: "课堂互动和表达观点的校园实拍图" },
  { src: "/photography/feed-campus-discussion.jpg", alt: "同学在校园里交流互动的实拍图" }
] as const;
const CATEGORIES = ["公告通知", "校园吐槽", "建议反馈", "求助互助", "失物招领", "表白树洞", "二手交换", "社团动态"] as const;

let seedPromise: Promise<void> | null = null;

app.use("*", async (c, next) => {
  await ensureSeedData(c.env);
  const sessionId = getCookie(c, SESSION_COOKIE);
  const currentUser = sessionId ? await getCurrentUser(c.env.DB, sessionId) : null;
  c.set("currentUser", currentUser);
  await next();
});

app.get("/", (c) => {
  const currentUser = c.get("currentUser");
  return c.redirect(currentUser ? "/app" : "/login", 302);
});

app.get("/healthz", (c) =>
  c.json({
    ok: true,
    site: "JZIB 校园墙",
    now: Date.now()
  })
);

app.get("/illustrations/*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/photography/*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/prototypes/*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.get("/login", (c) => {
  if (c.get("currentUser")) {
    return c.redirect("/app", 302);
  }
  return c.html(renderAuthPage({ mode: "login", message: resolveMessage(c) }));
});

app.post("/login", async (c) => {
  const form = await c.req.formData();
  const account = toCleanString(form.get("account"));
  const password = toCleanString(form.get("password"));

  if (!account || !password) {
    return redirectWithMessage(c, "/login", "error", "请填写账号和密码。");
  }

  const row = await c.env.DB.prepare(
    `SELECT id, account, role, display_name, bio, created_at, password_salt, password_hash
     FROM users
     WHERE lower(account) = lower(?)
     LIMIT 1`
  )
    .bind(account)
    .first<{
      id: string;
      account: string;
      role: "student" | "admin";
      display_name: string | null;
      bio: string | null;
      created_at: number;
      password_salt: string;
      password_hash: string;
    }>();

  if (!row || !(await verifyPassword(password, row.password_salt, row.password_hash))) {
    return redirectWithMessage(c, "/login", "error", "账号或密码错误。");
  }

  const sessionId = generateId("sess_");
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(sessionId, row.id, now + SESSION_MAX_AGE * 1000, now)
    .run();

  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secure: c.req.url.startsWith("https://")
  });

  return c.redirect("/app", 303);
});

app.get("/register", (c) => {
  if (c.get("currentUser")) {
    return c.redirect("/app", 302);
  }
  return c.html(renderAuthPage({ mode: "register", message: resolveMessage(c) }));
});

app.post("/register", async (c) => {
  const form = await c.req.formData();
  const account = toCleanString(form.get("account"));
  const displayName = toCleanString(form.get("displayName")) || deriveDisplayName(account);
  const bio = clampText(toCleanString(form.get("bio")), MAX_BIO);
  const password = toCleanString(form.get("password"));
  const confirmPassword = toCleanString(form.get("confirmPassword"));

  if (!account || !password) {
    return redirectWithMessage(c, "/register", "error", "请先填写完整注册信息。");
  }
  if (password.length < 8) {
    return redirectWithMessage(c, "/register", "error", "密码至少需要 8 位。");
  }
  if (password !== confirmPassword) {
    return redirectWithMessage(c, "/register", "error", "两次输入的密码不一致。");
  }

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE lower(account) = lower(?) LIMIT 1")
    .bind(account)
    .first();
  if (existing) {
    return redirectWithMessage(c, "/register", "error", "这个账号已经被注册。");
  }

  const salt = generateId("salt_");
  const hash = await hashPassword(password, salt);
  const userId = generateId("user_");
  await c.env.DB.prepare(
    `INSERT INTO users (id, account, role, display_name, bio, password_salt, password_hash, created_at)
     VALUES (?, ?, 'student', ?, ?, ?, ?, ?)`
  )
    .bind(userId, account, displayName, bio || null, salt, hash, Date.now())
    .run();

  return redirectWithMessage(c, "/login", "success", "注册成功，现在可以登录校园墙了。");
});

app.post("/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/login", 303);
});

app.get("/app", async (c) => {
  const currentUser = requireUser(c);
  if (currentUser instanceof Response) return currentUser;

  const sort = normalizeSort(c.req.query("sort"));
  const category = normalizeCategory(c.req.query("category"));
  const [posts, stats, categoryStats, profile] = await Promise.all([
    listPosts(c.env.DB, {
      sort,
      category,
      viewerId: currentUser.id,
      limit: 24
    }),
    getWallStats(c.env.DB, currentUser.id),
    listCategoryStats(c.env.DB),
    getProfileSummary(c.env.DB, currentUser.id)
  ]);

  return c.html(
    renderAppShell({
      title: "校园广场",
      currentUser,
      active: "feed",
      message: resolveMessage(c),
      body: renderTimelinePage({
        currentUser,
        posts,
        stats,
        category,
        sort,
        categoryStats,
        profile
      })
    })
  );
});

app.get("/app/posts/new", (c) => {
  const currentUser = requireUser(c);
  if (currentUser instanceof Response) return currentUser;

  return c.html(
    renderAppShell({
      title: "发新帖",
      currentUser,
      active: "compose",
      message: resolveMessage(c),
      body: renderComposePage()
    })
  );
});

app.post("/app/posts", async (c) => {
  const currentUser = requireUser(c);
  if (currentUser instanceof Response) return currentUser;

  const form = await c.req.formData();
  const title = clampText(toCleanString(form.get("title")), MAX_POST_TITLE);
  const body = clampText(toCleanString(form.get("body")), MAX_POST_BODY);
  const category = normalizeCategory(toCleanString(form.get("category")));
  const isAnonymous = form.get("isAnonymous") === "on" ? 1 : 0;
  const image = form.get("image");

  if (!title || !body || !category) {
    return redirectWithMessage(c, "/app/posts/new", "error", "标题、正文和分类都要填写。");
  }

  let imageBytes: Uint8Array | null = null;
  let imageMime: string | null = null;
  if (image instanceof File && image.size > 0) {
    if (!image.type.startsWith("image/")) {
      return redirectWithMessage(c, "/app/posts/new", "error", "帖子配图只支持常见图片格式。");
    }
    if (image.size > MAX_POST_IMAGE_BYTES) {
      return redirectWithMessage(
        c,
        "/app/posts/new",
        "error",
        `配图不能超过 ${(MAX_POST_IMAGE_BYTES / 1024 / 1024).toFixed(1)}MB。`
      );
    }
    imageBytes = new Uint8Array(await image.arrayBuffer());
    imageMime = image.type || "image/jpeg";
  }

  const postId = generateId("post_");
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO posts (
      id, author_id, title, body, category, is_anonymous, image_blob, image_mime,
      ai_status, review_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'analyzing', ?, ?)`
  )
    .bind(postId, currentUser.id, title, body, category, isAnonymous, imageBytes, imageMime, now, now)
    .run();

  await moderatePost(c.env, {
    postId,
    title,
    body,
    category,
    imageBytes,
    imageMime,
    createdAt: now
  });

  const moderated = await c.env.DB.prepare("SELECT review_status FROM posts WHERE id = ? LIMIT 1")
    .bind(postId)
    .first<{ review_status: string }>();

  if (moderated?.review_status === "approved") {
    return c.redirect(
      `/app/posts/${postId}?success=${encodeURIComponent("帖子已经发布，其他同学现在可以评论了。")}`,
      303
    );
  }

  return redirectWithMessage(c, "/app/me", "success", "帖子已提交，AI 认为存在风险，已转入人工审核。");
});

app.get("/app/posts/:id", async (c) => {
  const currentUser = requireUser(c);
  if (currentUser instanceof Response) return currentUser;

  const postId = c.req.param("id");
  const post = await getPostDetail(c.env.DB, postId, currentUser.id);
  if (!post || post.hidden_at || post.review_status !== "approved") {
    return c.html(renderSimpleError("帖子不存在", "这条内容可能已经被删除。", currentUser), 404);
  }

  const [comments, relatedPosts, profile] = await Promise.all([
    listComments(c.env.DB, post.id),
    listRelatedPosts(c.env.DB, post.id, post.category, currentUser.id),
    getProfileSummary(c.env.DB, currentUser.id)
  ]);

  return c.html(
    renderAppShell({
      title: post.title,
      currentUser,
      active: "feed",
      message: resolveMessage(c),
      body: renderPostDetailPage({
        currentUser,
        post,
        comments,
        relatedPosts,
        profile
      })
    })
  );
});

app.post("/app/posts/:id/comments", async (c) => {
  const currentUser = requireUser(c);
  if (currentUser instanceof Response) return currentUser;

  const postId = c.req.param("id");
  const post = await getPostDetail(c.env.DB, postId, currentUser.id);
  if (!post || post.hidden_at) {
    return redirectWithMessage(c, "/app", "error", "这条帖子已经不存在了。");
  }

  const form = await c.req.formData();
  const body = clampText(toCleanString(form.get("body")), MAX_COMMENT_BODY);
  const isAnonymous = form.get("isAnonymous") === "on" ? 1 : 0;

  if (!body) {
    return redirectWithMessage(c, `/app/posts/${post.id}`, "error", "评论内容不能为空。");
  }

  const commentId = generateId("cmt_");
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO comments (
      id, post_id, author_id, body, is_anonymous, ai_status, review_status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 'analyzing', ?)`
  )
    .bind(commentId, post.id, currentUser.id, body, isAnonymous, now)
    .run();

  await moderateComment(c.env, {
    commentId,
    postId: post.id,
    body,
    createdAt: now
  });

  const moderated = await c.env.DB.prepare("SELECT review_status FROM comments WHERE id = ? LIMIT 1")
    .bind(commentId)
    .first<{ review_status: string }>();

  if (moderated?.review_status === "approved") {
    return c.redirect(`/app/posts/${post.id}?success=${encodeURIComponent("评论已发送。")}`, 303);
  }

  return c.redirect(`/app/posts/${post.id}?success=${encodeURIComponent("评论已提交，正在等待人工审核。")}`, 303);
});

app.post("/app/posts/:id/like", async (c) => {
  const currentUser = requireUser(c);
  if (currentUser instanceof Response) return currentUser;

  const postId = c.req.param("id");
  const post = await getPostDetail(c.env.DB, postId, currentUser.id);
  if (!post || post.hidden_at) {
    return redirectWithMessage(c, "/app", "error", "这条帖子已经不存在了。");
  }

  const form = await c.req.formData();
  const returnTo = resolveReturnTo(form.get("returnTo"), `/app/posts/${post.id}`);
  const existing = await c.env.DB.prepare("SELECT post_id FROM post_likes WHERE post_id = ? AND user_id = ? LIMIT 1")
    .bind(post.id, currentUser.id)
    .first();

  if (existing) {
    await c.env.DB.prepare("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?")
      .bind(post.id, currentUser.id)
      .run();
  } else {
    await c.env.DB.prepare("INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)")
      .bind(post.id, currentUser.id, Date.now())
      .run();
  }

  return c.redirect(returnTo, 303);
});

app.post("/app/posts/:id/delete", async (c) => {
  const currentUser = requireUser(c);
  if (currentUser instanceof Response) return currentUser;

  const postId = c.req.param("id");
  const post = await c.env.DB.prepare("SELECT id, author_id, hidden_at FROM posts WHERE id = ? LIMIT 1")
    .bind(postId)
    .first<{ id: string; author_id: string; hidden_at: number | null }>();

  if (!post) {
    return redirectWithMessage(c, "/app", "error", "帖子不存在。");
  }
  if (post.author_id !== currentUser.id && !isModerator(currentUser)) {
    return redirectWithMessage(c, `/app/posts/${post.id}`, "error", "你没有删除这条帖子的权限。");
  }

  await c.env.DB.prepare("UPDATE posts SET hidden_at = ?, hidden_by = ? WHERE id = ?")
    .bind(Date.now(), currentUser.id, post.id)
    .run();

  return redirectWithMessage(c, "/app", "success", "帖子已删除。");
});

app.post("/app/comments/:id/delete", async (c) => {
  const currentUser = requireUser(c);
  if (currentUser instanceof Response) return currentUser;

  const commentId = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT id, post_id, author_id FROM comments WHERE id = ? LIMIT 1"
  )
    .bind(commentId)
    .first<{ id: string; post_id: string; author_id: string }>();

  if (!row) {
    return redirectWithMessage(c, "/app", "error", "评论不存在。");
  }
  if (row.author_id !== currentUser.id && !isModerator(currentUser)) {
    return redirectWithMessage(c, `/app/posts/${row.post_id}`, "error", "你没有删除这条评论的权限。");
  }

  await c.env.DB.prepare("UPDATE comments SET hidden_at = ?, hidden_by = ? WHERE id = ?")
    .bind(Date.now(), currentUser.id, row.id)
    .run();

  return redirectWithMessage(c, `/app/posts/${row.post_id}`, "success", "评论已删除。");
});

app.get("/app/me", async (c) => {
  const currentUser = requireUser(c);
  if (currentUser instanceof Response) return currentUser;

  const [profile, myPosts, myComments] = await Promise.all([
    getProfileSummary(c.env.DB, currentUser.id),
    listUserPosts(c.env.DB, currentUser.id, currentUser.id),
    listRecentCommentsByUser(c.env.DB, currentUser.id)
  ]);

  return c.html(
    renderAppShell({
      title: "我的主页",
      currentUser,
      active: "profile",
      message: resolveMessage(c),
      body: renderProfilePage({
        currentUser,
        profile,
        myPosts,
        myComments
      })
    })
  );
});

app.get("/admin/reviews", async (c) => {
  const currentUser = requireAdmin(c);
  if (currentUser instanceof Response) return currentUser;

  const queue = await listReviewQueue(c.env.DB);
  return c.html(
    renderAppShell({
      title: "审核台",
      currentUser,
      active: "profile",
      message: resolveMessage(c),
      body: renderAdminReviewPage(queue)
    })
  );
});

app.post("/admin/reviews/:type/:id/approve", async (c) => {
  const currentUser = requireAdmin(c);
  if (currentUser instanceof Response) return currentUser;

  const itemType = c.req.param("type");
  const itemId = c.req.param("id");
  const now = Date.now();

  if (itemType === "post") {
    await c.env.DB.prepare(
      `UPDATE posts
       SET review_status = 'approved', reviewed_by = ?, reviewed_at = ?, ai_status = CASE WHEN ai_status = 'pending' THEN 'completed' ELSE ai_status END
       WHERE id = ?`
    )
      .bind(currentUser.id, now, itemId)
      .run();
  } else if (itemType === "comment") {
    await c.env.DB.prepare(
      `UPDATE comments
       SET review_status = 'approved', reviewed_by = ?, reviewed_at = ?, ai_status = CASE WHEN ai_status = 'pending' THEN 'completed' ELSE ai_status END
       WHERE id = ?`
    )
      .bind(currentUser.id, now, itemId)
      .run();
  } else {
    return redirectWithMessage(c, "/admin/reviews", "error", "审核对象类型无效。");
  }

  return redirectWithMessage(c, "/admin/reviews", "success", "内容已人工通过。");
});

app.post("/admin/reviews/bulk-approve-low-risk", async (c) => {
  const currentUser = requireAdmin(c);
  if (currentUser instanceof Response) return currentUser;

  const now = Date.now();
  const riskExpression =
    "(privacy_risk * 34 + abuse_risk * 28 + defamation_risk * 24 + sensitive_risk * 30 + manual_review_by_ai * 12 + CASE WHEN confidence IS NULL THEN 16 ELSE CAST((1 - confidence) * 24 AS INTEGER) END)";

  const postResult = await c.env.DB.prepare(
    `UPDATE posts
     SET review_status = 'approved',
         reviewed_by = ?,
         reviewed_at = ?,
         ai_status = CASE WHEN ai_status = 'pending' THEN 'completed' ELSE ai_status END
     WHERE hidden_at IS NULL
       AND review_status = 'manual_review'
       AND ai_status = 'completed'
       AND ${riskExpression} < ?`
  )
    .bind(currentUser.id, now, LOW_REVIEW_RISK_SCORE)
    .run();

  const commentResult = await c.env.DB.prepare(
    `UPDATE comments
     SET review_status = 'approved',
         reviewed_by = ?,
         reviewed_at = ?,
         ai_status = CASE WHEN ai_status = 'pending' THEN 'completed' ELSE ai_status END
     WHERE hidden_at IS NULL
       AND review_status = 'manual_review'
       AND ai_status = 'completed'
       AND ${riskExpression} < ?`
  )
    .bind(currentUser.id, now, LOW_REVIEW_RISK_SCORE)
    .run();

  const approvedCount = (postResult.meta.changes || 0) + (commentResult.meta.changes || 0);
  return redirectWithMessage(c, "/admin/reviews", "success", `已一键通过 ${approvedCount} 条低风险内容。`);
});

app.post("/admin/reviews/:type/:id/reject", async (c) => {
  const currentUser = requireAdmin(c);
  if (currentUser instanceof Response) return currentUser;

  const itemType = c.req.param("type");
  const itemId = c.req.param("id");
  const form = await c.req.formData();
  const rejectionReason = clampText(toCleanString(form.get("rejectionReason")), 200);
  if (!rejectionReason) {
    return redirectWithMessage(c, "/admin/reviews", "error", "请填写拒绝原因。");
  }

  const now = Date.now();
  if (itemType === "post") {
    await c.env.DB.prepare(
      `UPDATE posts
       SET review_status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = ?, hidden_at = COALESCE(hidden_at, ?), hidden_by = COALESCE(hidden_by, ?)
       WHERE id = ?`
    )
      .bind(rejectionReason, currentUser.id, now, now, currentUser.id, itemId)
      .run();
  } else if (itemType === "comment") {
    await c.env.DB.prepare(
      `UPDATE comments
       SET review_status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = ?, hidden_at = COALESCE(hidden_at, ?), hidden_by = COALESCE(hidden_by, ?)
       WHERE id = ?`
    )
      .bind(rejectionReason, currentUser.id, now, now, currentUser.id, itemId)
      .run();
  } else {
    return redirectWithMessage(c, "/admin/reviews", "error", "审核对象类型无效。");
  }

  return redirectWithMessage(c, "/admin/reviews", "success", "内容已拒绝。");
});

app.get("/post-images/:id", async (c) => {
  const currentUser = requireUser(c);
  if (currentUser instanceof Response) return currentUser;

  const row = await c.env.DB.prepare(
    "SELECT image_blob, image_mime, hidden_at FROM posts WHERE id = ? LIMIT 1"
  )
    .bind(c.req.param("id"))
    .first<{ image_blob: unknown; image_mime: string | null; hidden_at: number | null }>();

  if (!row || row.hidden_at || !row.image_blob || !row.image_mime) {
    return c.text("Not found", 404);
  }

  return new Response(toBinaryBuffer(row.image_blob), {
    headers: {
      "Content-Type": row.image_mime,
      "Cache-Control": "private, max-age=300"
    }
  });
});

app.get("/errors/404", (c) => c.html(renderSimpleError("页面不存在", "你访问的页面不存在。", c.get("currentUser")), 404));
app.get("/errors/500", (c) => c.html(renderSimpleError("应用出错", "请稍后重试。", c.get("currentUser")), 500));

app.notFound((c) => c.html(renderSimpleError("页面不存在", "你访问的页面不存在。", c.get("currentUser")), 404));
app.onError((error, c) => {
  console.error(error);
  return c.html(renderSimpleError("应用出错", errorMessage(error), c.get("currentUser")), 500);
});

async function ensureSeedData(env: Bindings): Promise<void> {
  if (!seedPromise) {
    seedPromise = seedDefaults(env).catch((error) => {
      seedPromise = null;
      throw error;
    });
  }
  await seedPromise;
}

async function seedDefaults(env: Bindings): Promise<void> {
  const now = Date.now();
  const adminAccount = env.ADMIN_BOOTSTRAP_USERNAME || "admin";
  const adminPassword = env.ADMIN_BOOTSTRAP_PASSWORD || "Admin@123456";

  const existingAdmin = await env.DB.prepare("SELECT id FROM users WHERE lower(account) = lower(?) LIMIT 1")
    .bind(adminAccount)
    .first<{ id: string }>();

  let adminId = existingAdmin?.id || "";
  if (!existingAdmin) {
    const salt = generateId("salt_");
    const hash = await hashPassword(adminPassword, salt);
    adminId = generateId("user_");
    await env.DB.prepare(
      `INSERT INTO users (id, account, role, display_name, bio, password_salt, password_hash, created_at)
       VALUES (?, ?, 'admin', '校园墙管理员', '负责维护校园墙秩序和公告发布。', ?, ?, ?)`
    )
      .bind(adminId, adminAccount, salt, hash, now)
      .run();
  }

  const existingWelcome = await env.DB.prepare("SELECT id FROM posts WHERE title = ? LIMIT 1")
    .bind("欢迎来到 JZIB 校园墙")
    .first<{ id: string }>();

  if (!existingWelcome) {
    await env.DB.prepare(
      `INSERT INTO posts (
        id, author_id, title, body, category, is_anonymous, image_blob, image_mime, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '公告通知', 0, NULL, NULL, ?, ?)`
    )
      .bind(
        generateId("post_"),
        adminId,
        "欢迎来到 JZIB 校园墙",
        [
          "这里是面向全体学生的公开交流区。",
          "你可以发帖讨论校园里遇到的问题、向老师和同学说的话，也可以在评论区继续追问和补充。",
          "发帖时请尽量把事实写清楚，避免人身攻击、隐私泄露和空泛情绪输出。"
        ].join("\n\n"),
        now,
        now
      )
      .run();
  }
}

async function getCurrentUser(db: QueryDB, sessionId: string): Promise<CurrentUser | null> {
  const row = await db.prepare(
    `SELECT users.id, users.account, users.role, users.display_name, users.bio, users.created_at
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ? AND sessions.expires_at > ?
     LIMIT 1`
  )
    .bind(sessionId, Date.now())
    .first<{
      id: string;
      account: string;
      role: "student" | "admin";
      display_name: string | null;
      bio: string | null;
      created_at: number;
    }>();

  if (!row) return null;
  return {
    id: row.id,
    account: row.account,
    role: row.role,
    displayName: row.display_name || deriveDisplayName(row.account),
    bio: row.bio,
    createdAt: row.created_at
  };
}

function requireUser(c: AppContext): CurrentUser | Response {
  const currentUser = c.get("currentUser");
  if (!currentUser) {
    return c.redirect("/login", 302);
  }
  return currentUser;
}

function isModerator(currentUser: CurrentUser): boolean {
  return currentUser.role === "admin";
}

function requireAdmin(c: AppContext): CurrentUser | Response {
  const currentUser = requireUser(c);
  if (currentUser instanceof Response) return currentUser;
  if (currentUser.role !== "admin") {
    return c.redirect("/app", 302);
  }
  return currentUser;
}

async function listPosts(
  db: QueryDB,
  input: {
    sort: "latest" | "hot" | "likes";
    category: string | null;
    viewerId: string;
    limit: number;
  }
): Promise<PostListItem[]> {
  const now = Date.now();
  const bindings: Array<string | number> = [input.viewerId, input.viewerId, now - 86_400_000, now - 259_200_000, now - 604_800_000];
  const whereCategory = input.category ? "AND posts.category = ?" : "";
  if (input.category) {
    bindings.push(input.category);
  }
  bindings.push(input.limit);

  const result = await db.prepare(
    `SELECT * FROM (
      SELECT
        posts.id,
        posts.author_id,
        posts.title,
        posts.body,
        posts.category,
        posts.is_anonymous,
        CASE WHEN posts.image_blob IS NOT NULL THEN 1 ELSE 0 END AS has_image,
        posts.created_at,
        posts.updated_at,
        CASE
          WHEN posts.is_anonymous = 1 THEN '匿名同学'
          ELSE COALESCE(users.display_name, users.account)
        END AS author_name,
        COALESCE((SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id), 0) AS like_count,
        COALESCE((SELECT COUNT(*) FROM comments WHERE post_id = posts.id AND hidden_at IS NULL AND review_status = 'approved'), 0) AS comment_count,
        CASE
          WHEN ? != '' AND EXISTS (
            SELECT 1 FROM post_likes WHERE post_id = posts.id AND user_id = ?
          ) THEN 1
          ELSE 0
        END AS viewer_liked,
        (
          COALESCE((SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id), 0) * 4
          + COALESCE((SELECT COUNT(*) FROM comments WHERE post_id = posts.id AND hidden_at IS NULL), 0) * 2
          + CASE
              WHEN posts.created_at >= ? THEN 10
              WHEN posts.created_at >= ? THEN 5
              WHEN posts.created_at >= ? THEN 2
              ELSE 0
            END
        ) AS hot_score,
        posts.ai_status,
        posts.review_status,
        posts.review_reason,
        posts.rejection_reason
      FROM posts
      JOIN users ON users.id = posts.author_id
      WHERE posts.hidden_at IS NULL AND posts.review_status = 'approved'
      ${whereCategory}
    ) feed
    ORDER BY ${
      input.sort === "hot"
        ? "hot_score DESC, created_at DESC"
        : input.sort === "likes"
          ? "like_count DESC, comment_count DESC, created_at DESC"
          : "created_at DESC"
    }
    LIMIT ?`
  )
    .bind(...bindings)
    .all<PostListItem>();

  return result.results;
}

async function getPostDetail(db: QueryDB, postId: string, viewerId: string): Promise<PostDetail | null> {
  const row = await db.prepare(
    `SELECT
      posts.id,
      posts.author_id,
      posts.title,
      posts.body,
      posts.category,
      posts.is_anonymous,
      CASE WHEN posts.image_blob IS NOT NULL THEN 1 ELSE 0 END AS has_image,
      posts.image_mime,
      posts.created_at,
      posts.updated_at,
      posts.hidden_at,
      posts.reviewed_at,
      users.account AS author_account,
      users.role AS author_role,
      COALESCE(users.display_name, users.account) AS author_display_name,
      users.bio AS author_bio,
      CASE
        WHEN posts.is_anonymous = 1 THEN '匿名同学'
        ELSE COALESCE(users.display_name, users.account)
      END AS author_name,
      COALESCE((SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id), 0) AS like_count,
      COALESCE((SELECT COUNT(*) FROM comments WHERE post_id = posts.id AND hidden_at IS NULL AND review_status = 'approved'), 0) AS comment_count,
      CASE
        WHEN ? != '' AND EXISTS (
          SELECT 1 FROM post_likes WHERE post_id = posts.id AND user_id = ?
        ) THEN 1
        ELSE 0
      END AS viewer_liked,
      (
        COALESCE((SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id), 0) * 4
        + COALESCE((SELECT COUNT(*) FROM comments WHERE post_id = posts.id AND hidden_at IS NULL AND review_status = 'approved'), 0) * 2
      ) AS hot_score
      ,
      posts.ai_status,
      posts.review_status,
      posts.review_reason,
      posts.rejection_reason
     FROM posts
     JOIN users ON users.id = posts.author_id
     WHERE posts.id = ?
     LIMIT 1`
  )
    .bind(viewerId, viewerId, postId)
    .first<PostDetail>();

  return row || null;
}

async function listComments(db: QueryDB, postId: string): Promise<CommentItem[]> {
  const result = await db.prepare(
    `SELECT
      comments.id,
      comments.post_id,
      comments.author_id,
      comments.body,
      comments.is_anonymous,
      comments.created_at,
      comments.ai_status,
      comments.review_status,
      comments.review_reason,
      comments.rejection_reason,
      CASE
        WHEN comments.is_anonymous = 1 THEN '匿名回复'
        ELSE COALESCE(users.display_name, users.account)
      END AS author_name,
      users.account AS author_account
     FROM comments
     JOIN users ON users.id = comments.author_id
     WHERE comments.post_id = ? AND comments.hidden_at IS NULL AND comments.review_status = 'approved'
     ORDER BY comments.created_at ASC`
  )
    .bind(postId)
    .all<CommentItem>();

  return result.results;
}

async function listRelatedPosts(db: QueryDB, postId: string, category: string, viewerId: string): Promise<PostListItem[]> {
  const result = await db.prepare(
    `SELECT
      posts.id,
      posts.author_id,
      posts.title,
      posts.body,
      posts.category,
      posts.is_anonymous,
      CASE WHEN posts.image_blob IS NOT NULL THEN 1 ELSE 0 END AS has_image,
      posts.created_at,
      posts.updated_at,
      CASE
        WHEN posts.is_anonymous = 1 THEN '匿名同学'
        ELSE COALESCE(users.display_name, users.account)
      END AS author_name,
      COALESCE((SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id), 0) AS like_count,
      COALESCE((SELECT COUNT(*) FROM comments WHERE post_id = posts.id AND hidden_at IS NULL AND review_status = 'approved'), 0) AS comment_count,
      CASE
        WHEN ? != '' AND EXISTS (
          SELECT 1 FROM post_likes WHERE post_id = posts.id AND user_id = ?
        ) THEN 1
        ELSE 0
      END AS viewer_liked,
      (
        COALESCE((SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id), 0) * 4
        + COALESCE((SELECT COUNT(*) FROM comments WHERE post_id = posts.id AND hidden_at IS NULL AND review_status = 'approved'), 0) * 2
      ) AS hot_score,
      posts.ai_status,
      posts.review_status,
      posts.review_reason,
      posts.rejection_reason
     FROM posts
     JOIN users ON users.id = posts.author_id
     WHERE posts.hidden_at IS NULL AND posts.review_status = 'approved' AND posts.category = ? AND posts.id != ?
     ORDER BY posts.created_at DESC
     LIMIT 5`
  )
    .bind(viewerId, viewerId, category, postId)
    .all<PostListItem>();

  return result.results;
}

async function listUserPosts(db: QueryDB, userId: string, viewerId: string): Promise<PostListItem[]> {
  const result = await db.prepare(
    `SELECT
      posts.id,
      posts.author_id,
      posts.title,
      posts.body,
      posts.category,
      posts.is_anonymous,
      CASE WHEN posts.image_blob IS NOT NULL THEN 1 ELSE 0 END AS has_image,
      posts.created_at,
      posts.updated_at,
      CASE
        WHEN posts.is_anonymous = 1 THEN '匿名同学'
        ELSE COALESCE(users.display_name, users.account)
      END AS author_name,
      COALESCE((SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id), 0) AS like_count,
      COALESCE((SELECT COUNT(*) FROM comments WHERE post_id = posts.id AND hidden_at IS NULL AND review_status = 'approved'), 0) AS comment_count,
      CASE
        WHEN ? != '' AND EXISTS (
          SELECT 1 FROM post_likes WHERE post_id = posts.id AND user_id = ?
        ) THEN 1
        ELSE 0
      END AS viewer_liked,
      (
        COALESCE((SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id), 0) * 4
        + COALESCE((SELECT COUNT(*) FROM comments WHERE post_id = posts.id AND hidden_at IS NULL AND review_status = 'approved'), 0) * 2
      ) AS hot_score,
      posts.ai_status,
      posts.review_status,
      posts.review_reason,
      posts.rejection_reason
     FROM posts
     JOIN users ON users.id = posts.author_id
     WHERE posts.author_id = ? AND posts.hidden_at IS NULL
     ORDER BY posts.created_at DESC
     LIMIT 30`
  )
    .bind(viewerId, viewerId, userId)
    .all<PostListItem>();

  return result.results;
}

async function listRecentCommentsByUser(db: QueryDB, userId: string): Promise<RecentComment[]> {
  const result = await db.prepare(
    `SELECT
      comments.id,
      comments.post_id,
      posts.title AS post_title,
      comments.body,
      comments.created_at
     FROM comments
     JOIN posts ON posts.id = comments.post_id
     WHERE comments.author_id = ? AND comments.hidden_at IS NULL AND comments.review_status = 'approved' AND posts.hidden_at IS NULL AND posts.review_status = 'approved'
     ORDER BY comments.created_at DESC
     LIMIT 20`
  )
    .bind(userId)
    .all<RecentComment>();

  return result.results;
}

async function getProfileSummary(db: QueryDB, userId: string): Promise<ProfileSummary> {
  const row = await db.prepare(
    `SELECT
      users.id,
      users.account,
      COALESCE(users.display_name, users.account) AS display_name,
      users.bio,
      users.created_at,
      COALESCE((SELECT COUNT(*) FROM posts WHERE author_id = users.id AND hidden_at IS NULL), 0) AS post_count,
      COALESCE((SELECT COUNT(*) FROM comments WHERE author_id = users.id AND hidden_at IS NULL), 0) AS comment_count,
      COALESCE((
        SELECT COUNT(*)
        FROM post_likes
        JOIN posts ON posts.id = post_likes.post_id
        WHERE posts.author_id = users.id AND posts.hidden_at IS NULL
      ), 0) AS received_like_count
     FROM users
     WHERE users.id = ?
     LIMIT 1`
  )
    .bind(userId)
    .first<ProfileSummary>();

  if (!row) {
    throw new Error("用户不存在");
  }
  return row;
}

async function getWallStats(db: QueryDB, userId: string): Promise<WallStats> {
  const row = await db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM posts WHERE hidden_at IS NULL AND review_status = 'approved') AS post_count,
      (SELECT COUNT(*) FROM comments WHERE hidden_at IS NULL AND review_status = 'approved') AS comment_count,
      (SELECT COUNT(*) FROM users WHERE role = 'student') AS user_count,
      (SELECT COUNT(*) FROM posts WHERE hidden_at IS NULL AND review_status = 'approved' AND created_at >= ?) AS recent_post_count,
      (SELECT COUNT(*) FROM posts WHERE hidden_at IS NULL AND author_id = ?) AS my_post_count,
      (SELECT COUNT(*) FROM comments WHERE hidden_at IS NULL AND author_id = ?) AS my_comment_count`
  )
    .bind(Date.now() - 86_400_000, userId, userId)
    .first<{
      post_count: number;
      comment_count: number;
      user_count: number;
      recent_post_count: number;
      my_post_count: number;
      my_comment_count: number;
    }>();

  return {
    postCount: row?.post_count ?? 0,
    commentCount: row?.comment_count ?? 0,
    userCount: row?.user_count ?? 0,
    recentPostCount: row?.recent_post_count ?? 0,
    myPostCount: row?.my_post_count ?? 0,
    myCommentCount: row?.my_comment_count ?? 0
  };
}

async function listCategoryStats(db: QueryDB): Promise<CategoryStat[]> {
  const result = await db.prepare(
    `SELECT category, COUNT(*) AS count
     FROM posts
     WHERE hidden_at IS NULL AND review_status = 'approved'
     GROUP BY category
     ORDER BY count DESC, category ASC`
  ).all<CategoryStat>();

  return result.results;
}

async function listReviewQueue(db: QueryDB): Promise<ReviewQueueItem[]> {
  const result = await db.prepare(
    `SELECT
      queue.*,
      (
        queue.privacy_risk * 34
        + queue.abuse_risk * 28
        + queue.defamation_risk * 24
        + queue.sensitive_risk * 30
        + queue.manual_review_by_ai * 12
        + CASE
            WHEN queue.ai_status = 'failed' OR queue.review_status = 'ai_failed' THEN 34
            WHEN queue.ai_status = 'analyzing' OR queue.review_status = 'analyzing' THEN 20
            WHEN queue.confidence IS NULL THEN 16
            ELSE CAST((1 - queue.confidence) * 24 AS INTEGER)
          END
      ) AS risk_score
    FROM (
      SELECT
        'post' AS item_type,
        posts.id,
        posts.id AS post_id,
        posts.title,
        posts.body AS summary,
        posts.category,
        posts.author_id,
        CASE WHEN posts.is_anonymous = 1 THEN '匿名同学' ELSE COALESCE(users.display_name, users.account) END AS author_name,
        CASE WHEN posts.image_blob IS NOT NULL THEN 1 ELSE 0 END AS has_image,
        posts.ai_status,
        posts.review_status,
        posts.review_reason,
        posts.rejection_reason,
        posts.privacy_risk,
        posts.abuse_risk,
        posts.defamation_risk,
        posts.sensitive_risk,
        posts.manual_review_by_ai,
        posts.confidence,
        posts.created_at,
        posts.image_mime
      FROM posts
      JOIN users ON users.id = posts.author_id
      WHERE posts.hidden_at IS NULL AND posts.review_status IN ('manual_review', 'ai_failed', 'analyzing')
      UNION ALL
      SELECT
        'comment' AS item_type,
        comments.id,
        comments.post_id,
        '评论内容' AS title,
        comments.body AS summary,
        NULL AS category,
        comments.author_id,
        CASE WHEN comments.is_anonymous = 1 THEN '匿名回复' ELSE COALESCE(users.display_name, users.account) END AS author_name,
        0 AS has_image,
        comments.ai_status,
        comments.review_status,
        comments.review_reason,
        comments.rejection_reason,
        comments.privacy_risk,
        comments.abuse_risk,
        comments.defamation_risk,
        comments.sensitive_risk,
        comments.manual_review_by_ai,
        comments.confidence,
        comments.created_at,
        NULL AS image_mime
      FROM comments
      JOIN users ON users.id = comments.author_id
      WHERE comments.hidden_at IS NULL AND comments.review_status IN ('manual_review', 'ai_failed', 'analyzing')
    ) queue
    ORDER BY risk_score DESC, created_at DESC
    LIMIT 100`
  ).all<ReviewQueueItem>();

  return result.results;
}

async function moderatePost(
  env: Bindings,
  input: {
    postId: string;
    title: string;
    body: string;
    category: string;
    imageBytes: Uint8Array | null;
    imageMime: string | null;
    createdAt: number;
  }
): Promise<void> {
  try {
    const analysis = await analyzeContentRisk(env, {
      contentType: "post",
      title: input.title,
      body: input.body,
      category: input.category,
      imageBytes: input.imageBytes,
      imageMime: input.imageMime
    });

    const requiresManualReview =
      analysis.confidence < AUTO_APPROVE_CONFIDENCE ||
      analysis.privacyRisk ||
      analysis.abuseRisk ||
      analysis.defamationRisk ||
      analysis.sensitiveRisk ||
      analysis.manualReviewByAI;

    await env.DB.prepare(
      `UPDATE posts
       SET ai_status = 'completed',
           ai_model = ?,
           ai_raw_response = ?,
           confidence = ?,
           review_reason = ?,
           privacy_risk = ?,
           abuse_risk = ?,
           defamation_risk = ?,
           sensitive_risk = ?,
           manual_review_by_ai = ?,
           requires_manual_review = ?,
           review_status = ?,
           reviewed_at = CASE WHEN ? = 'approved' THEN ? ELSE NULL END
       WHERE id = ?`
    )
      .bind(
        env.OPENAI_MODEL || "gpt-4.1-mini",
        analysis.rawResponse,
        analysis.confidence,
        analysis.reviewReason,
        analysis.privacyRisk ? 1 : 0,
        analysis.abuseRisk ? 1 : 0,
        analysis.defamationRisk ? 1 : 0,
        analysis.sensitiveRisk ? 1 : 0,
        analysis.manualReviewByAI ? 1 : 0,
        requiresManualReview ? 1 : 0,
        requiresManualReview ? "manual_review" : "approved",
        requiresManualReview ? "manual_review" : "approved",
        input.createdAt,
        input.postId
      )
      .run();
  } catch (error) {
    await env.DB.prepare(
      `UPDATE posts
       SET ai_status = 'failed',
           review_status = 'ai_failed',
           review_reason = ?,
           requires_manual_review = 1
       WHERE id = ?`
    )
      .bind(`AI 风险分析失败：${errorMessage(error)}`, input.postId)
      .run();
  }
}

async function moderateComment(
  env: Bindings,
  input: {
    commentId: string;
    postId: string;
    body: string;
    createdAt: number;
  }
): Promise<void> {
  try {
    const analysis = await analyzeContentRisk(env, {
      contentType: "comment",
      title: "",
      body: input.body,
      category: null,
      imageBytes: null,
      imageMime: null
    });

    const requiresManualReview =
      analysis.confidence < AUTO_APPROVE_CONFIDENCE ||
      analysis.privacyRisk ||
      analysis.abuseRisk ||
      analysis.defamationRisk ||
      analysis.sensitiveRisk ||
      analysis.manualReviewByAI;

    await env.DB.prepare(
      `UPDATE comments
       SET ai_status = 'completed',
           ai_model = ?,
           ai_raw_response = ?,
           confidence = ?,
           review_reason = ?,
           privacy_risk = ?,
           abuse_risk = ?,
           defamation_risk = ?,
           sensitive_risk = ?,
           manual_review_by_ai = ?,
           requires_manual_review = ?,
           review_status = ?,
           reviewed_at = CASE WHEN ? = 'approved' THEN ? ELSE NULL END
       WHERE id = ?`
    )
      .bind(
        env.OPENAI_MODEL || "gpt-4.1-mini",
        analysis.rawResponse,
        analysis.confidence,
        analysis.reviewReason,
        analysis.privacyRisk ? 1 : 0,
        analysis.abuseRisk ? 1 : 0,
        analysis.defamationRisk ? 1 : 0,
        analysis.sensitiveRisk ? 1 : 0,
        analysis.manualReviewByAI ? 1 : 0,
        requiresManualReview ? 1 : 0,
        requiresManualReview ? "manual_review" : "approved",
        requiresManualReview ? "manual_review" : "approved",
        input.createdAt,
        input.commentId
      )
      .run();
  } catch (error) {
    await env.DB.prepare(
      `UPDATE comments
       SET ai_status = 'failed',
           review_status = 'ai_failed',
           review_reason = ?,
           requires_manual_review = 1
       WHERE id = ?`
    )
      .bind(`AI 风险分析失败：${errorMessage(error)}`, input.commentId)
      .run();
  }
}

async function analyzeContentRisk(
  env: Bindings,
  input: {
    contentType: "post" | "comment";
    title: string;
    body: string;
    category: string | null;
    imageBytes: Uint8Array | null;
    imageMime: string | null;
  }
): Promise<ContentRiskAnalysis> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 未配置");
  }

  const promptLines = [
    "你是校园公开讨论平台的内容风险审核助手，只能输出 JSON。",
    `内容类型：${input.contentType === "post" ? "帖子" : "评论"}`,
    input.title ? `标题：${input.title}` : "",
    input.category ? `分类：${input.category}` : "",
    `正文：${input.body}`,
    "请判断内容是否涉及隐私泄露、人身攻击辱骂、未经证实的指控/诽谤风险、敏感煽动或高冲突校园舆情风险。",
    "如果你不确定，也应转人工审核。",
    "返回 JSON 字段：confidence, review_reason, privacy_risk, abuse_risk, defamation_risk, sensitive_risk, manual_review。"
  ]
    .filter(Boolean)
    .join("\n");

  const content: Array<Record<string, unknown>> = [{ type: "text", text: promptLines }];
  if (input.imageBytes && input.imageMime) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${input.imageMime};base64,${Buffer.from(input.imageBytes).toString("base64")}`
      }
    });
  }

  const response = await fetch(`${(env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0.1,
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "你是校园公开发言审核助手。必须只输出 JSON，不要 Markdown，不要额外解释。"
        },
        {
          role: "user",
          content
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI 请求失败：HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = payload.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    throw new Error("OpenAI 返回为空");
  }

  const parsed = JSON.parse(raw) as {
    confidence?: number;
    review_reason?: string;
    privacy_risk?: boolean;
    abuse_risk?: boolean;
    defamation_risk?: boolean;
    sensitive_risk?: boolean;
    manual_review?: boolean;
  };

  return {
    confidence: clampNumber(parsed.confidence ?? 0, 0, 1),
    reviewReason: clampText(String(parsed.review_reason || "AI 未返回审核理由。"), 200),
    privacyRisk: Boolean(parsed.privacy_risk),
    abuseRisk: Boolean(parsed.abuse_risk),
    defamationRisk: Boolean(parsed.defamation_risk),
    sensitiveRisk: Boolean(parsed.sensitive_risk),
    manualReviewByAI: Boolean(parsed.manual_review),
    rawResponse: raw
  };
}

function renderAuthPage(input: { mode: "login" | "register"; message: string }): string {
  const isRegister = input.mode === "register";
  return renderDocument(
    isRegister ? "注册" : "登录",
    `
      <div class="auth-shell">
        <header class="site-header auth-header">
          <a class="site-brand" href="/login">
            <span class="site-brand-mark">JZIB</span>
            <span>
              <strong>校园墙</strong>
              <small>全体学生公开交流区</small>
            </span>
          </a>
          <nav class="site-nav auth-nav">
            <a class="${isRegister ? "" : "active"}" href="/login">登录</a>
            <a class="${isRegister ? "active" : ""}" href="/register">注册</a>
          </nav>
        </header>
        ${input.message}
        <section class="auth-stage ${isRegister ? "auth-stage-register" : "auth-stage-login"}">
          <div class="auth-visual">
            <div class="auth-visual-photo">
              <img src="${AUTH_IMAGE_SRC}" alt="校园交流与志愿活动实拍图" />
              <div class="auth-photo-copy">
                <span class="eyebrow">JZIB 校园墙</span>
                <h1>把校园问题、建议、吐槽和想说的话，公开贴到一面真正能被看见的墙上</h1>
                <p>一人发帖，其他同学评论、点赞、补充线索。比朋友圈更公开，比群聊更留痕。</p>
              </div>
            </div>
            <div class="auth-note-grid">
              <article class="note-card">
                <strong>最新热议</strong>
                <p>宿舍区热水供应、图书馆插座、食堂排队、课程建议，都能直接开帖讨论。</p>
              </article>
              <article class="note-card">
                <strong>公开评论</strong>
                <p>每条帖子都能继续追问、补图、反驳和补充，让信息沉淀下来。</p>
              </article>
              <article class="note-card">
                <strong>可匿名发言</strong>
                <p>需要时可以匿名，但仍然要求对事实负责，避免攻击和隐私泄露。</p>
              </article>
            </div>
          </div>
          <div class="auth-panel">
            <div class="auth-panel-head">
              <span class="eyebrow">${isRegister ? "创建学生账号" : "校内同学登录"}</span>
              <h2>${isRegister ? "注册新账号" : "登录校园墙"}</h2>
              <p>${isRegister ? "注册后就能发帖、评论和参与校园公开讨论。" : "登录后查看最新帖子、发布讨论并参与评论。"}</p>
            </div>
            <form class="stack auth-form" method="post" action="${isRegister ? "/register" : "/login"}">
              <label class="field">
                <span>账号</span>
                <input name="account" placeholder="学号 / 手机号 / 校园邮箱" required />
              </label>
              ${
                isRegister
                  ? `
                <label class="field">
                  <span>显示名称</span>
                  <input name="displayName" placeholder="例如：机电 23 级小周" />
                </label>
                <label class="field">
                  <span>一句简介</span>
                  <textarea name="bio" rows="4" placeholder="可以写：关注教学反馈 / 失物招领 / 校园生活"></textarea>
                </label>
              `
                  : ""
              }
              <label class="field">
                <span>密码</span>
                <input type="password" name="password" placeholder="不少于 8 位" required />
              </label>
              ${
                isRegister
                  ? `
                <label class="field">
                  <span>确认密码</span>
                  <input type="password" name="confirmPassword" placeholder="再次输入密码" required />
                </label>
              `
                  : ""
              }
              <button class="button button-primary button-block" type="submit">${isRegister ? "创建账号" : "进入校园墙"}</button>
            </form>
            <div class="auth-panel-foot">
              <span>${isRegister ? "已经有账号？" : "还没有账号？"}</span>
              <a href="${isRegister ? "/login" : "/register"}">${isRegister ? "去登录" : "去注册"}</a>
            </div>
            <div class="rule-box">
              <strong>发言规则</strong>
              <ul>
                <li>讨论学校问题时尽量写清时间、地点和事实。</li>
                <li>不要公开手机号、宿舍号、证件照等隐私信息。</li>
                <li>允许批评，但不允许辱骂、造谣和人身攻击。</li>
              </ul>
            </div>
          </div>
        </section>
      </div>
    `
  );
}

function renderAppShell(input: {
  title: string;
  currentUser: CurrentUser;
  active: "feed" | "compose" | "profile";
  message: string;
  body: string;
}): string {
  return renderDocument(
    input.title,
    `
      <div class="app-shell">
        <header class="site-header app-header">
          <a class="site-brand" href="/app">
            <span class="site-brand-mark">JZIB</span>
            <span>
              <strong>校园墙</strong>
              <small>问题公开说，回复公开看</small>
            </span>
          </a>
          <nav class="site-nav app-nav">
            <a class="${input.active === "feed" ? "active" : ""}" href="/app">校园广场</a>
            <a class="${input.active === "compose" ? "active" : ""}" href="/app/posts/new">发新帖</a>
            <a class="${input.active === "profile" ? "active" : ""}" href="/app/me">我的主页</a>
            ${input.currentUser.role === "admin" ? `<a href="/admin/reviews">管理员栏</a>` : ""}
            <form class="nav-logout" method="post" action="/logout">
              <button type="submit">退出登录</button>
            </form>
          </nav>
        </header>
        <main class="app-main">
          ${input.message}
          ${input.body}
        </main>
      </div>
    `
  );
}

function renderPhotoWall(items: readonly { src: string; alt: string }[], variant: "hero" | "sidebar" = "hero"): string {
  return `
    <div class="photo-wall photo-wall-${variant}">
      ${items
        .map(
          (item, index) => `
        <figure class="photo-wall-item photo-wall-item-${index + 1}">
          <img src="${item.src}" alt="${item.alt}" />
        </figure>
      `
        )
        .join("")}
    </div>
  `;
}

function renderTimelinePage(input: {
  currentUser: CurrentUser;
  posts: PostListItem[];
  stats: WallStats;
  category: string | null;
  sort: "latest" | "hot" | "likes";
  categoryStats: CategoryStat[];
  profile: ProfileSummary;
}): string {
  return `
    <section class="forum-layout">
      <aside class="forum-sidebar">
        <a class="button button-primary button-block" href="/app/posts/new">发新帖</a>
        <div class="sidebar-block">
          <h3>广场数据</h3>
          <div class="compact-kpis">
            <span><b>${input.stats.postCount}</b> 公开帖</span>
            <span><b>${input.stats.commentCount}</b> 评论</span>
            <span><b>${input.stats.userCount}</b> 同学</span>
            <span><b>${input.stats.recentPostCount}</b> 24h 新帖</span>
          </div>
        </div>
        <div class="sidebar-block">
          <h3>我的状态</h3>
          <div class="compact-kpis">
            <span><b>${input.stats.myPostCount}</b> 发帖</span>
            <span><b>${input.stats.myCommentCount}</b> 评论</span>
            <span><b>${input.profile.received_like_count}</b> 获赞</span>
          </div>
          <a class="text-link" href="/app/me">我的主页</a>
        </div>
        <div class="sidebar-block">
          <h3>分类</h3>
          <div class="forum-category-nav">
            <a class="${input.category ? "" : "active"}" href="${feedUrl(input.sort, null)}">
              <span>全部</span><b>${input.stats.postCount}</b>
            </a>
            ${CATEGORIES.map((item) => {
              const count = input.categoryStats.find((stat) => stat.category === item)?.count || 0;
              return `
                <a class="${input.category === item ? "active" : ""}" href="${feedUrl(input.sort, item)}">
                  <span>${escapeHtml(item)}</span><b>${count}</b>
                </a>
              `;
            }).join("")}
          </div>
        </div>
      </aside>
      <div class="forum-main">
        <div class="forum-heading">
          <div>
            <h1>校园广场</h1>
            <p>最新讨论、建议反馈和互助信息。</p>
          </div>
        </div>
        <div class="toolbar-card forum-toolbar">
          <div class="toolbar-row">
            <div class="filter-tabs">
              <a class="${input.sort === "latest" ? "active" : ""}" href="${feedUrl("latest", input.category)}">最新</a>
              <a class="${input.sort === "hot" ? "active" : ""}" href="${feedUrl("hot", input.category)}">热门</a>
              <a class="${input.sort === "likes" ? "active" : ""}" href="${feedUrl("likes", input.category)}">点赞榜</a>
            </div>
            <a class="button button-secondary" href="/app/posts/new">去发帖</a>
          </div>
        </div>
        <div class="forum-topic-list">
          ${
            input.posts.length
              ? input.posts.map((post) => renderPostCard(post, `${feedUrl(input.sort, input.category)}#post-${post.id}`)).join("")
              : `<div class="empty-card">还没有帖子，先发第一条校园讨论。</div>`
          }
        </div>
      </div>
    </section>
  `;
}

function renderComposePage(): string {
  return `
    <section class="hero-card">
      <div>
        <span class="eyebrow">创建新讨论</span>
        <h1>发新帖</h1>
        <p>像发微博一样发一条校园帖子，其他同学会在下面评论、点赞和继续补充信息。</p>
      </div>
    </section>
    <section class="feature-visual-card feature-visual-card-compose feature-visual-card-gallery">
      <div class="feature-visual-media">${renderPhotoWall(COMPOSE_ART_SOURCES, "hero")}</div>
    </section>
    <section class="board-layout compose-form-layout">
      <div class="board-main">
        <form class="compose-card stack" method="post" action="/app/posts" enctype="multipart/form-data">
          <label class="field">
            <span>分类</span>
            <select name="category" required>
              <option value="">请选择一个分类</option>
              ${CATEGORIES.map((item) => `<option value="${item}">${item}</option>`).join("")}
            </select>
          </label>
          <label class="field">
            <span>标题</span>
            <input name="title" maxlength="${MAX_POST_TITLE}" placeholder="例如：图书馆二楼插座一半都没电，能不能尽快排查？" required />
          </label>
          <label class="field">
            <span>正文</span>
            <textarea name="body" rows="12" maxlength="${MAX_POST_BODY}" placeholder="把时间、地点、情况、诉求写清楚。越具体，越容易得到有用回复。" required></textarea>
          </label>
          <label class="field">
            <span>配图（可选）</span>
            <input id="imageInput" type="file" name="image" accept="image/*" />
            <small>支持常见图片格式，单张不超过 ${(MAX_POST_IMAGE_BYTES / 1024 / 1024).toFixed(1)}MB。</small>
          </label>
          <div id="imagePreview" class="image-preview hidden"></div>
          <label class="checkbox-row">
            <input type="checkbox" name="isAnonymous" />
            <span>匿名发帖</span>
          </label>
          <button class="button button-primary button-block" type="submit">发布帖子</button>
        </form>
      </div>
    </section>
    <script>${composePageScript()}</script>
  `;
}

function renderPostDetailPage(input: {
  currentUser: CurrentUser;
  post: PostDetail;
  comments: CommentItem[];
  relatedPosts: PostListItem[];
  profile: ProfileSummary;
}): string {
  return `
    <section class="detail-topbar">
      <a class="text-link" href="/app">返回校园广场</a>
    </section>
    <section class="detail-layout">
      <div class="detail-main">
        <article class="detail-card">
          <div class="post-head">
            <span class="category-badge">${escapeHtml(input.post.category)}</span>
            <time>${formatDate(input.post.created_at)}</time>
          </div>
          <h1>${escapeHtml(input.post.title)}</h1>
          <div class="post-author-line">
            <span>${escapeHtml(input.post.author_name)}</span>
            <span>${input.post.like_count} 点赞</span>
            <span>${input.post.comment_count} 评论</span>
          </div>
          <div class="post-body">${renderMultiline(input.post.body)}</div>
          ${
            input.post.has_image
              ? `<div class="detail-image-wrap"><img src="/post-images/${input.post.id}" alt="${escapeHtml(input.post.title)} 的配图" /></div>`
              : ""
          }
          <div class="post-action-row">
            <form method="post" action="/app/posts/${input.post.id}/like">
              <input type="hidden" name="returnTo" value="/app/posts/${input.post.id}" />
              <button class="button ${input.post.viewer_liked ? "button-secondary" : "button-primary"}" type="submit">
                ${input.post.viewer_liked ? "取消点赞" : "点赞这条帖"}
              </button>
            </form>
            ${
              input.post.author_id === input.currentUser.id || isModerator(input.currentUser)
                ? `
              <form method="post" action="/app/posts/${input.post.id}/delete" onsubmit="return confirm('确认删除这条帖子？');">
                <button class="button button-danger" type="submit">删除帖子</button>
              </form>
            `
                : ""
            }
          </div>
        </article>
        <section class="panel-card comment-panel">
          <div class="section-head">
            <h2>评论区</h2>
            <span>${input.comments.length} 条回复</span>
          </div>
          <form class="stack comment-form" method="post" action="/app/posts/${input.post.id}/comments">
            <label class="field">
              <span>发表评论</span>
              <textarea name="body" rows="5" maxlength="${MAX_COMMENT_BODY}" placeholder="继续补充信息，或者给出更具体的建议。" required></textarea>
            </label>
            <label class="checkbox-row">
              <input type="checkbox" name="isAnonymous" />
              <span>匿名评论</span>
            </label>
            <button class="button button-primary" type="submit">提交评论</button>
          </form>
          <div class="comment-list">
            ${
              input.comments.length
                ? input.comments
                    .map((comment) => renderCommentCard(comment, input.currentUser, input.post.id))
                    .join("")
                : `<div class="empty-card small">还没有评论，先占一楼。</div>`
            }
          </div>
        </section>
      </div>
      <aside class="detail-side">
        <div class="panel-card">
          <h3>当前账号</h3>
          <div class="side-kpis">
            <span><b>${input.profile.post_count}</b> 我的帖子</span>
            <span><b>${input.profile.comment_count}</b> 我的评论</span>
            <span><b>${input.profile.received_like_count}</b> 收到点赞</span>
          </div>
          <p class="muted">${escapeHtml(input.profile.bio || "你还没有填写简介。")}</p>
        </div>
        <div class="panel-card">
          <h3>同类帖子</h3>
          ${
            input.relatedPosts.length
              ? input.relatedPosts
                  .map(
                    (post) => `
                <a class="mini-post" href="/app/posts/${post.id}">
                  <strong>${escapeHtml(post.title)}</strong>
                  <span>${post.comment_count} 评论 · ${formatDate(post.created_at)}</span>
                </a>
              `
                  )
                  .join("")
              : `<p class="muted">暂时没有更多同类讨论。</p>`
          }
        </div>
      </aside>
    </section>
  `;
}

function renderProfilePage(input: {
  currentUser: CurrentUser;
  profile: ProfileSummary;
  myPosts: PostListItem[];
  myComments: RecentComment[];
}): string {
  return `
    <section class="hero-card">
      <div>
        <span class="eyebrow">个人主页</span>
        <h1>${escapeHtml(input.profile.display_name)}</h1>
        <p>${escapeHtml(input.profile.bio || "还没有填写简介。你可以用发帖和评论让大家知道你关心什么。")}</p>
      </div>
    </section>
    <section class="feature-visual-card feature-visual-card-profile feature-visual-card-gallery">
      <div class="feature-visual-media">${renderPhotoWall(PROFILE_ART_SOURCES, "hero")}</div>
    </section>
    <section class="metric-grid">
      <article class="metric-card">
        <span>我的帖子</span>
        <strong>${input.profile.post_count}</strong>
      </article>
      <article class="metric-card">
        <span>我的评论</span>
        <strong>${input.profile.comment_count}</strong>
      </article>
      <article class="metric-card">
        <span>收到点赞</span>
        <strong>${input.profile.received_like_count}</strong>
      </article>
      <article class="metric-card">
        <span>注册时间</span>
        <strong>${formatDate(input.profile.created_at).slice(0, 10)}</strong>
      </article>
    </section>
    <section class="board-layout profile-posts-layout">
      <div class="board-main">
        <div class="section-head">
          <h2>我发过的帖子</h2>
          <a class="text-link" href="/app/posts/new">再发一条</a>
        </div>
        ${
          input.myPosts.length
            ? input.myPosts.map((post) => renderOwnedPostCard(post)).join("")
            : `<div class="empty-card">你还没有发过帖子。</div>`
        }
      </div>
    </section>
  `;
}

function renderPostCard(post: PostListItem, returnTo: string): string {
  return `
    <article class="post-card topic-row" id="post-${post.id}">
      <div class="topic-main">
        <div class="topic-title-line">
          <span class="category-badge">${escapeHtml(post.category)}</span>
          <h2><a href="/app/posts/${post.id}">${escapeHtml(post.title)}</a></h2>
        </div>
        <p class="post-excerpt">${escapeHtml(truncate(flattenText(post.body), 150))}</p>
        <div class="topic-meta">
          <span>${escapeHtml(post.author_name)}</span>
          <time>${formatDate(post.created_at)}</time>
        </div>
      </div>
      <div class="topic-stats">
        <span><b>${post.like_count}</b>赞</span>
        <span><b>${post.comment_count}</b>评</span>
      </div>
      <div class="topic-actions">
        <form method="post" action="/app/posts/${post.id}/like">
          <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
          <button class="button button-small ${post.viewer_liked ? "button-secondary" : "button-ghost"}" type="submit">
            ${post.viewer_liked ? "已点赞" : "点赞"}
          </button>
        </form>
      </div>
    </article>
  `;
}

function renderOwnedPostCard(post: PostListItem): string {
  return `
    <article class="post-card" id="post-${post.id}">
      <div class="post-head">
        <span class="category-badge">${escapeHtml(post.category)}</span>
        <time>${formatDate(post.created_at)}</time>
      </div>
      <h2>${post.review_status === "approved" ? `<a href="/app/posts/${post.id}">${escapeHtml(post.title)}</a>` : escapeHtml(post.title)}</h2>
      <p class="post-excerpt">${escapeHtml(truncate(flattenText(post.body), 180))}</p>
      <div class="post-author-line">
        <span>${escapeHtml(post.author_name)}</span>
        <span>${renderReviewStatusText(post.review_status)}</span>
        <span>${post.like_count} 点赞</span>
      </div>
      ${
        post.review_reason
          ? `<div class="review-note">${escapeHtml(post.review_reason)}</div>`
          : post.rejection_reason
            ? `<div class="review-note review-note-danger">${escapeHtml(post.rejection_reason)}</div>`
            : ""
      }
      <div class="post-action-row">
        ${
          post.review_status === "approved"
            ? `
          <form method="post" action="/app/posts/${post.id}/like">
            <input type="hidden" name="returnTo" value="/app/me#post-${post.id}" />
            <button class="button ${post.viewer_liked ? "button-secondary" : "button-primary"}" type="submit">
              ${post.viewer_liked ? "已点赞" : "点赞"}
            </button>
          </form>
          <a class="button button-ghost" href="/app/posts/${post.id}">查看详情</a>
        `
            : `<span class="muted">当前内容尚未公开展示。</span>`
        }
      </div>
    </article>
  `;
}

function renderAdminReviewPage(queue: ReviewQueueItem[]): string {
  const priorityQueue = queue.filter((item) => isPriorityReviewItem(item));
  const quickApproveQueue = queue.filter((item) => !isPriorityReviewItem(item));
  const renderReviewItems = (items: ReviewQueueItem[], emptyText: string) =>
    items.length
      ? items.map((item) => renderReviewQueueCard(item)).join("")
      : `<div class="empty-card">${emptyText}</div>`;

  return `
    <section class="hero-card">
      <div>
        <span class="eyebrow">管理员栏</span>
        <h1>管理员审核台</h1>
        <p>AI 会先计算风险分数：高风险内容优先人工判断，低风险内容进入一键通过栏目，减少审核压力。</p>
      </div>
    </section>
    <section class="board-layout">
      <div class="board-main">
        <div class="section-head">
          <h2>重点考虑</h2>
          <span class="muted">${priorityQueue.length} 条 · 按 AI 风险从高到低</span>
        </div>
        ${renderReviewItems(priorityQueue, "当前没有高风险待审核内容。")}
        <div class="section-head review-section-head">
          <h2>一键通过栏目</h2>
          <form method="post" action="/admin/reviews/bulk-approve-low-risk">
            <button class="button button-primary" type="submit" ${quickApproveQueue.length ? "" : "disabled"}>一键通过低风险</button>
          </form>
        </div>
        ${renderReviewItems(quickApproveQueue, "当前没有低风险待审核内容。")}
      </div>
      <aside class="board-side">
        <div class="panel-card admin-panel-card">
          <h3>管理员栏</h3>
          <div class="side-kpis">
            <span><b>${queue.length}</b> 待审总数</span>
            <span><b>${priorityQueue.length}</b> 重点考虑</span>
            <span><b>${quickApproveQueue.length}</b> 可一键通过</span>
          </div>
          <div class="admin-login-hint">
            <strong>默认管理员账号</strong>
            <span>账号：admin</span>
            <span>密码：Admin@123456</span>
          </div>
        </div>
        <div class="panel-card">
          <h3>审核规则</h3>
          <ul class="plain-list">
            <li>明确的人身攻击、辱骂、影射和未证实指控，不公开。</li>
            <li>带手机号、宿舍号、截图证据、人脸等隐私信息，先驳回或要求脱敏。</li>
            <li>一般性服务建议、设施问题、校园互助内容，可在脱敏后放行。</li>
          </ul>
        </div>
      </aside>
    </section>
  `;
}

function isPriorityReviewItem(item: ReviewQueueItem): boolean {
  return item.risk_score >= LOW_REVIEW_RISK_SCORE || item.ai_status !== "completed" || item.review_status !== "manual_review";
}

function renderReviewQueueCard(item: ReviewQueueItem): string {
  return `
    <article class="post-card review-card">
      <div class="post-head">
        <span class="category-badge">${item.item_type === "post" ? "帖子" : "评论"}</span>
        <time>${formatDate(item.created_at)}</time>
      </div>
      <div class="review-score-row">
        <strong>风险分 ${Math.round(item.risk_score)}</strong>
        <span>置信度 ${item.confidence === null ? "未知" : `${Math.round(item.confidence * 100)}%`}</span>
      </div>
      <h2>${escapeHtml(item.title)}</h2>
      <p class="post-excerpt">${escapeHtml(truncate(flattenText(item.summary), 220))}</p>
      <div class="risk-chip-row">
        ${renderRiskChip(item.privacy_risk, "隐私")}
        ${renderRiskChip(item.abuse_risk, "辱骂")}
        ${renderRiskChip(item.defamation_risk, "指控")}
        ${renderRiskChip(item.sensitive_risk, "敏感")}
        ${renderRiskChip(item.manual_review_by_ai, "AI转人工")}
        ${item.ai_status !== "completed" ? `<span class="risk-chip">${escapeHtml(item.ai_status)}</span>` : ""}
      </div>
      <div class="post-author-line">
        <span>${escapeHtml(item.author_name)}</span>
        <span>${escapeHtml(item.review_status)}</span>
      </div>
      ${item.review_reason ? `<div class="review-note">${escapeHtml(item.review_reason)}</div>` : ""}
      <div class="post-action-row">
        <form method="post" action="/admin/reviews/${item.item_type}/${item.id}/approve">
          <button class="button button-primary" type="submit">人工通过</button>
        </form>
        <form class="review-reject-form" method="post" action="/admin/reviews/${item.item_type}/${item.id}/reject">
          <input name="rejectionReason" placeholder="填写拒绝原因" required />
          <button class="button button-danger" type="submit">拒绝</button>
        </form>
      </div>
    </article>
  `;
}

function renderCommentCard(comment: CommentItem, currentUser: CurrentUser, postId: string): string {
  return `
    <article class="comment-card">
      <div class="comment-meta">
        <strong>${escapeHtml(comment.author_name)}</strong>
        <span>${formatDate(comment.created_at)}</span>
      </div>
      <p>${escapeHtml(comment.body)}</p>
      ${
        comment.author_id === currentUser.id || isModerator(currentUser)
          ? `
        <form method="post" action="/app/comments/${comment.id}/delete" onsubmit="return confirm('确认删除这条评论？');">
          <input type="hidden" name="returnTo" value="/app/posts/${postId}" />
          <button class="button button-text" type="submit">删除评论</button>
        </form>
      `
          : ""
      }
    </article>
  `;
}

function renderSimpleError(title: string, message: string, currentUser: CurrentUser | null): string {
  return renderDocument(
    title,
    `
      <div class="error-shell">
        <section class="error-card">
          <span class="eyebrow">JZIB 校园墙</span>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(message)}</p>
          <a class="button button-primary" href="${currentUser ? "/app" : "/login"}">返回</a>
        </section>
      </div>
    `
  );
}

function renderDocument(title: string, body: string): string {
  return `<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)} - JZIB 校园墙</title>
      <style>${styles()}</style>
    </head>
    <body>${body}</body>
  </html>`;
}

function resolveMessage(c: AppContext): string {
  const success = c.req.query("success");
  const error = c.req.query("error");
  if (success) {
    return `<div class="message success">${escapeHtml(success)}</div>`;
  }
  if (error) {
    return `<div class="message error">${escapeHtml(error)}</div>`;
  }
  return "";
}

function composePageScript(): string {
  return `
    (function () {
      const input = document.getElementById("imageInput");
      const preview = document.getElementById("imagePreview");
      if (!(input instanceof HTMLInputElement) || !(preview instanceof HTMLElement)) return;

      input.addEventListener("change", () => {
        preview.innerHTML = "";
        preview.classList.add("hidden");
        const file = input.files && input.files[0];
        if (!file || !file.type.startsWith("image/")) return;
        const url = URL.createObjectURL(file);
        const img = document.createElement("img");
        img.src = url;
        img.alt = "帖子配图预览";
        img.onload = () => URL.revokeObjectURL(url);
        preview.appendChild(img);
        preview.classList.remove("hidden");
      });
    })();
  `;
}

function feedUrl(sort: "latest" | "hot" | "likes", category: string | null): string {
  const params = new URLSearchParams();
  if (sort === "hot") params.set("sort", "hot");
  if (sort === "likes") params.set("sort", "likes");
  if (category) params.set("category", category);
  const query = params.toString();
  return query ? `/app?${query}` : "/app";
}

function normalizeSort(value: string | undefined): "latest" | "hot" | "likes" {
  if (value === "hot" || value === "likes") return value;
  return "latest";
}

function renderReviewStatusText(status: string): string {
  switch (status) {
    case "approved":
      return "已公开";
    case "manual_review":
      return "待人工审核";
    case "ai_failed":
      return "AI 审核失败";
    case "rejected":
      return "未通过";
    case "analyzing":
      return "AI 分析中";
    default:
      return status;
  }
}

function renderRiskChip(active: number, label: string): string {
  return active ? `<span class="risk-chip">${escapeHtml(label)}</span>` : "";
}

function normalizeCategory(value: string | undefined): string | null {
  if (!value) return null;
  return (CATEGORIES as readonly string[]).includes(value) ? value : null;
}

function resolveReturnTo(value: FormDataEntryValue | null, fallback: string): string {
  const parsed = typeof value === "string" ? value.trim() : "";
  return parsed.startsWith("/") ? parsed : fallback;
}

function flattenText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clampText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function toCleanString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function deriveDisplayName(account: string): string {
  if (!account) return "JZIB同学";
  const clean = account.replace(/\s+/g, "");
  return clean.length <= 10 ? clean : `${clean.slice(0, 4)}…${clean.slice(-3)}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function renderMultiline(value: string): string {
  return value
    .split(/\n{2,}/)
    .map((part) => `<p>${escapeHtml(part).replaceAll("\n", "<br />")}</p>`)
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${password}`));
  return Buffer.from(digest).toString("hex");
}

async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  return (await hashPassword(password, salt)) === expectedHash;
}

function generateId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toBinaryBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value).buffer as ArrayBuffer;
  }
  throw new Error("图片数据无效");
}

function redirectWithMessage(c: AppContext, path: string, tone: "success" | "error", message: string): Response {
  const glue = path.includes("?") ? "&" : "?";
  return c.redirect(new URL(`${path}${glue}${tone}=${encodeURIComponent(message)}`, c.req.url).toString(), 303);
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai"
  }).format(new Date(timestamp));
}

function styles(): string {
  return `
    :root {
      --paper: #c5d89d;
      --paper-deep: #9fb86e;
      --card: rgba(251, 255, 239, 0.97);
      --ink: #1b2b21;
      --muted: #52624a;
      --line: rgba(27, 43, 33, 0.13);
      --line-strong: rgba(27, 43, 33, 0.24);
      --green: #243f2e;
      --green-soft: #e7f0d2;
      --red: #8a3625;
      --red-soft: #f1dfda;
      --yellow: #9b6b22;
      --light-card: rgba(250, 255, 236, 0.96);
      --shadow: 0 24px 60px rgba(30, 52, 31, 0.14);
      --shadow-soft: 0 14px 30px rgba(30, 52, 31, 0.09);
      --max-width: 1360px;
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      position: relative;
      margin: 0;
      color: var(--ink);
      font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(circle at 12% 8%, rgba(255, 248, 151, 0.58), transparent 25%),
        radial-gradient(circle at 88% 18%, rgba(58, 111, 55, 0.38), transparent 29%),
        radial-gradient(circle at 48% 92%, rgba(255, 255, 255, 0.36), transparent 34%),
        linear-gradient(160deg, #e6f2bd 0%, var(--paper) 44%, #8fad5c 100%);
      background-size: auto, auto, auto, auto;
      overflow-x: hidden;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      background:
        radial-gradient(ellipse at 18% 18%, rgba(255, 255, 255, 0.68), transparent 32%),
        radial-gradient(ellipse at 84% 62%, rgba(141, 184, 72, 0.58), transparent 34%),
        linear-gradient(120deg, rgba(255,255,255,0.28), transparent 28%, rgba(255,255,255,0.34));
      opacity: 1;
      mix-blend-mode: overlay;
    }
    body::after {
      content: "";
      position: fixed;
      inset: -45% -30%;
      pointer-events: none;
      z-index: 0;
      background:
        linear-gradient(112deg, transparent 22%, rgba(255,255,255,0.14) 32%, rgba(255,255,255,0.94) 43%, rgba(255,255,255,0.28) 53%, transparent 66%),
        linear-gradient(112deg, transparent 44%, rgba(255, 231, 91, 0.68) 53%, rgba(210, 255, 130, 0.52) 59%, transparent 69%),
        linear-gradient(72deg, transparent 34%, rgba(55, 110, 53, 0.48) 48%, transparent 62%);
      opacity: 1;
      mix-blend-mode: screen;
      transform: translate3d(-18%, -8%, 0);
      animation: shimmerFlow 11s ease-in-out infinite alternate;
    }
    @keyframes shimmerFlow {
      from {
        transform: translate3d(-26%, -12%, 0) rotate(-5deg) scale(1);
      }
      to {
        transform: translate3d(22%, 12%, 0) rotate(5deg) scale(1.04);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      body::after {
        animation: none;
        transform: none;
        opacity: 0.28;
      }
    }
    a { color: inherit; text-decoration: none; }
    img { display: block; max-width: 100%; }
    form { margin: 0; }
    h1, h2, h3 {
      margin: 0;
      font-family: "Noto Serif SC", "Songti SC", "STSong", serif;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    p { margin: 0; }
    .auth-shell,
    .app-shell {
      position: relative;
      z-index: 1;
      width: min(var(--max-width), calc(100% - 40px));
      margin: 0 auto;
      padding: 24px 0 56px;
    }
    .site-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 24px;
      padding: 18px 22px;
      border: 1px solid var(--line-strong);
      background: rgba(250, 255, 236, 0.97);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(18px);
    }
    .site-brand {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }
    .site-brand-mark {
      font-family: "Noto Serif SC", "Songti SC", serif;
      font-size: clamp(30px, 4vw, 54px);
      line-height: 1;
      color: var(--green);
      font-weight: 900;
    }
    .site-brand strong {
      display: block;
      font-size: 24px;
    }
    .site-brand small {
      display: block;
      color: var(--muted);
      font-size: 13px;
      margin-top: 2px;
    }
    .site-nav {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .site-nav a {
      padding: 10px 16px;
      border: 1px solid transparent;
      color: var(--muted);
      font-weight: 700;
    }
    .nav-logout {
      display: inline-flex;
    }
    .nav-logout button {
      appearance: none;
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      padding: 10px 16px;
    }
    .nav-logout button:hover,
    .site-nav a:hover {
      color: var(--ink);
      border-color: var(--line);
      background: rgba(250, 255, 236, 0.58);
    }
    .site-nav a.active {
      color: var(--ink);
      border-color: var(--line-strong);
      background: var(--light-card);
    }
    .header-user {
      display: inline-flex;
      align-items: center;
      gap: 14px;
    }
    .header-user-copy {
      display: grid;
      gap: 2px;
      text-align: right;
    }
    .header-user-copy span {
      font-size: 13px;
      color: var(--muted);
    }
    .message {
      margin-top: 18px;
      padding: 16px 18px;
      border: 1px solid var(--line-strong);
      box-shadow: var(--shadow-soft);
      font-weight: 700;
      background: var(--light-card);
    }
    .message.success {
      border-color: rgba(37, 79, 67, 0.28);
      background: var(--green-soft);
    }
    .message.error {
      border-color: rgba(138, 54, 37, 0.3);
      background: var(--red-soft);
    }
    .auth-stage,
    .board-layout,
    .detail-layout {
      display: grid;
      gap: 24px;
      margin-top: 24px;
    }
    .auth-stage {
      grid-template-columns: minmax(0, 1.45fr) minmax(420px, 520px);
      align-items: stretch;
    }
    .auth-stage-login {
      align-items: start;
    }
    .auth-stage-register {
      grid-template-columns: minmax(420px, 520px) minmax(0, 1.45fr);
    }
    .auth-stage-register .auth-visual { order: 2; }
    .auth-stage-register .auth-panel { order: 1; }
    .auth-visual,
    .auth-panel,
    .hero-card,
    .feature-visual-card,
    .metric-card,
    .toolbar-card,
    .panel-card,
    .post-card,
    .compose-card,
    .detail-card,
    .comment-card,
    .error-card,
    .empty-card {
      border: 1px solid var(--line-strong);
      background: var(--card);
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }
    .auth-visual,
    .auth-panel,
    .compose-card,
    .panel-card,
    .detail-card,
    .comment-card,
    .hero-card,
    .feature-visual-card,
    .metric-card,
    .toolbar-card,
    .post-card,
    .error-card,
    .empty-card {
      border-radius: 0;
    }
    .auth-visual,
    .auth-panel,
    .compose-card,
    .panel-card,
    .detail-card {
      padding: 22px;
    }
    .feature-visual-card {
      display: grid;
      grid-template-columns: minmax(260px, 0.9fr) minmax(0, 1.2fr);
      gap: 24px;
      align-items: start;
      margin-top: 18px;
      padding: 22px;
    }
    .feature-visual-card-gallery {
      grid-template-columns: 1fr;
    }
    .feature-visual-copy h2 {
      font-size: clamp(28px, 3vw, 42px);
      line-height: 1.14;
    }
    .feature-visual-media,
    .sidebar-visual {
      border: 1px solid var(--line);
      background: #d8e8b4;
      overflow: hidden;
    }
    .photo-wall {
      display: grid;
      gap: 12px;
      height: 100%;
    }
    .photo-wall-hero {
      grid-template-columns: minmax(0, 1.35fr) minmax(0, 0.95fr);
      grid-template-rows: repeat(2, minmax(0, 1fr));
      min-height: 100%;
    }
    .photo-wall-sidebar {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      min-height: 180px;
    }
    .photo-wall-item {
      position: relative;
      overflow: hidden;
      border: 1px solid rgba(31, 37, 39, 0.14);
      background: #b7cd85;
      min-height: 0;
    }
    .photo-wall-hero .photo-wall-item-1 {
      grid-row: 1 / span 2;
    }
    .photo-wall-sidebar .photo-wall-item {
      min-height: 180px;
    }
    .feature-visual-media img,
    .sidebar-visual img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .photo-wall-item img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      filter: saturate(0.98) contrast(1.02);
    }
    .feature-visual-media {
      min-height: 340px;
    }
    .feature-visual-card-compose .feature-visual-media {
      min-height: 320px;
    }
    .feature-visual-card-profile .feature-visual-media {
      min-height: 300px;
    }
    .sidebar-visual {
      min-height: 180px;
    }
    .auth-visual-photo {
      position: relative;
      min-height: 620px;
      overflow: hidden;
      border: 1px solid var(--line);
    }
    .auth-stage-login .auth-visual-photo {
      min-height: 440px;
    }
    .auth-stage-login .auth-photo-copy h1 {
      font-size: clamp(28px, 3.4vw, 44px);
    }
    .auth-visual-photo img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      filter: saturate(0.96) contrast(1.04);
    }
    .auth-photo-copy {
      position: absolute;
      left: 24px;
      right: 24px;
      bottom: 24px;
      padding: 22px;
      background: rgba(250, 255, 236, 0.97);
      border: 1px solid var(--line-strong);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(14px);
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border: 1px solid rgba(155, 107, 34, 0.44);
      color: var(--yellow);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 12px;
      background: rgba(255, 250, 220, 0.84);
    }
    .auth-photo-copy h1,
    .hero-card h1,
    .detail-card h1 {
      font-size: clamp(30px, 4.2vw, 54px);
      line-height: 1.08;
    }
    .auth-photo-copy p,
    .hero-card p,
    .auth-panel-head p,
    .panel-card p,
    .detail-card p {
      margin-top: 14px;
      color: var(--muted);
      line-height: 1.72;
      font-size: 16px;
    }
    .auth-note-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      margin-top: 18px;
    }
    .note-card {
      border: 1px solid var(--line);
      background: rgba(250, 255, 236, 0.82);
      padding: 16px;
      min-height: 132px;
    }
    .note-card strong {
      display: block;
      font-family: "Noto Serif SC", "Songti SC", serif;
      font-size: 18px;
      margin-bottom: 8px;
    }
    .note-card p {
      color: var(--muted);
      line-height: 1.66;
      font-size: 14px;
    }
    .auth-panel-head h2 {
      font-size: 38px;
      margin-top: 4px;
    }
    .stack {
      display: grid;
      gap: 16px;
    }
    .auth-form { margin-top: 18px; }
    .field {
      display: grid;
      gap: 8px;
    }
    .field span {
      font-size: 14px;
      font-weight: 700;
    }
    .field input,
    .field textarea,
    .field select {
      width: 100%;
      border: 1px solid var(--line-strong);
      background: rgba(252, 255, 242, 0.9);
      color: var(--ink);
      padding: 14px 16px;
      font: inherit;
      outline: none;
      border-radius: 0;
    }
    .field textarea {
      resize: vertical;
      min-height: 120px;
    }
    .field input:focus,
    .field textarea:focus,
    .field select:focus {
      border-color: var(--green);
      box-shadow: inset 0 0 0 1px var(--green);
    }
    .field small {
      color: var(--muted);
      font-size: 12px;
    }
    .button {
      appearance: none;
      border: 1px solid var(--line-strong);
      background: var(--light-card);
      color: var(--ink);
      padding: 12px 18px;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: 160ms ease;
      border-radius: 0;
    }
    .button:hover { transform: translateY(-1px); }
    .button:disabled {
      cursor: not-allowed;
      opacity: 0.48;
      transform: none;
    }
    .button-primary {
      background: linear-gradient(180deg, #385a3e 0%, var(--green) 100%);
      border-color: var(--green);
      color: #fcfff4;
    }
    .button-secondary {
      background: rgba(255, 250, 220, 0.92);
      border-color: rgba(155, 107, 34, 0.5);
      color: var(--yellow);
    }
    .button-danger {
      background: var(--red);
      border-color: var(--red);
      color: #fff;
    }
    .button-ghost {
      background: transparent;
    }
    .button-text {
      border: none;
      padding: 0;
      background: transparent;
      color: var(--red);
      font-weight: 700;
    }
    .button-block {
      width: 100%;
      min-height: 52px;
    }
    .auth-panel-foot {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      margin-top: 18px;
      color: var(--muted);
    }
    .auth-panel-foot a,
    .text-link {
      color: var(--green);
      font-weight: 800;
    }
    .rule-box {
      margin-top: 18px;
      padding: 16px;
      border: 1px solid var(--line);
      background: rgba(250, 255, 236, 0.76);
    }
    .rule-box strong {
      display: block;
      margin-bottom: 10px;
      font-family: "Noto Serif SC", "Songti SC", serif;
      font-size: 18px;
    }
    .rule-box ul,
    .plain-list {
      margin: 0;
      padding-left: 18px;
      color: var(--muted);
      line-height: 1.7;
    }
    .app-main { margin-top: 24px; }
    .forum-layout {
      display: grid;
      grid-template-columns: 248px minmax(0, 1fr);
      gap: 28px;
      align-items: start;
      margin-top: 24px;
    }
    .forum-sidebar {
      position: sticky;
      top: 18px;
      display: grid;
      gap: 18px;
      border: 1px solid var(--line-strong);
      background: rgba(250, 255, 236, 0.97);
      box-shadow: var(--shadow-soft);
      padding: 16px;
      backdrop-filter: blur(16px);
    }
    .sidebar-block {
      display: grid;
      gap: 12px;
      padding-top: 14px;
      border-top: 1px solid var(--line);
    }
    .sidebar-block h3 {
      font-family: inherit;
      font-size: 13px;
      letter-spacing: 0;
      color: var(--muted);
    }
    .compact-kpis {
      display: grid;
      gap: 8px;
    }
    .compact-kpis span,
    .forum-category-nav a {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      min-width: 0;
      color: var(--muted);
      font-size: 14px;
    }
    .compact-kpis b,
    .forum-category-nav b {
      color: var(--ink);
      font-weight: 800;
      font-variant-numeric: tabular-nums;
    }
    .forum-category-nav {
      display: grid;
      gap: 2px;
    }
    .forum-category-nav a {
      padding: 8px 10px;
      border-left: 3px solid transparent;
    }
    .forum-category-nav a.active {
      background: var(--green-soft);
      border-left-color: var(--green);
      color: var(--ink);
      font-weight: 800;
    }
    .forum-main {
      min-width: 0;
    }
    .forum-heading {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 14px;
    }
    .forum-heading h1 {
      font-size: 32px;
    }
    .forum-heading p {
      margin-top: 4px;
      color: var(--muted);
      line-height: 1.5;
    }
    .forum-toolbar {
      margin-bottom: 0;
      border-bottom: none;
      box-shadow: none;
    }
    .forum-topic-list {
      border: 1px solid var(--line-strong);
      background: rgba(250, 255, 236, 0.97);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(16px);
    }
    .hero-card {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 24px;
      padding: 24px;
    }
    .hero-card p {
      max-width: 920px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
      margin-top: 18px;
    }
    .metric-card {
      padding: 18px;
      display: grid;
      gap: 6px;
    }
    .metric-card span,
    .metric-card small,
    .muted {
      color: var(--muted);
    }
    .metric-card strong {
      font-size: clamp(28px, 3vw, 42px);
      font-family: "Noto Serif SC", "Songti SC", serif;
    }
    .board-layout {
      grid-template-columns: minmax(0, 1.65fr) 320px;
      align-items: start;
    }
    .compose-form-layout,
    .profile-posts-layout {
      grid-template-columns: 1fr;
    }
    .board-main,
    .board-side,
    .detail-main,
    .detail-side {
      display: grid;
      gap: 18px;
    }
    .toolbar-card {
      padding: 18px;
      display: grid;
      gap: 14px;
    }
    .toolbar-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .filter-tabs {
      display: inline-flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .filter-tabs a,
    .chip {
      padding: 10px 14px;
      border: 1px solid var(--line-strong);
      background: var(--light-card);
      color: var(--muted);
      font-weight: 700;
    }
    .filter-tabs a.active,
    .chip.active {
      color: var(--ink);
      border-color: var(--green);
      background: var(--green-soft);
    }
    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .post-card {
      padding: 20px;
      display: grid;
      gap: 14px;
    }
    .topic-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 108px 76px;
      gap: 16px;
      align-items: center;
      padding: 14px 16px;
      border: 0;
      border-bottom: 1px solid var(--line);
      box-shadow: none;
      background: transparent;
    }
    .topic-row:last-child {
      border-bottom: 0;
    }
    .topic-main {
      min-width: 0;
      display: grid;
      gap: 6px;
    }
    .topic-title-line {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .topic-title-line h2 {
      min-width: 0;
      font-family: inherit;
      font-size: 18px;
      line-height: 1.35;
      letter-spacing: 0;
      font-weight: 800;
    }
    .topic-title-line h2 a {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .topic-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .topic-stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    .topic-stats span {
      display: grid;
      gap: 1px;
    }
    .topic-stats b {
      color: var(--ink);
      font-size: 17px;
      line-height: 1.1;
    }
    .topic-actions {
      display: flex;
      justify-content: flex-end;
    }
    .button-small {
      padding: 8px 10px;
      min-height: 34px;
      font-size: 13px;
    }
    .post-head,
    .post-author-line,
    .comment-meta,
    .section-head,
    .detail-topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .category-badge {
      display: inline-flex;
      align-items: center;
      padding: 7px 11px;
      border: 1px solid rgba(37, 79, 67, 0.24);
      background: var(--green-soft);
      color: var(--green);
      font-size: 12px;
      font-weight: 800;
    }
    .post-card h2 {
      font-size: 28px;
      line-height: 1.2;
    }
    .post-card h2 a:hover,
    .mini-post:hover strong,
    .text-link:hover {
      text-decoration: underline;
    }
    .post-excerpt {
      color: var(--muted);
      line-height: 1.55;
      font-size: 14px;
    }
    .post-image,
    .detail-image-wrap,
    .image-preview {
      border: 1px solid var(--line);
      background: #d6e6ad;
      overflow: hidden;
    }
    .post-image img,
    .detail-image-wrap img,
    .image-preview img {
      width: 100%;
      max-height: 460px;
      object-fit: cover;
    }
    .post-action-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
    }
    .review-note {
      padding: 12px 14px;
      border: 1px solid rgba(37, 79, 67, 0.18);
      background: rgba(226, 236, 232, 0.72);
      color: var(--green);
      line-height: 1.7;
    }
    .review-note-danger {
      border-color: rgba(138, 54, 37, 0.24);
      background: rgba(241, 223, 218, 0.82);
      color: var(--red);
    }
    .review-section-head {
      margin-top: 18px;
      padding-top: 18px;
      border-top: 1px solid var(--line-strong);
    }
    .review-card {
      border-left: 5px solid rgba(36, 63, 46, 0.72);
    }
    .review-score-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      background: rgba(231, 240, 210, 0.72);
      font-variant-numeric: tabular-nums;
    }
    .review-score-row strong {
      font-size: 18px;
    }
    .review-score-row span {
      color: var(--muted);
      font-weight: 700;
    }
    .risk-chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .risk-chip {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border: 1px solid rgba(138, 54, 37, 0.24);
      background: rgba(241, 223, 218, 0.85);
      color: var(--red);
      font-size: 12px;
      font-weight: 800;
    }
    .review-reject-form {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      flex: 1;
    }
    .review-reject-form input {
      flex: 1 1 240px;
      min-width: 0;
      padding: 12px 14px;
      border: 1px solid var(--line-strong);
      background: rgba(252, 255, 242, 0.9);
      color: var(--ink);
      font: inherit;
    }
    .admin-panel-card {
      display: grid;
      gap: 14px;
    }
    .admin-login-hint {
      display: grid;
      gap: 8px;
      padding: 14px;
      border: 1px solid var(--line);
      background: rgba(250, 255, 236, 0.8);
    }
    .admin-login-hint strong {
      font-size: 14px;
    }
    .admin-login-hint span {
      color: var(--muted);
      font-weight: 700;
      word-break: break-all;
    }
    .panel-card h3,
    .section-head h2 {
      font-size: 26px;
    }
    .side-kpis,
    .category-stack {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }
    .side-kpis span,
    .category-stack span {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 10px;
      border-bottom: 1px dashed var(--line);
    }
    .side-kpis b,
    .category-stack b {
      font-family: "Noto Serif SC", "Songti SC", serif;
      font-size: 22px;
    }
    .compose-card { min-height: 100%; }
    .checkbox-row {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
    }
    .checkbox-row input {
      width: 18px;
      height: 18px;
      margin: 0;
    }
    .image-preview {
      padding: 8px;
    }
    .hidden { display: none; }
    .detail-layout {
      grid-template-columns: minmax(0, 1.6fr) 320px;
      align-items: start;
      margin-top: 18px;
    }
    .detail-card {
      display: grid;
      gap: 16px;
    }
    .post-body {
      display: grid;
      gap: 14px;
      line-height: 1.82;
      color: #2e3642;
    }
    .comment-panel,
    .comment-list {
      display: grid;
      gap: 16px;
    }
    .comment-card {
      padding: 16px;
      background: rgba(250, 255, 236, 0.9);
    }
    .comment-card p {
      line-height: 1.74;
      color: #313948;
      margin-top: 10px;
      white-space: pre-wrap;
    }
    .mini-post {
      display: grid;
      gap: 6px;
      padding: 12px 0;
      border-bottom: 1px dashed var(--line);
    }
    .mini-post strong {
      font-size: 16px;
      line-height: 1.45;
    }
    .mini-post span {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    .empty-card {
      padding: 28px;
      text-align: center;
      color: var(--muted);
    }
    .empty-card.small {
      padding: 18px;
    }
    .error-shell {
      position: relative;
      z-index: 1;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .error-card {
      width: min(640px, 100%);
      padding: 32px;
      text-align: center;
    }
    .error-card p { margin: 14px 0 22px; color: var(--muted); line-height: 1.72; }
    @media (max-width: 1180px) {
      .auth-stage,
      .auth-stage-register,
      .forum-layout,
      .board-layout,
      .detail-layout,
      .feature-visual-card {
        grid-template-columns: 1fr;
      }
      .forum-sidebar {
        position: static;
      }
      .auth-stage-register .auth-visual,
      .auth-stage-register .auth-panel {
        order: initial;
      }
      .metric-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 820px) {
      .auth-shell,
      .app-shell {
        width: min(var(--max-width), calc(100% - 24px));
        padding-top: 12px;
      }
      .site-header,
      .hero-card,
      .toolbar-row,
      .post-head,
      .post-author-line,
      .comment-meta,
      .section-head,
      .auth-panel-foot {
        align-items: flex-start;
      }
      .site-header,
      .hero-card {
        flex-direction: column;
      }
      .header-user {
        width: 100%;
        justify-content: space-between;
      }
      .header-user-copy {
        text-align: left;
      }
      .auth-visual-photo {
        min-height: 420px;
      }
      .auth-note-grid,
      .metric-grid {
        grid-template-columns: 1fr;
      }
      .post-card h2,
      .panel-card h3,
      .section-head h2 {
        font-size: 22px;
      }
      .forum-heading {
        align-items: flex-start;
        flex-direction: column;
      }
      .forum-heading h1 {
        font-size: 28px;
      }
      .topic-row {
        grid-template-columns: 1fr;
        gap: 10px;
      }
      .topic-title-line {
        align-items: flex-start;
        flex-direction: column;
        gap: 7px;
      }
      .topic-title-line h2 a {
        white-space: normal;
      }
      .topic-stats {
        width: min(180px, 100%);
        text-align: left;
      }
      .topic-actions {
        justify-content: flex-start;
      }
      .auth-panel-head h2 {
        font-size: 30px;
      }
      .auth-photo-copy h1,
      .hero-card h1,
      .detail-card h1 {
        font-size: 28px;
      }
      .feature-visual-copy h2 {
        font-size: 24px;
      }
      .feature-visual-media {
        min-height: 220px;
      }
      .photo-wall-hero,
      .photo-wall-sidebar {
        grid-template-columns: 1fr;
        grid-template-rows: none;
      }
      .photo-wall-hero .photo-wall-item-1 {
        grid-row: auto;
      }
      .photo-wall-sidebar .photo-wall-item {
        min-height: 160px;
      }
    }
  `;
}

export default app;
