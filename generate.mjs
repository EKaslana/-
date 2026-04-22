import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "site");
const DATA_DIR = path.join(ROOT, "data", "days");
const DIST_DIR = path.join(ROOT, "dist");
const DIST_DAYS_DIR = path.join(DIST_DIR, "days");
const DIST_ASSETS_DIR = path.join(DIST_DIR, "assets");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replaceAll(/[\s/]+/g, "-")
    .replaceAll(/[^a-z0-9\u4e00-\u9fa5\-]+/g, "")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function renderInline(text) {
  let html = escapeHtml(text);
  html = html.replaceAll(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replaceAll(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  return html;
}

function markdownToHtml(md) {
  const lines = String(md ?? "").replaceAll("\r\n", "\n").split("\n");
  const toc = [];
  const out = [];

  let inUl = false;
  let inOl = false;

  function closeLists() {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      closeLists();
      continue;
    }

    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      closeLists();
      const title = h2[1].trim();
      const id = slugify(title);
      toc.push({ id, title });
      out.push(`<h2 id="${escapeHtml(id)}">${renderInline(title)}</h2>`);
      continue;
    }

    const ul = line.match(/^\-\s+(.+)$/);
    if (ul) {
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${renderInline(ul[1].trim())}</li>`);
      continue;
    }

    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        out.push("<ol>");
        inOl = true;
      }
      out.push(`<li>${renderInline(ol[1].trim())}</li>`);
      continue;
    }

    closeLists();
    out.push(`<p>${renderInline(line.trim())}</p>`);
  }

  closeLists();
  return { toc, html: out.join("\n") };
}

function extractFirstUrl(text) {
  const m = String(text ?? "").match(/https?:\/\/\S+/);
  return m ? m[0].replaceAll(/[)\],.，。；;]+$/g, "") : "";
}

function parseReportSections(md) {
  const lines = String(md ?? "").replaceAll("\r\n", "\n").split("\n");
  const sections = [];
  let current = null;

  function pushCurrent() {
    if (!current) return;
    if (current.items.length === 0 && current.raw.length === 0) return;
    sections.push(current);
  }

  function startSection(title) {
    pushCurrent();
    current = { title, items: [], raw: [] };
  }

  function pushItem(item) {
    if (!current) startSection("正文");
    current.items.push(item);
  }

  let activeItem = null;
  let lastItem = null;
  function flushItem() {
    if (!activeItem) return;
    pushItem(activeItem);
    lastItem = activeItem;
    activeItem = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      flushItem();
      startSection(h2[1].trim());
      continue;
    }

    if (!current) startSection("正文");
    const trimmed = line.trim();
    if (trimmed === "") {
      flushItem();
      continue;
    }

    const isList = trimmed.match(/^(-|\*|\d+\.)\s+(.+)$/);
    if (isList) {
      const content = isList[2].trim();
      const sourceLikeInline = content.match(/^(?:来源|source)[:：]\s*(.+)$/i);
      if (sourceLikeInline) {
        const url = extractFirstUrl(sourceLikeInline[1]);
        const target = activeItem ?? lastItem ?? (current.items.length ? current.items[current.items.length - 1] : null);
        if (target && url) target.sourceUrl = url;
        continue;
      }

      flushItem();
      activeItem = { text: content, sourceUrl: "" };
      const url = extractFirstUrl(content);
      if (url) activeItem.sourceUrl = url;
      continue;
    }

    const sourceLike = trimmed.match(/^(?:-|\*)?\s*来源[:：]\s*(.+)$/);
    if (sourceLike) {
      const url = extractFirstUrl(sourceLike[1]);
      const target = activeItem ?? lastItem ?? (current.items.length ? current.items[current.items.length - 1] : null);
      if (target && url) target.sourceUrl = url;
      continue;
    }

    // Continuation line
    if (activeItem) {
      activeItem.text = `${activeItem.text} ${trimmed}`.trim();
      const url = extractFirstUrl(trimmed);
      if (!activeItem.sourceUrl && url) activeItem.sourceUrl = url;
    } else {
      current.raw.push(trimmed);
    }
  }

  flushItem();
  pushCurrent();
  return sections;
}

function splitTagAndBody(text) {
  const m = String(text ?? "").match(/^【([^】]+)】\s*(.+)$/);
  if (!m) return { tag: "", body: String(text ?? "").trim() };
  return { tag: m[1].trim(), body: m[2].trim() };
}

function deriveTitleAndDesc(body) {
  const b = String(body ?? "").trim();
  if (!b) return { title: "", desc: "" };
  const idx = b.search(/[，。；;]/);
  if (idx <= 0) return { title: b, desc: "" };
  return { title: b.slice(0, idx).trim(), desc: b.slice(idx + 1).trim() };
}

function renderNoteCards(sectionTitle, items, palette) {
  const id = slugify(sectionTitle);
  const cards = items
    .map((it) => {
      const { tag, body } = splitTagAndBody(it.text);
      const parts = tag ? tag.split("｜").map((s) => s.trim()) : [];
      const category = parts[0] ?? "";
      const importance = parts[1] ?? "";
      const direction = parts[2] ?? "";
      const impDot = palette.importance[importance] ?? "#9ca3af";
      const border = palette.direction[direction] ?? "rgba(0,0,0,.12)";
      const { title, desc } = deriveTitleAndDesc(body);
      const pill = [category, importance, direction].filter(Boolean).join(" · ");
      return `<article class="note">
  <div class="note__accent" style="background:${escapeHtml(border)}"></div>
  <div class="note__head">
    <div class="note__title">${escapeHtml(title || body)}</div>
    ${pill ? `<div class="note__pill"><span class="idot" style="background:${escapeHtml(impDot)}"></span>${escapeHtml(pill)}</div>` : ""}
  </div>
  ${desc ? `<div class="note__desc">${escapeHtml(desc)}</div>` : ""}
  ${
    it.sourceUrl
      ? `<div class="note__foot">
  <div class="note__src">来源：<a href="${escapeHtml(it.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(it.sourceUrl)}</a></div>
  <a class="link" href="${escapeHtml(it.sourceUrl)}" target="_blank" rel="noreferrer">原文</a>
</div>`
      : ""
  }
</article>`;
    })
    .join("\n");

  return `<section class="block" id="${escapeHtml(id)}">
  <h2>${escapeHtml(sectionTitle)}</h2>
  <div class="notes">${cards || `<div class="empty">该章节无条目。</div>`}</div>
</section>`;
}

function computeStats(day) {
  const events = Array.isArray(day.events) ? day.events : [];
  const categories = new Set();
  let highest = "低";
  let highCount = 0;
  let followCount = 0;

  const importanceRank = { 低: 1, 中: 2, 高: 3 };

  for (const e of events) {
    if (e?.category) categories.add(e.category);
    const imp = e?.importance;
    if (imp === "高") highCount += 1;
    if (e?.follow_up === "是") followCount += 1;
    if ((importanceRank[imp] ?? 0) > (importanceRank[highest] ?? 0)) highest = imp;
  }

  return {
    eventCount: events.length,
    categories: Array.from(categories),
    highestImportance: highest,
    highCount,
    followCount,
  };
}

function computeBreakdowns(day) {
  const events = Array.isArray(day.events) ? day.events : [];
  const byCategory = new Map();
  const byImportance = new Map([["高", 0], ["中", 0], ["低", 0]]);
  const byDirection = new Map([["利多", 0], ["利空", 0], ["中性", 0]]);
  let followYes = 0;

  for (const e of events) {
    const c = e?.category ?? "未分类";
    byCategory.set(c, (byCategory.get(c) ?? 0) + 1);

    const imp = e?.importance ?? "低";
    byImportance.set(imp, (byImportance.get(imp) ?? 0) + 1);

    const dir = e?.direction ?? "中性";
    byDirection.set(dir, (byDirection.get(dir) ?? 0) + 1);

    if (e?.follow_up === "是") followYes += 1;
  }

  const categories = Array.from(byCategory.entries())
    .map(([k, v]) => ({ key: k, value: v }))
    .sort((a, b) => b.value - a.value);

  return {
    categories,
    importance: Array.from(byImportance.entries()).map(([k, v]) => ({ key: k, value: v })),
    direction: Array.from(byDirection.entries()).map(([k, v]) => ({ key: k, value: v })),
    follow: { yes: followYes, no: Math.max(0, events.length - followYes) },
  };
}

function chartColors() {
  return {
    importance: { 高: "#ef4444", 中: "#f59e0b", 低: "#22c55e" },
    direction: { 利多: "#22c55e", 利空: "#ef4444", 中性: "#a3a3a3" },
    category: {
      宏观经济: "#60a5fa",
      资本市场: "#34d399",
      金融机构: "#fbbf24",
      监管政策: "#fb7185",
      国际金融: "#a78bfa",
      重点公司: "#f97316",
      未分类: "#9ca3af",
    },
  };
}

function renderStackBar(parts, { width = 240, height = 10, colors = {} } = {}) {
  const total = parts.reduce((s, p) => s + (p.value ?? 0), 0);
  const safeTotal = total > 0 ? total : 1;
  let x = 0;
  const segs = parts
    .filter((p) => (p.value ?? 0) > 0)
    .map((p) => {
      const w = Math.max(2, Math.round((width * p.value) / safeTotal));
      const fill = colors[p.key] ?? "#9ca3af";
      const seg = `<rect x="${x}" y="0" width="${w}" height="${height}" rx="6" ry="6" fill="${fill}" fill-opacity="0.9"></rect>`;
      x += w;
      return seg;
    })
    .join("");

  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="分布图">
  <rect x="0" y="0" width="${width}" height="${height}" rx="6" ry="6" fill="rgba(255,255,255,0.08)"></rect>
  ${segs}
</svg>`;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function donutSegmentPath(cx, cy, rOuter, rInner, startAngle, endAngle) {
  const startOuter = polarToCartesian(cx, cy, rOuter, endAngle);
  const endOuter = polarToCartesian(cx, cy, rOuter, startAngle);
  const startInner = polarToCartesian(cx, cy, rInner, startAngle);
  const endInner = polarToCartesian(cx, cy, rInner, endAngle);
  const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 0 ${endOuter.x} ${endOuter.y}`,
    `L ${startInner.x} ${startInner.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 1 ${endInner.x} ${endInner.y}`,
    "Z",
  ].join(" ");
}

function renderDonut(parts, { size = 180, thickness = 28, colors = {} } = {}) {
  const total = parts.reduce((s, p) => s + (p.value ?? 0), 0);
  const safeTotal = total > 0 ? total : 1;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 4;
  const rInner = rOuter - thickness;

  let angle = 0;
  const segs = parts
    .filter((p) => (p.value ?? 0) > 0)
    .map((p) => {
      const delta = (360 * p.value) / safeTotal;
      const start = angle;
      const end = angle + delta;
      angle = end;
      const d = donutSegmentPath(cx, cy, rOuter, rInner, start, end);
      const fill = colors[p.key] ?? "#9ca3af";
      return `<path d="${d}" fill="${fill}" fill-opacity="0.92"></path>`;
    })
    .join("");

  const centerLabel = `<text x="${cx}" y="${cy - 2}" text-anchor="middle" dominant-baseline="central" fill="rgba(255,255,255,0.88)" font-size="22" font-weight="720">${escapeHtml(
    String(total),
  )}</text>
<text x="${cx}" y="${cy + 18}" text-anchor="middle" dominant-baseline="central" fill="rgba(255,255,255,0.62)" font-size="12">事件</text>`;

  return `<svg class="donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="类别分布">
  <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="rgba(255,255,255,0.05)"></circle>
  ${segs}
  ${centerLabel}
</svg>`;
}

function renderLegend(parts, colors) {
  const items = parts
    .filter((p) => (p.value ?? 0) > 0)
    .map((p) => {
      const c = colors[p.key] ?? "#9ca3af";
      return `<div class="legend__item">
  <span class="dot" style="background:${escapeHtml(c)}"></span>
  <span class="legend__key">${escapeHtml(p.key)}</span>
  <span class="legend__val">${escapeHtml(p.value)}</span>
</div>`;
    })
    .join("");
  return `<div class="legend">${items || `<div class="muted">无数据</div>`}</div>`;
}

function layout({ title, description, body, cssHref, homeHref }) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description ?? "")}" />
    <link rel="stylesheet" href="${escapeHtml(cssHref)}" />
  </head>
  <body>
    <div class="page">
      <div class="wrap">
        <div class="top">
          <a class="top__brand" href="${escapeHtml(homeHref)}">Finance Daily</a>
          <div class="top__meta">静态可视化 · 目录 + 每日卡片</div>
        </div>
        ${body}
        <footer class="footer">
          <div>生成于 ${escapeHtml(new Date().toISOString())}</div>
        </footer>
      </div>
    </div>
    <script type="module">
      const toggles = document.querySelectorAll("[data-toggle]");
      for (const btn of toggles) {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-toggle");
          const el = document.getElementById(id);
          if (!el) return;
          const next = el.getAttribute("data-open") !== "1";
          el.setAttribute("data-open", next ? "1" : "0");
        });
      }

      // Trend chart (index page)
      const trend = document.querySelector("[data-trend]");
      if (trend) {
        const raw = trend.getAttribute("data-series");
        const series = raw ? JSON.parse(raw) : [];
        const btns = document.querySelectorAll("[data-range]");
        const svg = trend.querySelector("svg");
        const pathMain = trend.querySelector("[data-path-main]");
        const pathAlt = trend.querySelector("[data-path-alt]");
        const dots = trend.querySelector("[data-dots]");
        const tooltip = trend.querySelector("[data-tooltip]");
        const label = trend.querySelector("[data-range-label]");

        function sliceSeries(range) {
          if (range === "all") return series;
          const n = Number(range);
          if (!Number.isFinite(n) || n <= 0) return series;
          return series.slice(Math.max(0, series.length - n));
        }

        function buildPath(points, w, h, pad, maxY, field) {
          const usableW = w - pad * 2;
          const usableH = h - pad * 2;
          const n = points.length;
          if (n === 0) return "";
          const scaleX = n === 1 ? 0 : usableW / (n - 1);
          const scaleY = maxY <= 0 ? 0 : usableH / maxY;
          let d = "";
          for (let i = 0; i < n; i++) {
            const x = pad + i * scaleX;
            const v = points[i][field] ?? 0;
            const y = pad + (usableH - v * scaleY);
            d += (i === 0 ? "M" : " L") + " " + x.toFixed(2) + " " + y.toFixed(2);
          }
          return d;
        }

        function render(range) {
          const points = sliceSeries(range);
          const w = 860;
          const h = 220;
          const pad = 18;
          const maxY = Math.max(1, ...points.map((p) => p.events ?? 0));
          if (label) label.textContent = range === "all" ? "全部" : "最近" + range + "天";

          if (pathMain) pathMain.setAttribute("d", buildPath(points, w, h, pad, maxY, "events"));
          if (pathAlt) pathAlt.setAttribute("d", buildPath(points, w, h, pad, maxY, "high"));
          if (dots) {
            const usableW = w - pad * 2;
            const usableH = h - pad * 2;
            const n = points.length;
            const scaleX = n === 1 ? 0 : usableW / (n - 1);
            const scaleY = maxY <= 0 ? 0 : usableH / maxY;
            dots.innerHTML = points
              .map((p, i) => {
                const x = pad + i * scaleX;
                const y = pad + (usableH - (p.events ?? 0) * scaleY);
                return (
                  '<circle cx="' +
                  x.toFixed(2) +
                  '" cy="' +
                  y.toFixed(2) +
                  '" r="3.2" data-x="' +
                  x.toFixed(2) +
                  '" data-y="' +
                  y.toFixed(2) +
                  '" data-date="' +
                  p.date +
                  '" data-events="' +
                  p.events +
                  '" data-high="' +
                  p.high +
                  '"></circle>'
                );
              })
              .join("");
          }
        }

        function setActive(range) {
          for (const b of btns) b.toggleAttribute("data-active", b.getAttribute("data-range") === range);
        }

        function init() {
          const defaultRange = trend.getAttribute("data-default-range") || "30";
          setActive(defaultRange);
          render(defaultRange);
        }

        for (const b of btns) {
          b.addEventListener("click", () => {
            const range = b.getAttribute("data-range") || "all";
            setActive(range);
            render(range);
          });
        }

        if (svg && tooltip) {
          svg.addEventListener("mousemove", (ev) => {
            const target = ev.target;
            if (!(target instanceof SVGCircleElement)) return;
            const date = target.getAttribute("data-date") || "";
            const events = target.getAttribute("data-events") || "0";
            const high = target.getAttribute("data-high") || "0";
            tooltip.innerHTML =
              '<div class="tt__t">' +
              date +
              '</div><div class="tt__b">事件 ' +
              events +
              " · 高 " +
              high +
              "</div>";
            tooltip.style.opacity = "1";
            const rect = svg.getBoundingClientRect();
            tooltip.style.left = String(ev.clientX - rect.left + 12) + "px";
            tooltip.style.top = String(ev.clientY - rect.top - 12) + "px";
          });
          svg.addEventListener("mouseleave", () => {
            tooltip.style.opacity = "0";
          });
        }

        init();
      }
    </script>
  </body>
</html>`;
}

function renderIndex(days) {
  return renderIndexWithConfig(days, {
    cssHref: "./assets/styles.css",
    homeHref: "./index.html",
    dayHrefPrefix: "./days/",
  });
}

function renderIndexWithConfig(days, { cssHref, homeHref, dayHrefPrefix }) {
  const cards = days
    .map((d) => {
      const stats = computeStats(d);
      const breakdown = computeBreakdowns(d);
      const palette = chartColors();
      const href = `${dayHrefPrefix}${encodeURIComponent(d.date)}.html`;
      const catText = stats.categories.slice(0, 4).join(" · ");
      const impBar = renderStackBar(breakdown.importance, { width: 280, height: 10, colors: palette.importance });
      return `<a class="card" href="${href}">
  <div class="card__top">
    <div class="card__k">FINANCE DAILY</div>
    <div class="badge">${escapeHtml(d.date)}</div>
  </div>
  <div class="card__title">${escapeHtml(d.title ?? `金融日报 ${d.date}`)}</div>
  <div class="card__desc">${escapeHtml(d.summary ?? "")}</div>
  <div class="card__bar">${impBar}</div>
  <div class="stat-grid">
    <div class="stat">
      <div class="stat__k">事件总数</div>
      <div class="stat__v">${escapeHtml(stats.eventCount)}</div>
    </div>
    <div class="stat">
      <div class="stat__k">需跟踪 / 高重要</div>
      <div class="stat__v">${escapeHtml(stats.followCount)} / ${escapeHtml(stats.highCount)}</div>
    </div>
  </div>
  <div class="card__foot">
    <div class="card__tags">${escapeHtml(catText || "—")}</div>
    <div class="chip">${escapeHtml(stats.highestImportance)} 级</div>
  </div>
</a>`;
    })
    .join("\n");

  const totals = days.reduce(
    (acc, d) => {
      const s = computeStats(d);
      acc.days += 1;
      acc.events += s.eventCount;
      acc.high += s.highCount;
      acc.follow += s.followCount;
      return acc;
    },
    { days: 0, events: 0, high: 0, follow: 0 },
  );

  const series = days
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => {
      const s = computeStats(d);
      return { date: d.date, events: s.eventCount, high: s.highCount, follow: s.followCount };
    });

  const trend =
    series.length >= 2
      ? `
    <div class="trend" data-trend data-default-range="30" data-series='${escapeHtml(JSON.stringify(series))}'>
      <div class="trend__head">
        <div>
          <div class="trend__k">趋势</div>
          <div class="trend__v"><span data-range-label>最近30天</span> · 事件（主线）/ 高重要（辅线）</div>
        </div>
        <div class="seg">
          <button class="seg__btn" data-range="7">7天</button>
          <button class="seg__btn" data-range="30">30天</button>
          <button class="seg__btn" data-range="all">全部</button>
        </div>
      </div>
      <div class="trend__wrap">
        <div class="trend__tooltip" data-tooltip></div>
        <svg viewBox="0 0 860 220" width="860" height="220" class="trend__svg" aria-label="趋势图">
          <defs>
            <linearGradient id="gMain" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color="rgba(47,129,247,0.26)"></stop>
              <stop offset="100%" stop-color="rgba(47,129,247,0)"></stop>
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="860" height="220" rx="14" fill="rgba(255,255,255,0.03)"></rect>
          <path data-path-main fill="none" stroke="rgba(47,129,247,0.95)" stroke-width="2.2" stroke-linecap="round"></path>
          <path data-path-alt fill="none" stroke="rgba(34,197,94,0.85)" stroke-width="2" stroke-dasharray="4 6" stroke-linecap="round"></path>
          <g data-dots fill="rgba(47,129,247,0.95)"></g>
        </svg>
      </div>
      <div class="trend__legend">
        <span class="lg"><span class="lg__swatch" style="background:rgba(47,129,247,0.95)"></span>事件</span>
        <span class="lg"><span class="lg__swatch" style="background:rgba(34,197,94,0.85)"></span>高重要</span>
      </div>
    </div>
  `
      : "";

  const body = `
    <section class="hero">
      <div class="hero__pill">FINANCE DAILY DIRECTORY</div>
      <h1 class="hero__title">金融日报 目录</h1>
      <p class="hero__desc">目录页按卡片展示每个“日期”。后续只需新增一个日期 JSON 文件，重新运行生成脚本后会自动新增一张卡片和对应详情页。</p>
      <div class="hero__meta">
        <span>记录源：<code>site/data/days</code></span>
        <span>卡片数量：<strong>${escapeHtml(totals.days)}</strong></span>
        <span>输出目录：<code>site/dist</code></span>
      </div>
      <div class="hero__kpis">
        <div class="kpi">
          <div class="kpi__k">事件总数</div>
          <div class="kpi__v">${escapeHtml(totals.events)}</div>
        </div>
        <div class="kpi">
          <div class="kpi__k">高重要</div>
          <div class="kpi__v">${escapeHtml(totals.high)}</div>
        </div>
        <div class="kpi">
          <div class="kpi__k">需跟踪</div>
          <div class="kpi__v">${escapeHtml(totals.follow)}</div>
        </div>
      </div>
      ${trend}
    </section>
    <section class="cards">
      ${cards || `<div class="empty">未发现任何日报数据：请在 <code>site/data/days</code> 新增 JSON。</div>`}
    </section>
  `;

  return layout({
    title: "金融日报 · 目录",
    description: "金融日报静态目录",
    body,
    cssHref,
    homeHref,
  });
}

function renderDayPage(day, allDays, { homeHref = "../index.html" } = {}) {
  const stats = computeStats(day);
  const breakdown = computeBreakdowns(day);
  const palette = chartColors();
  const parsedSections = parseReportSections(day.reportMarkdown ?? "");
  const sections = parsedSections.filter((s) => String(s.title ?? "").trim().toUpperCase() !== "JSON");
  const tocHtml = sections
    .map((s) => {
      const id = slugify(s.title);
      return `<a class="toc__item" href="#${escapeHtml(id)}">${escapeHtml(s.title)}</a>`;
    })
    .join("\n");

  const events = Array.isArray(day.events) ? day.events : [];
  const eventCards = events
    .map((e) => {
      const keywords = Array.isArray(e.keywords) ? e.keywords : [];
      const kw = keywords.slice(0, 6).map((k) => `<span class="chip2">${escapeHtml(k)}</span>`).join("");
      const header = `${escapeHtml(e.category ?? "")} · ${escapeHtml(e.importance ?? "")} · ${escapeHtml(e.direction ?? "")}`;
      const border = palette.direction[e.direction] ?? "rgba(255,255,255,.18)";
      const impDot = palette.importance[e.importance] ?? "#9ca3af";
      const follow = e.follow_up === "是" ? `<span class="flag">跟踪</span>` : "";
      return `<article class="event">
  <div class="event__accent" style="background:${escapeHtml(border)}"></div>
  <div class="event__head">
    <div class="event__title">${escapeHtml(e.title ?? "")}</div>
    <div class="event__pill"><span class="idot" style="background:${escapeHtml(impDot)}"></span>${header}${follow}</div>
  </div>
  <div class="event__sub">
    <span>${escapeHtml(e.source ?? "")}</span>
    ${e.date ? `<span>事件日 ${escapeHtml(e.date)}</span>` : ""}
    ${e.notion_url ? `<span><a class="mini-link" href="${escapeHtml(e.notion_url)}" target="_blank" rel="noreferrer">Notion</a></span>` : ""}
  </div>
  <div class="event__one">${escapeHtml(e.summary ?? "")}</div>
  <div class="event__grid">
    <div><div class="k">核心影响</div><div class="v">${escapeHtml(e.impact ?? "")}</div></div>
    <div><div class="k">影响对象</div><div class="v">${escapeHtml(e.targets ?? "")}</div></div>
  </div>
  <div class="event__foot">
    <div class="chips">${kw}</div>
    ${e.link ? `<a class="link" href="${escapeHtml(e.link)}" target="_blank" rel="noreferrer">原文</a>` : ""}
  </div>
</article>`;
    })
    .join("\n");

  const jsonBoxId = `json_${slugify(day.date)}`;
  const jsonText = escapeHtml(JSON.stringify(events, null, 2));

  const donut = renderDonut(breakdown.categories, { colors: palette.category });
  const categoryLegend = renderLegend(breakdown.categories, palette.category);
  const dirBar = renderStackBar(breakdown.direction, { width: 240, height: 12, colors: palette.direction });
  const impBar = renderStackBar(breakdown.importance, { width: 240, height: 12, colors: palette.importance });

  const dominantDirection = breakdown.direction.reduce(
    (m, x) => (x.value > m.value ? x : m),
    { key: "—", value: -1 },
  ).key;

  const sectionCardsHtml = sections
    .map((s) => {
      const items = s.items.length ? s.items : s.raw.map((t) => ({ text: t, sourceUrl: "" }));
      return renderNoteCards(s.title, items, palette);
    })
    .join("\n");

  const body = `
    <section class="hero hero--day">
      <div class="hero__pill">FINANCE DAILY</div>
      <h1 class="hero__title">${escapeHtml(day.title ?? `金融日报 ${day.date}`)}</h1>
      <div class="hero__meta">
        <span>日期：<strong>${escapeHtml(day.date)}</strong></span>
        <span>事件：<strong>${escapeHtml(stats.eventCount)}</strong></span>
        <span>高重要：<strong>${escapeHtml(stats.highCount)}</strong></span>
        <span>需跟踪：<strong>${escapeHtml(stats.followCount)}</strong></span>
        <span><a class="hero__link" href="${escapeHtml(homeHref)}">返回目录</a></span>
      </div>
      ${day.summary ? `<p class="hero__desc">${escapeHtml(day.summary)}</p>` : ""}
      ${day.notion_url ? `<div class="hero__meta"><span><a class="hero__link" href="${escapeHtml(day.notion_url)}" target="_blank" rel="noreferrer">打开 Notion 日报</a></span></div>` : ""}
      <div class="hero__kpis">
        <div class="kpi">
          <div class="kpi__k">最高重要性</div>
          <div class="kpi__v">${escapeHtml(stats.highestImportance)}</div>
          <div class="kpi__mini">${impBar}</div>
        </div>
        <div class="kpi">
          <div class="kpi__k">影响方向</div>
          <div class="kpi__v">${escapeHtml(dominantDirection)}</div>
          <div class="kpi__mini">${dirBar}</div>
        </div>
        <div class="kpi kpi--wide">
          <div class="kpi__k">类别分布</div>
          <div class="viz">
            <div class="viz__chart">${donut}</div>
            <div class="viz__legend">${categoryLegend}</div>
          </div>
        </div>
      </div>
    </section>

    <section class="block">
      <h2 id="目录">目录</h2>
      <div class="toc">${tocHtml || `<div class="muted">未检测到二级标题（##）。</div>`}</div>
    </section>

    ${sectionCardsHtml}

    <section class="block">
      <h2 id="事件">事件</h2>
      <div class="events">${eventCards || `<div class="empty">该日报未包含事件数组。</div>`}</div>
    </section>

    <section class="block">
      <div class="json-head">
        <h2 id="JSON">JSON</h2>
        <button class="btn" data-toggle="${jsonBoxId}">展开/收起</button>
      </div>
      <pre class="json" id="${jsonBoxId}" data-open="0">${jsonText}</pre>
    </section>
  `;

  return layout({
    title: day.title ?? `金融日报 ${day.date}`,
    description: day.summary ?? "",
    body,
    cssHref: "../assets/styles.css",
    homeHref,
  });
}

function validateDay(day, filePath) {
  const errors = [];
  if (!day || typeof day !== "object") errors.push("不是对象");
  if (!day.date || !/^\d{4}\-\d{2}\-\d{2}$/.test(day.date)) errors.push("date 必须为 YYYY-MM-DD");
  if (day.events && !Array.isArray(day.events)) errors.push("events 必须为数组");
  if (errors.length > 0) {
    const msg = `数据文件无效：${filePath}\n- ${errors.join("\n- ")}`;
    throw new Error(msg);
  }
}

function main() {
  ensureDir(DIST_DIR);
  ensureDir(DIST_DAYS_DIR);
  ensureDir(DIST_ASSETS_DIR);

  const repoIndexPath = path.resolve(process.cwd(), "index.html");
  const rootIndexEnabled =
    process.argv.includes("--root-index") ||
    process.env.ROOT_INDEX === "1" ||
    (fs.existsSync(repoIndexPath) && !process.argv.includes("--no-root-index"));

  const files = fs
    .readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".json"))
    .map((d) => path.join(DATA_DIR, d.name));

  const days = files
    .map((fp) => {
      const day = readJson(fp);
      validateDay(day, fp);
      return day;
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  const distIndexHtml = renderIndexWithConfig(days, {
    cssHref: "./assets/styles.css",
    homeHref: "./index.html",
    dayHrefPrefix: "./days/",
  });
  writeText(path.join(DIST_DIR, "index.html"), distIndexHtml);

  if (rootIndexEnabled) {
    const rootIndexHtml = renderIndexWithConfig(days, {
      cssHref: "./site/dist/assets/styles.css",
      homeHref: "./index.html",
      dayHrefPrefix: "./site/dist/days/",
    });
    writeText(repoIndexPath, rootIndexHtml);
  }

  for (const day of days) {
    const pageHtml = renderDayPage(day, days, {
      homeHref: rootIndexEnabled ? "../../../index.html" : "../index.html",
    });
    writeText(path.join(DIST_DAYS_DIR, `${day.date}.html`), pageHtml);
  }

  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  writeText(path.join(DIST_ASSETS_DIR, "styles.css"), css);

  // Convenience for file:// previews
  writeText(
    path.join(DIST_DIR, ".nojekyll"),
    "This folder is generated by node site/generate.mjs\n",
  );

  console.log(`Generated ${days.length} day(s). Output: ${DIST_DIR}`);
}

main();
