import 'dotenv/config';
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "site");
const DATA_DIR = path.join(ROOT, "data", "days");

// From existing Notion workspace:
// - 金融每日记录: https://www.notion.so/343f9553c5708071b237e68b0e8764a0
// - 金融事件记录: https://www.notion.so/9d767f81eaea49ce974bd04a80144284
const DAILY_DB_ID = process.env.NOTION_DAILY_DB_ID || "343f9553c5708071b237e68b0e8764a0";
const EVENT_DB_ID = process.env.NOTION_EVENT_DB_ID || "9d767f81eaea49ce974bd04a80144284";

function getNotionToken() {
  const fromEnv = process.env.NOTION_TOKEN;
  if (fromEnv) return String(fromEnv).trim();
  const tokenPath = path.join(ROOT, ".notion_token");
  if (fs.existsSync(tokenPath)) return fs.readFileSync(tokenPath, "utf8").trim();
  return "";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") out.since = argv[i + 1] || "";
    if (a === "--until") out.until = argv[i + 1] || "";
    if (a === "--limit") out.limit = Number(argv[i + 1] || "");
  }
  return out;
}

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function stripUuidDashes(id) {
  return String(id).replaceAll("-", "");
}

function pageUrl(pageIdOrUuid) {
  return `https://www.notion.so/${stripUuidDashes(pageIdOrUuid)}`;
}

async function notionFetch(url, { method = "GET", body } = {}) {
  const token = getNotionToken();
  if (!token) {
    throw new Error([
      "缺少 Notion Token。",
      "请先设置后再运行：",
      "1) 临时（当前终端会话）：",
      '  export NOTION_TOKEN="你的 Notion Integration Token"',
      "",
      "2) 使用 .env（推荐，避免误提交到 git）：",
      "  在项目根目录创建 .env 文件，并写入：",
      "    NOTION_TOKEN=你的 Notion Integration Token",
      "",
      "3) 或在 site/.notion_token 中放置 token（与 upsert 脚本一致）",
      "",
      "可选：限制同步范围：",
      "  node sync-notion.mjs --since YYYY-MM-DD --until YYYY-MM-DD --limit 50",
    ].join("\n"));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error([
        "Notion API 401 Unauthorized：当前 token 无效或已过期。",
        "请更新 NOTION_TOKEN 或 site/.notion_token 后重试。",
        text,
      ].join("\n"));
    }
    throw new Error(`Notion API 请求失败：${res.status} ${res.statusText}\n${text}`);
  }
  return JSON.parse(text);
}

async function queryDatabaseAll(databaseId, queryBody) {
  const results = [];
  let cursor = undefined;
  while (true) {
    const body = { ...queryBody };
    if (!body.filter) delete body.filter;
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: "POST",
      body,
    });
    results.push(...(data.results ?? []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
    if (!cursor) break;
  }
  return results;
}

async function fetchPage(pageId) {
  return notionFetch(`https://api.notion.com/v1/pages/${stripUuidDashes(pageId)}`, { method: "GET" });
}

async function fetchRelationPropertyAll(pageId, propertyId) {
  const results = [];
  let cursor = undefined;
  while (true) {
    const url = new URL(`https://api.notion.com/v1/pages/${stripUuidDashes(pageId)}/properties/${propertyId}`);
    if (cursor) url.searchParams.set("start_cursor", cursor);
    url.searchParams.set("page_size", "100");
    const data = await notionFetch(url.toString(), { method: "GET" });
    results.push(...(data.results ?? []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
    if (!cursor) break;
  }
  return results;
}

async function getRelationPageIds(page, propName) {
  const p = getProp(page, propName);
  if (!p || p.type !== "relation") return [];
  const ids = (p.relation ?? []).map((x) => x.id).filter(Boolean);
  if (!p.has_more) return ids;
  // When relation is large, fetch the rest via property endpoint
  const more = await fetchRelationPropertyAll(page.id, p.id);
  for (const r of more) {
    const id = r?.relation?.id;
    if (id) ids.push(id);
  }
  return ids;
}

function richTextToMarkdown(richText) {
  const parts = Array.isArray(richText) ? richText : [];
  return parts
    .map((t) => {
      const plain = t?.plain_text ?? "";
      const href = t?.href || t?.text?.link?.url || "";
      if (href) return `[${plain}](${href})`;
      return plain;
    })
    .join("");
}

function getProp(page, propName) {
  return page?.properties?.[propName];
}

function getTitle(page, propName) {
  const p = getProp(page, propName);
  if (!p) return "";
  if (p.type === "title") return richTextToMarkdown(p.title);
  if (p.type === "rich_text") return richTextToMarkdown(p.rich_text);
  return "";
}

function getText(page, propName) {
  const p = getProp(page, propName);
  if (!p) return "";
  if (p.type === "rich_text") return richTextToMarkdown(p.rich_text);
  if (p.type === "title") return richTextToMarkdown(p.title);
  if (p.type === "select") return p.select?.name ?? "";
  return "";
}

function getSelect(page, propName) {
  const p = getProp(page, propName);
  if (!p) return "";
  if (p.type === "select") return p.select?.name ?? "";
  return "";
}

function getMultiSelect(page, propName) {
  const p = getProp(page, propName);
  if (!p) return [];
  if (p.type === "multi_select") return (p.multi_select ?? []).map((x) => x.name).filter(Boolean);
  return [];
}

function getNumber(page, propName) {
  const p = getProp(page, propName);
  if (!p) return null;
  if (p.type === "number") return typeof p.number === "number" ? p.number : null;
  return null;
}

function getDateStart(page, propName) {
  const p = getProp(page, propName);
  if (!p) return "";
  if (p.type === "date") return p.date?.start ?? "";
  return "";
}

function getCheckbox(page, propName) {
  const p = getProp(page, propName);
  if (!p) return false;
  if (p.type === "checkbox") return Boolean(p.checkbox);
  return false;
}

function getUrl(page, propName) {
  const p = getProp(page, propName);
  if (!p) return "";
  if (p.type === "url") return p.url ?? "";
  return "";
}

async function fetchPageBlocksMarkdown(pageId) {
  const lines = [];
  let cursor = undefined;
  let reachedJson = false;

  while (true) {
    const url = new URL(`https://api.notion.com/v1/blocks/${pageId}/children`);
    if (cursor) url.searchParams.set("start_cursor", cursor);
    url.searchParams.set("page_size", "100");
    const data = await notionFetch(url.toString(), { method: "GET" });
    for (const b of data.results ?? []) {
      const type = b.type;
      if (type === "heading_2") {
        const text = richTextToMarkdown(b.heading_2?.rich_text);
        if (text.trim().toUpperCase() === "JSON") {
          reachedJson = true;
          break;
        }
        lines.push(`## ${text}`.trim());
        continue;
      }
      if (reachedJson) break;
      if (type === "paragraph") {
        const text = richTextToMarkdown(b.paragraph?.rich_text);
        if (text.trim()) lines.push(text.trim());
        continue;
      }
      if (type === "bulleted_list_item") {
        const text = richTextToMarkdown(b.bulleted_list_item?.rich_text);
        if (text.trim()) lines.push(`- ${text}`.trim());
        continue;
      }
      if (type === "numbered_list_item") {
        const text = richTextToMarkdown(b.numbered_list_item?.rich_text);
        if (text.trim()) lines.push(`1. ${text}`.trim());
        continue;
      }
      // ignore other block types
    }
    if (reachedJson) break;
    if (!data.has_more) break;
    cursor = data.next_cursor;
    if (!cursor) break;
  }

  return lines.join("\n");
}

async function main() {
  ensureDir(DATA_DIR);

  const args = parseArgs(process.argv.slice(2));
  const filterParts = [];
  if (isIsoDate(args.since)) {
    filterParts.push({ property: "日报日期", date: { on_or_after: args.since } });
  }
  if (isIsoDate(args.until)) {
    filterParts.push({ property: "日报日期", date: { on_or_before: args.until } });
  }

  const dailyPages = await queryDatabaseAll(DAILY_DB_ID, {
    page_size: 100,
    filter:
      filterParts.length === 0
        ? undefined
        : filterParts.length === 1
          ? filterParts[0]
          : { and: filterParts },
    sorts: [{ property: "日报日期", direction: "descending" }],
  });

  const limited =
    Number.isFinite(args.limit) && args.limit > 0 ? dailyPages.slice(0, args.limit) : dailyPages;

  let written = 0;
  for (const dp of limited) {
    const date = getDateStart(dp, "日报日期");
    if (!date) continue;

    const title = getText(dp, "日报标题") || dp?.properties?.title?.title?.[0]?.plain_text || `金融日报 ${date}`;
    const summary = getText(dp, "日报摘要");

    const reportMarkdown = await fetchPageBlocksMarkdown(stripUuidDashes(dp.id));

    let eventPages = [];
    let useRelationFallback = false;
    try {
      eventPages = await queryDatabaseAll(EVENT_DB_ID, {
        page_size: 100,
        filter: {
          property: "所属日报",
          relation: { contains: dp.id },
        },
        sorts: [{ property: "事件日期", direction: "ascending" }],
      });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("object_not_found") || msg.includes("Could not find database")) {
        useRelationFallback = true;
      } else {
        throw e;
      }
    }

    if (useRelationFallback) {
      const relIds = await getRelationPageIds(dp, "关联事件");
      const pages = [];
      for (const id of relIds) {
        pages.push(await fetchPage(id));
      }
      // Sort by event date if available
      eventPages = pages.sort((a, b) => {
        const da = getDateStart(a, "事件日期") || getDateStart(a, "发布时间") || "";
        const db = getDateStart(b, "事件日期") || getDateStart(b, "发布时间") || "";
        return da.localeCompare(db);
      });
    }

    const events = eventPages.map((ep) => {
      const eventDate = getDateStart(ep, "事件日期");
      const publishDate = getDateStart(ep, "发布时间");
      const follow = getCheckbox(ep, "持续跟踪");
      return {
        title: getTitle(ep, "事件标题"),
        date: eventDate || publishDate || date,
        source: getSelect(ep, "来源"),
        category: getSelect(ep, "类别"),
        importance: getSelect(ep, "重要性"),
        summary: getText(ep, "一句话摘要"),
        impact: getText(ep, "核心影响"),
        targets: getText(ep, "影响对象"),
        direction: getSelect(ep, "影响方向"),
        keywords: getMultiSelect(ep, "关键词"),
        follow_up: follow ? "是" : "否",
        link: getUrl(ep, "原文链接"),
        notion_url: pageUrl(ep.id),
      };
    });

    const dayJson = {
      date,
      title,
      summary,
      notion_url: pageUrl(dp.id),
      reportMarkdown,
      events,
    };

    writeJson(path.join(DATA_DIR, `${date}.json`), dayJson);
    written += 1;
  }

  console.log(`Notion sync done. Wrote ${written} day file(s) into ${DATA_DIR}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
