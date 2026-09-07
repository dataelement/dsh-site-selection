# 数据许可 — 请在对外分发前读完

这个插件里有两类东西，**许可证不一样**，混在一起会出问题。

## 代码：MIT

`src/*.js`、`lib/`、`public/`、`scripts/`、`test/` —— 见 `LICENSE`。随便用。

## 地理数据：ODbL 1.0，具有传染性

`src/data/` 下所有 `*-poi.json`、`*-basemap.json`、`*-buildings.json`、
`*-floorarea.json`，是 **OpenStreetMap 的衍生数据库（Derivative Database）**。

> © OpenStreetMap contributors，依 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 提供。

每个文件头部都带 `source` 和 `license` 字段，标明来源，不要删。

### 这对商业化意味着什么

ODbL 是 **share-alike（相同方式共享）**。简单说：

- **自己内部用**：随便。分析、决策、出报告，都不触发任何义务。
- **把衍生数据库交给别人**（发布插件、随产品分发、给客户一份数据）：
  必须以 **ODbL** 同样条件提供那份数据库，并注明来源。
  你不能把它包进一个闭源产品里当作自有资产卖。
- **只公开分析结果**（比如一张评分表、一份选址报告）而不给数据库本身：
  属于 "Produced Work"，只需**署名**，不必开放数据库。

### 商业版的三条路

1. **换数据源**——买高德/百度/极海等持牌服务商的数据，替换 `src/data/`。
   `scripts/fetch-city.mjs` 产出的 schema 就是替换的接口，上层代码不用动。
   **国内做地图服务还涉及测绘资质，生产环境本来也该用持牌服务商，不能自绘 OSM。**
2. **接受 ODbL**——把随产品分发的数据库以 ODbL 开放。
3. **让客户自带数据**——产品只发代码，数据由客户自己按 `fetch-city.mjs` 生成或自行采购。

哪条都行，但**得先选一条**。默认什么都不做、把 ODbL 数据打进闭源产品分发，是不合规的。

## 模拟数据：不是真实记录

`src/data/*-market.json`（铺源、客流、商场档次）**全部是程序生成的**，
不是任何真实挂牌、真实测量或真实企业记录。文件头有 `simulated: true` 和
`warning` 字段，每条记录也有 `simulated: true`。

它存在的意义是**演示接口契约**：字段口径对齐国内数据商实际售卖的内容
（见文件里的 `vendors` 字段），买到真数据后按同一 schema 灌进来即可。

**不要拿这里面的租金去谈判，也不要把这些数字写进任何对外材料。**
生成器在 `scripts/generate-market.mjs`，改 seed 就是另一批。
