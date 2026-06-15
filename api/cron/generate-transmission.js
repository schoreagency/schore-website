// /api/cron/generate-transmission.js
//
// SCHORE — Transmissions auto-publisher
// Triggered weekly by Vercel Cron (see vercel.json).
// 1. Pulls the next topic from data/topics.json
// 2. Asks Groq (llama-3.3-70b-versatile) to write the post in SCHORE's voice
// 3. Builds a static HTML page matching the SCHORE design system
// 4. Commits the new page + updates transmissions/index.html + sitemap.xml + topics.json
//
// Required environment variables (set in Vercel → Project → Settings → Environment Variables):
//   GROQ_API_KEY     - Groq API key
//   GITHUB_TOKEN     - GitHub Personal Access Token with "repo" scope (Contents: read/write)
//   GITHUB_OWNER     - e.g. "schoreagency"
//   GITHUB_REPO      - e.g. "schore-website"
//   GITHUB_BRANCH    - optional, defaults to "main"
//   CRON_SECRET      - optional shared secret to prevent unauthorized manual triggers

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GITHUB_API = 'https://api.github.com';
const SITE_URL = 'https://schore.agency';

const {
  GROQ_API_KEY,
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH = 'main',
  CRON_SECRET,
} = process.env;

module.exports = async function handler(req, res) {
  // ── Optional auth check ──
  if (CRON_SECRET) {
    const authHeader = req.headers['authorization'] || '';
    const qsSecret = (req.query && req.query.secret) || '';
    if (authHeader !== `Bearer ${CRON_SECRET}` && qsSecret !== CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // ── Sanity check env vars ──
  const missing = ['GROQ_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({ error: `Missing environment variables: ${missing.join(', ')}` });
  }

  try {
    // 1. Load topic queue
    const topicsFile = await ghGetFile('data/topics.json');
    if (!topicsFile) throw new Error('data/topics.json not found in repo');
    const topics = JSON.parse(topicsFile.content);

    if (!topics.queue || topics.queue.length === 0) {
      return res.status(200).json({
        message: 'Topic queue is empty. Add more topics to data/topics.json to keep publishing.',
      });
    }

    const topic = topics.queue[0];

    // 2. Generate post content
    const post = await generatePost(topic);

    // 3. Build a unique slug
    const baseSlug = post.slug ? slugify(post.slug) : slugify(post.title);
    const slug = await ensureUniqueSlug(baseSlug);

    const dateStr = new Date().toISOString().split('T')[0];

    // 4. Build the static HTML page
    const html = buildPostHTML(post, topic.category, dateStr, slug);

    // 5. Commit the new post page
    await ghPutFile(`transmissions/${slug}.html`, html, `transmissions: add "${post.title}"`);

    // 6. Update the transmissions index page
    await updateIndex(post, topic.category, dateStr, slug);

    // 7. Update sitemap.xml
    await updateSitemap(slug, dateStr);

    // 8. Update topics.json — move topic from queue to used
    topics.queue.shift();
    topics.used = topics.used || [];
    topics.used.push({ ...topic, slug, published: dateStr });
    await ghPutFile(
      'data/topics.json',
      JSON.stringify(topics, null, 2),
      `transmissions: mark "${topic.id}" used`,
      topicsFile.sha
    );

    return res.status(200).json({
      success: true,
      title: post.title,
      slug,
      url: `${SITE_URL}/transmissions/${slug}`,
      remaining_topics: topics.queue.length,
    });
  } catch (err) {
    console.error('generate-transmission error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ════════════════════════════════════
// GitHub Contents API helpers
// ════════════════════════════════════

async function ghGetFile(path) {
  const url = `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return {
    sha: data.sha,
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
  };
}

async function ghPutFile(path, content, message, sha) {
  const url = `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
  const body = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '');
}

async function ensureUniqueSlug(slug) {
  let candidate = slug;
  let i = 2;
  while (await ghGetFile(`transmissions/${candidate}.html`)) {
    candidate = `${slug}-${i}`;
    i += 1;
  }
  return candidate;
}

// ════════════════════════════════════
// Groq content generation
// ════════════════════════════════════

const SYSTEM_PROMPT = `You are the writing voice of SCHORE, an anonymous brand strategy and performance marketing agency. Brand line: "Unknown Operators // Unmistakable Results."

Voice rules:
- Confident, direct, analytical. Operator-to-operator, not agency-to-prospect.
- No hype, no "game-changing", no emoji, no fluff intros like "In today's fast-paced world".
- Write for founders and marketers running e-commerce and DTC brands.
- Take a clear point of view. Mild contrarian framing is good when it's earned.
- Use concrete reasoning. Illustrative numbers are fine if framed as typical/illustrative, never claimed as real-time data.
- Sentence case headings, no title case.`;

async function generatePost(topic) {
  const userPrompt = `Write a "Transmissions" post for SCHORE on this topic: "${topic.topic}"
Category: ${topic.category}

Respond with ONLY valid JSON, no markdown formatting, no code fences. Use exactly this structure:
{
  "title": "string, under 70 characters",
  "slug": "lowercase-hyphenated-slug-under-60-chars",
  "meta_description": "string, under 155 characters, for SEO",
  "hook": "1-2 sentence opening hook, sets up the argument",
  "sections": [
    {"heading": "string", "body": "2-4 short paragraphs separated by \\n\\n"},
    {"heading": "string", "body": "..."},
    {"heading": "string", "body": "..."}
  ],
  "takeaway": "2-3 sentence closing paragraph in SCHORE's voice, the point of view to leave the reader with"
}

3 to 5 sections total.`;

  const r = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.8,
      response_format: { type: 'json_object' },
    }),
  });

  if (!r.ok) throw new Error(`Groq API failed: ${r.status} ${await r.text()}`);

  const data = await r.json();
  let raw = data.choices[0].message.content.trim();
  raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

  const parsed = JSON.parse(raw);
  if (!parsed.title || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    throw new Error('Groq response missing required fields');
  }
  return parsed;
}

// ════════════════════════════════════
// HTML escaping
// ════════════════════════════════════

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function paragraphs(text) {
  return String(text)
    .split(/\n\s*\n/)
    .map((p) => `<p>${esc(p.trim())}</p>`)
    .join('\n        ');
}

// ════════════════════════════════════
// Post page template
// ════════════════════════════════════

const PAGE_CSS = `
*{margin:0;padding:0;box-sizing:border-box;}
html{scroll-behavior:smooth;}
body{background:#f4f2ee;color:#111;font-family:'DM Sans',sans-serif;overflow-x:hidden;}
:root{--bg:#f4f2ee;--bg2:#edeae4;--orange:#ff5500;--black:#111111;--mid:#555555;--light:#888888;--border:rgba(17,17,17,0.1);--border-strong:rgba(17,17,17,0.18);}
nav{position:fixed;top:0;left:0;right:0;z-index:200;display:flex;justify-content:space-between;align-items:center;padding:20px 64px;background:rgba(244,242,238,0.92);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);}
.nav-logo{font-family:'Bebas Neue',sans-serif;font-size:24px;letter-spacing:10px;color:#111;text-decoration:none;display:flex;align-items:center;}
.nav-logo span{color:#ff5500;}
.nav-back{font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:3px;color:#555;text-decoration:none;transition:color .2s;}
.nav-back:hover{color:#ff5500;}
.nav-cta{font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:3px;padding:12px 24px;background:#ff5500;color:#fff;text-decoration:none;transition:background .2s;clip-path:polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,8px 100%,0 calc(100% - 8px));}
.nav-cta:hover{background:#111;}
.hero{background:#111;padding:140px 64px 72px;position:relative;overflow:hidden;}
.hero::before{content:'';position:absolute;inset:0;background-image:linear-gradient(rgba(255,85,0,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,85,0,0.05) 1px,transparent 1px);background-size:60px 60px;}
.hero-tag{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:5px;color:rgba(255,85,0,.7);margin-bottom:20px;display:flex;align-items:center;gap:12px;position:relative;z-index:1;}
.hero-tag::before{content:'';width:28px;height:1px;background:#ff5500;}
.hero-title{font-family:'Bebas Neue',sans-serif;font-size:clamp(40px,6vw,68px);letter-spacing:2px;color:#fff;line-height:1.1;margin-bottom:20px;position:relative;z-index:1;max-width:820px;}
.hero-hook{font-size:16px;color:rgba(255,255,255,.5);max-width:640px;line-height:1.85;font-weight:300;position:relative;z-index:1;}
.hero-meta{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:3px;color:rgba(255,255,255,.25);margin-top:28px;position:relative;z-index:1;}
.page-body{max-width:760px;margin:0 auto;padding:64px 24px 100px;}
.section{margin-bottom:48px;}
.sec-title{font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:2px;color:#111;margin-bottom:16px;}
.section p{font-size:16px;line-height:1.9;color:#333;margin-bottom:16px;font-weight:400;}
.section p:last-child{margin-bottom:0;}
.takeaway{background:#edeae4;border-left:4px solid #ff5500;padding:28px 32px;margin-top:8px;}
.takeaway-label{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:4px;color:#ff5500;margin-bottom:10px;}
.takeaway p{font-size:16px;line-height:1.85;color:#222;margin:0;}
.cta-block{background:#111;padding:48px;text-align:center;margin-top:56px;}
.cta-label{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:4px;color:rgba(255,255,255,.3);margin-bottom:12px;}
.cta-title{font-family:'Bebas Neue',sans-serif;font-size:40px;letter-spacing:3px;color:#fff;margin-bottom:20px;}
.cta-title span{color:#ff5500;}
.cta-btn{display:inline-block;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:4px;padding:18px 48px;background:#ff5500;color:#fff;text-decoration:none;clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px));}
footer{background:#111;padding:40px 64px;border-top:3px solid #ff5500;display:flex;justify-content:space-between;align-items:center;}
.foot-logo{font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:6px;color:#fff;text-decoration:none;}
.foot-logo span{color:#ff5500;}
.foot-right{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:3px;color:rgba(255,255,255,.3);}
@media(max-width:768px){nav{padding:16px 24px;}.hero{padding:110px 24px 56px;}.page-body{padding:48px 20px 80px;}.cta-block{padding:36px 24px;}}
`;

function buildPostHTML(post, category, dateStr, slug) {
  const sectionsHTML = post.sections
    .map(
      (s) => `<div class="section">
        <h2 class="sec-title">${esc(s.heading)}</h2>
        ${paragraphs(s.body)}
      </div>`
    )
    .join('\n      ');

  const schema = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"${esc(
    post.title
  )}","description":"${esc(post.meta_description)}","datePublished":"${dateStr}","author":{"@type":"Organization","name":"SCHORE","url":"${SITE_URL}"},"publisher":{"@type":"Organization","name":"SCHORE","logo":{"@type":"ImageObject","url":"${SITE_URL}/favicon-180.png"}},"mainEntityOfPage":{"@type":"WebPage","@id":"${SITE_URL}/transmissions/${slug}"}}</script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(post.title)} — SCHORE Transmissions</title>
<meta name="description" content="${esc(post.meta_description)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${SITE_URL}/transmissions/${slug}">
<meta property="og:type" content="article">
<meta property="og:url" content="${SITE_URL}/transmissions/${slug}">
<meta property="og:title" content="${esc(post.title)}">
<meta property="og:description" content="${esc(post.meta_description)}">
<meta property="og:image" content="${SITE_URL}/favicon-180.png">
<meta property="og:site_name" content="SCHORE">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(post.title)}">
<meta name="twitter:description" content="${esc(post.meta_description)}">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" href="/favicon-180.png">
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>${PAGE_CSS}</style>
${schema}
<script async src="https://www.googletagmanager.com/gtag/js?id=G-10EHSDF0Y6"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-10EHSDF0Y6');</script>
</head>
<body>
<nav>
  <a href="/" class="nav-logo"><span>S</span>CHORE</a>
  <a href="/transmissions" class="nav-back">&larr; ALL TRANSMISSIONS</a>
  <a href="/#contact" class="nav-cta">START A PROJECT</a>
</nav>

<div class="hero">
  <div class="hero-tag">// TRANSMISSION — ${esc(category)}</div>
  <h1 class="hero-title">${esc(post.title)}</h1>
  <p class="hero-hook">${esc(post.hook)}</p>
  <div class="hero-meta">${dateStr} // SCHORE</div>
</div>

<div class="page-body">
  ${sectionsHTML}

  <div class="section">
    <div class="takeaway">
      <div class="takeaway-label">// SCHORE'S TAKE</div>
      <p>${esc(post.takeaway)}</p>
    </div>
  </div>

  <div class="cta-block">
    <div class="cta-label">// START A PROJECT</div>
    <div class="cta-title">READY TO <span>SCALE?</span></div>
    <a href="/#contact" class="cta-btn">GET IN TOUCH &rarr;</a>
  </div>
</div>

<footer>
  <a href="/" class="foot-logo"><span>S</span>CHORE</a>
  <div class="foot-right">&copy; 2026 SCHORE // SCHORE.AGENCY</div>
</footer>
</body>
</html>`;
}

// ════════════════════════════════════
// Index page + sitemap updates
// ════════════════════════════════════

async function updateIndex(post, category, dateStr, slug) {
  const indexFile = await ghGetFile('transmissions/index.html');
  if (!indexFile) throw new Error('transmissions/index.html not found in repo');

  const card = `<a href="/transmissions/${slug}" class="t-card">
        <div class="t-card-cat">// ${esc(category)}</div>
        <div class="t-card-title">${esc(post.title)}</div>
        <div class="t-card-desc">${esc(post.hook)}</div>
        <div class="t-card-date">${dateStr}</div>
      </a>
      `;

  const marker = '<!-- TRANSMISSION_CARDS -->';
  if (!indexFile.content.includes(marker)) {
    throw new Error('transmissions/index.html missing <!-- TRANSMISSION_CARDS --> marker');
  }

  const updated = indexFile.content.replace(marker, `${marker}\n      ${card}`);
  await ghPutFile('transmissions/index.html', updated, `transmissions: list "${post.title}"`, indexFile.sha);
}

async function updateSitemap(slug, dateStr) {
  const sitemapFile = await ghGetFile('sitemap.xml');
  if (!sitemapFile) {
    console.warn('sitemap.xml not found — skipping sitemap update');
    return;
  }

  const entry = `  <url><loc>${SITE_URL}/transmissions/${slug}</loc><lastmod>${dateStr}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>\n`;
  const updated = sitemapFile.content.replace('</urlset>', `${entry}</urlset>`);
  await ghPutFile('sitemap.xml', updated, `sitemap: add transmissions/${slug}`, sitemapFile.sha);
}
