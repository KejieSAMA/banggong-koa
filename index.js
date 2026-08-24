/**
 * 办公严选 · 后端入口（基于微信云托管 wxcloudrun-koa 模板）
 * - 模板原有：GET /（演示页）、GET|POST /api/count、GET /api/wx_openid
 * - 本项目新增：/api/banners|categories|products|products/:id|hot-keywords、/images/* 静态图片
 */
const Koa = require("koa");
const Router = require("koa-router");
const logger = require("koa-logger");
const bodyParser = require("koa-bodyparser");
const fs = require("fs");
const path = require("path");
const counter = require("./db");
const mall = require("./routes/mall");
const user = require("./routes/user");
const admin = require("./routes/admin");

const app = new Koa();

/* 统一错误兜底：打印堆栈（云日志可见）并返回 JSON，让客户端拿到具体错误信息 */
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (e) {
    console.error("[api] 接口异常:", ctx.method, ctx.url, "\n", (e && e.stack) || e);
    ctx.status = 500;
    ctx.body = { code: 500, data: null, msg: (e && e.message) || "服务器内部错误" };
  }
});

/* CORS：公网域名下的浏览器调试（小程序 callContainer 不需要） */
app.use(async (ctx, next) => {
  ctx.set("Access-Control-Allow-Origin", "*");
  ctx.set("Access-Control-Allow-Headers", "Content-Type, X-WX-SERVICE, X-WX-SOURCE");
  ctx.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (ctx.method === "OPTIONS") {
    ctx.status = 204;
    return;
  }
  await next();
});

const router = new Router();

/* 首页（模板演示页） */
router.get("/", async ctx => {
  ctx.type = "html";
  ctx.body = fs.readFileSync(path.join(__dirname, "index.html"), "utf-8");
});

/* 计数示例（模板原有，数据库不可用时内存降级） */
router.post("/api/count", async ctx => {
  const { action } = ctx.request.body || {};
  if (action === "inc") await counter.inc();
  else if (action === "clear") await counter.clear();
  ctx.body = { code: 0, data: await counter.count(), msg: "" };
});

router.get("/api/count", async ctx => {
  ctx.body = { code: 0, data: await counter.count(), msg: "" };
});

/* 小程序调用，获取微信 Open ID（模板原有） */
router.get("/api/wx_openid", async ctx => {
  if (ctx.request.headers["x-wx-source"]) {
    ctx.body = ctx.request.headers["x-wx-openid"];
  }
});

/* 静态图片：仅开放 images 目录，防目录穿越 */
const IMAGES_DIR = path.join(__dirname, "images");
const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
router.get("/images/:file", async ctx => {
  const file = path.basename(ctx.params.file);
  try {
    const buf = await fs.promises.readFile(path.join(IMAGES_DIR, file));
    ctx.type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    ctx.set("Cache-Control", "public, max-age=86400");
    ctx.body = buf;
  } catch (e) {
    ctx.status = 404;
    ctx.body = { code: 404, data: null, msg: "图片不存在" };
  }
});

app
  .use(logger())
  .use(bodyParser())
  .use(router.routes())
  .use(router.allowedMethods())
  .use(mall.routes())
  .use(mall.allowedMethods())
  .use(user.routes())
  .use(user.allowedMethods())
  .use(admin.routes())
  .use(admin.allowedMethods());

const port = process.env.PORT || 80;
async function bootstrap() {
  await counter.init();
  app.listen(port, () => {
    console.log("启动成功", port);
  });
}
bootstrap();
