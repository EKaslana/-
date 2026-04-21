本目录用于“金融日报”静态可视化页面生成。

输入：
- site/data/days/*.json：每个日期一个文件（新增一天=新增一个 json 文件）

输出：
- site/dist/index.html：目录页（每日卡片列表）
- site/dist/days/YYYY-MM-DD.html：每日报告页（带目录 + 事件卡片）

生成命令：
- node site/generate.mjs

从 Notion 同步（金融每日记录 + 金融事件记录）：
1) 设置 Notion Token（需要对两个数据库有访问权限）：
   - export NOTION_TOKEN="你的 Notion Integration Token"
2) 同步到本地 JSON（会写入/覆盖 site/data/days/*.json）：
   - node site/sync-notion.mjs
3) 重新生成可视化页面：
   - node site/generate.mjs
