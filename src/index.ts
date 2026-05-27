import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

type Bindings = {
  DB: D1Database;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  ADMIN_BOOTSTRAP_USERNAME?: string;
  ADMIN_BOOTSTRAP_PASSWORD?: string;
};

type Variables = {
  currentUser: CurrentUser | null;
};

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

type CurrentUser = {
  id: string;
  account: string;
  role: "member" | "admin";
  clubName: string | null;
  displayName: string;
  pointsBalance: number;
};

type SubmissionListRow = {
  id: string;
  description: string;
  welfare_type: string | null;
  confidence: number | null;
  suggested_points: number | null;
  review_reason: string | null;
  privacy_risk: number;
  blur_risk: number;
  web_image_risk: number;
  duplicate_risk: number;
  ai_status: string;
  review_status: string;
  rejection_reason: string | null;
  awarded_points: number;
  created_at: number;
  analyzed_at: number | null;
  reviewed_at: number | null;
};

type SubmissionDetail = SubmissionListRow & {
  user_id: string;
  image_mime: string;
  club_name: string | null;
  display_name: string;
  account: string;
  review_note: string | null;
  ai_raw_response: string | null;
};

type RewardRow = {
  id: string;
  name: string;
  description: string;
  points_cost: number;
  stock: number;
  active: number;
};

type ExchangeRow = {
  id: string;
  reward_name: string;
  points_cost: number;
  contact_info: string;
  note: string | null;
  status: string;
  created_at: number;
};

type LeaderboardRow = {
  user_id: string;
  display_name: string;
  club_name: string | null;
  month_points: number;
  approved_count: number;
};

type AIResult = {
  welfareType: string;
  confidence: number;
  suggestedPoints: number;
  reviewReason: string;
  privacyRisk: boolean;
  blurRisk: boolean;
  webImageRisk: boolean;
  duplicateRisk: boolean;
  manualReviewByAI: boolean;
  riskTags: string[];
  rawResponse: string;
};

type DashboardSummary = {
  pendingCount: number;
  approvedCount: number;
  thisMonthPoints: number;
};

const app: App = new Hono();

const SESSION_COOKIE = "jzib_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const AUTO_APPROVE_CONFIDENCE = 0.85;
const MAX_UPLOAD_BYTES = 1_200_000;
const REWARD_RULES = [
  "积分仅限本人使用，不可转让或折现。",
  "兑换申请提交后会立即扣减积分并占用奖励库存。",
  "请确保联系方式可用，管理员会通过站内记录或联系信息跟进兑换。",
  "如奖励库存不足或规则变更，管理员可拒绝申请并回退积分。"
];
const REWARD_SEEDS: RewardRow[] = [
  { id: "reward_notebook", name: "校园笔记本", description: "适合日常记录公益活动心得。", points_cost: 800, stock: 120, active: 1 },
  { id: "reward_coupon", name: "饮品兑换券（10元）", description: "校内饮品店单次 10 元兑换券。", points_cost: 1000, stock: 200, active: 1 },
  { id: "reward_stationery", name: "简约文具套装", description: "包含签字笔、尺子和便签等学习用品。", points_cost: 1500, stock: 80, active: 1 },
  { id: "reward_bus", name: "校园接驳车单次票", description: "校内接驳车单次乘车权益。", points_cost: 600, stock: 150, active: 1 },
  { id: "reward_study_room", name: "自习室预约（2小时）", description: "可兑换校内共享自习空间 2 小时。", points_cost: 1200, stock: 60, active: 1 },
  { id: "reward_gym", name: "体育馆单次使用券", description: "单次场馆入场权益。", points_cost: 1800, stock: 40, active: 1 }
];

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
  if (!currentUser) {
    return c.redirect("/login");
  }
  return c.redirect(homePathFor(currentUser));
});

app.get("/healthz", (c) =>
  c.json({
    ok: true,
    model: c.env.OPENAI_MODEL || "gpt-5.4",
    baseUrl: c.env.OPENAI_BASE_URL || "https://api.jzib.club/v1"
  })
);

app.get("/login", async (c) => {
  const currentUser = c.get("currentUser");
  if (currentUser) {
    return c.redirect(homePathFor(currentUser));
  }

  const roleMode = c.req.query("role") === "admin" ? "admin" : "member";
  return c.html(
    renderGuestPage({
      title: "登录",
      active: "login",
      roleMode,
      message: resolveMessage(c),
      body: `
        <section class="hero-card auth-hero">
          <div class="hero-copy">
            <span class="eyebrow">JZIB 公益积分站</span>
            <h1>真实公益提交，真实 AI 审核，透明积分流转</h1>
            <p>校园社团成员可以上传公益活动图片，系统会调用真实 AI 做图像分析，再根据风险情况自动通过或进入管理员审核。</p>
            <ul class="feature-list">
              <li>上传公益图片并填写说明</li>
              <li>输出公益类型、置信度、建议积分、审核理由</li>
              <li>高置信度低风险自动发积分，其余进入人工审核</li>
            </ul>
          </div>
          <div class="auth-panel">
            <div class="tab-row">
              <a class="tab ${roleMode === "member" ? "active" : ""}" href="/login">成员登录</a>
              <a class="tab ${roleMode === "admin" ? "active" : ""}" href="/login?role=admin">管理员入口</a>
            </div>
            <form method="post" action="/login" class="stack">
              <input type="hidden" name="roleMode" value="${roleMode}" />
              <label class="field">
                <span>账号</span>
                <input name="account" placeholder="手机号 / 学号 / 管理员账号" required />
              </label>
              <label class="field">
                <span>密码</span>
                <input type="password" name="password" placeholder="请输入密码" required />
              </label>
              <button class="btn btn-primary" type="submit">${roleMode === "admin" ? "进入管理员审核台" : "登录"}</button>
            </form>
            <div class="auth-links">
              <span>还没有账号？</span>
              <a href="/register">去注册</a>
            </div>
            <p class="helper-text">P0 默认支持成员账号注册；管理员账号由系统初始化或部署变量创建。</p>
          </div>
        </section>
      `
    })
  );
});

app.post("/login", async (c) => {
  const form = await c.req.formData();
  const account = toCleanString(form.get("account"));
  const password = toCleanString(form.get("password"));
  const roleMode = toCleanString(form.get("roleMode")) === "admin" ? "admin" : "member";

  if (!account || !password) {
    return redirectWithMessage(c, "/login", "error", "请填写账号和密码。");
  }

  const row = await c.env.DB.prepare(
    `SELECT id, account, role, club_name, display_name, points_balance, password_salt, password_hash
      FROM users
      WHERE lower(account) = lower(?)
      LIMIT 1`
  )
    .bind(account)
    .first<{
      id: string;
      account: string;
      role: "member" | "admin";
      club_name: string | null;
      display_name: string | null;
      points_balance: number;
      password_salt: string;
      password_hash: string;
    }>();

  if (!row || !(await verifyPassword(password, row.password_salt, row.password_hash))) {
    return redirectWithMessage(c, `/login${roleMode === "admin" ? "?role=admin" : ""}`, "error", "账号或密码错误。");
  }

  if (roleMode === "admin" && row.role !== "admin") {
    return redirectWithMessage(c, "/login?role=admin", "error", "该账号不是管理员。");
  }

  const sessionId = generateId("sess_");
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(sessionId, row.id, now + SESSION_MAX_AGE * 1000, now)
    .run();

  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secure: c.req.url.startsWith("https://")
  });

  return c.redirect(homePathFor(toCurrentUser(row)));
});

app.get("/register", (c) => {
  const currentUser = c.get("currentUser");
  if (currentUser) {
    return c.redirect(homePathFor(currentUser));
  }

  return c.html(
    renderGuestPage({
      title: "注册",
      active: "register",
      roleMode: "member",
      message: resolveMessage(c),
      body: `
        <section class="hero-card auth-hero">
          <div class="hero-copy">
            <span class="eyebrow">成员注册</span>
            <h1>为校园公益社团创建可用账号</h1>
            <p>注册成功后，你可以提交公益图片、查看审核状态、累计积分并发起奖励兑换。</p>
            <div class="tip-grid">
              <article class="mini-card"><strong>上传要求</strong><span>请尽量上传现场拍摄图片，避免截图或海报。</span></article>
              <article class="mini-card"><strong>审核机制</strong><span>高置信度低风险自动加分，其他情况进入管理员审核。</span></article>
              <article class="mini-card"><strong>积分透明</strong><span>所有积分变化都会记录在个人账户中，支持月榜展示。</span></article>
            </div>
          </div>
          <div class="auth-panel">
            <form method="post" action="/register" class="stack">
              <label class="field">
                <span>账号</span>
                <input name="account" placeholder="手机号 / 学号" required />
              </label>
              <label class="field">
                <span>社团名称</span>
                <input name="clubName" placeholder="例如：校园环保志愿社" required />
              </label>
              <label class="field">
                <span>显示名称（可选）</span>
                <input name="displayName" placeholder="排行榜中展示的名称" />
              </label>
              <label class="field">
                <span>密码</span>
                <input type="password" name="password" placeholder="不少于 8 位" required />
              </label>
              <label class="field">
                <span>确认密码</span>
                <input type="password" name="confirmPassword" placeholder="再次输入密码" required />
              </label>
              <button class="btn btn-primary" type="submit">创建成员账号</button>
            </form>
            <div class="auth-links">
              <span>已经有账号？</span>
              <a href="/login">去登录</a>
            </div>
          </div>
        </section>
      `
    })
  );
});

app.post("/register", async (c) => {
  const form = await c.req.formData();
  const account = toCleanString(form.get("account"));
  const clubName = toCleanString(form.get("clubName"));
  const displayName = toCleanString(form.get("displayName")) || deriveDisplayName(account);
  const password = toCleanString(form.get("password"));
  const confirmPassword = toCleanString(form.get("confirmPassword"));

  if (!account || !clubName || !password) {
    return redirectWithMessage(c, "/register", "error", "请完整填写注册信息。");
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
    return redirectWithMessage(c, "/register", "error", "该账号已被注册。");
  }

  const salt = generateId("salt_");
  const hash = await hashPassword(password, salt);
  const userId = generateId("user_");
  await c.env.DB.prepare(
    `INSERT INTO users (id, account, role, club_name, display_name, password_salt, password_hash, points_balance, created_at)
      VALUES (?, ?, 'member', ?, ?, ?, ?, 0, ?)`
  )
    .bind(userId, account, clubName, displayName, salt, hash, Date.now())
    .run();

  return redirectWithMessage(c, "/login", "success", "注册成功，请登录。");
});

app.post("/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/login");
});

app.get("/app", async (c) => {
  const currentUser = requireMember(c);
  if (currentUser instanceof Response) return currentUser;

  const [summary, recentSubmissions, rewards, leaderboard] = await Promise.all([
    getDashboardSummary(c.env.DB, currentUser.id),
    listUserSubmissions(c.env.DB, currentUser.id, 5),
    listRewards(c.env.DB, 4),
    getLeaderboard(c.env.DB, currentMonthKey())
  ]);

  const yourRank = leaderboard.findIndex((row) => row.user_id === currentUser.id) + 1 || null;
  const leaderboardRows = leaderboard.slice(0, 5);

  return c.html(
    renderMemberShell({
      title: "用户首页",
      currentUser,
      active: "dashboard",
      message: resolveMessage(c),
      body: `
        <section class="page-hero">
          <div>
            <h1>用户首页</h1>
            <p>你好，${escapeHtml(currentUser.displayName)}。这里可以查看积分余额、最近提交和本月排行榜概览。</p>
          </div>
          <a class="btn btn-primary" href="/app/submissions/new">上传公益图片</a>
        </section>
        <section class="card-grid cards-4">
          <article class="metric-card">
            <span>积分余额</span>
            <strong>${currentUser.pointsBalance}</strong>
            <small>可用于兑换奖励</small>
          </article>
          <article class="metric-card">
            <span>待处理提交</span>
            <strong>${summary.pendingCount}</strong>
            <small>包含审核中和 AI 失败</small>
          </article>
          <article class="metric-card">
            <span>已通过提交</span>
            <strong>${summary.approvedCount}</strong>
            <small>自动通过 + 管理员通过</small>
          </article>
          <article class="metric-card accent-card">
            <span>本月新增积分</span>
            <strong>${summary.thisMonthPoints}</strong>
            <small>${currentMonthKey().replace("-", " 年 ")} 月统计</small>
          </article>
        </section>
        <section class="split-layout">
          <div class="panel">
            <div class="panel-head">
              <h2>最近提交</h2>
              <a href="/app/submissions">查看全部</a>
            </div>
            <div class="stack">
              ${
                recentSubmissions.length
                  ? recentSubmissions
                      .map(
                        (submission) => `
                  <a class="submission-row" href="/app/submissions?id=${submission.id}">
                    <img src="/submission-images/${submission.id}" alt="提交图片缩略图" />
                    <div class="submission-row-main">
                      <strong>${escapeHtml(truncate(submission.description, 44))}</strong>
                      <span>${statusBadge(submission.review_status)} · ${formatDate(submission.created_at)}</span>
                    </div>
                    <div class="submission-row-points">${submission.awarded_points ? `+${submission.awarded_points}` : "待定"}</div>
                  </a>
                `
                      )
                      .join("")
                  : `<p class="empty-state">还没有任何公益提交，先上传第一张现场图片。</p>`
              }
            </div>
          </div>
          <div class="panel">
            <div class="panel-head">
              <h2>每月排行榜</h2>
              <a href="/app/leaderboard">查看月榜</a>
            </div>
            <div class="leaderboard-card">
              <div class="leaderboard-rank">
                <span>我的排名</span>
                <strong>${yourRank || "--"}</strong>
                <small>${currentMonthKey()} 月积分</small>
              </div>
              <div class="stack">
                ${
                  leaderboardRows.length
                    ? leaderboardRows
                        .map(
                          (row, index) => `
                    <div class="leaderboard-row ${row.user_id === currentUser.id ? "self" : ""}">
                      <span>#${index + 1}</span>
                      <strong>${escapeHtml(row.display_name)}</strong>
                      <small>${escapeHtml(row.club_name || "未填写社团")}</small>
                      <b>${row.month_points}</b>
                    </div>
                  `
                        )
                        .join("")
                    : `<p class="empty-state">本月还没有积分记录。</p>`
                }
              </div>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>可兑换奖励</h2>
            <a href="/app/rewards">进入兑换中心</a>
          </div>
          <div class="reward-grid">
            ${rewards
              .map(
                (reward) => `
              <article class="reward-card">
                <div class="reward-media">${rewardEmoji(reward.name)}</div>
                <div class="reward-body">
                  <h3>${escapeHtml(reward.name)}</h3>
                  <p>${escapeHtml(reward.description)}</p>
                </div>
                <div class="reward-meta">
                  <span>${reward.points_cost} 积分</span>
                  <small>库存 ${reward.stock}</small>
                </div>
              </article>
            `
              )
              .join("")}
          </div>
        </section>
      `
    })
  );
});

app.get("/app/submissions/new", (c) => {
  const currentUser = requireMember(c);
  if (currentUser instanceof Response) return currentUser;

  return c.html(
    renderMemberShell({
      title: "图片提交",
      currentUser,
      active: "submit",
      message: resolveMessage(c),
      body: `
        <section class="page-hero">
          <div>
            <h1>图片提交</h1>
            <p>上传公益活动图片并填写简单说明。系统会调用真实 AI 分析图片，失败时会保留失败状态并转人工处理。</p>
          </div>
        </section>
        <section class="split-layout">
          <form class="panel stack" method="post" action="/app/submissions" enctype="multipart/form-data" id="upload-form">
            <div class="panel-head">
              <h2>上传图片</h2>
            </div>
            <label class="upload-dropzone" for="imageInput">
              <input id="imageInput" type="file" name="image" accept="image/*" required />
              <div id="upload-preview" class="upload-preview hidden"></div>
              <div id="upload-placeholder">
                <strong>拖拽图片到此处，或点击选择文件</strong>
                <span>浏览器会在提交前自动压缩图片，便于存入 D1 并传给 AI 分析。</span>
              </div>
            </label>
            <div class="helper-text" id="upload-meta">建议上传现场拍摄的 JPG / PNG 图片，压缩后不超过 1.2MB。</div>
            <label class="field">
              <span>活动说明</span>
              <textarea name="description" rows="6" placeholder="例如：2026 年 5 月 21 日，我们在校园东区主干道开展垃圾清理和绿化维护活动。" required></textarea>
            </label>
            <button class="btn btn-primary" type="submit">提交审核</button>
          </form>
          <aside class="panel stack">
            <div class="panel-head">
              <h2>AI 分析输出</h2>
            </div>
            <div class="info-card">
              <strong>提交后会尝试生成以下字段</strong>
              <ul class="feature-list compact">
                <li>公益类型</li>
                <li>置信度</li>
                <li>建议积分</li>
                <li>审核理由</li>
                <li>隐私风险 / 模糊 / 疑似网图 / 疑似重复</li>
              </ul>
            </div>
            <div class="warning-box">
              <strong>隐私风险提醒</strong>
              <p>请尽量避免包含身份证件、车牌、宿舍号、手机号、签到表或清晰人脸特写。如果图像存在隐私风险，会强制进入人工审核。</p>
            </div>
            <div class="info-card">
              <strong>自动加分条件</strong>
              <p>AI 置信度 ≥ ${AUTO_APPROVE_CONFIDENCE}，且无隐私风险、无模糊、无疑似网图、无重复命中时，系统才会自动通过并发放积分。</p>
            </div>
          </aside>
        </section>
        <script>${uploadPageScript()}</script>
      `
    })
  );
});

app.post("/app/submissions", async (c) => {
  const currentUser = requireMember(c);
  if (currentUser instanceof Response) return currentUser;

  const form = await c.req.formData();
  const description = toCleanString(form.get("description"));
  const image = form.get("image");

  if (!description || !(image instanceof File)) {
    return redirectWithMessage(c, "/app/submissions/new", "error", "请上传图片并填写活动说明。");
  }

  const imageBuffer = new Uint8Array(await image.arrayBuffer());
  if (!imageBuffer.byteLength) {
    return redirectWithMessage(c, "/app/submissions/new", "error", "上传图片为空，请重新选择。");
  }
  if (imageBuffer.byteLength > MAX_UPLOAD_BYTES) {
    return redirectWithMessage(c, "/app/submissions/new", "error", `图片压缩后仍超过 ${(MAX_UPLOAD_BYTES / 1024).toFixed(0)}KB，请重新选择更小的图片。`);
  }

  const imageMime = image.type || "image/jpeg";
  const imageHash = await sha256Hex(imageBuffer);
  const duplicateHit = await c.env.DB.prepare("SELECT id FROM submissions WHERE image_sha256 = ? LIMIT 1")
    .bind(imageHash)
    .first<{ id: string }>();

  const submissionId = generateId("sub_");
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO submissions (
      id, user_id, description, image_blob, image_mime, image_sha256, image_size,
      ai_status, review_status, duplicate_risk, requires_manual_review, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'analyzing', ?, 1, ?)`
  )
    .bind(
      submissionId,
      currentUser.id,
      description,
      imageBuffer,
      imageMime,
      imageHash,
      imageBuffer.byteLength,
      duplicateHit ? 1 : 0,
      now
    )
    .run();

  try {
    const aiResult = await analyzeImage(c.env, {
      description,
      imageMime,
      imageBuffer,
      duplicateDetected: Boolean(duplicateHit)
    });

    const requiresManualReview =
      aiResult.confidence < AUTO_APPROVE_CONFIDENCE ||
      aiResult.privacyRisk ||
      aiResult.blurRisk ||
      aiResult.webImageRisk ||
      aiResult.duplicateRisk ||
      aiResult.manualReviewByAI;

    const reviewStatus = requiresManualReview ? "manual_review" : "auto_approved";
    const awardedPoints = requiresManualReview ? 0 : aiResult.suggestedPoints;

    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `UPDATE submissions
         SET ai_status = 'completed',
             ai_model = ?,
             ai_raw_response = ?,
             welfare_type = ?,
             confidence = ?,
             suggested_points = ?,
             review_reason = ?,
             privacy_risk = ?,
             blur_risk = ?,
             web_image_risk = ?,
             duplicate_risk = ?,
             manual_review_by_ai = ?,
             requires_manual_review = ?,
             review_status = ?,
             awarded_points = ?,
             analyzed_at = ?,
             reviewed_at = CASE WHEN ? = 'auto_approved' THEN ? ELSE reviewed_at END,
             reviewed_by = CASE WHEN ? = 'auto_approved' THEN NULL ELSE reviewed_by END,
             review_note = CASE WHEN ? = 'auto_approved' THEN '系统自动通过' ELSE review_note END
         WHERE id = ?`
      ).bind(
        c.env.OPENAI_MODEL || "gpt-5.4",
        aiResult.rawResponse,
        aiResult.welfareType,
        aiResult.confidence,
        aiResult.suggestedPoints,
        aiResult.reviewReason,
        aiResult.privacyRisk ? 1 : 0,
        aiResult.blurRisk ? 1 : 0,
        aiResult.webImageRisk ? 1 : 0,
        aiResult.duplicateRisk ? 1 : 0,
        aiResult.manualReviewByAI ? 1 : 0,
        requiresManualReview ? 1 : 0,
        reviewStatus,
        awardedPoints,
        now,
        reviewStatus,
        now,
        reviewStatus,
        reviewStatus,
        submissionId
      )
    ];

    if (!requiresManualReview && awardedPoints > 0) {
      statements.push(
        c.env.DB.prepare("UPDATE users SET points_balance = points_balance + ? WHERE id = ?").bind(awardedPoints, currentUser.id),
        c.env.DB.prepare(
          "INSERT INTO points_ledger (id, user_id, submission_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(
          generateId("ledger_"),
          currentUser.id,
          submissionId,
          awardedPoints,
          `自动通过：${aiResult.welfareType}`,
          now
        )
      );
    }

    await c.env.DB.batch(statements);
  } catch (error) {
    await c.env.DB.prepare(
      `UPDATE submissions
       SET ai_status = 'failed',
           review_status = 'ai_failed',
           review_reason = ?,
           analyzed_at = ?
       WHERE id = ?`
    )
      .bind(`AI 分析失败：${errorMessage(error)}`, now, submissionId)
      .run();
  }

  return c.redirect(`/app/submissions?id=${submissionId}&success=${encodeURIComponent("提交已保存，系统已尝试执行 AI 分析。")}`);
});

app.get("/app/submissions", async (c) => {
  const currentUser = requireMember(c);
  if (currentUser instanceof Response) return currentUser;

  const submissions = await listUserSubmissions(c.env.DB, currentUser.id, 50);
  const selectedId = c.req.query("id") || submissions[0]?.id || null;
  const selected = selectedId ? await getSubmissionDetail(c.env.DB, selectedId, currentUser.id) : null;

  return c.html(
    renderMemberShell({
      title: "提交记录",
      currentUser,
      active: "records",
      message: resolveMessage(c),
      body: `
        <section class="page-hero">
          <div>
            <h1>提交记录</h1>
            <p>查看 AI 分析、审核状态、积分发放情况和拒绝原因。</p>
          </div>
          <a class="btn btn-secondary" href="/app/submissions/new">继续上传</a>
        </section>
        <section class="split-layout records-layout">
          <div class="panel">
            <div class="panel-head">
              <h2>我的提交</h2>
              <span>${submissions.length} 条</span>
            </div>
            <div class="stack">
              ${
                submissions.length
                  ? submissions
                      .map(
                        (submission) => `
                  <a class="submission-row ${selectedId === submission.id ? "selected" : ""}" href="/app/submissions?id=${submission.id}">
                    <img src="/submission-images/${submission.id}" alt="提交图片缩略图" />
                    <div class="submission-row-main">
                      <strong>${escapeHtml(truncate(submission.description, 46))}</strong>
                      <span>${statusBadge(submission.review_status)} · ${formatDate(submission.created_at)}</span>
                    </div>
                    <div class="submission-row-points">${submission.awarded_points ? `+${submission.awarded_points}` : "待定"}</div>
                  </a>
                `
                      )
                      .join("")
                  : `<p class="empty-state">暂无提交记录。</p>`
              }
            </div>
          </div>
          <div class="panel detail-panel">
            ${
              selected
                ? renderSubmissionDetail(selected)
                : `<div class="empty-state tall">请选择左侧的一条提交记录查看详情。</div>`
            }
          </div>
        </section>
      `
    })
  );
});

app.get("/app/rewards", async (c) => {
  const currentUser = requireMember(c);
  if (currentUser instanceof Response) return currentUser;

  const rewards = await listRewards(c.env.DB, 100);
  const exchanges = await listExchangeRequests(c.env.DB, currentUser.id);
  const selectedRewardId = c.req.query("reward") || rewards[0]?.id || null;
  const selectedReward = rewards.find((reward) => reward.id === selectedRewardId) || rewards[0] || null;

  return c.html(
    renderMemberShell({
      title: "积分兑换",
      currentUser,
      active: "rewards",
      message: resolveMessage(c),
      body: `
        <section class="page-hero">
          <div>
            <h1>积分兑换</h1>
            <p>查看兑换规则和可兑换奖励，并提交兑换申请。</p>
          </div>
        </section>
        <section class="split-layout">
          <div class="panel">
            <div class="panel-head">
              <h2>可兑换奖励</h2>
              <span>当前积分 ${currentUser.pointsBalance}</span>
            </div>
            <div class="reward-grid">
              ${rewards
                .map(
                  (reward) => `
                <article class="reward-card ${selectedReward?.id === reward.id ? "selected" : ""}">
                  <div class="reward-media">${rewardEmoji(reward.name)}</div>
                  <div class="reward-body">
                    <h3>${escapeHtml(reward.name)}</h3>
                    <p>${escapeHtml(reward.description)}</p>
                  </div>
                  <div class="reward-meta">
                    <span>${reward.points_cost} 积分</span>
                    <small>库存 ${reward.stock}</small>
                  </div>
                  <a class="btn btn-secondary" href="/app/rewards?reward=${reward.id}">选择奖励</a>
                </article>
              `
                )
                .join("")}
            </div>
          </div>
          <aside class="panel stack">
            <div class="panel-head">
              <h2>兑换规则</h2>
            </div>
            <ol class="rule-list">
              ${REWARD_RULES.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}
            </ol>
            ${
              selectedReward
                ? `
              <div class="info-card">
                <strong>当前选择</strong>
                <div class="reward-inline">
                  <span class="reward-inline-icon">${rewardEmoji(selectedReward.name)}</span>
                  <div>
                    <b>${escapeHtml(selectedReward.name)}</b>
                    <p>${selectedReward.points_cost} 积分 · 库存 ${selectedReward.stock}</p>
                  </div>
                </div>
              </div>
              <form class="stack" method="post" action="/app/rewards/redeem">
                <input type="hidden" name="rewardId" value="${selectedReward.id}" />
                <label class="field">
                  <span>联系方式</span>
                  <input name="contactInfo" placeholder="手机号 / 邮箱 / 学号" required />
                </label>
                <label class="field">
                  <span>备注（可选）</span>
                  <textarea name="note" rows="4" placeholder="例如：希望线下领取"></textarea>
                </label>
                <button class="btn btn-primary" type="submit">提交兑换申请</button>
              </form>
            `
                : `<p class="empty-state">当前没有可兑换奖励。</p>`
            }
          </aside>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>我的兑换申请</h2>
          </div>
          ${
            exchanges.length
              ? `
            <table class="table">
              <thead>
                <tr>
                  <th>奖励</th>
                  <th>积分</th>
                  <th>状态</th>
                  <th>提交时间</th>
                </tr>
              </thead>
              <tbody>
                ${exchanges
                  .map(
                    (exchange) => `
                  <tr>
                    <td>${escapeHtml(exchange.reward_name)}</td>
                    <td>${exchange.points_cost}</td>
                    <td>${statusBadge(exchange.status)}</td>
                    <td>${formatDate(exchange.created_at)}</td>
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>
          `
              : `<p class="empty-state">还没有兑换申请。</p>`
          }
        </section>
      `
    })
  );
});

app.post("/app/rewards/redeem", async (c) => {
  const currentUser = requireMember(c);
  if (currentUser instanceof Response) return currentUser;

  const form = await c.req.formData();
  const rewardId = toCleanString(form.get("rewardId"));
  const contactInfo = toCleanString(form.get("contactInfo"));
  const note = toCleanString(form.get("note"));

  if (!rewardId || !contactInfo) {
    return redirectWithMessage(c, "/app/rewards", "error", "请先选择奖励并填写联系方式。");
  }

  const reward = await c.env.DB.prepare(
    "SELECT id, name, description, points_cost, stock, active FROM rewards WHERE id = ? LIMIT 1"
  )
    .bind(rewardId)
    .first<RewardRow>();
  if (!reward || reward.active !== 1) {
    return redirectWithMessage(c, "/app/rewards", "error", "奖励不存在或已下架。");
  }
  if (reward.stock <= 0) {
    return redirectWithMessage(c, "/app/rewards", "error", "该奖励库存不足。");
  }

  const latestUser = await c.env.DB.prepare("SELECT points_balance FROM users WHERE id = ? LIMIT 1")
    .bind(currentUser.id)
    .first<{ points_balance: number }>();
  const balance = latestUser?.points_balance ?? currentUser.pointsBalance;
  if (balance < reward.points_cost) {
    return redirectWithMessage(c, "/app/rewards", "error", "当前积分不足，无法提交兑换申请。");
  }

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET points_balance = points_balance - ? WHERE id = ?").bind(reward.points_cost, currentUser.id),
    c.env.DB.prepare("UPDATE rewards SET stock = stock - 1 WHERE id = ? AND stock > 0").bind(reward.id),
    c.env.DB.prepare(
      `INSERT INTO exchange_requests (id, user_id, reward_id, reward_name, points_cost, contact_info, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?)`
    ).bind(generateId("ex_"), currentUser.id, reward.id, reward.name, reward.points_cost, contactInfo, note || null, now),
    c.env.DB.prepare(
      "INSERT INTO points_ledger (id, user_id, submission_id, delta, reason, created_at) VALUES (?, ?, NULL, ?, ?, ?)"
    ).bind(generateId("ledger_"), currentUser.id, -reward.points_cost, `兑换申请：${reward.name}`, now)
  ]);

  return redirectWithMessage(c, `/app/rewards?reward=${reward.id}`, "success", "兑换申请已提交，积分已冻结。");
});

app.get("/app/leaderboard", async (c) => {
  const currentUser = requireMember(c);
  if (currentUser instanceof Response) return currentUser;

  const month = normalizeMonthKey(c.req.query("month")) || currentMonthKey();
  const rows = await getLeaderboard(c.env.DB, month);
  const currentRank = rows.findIndex((row) => row.user_id === currentUser.id) + 1 || null;

  return c.html(
    renderMemberShell({
      title: "每月排行榜",
      currentUser,
      active: "leaderboard",
      message: resolveMessage(c),
      body: `
        <section class="page-hero">
          <div>
            <h1>每月排行榜</h1>
            <p>展示本月通过审核后累计获得的公益积分。P0 只保留月榜，不扩展总榜和排名变化图。</p>
          </div>
          <form class="month-picker" method="get" action="/app/leaderboard">
            <input type="month" name="month" value="${month}" />
            <button class="btn btn-secondary" type="submit">切换月份</button>
          </form>
        </section>
        <section class="card-grid cards-3">
          <article class="metric-card">
            <span>当前月份</span>
            <strong>${month}</strong>
          </article>
          <article class="metric-card">
            <span>我的排名</span>
            <strong>${currentRank || "--"}</strong>
          </article>
          <article class="metric-card">
            <span>我的本月积分</span>
            <strong>${rows.find((row) => row.user_id === currentUser.id)?.month_points || 0}</strong>
          </article>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>月榜 Top 10</h2>
          </div>
          ${
            rows.length
              ? `
            <table class="table">
              <thead>
                <tr>
                  <th>排名</th>
                  <th>成员</th>
                  <th>社团</th>
                  <th>公益积分</th>
                  <th>通过次数</th>
                </tr>
              </thead>
              <tbody>
                ${rows
                  .slice(0, 10)
                  .map(
                    (row, index) => `
                  <tr class="${row.user_id === currentUser.id ? "highlight-row" : ""}">
                    <td>#${index + 1}</td>
                    <td>${escapeHtml(row.display_name)}</td>
                    <td>${escapeHtml(row.club_name || "未填写")}</td>
                    <td>${row.month_points}</td>
                    <td>${row.approved_count}</td>
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>
          `
              : `<p class="empty-state">该月份暂无积分记录。</p>`
          }
        </section>
      `
    })
  );
});

app.get("/admin/reviews", async (c) => {
  const currentUser = requireAdmin(c);
  if (currentUser instanceof Response) return currentUser;

  const pendingRows = await listPendingSubmissions(c.env.DB);
  const selectedId = c.req.query("id") || pendingRows[0]?.id || null;
  const selected = selectedId ? await getSubmissionDetail(c.env.DB, selectedId) : null;

  const counters = await c.env.DB.prepare(
    `SELECT
      SUM(CASE WHEN review_status IN ('manual_review', 'ai_failed') THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
      SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count
    FROM submissions`
  ).first<{ pending_count: number | null; approved_count: number | null; rejected_count: number | null }>();

  return c.html(
    renderAdminShell({
      title: "管理员审核台",
      currentUser,
      active: "reviews",
      message: resolveMessage(c),
      body: `
        <section class="page-hero">
          <div>
            <h1>管理员审核台</h1>
            <p>处理 AI 低置信度、隐私风险、模糊、疑似网图、疑似重复或 AI 调用失败的提交。</p>
          </div>
        </section>
        <section class="card-grid cards-3">
          <article class="metric-card">
            <span>待审核</span>
            <strong>${counters?.pending_count ?? 0}</strong>
          </article>
          <article class="metric-card">
            <span>人工通过</span>
            <strong>${counters?.approved_count ?? 0}</strong>
          </article>
          <article class="metric-card">
            <span>已拒绝</span>
            <strong>${counters?.rejected_count ?? 0}</strong>
          </article>
        </section>
        <section class="split-layout records-layout">
          <div class="panel">
            <div class="panel-head">
              <h2>待审核队列</h2>
              <span>${pendingRows.length} 条</span>
            </div>
            <div class="stack">
              ${
                pendingRows.length
                  ? pendingRows
                      .map(
                        (submission) => `
                  <a class="submission-row ${selectedId === submission.id ? "selected" : ""}" href="/admin/reviews?id=${submission.id}">
                    <img src="/submission-images/${submission.id}" alt="待审核图片缩略图" />
                    <div class="submission-row-main">
                      <strong>${escapeHtml(truncate(submission.description, 40))}</strong>
                      <span>${statusBadge(submission.review_status)} · ${formatDate(submission.created_at)}</span>
                    </div>
                  </a>
                `
                      )
                      .join("")
                  : `<p class="empty-state">当前没有需要人工处理的提交。</p>`
              }
            </div>
          </div>
          <div class="panel detail-panel">
            ${
              selected
                ? renderAdminReviewDetail(selected)
                : `<div class="empty-state tall">当前没有待审核内容。</div>`
            }
          </div>
        </section>
      `
    })
  );
});

app.post("/admin/reviews/:id/approve", async (c) => {
  const currentUser = requireAdmin(c);
  if (currentUser instanceof Response) return currentUser;

  const submissionId = c.req.param("id");
  const form = await c.req.formData();
  const reviewNote = toCleanString(form.get("reviewNote"));
  const awardedPoints = clampInteger(Number.parseInt(toCleanString(form.get("awardedPoints")) || "0", 10), 0, 50);

  const submission = await getSubmissionDetail(c.env.DB, submissionId);
  if (!submission) {
    return redirectWithMessage(c, "/admin/reviews", "error", "提交记录不存在。");
  }
  if (!["manual_review", "ai_failed"].includes(submission.review_status)) {
    return redirectWithMessage(c, `/admin/reviews?id=${submission.id}`, "error", "该记录当前不能执行通过操作。");
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE submissions
       SET review_status = 'approved',
           awarded_points = ?,
           reviewed_by = ?,
           review_note = ?,
           reviewed_at = ?
       WHERE id = ?`
    ).bind(awardedPoints, currentUser.id, reviewNote || null, now, submission.id)
  ];

  if (awardedPoints > 0) {
    statements.push(
      c.env.DB.prepare("UPDATE users SET points_balance = points_balance + ? WHERE id = ?").bind(awardedPoints, submission.user_id),
      c.env.DB.prepare(
        "INSERT INTO points_ledger (id, user_id, submission_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(generateId("ledger_"), submission.user_id, submission.id, awardedPoints, "管理员通过", now)
    );
  }

  await c.env.DB.batch(statements);
  return redirectWithMessage(c, "/admin/reviews", "success", "提交已通过，积分已发放。");
});

app.post("/admin/reviews/:id/reject", async (c) => {
  const currentUser = requireAdmin(c);
  if (currentUser instanceof Response) return currentUser;

  const submissionId = c.req.param("id");
  const form = await c.req.formData();
  const rejectionReason = toCleanString(form.get("rejectionReason"));

  if (!rejectionReason) {
    return redirectWithMessage(c, `/admin/reviews?id=${submissionId}`, "error", "请填写拒绝原因。");
  }

  const submission = await getSubmissionDetail(c.env.DB, submissionId);
  if (!submission) {
    return redirectWithMessage(c, "/admin/reviews", "error", "提交记录不存在。");
  }

  await c.env.DB.prepare(
    `UPDATE submissions
     SET review_status = 'rejected',
         rejection_reason = ?,
         reviewed_by = ?,
         reviewed_at = ?
     WHERE id = ?`
  )
    .bind(rejectionReason, currentUser.id, Date.now(), submission.id)
    .run();

  return redirectWithMessage(c, "/admin/reviews", "success", "提交已拒绝。");
});

app.get("/submission-images/:id", async (c) => {
  const currentUser = c.get("currentUser");
  if (!currentUser) {
    return c.text("Unauthorized", 401);
  }

  const row = await c.env.DB.prepare(
    "SELECT id, user_id, image_blob, image_mime FROM submissions WHERE id = ? LIMIT 1"
  )
    .bind(c.req.param("id"))
    .first<{ id: string; user_id: string; image_blob: ArrayBuffer; image_mime: string }>();

  if (!row) {
    return c.text("Not found", 404);
  }
  if (currentUser.role !== "admin" && row.user_id !== currentUser.id) {
    return c.text("Forbidden", 403);
  }

  return new Response(row.image_blob, {
    headers: {
      "Content-Type": row.image_mime,
      "Cache-Control": "private, max-age=300"
    }
  });
});

app.notFound((c) => c.html(renderSimpleError("页面不存在", "请求的页面不存在。", c.get("currentUser"))));
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
  const adminAccount = env.ADMIN_BOOTSTRAP_USERNAME || "admin";
  const adminPassword = env.ADMIN_BOOTSTRAP_PASSWORD || "Admin@123456";
  const now = Date.now();

  const existingAdmin = await env.DB.prepare("SELECT id FROM users WHERE lower(account) = lower(?) LIMIT 1")
    .bind(adminAccount)
    .first();
  if (!existingAdmin) {
    const salt = generateId("salt_");
    const hash = await hashPassword(adminPassword, salt);
    await env.DB.prepare(
      `INSERT INTO users (id, account, role, club_name, display_name, password_salt, password_hash, points_balance, created_at)
       VALUES (?, ?, 'admin', '平台管理', '管理员', ?, ?, 0, ?)`
    )
      .bind(generateId("user_"), adminAccount, salt, hash, now)
      .run();
  }

  for (const reward of REWARD_SEEDS) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO rewards (id, name, description, points_cost, stock, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(reward.id, reward.name, reward.description, reward.points_cost, reward.stock, reward.active, now)
      .run();
  }
}

async function getCurrentUser(db: D1Database, sessionId: string): Promise<CurrentUser | null> {
  const row = await db.prepare(
    `SELECT users.id, users.account, users.role, users.club_name, users.display_name, users.points_balance
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ? AND sessions.expires_at > ?
     LIMIT 1`
  )
    .bind(sessionId, Date.now())
    .first<{
      id: string;
      account: string;
      role: "member" | "admin";
      club_name: string | null;
      display_name: string | null;
      points_balance: number;
    }>();

  return row ? toCurrentUser(row) : null;
}

function toCurrentUser(row: {
  id: string;
  account: string;
  role: "member" | "admin";
  club_name: string | null;
  display_name: string | null;
  points_balance: number;
}): CurrentUser {
  return {
    id: row.id,
    account: row.account,
    role: row.role,
    clubName: row.club_name,
    displayName: row.display_name || deriveDisplayName(row.account),
    pointsBalance: row.points_balance
  };
}

function requireMember(c: AppContext): CurrentUser | Response {
  const currentUser = c.get("currentUser");
  if (!currentUser) {
    return c.redirect("/login");
  }
  if (currentUser.role !== "member") {
    return c.redirect("/admin/reviews");
  }
  return currentUser;
}

function requireAdmin(c: AppContext): CurrentUser | Response {
  const currentUser = c.get("currentUser");
  if (!currentUser) {
    return c.redirect("/login?role=admin");
  }
  if (currentUser.role !== "admin") {
    return c.redirect("/app");
  }
  return currentUser;
}

async function getDashboardSummary(db: D1Database, userId: string): Promise<DashboardSummary> {
  const [start, end] = monthRange(currentMonthKey());
  const row = await db.prepare(
    `SELECT
      SUM(CASE WHEN review_status IN ('manual_review', 'analyzing', 'ai_failed') THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN review_status IN ('auto_approved', 'approved') THEN 1 ELSE 0 END) AS approved_count,
      (
        SELECT COALESCE(SUM(delta), 0)
        FROM points_ledger
        WHERE user_id = ? AND created_at >= ? AND created_at < ? AND delta > 0
      ) AS this_month_points
     FROM submissions
     WHERE user_id = ?`
  )
    .bind(userId, start, end, userId)
    .first<{ pending_count: number | null; approved_count: number | null; this_month_points: number | null }>();

  return {
    pendingCount: row?.pending_count ?? 0,
    approvedCount: row?.approved_count ?? 0,
    thisMonthPoints: row?.this_month_points ?? 0
  };
}

async function listUserSubmissions(db: D1Database, userId: string, limit: number): Promise<SubmissionListRow[]> {
  const result = await db.prepare(
    `SELECT
      id, description, welfare_type, confidence, suggested_points, review_reason,
      privacy_risk, blur_risk, web_image_risk, duplicate_risk,
      ai_status, review_status, rejection_reason, awarded_points,
      created_at, analyzed_at, reviewed_at
     FROM submissions
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(userId, limit)
    .all<SubmissionListRow>();
  return result.results;
}

async function getSubmissionDetail(db: D1Database, submissionId: string, ownerId?: string): Promise<SubmissionDetail | null> {
  const whereOwner = ownerId ? "AND submissions.user_id = ?" : "";
  const row = await db.prepare(
    `SELECT
      submissions.id,
      submissions.user_id,
      submissions.description,
      submissions.image_mime,
      submissions.welfare_type,
      submissions.confidence,
      submissions.suggested_points,
      submissions.review_reason,
      submissions.privacy_risk,
      submissions.blur_risk,
      submissions.web_image_risk,
      submissions.duplicate_risk,
      submissions.ai_status,
      submissions.review_status,
      submissions.rejection_reason,
      submissions.awarded_points,
      submissions.created_at,
      submissions.analyzed_at,
      submissions.reviewed_at,
      submissions.review_note,
      submissions.ai_raw_response,
      users.club_name,
      users.display_name,
      users.account
     FROM submissions
     JOIN users ON users.id = submissions.user_id
     WHERE submissions.id = ?
     ${whereOwner}
     LIMIT 1`
  )
    .bind(...(ownerId ? [submissionId, ownerId] : [submissionId]))
    .first<SubmissionDetail>();

  return row || null;
}

async function listRewards(db: D1Database, limit: number): Promise<RewardRow[]> {
  const result = await db.prepare(
    "SELECT id, name, description, points_cost, stock, active FROM rewards WHERE active = 1 ORDER BY points_cost ASC LIMIT ?"
  )
    .bind(limit)
    .all<RewardRow>();
  return result.results;
}

async function listExchangeRequests(db: D1Database, userId: string): Promise<ExchangeRow[]> {
  const result = await db.prepare(
    `SELECT id, reward_name, points_cost, contact_info, note, status, created_at
     FROM exchange_requests
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 20`
  )
    .bind(userId)
    .all<ExchangeRow>();
  return result.results;
}

async function listPendingSubmissions(db: D1Database): Promise<SubmissionListRow[]> {
  const result = await db.prepare(
    `SELECT
      id, description, welfare_type, confidence, suggested_points, review_reason,
      privacy_risk, blur_risk, web_image_risk, duplicate_risk,
      ai_status, review_status, rejection_reason, awarded_points,
      created_at, analyzed_at, reviewed_at
     FROM submissions
     WHERE review_status IN ('manual_review', 'ai_failed')
     ORDER BY created_at DESC
     LIMIT 50`
  ).all<SubmissionListRow>();
  return result.results;
}

async function getLeaderboard(db: D1Database, month: string): Promise<LeaderboardRow[]> {
  const [start, end] = monthRange(month);
  const result = await db.prepare(
    `SELECT
      users.id AS user_id,
      COALESCE(users.display_name, users.account) AS display_name,
      users.club_name AS club_name,
      COALESCE(SUM(CASE WHEN points_ledger.delta > 0 THEN points_ledger.delta ELSE 0 END), 0) AS month_points,
      COALESCE(COUNT(DISTINCT CASE WHEN submissions.review_status IN ('auto_approved', 'approved') THEN submissions.id END), 0) AS approved_count
     FROM users
     LEFT JOIN points_ledger ON points_ledger.user_id = users.id AND points_ledger.created_at >= ? AND points_ledger.created_at < ?
     LEFT JOIN submissions ON submissions.user_id = users.id AND submissions.reviewed_at >= ? AND submissions.reviewed_at < ? AND submissions.review_status IN ('auto_approved', 'approved')
     WHERE users.role = 'member'
     GROUP BY users.id
     HAVING month_points > 0
     ORDER BY month_points DESC, approved_count DESC, display_name ASC`
  )
    .bind(start, end, start, end)
    .all<LeaderboardRow>();
  return result.results;
}

async function analyzeImage(
  env: Bindings,
  input: {
    description: string;
    imageMime: string;
    imageBuffer: Uint8Array;
    duplicateDetected: boolean;
  }
): Promise<AIResult> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 未配置");
  }

  const response = await fetch(`${(env.OPENAI_BASE_URL || "https://api.jzib.club/v1").replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.4",
      temperature: 0.1,
      max_tokens: 900,
      messages: [
        {
          role: "system",
          content:
            "你是《JZIB 公益积分站》的图像审核助手。必须只输出 JSON，不要 Markdown，不要解释，不要额外文字。"
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "请根据上传图片和活动说明，判断这是否像真实公益现场，并输出严格 JSON。",
                "你必须尽量保守，只根据图中可见信息和用户说明做判断，不要编造看不见的细节。",
                "字段要求：",
                `{
  "welfare_type": "公益类型，中文短语",
  "confidence": 0 到 1 之间的小数，
  "suggested_points": 0 到 30 之间的整数，
  "review_reason": "简短审核理由",
  "privacy_risk": true 或 false,
  "blur_risk": true 或 false,
  "web_image_risk": true 或 false,
  "duplicate_risk": true 或 false,
  "manual_review": true 或 false,
  "risk_tags": ["中文风险标签数组"]
}`,
                "只要你不确定、图片模糊、像海报截图、含隐私信息、无法确认是公益现场，就把 manual_review 设为 true。",
                "只有在画面明显像海报、网页截图、水印图、宣传物料、拼贴图、精修广告图时，才把 web_image_risk 设为 true；不要因为画面清晰或光线好就误判为网图。",
                `本地精确重复检测结果：${input.duplicateDetected ? "已经命中重复图片哈希，请将 duplicate_risk 设为 true 且 manual_review 设为 true。" : "没有命中精确重复哈希，请将 duplicate_risk 设为 false。"} `,
                `活动说明：${input.description}`
              ].join("\n")
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${input.imageMime};base64,${Buffer.from(input.imageBuffer).toString("base64")}`
              }
            }
          ]
        }
      ]
    })
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`AI 接口返回 ${response.status}：${truncate(responseText, 400)}`);
  }

  let rawContent = "";
  try {
    const payload = JSON.parse(responseText) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    rawContent = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text || "").join("") : "";
  } catch {
    rawContent = responseText;
  }

  const parsed = parseJsonObject(rawContent);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`AI 返回不是有效 JSON：${truncate(rawContent || responseText, 240)}`);
  }

  const confidence = clampNumber(Number(parsed.confidence), 0, 1);
  const suggestedPoints = clampInteger(Number(parsed.suggested_points), 0, 30);
  const welfareType = sanitizeText(parsed.welfare_type) || "待人工判断";
  const reviewReason = sanitizeText(parsed.review_reason) || "模型未提供明确理由";
  const privacyRisk = Boolean(parsed.privacy_risk);
  const blurRisk = Boolean(parsed.blur_risk);
  const webImageRisk = Boolean(parsed.web_image_risk);
  const duplicateRisk = input.duplicateDetected;
  const manualReviewByAI = Boolean(parsed.manual_review);
  const riskTags = Array.isArray(parsed.risk_tags)
    ? parsed.risk_tags.map((item) => sanitizeText(item)).filter(Boolean)
    : [];

  return {
    welfareType,
    confidence,
    suggestedPoints,
    reviewReason,
    privacyRisk,
    blurRisk,
    webImageRisk,
    duplicateRisk,
    manualReviewByAI,
    riskTags,
    rawResponse: rawContent || responseText
  };
}

function renderGuestPage(input: {
  title: string;
  active: "login" | "register";
  roleMode: "member" | "admin";
  message: string;
  body: string;
}): string {
  return renderDocument(
    input.title,
    `
      <div class="guest-shell">
        <header class="guest-header">
          <a class="brand" href="/login">JZIB 公益积分站</a>
          <nav>
            <a class="${input.active === "login" ? "active" : ""}" href="/login">登录</a>
            <a class="${input.active === "register" ? "active" : ""}" href="/register">注册</a>
          </nav>
        </header>
        ${input.message}
        ${input.body}
      </div>
    `
  );
}

function renderMemberShell(input: {
  title: string;
  currentUser: CurrentUser;
  active: "dashboard" | "submit" | "records" | "rewards" | "leaderboard";
  message: string;
  body: string;
}): string {
  return renderDocument(
    input.title,
    `
      <div class="app-shell">
        <aside class="sidebar">
          <a class="brand" href="/app">JZIB<br />公益积分站</a>
          <nav class="nav-list">
            ${memberNavLink("dashboard", "用户首页", "/app", input.active)}
            ${memberNavLink("submit", "图片提交", "/app/submissions/new", input.active)}
            ${memberNavLink("records", "提交记录", "/app/submissions", input.active)}
            ${memberNavLink("rewards", "积分兑换", "/app/rewards", input.active)}
            ${memberNavLink("leaderboard", "每月排行榜", "/app/leaderboard", input.active)}
          </nav>
          <div class="sidebar-card">
            <strong>${escapeHtml(input.currentUser.displayName)}</strong>
            <span>${escapeHtml(input.currentUser.clubName || "未填写社团")}</span>
            <b>${input.currentUser.pointsBalance} 积分</b>
          </div>
        </aside>
        <main class="main-shell">
          <header class="topbar">
            <div>
              <strong>${escapeHtml(input.currentUser.displayName)}</strong>
              <span>${escapeHtml(input.currentUser.account)}</span>
            </div>
            <form method="post" action="/logout">
              <button class="btn btn-ghost" type="submit">退出登录</button>
            </form>
          </header>
          ${input.message}
          ${input.body}
        </main>
      </div>
    `
  );
}

function renderAdminShell(input: {
  title: string;
  currentUser: CurrentUser;
  active: "reviews";
  message: string;
  body: string;
}): string {
  return renderDocument(
    input.title,
    `
      <div class="app-shell admin-shell">
        <aside class="sidebar dark">
          <a class="brand" href="/admin/reviews">公益审核平台</a>
          <nav class="nav-list">
            <a class="nav-link ${input.active === "reviews" ? "active" : ""}" href="/admin/reviews">审核管理</a>
          </nav>
          <div class="sidebar-card dark-card">
            <strong>${escapeHtml(input.currentUser.displayName)}</strong>
            <span>${escapeHtml(input.currentUser.account)}</span>
          </div>
        </aside>
        <main class="main-shell">
          <header class="topbar">
            <div>
              <strong>管理员审核台</strong>
              <span>处理需要人工介入的公益提交</span>
            </div>
            <div class="topbar-actions">
              <a class="btn btn-secondary" href="/app">成员视图</a>
              <form method="post" action="/logout">
                <button class="btn btn-ghost" type="submit">退出登录</button>
              </form>
            </div>
          </header>
          ${input.message}
          ${input.body}
        </main>
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
      <title>${escapeHtml(title)} - JZIB 公益积分站</title>
      <style>${styles()}</style>
    </head>
    <body>${body}</body>
  </html>`;
}

function renderSubmissionDetail(submission: SubmissionDetail): string {
  const aiSection =
    submission.ai_status === "completed"
      ? `
      <div class="detail-grid">
        <div class="detail-card">
          <span>公益类型</span>
          <strong>${escapeHtml(submission.welfare_type || "未识别")}</strong>
        </div>
        <div class="detail-card">
          <span>置信度</span>
          <strong>${submission.confidence !== null ? `${Math.round(submission.confidence * 100)}%` : "--"}</strong>
        </div>
        <div class="detail-card">
          <span>建议积分</span>
          <strong>${submission.suggested_points ?? "--"}</strong>
        </div>
        <div class="detail-card">
          <span>审核状态</span>
          <strong>${statusText(submission.review_status)}</strong>
        </div>
      </div>
      <div class="info-card">
        <strong>审核理由</strong>
        <p>${escapeHtml(submission.review_reason || "暂无")}</p>
      </div>
      ${renderRiskBadges(submission)}
    `
      : `
      <div class="warning-box">
        <strong>${submission.ai_status === "failed" ? "AI 分析失败" : "AI 分析中"}</strong>
        <p>${escapeHtml(submission.review_reason || "系统未能产出有效 AI 结果，这条提交会保持失败状态或等待人工处理。")}</p>
      </div>
    `;

  return `
    <div class="panel-head">
      <h2>记录详情</h2>
      <span>${statusBadge(submission.review_status)}</span>
    </div>
    <img class="detail-image" src="/submission-images/${submission.id}" alt="提交现场图片" />
    <div class="info-card">
      <strong>活动说明</strong>
      <p>${escapeHtml(submission.description)}</p>
    </div>
    ${aiSection}
    ${
      submission.rejection_reason
        ? `<div class="error-box"><strong>拒绝原因</strong><p>${escapeHtml(submission.rejection_reason)}</p></div>`
        : ""
    }
    <div class="detail-meta">
      <span>提交时间：${formatDate(submission.created_at)}</span>
      <span>发放积分：${submission.awarded_points}</span>
      <span>审核完成：${submission.reviewed_at ? formatDate(submission.reviewed_at) : "待处理"}</span>
    </div>
  `;
}

function renderAdminReviewDetail(submission: SubmissionDetail): string {
  return `
    <div class="panel-head">
      <h2>证据材料预览</h2>
      <span>${statusBadge(submission.review_status)}</span>
    </div>
    <img class="detail-image" src="/submission-images/${submission.id}" alt="提交现场图片" />
    <div class="detail-grid">
      <div class="detail-card"><span>成员</span><strong>${escapeHtml(submission.display_name)}</strong></div>
      <div class="detail-card"><span>社团</span><strong>${escapeHtml(submission.club_name || "未填写")}</strong></div>
      <div class="detail-card"><span>提交时间</span><strong>${formatDate(submission.created_at)}</strong></div>
      <div class="detail-card"><span>账号</span><strong>${escapeHtml(submission.account)}</strong></div>
    </div>
    <div class="info-card">
      <strong>活动说明</strong>
      <p>${escapeHtml(submission.description)}</p>
    </div>
    ${
      submission.ai_status === "completed"
        ? `
      <div class="detail-grid">
        <div class="detail-card"><span>公益类型</span><strong>${escapeHtml(submission.welfare_type || "未识别")}</strong></div>
        <div class="detail-card"><span>置信度</span><strong>${submission.confidence !== null ? `${Math.round(submission.confidence * 100)}%` : "--"}</strong></div>
        <div class="detail-card"><span>建议积分</span><strong>${submission.suggested_points ?? 0}</strong></div>
        <div class="detail-card"><span>AI 状态</span><strong>${statusText(submission.ai_status)}</strong></div>
      </div>
      <div class="info-card">
        <strong>审核理由</strong>
        <p>${escapeHtml(submission.review_reason || "暂无")}</p>
      </div>
      ${renderRiskBadges(submission)}
    `
        : `
      <div class="warning-box">
        <strong>AI 分析失败</strong>
        <p>${escapeHtml(submission.review_reason || "没有得到 AI 分析结果，请管理员根据现场图片和文字说明人工处理。")}</p>
      </div>
    `
    }
    <div class="split-layout no-gap">
      <form class="panel subtle-panel stack" method="post" action="/admin/reviews/${submission.id}/approve">
        <h3>通过</h3>
        <label class="field">
          <span>发放积分</span>
          <input type="number" name="awardedPoints" min="0" max="50" value="${submission.suggested_points ?? 10}" required />
        </label>
        <label class="field">
          <span>备注（可选）</span>
          <textarea name="reviewNote" rows="4" placeholder="例如：人工确认是现场活动，可发放积分。"></textarea>
        </label>
        <button class="btn btn-primary" type="submit">通过并发积分</button>
      </form>
      <form class="panel subtle-panel stack" method="post" action="/admin/reviews/${submission.id}/reject">
        <h3>拒绝</h3>
        <label class="field">
          <span>拒绝原因</span>
          <textarea name="rejectionReason" rows="6" placeholder="例如：图片过于模糊，无法确认是公益现场；建议重新提交更清晰图片。" required></textarea>
        </label>
        <button class="btn btn-danger" type="submit">拒绝该提交</button>
      </form>
    </div>
  `;
}

function renderRiskBadges(submission: SubmissionDetail | SubmissionListRow): string {
  const risks = [
    submission.privacy_risk ? "隐私风险" : "",
    submission.blur_risk ? "图片模糊" : "",
    submission.web_image_risk ? "疑似网图" : "",
    submission.duplicate_risk ? "疑似重复" : ""
  ].filter(Boolean);
  if (!risks.length) {
    return `<div class="risk-row"><span class="tag success">未发现高风险标签</span></div>`;
  }
  return `<div class="risk-row">${risks.map((risk) => `<span class="tag warning">${escapeHtml(risk)}</span>`).join("")}</div>`;
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

function renderSimpleError(title: string, message: string, currentUser: CurrentUser | null): string {
  const backLink = currentUser ? homePathFor(currentUser) : "/login";
  return renderDocument(
    title,
    `<div class="guest-shell"><section class="hero-card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="btn btn-primary" href="${backLink}">返回</a></section></div>`
  );
}

function memberNavLink(
  key: "dashboard" | "submit" | "records" | "rewards" | "leaderboard",
  label: string,
  href: string,
  active: "dashboard" | "submit" | "records" | "rewards" | "leaderboard"
): string {
  return `<a class="nav-link ${key === active ? "active" : ""}" href="${href}">${label}</a>`;
}

function homePathFor(currentUser: CurrentUser): string {
  return currentUser.role === "admin" ? "/admin/reviews" : "/app";
}

function statusText(status: string): string {
  switch (status) {
    case "analyzing":
      return "AI 分析中";
    case "auto_approved":
      return "自动通过";
    case "manual_review":
      return "待人工审核";
    case "approved":
      return "人工通过";
    case "rejected":
      return "已拒绝";
    case "ai_failed":
      return "AI 分析失败";
    case "completed":
      return "AI 已完成";
    case "failed":
      return "AI 失败";
    case "submitted":
      return "已提交";
    case "fulfilled":
      return "已完成";
    default:
      return status;
  }
}

function statusBadge(status: string): string {
  const tone =
    status === "auto_approved" || status === "approved" || status === "fulfilled"
      ? "success"
      : status === "rejected" || status === "failed"
        ? "danger"
        : status === "manual_review" || status === "ai_failed"
          ? "warning"
          : "neutral";
  return `<span class="tag ${tone}">${escapeHtml(statusText(status))}</span>`;
}

function rewardEmoji(name: string): string {
  if (name.includes("笔记")) return "📓";
  if (name.includes("饮品")) return "☕";
  if (name.includes("文具")) return "✏️";
  if (name.includes("接驳")) return "🚌";
  if (name.includes("自习")) return "📚";
  if (name.includes("体育")) return "🏀";
  return "🎁";
}

function normalizeMonthKey(value: string | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}$/.test(value) ? value : null;
}

function currentMonthKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

function monthRange(monthKey: string): [number, number] {
  const [yearText, monthText] = monthKey.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0)).getTime();
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0)).getTime();
  return [start, end];
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

function toCleanString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function deriveDisplayName(account: string): string {
  if (!account) return "公益成员";
  const clean = account.replace(/\s+/g, "");
  return clean.length <= 8 ? clean : `${clean.slice(0, 4)}…${clean.slice(-2)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseJsonObject(raw: string): Record<string, any> | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${password}`));
  return Buffer.from(digest).toString("hex");
}

async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  return (await hashPassword(password, salt)) === expectedHash;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const normalized = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", normalized);
  return Buffer.from(digest).toString("hex");
}

function generateId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sanitizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redirectWithMessage(c: AppContext, path: string, tone: "success" | "error", message: string): Response {
  const glue = path.includes("?") ? "&" : "?";
  return c.redirect(new URL(`${path}${glue}${tone}=${encodeURIComponent(message)}`, c.req.url).toString(), 302);
}

function uploadPageScript(): string {
  return `
    const input = document.getElementById("imageInput");
    const preview = document.getElementById("upload-preview");
    const placeholder = document.getElementById("upload-placeholder");
    const meta = document.getElementById("upload-meta");
    const form = document.getElementById("upload-form");

    async function compressImage(file) {
      const bitmap = await createImageBitmap(file);
      const maxEdge = 1600;
      let width = bitmap.width;
      let height = bitmap.height;
      if (Math.max(width, height) > maxEdge) {
        const scale = maxEdge / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, width, height);

      let quality = 0.9;
      let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      while (blob && blob.size > ${MAX_UPLOAD_BYTES} && quality > 0.45) {
        quality -= 0.1;
        blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      }

      if (!blob) {
        throw new Error("浏览器无法压缩该图片");
      }
      return new File([blob], file.name.replace(/\\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
    }

    input?.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      meta.textContent = "正在压缩图片…";
      try {
        const compressed = await compressImage(file);
        const dt = new DataTransfer();
        dt.items.add(compressed);
        input.files = dt.files;
        const url = URL.createObjectURL(compressed);
        preview.innerHTML = '<img src="' + url + '" alt="上传预览" />';
        preview.classList.remove("hidden");
        placeholder.classList.add("hidden");
        meta.textContent = "压缩后大小：" + Math.round(compressed.size / 1024) + "KB";
      } catch (error) {
        meta.textContent = error instanceof Error ? error.message : "图片压缩失败";
      }
    });

    form?.addEventListener("submit", () => {
      const file = input.files?.[0];
      if (file) {
        meta.textContent = "正在上传并触发 AI 分析…";
      }
    });
  `;
}

function styles(): string {
  return `
    :root {
      --bg: #f5f1e7;
      --panel: rgba(255,255,255,0.94);
      --panel-soft: rgba(255,255,255,0.75);
      --green: #0e7c4f;
      --green-dark: #08563a;
      --green-soft: #dff5ea;
      --slate: #1f2937;
      --slate-soft: #6b7280;
      --amber: #f59e0b;
      --red: #dc2626;
      --red-soft: #fee2e2;
      --line: rgba(15, 23, 42, 0.08);
      --shadow: 0 24px 60px rgba(31, 41, 55, 0.08);
      --radius: 24px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: var(--slate);
      background:
        radial-gradient(circle at top left, rgba(22, 163, 74, 0.08), transparent 35%),
        radial-gradient(circle at top right, rgba(245, 158, 11, 0.08), transparent 30%),
        linear-gradient(180deg, #f9f6ef 0%, #f2ecdf 100%);
      min-height: 100vh;
    }
    a { color: inherit; text-decoration: none; }
    .guest-shell { max-width: 1280px; margin: 0 auto; padding: 32px; }
    .guest-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }
    .guest-header nav { display: flex; gap: 12px; }
    .guest-header nav a,
    .tab,
    .btn,
    .nav-link {
      transition: 160ms ease;
    }
    .guest-header nav a {
      padding: 10px 16px;
      border-radius: 999px;
      color: var(--slate-soft);
    }
    .guest-header nav a.active { background: var(--green-soft); color: var(--green-dark); }
    .brand {
      font-weight: 800;
      font-size: 30px;
      line-height: 1.05;
      color: var(--green-dark);
      letter-spacing: -0.04em;
    }
    .hero-card,
    .panel,
    .metric-card,
    .reward-card,
    .message,
    .sidebar-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .hero-card { padding: 28px; }
    .auth-hero {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(360px, 420px);
      gap: 28px;
      align-items: start;
    }
    .hero-copy h1,
    .page-hero h1 {
      margin: 0 0 12px;
      font-size: clamp(34px, 4vw, 58px);
      line-height: 1.02;
      letter-spacing: -0.04em;
    }
    .hero-copy p,
    .page-hero p,
    .helper-text,
    .empty-state,
    .detail-meta,
    .info-card p,
    .warning-box p,
    .error-box p {
      color: var(--slate-soft);
      line-height: 1.7;
    }
    .eyebrow {
      display: inline-flex;
      padding: 8px 14px;
      border-radius: 999px;
      background: rgba(245, 158, 11, 0.14);
      color: #9a5b00;
      margin-bottom: 20px;
      font-weight: 700;
    }
    .feature-list {
      margin: 20px 0 0;
      padding-left: 18px;
      display: grid;
      gap: 8px;
    }
    .feature-list.compact { margin-top: 10px; }
    .auth-panel,
    .stack {
      display: grid;
      gap: 16px;
    }
    .tab-row {
      display: flex;
      gap: 8px;
      background: rgba(15, 23, 42, 0.04);
      padding: 8px;
      border-radius: 18px;
    }
    .tab {
      flex: 1;
      text-align: center;
      padding: 12px 14px;
      border-radius: 14px;
      font-weight: 700;
      color: var(--slate-soft);
    }
    .tab.active {
      background: white;
      color: var(--green-dark);
      box-shadow: 0 12px 24px rgba(15, 23, 42, 0.08);
    }
    .field {
      display: grid;
      gap: 8px;
    }
    .field span,
    .panel-head span {
      font-size: 14px;
      color: var(--slate-soft);
    }
    input,
    textarea,
    select {
      width: 100%;
      border-radius: 16px;
      border: 1px solid rgba(15, 23, 42, 0.12);
      padding: 14px 16px;
      font: inherit;
      background: rgba(255,255,255,0.98);
    }
    textarea { resize: vertical; min-height: 120px; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 16px;
      padding: 14px 18px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--green) 0%, #18a36a 100%);
      color: white;
    }
    .btn-secondary {
      background: rgba(14, 124, 79, 0.1);
      color: var(--green-dark);
    }
    .btn-danger {
      background: linear-gradient(135deg, #d62839 0%, #ef4444 100%);
      color: white;
    }
    .btn-ghost {
      background: transparent;
      border: 1px solid rgba(15, 23, 42, 0.12);
    }
    .btn:hover,
    .nav-link:hover,
    .tab:hover { transform: translateY(-1px); }
    .auth-links {
      display: flex;
      gap: 8px;
      align-items: center;
      color: var(--slate-soft);
      font-size: 14px;
    }
    .auth-links a { color: var(--green-dark); font-weight: 700; }
    .tip-grid,
    .card-grid,
    .reward-grid {
      display: grid;
      gap: 16px;
    }
    .tip-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 18px; }
    .mini-card {
      background: rgba(255,255,255,0.7);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 18px;
      display: grid;
      gap: 8px;
    }
    .app-shell {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      min-height: 100vh;
    }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 28px 22px;
      background: linear-gradient(180deg, var(--green-dark) 0%, var(--green) 100%);
      color: white;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 24px;
    }
    .sidebar.dark { background: linear-gradient(180deg, #10243b 0%, #091525 100%); }
    .sidebar .brand { color: white; }
    .nav-list { display: grid; gap: 10px; align-content: start; }
    .nav-link {
      border-radius: 18px;
      padding: 14px 16px;
      font-weight: 700;
      color: rgba(255,255,255,0.82);
      background: rgba(255,255,255,0.04);
    }
    .nav-link.active { background: rgba(255,255,255,0.16); color: white; }
    .sidebar-card {
      padding: 20px;
      display: grid;
      gap: 6px;
      color: var(--slate);
    }
    .dark-card {
      background: rgba(255,255,255,0.08);
      color: white;
      border-color: rgba(255,255,255,0.1);
      box-shadow: none;
    }
    .main-shell { padding: 26px; }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 18px;
    }
    .topbar span { color: var(--slate-soft); display: block; margin-top: 6px; }
    .topbar-actions { display: flex; gap: 12px; }
    .message {
      padding: 14px 18px;
      margin-bottom: 18px;
      font-weight: 600;
    }
    .message.success { background: #ecfdf3; color: var(--green-dark); }
    .message.error { background: #fff1f2; color: #991b1b; }
    .page-hero {
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: 18px;
      margin-bottom: 22px;
    }
    .cards-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .cards-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .metric-card {
      padding: 22px;
      display: grid;
      gap: 8px;
    }
    .metric-card strong { font-size: 40px; letter-spacing: -0.04em; }
    .metric-card span,
    .metric-card small { color: var(--slate-soft); }
    .accent-card {
      background: linear-gradient(135deg, rgba(14,124,79,0.12), rgba(255,255,255,0.94));
    }
    .split-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(320px, 420px);
      gap: 18px;
      margin-bottom: 18px;
    }
    .split-layout.records-layout {
      grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
      align-items: start;
    }
    .split-layout.no-gap { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .panel {
      padding: 22px;
    }
    .subtle-panel {
      background: rgba(255,255,255,0.7);
      box-shadow: none;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 18px;
    }
    .panel-head h2,
    .panel h3,
    .detail-panel h2 { margin: 0; font-size: 28px; letter-spacing: -0.03em; }
    .submission-row {
      display: grid;
      grid-template-columns: 92px minmax(0, 1fr) auto;
      gap: 14px;
      align-items: center;
      padding: 12px;
      border: 1px solid rgba(15,23,42,0.08);
      border-radius: 18px;
      background: rgba(255,255,255,0.68);
    }
    .submission-row.selected { border-color: rgba(14,124,79,0.4); background: rgba(223,245,234,0.55); }
    .submission-row img,
    .detail-image {
      width: 100%;
      border-radius: 18px;
      object-fit: cover;
      background: #eef3ef;
    }
    .submission-row img { height: 92px; }
    .detail-image { max-height: 460px; margin-bottom: 16px; }
    .submission-row-main {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .submission-row-main strong,
    .leaderboard-row strong,
    .reward-card h3 { overflow-wrap: anywhere; }
    .submission-row-points { font-weight: 800; color: var(--green-dark); }
    .leaderboard-card {
      background: linear-gradient(180deg, rgba(14,124,79,0.07), rgba(255,255,255,0.7));
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 18px;
      display: grid;
      gap: 14px;
    }
    .leaderboard-rank {
      display: grid;
      gap: 4px;
      padding-bottom: 14px;
      border-bottom: 1px solid rgba(15,23,42,0.08);
    }
    .leaderboard-rank strong { font-size: 48px; line-height: 1; }
    .leaderboard-row {
      display: grid;
      grid-template-columns: auto 1fr auto auto;
      gap: 10px;
      align-items: center;
      padding: 10px 12px;
      border-radius: 16px;
      background: rgba(255,255,255,0.78);
    }
    .leaderboard-row.self { outline: 2px solid rgba(14,124,79,0.18); }
    .reward-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .reward-card {
      padding: 18px;
      display: grid;
      gap: 14px;
      background: rgba(255,255,255,0.88);
    }
    .reward-card.selected { border-color: rgba(14,124,79,0.32); background: rgba(223,245,234,0.72); }
    .reward-media {
      height: 88px;
      display: grid;
      place-items: center;
      border-radius: 18px;
      background: rgba(14,124,79,0.08);
      font-size: 42px;
    }
    .reward-body { display: grid; gap: 8px; }
    .reward-body h3 { margin: 0; }
    .reward-body p { margin: 0; color: var(--slate-soft); }
    .reward-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      color: var(--slate-soft);
    }
    .reward-inline {
      display: flex;
      gap: 14px;
      align-items: center;
    }
    .reward-inline-icon {
      width: 56px;
      height: 56px;
      display: grid;
      place-items: center;
      border-radius: 18px;
      background: rgba(14,124,79,0.08);
      font-size: 28px;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }
    .detail-card,
    .info-card,
    .warning-box,
    .error-box {
      border-radius: 20px;
      padding: 18px;
      border: 1px solid rgba(15,23,42,0.08);
      background: rgba(255,255,255,0.74);
      margin-bottom: 14px;
    }
    .detail-card span,
    .info-card strong,
    .warning-box strong,
    .error-box strong { display: block; margin-bottom: 8px; }
    .detail-card strong { font-size: 22px; }
    .warning-box {
      background: rgba(245, 158, 11, 0.08);
      border-color: rgba(245, 158, 11, 0.24);
    }
    .error-box {
      background: rgba(220, 38, 38, 0.08);
      border-color: rgba(220, 38, 38, 0.22);
    }
    .detail-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      font-size: 14px;
    }
    .risk-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 7px 12px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 700;
    }
    .tag.success { background: rgba(34, 197, 94, 0.12); color: #166534; }
    .tag.warning { background: rgba(245, 158, 11, 0.16); color: #9a5b00; }
    .tag.danger { background: rgba(220, 38, 38, 0.12); color: #991b1b; }
    .tag.neutral { background: rgba(15, 23, 42, 0.08); color: #334155; }
    .upload-dropzone {
      display: grid;
      gap: 12px;
      align-items: center;
      justify-items: center;
      padding: 28px;
      min-height: 320px;
      border: 2px dashed rgba(14,124,79,0.28);
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(14,124,79,0.06), rgba(255,255,255,0.86));
      text-align: center;
      cursor: pointer;
    }
    .upload-dropzone input[type="file"] { display: none; }
    .upload-preview img {
      width: min(100%, 560px);
      max-height: 320px;
      object-fit: cover;
      border-radius: 20px;
      box-shadow: var(--shadow);
    }
    .hidden { display: none; }
    .table {
      width: 100%;
      border-collapse: collapse;
    }
    .table th,
    .table td {
      text-align: left;
      padding: 14px 12px;
      border-bottom: 1px solid rgba(15, 23, 42, 0.08);
    }
    .highlight-row { background: rgba(223,245,234,0.4); }
    .month-picker {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .rule-list {
      margin: 0;
      padding-left: 20px;
      display: grid;
      gap: 10px;
      color: var(--slate-soft);
      line-height: 1.6;
    }
    .empty-state {
      margin: 0;
      padding: 32px 0;
      text-align: center;
    }
    .empty-state.tall { min-height: 320px; display: grid; place-items: center; }
    @media (max-width: 1180px) {
      .auth-hero,
      .split-layout,
      .split-layout.records-layout,
      .split-layout.no-gap,
      .cards-4,
      .cards-3,
      .reward-grid,
      .detail-grid {
        grid-template-columns: 1fr;
      }
      .app-shell { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
      }
      .page-hero,
      .topbar,
      .topbar-actions {
        flex-direction: column;
        align-items: stretch;
      }
    }
  `;
}

export default app;
