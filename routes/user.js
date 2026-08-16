/**
 * 用户体系路由：身份来自云托管网关注入的 x-wx-openid 请求头。
 * 无 openid（公网直访/本地调试）或数据库未就绪时统一返回 code:1，
 * 客户端据此保持「本地模式」（数据仅存小程序 storage）。
 */
const Router = require("koa-router");
const db = require("../db");

const router = new Router({ prefix: "/api" });

const ok = (ctx, data, msg = "") => { ctx.body = { code: 0, data, msg }; };
const deny = (ctx, msg = "未登录或数据库未初始化") => { ctx.body = { code: 1, data: null, msg }; };

/* 单调时间戳（毫秒 + 进程内序号），避免同毫秒写入导致排序不稳定 */
let tick = 0;
const nowTick = () => Date.now() * 1000 + (++tick % 1000);

/* 从请求头解析 openid（云托管经小程序 callContainer 调用时自动携带） */
const openidOf = ctx => {
  const h = ctx.request.headers;
  return h["x-wx-openid"] || "";
};

const needUser = async ctx => {
  if (!db.ready()) { deny(ctx); return null; }
  const openid = openidOf(ctx);
  if (!openid) { deny(ctx); return null; }
  const { User } = db.models();
  const [user] = await User.findOrCreate({ where: { openid } });
  return user;
};

/* —— 资料 —— */
router.get("/user/profile", async ctx => {
  const user = await needUser(ctx);
  if (!user) return;
  ok(ctx, { nickname: user.nickname, avatar: user.avatar || "" });
});

router.put("/user/profile", async ctx => {
  const user = await needUser(ctx);
  if (!user) return;
  const { nickname, avatar } = ctx.request.body || {};
  const patch = {};
  if (typeof nickname === "string" && nickname.trim()) patch.nickname = nickname.trim().slice(0, 64);
  if (typeof avatar === "string") patch.avatar = avatar.slice(0, 512 * 1024); // data URL 上限 512KB
  await user.update(patch);
  ok(ctx, { nickname: user.nickname, avatar: user.avatar || "" });
});

/* —— 收藏（全量替换，幂等；保持客户端顺序：最新在前） —— */
router.get("/favorites", async ctx => {
  const user = await needUser(ctx);
  if (!user) return;
  const { Favorite } = db.models();
  const rows = await Favorite.findAll({ where: { openid: user.openid }, order: [["sort", "ASC"]], raw: true });
  ok(ctx, rows.map(r => r.productId));
});

router.post("/favorites", async ctx => {
  const user = await needUser(ctx);
  if (!user) return;
  const { ids } = ctx.request.body || {};
  if (!Array.isArray(ids)) { deny(ctx, "参数错误：ids 应为数组"); return; }
  const { Favorite } = db.models();
  const sequelize = db.sequelize();
  const clean = [...new Set(ids.filter(x => typeof x === "string"))].slice(0, 200);
  await sequelize.transaction(async t => {
    await Favorite.destroy({ where: { openid: user.openid }, transaction: t });
    if (clean.length) {
      await Favorite.bulkCreate(
        clean.map((id, idx) => ({ openid: user.openid, productId: id, sort: idx })),
        { transaction: t }
      );
    }
  });
  ok(ctx, clean);
});

/* —— 浏览足迹（置顶去重，保留 20 条） —— */
router.get("/history", async ctx => {
  const user = await needUser(ctx);
  if (!user) return;
  const { ViewHistory } = db.models();
  const rows = await ViewHistory.findAll({ where: { openid: user.openid }, order: [["at", "DESC"]], limit: 20, raw: true });
  ok(ctx, rows.map(r => r.productId));
});

router.post("/history", async ctx => {
  const user = await needUser(ctx);
  if (!user) return;
  const { id } = ctx.request.body || {};
  if (typeof id !== "string" || !id) { deny(ctx, "参数错误：id"); return; }
  const { ViewHistory } = db.models();
  await ViewHistory.upsert({ openid: user.openid, productId: id, at: nowTick() });
  /* 超出 20 条裁剪最旧的 */
  const rows = await ViewHistory.findAll({ where: { openid: user.openid }, order: [["at", "DESC"]], raw: true });
  const stale = rows.slice(20).map(r => r.productId);
  if (stale.length) await ViewHistory.destroy({ where: { openid: user.openid, productId: stale } });
  ok(ctx, rows.slice(0, 20).map(r => r.productId));
});

router.delete("/history", async ctx => {
  const user = await needUser(ctx);
  if (!user) return;
  const { ViewHistory } = db.models();
  await ViewHistory.destroy({ where: { openid: user.openid } });
  ok(ctx, []);
});

/* —— 搜索历史（置顶去重，保留 8 条） —— */
router.get("/search-history", async ctx => {
  const user = await needUser(ctx);
  if (!user) return;
  const { SearchHistory } = db.models();
  const rows = await SearchHistory.findAll({ where: { openid: user.openid }, order: [["at", "DESC"]], limit: 8, raw: true });
  ok(ctx, rows.map(r => r.keyword));
});

router.post("/search-history", async ctx => {
  const user = await needUser(ctx);
  if (!user) return;
  const { q } = ctx.request.body || {};
  if (typeof q !== "string" || !q.trim()) { deny(ctx, "参数错误：q"); return; }
  const keyword = q.trim().slice(0, 64);
  const { SearchHistory } = db.models();
  await SearchHistory.upsert({ openid: user.openid, keyword, at: nowTick() });
  const rows = await SearchHistory.findAll({ where: { openid: user.openid }, order: [["at", "DESC"]], raw: true });
  const stale = rows.slice(8).map(r => r.keyword);
  if (stale.length) await SearchHistory.destroy({ where: { openid: user.openid, keyword: stale } });
  ok(ctx, rows.slice(0, 8).map(r => r.keyword));
});

router.delete("/search-history", async ctx => {
  const user = await needUser(ctx);
  if (!user) return;
  const { SearchHistory } = db.models();
  await SearchHistory.destroy({ where: { openid: user.openid } });
  ok(ctx, []);
});

module.exports = router;
