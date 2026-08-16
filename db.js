/**
 * 计数示例（模板原有能力）：MySQL 可选。
 * 配置了 MYSQL_USERNAME / MYSQL_PASSWORD / MYSQL_ADDRESS 时使用数据库，
 * 否则降级为进程内存计数（重启归零），保证无数据库环境也能启动。
 */
const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = "" } = process.env;

const HAS_MYSQL = Boolean(MYSQL_USERNAME && MYSQL_PASSWORD && MYSQL_ADDRESS);

let Counter = null;
let memCount = 0;

async function init() {
  if (!HAS_MYSQL) {
    console.warn("[db] 未配置 MySQL 环境变量，/api/count 使用内存计数（重启归零）");
    return;
  }
  try {
    const { Sequelize, DataTypes } = require("sequelize");
    const [host, port] = MYSQL_ADDRESS.split(":");
    const sequelize = new Sequelize("nodejs_demo", MYSQL_USERNAME, MYSQL_PASSWORD, {
      host,
      port,
      dialect: "mysql",
      logging: false,
    });
    Counter = sequelize.define("Counter", {
      count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
    });
    await sequelize.authenticate();
    await Counter.sync({ alter: true });
    console.log("[db] MySQL 初始化成功");
  } catch (e) {
    Counter = null;
    console.warn("[db] MySQL 初始化失败，降级内存计数：", e.message);
  }
}

async function count() {
  return Counter ? await Counter.count() : memCount;
}

async function inc() {
  if (Counter) await Counter.create();
  else memCount += 1;
  return count();
}

async function clear() {
  if (Counter) await Counter.destroy({ truncate: true });
  else memCount = 0;
  return count();
}

module.exports = { init, count, inc, clear };
