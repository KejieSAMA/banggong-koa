# banggong-koa

办公严选小程序后端服务，基于[微信云托管 wxcloudrun-koa 模板](https://github.com/WeixinCloud/wxcloudrun-koa)二次开发（Apache-2.0）。

提供商城演示数据接口（分类/商品/轮播/热搜）与静态图片服务；模板原有的计数器与 OpenID 示例接口保留，MySQL 已改为**可选依赖**——未配置数据库环境变量时自动降级为内存计数，服务可正常启动。

## 本地运行

```bash
npm install
PORT=3000 node index.js   # 默认 80
```

## 项目结构

```
.
├── Dockerfile              # 容器配置（模板原样）
├── container.config.json   # 模板部署「服务设置」初始值（二开忽略）
├── index.js                # 入口：路由注册 + CORS + 静态图片
├── db.js                   # 计数示例：MySQL 可选，无库时内存降级
├── routes/mall.js          # 商城接口路由
├── data/db.js              # 演示数据（CATS/PRODUCTS/BANNERS/HOT_KEYWORDS）
├── images/                 # 商品/轮播图片（39 张）
├── index.html              # 模板演示首页
└── package.json
```

## API 文档

统一响应结构：`{ "code": 0, "data": ..., "msg": "" }`（code=0 成功）。
图片字段为 `/images/xxx.jpg` 相对路径，由客户端拼接公网域名。

### 商城接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/banners` | 首页轮播 `[{img, t1, t2}]` |
| GET | `/api/categories` | 分类列表 `[{id, name, icon, subs}]` |
| GET | `/api/products` | 全部商品（img 已解析为 `/images/*`） |
| GET | `/api/products/:id` | 商品详情；不存在时 `data: null, msg: "商品不存在"` |
| GET | `/api/hot-keywords` | 热搜词数组 |
| GET | `/images/:file` | 静态图片（仅 images 目录，缓存 1 天） |

```
curl https://<云托管服务域名>/api/products
curl https://<云托管服务域名>/images/p01.jpg
```

### 模板原有接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/count` | 获取计数 |
| POST | `/api/count` | `{"action":"inc"\|"clear"}` 自增/清零 |
| GET | `/api/wx_openid` | 小程序经云托管调用时回显 OpenID（`x-wx-source` 头存在时） |

### 小程序端调用（云托管免鉴权）

```js
wx.cloud.callContainer({
  config: { env: '<环境ID>' },
  path: '/api/products',
  header: { 'X-WX-SERVICE': '<服务名>' },
  method: 'GET',
})
```

## 部署（微信云托管）

1. 云托管控制台 → 服务「设置」→ 代码源，绑定本 GitHub 仓库与分支
2. 「服务列表」对该服务执行部署/重新部署，构建即自动拉取仓库代码
3. 公网访问：`https://<服务域名>/api/products`

### 环境变量（可选）

| 变量 | 说明 |
|---|---|
| `MYSQL_ADDRESS` | `host:port`，云托管 MySQL 页面可获取 |
| `MYSQL_USERNAME` / `MYSQL_PASSWORD` | 数据库账号 |

> 未配置以上变量时 `/api/count` 走内存计数（重启归零），商城接口不受影响。

## 本地调试 / 实时开发

参考[微信云托管本地调试指南](https://developers.weixin.qq.com/miniprogram/dev/wxcloudrun/src/guide/debug/)与[实时开发指南](https://developers.weixin.qq.com/miniprogram/dev/wxcloudrun/src/guide/debug/dev.html)。

## License

[Apache-2.0](./LICENSE)（继承自模板）
