import axios from "axios";
import logger from "../../configs/logger.config";
import fs from "fs";
import path from "path";

type DuckDuckGoTopic = {
    Text?: string;
};

type DuckDuckGoResponse = {
    AbstractText?: string;
    RelatedTopics?: DuckDuckGoTopic[];
};

type WikipediaSummary = {
    extract?: string;
};

type SerperOrganicItem = {
    title?: string;
    link?: string;
    snippet?: string;
};

type SerperResponse = {
    organic?: SerperOrganicItem[];
};

export type WebLookupResult = {
    context: string;
    sourceLinks: string[];
};

const HTTP_TIMEOUT_MS = Number(process.env.WEB_LOOKUP_TIMEOUT_MS || 5000);
const WEB_CACHE_TTL_MS = Number(process.env.WEB_LOOKUP_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const WEB_CACHE_FILE = path.join("logs", "ai-web-cache.json");
const WEB_LOOKUP_MODE = String(process.env.AI_WEB_LOOKUP_MODE || "aggressive").toLowerCase();
const SERPER_API_KEY = String(process.env.SERPER_API_KEY || "").trim();
const ALLOWED_WEB_DOMAINS = String(
    process.env.AI_WEB_ALLOWED_DOMAINS || "wikipedia.org,gov.tr,edu.tr,resmigazete.gov.tr,epdk.gov.tr,enerji.gov.tr,duckduckgo.com"
)
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

type WebCacheMap = Record<string, { value: WebLookupResult | string; ts: number }>;

const ensureCacheDir = () => {
    const dir = path.dirname(WEB_CACHE_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

const readCache = (): WebCacheMap => {
    try {
        if (!fs.existsSync(WEB_CACHE_FILE)) {
            return {};
        }
        const raw = fs.readFileSync(WEB_CACHE_FILE, "utf8");
        return JSON.parse(raw || "{}") as WebCacheMap;
    } catch {
        return {};
    }
};

const writeCache = (cache: WebCacheMap) => {
    try {
        ensureCacheDir();
        fs.writeFileSync(WEB_CACHE_FILE, JSON.stringify(cache), "utf8");
    } catch {
        // cache write is non-critical
    }
};

const normalize = (value: string): string =>
    String(value || "")
        .replace(/\s+/g, " ")
        .trim();

const normalizeHost = (host: string): string => String(host || "").toLowerCase().replace(/^www\./, "");

const isAllowedHost = (host: string): boolean => {
    const normalizedHost = normalizeHost(host);
    return ALLOWED_WEB_DOMAINS.some((allowed) => normalizedHost === allowed || normalizedHost.endsWith(`.${allowed}`));
};

const isAllowedHttpUrl = (value: string): boolean => {
    try {
        const url = new URL(String(value || ""));
        if (!["http:", "https:"].includes(url.protocol)) return false;
        return isAllowedHost(url.hostname);
    } catch {
        return false;
    }
};

export const shouldUseInternetLookup = (query: string): boolean => {
    if (WEB_LOOKUP_MODE === "off") return false;

    const q = normalize(query).toLowerCase();
    if (!q) return false;
    if (q.length < 4) return false;

    if (WEB_LOOKUP_MODE === "aggressive") {
        return true;
    }

    const hasQuestionHint = /\?|nedir|neden|nasil|ne demek|guncel|bugun|haber|fiyat|kur|mevzuat|yasa|oran|kac/.test(q);
    const looksLikeContactForm = /ad soyad|telefon|adres|tesisat|sayac/.test(q);

    return hasQuestionHint && !looksLikeContactForm;
};

const shorten = (value: string, maxLength = 700): string => {
    const text = normalize(value);
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength - 3)}...`;
};

const fetchDuckDuckGoSnippet = async (query: string): Promise<string> => {
    try {
        const { data } = await axios.get<DuckDuckGoResponse>("https://api.duckduckgo.com/", {
            params: {
                q: query,
                format: "json",
                no_redirect: 1,
                no_html: 1,
                skip_disambig: 1
            },
            timeout: HTTP_TIMEOUT_MS
        });

        const abstractText = shorten(data?.AbstractText || "", 500);
        if (abstractText) {
            return `DuckDuckGo: ${abstractText}`;
        }

        const related = (data?.RelatedTopics || [])
            .map((topic) => shorten(topic?.Text || "", 220))
            .filter(Boolean)
            .slice(0, 2);

        if (related.length) {
            return `DuckDuckGo ilgili bilgiler: ${related.join(" | ")}`;
        }
    } catch (err) {
        logger.warn("[WebLookup] DuckDuckGo istegi basarisiz:", err?.message || err);
    }

    return "";
};

const fetchSerperResult = async (query: string): Promise<WebLookupResult> => {
    if (!SERPER_API_KEY) {
        return { context: "", sourceLinks: [] };
    }

    try {
        const { data } = await axios.post<SerperResponse>(
            "https://google.serper.dev/search",
            {
                q: query,
                gl: "tr",
                hl: "tr",
                num: 6
            },
            {
                timeout: HTTP_TIMEOUT_MS,
                headers: {
                    "X-API-KEY": SERPER_API_KEY,
                    "content-type": "application/json"
                }
            }
        );

        const validItems = (data?.organic || [])
            .filter((item) => item?.link && isAllowedHttpUrl(item.link))
            .slice(0, 3);

        if (!validItems.length) {
            return { context: "", sourceLinks: [] };
        }

        const context = validItems
            .map((item, index) => {
                const title = shorten(item?.title || "", 120);
                const snippet = shorten(item?.snippet || "", 260);
                return `Web kaynagi ${index + 1}: ${title}${snippet ? ` - ${snippet}` : ""}`;
            })
            .join("\n");

        const sourceLinks = validItems.map((item) => String(item.link || "").trim()).filter(Boolean);
        return { context, sourceLinks };
    } catch (err) {
        logger.warn("[WebLookup] Serper istegi basarisiz:", err?.message || err);
        return { context: "", sourceLinks: [] };
    }
};

const fetchWikipediaSnippet = async (query: string): Promise<{ snippet: string; sourceLink: string }> => {
    const sourceLink = `https://tr.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query)}`;
    if (!isAllowedHttpUrl(sourceLink)) {
        return { snippet: "", sourceLink: "" };
    }

    try {
        const { data } = await axios.get<WikipediaSummary>(
            `https://tr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`,
            {
                timeout: HTTP_TIMEOUT_MS,
                headers: {
                    Accept: "application/json"
                }
            }
        );

        const extract = shorten(data?.extract || "", 500);
        if (extract) {
            return { snippet: `Wikipedia: ${extract}`, sourceLink };
        }
    } catch (_err) {
        // Wikipedia sonucu cikmamasi normal olabilir.
    }

    return { snippet: "", sourceLink: "" };
};

const normalizeCachedValue = (value: WebLookupResult | string): WebLookupResult => {
    if (!value) {
        return { context: "", sourceLinks: [] };
    }
    if (typeof value === "string") {
        return { context: value, sourceLinks: [] };
    }
    return {
        context: normalize(value.context || ""),
        sourceLinks: Array.isArray(value.sourceLinks)
            ? value.sourceLinks.filter((url) => isAllowedHttpUrl(url)).slice(0, 5)
            : []
    };
};

export const getInternetContext = async (query: string): Promise<WebLookupResult> => {
    const q = normalize(query);
    if (!q || q.length < 2) {
        return { context: "", sourceLinks: [] };
    }

    const cacheKey = q.toLowerCase();
    const cache = readCache();
    const cached = cache[cacheKey];
    if (cached && Date.now() - cached.ts < WEB_CACHE_TTL_MS) {
        return normalizeCachedValue(cached.value);
    }

    const [serper, ddg, wiki] = await Promise.all([
        fetchSerperResult(q),
        fetchDuckDuckGoSnippet(q),
        fetchWikipediaSnippet(q)
    ]);

    const pieces = [serper.context, ddg, wiki.snippet].filter(Boolean);
    const ddgSource = `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
    const mergedSources = [...serper.sourceLinks];
    if (isAllowedHttpUrl(ddgSource)) {
        mergedSources.push(ddgSource);
    }
    if (wiki.sourceLink && isAllowedHttpUrl(wiki.sourceLink)) {
        mergedSources.push(wiki.sourceLink);
    }
    const sourceLinks = Array.from(new Set(mergedSources)).slice(0, 5);

    const result: WebLookupResult = {
        context: pieces.join("\n"),
        sourceLinks
    };

    if (result.context || result.sourceLinks.length) {
        cache[cacheKey] = { value: result, ts: Date.now() };
        writeCache(cache);
    }

    return result;
};
