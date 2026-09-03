/**
 * 桌面管理端鉴权测试：验证 adminOnly 的 x-admin-token / ADMIN_TOKEN 通道，
 * 以及它不影响小程序网关通道、不越权访问用户路由。
 * 运行：node tools/test-admin-token.js
 */
const path = require("path");
const http = require("http");

/* —— 内存模型桩（与 test-user-routes.js 同构） —— */
function makeTable(keyOf) {
  const rows = new Map();
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
      return [n];
    },
    async upsert(rec) { rows.set(keyOf(rec), Object.assign({}, rows.get(keyOf(rec)) || { createdAt: ++seq }, rec)); },
    async count({ where = {} } = {}) {
      let n = 0;
      for (const r of rows.values()) if (Object.keys(where).every(f => r[f] === where[f])) n++;
      return n;
    },
    rows,
  };
}

const Users = new Map();
function makeUser(openid) {
  const user = { openid, nickname: "微信用户", avatar: null, loggedOut: false, async update(patch) { Object.assign(user, patch); } };
  Users.set(openid, user);
  return user;
}

const dbStub = (() => {
  const Product = makeTable(r => r.id);
  const Category = makeTable(r => r.id);
  const Banner = makeTable(r => "b:" + (r.img || "") + "|" + (r.t1 || ""));
  const HotKeyword = makeTable(r => r.word);
  Product.bulkCreate([
    { id: "p01", cat: "c1", sub: "中性笔", name: "演示笔", brand: "", price: 9.9, orig: null, img: "https://oss/p01.jpg", tag: "", rating: 5, sold: 0, desc: "", specs: [], images: ["https://oss/p01.jpg"], online: true },
  ]);
  Category.bulkCreate([{ id: "c1", name: "办公文具", icon: "edit", subs: ["中性笔", "笔记本"] }]);
  return {
    ready: () => true,
    models: () => ({
      User: { async findOrCreate({ where: { openid } }) { return [Users.get(openid) || makeUser(openid), !Users.has(openid)]; } },
      Favorite: makeTable(r => r.openid + "|" + r.productId),
      ViewHistory: makeTable(r => r.openid + "|" + r.productId),
      SearchHistory: makeTable(r => r.openid + "|" + r.keyword),
      Product, Category, Banner, HotKeyword,
    }),
    sequelize: () => ({ async transaction(fn) { return fn(); } }),
  };
})();

const dbPath = require.resolve(path.join(__dirname, '..', 'db'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };

const Koa = require(path.join(__dirname, '..', 'node_modules', 'koa'));
const userRoutes = require(path.join(__dirname, '..', 'routes', 'user'));
const adminRoutes = require(path.join(__dirname, '..', 'routes', 'admin'));
if (typeof adminRoutes.routes !== 'function' || typeof adminRoutes.isAdmin !== 'function') {
  console.error("✗ admin 路由模块导出形态错误");
  process.exit(1);
}

const app = new Koa();
const bodyParser = require(path.join(__dirname, '..', 'node_modules', 'koa-bodyparser'));
app.use(bodyParser());
app.use(userRoutes.routes()).use(userRoutes.allowedMethods());
app.use(adminRoutes.routes()).use(adminRoutes.allowedMethods());

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.error("  ✗", name, extra === undefined ? "" : JSON.stringify(extra)); }
}

function req(method, p, { body, openid, source = true, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { "content-type": "application/json" };
    if (openid) { headers["x-wx-openid"] = openid; if (source) headers["x-wx-source"] = "wx"; }
    if (token !== undefined) headers["x-admin-token"] = token;
    const r = http.request({ host: "127.0.0.1", port: server.address().port, path: p, method, headers }, rp => {
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
  const TK = "tk_desktop_9f8e7d6c";

  console.log("ADMIN_TOKEN 未配置时:");
  delete process.env.ADMIN_TOKEN;
  process.env.ADMIN_OPENIDS = "admin-od";
  let r = await req("GET", "/api/admin/products", { token: TK });
  check("带 token 头但不配置 ADMIN_TOKEN → code:1", r.json.code === 1, r.json);
  r = await req("GET", "/api/admin/products", { openid: "admin-od" });
  check("微信白名单通道不受影响", r.json.code === 0, r.json);

  console.log("ADMIN_TOKEN 配置后（鉴权矩阵）:");
  process.env.ADMIN_TOKEN = TK;
  r = await req("GET", "/api/admin/products", { token: "wrong-token" });
  check("错误 token → code:1 非管理员", r.json.code === 1 && r.json.msg === "非管理员", r.json);
  r = await req("GET", "/api/admin/products", { token: "x" + TK });
  check("token 前插字符 → 拒绝（精确匹配）", r.json.code === 1, r.json);
  r = await req("GET", "/api/admin/products", {});
  check("无任何凭证 → code:1", r.json.code === 1, r.json);
  r = await req("GET", "/api/admin/products", { token: TK });
  check("正确 token → code:0", r.json.code === 0 && Array.isArray(r.json.data), r.json);
  process.env.ADMIN_OPENIDS = ""; // 清空白名单，token 通道必须独立可用
  r = await req("GET", "/api/admin/products", { token: TK });
  check("白名单清空后 token 仍可用（通道独立）", r.json.code === 0, r.json);
  r = await req("GET", "/api/admin/products", { openid: "admin-od" });
  check("白名单清空后微信通道拒绝", r.json.code === 1, r.json);
  process.env.ADMIN_OPENIDS = "admin-od";

  console.log("token 通道全接口（CRUD / 上下架 / OSS）:");
  r = await req("POST", "/api/admin/products", { token: TK, body: { name: "桌面端商品", cat: "c1", sub: "中性笔", price: 19.9, img: "https://oss/d1.jpg", images: ["https://oss/d1.jpg", "https://oss/d2.jpg"], online: true } });
  check("token 创建商品", r.json.code === 0 && r.json.data.id, r.json);
  const pid = r.json.data && r.json.data.id;
  r = await req("PUT", "/api/admin/products/" + pid, { token: TK, body: { online: false, price: 29.9 } });
  check("token 更新 + 下架", r.json.code === 0, r.json);
  r = await req("GET", "/api/admin/products", { token: TK });
  const row = r.json.data.find(x => x.id === pid);
  check("更新生效", row && row.online === false && Number(row.price) === 29.9, row);
  r = await req("DELETE", "/api/admin/products/" + pid, { token: TK });
  check("token 删除商品", r.json.code === 0, r.json);
  r = await req("GET", "/api/admin/categories", { token: TK });
  check("token 分类列表（含 productCount）", r.json.code === 0 && r.json.data[0].productCount === 1, r.json.data);
  r = await req("PUT", "/api/admin/banners", { token: TK, body: { banners: [{ img: "https://oss/b1.jpg", t1: "t", t2: "" }] } });
  check("token Banner 替换", r.json.code === 0 && r.json.data.length === 1, r.json);
  r = await req("PUT", "/api/admin/hot-keywords", { token: TK, body: { words: ["笔"] } });
  check("token 热搜词替换", r.json.code === 0 && r.json.data[0] === "笔", r.json);
  process.env.OSS_ACCESS_KEY_ID = "ak-test";
  process.env.OSS_ACCESS_KEY_SECRET = "sk-test";
  process.env.OSS_BUCKET = "bg-bucket";
  process.env.OSS_REGION = "oss-cn-beijing";
  r = await req("GET", "/api/admin/upload-token?ext=jpg", { token: TK });
  const t = r.json.data || {};
  check("token 取 OSS 上传凭证", r.json.code === 0 && /^https:\/\/bg-bucket\.oss-cn-beijing\.aliyuncs\.com$/.test(t.host || "") && t.key && t.policy && t.signature && t.OSSAccessKeyId === "ak-test", r.json);

  console.log("越权边界:");
  r = await req("GET", "/api/user/profile", { token: TK });
  check("token 不能读取用户路由（无 openid）→ code:1", r.json.code === 1, r.json);
  r = await req("GET", "/api/favorites", { token: TK });
  check("token 不能读取收藏 → code:1", r.json.code === 1, r.json);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  server.close();
  process.exit(failed ? 1 : 0);
});
