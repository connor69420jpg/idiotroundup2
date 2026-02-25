import Anthropic from "@anthropic-ai/sdk";

// Known repost/aggregator accounts to specifically search for
const KNOWN_REPOST_ACCOUNTS = {
  tiktok: [
    "countrycentral", "barstoolsports", "zachbryanarchive", "oklahomanoutlaw",
    "whiskeyriff", "countrychord", "countrymusictiktok", "nashvillevibes",
    "countrymusicnation", "savagecountry", "countryrap", "wideopen_country",
    "countryrebel", "thebootofficial", "tasteofcountry",
    "countryconcerts", "concertvibes", "concertjunkie", "festivalszn",
    "viralcountry", "countrylyfe", "honkytonkhighway",
    "morezachbryan", "zachbryanedits", "zachbryansongs"
  ],
  instagram: [
    "whiskeyriff", "countrycentral", "barstoolsports", "zachbryanarchive",
    "countrychord", "tasteofcountry", "countryrebel",
    "theboot", "wideopencountry", "countrymusic", "nashvillelifestyles",
    "countryconcertvibes", "countrynation", "cmt", "iheartcountry",
    "savagecountry", "honkytonklife", "tmz", "billboard", "rollingstone"
  ],
  youtube: [
    "CountryChord", "WhiskeyRiff", "TasteOfCountry", "CountryRebel",
    "TMX", "BarstoolSports", "CMT", "CountryCentral", "CountryNow"
  ]
};

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
      return
