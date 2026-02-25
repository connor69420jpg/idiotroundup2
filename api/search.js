import Anthropic from "@anthropic-ai/sdk";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const apifyToken = process.env.APIFY_API_TOKEN;

  if (!anthropicKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  try {
    const { url, platform, metadata } = req.body;
    if (!url || !platform) {
      return res.status(400).json({ error: "Missing url or platform" });
    }

    const videoId = extractVideoId(url, platform);
    const author = metadata?.author || "unknown";
    const client = new Anthropic({ apiKey: anthropicKey });

    // Step 1: Use AI to identify the video content first
    const videoInfo = await identifyVideo(client, url, platform, author);

    // Step 2: Run all searches in parallel
    const searches = [];

    // Apify TikTok search (if token available)
    if (apifyToken) {
      searches.push(
        apifyTikTokSearch(apifyToken, videoInfo.keywords, 30)
          .then(items => parseTikTokResults(items, videoId, author))
          .catch(err => { console.error("TikTok scrape error:", err.message); return []; })
      );

      searches.push(
        apifyInstagramSearch(apifyToken, videoInfo.hashtags, 30)
          .then(items => parseInstagramResults(items, author))
          .catch(err => { console.error("Instagram scrape error:", err.message); return []; })
      );
    }

    // AI web search (always runs — catches websites, YouTube, Twitter, etc.)
    searches.push(
      aiWebSearch(client, url, platform, author, videoInfo)
        .catch(err => { console.error("AI search error:", err.message); return []; })
    );

    const allPasses = await Promise.all(searches);
    let allResults = allPasses.flat();

    // Deduplicate
    const seen = new Set();
    allResults = allResults.filter((r) => {
      if (!r || !r.url) return false;
      let key = r.url.toLowerCase().replace(/[?#].*$/, "").replace(/\/$/, "");
      if (seen.has(key)) return false;
      if (videoId && key.includes(videoId)) return false;
      seen.add(key);
      return true;
    });

    // Sort: high confidence first
    allResults.sort((a, b) => {
      if (a.confidence === "high" && b.confidence !== "high") return -1;
      if (b.confidence === "high" && a.confidence !== "high") return 1;
      return 0;
    });

    return res.status(200).json({
      results: allResults,
      sources: {
        apify: !!apifyToken,
        ai_search: true,
      },
    });
  } catch (err) {
    console.error("API error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ===== IDENTIFY VIDEO CONTENT =====
async function identifyVideo(client, url, platform, author) {
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 400,
      system:
        'Look up this video and return ONLY a JSON object with: keywords (string - main search terms to find this video, 5-8 words), hashtags (string - comma-separated hashtags without #), description (string - one sentence about the video). No other text.',
      messages: [{ role: "user", content: `What is this video about? ${url} by ${author} on ${platform}` }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const match = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {}
  return { keywords: `${author} video ${platform}`, hashtags: "", description: "" };
}

// ===== APIFY TIKTOK SEARCH =====
async function apifyTikTokSearch(token, keywords, maxItems) {
  // Use the free TikTok scraper actor with search query
  const actorId = "clockworks~free-tiktok-scraper";
  const input = {
    searchQueries: [keywords],
    maxItems: maxItems,
    searchSection: "video",
  };

  const response = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}&timeout=60`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Apify TikTok error ${response.status}: ${errText.substring(0, 200)}`);
  }

  return await response.json();
}

// ===== APIFY INSTAGRAM SEARCH =====
async function apifyInstagramSearch(token, hashtags, maxItems) {
  // Use Instagram hashtag scraper
  const actorId = "apify~instagram-hashtag-scraper";
  const hashtagList = hashtags
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .slice(0, 3); // max 3 hashtags to save credits

  if (hashtagList.length === 0) return [];

  const input = {
    hashtags: hashtagList,
    resultsLimit: maxItems,
  };

  const response = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}&timeout=60`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Apify Instagram error ${response.status}: ${errText.substring(0, 200)}`);
  }

  return await response.json();
}

// ===== PARSE TIKTOK RESULTS =====
function parseTikTokResults(items, originalVideoId, originalAuthor) {
  if (!Array.isArray(items)) return [];
  const authorClean = originalAuthor.replace("@", "").toLowerCase();

  return items
    .filter((item) => {
      // Filter out the original video
      const itemId = String(item.id || item.videoId || "");
      if (itemId === originalVideoId) return false;
      // Filter out the original author
      const itemAuthor = (item.authorMeta?.name || item.author?.uniqueId || "").toLowerCase();
      if (itemAuthor === authorClean) return false;
      return true;
    })
    .map((item) => {
      const username = item.authorMeta?.name || item.author?.uniqueId || "unknown";
      const id = item.id || item.videoId || "";
      return {
        platform: "tiktok",
        account_name: `@${username}`,
        url: item.webVideoUrl || `https://www.tiktok.com/@${username}/video/${id}`,
        confidence: "high",
        date_found: item.createTimeISO
          ? item.createTimeISO.split("T")[0]
          : new Date().toISOString().split("T")[0],
        type: "repost",
        likes: item.diggCount || item.stats?.diggCount || 0,
        views: item.playCount || item.stats?.playCount || 0,
        comments: item.commentCount || item.stats?.commentCount || 0,
        shares: item.shareCount || item.stats?.shareCount || 0,
      };
    });
}

// ===== PARSE INSTAGRAM RESULTS =====
function parseInstagramResults(items, originalAuthor) {
  if (!Array.isArray(items)) return [];
  const authorClean = originalAuthor.replace("@", "").toLowerCase();

  return items
    .filter((item) => {
      const itemAuthor = (item.ownerUsername || "").toLowerCase();
      if (itemAuthor === authorClean) return false;
      return item.type === "Video" || item.videoUrl;
    })
    .map((item) => {
      const username = item.ownerUsername || "unknown";
      return {
        platform: "instagram",
        account_name: `@${username}`,
        url: item.url || `https://www.instagram.com/p/${item.shortCode}/`,
        confidence: "high",
        date_found: item.timestamp
          ? new Date(item.timestamp * 1000).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0],
        type: "repost",
        likes: item.likesCount || 0,
        views: item.videoViewCount || 0,
        comments: item.commentsCount || 0,
      };
    });
}

// ===== AI WEB SEARCH =====
async function aiWebSearch(client, url, platform, author, videoInfo) {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: `You find reposted video content. Do 5+ web searches. Return ONLY a JSON array.
Each object: platform (tiktok/instagram/youtube/facebook/twitter/website), account_name, url (REAL URL from search results only), confidence (high/medium), date_found (YYYY-MM-DD), type (repost/embed/reaction), likes (number or 0), views (number or 0), comments (number or 0), shares (number or 0).
Include any engagement numbers you find in the search results. Do NOT include the original: ${url}. NEVER fabricate URLs.`,
    messages: [
      {
        role: "user",
        content: `Find reposts of this video: ${url} by ${author}
Content: ${videoInfo.description}
Keywords: ${videoInfo.keywords}
Hashtags: ${videoInfo.hashtags}

Search for:
1. "instagram.com ${videoInfo.keywords}"
2. "whiskeyriff.com ${videoInfo.keywords}"
3. "${videoInfo.keywords} repost site:youtube.com OR site:twitter.com"
4. "${videoInfo.keywords} site:rollingstone.com OR site:billboard.com OR site:tmz.com"
5. "${author} ${videoInfo.keywords} reposted"
6. "${videoInfo.hashtags} repost TikTok Instagram"`,
      },
    ],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });

  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch {}
  return [];
}

// ===== HELPERS =====
function extractVideoId(url, platform) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (platform === "tiktok") {
      const idx = parts.indexOf("video");
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    }
    if (platform === "instagram") {
      const idx = parts.indexOf("reel") !== -1 ? parts.indexOf("reel") : parts.indexOf("reels");
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    }
    if (platform === "youtube") {
      if (u.pathname.includes("/shorts/")) return parts[parts.indexOf("shorts") + 1];
      return u.searchParams.get("v") || parts[parts.length - 1];
    }
  } catch {}
  return "";
}
