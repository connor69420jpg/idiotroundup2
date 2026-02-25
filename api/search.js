
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

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: `You are a video repost detection assistant. The user gives you info about a short-form video. Search the web thoroughly for every instance of this video being reposted on other accounts or platforms.

Return ONLY a valid JSON array of objects. Each object must have:
- "platform": one of tiktok, instagram, youtube, facebook, twitter, other
- "account_name": the account that reposted (e.g. @username)
- "url": direct link to the repost
- "confidence": "high" or "medium"
- "date_found": approximate date in YYYY-MM-DD format

Only include results that appear to be the SAME video content reposted by DIFFERENT accounts (not the original). If you find no reposts, return an empty array []. Return ONLY the JSON array, no other text.`,
      messages: [
        {
          role: "user",
          content: `Find all reposts of this video:

Original URL: ${url}
Platform: ${platform}
Title/Description: ${metadata?.title || "Unknown"}
Author: ${metadata?.author || "Unknown"}

Search extensively for this exact video reposted on TikTok, Instagram Reels, YouTube Shorts, Facebook, Twitter/X, and any other platforms. Look for the same video uploaded by different accounts. Search for the URL, the author name, keywords from the title, and any other identifying info.`
        }
      ],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
        }
      ]
    });

    // Extract text blocks from the response
    const textBlocks = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Try to parse JSON results
    let results = [];
    try {
      const cleaned = textBlocks.replace(/```json|```/g, "").trim();
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        results = JSON.parse(jsonMatch[0]);
      }
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr.message);
      // Return the raw text so the frontend can handle it
      return res.status(200).json({ results: [], rawText: textBlocks });
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error("API error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
