/**
 * 数据层：MySQL 可选。
 * - 配置 MYSQL_USERNAME / MYSQL_PASSWORD / MYSQL_ADDRESS 时启用数据库：
 *   目录表（Product/Category/Banner/HotKeyword）+ 用户表（User/Favorite/ViewHistory/SearchHistory）
 *   首次启动自动建表；目录表为空时自动灌入 data/db.js 种子数据
 * - 未配置或连接失败时降级：目录接口回落静态数据，用户同步接口返回 code:1（客户端保持本地模式）
 * - 路由逻辑的免库测试见 tools/test-user-routes.js（注入内存桩）
 */
const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = "" } = process.env;

const HAS_MYSQL = Boolean(MYSQL_USERNAME && MYSQL_PASSWORD && MYSQL_ADDRESS);

let orm = null;          // { sequelize, models }
let memCount = 0;        // 无库时计数降级

async function init() {
  if (!HAS_MYSQL) {
    console.warn("[db] 未配置 MySQL 环境变量：目录回落静态数据，用户同步不可用（code:1），/api/count 用内存计数");
    return;
  }
  try {
    const { Sequelize, DataTypes } = require("sequelize");
    const [host, port] = (MYSQL_ADDRESS || "").split(":");
    const sequelize = new Sequelize("nodejs_demo", MYSQL_USERNAME, MYSQL_PASSWORD, {
      host,
      port,
      dialect: "mysql",
      logging: false,
    });

    /* —— 模板原有计数示例 —— */
    const Counter = sequelize.define("Counter", {
      count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    });

    /* —— 目录 —— */
    const Category = sequelize.define("Category", {
      id: { type: DataTypes.STRING(32), primaryKey: true },
      name: { type: DataTypes.STRING(64), allowNull: false },
      icon: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "" },
      subs: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    }, { tableName: "categories", timestamps: false });

    const Product = sequelize.define("Product", {
      id: { type: DataTypes.STRING(32), primaryKey: true },
      cat: { type: DataTypes.STRING(32), allowNull: false },
      sub: { type: DataTypes.STRING(64), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      brand: { type: DataTypes.STRING(128), allowNull: false, defaultValue: "" },
      price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      orig: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      img: { type: DataTypes.TEXT, allowNull: false }, // 相对路径或完整 URL（OSS）
      tag: { type: DataTypes.STRING(16), allowNull: true },
      rating: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 5 },
      sold: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      desc: { type: DataTypes.TEXT, allowNull: true },
      specs: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
      online: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, // 下架后前台不可见
    }, { tableName: "products", timestamps: false });

    const Banner = sequelize.define("Banner", {
      img: { type: DataTypes.STRING(128), allowNull: false },
      t1: { type: DataTypes.STRING(128), allowNull: false },
      t2: { type: DataTypes.STRING(128), allowNull: false },
    }, { tableName: "banners", timestamps: false });

    const HotKeyword = sequelize.define("HotKeyword", {
      word: { type: DataTypes.STRING(64), allowNull: false },
    }, { tableName: "hot_keywords", timestamps: false });

    /* —— 用户体系（openid 由云托管网关注入 x-wx-openid 头） —— */
    const User = sequelize.define("User", {
      openid: { type: DataTypes.STRING(64), primaryKey: true },
      nickname: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "微信用户" },
      avatar: { type: DataTypes.TEXT, allowNull: true }, // data URL
      /* 退出登录只置标记、不清资料：重新登录取回原昵称头像 */
      loggedOut: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      /* 用户显式编辑过昵称：登录时保留；否则一律按 openid 重算确定性昵称
         （自愈历史上被旧版客户端污染的随机昵称） */
      named: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    }, { tableName: "users" });

    const Favorite = sequelize.define("Favorite", {
      openid: { type: DataTypes.STRING(64), allowNull: false },
      productId: { type: DataTypes.STRING(32), allowNull: false },
      sort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    }, { tableName: "favorites", indexes: [{ unique: true, fields: ["openid", "productId"] }] });

    const ViewHistory = sequelize.define("ViewHistory", {
      openid: { type: DataTypes.STRING(64), allowNull: false },
      productId: { type: DataTypes.STRING(32), allowNull: false },
      at: { type: DataTypes.BIGINT, allowNull: false },
    }, { tableName: "view_histories", indexes: [{ unique: true, fields: ["openid", "productId"] }] });

    const SearchHistory = sequelize.define("SearchHistory", {
      openid: { type: DataTypes.STRING(64), allowNull: false },
      keyword: { type: DataTypes.STRING(64), allowNull: false },
      at: { type: DataTypes.BIGINT, allowNull: false },
    }, { tableName: "search_histories", indexes: [{ unique: true, fields: ["openid", "keyword"] }] });

    await sequelize.authenticate();
    const m = { Counter, Category, Product, Banner, HotKeyword, User, Favorite, ViewHistory, SearchHistory };
    for (const model of Object.values(m)) await model.sync({ alter: true });
    orm = { sequelize, models: m };

    /* 目录为空时自动灌种子（与 data/db.js 同源） */
    const { CATS, PRODUCTS, BANNERS, HOT_KEYWORDS } = require("./data/db");
    if ((await Product.count()) === 0) {
      await Product.bulkCreate(PRODUCTS);
      console.log("[db] 种子：products", PRODUCTS.length);
    }
    if ((await Category.count()) === 0) {
      await Category.bulkCreate(CATS);
      console.log("[db] 种子：categories", CATS.length);
    }
    if ((await Banner.count()) === 0) {
      await Banner.bulkCreate(BANNERS);
      console.log("[db] 种子：banners", BANNERS.length);
    }
    if ((await HotKeyword.count()) === 0) {
      await HotKeyword.bulkCreate(HOT_KEYWORDS.map(w => ({ word: w })));
      console.log("[db] 种子：hot_keywords", HOT_KEYWORDS.length);
    }
    console.log("[db] MySQL 初始化成功");
  } catch (e) {
    orm = null;
    console.warn("[db] MySQL 初始化失败，降级静态数据：", e.message);
  }
}

const ready = () => orm !== null;
const models = () => orm && orm.models;
const sequelize = () => orm && orm.sequelize;

/* —— 目录读取：有库读库，无库回落静态（字段结构保持一致） —— */
async function catalog() {
  if (!ready()) {
    const { CATS, PRODUCTS, BANNERS, HOT_KEYWORDS } = require("./data/db");
    return { source: "static", cats: CATS, products: PRODUCTS, banners: BANNERS, hotKeywords: HOT_KEYWORDS };
  }
  const m = models();
  const [cats, products, banners, hotWords] = await Promise.all([
    m.Category.findAll({ raw: true }),
    m.Product.findAll({ raw: true, order: [["id", "ASC"]], where: { online: true } }),
    m.Banner.findAll({ raw: true }),
    m.HotKeyword.findAll({ raw: true }),
  ]);
  return {
    source: "db",
    cats: cats.map(c => ({ id: c.id, name: c.name, icon: c.icon, subs: c.subs || [] })),
    products: products.map(p => ({
      id: p.id, cat: p.cat, sub: p.sub, name: p.name, brand: p.brand,
      price: Number(p.price), orig: p.orig == null ? undefined : Number(p.orig),
      img: p.img, tag: p.tag || undefined, rating: Number(p.rating), sold: p.sold,
      desc: p.desc || "", specs: p.specs || [],
    })),
    banners,
    hotKeywords: hotWords.map(w => w.word),
  };
}

/* —— 计数示例（模板原有，无库时内存降级） —— */
async function count() {
  return orm ? await models().Counter.count() : memCount;
}
async function inc() {
  if (orm) await models().Counter.create();
  else memCount += 1;
  return count();
}
async function clear() {
  if (orm) await models().Counter.destroy({ truncate: true });
  else memCount = 0;
  return count();
}

module.exports = { init, ready, models, sequelize, catalog, count, inc, clear };
