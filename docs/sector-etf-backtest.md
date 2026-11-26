# 15只行业ETF四线趋势回测数据

本任务使用独立清单 config/sector-backtest-etfs.json，不改变 config/universe.json 中的20只核心ETF，也不改变日常资金雷达的数据成员。

## 基金范围与名称

每只基金同时保存交易代码、完整中文法定基金名称、中文简称、展示名称、行业、跟踪指数、基金合同生效日、上市日期和公开资料来源。报告展示时优先使用 display_name，并同时保留六位代码和所属行业。

## 历史数据采集

需要 Node.js 24+，并在本地 .env 中配置自己的 FtShare 凭据：

```dotenv
FTSHARE_API_KEY=你的FtShare密钥
```

首次采集：

```sh
npm run collect:sector-etfs
```

指定一个已经完成的中国交易日作为截止日：

```sh
npm run collect:sector-etfs -- --end 2026-11-24
```

采集器按12个月窗口分段获取日K，优先复用项目已有的 ft_v1_stock_candlesticks，无数据时回退到 ft_v1_etf_candlesticks。使用 Forward（前复权）日线，避免分红等除权事件把均线切断。每只ETF的有效起点不早于其核实的上市日期；不补造上市前行情。

默认输出写入被 Git 忽略的私有目录：

- data/private/sector-etf-backtest.json.gz
- data/private/sector-etf-backtest.manifest.json

后续增量采集会读取并合并已有归档。若某只ETF有缺失交易日，清单会逐日列出并标记 incomplete；不会用前值填充或把缺失行情当作零。全部数据采集成功后才原子替换行情归档。

## 回测口径

- 每只ETF独立使用初始资金人民币20,000元，不复利、不跨ETF调拨资金。
- 买入信号：收盘价同时高于MA5、MA10、MA20、MA60。
- 卖出信号：收盘价同时低于MA5、MA10、MA20、MA60。
- 信号在当日收盘确认，按下一交易日开盘价成交。
- 复权口径：FtShare前复权日K线；信号使用复权收盘价，成交模拟使用同一复权口径的次日开盘价。
- 默认交易成本设为0，结果属于毛收益；报告应另行提示佣金、滑点及跟踪误差影响。
- 每只ETF与同期买入持有比较时，均从该ETF上市后首个有效交易日开始，不把未上市期间计入。

## 数据来源

每只ETF的基金名称和上市日期核验来源记录在 config/sector-backtest-etfs.json 的 source_url 字段。行情由用户自己的 FtShare 账户按该项目现有客户端采集。

## 从 GitHub Actions 运行

合并本变更后，可在 GitHub 仓库的 Actions 页面手动运行“15只行业ETF历史行情采集”。运行前需在仓库 Settings → Secrets and variables → Actions 中添加仓库密钥 FTSHARE_API_KEY。工作流会先运行 npm test，再采集行情并将压缩历史数据及清单作为 30 天有效期的 workflow artifact 上传；不会把私有行情写入 Git 提交。
