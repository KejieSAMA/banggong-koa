/* 商城目录接口：统一返回 { code: 0, data, msg }，img 为 /images/* 相对路径（客户端拼接域名）
   数据源由 db.catalog() 决定：有 MySQL 读库，无库回落静态 data/db.js */
const Router = require("koa-router");
const db = require("../db");

const IMG = "/images/";
const router = new Router({ prefix: "/api" });

const ok = (ctx, data, msg = "") => {
  ctx.body = { code: 0, data, msg };
};

/* 完整 URL（OSS）/ data URL 直接透传，相对路径拼图床前缀；图集逐项同规则 */
const passImg = img => /^(https?:|data:)/.test(img || "") ? img : IMG + img;
const withImg = p => Object.assign({}, p, {
  img: passImg(p.img),
  images: (p.images || []).map(passImg),
});

router.get("/banners", async ctx => {
  const c = await db.catalog();
  ok(ctx, c.banners.map(b => Object.assign({}, b, { img: IMG + b.img })));
});

router.get("/categories", async ctx => {
  const c = await db.catalog();
  ok(ctx, c.cats);
});

router.get("/products", async ctx => {
  const c = await db.catalog();
  ok(ctx, c.products.map(withImg));
});

router.get("/products/:id", async ctx => {
  const c = await db.catalog();
  const p = c.products.find(x => x.id === ctx.params.id);
  if (p) ok(ctx, withImg(p));
  else ok(ctx, null, "商品不存在");
});

router.get("/hot-keywords", async ctx => {
  const c = await db.catalog();
  ok(ctx, c.hotKeywords);
});

module.exports = router;
