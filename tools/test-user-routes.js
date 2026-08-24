/**
 * 用户路由免库测试：向 require 缓存注入内存版 db 桩，起临时 koa 实例，
 * 验证 profile / favorites / history / search-history 的鉴权、置顶去重、裁剪与全量替换逻辑。
 * 运行：node tools/test-user-routes.js
 */
const path = require("path");
const http = require("http");
const { pathToFileURL } = require("url");

/* —— 内存模型桩：模拟 sequelize 子集语义 —— */
function makeTable(keyOf) {
  const rows = new Map(); // key -> record
  let seq = 0;
  return {
    async findAll({ where = {}, order = [], limit = Infinity } = {}) {
      let list = [...rows.values()].filter(r => Object.keys(where).every(k => r[k] === where[k]));
      const [field, dir] = order[0] || [];
      if (field) list.sort((a, b) => (dir === "DESC" ? b[field] - a[field] : a[field] - b[field]));
      return list.slice(0, limit);
    },
    async destroy({ where = {} } = {}) {
      let n = 0;
      for (const [k, r] of rows) {
        const hit = Object.keys(where).every(f =>
          Array.isArray(where[f]) ? where[f].includes(r[f]) : r[f] === where[f]);
        if (hit) { rows.delete(k); n++; }
      }
      return n;
    },
    async bulkCreate(recs) { for (const r of recs) rows.set(keyOf(r), Object.assign({ createdAt: ++seq }, r)); },
    async create(rec) { rows.set(keyOf(rec), Object.assign({ createdAt: ++seq }, rec)); return rec; },
    async update(patch, { where = {} } = {}) {
      let n = 0;
      for (const r of rows.values()) {
        if (Object.keys(where).every(f => r[f] === where[f])) { Object.assign(r, patch); n++; }
      }
      return [n]; // sequelize 静态 update 返回 [受影响行数]
    },
    async upsert(rec) { rows.set(keyOf(rec), Object.assign({}, rows.get(keyOf(rec)) || { createdAt: ++seq }, rec)); },
    rows,
  };
}

const Users = new Map();
function makeUser(openid) {
  const user = {
    openid, nickname: "微信用户", avatar: null, loggedOut: false,
    async update(patch) { Object.assign(user, patch); },
  };
  Users.set(openid, user);
  return user;
}

const dbStub = (() => {
  const Favorite = makeTable(r => r.openid + "|" + r.productId);
  const ViewHistory = makeTable(r => r.openid + "|" + r.productId);
  const SearchHistory = makeTable(r => r.openid + "|" + r.keyword);
  const Product = makeTable(r => r.id);
  return {
    ready: () => true,
    /* 与真实 db.js 接口保持一致：sequelize 实例在 db.sequelize()，不在 models() 里 */
    models: () => ({
      User: { async findOrCreate({ where: { openid } }) { return [Users.get(openid) || makeUser(openid), !Users.has(openid)]; } },
      Favorite,
      ViewHistory,
      SearchHistory,
      Product,
    }),
    sequelize: () => ({ async transaction(fn) { return fn(); } }),
  };
})();

/* —— 注入桩到 require 缓存（必须在加载路由前） —— */
const dbPath = require.resolve(path.join(__dirname, '..', 'db'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };

const Koa = require(path.join(__dirname, '..', 'node_modules', 'koa'));
const userRoutes = require(path.join(__dirname, '..', 'routes', 'user'));
const adminRoutes = require(path.join(__dirname, '..', 'routes', 'admin'));

const app = new Koa();
app.use(async (ctx, next) => {
  ctx.set("Access-Control-Allow-Origin", "*");
  await next();
});
const bodyParser = require(path.join(__dirname, '..', 'node_modules', 'koa-bodyparser'));
app.use(bodyParser());
app.use(userRoutes.routes()).use(userRoutes.allowedMethods());
app.use(adminRoutes.router.routes()).use(adminRoutes.router.allowedMethods());

/* —— 断言工具 —— */
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.error("  ✗", name, extra === undefined ? "" : JSON.stringify(extra)); }
}

function req(method, p, { body, openid, source = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: "127.0.0.1", port: server.address().port, path: p, method,
      headers: Object.assign(
        { "content-type": "application/json" },
        openid ? Object.assign({ "x-wx-openid": openid }, source ? { "x-wx-source": "wx" } : {}) : {}
      ),
    }, rp => {
      let s = ""; rp.on("data", d => s += d);
      rp.on("end", () => resolve({ status: rp.statusCode, json: s ? JSON.parse(s) : null }));
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const server = http.createServer(app.callback());
server.listen(0, "127.0.0.1", async () => {
  const OD = "test-openid";

  console.log("鉴权与降级:");
  let r = await req("GET", "/api/user/profile");
  check("无 openid → code:1", r.json.code === 1);
  r = await req("GET", "/api/user/profile", { openid: OD, source: false });
  check("公网伪造 openid（无 x-wx-source）→ code:1", r.json.code === 1);
  r = await req("GET", "/api/user/profile", { openid: OD });
  check("有 openid + x-wx-source → 自动建档 code:0", r.json.code === 0 && r.json.data.nickname === "微信用户");

  console.log("资料更新:");
  r = await req("PUT", "/api/user/profile", { openid: OD, body: { nickname: " 办公达人 ", avatar: "data:image/png;base64,xxx" } });
  check("昵称 trim 保存 + 头像", r.json.data.nickname === "办公达人" && r.json.data.avatar.startsWith("data:image"));

  console.log("登录（确定性默认昵称 + 退出保留资料）:");
  const OD2 = "login-openid";
  r = await req("POST", "/api/user/login", { openid: OD2 });
  check("首次登录生成 用户XXXXXX", /^用户[0-9a-z]{6}$/.test(r.json.data.nickname), r.json.data);
  const stableName = r.json.data.nickname;
  await req("PUT", "/api/user/profile", { openid: OD2, body: { loggedOut: true } });
  r = await req("GET", "/api/user/profile", { openid: OD2 });
  check("退出登录：资料保留 + loggedOut=true", r.json.data.nickname === stableName && r.json.data.loggedOut === true, r.json.data);
  r = await req("POST", "/api/user/login", { openid: OD2 });
  check("重新登录：昵称不变 + loggedOut=false", r.json.data.nickname === stableName && r.json.data.loggedOut === false, r.json.data);
  await req("PUT", "/api/user/profile", { openid: OD2, body: { nickname: "自定义昵称", avatar: "data:image/png;base64,yyy" } });
  r = await req("POST", "/api/user/login", { openid: OD2 });
  check("改过资料后重登：保留自定义昵称头像", r.json.data.nickname === "自定义昵称" && r.json.data.avatar.startsWith("data:image"));

  console.log("登录（污染自愈）:");
  const OD3 = "polluted-openid";
  r = await req("POST", "/api/user/login", { openid: OD3 });
  const detName = r.json.data.nickname;
  Users.get(OD3).nickname = "用户zzzz99"; // 模拟旧版客户端写入的随机昵称（named=false）
  r = await req("POST", "/api/user/login", { openid: OD3 });
  check("污染随机昵称 → 登录自愈为确定性昵称", r.json.data.nickname === detName && detName !== "用户zzzz99", { detName, now: r.json.data.nickname });

  console.log("收藏（全量替换）:");
  await req("POST", "/api/favorites", { openid: OD, body: { ids: ["p01", "p02", "p02"] } });
  r = await req("GET", "/api/favorites", { openid: OD });
  check("去重后 2 条", JSON.stringify(r.json.data) === JSON.stringify(["p01", "p02"]), r.json.data);
  await req("POST", "/api/favorites", { openid: OD, body: { ids: ["p09"] } });
  r = await req("GET", "/api/favorites", { openid: OD });
  check("全量替换后仅 p09", JSON.stringify(r.json.data) === JSON.stringify(["p09"]), r.json.data);
  r = await req("POST", "/api/favorites", { openid: OD, body: { ids: "bad" } });
  check("非法 ids → code:1", r.json.code === 1);

  console.log("足迹（置顶去重 + 裁剪 20）:");
  for (let i = 1; i <= 22; i++) await req("POST", "/api/history", { openid: OD, body: { id: "p" + String(i).padStart(2, "0") } });
  await req("POST", "/api/history", { openid: OD, body: { id: "p01" } }); // 置顶
  r = await req("GET", "/api/history", { openid: OD });
  check("裁剪至 20 条", r.json.data.length === 20, r.json.data.length);
  check("重复浏览置顶", r.json.data[0] === "p01", r.json.data[0]);
  check("最旧的 p02 被裁掉", !r.json.data.includes("p02"), r.json.data);

  console.log("足迹（单条删除）:");
  r = await req("DELETE", "/api/history/p05", { openid: OD });
  check("单条删除 code:0", r.json.code === 0);
  r = await req("GET", "/api/history", { openid: OD });
  check("删除后不含 p05", !r.json.data.includes("p05"), r.json.data);
  r = await req("DELETE", "/api/history/p05", { openid: OD });
  check("重复删除幂等 code:0", r.json.code === 0);
  r = await req("GET", "/api/history", { openid: "other-openid" });
  check("单条删除不影响他人", r.json.data.length === 0);

  r = await req("DELETE", "/api/history", { openid: OD });
  check("清空足迹", JSON.stringify(r.json.data) === "[]");

  console.log("搜索历史（置顶去重 + 裁剪 8）:");
  for (let i = 1; i <= 9; i++) await req("POST", "/api/search-history", { openid: OD, body: { q: "关键词" + i } });
  await req("POST", "/api/search-history", { openid: OD, body: { q: "关键词1" } });
  r = await req("GET", "/api/search-history", { openid: OD });
  check("裁剪至 8 条", r.json.data.length === 8, r.json.data);
  check("重复搜索置顶", r.json.data[0] === "关键词1", r.json.data[0]);
  r = await req("DELETE", "/api/search-history", { openid: OD });
  check("清空搜索历史", JSON.stringify(r.json.data) === "[]");

  console.log("数据隔离:");
  await req("POST", "/api/favorites", { openid: OD, body: { ids: ["p01"] } });
  r = await req("GET", "/api/favorites", { openid: "other-openid" });
  check("不同 openid 互不可见", JSON.stringify(r.json.data) === "[]", r.json.data);

  console.log("管理端（鉴权 / 商品 CRUD / 上下架 / OSS）:");
  process.env.ADMIN_OPENIDS = "admin-od";
  r = await req("GET", "/api/admin/products", { openid: OD });
  check("非管理员 → code:1", r.json.code === 1);
  r = await req("GET", "/api/user/profile", { openid: "admin-od" });
  check("profile 返回 admin 标记与 openid", r.json.data.admin === true && r.json.data.openid === "admin-od", r.json.data);
  r = await req("GET", "/api/admin/products", { openid: "admin-od" });
  check("管理员列表 code:0", r.json.code === 0 && Array.isArray(r.json.data));
  r = await req("POST", "/api/admin/products", { openid: "admin-od", body: { name: " 测试商品 ", cat: "pen", sub: "中性笔", price: 9.9, img: "https://bucket.oss.example.com/a.jpg", specs: [["容量", "0.5mm"], ["颜色", "黑"], ["", "空键应被过滤"]] } });
  check("创建商品（specs 过滤空键）", r.json.code === 0 && r.json.data.id, r.json);
  const pid = r.json.data && r.json.data.id;
  r = await req("GET", "/api/admin/products", { openid: "admin-od" });
  const created = r.json.data.find(x => x.id === pid);
  check("列表含新商品且字段清洗生效", created && created.name === "测试商品" && Number(created.price) === 9.9 && created.specs.length === 2, created);
  r = await req("POST", "/api/admin/products", { openid: "admin-od", body: { cat: "pen", sub: "中性笔", price: 1, img: "a.jpg" } });
  check("缺少必填字段拒绝", r.json.code === 1);
  r = await req("PUT", "/api/admin/products/" + pid, { openid: "admin-od", body: { price: 19.9, online: false } });
  check("更新 + 下架", r.json.code === 0);
  r = await req("PUT", "/api/admin/products/not-exist", { openid: "admin-od", body: { price: 1 } });
  check("更新不存在 → code:1", r.json.code === 1);
  r = await req("GET", "/api/admin/products", { openid: "admin-od" });
  const updated = r.json.data.find(x => x.id === pid);
  check("下架状态与价格已更新", updated && updated.online === false && Number(updated.price) === 19.9, updated);
  r = await req("GET", "/api/admin/upload-token", { openid: "admin-od" });
  check("未配置 OSS → code:1", r.json.code === 1);
  r = await req("DELETE", "/api/admin/products/" + pid, { openid: "admin-od" });
  check("删除商品 code:0", r.json.code === 0);
  r = await req("GET", "/api/admin/products", { openid: "admin-od" });
  check("删除后列表不含", !r.json.data.some(x => x.id === pid));

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  server.close();
  process.exit(failed ? 1 : 0);
});
