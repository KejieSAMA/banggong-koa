/* 商城接口路由：统一返回 { code: 0, data, msg }，img 为 /images/* 相对路径（由客户端拼接域名） */
const Router = require("koa-router");
const { CATS, PRODUCTS, BANNERS, HOT_KEYWORDS } = require("../data/db");

const IMG = "/images/";
const router = new Router({ prefix: "/api" });

const ok = (ctx, data, msg = "") => {
  ctx.body = { code: 0, data, msg };
};

const withImg = p => Object.assign({}, p, { img: IMG + p.img });

router.get("/banners", async ctx => {
  ok(ctx, BANNERS.map(b => Object.assign({}, b, { img: IMG + b.img })));
});

router.get("/categories", async ctx => {
  ok(ctx, CATS);
});

router.get("/products", async ctx => {
  ok(ctx, PRODUCTS.map(withImg));
});

router.get("/products/:id", async ctx => {
  const p = PRODUCTS.find(x => x.id === ctx.params.id);
  if (p) ok(ctx, withImg(p));
  else ok(ctx, null, "商品不存在");
});

router.get("/hot-keywords", async ctx => {
  ok(ctx, HOT_KEYWORDS);
});

module.exports = router;
