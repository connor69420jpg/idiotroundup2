import Anthropic from "@anthropic-ai/sdk";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  try {
    const { url, platform, metadata } = req.body;
    if (!url || !platform) {
      return res.status(400).json({ error: "Missing url or platform" });
    }

    const client = new Anthropic({ apiKey });
    const videoId = extractVideoId(url, platform);
    const author = metadata?.author || "unknown";

    // Run all search passes in parallel for speed
    const passes = await Promise.all([
      runSearch(client, `Go to this TikTok video and find out what it is about: ${url}
Then search for EVERY TikTok account that reposted this same video. Specifically search for each of these accounts and check if they posted this video:
- Search: "countrycentral hawk tuah revival TikTok"
- Search: "barstoolsports hawk tuah zach bryan TikTok"  
- Search: "zachbryanarchive hawk tuah TikTok"
- Search: "oklahomanoutlaw hawk tuah zach bryan TikTok"
- Search: "morezachbryan hawk tuah TikTok"
For each result, I need the EXACT TikTok URL (like https://www.tiktok.com/@username/video/1234567890).
Do at least 5 separate web searches.`, url, videoId),

      runSearch(client, `Search Instagram for every account that reposted the Hawk Tuah Revival Zach Bryan video originally posted by @greatamericanbarscene on TikTok.
Do these specific searches:
- Search: "instagram.com countrycentral hawk tuah zach bryan"
- Search: "instagram.com zachbryanarchive hawk tuah revival reel"
- Search: "instagram.com whiskeyriff hawk tuah zach bryan"
- Search: "instagram.com barstoolsports hawk tuah zach bryan reel"
- Search: "instagram.com dailymail hawk tuah zach bryan"
- Search: "instagram reel hawk tuah revival nashville"
I need EXACT Instagram URLs (like https://www.instagram.com/username/reel/ABC123/ or https://www.instagram.com/p/ABC123/).
Do at least 5 separate web searches and return every Instagram post/reel you find.`, url, videoId),

      runSearch(client, `Search for every news website, blog, and YouTube video that featured or embedded the Hawk Tuah Revival video by @greatamericanbarscene. 
Do these specific searches:
- Search: "whiskeyriff.com hawk tuah zach bryan revival"
- Search: "rollingstone.com zach bryan hawk tuah"
- Search: "billboard.com zach bryan hawk tuah"
- Search: "tasteofcountry.com zach bryan hawk tuah"
- Search: "tmz.com zach bryan hawk tuah"
- Search: "stereogum.com hawk tuah zach bryan"
- Search: "youtube hawk tuah revival zach bryan"
- Search: "barstoolsports.com hawk tuah zach bryan"
- Search: "twitter.com hawk tuah zach bryan revival"
I need EXACT URLs to the articles or videos. Do at least 6 separate web searches.`, url, videoId),

      runSearch(client, `Search for ANY other social media accounts or pages that reposted or shared the Hawk Tuah Zach Bryan Revival video from @greatamericanbarscene.
Do these specific searches:
- Search: "hawk tuah zach bryan revival video repost"
- Search: "hawk tuah nissan stadium revival TikTok repost"  
- Search: "greatamericanbarscene hawk tuah video reposted"
- Search: "hawk tuah on stage zach bryan video"
- Search: "hailey welch zach bryan stage revival video"
Look for fan accounts, meme pages, news pages on TikTok, Instagram, YouTube, Twitter, Facebook, and any other platform.
I need EXACT working URLs. Do at least 5 separate web searches.`, url, videoId),
    ]);

    // Flatten and deduplicate
    let allResults = passes.flat();
    const seen = new Set();
    allResults = allResults.filter((r) => {
      if (!r || !r.url) return false;
      // Normalize URL for dedup
      let key = r.url.toLowerCase().replace(/[?#].*$/, "").replace(/\/$/, "");
      if (seen.has(key)) return false;
      // Filter out the original video
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

    return res.status(200).json({ results: allResults });
  } catch (err) {
    console.error("API error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function runSearch(client, instructions, originalUrl, videoId) {
  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: `You are a video repost detective. You find every instance of a viral video being reposted across the internet.

CRITICAL RULES:
1. Perform MULTIPLE separate web searches (at least 4-5 different queries).
2. Every URL you return MUST be a real URL you found in search results. NEVER make up or guess URLs.
3. Return ONLY a JSON array. No other text before or after.

Each object in the array must have:
- "platform": "tiktok", "instagram", "youtube", "facebook", "twitter", or "website"
- "account_name": the account name with @ for social media (e.g. "@countrycentral") or site name for websites (e.g. "Whiskey Riff")
- "url": the EXACT URL from search results — must be real and clickable
- "confidence": "high" if you found the actual post, "medium" if it seems related
- "date_found": date in YYYY-MM-DD format
- "type": "repost" (re-uploaded video), "embed" (article with embedded video), or "reaction" (reaction/commentary video)

Do NOT include the original video: ${originalUrl}
Return ONLY the JSON array.`,
      messages: [{ role: "user", content: instructions }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    try {
      const cleaned = text.replace(/```json|```/g, "").trim();
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
    } catch (e) {
      console.error("Parse error:", e.message);
    }
    return [];
  } catch (err) {
    console.error("Search failed:", err.message);
    return [];
  }
}

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
