# banggong-koa

办公严选小程序后端服务，基于[微信云托管 wxcloudrun-koa 模板](https://github.com/WeixinCloud/wxcloudrun-koa)二次开发（Apache-2.0）。

提供商城目录接口（分类/商品/轮播/热搜）与静态图片服务；**用户体系**（资料/收藏/足迹/搜索历史，经云托管网关注入的 `x-wx-openid` 免鉴权识别）；MySQL 为**可选依赖**——未配置时目录回落静态数据、用户接口返回 `code:1`（客户端自动转本地模式）、计数用内存降级。

## 本地运行

```bash
npm install
PORT=3000 node index.js          # 无 MySQL：静态目录 + 用户接口 code:1
node tools/test-user-routes.js   # 用户路由逻辑免库测试（内存桩，14 项断言）
```

## 项目结构

```
.
├── Dockerfile              # 容器配置（模板原样）
├── container.config.json   # 模板部署「服务设置」初始值（二开忽略）
├── index.js                # 入口：路由注册 + CORS + 静态图片
├── db.js                   # sequelize 模型（目录+用户）+ 自动建表/种子 + 降级
├── routes/mall.js          # 商城目录接口
├── routes/user.js          # 用户体系接口（openid 免鉴权）
├── data/db.js              # 静态兜底数据（同时是数据库种子源）
├── tools/test-user-routes.js # 用户路由免库测试
├── images/                 # 商品/轮播图片（39 张）
├── index.html              # 模板演示首页
└── package.json
```

## API 文档

统一响应结构：`{ "code": 0, "data": ..., "msg": "" }`（code=0 成功；code=1 表示未登录/数据库未就绪）。
图片字段为 `/images/xxx.jpg` 相对路径，由客户端拼接公网域名。

### 商城目录

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/banners` | 首页轮播 `[{img, t1, t2}]` |
| GET | `/api/categories` | 分类列表 `[{id, name, icon, subs}]` |
| GET | `/api/products` | 全部商品（img 已解析为 `/images/*`） |
| GET | `/api/products/:id` | 商品详情；不存在时 `data: null, msg: "商品不存在"` |
| GET | `/api/hot-keywords` | 热搜词数组 |
| GET | `/images/:file` | 静态图片（仅 images 目录，缓存 1 天） |

### 用户体系（需经小程序 `wx.cloud.callContainer` 调用，网关自动注入 openid）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/user/profile` | 获取资料（首次自动建档）；返回 `{nickname, avatar, loggedOut}` |
| POST | `/api/user/login` | 一键登录：昵称为默认值时按 openid 生成确定性昵称「用户XXXXXX」（恒定不变），清除退出标记 |
| PUT | `/api/user/profile` | 更新资料 `{nickname, avatar, loggedOut}`（头像 data URL ≤512KB；`loggedOut:true` 为退出登录，资料保留） |
| GET | `/api/favorites` | 收藏 productId 列表（最新在前） |
| POST | `/api/favorites` | `{ids}` 全量替换（幂等，保持传入顺序） |
| GET | `/api/history` | 足迹 productId 列表（≤20，最近在前） |
| POST | `/api/history` | `{id}` 置顶去重追加 |
| DELETE | `/api/history/:id` | 删除单条足迹（幂等） |
| DELETE | `/api/history` | 清空足迹 |
| GET | `/api/search-history` | 搜索词列表（≤8，最近在前） |
| POST | `/api/search-history` | `{q}` 置顶去重追加 |
| DELETE | `/api/search-history` | 清空搜索历史 |

### 管理端（仅管理员：环境变量 `ADMIN_OPENIDS` 白名单内的 openid）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/products` | 全量商品（含已下架） |
| POST | `/api/admin/products` | 新建（必填 name/cat/sub/price/img；服务端生成 id） |
| PUT | `/api/admin/products/:id` | 更新传入字段（含 `{online:false}` 下架） |
| DELETE | `/api/admin/products/:id` | 删除（幂等） |
| GET | `/api/admin/upload-token?ext=jpg` | OSS 直传凭证 `{host,key,policy,OSSAccessKeyId,signature}`（未配置返回 code:1） |

公开目录接口（`/api/products`、`/api/products/:id`）自动过滤 `online=false` 的商品。

## 管理端配置（管理员 + 阿里云 OSS 图床）

1. **管理员白名单**：小程序「设置 → 我的ID」复制 openid（登录后显示），配置到服务环境变量 `ADMIN_OPENIDS`（多人逗号分隔），重新部署后「我的」页出现「商品管理」入口
2. **OSS 开通**（商品图片直传，AK/SK 只存服务端）：
   - 阿里云 OSS 创建 bucket，读写权限设「公共读」（商品图需公网可访问）
   - bucket「跨域设置」：来源 `*`、允许 Methods `POST, PUT`、允许 Headers `*`
   - 建议 RAM 子账号仅授予该 bucket 写权限，取 AccessKeyId/Secret
3. 服务「设置」→ 环境变量补齐：

| 变量 | 说明 |
|---|---|
| `ADMIN_OPENIDS` | 管理员 openid，逗号分隔 |
| `OSS_ACCESS_KEY_ID` | RAM 子账号 AK |
| `OSS_ACCESS_KEY_SECRET` | RAM 子账号 SK |
| `OSS_BUCKET` | bucket 名 |
| `OSS_REGION` | 如 `oss-cn-beijing` |
| `OSS_DIR`（可选） | 上传目录前缀，如 `bg/` |

### 模板原有接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/count` | 获取计数 |
| POST | `/api/count` | `{"action":"inc"\|"clear"}` 自增/清零 |
| GET | `/api/wx_openid` | 回显网关注入的 OpenID |

## 部署（微信云托管）

1. 控制台开通 **MySQL**（云托管数据库），记下地址/账号/密码
2. 服务「设置」→ 环境变量补齐：

| 变量 | 说明 |
|---|---|
| `MYSQL_ADDRESS` | `host:port`（控制台 MySQL 页面获取） |
| `MYSQL_USERNAME` / `MYSQL_PASSWORD` | 数据库账号 |

3. 服务「设置」→ 代码源绑定本仓库 → 重新部署
4. 首次启动自动建表并灌入种子数据（36 商品/6 分类/3 轮播/8 热搜），日志可见 `[db] MySQL 初始化成功`
5. 验证：`https://<服务域名>/api/products`、小程序端收藏/足迹多端同步生效

> 未配置 MySQL 时不阻塞：目录走静态数据，用户接口 code:1，小程序保持本地模式。

### 小程序端调用（云托管免鉴权）

```js
wx.cloud.callContainer({
  config: { env: '<环境ID>' },
  path: '/api/products',
  header: { 'X-WX-SERVICE': '<服务名>' },
  method: 'GET',
})
```

## 本地调试 / 实时开发

参考[微信云托管本地调试指南](https://developers.weixin.qq.com/miniprogram/dev/wxcloudrun/src/guide/debug/)与[实时开发指南](https://developers.weixin.qq.com/miniprogram/dev/wxcloudrun/src/guide/debug/dev.html)。

## License

[Apache-2.0](./LICENSE)（继承自模板）
