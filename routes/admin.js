/**
 * 管理端路由：商品增删改 / 上下架 + OSS 直传凭证。
 * 管理员识别：环境变量 ADMIN_OPENIDS（逗号分隔 openid 白名单）；
 * 非管理员 / 无库 / 公网直访统一 code:1（客户端提示无权限）。
 */
const Router = require("koa-router");
const crypto = require("crypto");
const db = require("../db");

const router = new Router({ prefix: "/api/admin" });

const ok = (ctx, data, msg = "") => { ctx.body = { code: 0, data, msg }; };
const deny = (ctx, msg = "无权限或数据库未初始化") => { ctx.body = { code: 1, data: null, msg }; };

const adminOpenids = () => String(process.env.ADMIN_OPENIDS || "").split(",").map(s => s.trim()).filter(Boolean);
const isAdmin = openid => adminOpenids().indexOf(String(openid)) >= 0;

/* 管理员前置校验：库就绪 + 网关身份（x-wx-source 防伪造）+ 白名单；通过返回 openid */
async function adminOnly(ctx) {
  if (!db.ready()) { deny(ctx); return null; }
  const h = ctx.request.headers;
  const openid = h["x-wx-openid"] || "";
  if (!h["x-wx-source"] || !openid || !isAdmin(openid)) { deny(ctx, "非管理员"); return null; }
  return openid;
}

/* —— 商品字段清洗：返回 { patch, error }（PUT 只更新传入字段） —— */
function sanitize(body) {
  const b = body || {};
  const patch = {};
  if (typeof b.name === "string") {
    const v = b.name.trim();
    if (!v) return { error: "商品名称不能为空" };
    patch.name = v.slice(0, 255);
  }
  if (typeof b.brand === "string") patch.brand = b.brand.trim().slice(0, 128);
  if (typeof b.cat === "string") patch.cat = b.cat.trim().slice(0, 32);
  if (typeof b.sub === "string") patch.sub = b.sub.trim().slice(0, 64);
  if (typeof b.img === "string") {
    if (!b.img) return { error: "请上传商品图片" };
    patch.img = b.img.slice(0, 1024); // 相对路径或完整 URL（OSS）
  }
  if (b.price !== undefined && b.price !== null && b.price !== "") {
    const v = Number(b.price);
    if (!(v >= 0)) return { error: "价格格式不正确" };
    patch.price = v;
  }
  if (b.orig !== undefined && b.orig !== null && b.orig !== "") {
    const v = Number(b.orig);
    if (!(v >= 0)) return { error: "原价格式不正确" };
    patch.orig = v;
  } else if ("orig" in b) {
    patch.orig = null; // 显式传空 = 清除划线价
  }
  if (typeof b.tag === "string") patch.tag = ["hot", "new"].indexOf(b.tag) >= 0 ? b.tag : null;
  if (b.rating !== undefined && b.rating !== null && b.rating !== "") {
    patch.rating = Math.min(5, Math.max(1, Number(b.rating) || 5));
  }
  if (b.sold !== undefined && b.sold !== null && b.sold !== "") {
    patch.sold = Math.max(0, parseInt(b.sold, 10) || 0);
  }
  if (typeof b.desc === "string") patch.desc = b.desc.slice(0, 2000);
  if (Array.isArray(b.specs)) {
    patch.specs = b.specs
      .filter(s => Array.isArray(s) && typeof s[0] === "string" && typeof s[1] === "string" && s[0].trim() && s[1].trim())
      .slice(0, 20)
      .map(s => [s[0].trim().slice(0, 32), s[1].trim().slice(0, 128)]);
  }
  if (typeof b.online === "boolean") patch.online = b.online;
  return { patch };
}

/* —— 商品管理 —— */
router.get("/products", async ctx => {
  if (!(await adminOnly(ctx))) return;
  const { Product } = db.models();
  ok(ctx, await Product.findAll({ raw: true, order: [["id", "ASC"]] }));
});

router.post("/products", async ctx => {
  if (!(await adminOnly(ctx))) return;
  const { patch, error } = sanitize(ctx.request.body);
  if (error) { deny(ctx, error); return; }
  for (const f of ["name", "cat", "sub", "price", "img"]) {
    if (patch[f] === undefined) { deny(ctx, "缺少必填字段：" + f); return; }
  }
  const { Product } = db.models();
  const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await Product.create(Object.assign({ rating: 5, sold: 0, brand: "", desc: "", specs: [], online: true }, patch, { id }));
  ok(ctx, { id });
});

router.put("/products/:id", async ctx => {
  if (!(await adminOnly(ctx))) return;
  const { patch, error } = sanitize(ctx.request.body);
  if (error) { deny(ctx, error); return; }
  if (!Object.keys(patch).length) { deny(ctx, "没有可更新字段"); return; }
  const { Product } = db.models();
  const [n] = await Product.update(patch, { where: { id: ctx.params.id } });
  if (!n) { deny(ctx, "商品不存在"); return; }
  ok(ctx, { id: ctx.params.id });
});

router.delete("/products/:id", async ctx => {
  if (!(await adminOnly(ctx))) return;
  const { Product } = db.models();
  await Product.destroy({ where: { id: ctx.params.id } });
  ok(ctx, { id: ctx.params.id }); // 幂等
});

/* —— OSS 直传凭证（PostObject 表单签名；AK/SK 只留在服务端环境变量） —— */
router.get("/upload-token", async ctx => {
  if (!(await adminOnly(ctx))) return;
  const { OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, OSS_REGION, OSS_DIR = "" } = process.env;
  if (!OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET || !OSS_BUCKET || !OSS_REGION) {
    deny(ctx, "未配置 OSS 环境变量（OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET / OSS_REGION）");
    return;
  }
  const dir = OSS_DIR.replace(/^\/+|\/+$/g, "");
  const ext = String(ctx.query.ext || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "jpg";
  const key = (dir ? dir + "/" : "") + "prod_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + "." + ext;
  const policy = Buffer.from(JSON.stringify({
    expiration: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    conditions: [
      { bucket: OSS_BUCKET },
      ["starts-with", "$key", dir ? dir + "/" : ""],
      ["content-length-range", 1, 5 * 1024 * 1024], // 单图 ≤5MB
    ],
  })).toString("base64");
  const signature = crypto.createHmac("sha1", OSS_ACCESS_KEY_SECRET).update(policy).digest("base64");
  ok(ctx, {
    host: "https://" + OSS_BUCKET + "." + OSS_REGION + ".aliyuncs.com",
    key, policy, OSSAccessKeyId: OSS_ACCESS_KEY_ID, signature,
  });
});

/* 直接导出 router 实例（与 mall/user 一致，index.js 用 admin.routes() 挂载）；
   isAdmin 挂为属性供 user.js 判断管理员标记 */
module.exports = router;
module.exports.isAdmin = isAdmin;
