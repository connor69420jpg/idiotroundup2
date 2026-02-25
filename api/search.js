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

    // STEP 1: Fetch info about the original video first
    const videoInfo = await getVideoInfo(client, url, platform, author);

    // STEP 2: Run multiple targeted search passes in parallel
    const searchPasses = [
      searchPass(client, "tiktok_reposts", `Find TikTok reposts of this video. Search for: "${videoInfo.hashtags}" reposted on TikTok. Search for accounts like @countrycentral, @barstoolsports, @zachbryanarchive, @oklahomanoutlaw, @whiskeyriff, @countrychord, @viralcountry, @morezachbryan, @concertvibes, @savagecountry that posted about: ${videoInfo.description}. Search TikTok specifically for each of these accounts + the video topic.`, url, videoId),

      searchPass(client, "instagram_reposts", `Find Instagram reposts and reels of this video. Search for: ${videoInfo.description} on Instagram. Check these Instagram accounts: @whiskeyriff, @countrycentral, @barstoolsports, @tasteofcountry, @countryrebel, @cmt, @billboard, @tmz, @countryconcertvibes, @nashvillelifestyles, @savagecountry. Search Instagram reels for: ${videoInfo.hashtags}`, url, videoId),

      searchPass(client, "youtube_reposts", `Find YouTube re-uploads and shorts of this video. Search YouTube for: ${videoInfo.description}. Check channels like Country Chord, Whiskey Riff, TMX, Taste of Country, Country Rebel, CMT, Barstool Sports. Also search YouTube shorts for: ${videoInfo.hashtags}`, url, videoId),

      searchPass(client, "website_embeds", `Find news articles and blog posts that embedded or featured this video. Search these sites: whiskeyriff.com, tasteofcountry.com, billboard.com, rollingstone.com, stereogum.com, countryrebel.com, distractify.com, boredpanda.com, deadline.com, yahoo.com, countrytown.com, wideopencountry.com, theboot.com, cmt.com. Search for: ${videoInfo.description}`, url, videoId),

      searchPass(client, "twitter_facebook", `Find this video shared on Twitter/X and Facebook. Search Twitter for: ${videoInfo.description}. Search Facebook for viral video pages that reposted it. Also check Reddit for any posts sharing this video. Search for: ${videoInfo.hashtags} on these platforms.`, url, videoId),

      searchPass(client, "broad_search", `Find ANY other accounts or pages across the entire internet that reposted, re-uploaded, reacted to, or featured this video. Search broadly for: ${videoInfo.description}. Try different search queries using the video's key terms. Look for fan accounts, meme pages, news aggregators, and any other accounts that used this content.`, url, videoId),
    ];

    const passResults = await Promise.all(searchPasses);

    // Combine and deduplicate all results
    let allResults = passResults.flat();

    const seen = new Set();
    allResults = allResults.filter((r) => {
      if (!r || !r.url) return false;
      const key = r.url.toLowerCase().replace(/[?#].*$/, "").replace(/\/$/, "");
      if (seen.has(key)) return false;
      // Filter out the original video
      if (videoId && key.includes(videoId)) return false;
      // Filter out the original author's page
      const authorClean = author.replace("@", "").toLowerCase();
      if (authorClean !== "unknown" && authorClean !== "creator" && key.includes(`/${authorClean}/`)) return false;
      seen.add(key);
      return true;
    });

    return res.status(200).json({ results: allResults });
  } catch (err) {
    console.error("API error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// Get detailed info about the original video
async function getVideoInfo(client, url, platform, author) {
  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: "You find information about social media videos. Return ONLY a JSON object with these fields: description (1-2 sentence description of the video content), hashtags (space-separated list of relevant hashtags from the video), title (the video title or caption). No other text.",
      messages: [
        {
          role: "user",
          content: `Look up this video and tell me what it's about: ${url} by ${author} on ${platform}. What is the content, title, and hashtags?`
        }
      ],
      tools: [{ type: "web_search_20250305", name: "web_search" }]
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    try {
      const cleaned = text.replace(/```json|```/g, "").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch {}

    return {
      description: text.substring(0, 200),
      hashtags: "",
      title: ""
    };
  } catch {
    return { description: `video from ${author} on ${platform}`, hashtags: "", title: "" };
  }
}

// Run a single search pass focused on a specific area
async function searchPass(client, passName, searchInstructions, originalUrl, videoId) {
  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: `You are a video repost hunter. You search thoroughly for reposted video content. Perform MULTIPLE different web searches to find as many results as possible.

Return ONLY a valid JSON array. Each object must have:
- "platform": tiktok, instagram, youtube, facebook, twitter, or website
- "account_name": the account or site name (e.g. "@countrycentral" or "Whiskey Riff")
- "url": direct URL to the repost
- "confidence": "high" or "medium"
- "date_found": date in YYYY-MM-DD format
- "type": "repost", "embed", or "reaction"

Do NOT include the original URL: ${originalUrl}
Perform at least 3-4 different web searches. Return ONLY the JSON array.`,
      messages: [
        {
          role: "user",
          content: searchInstructions
        }
      ],
      tools: [{ type: "web_search_20250305", name: "web_search" }]
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
      console.error(`Parse error in ${passName}:`, e.message);
    }

    return [];
  } catch (err) {
    console.error(`Search pass ${passName} failed:`, err.message);
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
