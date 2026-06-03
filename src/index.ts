import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { REWARD_IMAGE_DATA } from "./reward-images";

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
type QueryDB = Pick<D1Database, "prepare">;

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
const ADMIN_LOGIN_PATH = "/admin/login";
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

function renderLoginPage(c: AppContext, roleMode: "member" | "admin"): Response {
  const currentUser = c.get("currentUser");
  if (currentUser) {
    return c.redirect(homePathFor(currentUser));
  }

  return c.html(
    renderGuestPage({
      title: "登录",
      active: "login",
      roleMode,
      message: resolveMessage(c),
      body: `
        <section class="hero-card auth-hero ${roleMode === "admin" ? "auth-hero-admin" : ""}">
          <div class="hero-copy ${roleMode === "admin" ? "hero-copy-admin" : ""}">
            <span class="eyebrow">JZIB 公益积分站</span>
            <h1>真实公益提交，真实 AI 审核，透明积分流转</h1>
            <p>校园社团成员可以上传公益活动图片，系统会调用真实 AI 做图像分析，再根据风险情况自动通过或进入管理员审核。</p>
            <div class="hero-chip-row">
              <span class="hero-chip">校园公益</span>
              <span class="hero-chip">积分成长</span>
              <span class="hero-chip">传递温暖</span>
            </div>
            <ul class="feature-list feature-list-cards">
              <li>上传公益图片并填写说明</li>
              <li>输出公益类型、置信度、建议积分、审核理由</li>
              <li>高置信度低风险自动发积分，其余进入人工审核</li>
            </ul>
            <div class="hero-stat-strip">
              <div class="hero-stat">
                <strong>AI</strong>
                <span>真实图像识别</span>
              </div>
              <div class="hero-stat">
                <strong>P0</strong>
                <span>最小可用闭环</span>
              </div>
              <div class="hero-stat">
                <strong>D1</strong>
                <span>云端积分存储</span>
              </div>
            </div>
          </div>
          <div class="auth-panel ${roleMode === "admin" ? "auth-panel-admin" : ""}">
            <div class="tab-row">
              <a class="tab ${roleMode === "member" ? "active" : ""}" href="/login">成员登录</a>
              <a class="tab ${roleMode === "admin" ? "active" : ""}" href="${ADMIN_LOGIN_PATH}">管理员入口</a>
            </div>
            <div class="auth-panel-copy">
              <strong>${roleMode === "admin" ? "管理员审核入口" : "成员账户登录"}</strong>
              <p>${roleMode === "admin" ? "进入人工审核台，处理低置信度、隐私风险或 AI 失败的公益提交。" : "登录后可上传现场图片、查看审核进度、累计积分并参与兑换。"}</p>
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
            <p class="helper-text">${roleMode === "admin" ? "管理员账号由系统初始化或部署变量创建。" : "P0 默认支持成员账号注册；管理员账号由系统初始化或部署变量创建。"}</p>
          </div>
        </section>
      `
    })
  );
}

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
  const roleMode = c.req.query("role") === "admin" ? "admin" : "member";
  return renderLoginPage(c, roleMode);
});

app.get(ADMIN_LOGIN_PATH, (c) => renderLoginPage(c, "admin"));

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
    return redirectWithMessage(c, roleMode === "admin" ? ADMIN_LOGIN_PATH : "/login", "error", "账号或密码错误。");
  }

  if (roleMode === "admin" && row.role !== "admin") {
    return redirectWithMessage(c, ADMIN_LOGIN_PATH, "error", "该账号不是管理员。");
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

  return c.redirect(homePathFor(toCurrentUser(row)), 303);
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
            <div class="hero-chip-row">
              <span class="hero-chip">成员注册</span>
              <span class="hero-chip">社团档案</span>
              <span class="hero-chip">公益成长</span>
            </div>
            <div class="tip-grid">
              <article class="mini-card"><strong>上传要求</strong><span>请尽量上传现场拍摄图片，避免截图或海报。</span></article>
              <article class="mini-card"><strong>审核机制</strong><span>高置信度低风险自动加分，其他情况进入管理员审核。</span></article>
              <article class="mini-card"><strong>积分透明</strong><span>所有积分变化都会记录在个人账户中，支持月榜展示。</span></article>
            </div>
            <div class="hero-stat-strip hero-stat-strip-soft">
              <div class="hero-stat">
                <strong>1</strong>
                <span>创建成员账号</span>
              </div>
              <div class="hero-stat">
                <strong>2</strong>
                <span>上传公益图片</span>
              </div>
              <div class="hero-stat">
                <strong>3</strong>
                <span>累计成长积分</span>
              </div>
            </div>
          </div>
          <div class="auth-panel">
            <div class="auth-panel-copy">
              <strong>创建成员账号</strong>
              <p>填写基础信息后即可进入个人工作台，上传公益现场图片并参与积分兑换。</p>
            </div>
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
  return c.redirect("/login", 303);
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
          <div class="hero-actions">
            <div class="hero-note-card">
              <strong>本月公益进度</strong>
              <span>围绕公益图片提交、积分发放与奖励兑换形成完整闭环。</span>
            </div>
            <a class="btn btn-primary" href="/app/submissions/new">上传公益图片</a>
          </div>
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
                <div class="reward-media">${rewardMediaContent(reward)}</div>
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
  const db = c.env.DB.withSession("first-primary");

  const form = await c.req.formData();
  const description = toCleanString(form.get("description"));
  const image = form.get("image");

  if (!description || !(image instanceof File)) {
    return redirectWithMessage(c, "/app/submissions/new", "error", "请上传图片并填写活动说明。");
  }
  if (!image.type.startsWith("image/")) {
    return redirectWithMessage(c, "/app/submissions/new", "error", "请上传 JPG、PNG 或 WebP 图片。");
  }
  if (image.size <= 0) {
    return redirectWithMessage(c, "/app/submissions/new", "error", "上传图片为空，请重新选择。");
  }
  if (image.size > MAX_UPLOAD_BYTES) {
    return redirectWithMessage(
      c,
      "/app/submissions/new",
      "error",
      `图片压缩后仍超过 ${(MAX_UPLOAD_BYTES / 1024).toFixed(0)}KB，请重新选择更小的图片。`
    );
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
  const duplicateHit = await db.prepare("SELECT id FROM submissions WHERE image_sha256 = ? LIMIT 1")
    .bind(imageHash)
    .first<{ id: string }>();

  const submissionId = generateId("sub_");
  const now = Date.now();
  await db.prepare(
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
      db.prepare(
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
        db.prepare("UPDATE users SET points_balance = points_balance + ? WHERE id = ?").bind(awardedPoints, currentUser.id),
        db.prepare(
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

    await db.batch(statements);
  } catch (error) {
    await db.prepare(
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

  return c.redirect(
    `/app/submissions?id=${submissionId}&success=${encodeURIComponent("提交已保存，系统已尝试执行 AI 分析。")}`,
    303
  );
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
          <div class="hero-actions">
            <div class="hero-note-card">
              <strong>审核状态透明可见</strong>
              <span>支持查看 AI 结果、风险标签、人工处理状态和拒绝原因。</span>
            </div>
            <a class="btn btn-secondary" href="/app/submissions/new">继续上传</a>
          </div>
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
          <div class="hero-actions">
            <div class="hero-note-card">
              <strong>积分商城</strong>
              <span>公益积分可兑换校园好物与服务，申请提交后会冻结对应积分。</span>
            </div>
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
                  <div class="reward-media">${rewardMediaContent(reward)}</div>
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
                  <div class="reward-inline-media">${rewardMediaContent(selectedReward, "inline")}</div>
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
  const db = c.env.DB.withSession("first-primary");

  const form = await c.req.formData();
  const rewardId = toCleanString(form.get("rewardId"));
  const contactInfo = toCleanString(form.get("contactInfo"));
  const note = toCleanString(form.get("note"));

  if (!rewardId || !contactInfo) {
    return redirectWithMessage(c, "/app/rewards", "error", "请先选择奖励并填写联系方式。");
  }

  const reward = await db.prepare(
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

  const now = Date.now();
  const reservedBalance = await db.prepare(
    `UPDATE users
     SET points_balance = points_balance - ?
     WHERE id = ? AND points_balance >= ?
     RETURNING points_balance`
  )
    .bind(reward.points_cost, currentUser.id, reward.points_cost)
    .first<{ points_balance: number }>();
  if (!reservedBalance) {
    return redirectWithMessage(c, "/app/rewards", "error", "当前积分不足，无法提交兑换申请。");
  }

  const reservedReward = await db.prepare(
    `UPDATE rewards
     SET stock = stock - 1
     WHERE id = ? AND active = 1 AND stock > 0
     RETURNING stock`
  )
    .bind(reward.id)
    .first<{ stock: number }>();
  if (!reservedReward) {
    await db.prepare("UPDATE users SET points_balance = points_balance + ? WHERE id = ?")
      .bind(reward.points_cost, currentUser.id)
      .run();
    return redirectWithMessage(c, "/app/rewards", "error", "该奖励库存不足。");
  }

  const exchangeId = generateId("ex_");
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO exchange_requests (id, user_id, reward_id, reward_name, points_cost, contact_info, note, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?)`
      ).bind(exchangeId, currentUser.id, reward.id, reward.name, reward.points_cost, contactInfo, note || null, now),
      db.prepare(
        "INSERT INTO points_ledger (id, user_id, submission_id, delta, reason, created_at) VALUES (?, ?, NULL, ?, ?, ?)"
      ).bind(generateId("ledger_"), currentUser.id, -reward.points_cost, `兑换申请：${reward.name}`, now)
    ]);
  } catch (error) {
    await db.batch([
      db.prepare("DELETE FROM exchange_requests WHERE id = ?").bind(exchangeId),
      db.prepare("UPDATE users SET points_balance = points_balance + ? WHERE id = ?").bind(reward.points_cost, currentUser.id),
      db.prepare("UPDATE rewards SET stock = stock + 1 WHERE id = ?").bind(reward.id)
    ]);
    throw error;
  }

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
          <div class="hero-actions">
            <div class="hero-note-card admin-note-card">
              <strong>人工审核闭环</strong>
              <span>管理员可在待审队列中逐条判断，通过后发放积分，拒绝时写明原因。</span>
            </div>
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
  const db = c.env.DB.withSession("first-primary");

  const submissionId = c.req.param("id");
  const form = await c.req.formData();
  const reviewNote = toCleanString(form.get("reviewNote"));
  const awardedPoints = clampInteger(Number.parseInt(toCleanString(form.get("awardedPoints")) || "0", 10), 0, 50);

  const submission = await getSubmissionDetail(db, submissionId);
  if (!submission) {
    return redirectWithMessage(c, "/admin/reviews", "error", "提交记录不存在。");
  }
  if (!["manual_review", "ai_failed"].includes(submission.review_status)) {
    return redirectWithMessage(c, `/admin/reviews?id=${submission.id}`, "error", "该记录当前不能执行通过操作。");
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    db.prepare(
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
      db.prepare("UPDATE users SET points_balance = points_balance + ? WHERE id = ?").bind(awardedPoints, submission.user_id),
      db.prepare(
        "INSERT INTO points_ledger (id, user_id, submission_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(generateId("ledger_"), submission.user_id, submission.id, awardedPoints, "管理员通过", now)
    );
  }

  await db.batch(statements);
  return redirectWithMessage(c, "/admin/reviews", "success", "提交已通过，积分已发放。");
});

app.post("/admin/reviews/:id/reject", async (c) => {
  const currentUser = requireAdmin(c);
  if (currentUser instanceof Response) return currentUser;
  const db = c.env.DB.withSession("first-primary");

  const submissionId = c.req.param("id");
  const form = await c.req.formData();
  const rejectionReason = toCleanString(form.get("rejectionReason"));

  if (!rejectionReason) {
    return redirectWithMessage(c, `/admin/reviews?id=${submissionId}`, "error", "请填写拒绝原因。");
  }

  const submission = await getSubmissionDetail(db, submissionId);
  if (!submission) {
    return redirectWithMessage(c, "/admin/reviews", "error", "提交记录不存在。");
  }

  await db.prepare(
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
    .first<{ id: string; user_id: string; image_blob: unknown; image_mime: string }>();

  if (!row) {
    return c.text("Not found", 404);
  }
  if (currentUser.role !== "admin" && row.user_id !== currentUser.id) {
    return c.text("Forbidden", 403);
  }

  return new Response(toBinaryBytes(row.image_blob), {
    headers: {
      "Content-Type": row.image_mime,
      "Cache-Control": "private, max-age=300"
    }
  });
});

app.get("/errors/404", (c) => c.html(renderSimpleError("页面不存在", "请求的页面不存在。", c.get("currentUser")), 404));
app.get("/errors/500", (c) => c.html(renderSimpleError("应用出错", "应用内部出现异常，请稍后重试。", c.get("currentUser")), 500));

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

async function getCurrentUser(db: QueryDB, sessionId: string): Promise<CurrentUser | null> {
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
    return c.redirect(ADMIN_LOGIN_PATH);
  }
  if (currentUser.role !== "admin") {
    return c.redirect("/app");
  }
  return currentUser;
}

async function getDashboardSummary(db: QueryDB, userId: string): Promise<DashboardSummary> {
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

async function listUserSubmissions(db: QueryDB, userId: string, limit: number): Promise<SubmissionListRow[]> {
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

async function getSubmissionDetail(db: QueryDB, submissionId: string, ownerId?: string): Promise<SubmissionDetail | null> {
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

async function listRewards(db: QueryDB, limit: number): Promise<RewardRow[]> {
  const result = await db.prepare(
    "SELECT id, name, description, points_cost, stock, active FROM rewards WHERE active = 1 ORDER BY points_cost ASC LIMIT ?"
  )
    .bind(limit)
    .all<RewardRow>();
  return result.results;
}

async function listExchangeRequests(db: QueryDB, userId: string): Promise<ExchangeRow[]> {
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

async function listPendingSubmissions(db: QueryDB): Promise<SubmissionListRow[]> {
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

async function getLeaderboard(db: QueryDB, month: string): Promise<LeaderboardRow[]> {
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
      <div class="guest-shell guest-shell-auth">
        <header class="guest-header">
          <div class="brand-lockup">
            <a class="brand" href="/login">JZIB 公益积分站</a>
            <span class="brand-caption">校园公益记录、积分成长与奖励兑换平台</span>
          </div>
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
          <div class="brand-lockup brand-lockup-sidebar">
            <a class="brand" href="/app">JZIB<br />公益积分站</a>
            <span class="brand-caption brand-caption-sidebar">校园公益记录与成长系统</span>
          </div>
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
          <header class="topbar topbar-card">
            <div>
              <span class="shell-kicker">成员工作台</span>
              <strong>${escapeHtml(input.currentUser.displayName)}</strong>
              <span>${escapeHtml(input.currentUser.account)}</span>
            </div>
            <div class="topbar-actions">
              <div class="topbar-pill">
                <b>${input.currentUser.pointsBalance}</b>
                <span>当前积分</span>
              </div>
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
          <div class="brand-lockup brand-lockup-sidebar">
            <a class="brand" href="/admin/reviews">公益审核平台</a>
            <span class="brand-caption brand-caption-sidebar">低置信度与风险提交人工处理台</span>
          </div>
          <nav class="nav-list">
            <a class="nav-link ${input.active === "reviews" ? "active" : ""}" href="/admin/reviews">审核管理</a>
          </nav>
          <div class="sidebar-card dark-card">
            <strong>${escapeHtml(input.currentUser.displayName)}</strong>
            <span>${escapeHtml(input.currentUser.account)}</span>
          </div>
        </aside>
        <main class="main-shell">
          <header class="topbar topbar-card">
            <div>
              <span class="shell-kicker shell-kicker-admin">管理员空间</span>
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
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)} - JZIB 公益积分站</title>
      <style>${styles()}</style>
    </head>
    <body>${body}<script>${translationScript()}</script></body>
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
    `
      <div class="guest-shell error-shell">
        <section class="hero-card error-card">
          <span class="eyebrow">JZIB 公益积分站</span>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(message)}</p>
          <a class="btn btn-primary" href="${backLink}">返回</a>
        </section>
      </div>
    `
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

function rewardImageSrc(rewardId: string): string | null {
  return REWARD_IMAGE_DATA[rewardId] || null;
}

function rewardMediaContent(
  reward: Pick<RewardRow, "id" | "name">,
  variant: "card" | "inline" = "card"
): string {
  const imageSrc = rewardImageSrc(reward.id);
  if (!imageSrc) {
    return variant === "inline"
      ? `<span class="reward-inline-icon" aria-hidden="true">${rewardEmoji(reward.name)}</span>`
      : `<span class="reward-emoji" aria-hidden="true">${rewardEmoji(reward.name)}</span>`;
  }

  return `<img src="${imageSrc}" alt="${escapeHtml(reward.name)}" loading="lazy" />`;
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

function toBinaryBytes(value: unknown): ArrayBuffer {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value).buffer as ArrayBuffer;
  }
  throw new Error("提交图片数据格式无效");
}

function redirectWithMessage(c: AppContext, path: string, tone: "success" | "error", message: string): Response {
  const glue = path.includes("?") ? "&" : "?";
  return c.redirect(new URL(`${path}${glue}${tone}=${encodeURIComponent(message)}`, c.req.url).toString(), 303);
}

function translationScript(): string {
  const textMap: Record<string, [string, string]> = {
    "JZIB 公益积分站": ["JZIB Public Welfare Points", "JZIB 公益积分站"],
    "校园公益记录、积分成长与奖励兑换平台": ["Campus public-welfare records, points growth, and rewards redemption", "校园公益记录、积分成长与奖励兑换平台"],
    "登录": ["Login", "登录"],
    "注册": ["Register", "注册"],
    "真实公益提交，真实 AI 审核，透明积分流转": ["Real public-welfare submissions, real AI review, transparent points flow", "真实公益提交，真实 AI 审核，透明积分流转"],
    "校园社团成员可以上传公益活动图片，系统会调用真实 AI 做图像分析，再根据风险情况自动通过或进入管理员审核。": [
      "Campus club members can upload public-welfare activity photos. The system calls a real AI model for image analysis, then auto-approves or routes to manual review based on risk.",
      "校园社团成员可以上传公益活动图片，系统会调用真实 AI 做图像分析，再根据风险情况自动通过或进入管理员审核。"
    ],
    "校园公益": ["Campus welfare", "校园公益"],
    "积分成长": ["Points growth", "积分成长"],
    "传递温暖": ["Share warmth", "传递温暖"],
    "上传公益图片并填写说明": ["Upload a public-welfare image and add a short description", "上传公益图片并填写说明"],
    "输出公益类型、置信度、建议积分、审核理由": ["Return welfare type, confidence, suggested points, and review reason", "输出公益类型、置信度、建议积分、审核理由"],
    "高置信度低风险自动发积分，其余进入人工审核": ["High-confidence, low-risk submissions are auto-scored; all others go to manual review", "高置信度低风险自动发积分，其余进入人工审核"],
    "真实图像识别": ["Real image analysis", "真实图像识别"],
    "最小可用闭环": ["Minimum viable loop", "最小可用闭环"],
    "云端积分存储": ["Cloud points storage", "云端积分存储"],
    "成员登录": ["Member login", "成员登录"],
    "管理员入口": ["Admin portal", "管理员入口"],
    "管理员审核入口": ["Admin review entry", "管理员审核入口"],
    "成员账户登录": ["Member account sign-in", "成员账户登录"],
    "进入管理员审核台": ["Enter admin review console", "进入管理员审核台"],
    "进入人工审核台，处理低置信度、隐私风险或 AI 失败的公益提交。": ["Enter the manual review console to handle low-confidence, privacy-risk, or AI-failed submissions.", "进入人工审核台，处理低置信度、隐私风险或 AI 失败的公益提交。"],
    "登录后可上传现场图片、查看审核进度、累计积分并参与兑换。": ["After signing in, upload on-site images, track review progress, accumulate points, and redeem rewards.", "登录后可上传现场图片、查看审核进度、累计积分并参与兑换。"],
    "账号": ["Account", "账号"],
    "密码": ["Password", "密码"],
    "还没有账号？": ["No account yet?", "还没有账号？"],
    "去注册": ["Create one", "去注册"],
    "P0 默认支持成员账号注册；管理员账号由系统初始化或部署变量创建。": ["P0 supports member self-registration by default. Admin accounts are created during initialization or via deployment variables.", "P0 默认支持成员账号注册；管理员账号由系统初始化或部署变量创建。"],
    "管理员账号由系统初始化或部署变量创建。": ["Admin accounts are created during initialization or via deployment variables.", "管理员账号由系统初始化或部署变量创建。"],
    "成员注册": ["Member registration", "成员注册"],
    "为校园公益社团创建可用账号": ["Create a usable account for a campus public-welfare club", "为校园公益社团创建可用账号"],
    "注册成功后，你可以提交公益图片、查看审核状态、累计积分并发起奖励兑换。": ["After registration, you can submit public-welfare images, review status updates, accumulate points, and request redemptions.", "注册成功后，你可以提交公益图片、查看审核状态、累计积分并发起奖励兑换。"],
    "社团档案": ["Club profile", "社团档案"],
    "公益成长": ["Welfare growth", "公益成长"],
    "上传要求": ["Upload rules", "上传要求"],
    "请尽量上传现场拍摄图片，避免截图或海报。": ["Please upload on-site photos whenever possible and avoid screenshots or posters.", "请尽量上传现场拍摄图片，避免截图或海报。"],
    "审核机制": ["Review workflow", "审核机制"],
    "高置信度低风险自动加分，其他情况进入管理员审核。": ["High-confidence, low-risk submissions are auto-scored. All other cases move to manual review.", "高置信度低风险自动加分，其他情况进入管理员审核。"],
    "积分透明": ["Transparent points", "积分透明"],
    "所有积分变化都会记录在个人账户中，支持月榜展示。": ["Every points change is recorded in the account and can appear in the monthly leaderboard.", "所有积分变化都会记录在个人账户中，支持月榜展示。"],
    "创建成员账号": ["Create member account", "创建成员账号"],
    "上传公益图片": ["Upload public-welfare image", "上传公益图片"],
    "累计成长积分": ["Accumulate growth points", "累计成长积分"],
    "填写基础信息后即可进入个人工作台，上传公益现场图片并参与积分兑换。": ["Complete the basic information to enter your dashboard, upload public-welfare proof images, and join the redemption flow.", "填写基础信息后即可进入个人工作台，上传公益现场图片并参与积分兑换。"],
    "社团名称": ["Club name", "社团名称"],
    "显示名称（可选）": ["Display name (optional)", "显示名称（可选）"],
    "确认密码": ["Confirm password", "确认密码"],
    "已经有账号？": ["Already have an account?", "已经有账号？"],
    "去登录": ["Go to login", "去登录"],
    "用户首页": ["Dashboard", "用户首页"],
    "本月公益进度": ["This month's welfare progress", "本月公益进度"],
    "围绕公益图片提交、积分发放与奖励兑换形成完整闭环。": ["A full loop built around image submission, points issuance, and reward redemption.", "围绕公益图片提交、积分发放与奖励兑换形成完整闭环。"],
    "积分余额": ["Points balance", "积分余额"],
    "可用于兑换奖励": ["Available for rewards redemption", "可用于兑换奖励"],
    "待处理提交": ["Pending submissions", "待处理提交"],
    "包含审核中和 AI 失败": ["Includes under-review and AI-failed items", "包含审核中和 AI 失败"],
    "已通过提交": ["Approved submissions", "已通过提交"],
    "自动通过 + 管理员通过": ["Auto-approved + manually approved", "自动通过 + 管理员通过"],
    "本月新增积分": ["Points added this month", "本月新增积分"],
    "最近提交": ["Recent submissions", "最近提交"],
    "查看全部": ["View all", "查看全部"],
    "待定": ["Pending", "待定"],
    "还没有任何公益提交，先上传第一张现场图片。": ["No public-welfare submissions yet. Upload your first on-site image.", "还没有任何公益提交，先上传第一张现场图片。"],
    "每月排行榜": ["Monthly leaderboard", "每月排行榜"],
    "查看月榜": ["Open leaderboard", "查看月榜"],
    "我的排名": ["My rank", "我的排名"],
    "未填写社团": ["Club not provided", "未填写社团"],
    "本月还没有积分记录。": ["There are no points records for this month yet.", "本月还没有积分记录。"],
    "可兑换奖励": ["Redeemable rewards", "可兑换奖励"],
    "进入兑换中心": ["Open redemption center", "进入兑换中心"],
    "选择奖励": ["Select reward", "选择奖励"],
    "图片提交": ["Image submission", "图片提交"],
    "上传公益活动图片并填写简单说明。系统会调用真实 AI 分析图片，失败时会保留失败状态并转人工处理。": ["Upload a public-welfare activity photo and add a short description. The system will call a real AI model to analyze the image. If analysis fails, the item stays failed or moves to manual handling.", "上传公益活动图片并填写简单说明。系统会调用真实 AI 分析图片，失败时会保留失败状态并转人工处理。"],
    "上传图片": ["Upload image", "上传图片"],
    "拖拽图片到此处，或点击选择文件": ["Drag an image here or click to choose a file", "拖拽图片到此处，或点击选择文件"],
    "浏览器会在提交前自动压缩图片，便于存入 D1 并传给 AI 分析。": ["The browser compresses the image before submission so it can be stored in D1 and sent to AI analysis efficiently.", "浏览器会在提交前自动压缩图片，便于存入 D1 并传给 AI 分析。"],
    "建议上传现场拍摄的 JPG / PNG 图片，压缩后不超过 1.2MB。": ["Upload an on-site JPG or PNG image. The compressed file should stay under 1.2MB.", "建议上传现场拍摄的 JPG / PNG 图片，压缩后不超过 1.2MB。"],
    "活动说明": ["Activity description", "活动说明"],
    "提交审核": ["Submit for review", "提交审核"],
    "AI 分析输出": ["AI output preview", "AI 分析输出"],
    "提交后会尝试生成以下字段": ["After submission, the system will try to generate these fields", "提交后会尝试生成以下字段"],
    "公益类型": ["Welfare type", "公益类型"],
    "置信度": ["Confidence", "置信度"],
    "建议积分": ["Suggested points", "建议积分"],
    "审核理由": ["Review reason", "审核理由"],
    "隐私风险 / 模糊 / 疑似网图 / 疑似重复": ["Privacy risk / blur / suspected web image / suspected duplicate", "隐私风险 / 模糊 / 疑似网图 / 疑似重复"],
    "隐私风险提醒": ["Privacy reminder", "隐私风险提醒"],
    "请尽量避免包含身份证件、车牌、宿舍号、手机号、签到表或清晰人脸特写。如果图像存在隐私风险，会强制进入人工审核。": ["Avoid ID cards, license plates, dorm numbers, phone numbers, sign-in sheets, or clear face close-ups whenever possible. Privacy-risk images are forced into manual review.", "请尽量避免包含身份证件、车牌、宿舍号、手机号、签到表或清晰人脸特写。如果图像存在隐私风险，会强制进入人工审核。"],
    "自动加分条件": ["Auto-approval rules", "自动加分条件"],
    "AI 置信度 ≥ 0.85，且无隐私风险、无模糊、无疑似网图、无重复命中时，系统才会自动通过并发放积分。": ["Only when AI confidence is at least 0.85 and there is no privacy risk, blur, suspected web-image risk, or duplicate hit will the system auto-approve and issue points.", "AI 置信度 ≥ 0.85，且无隐私风险、无模糊、无疑似网图、无重复命中时，系统才会自动通过并发放积分。"],
    "提交记录": ["Submission records", "提交记录"],
    "查看 AI 分析、审核状态、积分发放情况和拒绝原因。": ["Review AI analysis, review status, points issuance, and rejection reasons.", "查看 AI 分析、审核状态、积分发放情况和拒绝原因。"],
    "审核状态透明可见": ["Transparent review status", "审核状态透明可见"],
    "支持查看 AI 结果、风险标签、人工处理状态和拒绝原因。": ["See AI results, risk tags, manual handling status, and rejection reasons.", "支持查看 AI 结果、风险标签、人工处理状态和拒绝原因。"],
    "继续上传": ["Continue uploading", "继续上传"],
    "我的提交": ["My submissions", "我的提交"],
    "暂无提交记录。": ["No submission records yet.", "暂无提交记录。"],
    "请选择左侧的一条提交记录查看详情。": ["Choose a submission on the left to inspect the details.", "请选择左侧的一条提交记录查看详情。"],
    "积分兑换": ["Points redemption", "积分兑换"],
    "查看兑换规则和可兑换奖励，并提交兑换申请。": ["View redemption rules and rewards, then submit a redemption request.", "查看兑换规则和可兑换奖励，并提交兑换申请。"],
    "积分商城": ["Points store", "积分商城"],
    "公益积分可兑换校园好物与服务，申请提交后会冻结对应积分。": ["Public-welfare points can be redeemed for campus goods and services. Submitted requests freeze the corresponding points.", "公益积分可兑换校园好物与服务，申请提交后会冻结对应积分。"],
    "当前选择": ["Current selection", "当前选择"],
    "联系方式": ["Contact information", "联系方式"],
    "备注（可选）": ["Note (optional)", "备注（可选）"],
    "提交兑换申请": ["Submit redemption request", "提交兑换申请"],
    "当前没有可兑换奖励。": ["There are no redeemable rewards at the moment.", "当前没有可兑换奖励。"],
    "我的兑换申请": ["My redemption requests", "我的兑换申请"],
    "奖励": ["Reward", "奖励"],
    "积分": ["Points", "积分"],
    "状态": ["Status", "状态"],
    "提交时间": ["Submitted at", "提交时间"],
    "还没有兑换申请。": ["No redemption requests yet.", "还没有兑换申请。"],
    "展示本月通过审核后累计获得的公益积分。P0 只保留月榜，不扩展总榜和排名变化图。": ["Shows public-welfare points accumulated after approved submissions in the current month. P0 keeps only the monthly leaderboard without all-time or trend charts.", "展示本月通过审核后累计获得的公益积分。P0 只保留月榜，不扩展总榜和排名变化图。"],
    "切换月份": ["Switch month", "切换月份"],
    "当前月份": ["Current month", "当前月份"],
    "我的本月积分": ["My monthly points", "我的本月积分"],
    "月榜 Top 10": ["Top 10 leaderboard", "月榜 Top 10"],
    "排名": ["Rank", "排名"],
    "成员": ["Member", "成员"],
    "社团": ["Club", "社团"],
    "公益积分": ["Welfare points", "公益积分"],
    "通过次数": ["Approved count", "通过次数"],
    "该月份暂无积分记录。": ["There are no points records for this month.", "该月份暂无积分记录。"],
    "管理员审核台": ["Admin review console", "管理员审核台"],
    "处理 AI 低置信度、隐私风险、模糊、疑似网图、疑似重复或 AI 调用失败的提交。": ["Handle submissions flagged for low AI confidence, privacy risk, blur, suspected web image, suspected duplicate, or AI failure.", "处理 AI 低置信度、隐私风险、模糊、疑似网图、疑似重复或 AI 调用失败的提交。"],
    "人工审核闭环": ["Manual review loop", "人工审核闭环"],
    "管理员可在待审队列中逐条判断，通过后发放积分，拒绝时写明原因。": ["Admins can inspect each queued item, issue points after approval, and provide a clear reason when rejecting.", "管理员可在待审队列中逐条判断，通过后发放积分，拒绝时写明原因。"],
    "待审核": ["Pending review", "待审核"],
    "人工通过": ["Manually approved", "人工通过"],
    "已拒绝": ["Rejected", "已拒绝"],
    "待审核队列": ["Review queue", "待审核队列"],
    "当前没有需要人工处理的提交。": ["There are no submissions waiting for manual handling.", "当前没有需要人工处理的提交。"],
    "当前没有待审核内容。": ["There is nothing waiting for review right now.", "当前没有待审核内容。"],
    "公益审核平台": ["Public welfare review platform", "公益审核平台"],
    "低置信度与风险提交人工处理台": ["Manual handling console for low-confidence and risk-tagged submissions", "低置信度与风险提交人工处理台"],
    "审核管理": ["Review management", "审核管理"],
    "管理员空间": ["Admin workspace", "管理员空间"],
    "处理需要人工介入的公益提交": ["Handle public-welfare submissions that require manual intervention", "处理需要人工介入的公益提交"],
    "成员视图": ["Member view", "成员视图"],
    "退出登录": ["Sign out", "退出登录"],
    "校园公益记录与成长系统": ["Campus public-welfare record and growth system", "校园公益记录与成长系统"],
    "成员工作台": ["Member workspace", "成员工作台"],
    "当前积分": ["Current points", "当前积分"],
    "记录详情": ["Record details", "记录详情"],
    "提交现场图片": ["Submitted proof image", "提交现场图片"],
    "审核状态": ["Review status", "审核状态"],
    "暂无": ["None yet", "暂无"],
    "AI 分析失败": ["AI analysis failed", "AI 分析失败"],
    "AI 分析中": ["AI analysis in progress", "AI 分析中"],
    "系统未能产出有效 AI 结果，这条提交会保持失败状态或等待人工处理。": ["The system could not produce a valid AI result. This submission will stay failed or wait for manual handling.", "系统未能产出有效 AI 结果，这条提交会保持失败状态或等待人工处理。"],
    "拒绝原因": ["Rejection reason", "拒绝原因"],
    "审核完成：待处理": ["Reviewed: pending", "审核完成：待处理"],
    "证据材料预览": ["Evidence preview", "证据材料预览"],
    "未填写": ["Not provided", "未填写"],
    "AI 状态": ["AI status", "AI 状态"],
    "没有得到 AI 分析结果，请管理员根据现场图片和文字说明人工处理。": ["No AI result was returned. Please review this item manually based on the image and description.", "没有得到 AI 分析结果，请管理员根据现场图片和文字说明人工处理。"],
    "通过": ["Approve", "通过"],
    "发放积分": ["Points to issue", "发放积分"],
    "通过并发积分": ["Approve and issue points", "通过并发积分"],
    "拒绝": ["Reject", "拒绝"],
    "拒绝该提交": ["Reject submission", "拒绝该提交"],
    "未发现高风险标签": ["No high-risk tags detected", "未发现高风险标签"],
    "隐私风险": ["Privacy risk", "隐私风险"],
    "图片模糊": ["Blur risk", "图片模糊"],
    "疑似网图": ["Suspected web image", "疑似网图"],
    "疑似重复": ["Suspected duplicate", "疑似重复"],
    "页面不存在": ["Page not found", "页面不存在"],
    "请求的页面不存在。": ["The requested page does not exist.", "请求的页面不存在。"],
    "应用出错": ["Application error", "应用出错"],
    "应用内部出现异常，请稍后重试。": ["The application encountered an internal error. Please try again later.", "应用内部出现异常，请稍后重试。"],
    "返回": ["Back", "返回"],
    "自动通过": ["Auto-approved", "自动通过"],
    "系统自动通过": ["System auto-approval", "系统自动通过"],
    "待人工审核": ["Manual review", "待人工审核"],
    "AI 已完成": ["AI completed", "AI 已完成"],
    "AI 失败": ["AI failed", "AI 失败"],
    "已提交": ["Submitted", "已提交"],
    "已完成": ["Completed", "已完成"],
    "提交已保存，系统已尝试执行 AI 分析。": ["Submission saved. The system has attempted AI analysis.", "提交已保存，系统已尝试执行 AI 分析。"],
    "请填写账号和密码。": ["Please enter both account and password.", "请填写账号和密码。"],
    "账号或密码错误。": ["Incorrect account or password.", "账号或密码错误。"],
    "该账号不是管理员。": ["This account is not an admin account.", "该账号不是管理员。"],
    "请完整填写注册信息。": ["Please complete the full registration form.", "请完整填写注册信息。"],
    "密码至少需要 8 位。": ["Password must be at least 8 characters long.", "密码至少需要 8 位。"],
    "两次输入的密码不一致。": ["The two password entries do not match.", "两次输入的密码不一致。"],
    "该账号已被注册。": ["This account has already been registered.", "该账号已被注册。"],
    "注册成功，请登录。": ["Registration successful. Please sign in.", "注册成功，请登录。"],
    "请上传图片并填写活动说明。": ["Please upload an image and provide an activity description.", "请上传图片并填写活动说明。"],
    "请上传 JPG、PNG 或 WebP 图片。": ["Please upload a JPG, PNG, or WebP image.", "请上传 JPG、PNG 或 WebP 图片。"],
    "上传图片为空，请重新选择。": ["The uploaded image is empty. Please choose another file.", "上传图片为空，请重新选择。"],
    "请先选择奖励并填写联系方式。": ["Please choose a reward and provide contact information first.", "请先选择奖励并填写联系方式。"],
    "奖励不存在或已下架。": ["The reward does not exist or is no longer available.", "奖励不存在或已下架。"],
    "该奖励库存不足。": ["This reward is out of stock.", "该奖励库存不足。"],
    "当前积分不足，无法提交兑换申请。": ["You do not have enough points to submit this redemption request.", "当前积分不足，无法提交兑换申请。"],
    "兑换申请已提交，积分已冻结。": ["Redemption request submitted. The corresponding points have been reserved.", "兑换申请已提交，积分已冻结。"],
    "提交记录不存在。": ["The submission record does not exist.", "提交记录不存在。"],
    "该记录当前不能执行通过操作。": ["This record cannot be approved in its current state.", "该记录当前不能执行通过操作。"],
    "提交已通过，积分已发放。": ["Submission approved and points issued.", "提交已通过，积分已发放。"],
    "请填写拒绝原因。": ["Please provide a rejection reason.", "请填写拒绝原因。"],
    "提交已拒绝。": ["Submission rejected.", "提交已拒绝。"],
    "正在处理图片，请稍候…": ["Processing image, please wait…", "正在处理图片，请稍候…"],
    "正在上传并触发 AI 分析…": ["Uploading and triggering AI analysis…", "正在上传并触发 AI 分析…"],
    "图片处理超时，请先压缩后再上传。": ["Image processing timed out. Please compress it locally before uploading.", "图片处理超时，请先压缩后再上传。"],
    "图片压缩失败": ["Image compression failed", "图片压缩失败"],
    "原图过大，请先压缩到 20MB 以内再上传。": ["The original file is too large. Please compress it below 20MB before uploading.", "原图过大，请先压缩到 20MB 以内再上传。"],
    "图片分辨率过高，请先压缩后再上传。": ["The image resolution is too high. Please compress it before uploading.", "图片分辨率过高，请先压缩后再上传。"],
    "图片压缩后仍超过 1.2MB，请先在本地压缩后再上传。": ["The compressed image is still over 1.2MB. Please compress it locally before uploading.", "图片压缩后仍超过 1.2MB，请先在本地压缩后再上传。"],
    "浏览器无法压缩该图片": ["This browser could not compress the image.", "浏览器无法压缩该图片"],
    "当前浏览器不支持图片预处理，请更换现代浏览器后重试。": ["This browser does not support image preprocessing. Please retry with a modern browser.", "当前浏览器不支持图片预处理，请更换现代浏览器后重试。"],
    "请选择 JPG、PNG 或 WebP 图片。": ["Choose a JPG, PNG, or WebP image.", "请选择 JPG、PNG 或 WebP 图片。"],
    "环境保护": ["Environmental protection", "环境保护"],
    "校园笔记本": ["Campus notebook", "校园笔记本"],
    "适合日常记录公益活动心得。": ["Suitable for recording notes from daily public-welfare activities.", "适合日常记录公益活动心得。"],
    "饮品兑换券（10元）": ["Drink coupon (¥10)", "饮品兑换券（10元）"],
    "校内饮品店单次 10 元兑换券。": ["One-time ¥10 coupon for a campus drink shop.", "校内饮品店单次 10 元兑换券。"],
    "简约文具套装": ["Minimal stationery set", "简约文具套装"],
    "包含签字笔、尺子和便签等学习用品。": ["Includes pens, a ruler, memo notes, and other study tools.", "包含签字笔、尺子和便签等学习用品。"],
    "校园接驳车单次票": ["Campus shuttle single ride", "校园接驳车单次票"],
    "校内接驳车单次乘车权益。": ["One ride on the campus shuttle service.", "校内接驳车单次乘车权益。"],
    "自习室预约（2小时）": ["Study room booking (2 hours)", "自习室预约（2小时）"],
    "可兑换校内共享自习空间 2 小时。": ["Redeem 2 hours in a shared campus study room.", "可兑换校内共享自习空间 2 小时。"],
    "体育馆单次使用券": ["Gym single-entry pass", "体育馆单次使用券"],
    "单次场馆入场权益。": ["Single-entry access to the sports venue.", "单次场馆入场权益。"],
    "积分仅限本人使用，不可转让或折现。": ["Points are for personal use only and cannot be transferred or exchanged for cash.", "积分仅限本人使用，不可转让或折现。"],
    "兑换申请提交后会立即扣减积分并占用奖励库存。": ["Submitting a redemption request immediately deducts points and reserves reward inventory.", "兑换申请提交后会立即扣减积分并占用奖励库存。"],
    "请确保联系方式可用，管理员会通过站内记录或联系信息跟进兑换。": ["Please make sure your contact details are valid. Admins will follow up using site records or the contact information provided.", "请确保联系方式可用，管理员会通过站内记录或联系信息跟进兑换。"],
    "如奖励库存不足或规则变更，管理员可拒绝申请并回退积分。": ["If inventory runs out or the rules change, admins may reject the request and restore the points.", "如奖励库存不足或规则变更，管理员可拒绝申请并回退积分。"]
  };
  const placeholderMap: Record<string, [string, string]> = {
    "手机号 / 学号 / 管理员账号": ["Phone number / Student ID / Admin account", "手机号 / 学号 / 管理员账号"],
    "请输入密码": ["Enter your password", "请输入密码"],
    "手机号 / 学号": ["Phone number / Student ID", "手机号 / 学号"],
    "例如：校园环保志愿社": ["Example: Campus Green Volunteer Club", "例如：校园环保志愿社"],
    "排行榜中展示的名称": ["Name shown on the leaderboard", "排行榜中展示的名称"],
    "不少于 8 位": ["At least 8 characters", "不少于 8 位"],
    "再次输入密码": ["Enter the password again", "再次输入密码"],
    "例如：2026 年 5 月 21 日，我们在校园东区主干道开展垃圾清理和绿化维护活动。": ["Example: On May 21, 2026, we carried out trash cleanup and greenery maintenance on the main road in the east campus area.", "例如：2026 年 5 月 21 日，我们在校园东区主干道开展垃圾清理和绿化维护活动。"],
    "手机号 / 邮箱 / 学号": ["Phone / Email / Student ID", "手机号 / 邮箱 / 学号"],
    "例如：希望线下领取": ["Example: Prefer offline pickup", "例如：希望线下领取"],
    "例如：人工确认是现场活动，可发放积分。": ["Example: Confirmed manually as an on-site activity; points can be issued.", "例如：人工确认是现场活动，可发放积分。"],
    "例如：图片过于模糊，无法确认是公益现场；建议重新提交更清晰图片。": ["Example: The image is too blurry to confirm a real public-welfare scene. Please resubmit a clearer photo.", "例如：图片过于模糊，无法确认是公益现场；建议重新提交更清晰图片。"]
  };
  return `
    (() => {
      const storageKey = "jzib_lang_mode";
      const cookieKey = "jzib_lang_mode";
      const textMap = ${JSON.stringify(textMap)};
      const placeholderMap = ${JSON.stringify(placeholderMap)};
      const patternResolvers = [
        [/^库存\\s*(\\d+)$/, (m) => ({ en: "Stock " + m[1], zh: "库存 " + m[1] })],
        [/^当前积分\\s*(-?\\d+)$/, (m) => ({ en: "Current points " + m[1], zh: "当前积分 " + m[1] })],
        [/^(\\d+)\\s*积分$/, (m) => ({ en: m[1] + " points", zh: m[1] + " 积分" })],
        [/^(\\d+)\\s*条$/, (m) => ({ en: m[1] + " items", zh: m[1] + " 条" })],
        [/^压缩后大小：(\\d+)KB$/, (m) => ({ en: "Compressed size: " + m[1] + "KB", zh: "压缩后大小：" + m[1] + "KB" })],
        [/^提交时间：(.+)$/, (m) => ({ en: "Submitted: " + m[1], zh: "提交时间：" + m[1] })],
        [/^发放积分：(.+)$/, (m) => ({ en: "Points awarded: " + m[1], zh: "发放积分：" + m[1] })],
        [/^审核完成：(.+)$/, (m) => ({ en: "Reviewed: " + m[1], zh: "审核完成：" + m[1] })],
        [/^(\\d{4}) 年 (\\d{2}) 月统计$/, (m) => ({ en: m[1] + "-" + m[2] + " summary", zh: m[1] + " 年 " + m[2] + " 月统计" })],
        [/^(.+) 积分 · 库存 (\\d+)$/, (m) => ({ en: m[1] + " points · Stock " + m[2], zh: m[1] + " 积分 · 库存 " + m[2] })],
        [/^你好，(.+?)。这里可以查看积分余额、最近提交和本月排行榜概览。$/, (m) => ({ en: "Hello, " + m[1] + ". Review your balance, recent submissions, and this month's leaderboard summary.", zh: "你好，" + m[1] + "。这里可以查看积分余额、最近提交和本月排行榜概览。" })],
        [/^AI 分析失败：(.+)$/, (m) => ({ en: "AI analysis failed: " + m[1], zh: "AI 分析失败：" + m[1] })],
        [/^图片压缩后仍超过 (\\d+)KB，请重新选择更小的图片。$/, (m) => ({ en: "The compressed image is still larger than " + m[1] + "KB. Please choose a smaller file.", zh: "图片压缩后仍超过 " + m[1] + "KB，请重新选择更小的图片。" })]
      ];
      let mode = readMode();
      let applying = false;
      let queued = false;
      let observer = null;

      function readMode() {
        try {
          const saved = window.localStorage.getItem(storageKey);
          if (saved === "en" || saved === "zh") return saved;
        } catch {}
        const match = document.cookie.match(new RegExp("(?:^|; )" + cookieKey + "=(en|zh)"));
        return match ? match[1] : "en";
      }

      function saveMode(nextMode) {
        mode = nextMode === "zh" ? "zh" : "en";
        try {
          window.localStorage.setItem(storageKey, mode);
        } catch {}
        document.cookie = cookieKey + "=" + mode + "; path=/; max-age=31536000; SameSite=Lax";
        document.documentElement.lang = mode === "en" ? "en" : "zh-CN";
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function resolvePair(text) {
        const direct = textMap[text];
        if (direct) {
          return { en: direct[0], zh: direct[1] };
        }
        for (const [pattern, resolver] of patternResolvers) {
          const match = text.match(pattern);
          if (match) {
            return resolver(match);
          }
        }
        return null;
      }

      function chooseDisplay(element) {
        if (!(element instanceof HTMLElement)) return "inline";
        if (element.matches("h1, h2, h3, p, .helper-text, .brand-caption, .eyebrow, .message, .empty-state")) {
          return "stack";
        }
        return "inline";
      }

      function renderPair(element) {
        const en = element.dataset.i18nEn;
        const zh = element.dataset.i18nZh;
        if (!en || !zh) return;
        const primary = mode === "en" ? en : zh;
        const secondary = mode === "en" ? zh : en;
        const display = element.dataset.i18nDisplay || chooseDisplay(element);
        element.dataset.i18nDisplay = display;
        element.innerHTML =
          display === "stack"
            ? '<span class="i18n-copy stack"><span class="i18n-primary">' +
              escapeHtml(primary) +
              '</span><span class="i18n-secondary">' +
              escapeHtml(secondary) +
              "</span></span>"
            : '<span class="i18n-copy inline"><span class="i18n-primary">' +
              escapeHtml(primary) +
              '</span><span class="i18n-sep"> / </span><span class="i18n-secondary">' +
              escapeHtml(secondary) +
              "</span></span>";
      }

      function applyElement(element) {
        if (!(element instanceof HTMLElement)) return;
        if (element.closest("[data-i18n-skip='1']")) return;
        if (element.dataset.i18nEn && element.dataset.i18nZh) {
          renderPair(element);
          return;
        }
        if (element.childElementCount > 0) return;
        const raw = (element.textContent || "").trim();
        if (!raw) return;
        const pair = resolvePair(raw);
        if (!pair) return;
        element.dataset.i18nEn = pair.en;
        element.dataset.i18nZh = pair.zh;
        renderPair(element);
      }

      function applyPlaceholder(element) {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
        const raw = element.dataset.i18nPlaceholderRaw || element.getAttribute("placeholder") || "";
        if (!raw) return;
        const direct = placeholderMap[raw];
        let pair = direct ? { en: direct[0], zh: direct[1] } : resolvePair(raw);
        if (!pair) return;
        element.dataset.i18nPlaceholderRaw = raw;
        element.setAttribute("placeholder", mode === "en" ? pair.en + " / " + pair.zh : pair.zh + " / " + pair.en);
      }

      function applyDocumentTitle() {
        const suffix = " - JZIB 公益积分站";
        const rawTitle = document.title.endsWith(suffix) ? document.title.slice(0, -suffix.length) : document.title;
        const pair = resolvePair(rawTitle);
        const brand = mode === "en" ? "JZIB Public Welfare Points" : "JZIB 公益积分站";
        if (pair) {
          document.title = (mode === "en" ? pair.en : pair.zh) + " - " + brand;
        } else if (!document.title.includes(brand)) {
          document.title = rawTitle + " - " + brand;
        }
      }

      function ensureToggle() {
        let toggle = document.querySelector("[data-language-toggle]");
        if (!toggle) {
          toggle = document.createElement("div");
          toggle.className = "language-floating-toggle";
          toggle.setAttribute("data-language-toggle", "1");
          toggle.innerHTML =
            '<button type="button" data-lang-option="en">EN</button>' +
            '<button type="button" data-lang-option="zh">中文</button>';
          document.body.appendChild(toggle);
        }
        toggle.querySelectorAll("[data-lang-option]").forEach((button) => {
          button.classList.toggle("active", button.getAttribute("data-lang-option") === mode);
          if (!button.dataset.bound) {
            button.dataset.bound = "1";
            button.addEventListener("click", () => {
              saveMode(button.getAttribute("data-lang-option") || "en");
              scheduleApply();
            });
          }
        });
      }

      function scheduleApply() {
        if (applying) {
          queued = true;
          return;
        }
        window.requestAnimationFrame(applyAll);
      }

      function applyAll() {
        if (applying) return;
        applying = true;
        ensureToggle();
        document.querySelectorAll("*").forEach((element) => applyElement(element));
        document.querySelectorAll("input[placeholder], textarea[placeholder]").forEach((element) => applyPlaceholder(element));
        applyDocumentTitle();
        document.querySelectorAll("[data-lang-option]").forEach((button) => {
          button.classList.toggle("active", button.getAttribute("data-lang-option") === mode);
        });
        applying = false;
        if (queued) {
          queued = false;
          scheduleApply();
        }
      }

      function boot() {
        saveMode(mode);
        applyAll();
        if (!observer && document.body) {
          observer = new MutationObserver(() => scheduleApply());
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        }
      }

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot, { once: true });
      } else {
        boot();
      }
    })();
  `;
}

function uploadPageScript(): string {
  return `
    const input = document.getElementById("imageInput");
    const preview = document.getElementById("upload-preview");
    const placeholder = document.getElementById("upload-placeholder");
    const meta = document.getElementById("upload-meta");
    const form = document.getElementById("upload-form");
    const submitButton = form?.querySelector('button[type="submit"]');
    const maxOutputBytes = ${MAX_UPLOAD_BYTES};
    const maxSourceBytes = 20 * 1024 * 1024;
    const maxSourcePixels = 40_000_000;
    const maxEdge = 1600;
    const workerTimeoutMs = 20000;
    let previewUrl = "";
    let isProcessing = false;
    let compressionWorker = null;

    function setMeta(message) {
      if (meta) {
        meta.textContent = message;
      }
    }

    function setBusy(nextBusy, message) {
      isProcessing = nextBusy;
      if (input) input.disabled = nextBusy;
      if (submitButton) submitButton.disabled = nextBusy;
      if (form) form.setAttribute("aria-busy", String(nextBusy));
      if (message) setMeta(message);
    }

    function resetPreview() {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = "";
      }
      if (preview) {
        preview.innerHTML = "";
        preview.classList.add("hidden");
      }
      if (placeholder) {
        placeholder.classList.remove("hidden");
      }
    }

    function sanitizeFileName(name) {
      return (name || "upload").replace(/\\.[^.]+$/, "").slice(0, 80) || "upload";
    }

    function createCompressionWorker() {
      if (compressionWorker || !window.Worker || !window.OffscreenCanvas || !window.createImageBitmap) {
        return compressionWorker;
      }
      const workerSource = [
        "self.onmessage = async (event) => {",
        "  const data = event.data || {};",
        "  const file = data.file;",
        "  const maxBytes = Number(data.maxBytes) || 1200000;",
        "  const maxPixels = Number(data.maxPixels) || 40000000;",
        "  const maxEdge = Number(data.maxEdge) || 1600;",
        "  try {",
        "    if (!file) throw new Error(\\"未接收到图片文件\\");",
        "    const bitmap = await createImageBitmap(file);",
        "    const originalWidth = bitmap.width || 0;",
        "    const originalHeight = bitmap.height || 0;",
        "    if (!originalWidth || !originalHeight) throw new Error(\\"无法读取图片尺寸\\");",
        "    if (originalWidth * originalHeight > maxPixels) throw new Error(\\"图片分辨率过高，请先压缩后再上传\\");",
        "    let scale = Math.min(1, maxEdge / Math.max(originalWidth, originalHeight));",
        "    let width = Math.max(1, Math.round(originalWidth * scale));",
        "    let height = Math.max(1, Math.round(originalHeight * scale));",
        "    let quality = 0.88;",
        "    let blob = null;",
        "    for (let attempt = 0; attempt < 8; attempt += 1) {",
        "      const canvas = new OffscreenCanvas(width, height);",
        "      const ctx = canvas.getContext(\\"2d\\", { alpha: false });",
        "      if (!ctx) throw new Error(\\"浏览器不支持图片压缩\\");",
        "      ctx.drawImage(bitmap, 0, 0, width, height);",
        "      blob = await canvas.convertToBlob({ type: \\"image/jpeg\\", quality });",
        "      if (blob.size <= maxBytes) break;",
        "      if (quality > 0.56) {",
        "        quality = Math.max(0.46, quality - 0.12);",
        "      } else {",
        "        width = Math.max(1, Math.round(width * 0.85));",
        "        height = Math.max(1, Math.round(height * 0.85));",
        "        quality = 0.82;",
        "      }",
        "    }",
        "    if (typeof bitmap.close === \\"function\\") bitmap.close();",
        "    if (!blob) throw new Error(\\"浏览器无法压缩该图片\\");",
        "    if (blob.size > maxBytes) throw new Error(\\"图片压缩后仍超过 1.2MB，请先在本地压缩后再上传\\");",
        "    self.postMessage({ ok: true, blob, width, height, originalWidth, originalHeight });",
        "  } catch (error) {",
        "    self.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });",
        "  }",
        "};"
      ].join("\\n");
      const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "application/javascript" }));
      compressionWorker = new Worker(workerUrl);
      URL.revokeObjectURL(workerUrl);
      return compressionWorker;
    }

    function compressImageInWorker(file) {
      const worker = createCompressionWorker();
      if (!worker) return null;
      return new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          worker.onmessage = null;
          reject(new Error("图片处理超时，请先压缩后再上传。"));
        }, workerTimeoutMs);
        worker.onmessage = (event) => {
          window.clearTimeout(timeoutId);
          worker.onmessage = null;
          const payload = event.data || {};
          if (!payload.ok || !(payload.blob instanceof Blob)) {
            reject(new Error(payload.message || "图片压缩失败"));
            return;
          }
          resolve(
            new File([payload.blob], sanitizeFileName(file.name) + ".jpg", {
              type: "image/jpeg"
            })
          );
        };
        worker.postMessage({
          file,
          maxBytes: maxOutputBytes,
          maxPixels: maxSourcePixels,
          maxEdge
        });
      });
    }

    async function compressImageOnMainThread(file) {
      if (!window.createImageBitmap) {
        throw new Error("当前浏览器不支持图片预处理，请更换现代浏览器后重试。");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 16));
      const bitmap = await createImageBitmap(file);
      try {
        if ((bitmap.width || 0) * (bitmap.height || 0) > maxSourcePixels) {
          throw new Error("图片分辨率过高，请先压缩后再上传。");
        }
        let width = bitmap.width;
        let height = bitmap.height;
        if (Math.max(width, height) > maxEdge) {
          const scale = maxEdge / Math.max(width, height);
          width = Math.max(1, Math.round(width * scale));
          height = Math.max(1, Math.round(height * scale));
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) {
          throw new Error("浏览器无法压缩该图片");
        }
        ctx.drawImage(bitmap, 0, 0, width, height);

        let quality = 0.88;
        let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        while (blob && blob.size > maxOutputBytes && quality > 0.46) {
          quality -= 0.12;
          blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        }

        if (!blob) {
          throw new Error("浏览器无法压缩该图片");
        }
        if (blob.size > maxOutputBytes) {
          throw new Error("图片压缩后仍超过 1.2MB，请先在本地压缩后再上传。");
        }
        return new File([blob], sanitizeFileName(file.name) + ".jpg", { type: "image/jpeg" });
      } finally {
        if (typeof bitmap.close === "function") {
          bitmap.close();
        }
      }
    }

    async function compressImage(file) {
      if (!file.type.startsWith("image/")) {
        throw new Error("请选择 JPG、PNG 或 WebP 图片。");
      }
      if (file.size > maxSourceBytes) {
        throw new Error("原图过大，请先压缩到 20MB 以内再上传。");
      }
      const compressedByWorker = await compressImageInWorker(file);
      if (compressedByWorker) {
        return compressedByWorker;
      }
      return compressImageOnMainThread(file);
    }

    input?.addEventListener("change", async () => {
      const file = input.files?.[0];
      resetPreview();
      if (!file) {
        setMeta("建议上传现场拍摄的 JPG / PNG 图片，压缩后不超过 1.2MB。");
        return;
      }
      setBusy(true, "正在处理图片，请稍候…");
      try {
        const compressed = await compressImage(file);
        const dt = new DataTransfer();
        dt.items.add(compressed);
        input.files = dt.files;
        previewUrl = URL.createObjectURL(compressed);
        preview.innerHTML = '<img src="' + previewUrl + '" alt="上传预览" />';
        preview.classList.remove("hidden");
        placeholder.classList.add("hidden");
        setMeta("压缩后大小：" + Math.round(compressed.size / 1024) + "KB");
      } catch (error) {
        if (input) {
          input.value = "";
        }
        resetPreview();
        setMeta(error instanceof Error ? error.message : "图片压缩失败");
      } finally {
        setBusy(false);
      }
    });

    form?.addEventListener("submit", (event) => {
      if (isProcessing) {
        event.preventDefault();
        setMeta("图片仍在处理中，请稍候再提交。");
        return;
      }
      const file = input.files?.[0];
      if (file) {
        setBusy(true, "正在上传并触发 AI 分析…");
      }
    });
  `;
}

function styles(): string {
  return `
    :root {
      --bg: #f5f1e7;
      --bg-deep: #ece3d1;
      --panel: rgba(255, 255, 255, 0.86);
      --panel-strong: rgba(255, 255, 255, 0.94);
      --panel-soft: rgba(255, 255, 255, 0.72);
      --green: #0e7c4f;
      --green-dark: #08563a;
      --green-soft: #dff5ea;
      --green-glow: rgba(14, 124, 79, 0.12);
      --blue: #2457a6;
      --blue-dark: #10243b;
      --blue-soft: rgba(37, 99, 235, 0.12);
      --slate: #1f2937;
      --slate-soft: #6b7280;
      --slate-faint: #94a3b8;
      --amber: #f59e0b;
      --red: #dc2626;
      --red-soft: #fee2e2;
      --line: rgba(15, 23, 42, 0.08);
      --line-strong: rgba(15, 23, 42, 0.12);
      --shadow: 0 24px 60px rgba(31, 41, 55, 0.08);
      --shadow-soft: 0 16px 34px rgba(31, 41, 55, 0.06);
      --shadow-tight: 0 8px 18px rgba(31, 41, 55, 0.06);
      --radius: 24px;
      --radius-lg: 32px;
      --radius-md: 20px;
      --max-width: 1380px;
    }
    * { box-sizing: border-box; }
    html { min-height: 100%; }
    body {
      margin: 0;
      font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: var(--slate);
      position: relative;
      isolation: isolate;
      background:
        radial-gradient(circle at top left, rgba(22, 163, 74, 0.1), transparent 32%),
        radial-gradient(circle at top right, rgba(245, 158, 11, 0.1), transparent 28%),
        radial-gradient(circle at 75% 25%, rgba(255, 214, 102, 0.06), transparent 22%),
        linear-gradient(180deg, #faf6ef 0%, var(--bg) 56%, var(--bg-deep) 100%);
      min-height: 100vh;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(circle at 12% 18%, rgba(223, 245, 234, 0.78), transparent 18%),
        radial-gradient(circle at 86% 12%, rgba(254, 240, 138, 0.34), transparent 16%),
        radial-gradient(circle at 88% 76%, rgba(223, 245, 234, 0.42), transparent 18%);
      z-index: -1;
    }
    a { color: inherit; text-decoration: none; }
    img { display: block; }
    form { margin: 0; }
    .language-floating-toggle {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 40;
      display: inline-flex;
      gap: 6px;
      padding: 6px;
      border-radius: 999px;
      border: 1px solid rgba(15, 23, 42, 0.1);
      background: rgba(255, 255, 255, 0.92);
      box-shadow: 0 14px 28px rgba(15, 23, 42, 0.12);
      backdrop-filter: blur(16px);
    }
    .language-floating-toggle button {
      border: none;
      min-width: 62px;
      min-height: 40px;
      padding: 10px 14px;
      border-radius: 999px;
      background: transparent;
      color: var(--slate-soft);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      transition: 160ms ease;
    }
    .language-floating-toggle button.active {
      background: linear-gradient(135deg, rgba(14, 124, 79, 0.14), rgba(255, 255, 255, 0.92));
      color: var(--green-dark);
      box-shadow: var(--shadow-tight);
    }
    .admin-shell ~ .language-floating-toggle button.active {
      background: linear-gradient(135deg, rgba(37, 99, 235, 0.16), rgba(255, 255, 255, 0.94));
      color: var(--blue-dark);
    }
    .i18n-copy {
      display: inline-flex;
      align-items: baseline;
      gap: 0;
      flex-wrap: wrap;
    }
    .i18n-copy.stack {
      display: grid;
      gap: 3px;
    }
    .i18n-primary {
      color: inherit;
      font: inherit;
    }
    .i18n-secondary {
      color: var(--slate-soft);
      font-size: 0.84em;
      line-height: 1.45;
    }
    .i18n-copy.inline .i18n-secondary {
      margin-left: 6px;
    }
    .i18n-sep {
      color: var(--slate-faint);
      margin: 0 4px;
    }
    .tag .i18n-secondary,
    .nav-link .i18n-secondary,
    .btn .i18n-secondary,
    .tab .i18n-secondary,
    .shell-kicker .i18n-secondary,
    .eyebrow .i18n-secondary {
      color: inherit;
      opacity: 0.78;
    }
    .guest-shell {
      max-width: var(--max-width);
      margin: 0 auto;
      padding: 32px 32px 56px;
    }
    .guest-shell-auth {
      min-height: 100vh;
      display: grid;
      align-content: start;
      gap: 22px;
    }
    .guest-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
    }
    .guest-header nav { display: flex; gap: 12px; flex-wrap: wrap; }
    .guest-header nav a,
    .tab,
    .btn,
    .nav-link {
      transition: 180ms ease;
    }
    .guest-header nav a {
      padding: 10px 16px;
      border-radius: 999px;
      color: var(--slate-soft);
      border: 1px solid rgba(15, 23, 42, 0.08);
      background: rgba(255, 255, 255, 0.58);
      backdrop-filter: blur(12px);
    }
    .guest-header nav a.active {
      background: rgba(223, 245, 234, 0.92);
      color: var(--green-dark);
      box-shadow: var(--shadow-tight);
    }
    .brand-lockup {
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .brand {
      font-weight: 800;
      font-size: 30px;
      line-height: 1.05;
      color: var(--green-dark);
      letter-spacing: -0.04em;
    }
    .brand-caption {
      color: var(--slate-soft);
      font-size: 14px;
      letter-spacing: 0.02em;
    }
    .brand-lockup-sidebar { gap: 12px; }
    .brand-caption-sidebar {
      color: rgba(255, 255, 255, 0.72);
      max-width: 180px;
      font-size: 13px;
      line-height: 1.6;
    }
    .hero-card,
    .panel,
    .metric-card,
    .reward-card,
    .message,
    .sidebar-card,
    .leaderboard-card,
    .topbar-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }
    .hero-card {
      padding: 22px;
      border-radius: var(--radius-lg);
      overflow: hidden;
    }
    .auth-hero {
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(360px, 440px);
      gap: 22px;
      align-items: stretch;
    }
    .hero-copy {
      min-height: 620px;
      padding: 46px;
      border-radius: 30px;
      border: 1px solid rgba(15, 23, 42, 0.06);
      background:
        radial-gradient(circle at 78% 26%, rgba(255, 214, 102, 0.18), transparent 18%),
        radial-gradient(circle at 18% 14%, rgba(223, 245, 234, 0.72), transparent 20%),
        linear-gradient(145deg, rgba(252, 249, 241, 0.92), rgba(244, 239, 226, 0.78));
      position: relative;
      overflow: hidden;
      display: grid;
      align-content: space-between;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
    }
    .hero-copy::before {
      content: "";
      position: absolute;
      right: -52px;
      bottom: -76px;
      width: 260px;
      height: 260px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(14, 124, 79, 0.14), transparent 70%);
    }
    .hero-copy::after {
      content: "";
      position: absolute;
      inset: auto auto 42px 42px;
      width: 96px;
      height: 4px;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--green) 0%, rgba(14, 124, 79, 0.2) 100%);
      opacity: 0.9;
    }
    .hero-copy-admin {
      background:
        radial-gradient(circle at 82% 22%, rgba(191, 219, 254, 0.28), transparent 18%),
        radial-gradient(circle at 14% 18%, rgba(255, 214, 102, 0.16), transparent 18%),
        linear-gradient(145deg, rgba(248, 251, 255, 0.92), rgba(239, 244, 253, 0.8));
    }
    .hero-copy-admin::before {
      background: radial-gradient(circle, rgba(37, 99, 235, 0.16), transparent 70%);
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
    .hero-chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 24px;
    }
    .hero-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid rgba(14, 124, 79, 0.14);
      background: rgba(255, 255, 255, 0.66);
      color: var(--green-dark);
      font-size: 14px;
      font-weight: 700;
      box-shadow: var(--shadow-tight);
    }
    .feature-list {
      margin: 20px 0 0;
      padding-left: 18px;
      display: grid;
      gap: 8px;
    }
    .feature-list.compact {
      margin-top: 10px;
      padding-left: 20px;
    }
    .feature-list-cards {
      list-style: none;
      padding: 0;
      gap: 12px;
    }
    .feature-list-cards li {
      padding: 14px 16px;
      border-radius: 18px;
      border: 1px solid rgba(15, 23, 42, 0.06);
      background: rgba(255, 255, 255, 0.62);
      box-shadow: var(--shadow-soft);
      font-weight: 600;
      line-height: 1.7;
    }
    .hero-stat-strip {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 26px;
    }
    .hero-stat {
      padding: 16px 18px;
      border-radius: 20px;
      border: 1px solid rgba(15, 23, 42, 0.06);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.84), rgba(249, 246, 238, 0.74));
      display: grid;
      gap: 6px;
    }
    .hero-stat strong {
      font-size: 28px;
      line-height: 1;
      letter-spacing: -0.04em;
      color: var(--green-dark);
    }
    .hero-stat span {
      color: var(--slate-soft);
      font-size: 13px;
    }
    .hero-stat-strip-soft .hero-stat {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(253, 247, 233, 0.8));
    }
    .auth-panel,
    .stack {
      display: grid;
      gap: 16px;
    }
    .auth-panel {
      min-height: 620px;
      align-content: start;
      padding: 32px;
      border-radius: 30px;
      border: 1px solid rgba(15, 23, 42, 0.06);
      background: rgba(255, 255, 255, 0.92);
      box-shadow: var(--shadow-soft);
    }
    .auth-panel-admin {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(244, 248, 255, 0.92));
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
    .auth-hero-admin .tab.active {
      color: var(--blue-dark);
    }
    .auth-panel-copy {
      display: grid;
      gap: 8px;
      padding: 18px 20px;
      border-radius: 20px;
      border: 1px solid rgba(15, 23, 42, 0.06);
      background: linear-gradient(135deg, rgba(223, 245, 234, 0.56), rgba(255, 255, 255, 0.9));
    }
    .auth-panel-admin .auth-panel-copy {
      background: linear-gradient(135deg, rgba(231, 238, 255, 0.74), rgba(255, 255, 255, 0.92));
    }
    .auth-panel-copy strong {
      font-size: 22px;
      letter-spacing: -0.03em;
    }
    .auth-panel-copy p {
      margin: 0;
      color: var(--slate-soft);
      line-height: 1.7;
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
      background: rgba(255, 255, 255, 0.98);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.76);
      transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
    }
    textarea { resize: vertical; min-height: 120px; }
    input:focus,
    textarea:focus,
    select:focus {
      outline: none;
      border-color: rgba(14, 124, 79, 0.34);
      box-shadow: 0 0 0 4px rgba(14, 124, 79, 0.12);
      background: rgba(255, 255, 255, 1);
    }
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
      min-height: 52px;
      box-shadow: var(--shadow-tight);
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--green) 0%, #18a36a 100%);
      color: white;
    }
    .btn-secondary {
      background: rgba(14, 124, 79, 0.1);
      color: var(--green-dark);
      border: 1px solid rgba(14, 124, 79, 0.08);
    }
    .btn-danger {
      background: linear-gradient(135deg, #d62839 0%, #ef4444 100%);
      color: white;
    }
    .btn-ghost {
      background: rgba(255, 255, 255, 0.68);
      border: 1px solid rgba(15, 23, 42, 0.12);
    }
    .admin-shell .btn-secondary {
      background: rgba(37, 99, 235, 0.12);
      color: var(--blue-dark);
      border-color: rgba(37, 99, 235, 0.12);
    }
    .btn:hover,
    .nav-link:hover,
    .tab:hover { transform: translateY(-1px); }
    .btn:disabled,
    .btn:disabled:hover {
      opacity: 0.66;
      cursor: wait;
      transform: none;
      box-shadow: none;
    }
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
      background: rgba(255, 255, 255, 0.72);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 18px;
      display: grid;
      gap: 8px;
      box-shadow: var(--shadow-soft);
    }
    .app-shell {
      display: grid;
      grid-template-columns: 286px minmax(0, 1fr);
      min-height: 100vh;
    }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 28px 22px;
      background: linear-gradient(180deg, #095e3d 0%, var(--green) 54%, #08563a 100%);
      color: white;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 24px;
      overflow: hidden;
      isolation: isolate;
    }
    .sidebar::before {
      content: "";
      position: absolute;
      inset: auto -84px -86px auto;
      width: 260px;
      height: 260px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(255, 255, 255, 0.14), transparent 68%);
      z-index: 0;
    }
    .sidebar.dark { background: linear-gradient(180deg, #10243b 0%, #0b1a2d 54%, #081523 100%); }
    .sidebar .brand { color: white; }
    .nav-list { display: grid; gap: 10px; align-content: start; position: relative; z-index: 1; }
    .nav-link {
      border-radius: 18px;
      padding: 14px 16px;
      font-weight: 700;
      color: rgba(255,255,255,0.82);
      background: rgba(255,255,255,0.04);
      border: 1px solid transparent;
      backdrop-filter: blur(10px);
    }
    .nav-link.active {
      background: linear-gradient(135deg, rgba(255,255,255,0.18), rgba(255,255,255,0.1));
      color: white;
      border-color: rgba(255,255,255,0.08);
      box-shadow: 0 18px 32px rgba(5, 17, 28, 0.14);
    }
    .sidebar-card {
      padding: 20px;
      display: grid;
      gap: 6px;
      color: var(--slate);
      position: relative;
      z-index: 1;
    }
    .sidebar-card strong { font-size: 20px; }
    .sidebar-card span { color: var(--slate-soft); }
    .sidebar-card b { font-size: 30px; letter-spacing: -0.03em; color: var(--green-dark); }
    .dark-card {
      background: rgba(255,255,255,0.08);
      color: white;
      border-color: rgba(255,255,255,0.1);
      box-shadow: none;
    }
    .dark-card span,
    .dark-card b { color: rgba(255, 255, 255, 0.78); }
    .dark-card b { font-size: 20px; color: white; }
    .main-shell {
      padding: 28px;
      width: 100%;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 20px;
    }
    .topbar-card {
      padding: 18px 22px;
      border-radius: 28px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(251, 249, 244, 0.88));
    }
    .topbar span { color: var(--slate-soft); display: block; margin-top: 6px; }
    .topbar strong {
      display: block;
      font-size: 26px;
      letter-spacing: -0.03em;
    }
    .topbar-actions {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
    .shell-kicker {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(14, 124, 79, 0.12);
      color: var(--green-dark);
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 10px;
    }
    .shell-kicker-admin {
      background: rgba(37, 99, 235, 0.14);
      color: var(--blue-dark);
    }
    .topbar-pill {
      padding: 12px 16px;
      border-radius: 18px;
      border: 1px solid rgba(14, 124, 79, 0.12);
      background: linear-gradient(135deg, rgba(223, 245, 234, 0.72), rgba(255, 250, 240, 0.78));
      display: grid;
      gap: 4px;
      min-width: 110px;
    }
    .topbar-pill b {
      font-size: 28px;
      line-height: 1;
      color: var(--green-dark);
    }
    .message {
      padding: 15px 18px;
      margin-bottom: 18px;
      font-weight: 600;
      border-radius: 20px;
    }
    .message.success { background: rgba(236, 253, 243, 0.92); color: var(--green-dark); }
    .message.error { background: rgba(255, 241, 242, 0.92); color: #991b1b; }
    .page-hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 18px;
      margin-bottom: 22px;
    }
    .page-hero > div:first-child {
      display: grid;
      gap: 10px;
    }
    .cards-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .cards-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .metric-card {
      padding: 24px;
      display: grid;
      gap: 10px;
      min-height: 160px;
      position: relative;
      overflow: hidden;
    }
    .metric-card::after {
      content: "";
      position: absolute;
      top: -22px;
      right: -22px;
      width: 128px;
      height: 128px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(14, 124, 79, 0.12), transparent 70%);
    }
    .admin-shell .metric-card::after {
      background: radial-gradient(circle, rgba(37, 99, 235, 0.12), transparent 70%);
    }
    .metric-card strong { font-size: 46px; letter-spacing: -0.04em; line-height: 1; }
    .metric-card span,
    .metric-card small { color: var(--slate-soft); }
    .accent-card {
      background: linear-gradient(135deg, rgba(14,124,79,0.14), rgba(255,255,255,0.94));
    }
    .hero-actions {
      display: flex;
      align-items: stretch;
      justify-content: flex-end;
      gap: 14px;
      flex-wrap: wrap;
    }
    .hero-note-card {
      max-width: 320px;
      padding: 18px 20px;
      border-radius: 22px;
      border: 1px solid rgba(14, 124, 79, 0.12);
      background: linear-gradient(135deg, rgba(223, 245, 234, 0.8), rgba(255, 255, 255, 0.88));
      box-shadow: var(--shadow-soft);
      display: grid;
      gap: 8px;
    }
    .hero-note-card strong { font-size: 18px; letter-spacing: -0.02em; }
    .hero-note-card span { color: var(--slate-soft); }
    .admin-note-card {
      border-color: rgba(37, 99, 235, 0.16);
      background: linear-gradient(135deg, rgba(231, 238, 255, 0.82), rgba(255, 255, 255, 0.92));
    }
    .split-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(320px, 420px);
      gap: 20px;
      margin-bottom: 20px;
      align-items: start;
    }
    .split-layout.records-layout {
      grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
      align-items: start;
    }
    .split-layout.no-gap { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .panel {
      padding: 24px;
      position: relative;
      overflow: hidden;
    }
    .subtle-panel {
      background: rgba(255,255,255,0.78);
      box-shadow: var(--shadow-soft);
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
    .detail-panel h2 { margin: 0; font-size: 30px; letter-spacing: -0.03em; }
    .panel-head a {
      color: var(--green-dark);
      font-weight: 700;
    }
    .admin-shell .panel-head a {
      color: var(--blue-dark);
    }
    .submission-row {
      display: grid;
      grid-template-columns: 92px minmax(0, 1fr) auto;
      gap: 16px;
      align-items: center;
      padding: 14px;
      border: 1px solid rgba(15,23,42,0.08);
      border-radius: 22px;
      background: rgba(255,255,255,0.74);
      box-shadow: var(--shadow-tight);
    }
    .submission-row.selected {
      border-color: rgba(14,124,79,0.3);
      background: linear-gradient(135deg, rgba(223,245,234,0.72), rgba(255,255,255,0.88));
      box-shadow: 0 18px 34px rgba(14, 124, 79, 0.1);
    }
    .admin-shell .submission-row.selected {
      border-color: rgba(37,99,235,0.26);
      background: linear-gradient(135deg, rgba(231,238,255,0.82), rgba(255,255,255,0.92));
      box-shadow: 0 18px 34px rgba(37, 99, 235, 0.1);
    }
    .submission-row img,
    .detail-image {
      width: 100%;
      border-radius: 20px;
      object-fit: cover;
      background: #eef3ef;
    }
    .submission-row img { height: 92px; }
    .detail-image {
      max-height: 460px;
      margin-bottom: 18px;
      box-shadow: var(--shadow-soft);
    }
    .submission-row-main {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .submission-row-main strong,
    .leaderboard-row strong,
    .reward-card h3 { overflow-wrap: anywhere; }
    .submission-row-main span {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      color: var(--slate-soft);
    }
    .submission-row-points {
      font-weight: 800;
      font-size: 20px;
      color: var(--green-dark);
      white-space: nowrap;
    }
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
      background: rgba(255,255,255,0.82);
    }
    .leaderboard-row.self { outline: 2px solid rgba(14,124,79,0.18); }
    .reward-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .reward-card {
      padding: 20px;
      display: grid;
      gap: 14px;
      background: rgba(255,255,255,0.9);
      position: relative;
      overflow: hidden;
    }
    .reward-card.selected {
      border-color: rgba(14,124,79,0.28);
      background: linear-gradient(180deg, rgba(223,245,234,0.74), rgba(255,255,255,0.92));
      box-shadow: 0 18px 36px rgba(14, 124, 79, 0.12);
    }
    .reward-media {
      height: 164px;
      display: grid;
      place-items: center;
      border-radius: 22px;
      background: linear-gradient(135deg, rgba(14,124,79,0.12), rgba(255,214,102,0.14));
      overflow: hidden;
      padding: 0;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.42);
    }
    .reward-media img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }
    .reward-emoji {
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
    .reward-inline-icon,
    .reward-inline-media {
      width: 56px;
      height: 56px;
      display: grid;
      place-items: center;
      border-radius: 18px;
      background: rgba(14,124,79,0.08);
      overflow: hidden;
      flex: 0 0 56px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.58);
    }
    .reward-inline-media img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }
    .reward-inline-icon {
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
      border-radius: 22px;
      padding: 18px;
      border: 1px solid rgba(15,23,42,0.08);
      background: rgba(255,255,255,0.76);
      margin-bottom: 14px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.58);
    }
    .detail-card span,
    .info-card strong,
    .warning-box strong,
    .error-box strong { display: block; margin-bottom: 8px; }
    .detail-card strong { font-size: 24px; }
    .warning-box {
      background: rgba(255, 247, 237, 0.88);
      border-color: rgba(245, 158, 11, 0.24);
    }
    .error-box {
      background: rgba(254, 242, 242, 0.9);
      border-color: rgba(220, 38, 38, 0.22);
    }
    .info-card p,
    .warning-box p,
    .error-box p { margin: 0; }
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
      min-height: 340px;
      border: 2px dashed rgba(14,124,79,0.28);
      border-radius: 28px;
      background: linear-gradient(180deg, rgba(223,245,234,0.36), rgba(255,255,255,0.9));
      text-align: center;
      cursor: pointer;
      position: relative;
      overflow: hidden;
    }
    .upload-dropzone::before {
      content: "";
      position: absolute;
      right: -54px;
      bottom: -86px;
      width: 220px;
      height: 220px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(255, 214, 102, 0.18), transparent 72%);
    }
    .upload-dropzone input[type="file"] { display: none; }
    form[aria-busy="true"] .upload-dropzone {
      opacity: 0.78;
      cursor: wait;
    }
    .upload-preview {
      width: 100%;
      display: grid;
      gap: 12px;
      justify-items: center;
    }
    .upload-preview img {
      width: min(100%, 560px);
      max-height: 320px;
      object-fit: cover;
      border-radius: 22px;
      box-shadow: var(--shadow);
    }
    .hidden { display: none; }
    .table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      overflow: hidden;
      border-radius: 22px;
    }
    .table th,
    .table td {
      text-align: left;
      padding: 14px 12px;
      border-bottom: 1px solid rgba(15, 23, 42, 0.08);
    }
    .table thead th {
      background: rgba(248, 246, 240, 0.92);
      color: var(--slate);
      font-weight: 700;
    }
    .table tbody tr:hover { background: rgba(255, 255, 255, 0.54); }
    .highlight-row { background: rgba(223,245,234,0.4); }
    .month-picker {
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 14px 16px;
      border-radius: 20px;
      background: rgba(255,255,255,0.8);
      border: 1px solid rgba(15, 23, 42, 0.08);
      box-shadow: var(--shadow-soft);
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
      padding: 36px 18px;
      text-align: center;
      border-radius: 20px;
      border: 1px dashed rgba(15, 23, 42, 0.1);
      background: rgba(248, 246, 240, 0.68);
    }
    .empty-state.tall { min-height: 320px; display: grid; place-items: center; }
    .error-shell {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 40px 24px;
    }
    .error-card {
      max-width: 560px;
      margin: 0 auto;
      padding: 44px 40px;
      display: grid;
      gap: 18px;
      justify-items: center;
      text-align: center;
    }
    .error-card h1 {
      margin: 0;
      font-size: clamp(38px, 6vw, 54px);
      line-height: 1.05;
      letter-spacing: -0.04em;
    }
    .error-card p {
      margin: 0;
      max-width: 34ch;
    }
    .admin-shell .panel,
    .admin-shell .metric-card,
    .admin-shell .topbar-card,
    .admin-shell .leaderboard-card {
      border-color: rgba(37, 99, 235, 0.1);
    }
    @media (max-width: 1180px) {
      .auth-hero,
      .split-layout,
      .split-layout.records-layout,
      .split-layout.no-gap,
      .cards-4,
      .cards-3,
      .reward-grid,
      .detail-grid,
      .hero-stat-strip,
      .tip-grid {
        grid-template-columns: 1fr;
      }
      .app-shell { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
        border-right: none;
      }
      .page-hero,
      .topbar,
      .topbar-actions {
        flex-direction: column;
        align-items: stretch;
      }
      .nav-list {
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      }
      .auth-panel,
      .hero-copy {
        min-height: auto;
      }
      .hero-copy {
        padding: 34px;
      }
      .hero-actions {
        justify-content: stretch;
      }
      .month-picker,
      .hero-note-card {
        max-width: none;
      }
      .table {
        display: block;
        overflow-x: auto;
        white-space: nowrap;
      }
    }
    @media (max-width: 720px) {
      .guest-shell,
      .main-shell {
        padding: 20px 16px 28px;
      }
      .language-floating-toggle {
        right: 12px;
        bottom: 12px;
      }
      .guest-header {
        flex-direction: column;
        align-items: stretch;
      }
      .guest-header nav {
        justify-content: flex-start;
      }
      .hero-card,
      .panel,
      .metric-card,
      .reward-card,
      .topbar-card {
        border-radius: 24px;
      }
      .auth-panel,
      .hero-copy {
        padding: 24px;
      }
      .tab-row {
        flex-direction: column;
      }
      .sidebar {
        padding: 22px 16px;
      }
      .nav-list {
        grid-template-columns: 1fr 1fr;
      }
      .page-hero h1,
      .hero-copy h1 {
        font-size: clamp(32px, 9vw, 44px);
      }
      .panel-head h2,
      .panel h3,
      .detail-panel h2 {
        font-size: 24px;
      }
      .topbar strong {
        font-size: 22px;
      }
      .metric-card strong,
      .topbar-pill b {
        font-size: 36px;
      }
      .submission-row {
        grid-template-columns: 1fr;
      }
      .submission-row-points {
        justify-self: start;
      }
      .auth-links {
        flex-wrap: wrap;
      }
      .detail-meta {
        flex-direction: column;
        gap: 8px;
      }
      .upload-dropzone {
        min-height: 260px;
        padding: 22px;
      }
      .error-card {
        padding: 32px 24px;
      }
    }
  `;
}

export default app;
