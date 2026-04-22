import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@notionhq/client";

const ROOT = path.resolve(process.cwd());
const SITE_DIR = path.join(ROOT, "site");
const DATA_DIR = path.join(SITE_DIR, "data", "days");

const DEFAULT_DAILY_DB_ID = "343f9553c5708071b237e68b0e8764a0";
const DEFAULT_EVENT_DB_ID = "9d767f81eaea49ce974bd04a80144284";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") out.date = argv[i + 1] || "";
    if (a === "--payload") out.payload = argv[i + 1] || "";
  }
  return out;
}

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function stripUuidDashes(id) {
  return String(id).replaceAll("-", "");
}

function notionPageUrl(pageIdOrUuid) {
  return `https://www.notion.so/${stripUuidDashes(pageIdOrUuid)}`;
}

function getNotionToken() {
  const fromEnv = process.env.NOTION_TOKEN;
  if (fromEnv) return String(fromEnv).trim();
  const tokenPath = path.join(SITE_DIR, ".notion_token");
  if (fs.existsSync(tokenPath)) return fs.readFileSync(tokenPath, "utf8").trim();
  return "";
}

function richText(content) {
  const text = String(content ?? "");
  if (!text) return [];
  return [{ type: "text", text: { content: text } }];
}

function buildPropValue(propType, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  switch (propType) {
    case "title":
      return { title: richText(value) };
    case "rich_text":
      return { rich_text: richText(value) };
    case "number":
      return { number: typeof value === "number" ? value : Number(value) };
    case "select":
      return value ? { select: { name: String(value) } } : { select: null };
    case "multi_select":
      return {
        multi_select: (Array.isArray(value) ? value : [])
          .map((x) => String(x).trim())
          .filter(Boolean)
          .map((name) => ({ name })),
      };
    case "date":
      return isIsoDate(value) ? { date: { start: value } } : { date: null };
    case "url":
      return value ? { url: String(value) } : { url: null };
    case "checkbox":
      return { checkbox: Boolean(value) };
    case "relation":
      return {
        relation: (Array.isArray(value) ? value : [])
          .map((id) => String(id))
          .filter(Boolean)
          .map((id) => ({ id })),
      };
    default:
      return undefined;
  }
}

function setProp(properties, dbProps, propName, value) {
  const def = dbProps?.[propName];
  if (!def) return;
  const built = buildPropValue(def.type, value);
  if (built === undefined) return;
  properties[propName] = built;
}

function getDbTitlePropName(db) {
  const props = db?.properties || {};
  for (const [name, def] of Object.entries(props)) {
    if (def?.type === "title") return name;
  }
  return "title";
}

async function getDatabaseAndDataSource(notion, databaseId) {
  const database = await notion.databases.retrieve({ database_id: databaseId });
  const dsId = database?.data_sources?.[0]?.id;
  if (!dsId) throw new Error(`数据库 ${databaseId} 缺少 data_sources，无法继续。`);
  const dataSource = await notion.dataSources.retrieve({ data_source_id: dsId });
  return { database, dataSourceId: dsId, dataSource };
}

async function listAllChildBlocks(notion, blockId) {
  const out = [];
  let cursor = undefined;
  while (true) {
    const resp = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });
    out.push(...(resp.results || []));
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
    if (!cursor) break;
  }
  return out;
}

function markdownToNotionBlocks(md) {
  const lines = String(md ?? "").replaceAll("\r\n", "\n").split("\n");
  const blocks = [];

  let inCode = false;
  let codeLang = "plain text";
  let codeLines = [];

  function flushCode() {
    if (!inCode) return;
    const MAX = 1900; // Notion single rich_text item limit is 2000 chars; keep headroom
    const emit = (content) => {
      blocks.push({
        object: "block",
        type: "code",
        code: {
          rich_text: richText(content || " "),
          language: codeLang || "plain text",
        },
      });
    };

    let buf = "";
    for (const l of codeLines) {
      const candidate = buf ? `${buf}\n${l}` : l;
      if (candidate.length > MAX && buf) {
        emit(buf);
        buf = l;
        continue;
      }
      if (candidate.length > MAX && !buf) {
        // Single line too long; hard-split
        for (let i = 0; i < l.length; i += MAX) emit(l.slice(i, i + MAX));
        buf = "";
        continue;
      }
      buf = candidate;
    }
    if (buf) emit(buf);
    inCode = false;
    codeLang = "plain text";
    codeLines = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.replaceAll("\t", "  ");
    const trimmed = line.trimEnd();

    const fence = trimmed.match(/^```(\w+)?\s*$/);
    if (fence) {
      if (inCode) {
        flushCode();
      } else {
        inCode = true;
        codeLang = fence[1] ? fence[1].toLowerCase() : "plain text";
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(trimmed);
      continue;
    }

    if (trimmed.trim() === "") continue;

    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: richText(h2[1].trim()) },
      });
      continue;
    }

    const ul = trimmed.match(/^\-\s+(.+)$/);
    if (ul) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: richText(ul[1].trim()) },
      });
      continue;
    }

    const ol = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: richText(ol[1].trim()) },
      });
      continue;
    }

    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(trimmed.trim()) },
    });
  }

  if (inCode) flushCode();
  return blocks;
}

async function appendBlocksChunked(notion, parentBlockId, blocks) {
  const CHUNK = 90;
  for (let i = 0; i < blocks.length; i += CHUNK) {
    const slice = blocks.slice(i, i + CHUNK);
    await notion.blocks.children.append({ block_id: parentBlockId, children: slice });
  }
}

async function clearPageBlocks(notion, pageId) {
  const blocks = await listAllChildBlocks(notion, pageId);
  for (const b of blocks) {
    await notion.blocks.delete({ block_id: b.id });
  }
}

async function upsertDailyPage(notion, dailyDbId, payload) {
  const { database: db, dataSourceId: dsId, dataSource: ds } = await getDatabaseAndDataSource(
    notion,
    dailyDbId,
  );
  const dbProps = ds.properties || {};

  if (!dbProps["日报日期"] || dbProps["日报日期"].type !== "date") {
    throw new Error('日报库缺少日期属性 "日报日期"（type=date），无法按日期 upsert。');
  }

  const titlePropName = getDbTitlePropName(ds);

  const query = await notion.dataSources.query({
    data_source_id: dsId,
    page_size: 20,
    filter: { property: "日报日期", date: { equals: payload.date } },
  });

  const results = query.results || [];
  let page = null;
  if (results.length === 1) {
    page = results[0];
  } else if (results.length > 1) {
    const prefer = results.find((p) => {
      const props = p.properties || {};
      const t1 = props["日报标题"]?.rich_text?.map((x) => x.plain_text).join("") || "";
      const t2 = props[titlePropName]?.title?.map((x) => x.plain_text).join("") || "";
      return t1 === payload.title || t2 === payload.title;
    });
    page = prefer || results[0];
  }

  const dailyProps = {};
  setProp(dailyProps, dbProps, titlePropName, payload.title);
  setProp(dailyProps, dbProps, "日报标题", payload.title);
  setProp(dailyProps, dbProps, "日报日期", payload.date);
  setProp(dailyProps, dbProps, "日报摘要", payload.summary);
  setProp(dailyProps, dbProps, "今日重点", payload.todayFocus);
  setProp(dailyProps, dbProps, "重点类别", payload.categories);
  setProp(dailyProps, dbProps, "最高重要性", payload.maxImportance);
  setProp(dailyProps, dbProps, "市场偏向", payload.marketBias);
  setProp(dailyProps, dbProps, "事件总数", payload.eventCount);
  setProp(dailyProps, dbProps, "高重要事件数", payload.highCount);
  setProp(dailyProps, dbProps, "需跟踪事件数", payload.followCount);
  setProp(dailyProps, dbProps, "关键对象", payload.keyObjects);
  setProp(dailyProps, dbProps, "主要来源", payload.mainSources);
  setProp(dailyProps, dbProps, "后续观察点", payload.watchpointsText);

  if (!page) {
    const created = await notion.pages.create({
      parent: { data_source_id: dsId },
      properties: dailyProps,
    });
    return { db, ds, page: created };
  }

  const updated = await notion.pages.update({ page_id: page.id, properties: dailyProps });
  return { db, ds, page: updated };
}

async function upsertEventPages(notion, eventDbId, dailyPageId, events) {
  const { database: db, dataSourceId: dsId, dataSource: ds } = await getDatabaseAndDataSource(
    notion,
    eventDbId,
  );
  const dbProps = ds.properties || {};
  const titlePropName = getDbTitlePropName(ds);

  const required = ["去重键", "所属日报"];
  for (const p of required) {
    if (!dbProps[p]) throw new Error(`事件库缺少属性 "${p}"，无法幂等 upsert。`);
  }

  const out = [];

  for (const e of events) {
    const filter = {
      and: [
        { property: "去重键", rich_text: { equals: e.dedupe_key } },
        { property: "所属日报", relation: { contains: dailyPageId } },
      ],
    };

    const query = await notion.dataSources.query({
      data_source_id: dsId,
      page_size: 5,
      filter,
    });

    const existing = (query.results || [])[0] || null;

    const props = {};
    setProp(props, dbProps, titlePropName, e.title);
    setProp(props, dbProps, "事件标题", e.title);
    setProp(props, dbProps, "事件日期", e.date);
    setProp(props, dbProps, "来源", e.source);
    setProp(props, dbProps, "类别", e.category);
    setProp(props, dbProps, "重要性", e.importance);
    setProp(props, dbProps, "影响范围", e.impact_scope);
    setProp(props, dbProps, "影响方向", e.direction);
    setProp(props, dbProps, "一句话摘要", e.summary);
    setProp(props, dbProps, "核心影响", e.impact);
    setProp(props, dbProps, "影响对象", e.targets);
    setProp(props, dbProps, "对象标签", e.object_tags);
    setProp(props, dbProps, "关键词", e.keywords);
    setProp(props, dbProps, "持续跟踪", e.follow_up === "是");
    setProp(props, dbProps, "原文链接", e.link);
    setProp(props, dbProps, "去重键", e.dedupe_key);
    setProp(props, dbProps, "所属日报", [dailyPageId]);

    let page;
    if (existing) {
      page = await notion.pages.update({ page_id: existing.id, properties: props });
    } else {
      page = await notion.pages.create({
        parent: { data_source_id: dsId },
        properties: props,
      });
    }

    out.push({ id: page.id, url: notionPageUrl(page.id) });
  }

  return { db, ds, pages: out };
}

function computeAggregates(date, events) {
  const categories = [...new Set(events.map((e) => e.category).filter(Boolean))];
  const sources = [...new Set(events.map((e) => e.source).filter(Boolean))];
  const objectTags = [...new Set(events.flatMap((e) => e.object_tags || []).filter(Boolean))];

  const importanceRank = { 高: 3, 中: 2, 低: 1 };
  const maxImportance =
    events
      .map((e) => e.importance)
      .filter(Boolean)
      .sort((a, b) => (importanceRank[b] || 0) - (importanceRank[a] || 0))[0] || "低";

  const dirCounts = events.reduce((acc, e) => {
    const d = e.direction || "";
    acc[d] = (acc[d] || 0) + 1;
    return acc;
  }, {});
  const marketBias =
    dirCounts["利多"] && dirCounts["利空"]
      ? "分化"
      : dirCounts["利多"]
        ? "利多"
        : dirCounts["利空"]
          ? "利空"
          : "中性";

  const eventCount = events.length;
  const highCount = events.filter((e) => e.importance === "高").length;
  const followCount = events.filter((e) => e.follow_up === "是").length;

  const watchpoints = [];
  for (const e of events) {
    if (e.follow_up !== "是") continue;
    watchpoints.push(`${e.title}：关键条件/节奏/市场反应。`);
  }
  if (watchpoints.length === 0) watchpoints.push("关注油价与资金面波动对通胀与风险偏好的传导。");

  return {
    date,
    categories,
    sources,
    objectTags,
    maxImportance,
    marketBias,
    eventCount,
    highCount,
    followCount,
    watchpoints,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!isIsoDate(args.date)) throw new Error('参数错误：必须提供 --date YYYY-MM-DD');
  if (!args.payload) throw new Error("参数错误：必须提供 --payload <json 文件路径>");

  const payload = readJson(args.payload);
  if (Array.isArray(payload.reportMarkdown)) {
    payload.reportMarkdown = payload.reportMarkdown.map((x) => String(x ?? "")).join("\n");
  }
  if (payload.date !== args.date) throw new Error("payload.date 与 --date 不一致");

  const token = getNotionToken();
  if (!token) throw new Error("缺少 Notion Token：请设置 NOTION_TOKEN 或提供 site/.notion_token");

  const notion = new Client({ auth: token });
  const dailyDbId = process.env.NOTION_DAILY_DB_ID || DEFAULT_DAILY_DB_ID;
  const eventDbId = process.env.NOTION_EVENT_DB_ID || DEFAULT_EVENT_DB_ID;

  const aggregates = computeAggregates(payload.date, payload.events || []);
  payload.categories = aggregates.categories;
  payload.maxImportance = aggregates.maxImportance;
  payload.marketBias = aggregates.marketBias;
  payload.eventCount = aggregates.eventCount;
  payload.highCount = aggregates.highCount;
  payload.followCount = aggregates.followCount;
  payload.keyObjects = aggregates.objectTags.join("、");
  payload.mainSources = aggregates.sources.join("、");
  payload.watchpointsText = aggregates.watchpoints.map((x, i) => `${i + 1}. ${x}`).join("\n");

  const top = (payload.events || []).slice(0, 5);
  payload.todayFocus = top.map((e) => `【${e.category}】${e.summary}`).join("；");

  const daily = await upsertDailyPage(notion, dailyDbId, payload);
  const dailyPageId = daily.page.id;
  const dailyUrl = notionPageUrl(dailyPageId);

  // Replace daily page body (idempotent)
  await clearPageBlocks(notion, dailyPageId);
  const blocks = markdownToNotionBlocks(payload.reportMarkdown);
  await appendBlocksChunked(notion, dailyPageId, blocks);

  const eventResult = await upsertEventPages(notion, eventDbId, dailyPageId, payload.events || []);

  // Back-fill daily <-> events relation if present
  const dailyDbProps = daily.ds.properties || {};
  if (dailyDbProps["关联事件"]?.type === "relation") {
    const relProps = {};
    setProp(relProps, dailyDbProps, "关联事件", eventResult.pages.map((p) => p.id));
    await notion.pages.update({ page_id: dailyPageId, properties: relProps });
  }

  // Write site day json (this run is the only source of truth)
  ensureDir(DATA_DIR);
  const dayJson = {
    date: payload.date,
    title: payload.title,
    summary: payload.summary,
    notion_url: dailyUrl,
    reportMarkdown: payload.reportMarkdown,
    events: (payload.events || []).map((e, i) => ({
      title: e.title,
      date: e.date,
      source: e.source,
      category: e.category,
      importance: e.importance,
      summary: e.summary,
      impact: e.impact,
      targets: e.targets,
      direction: e.direction,
      keywords: e.keywords,
      follow_up: e.follow_up,
      link: e.link,
      notion_url: eventResult.pages[i]?.url,
    })),
  };

  writeJson(path.join(DATA_DIR, `${payload.date}.json`), dayJson);

  console.log(`Notion upsert done. Daily: ${dailyUrl} Events: ${eventResult.pages.length} JSON: ${path.join(DATA_DIR, `${payload.date}.json`)}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
