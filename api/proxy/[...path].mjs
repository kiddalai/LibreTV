// /api/proxy/[...path].mjs - Vercel Serverless Function (ES Module)
import fetch from 'node-fetch';
import { URL } from 'url';
import crypto from 'crypto';

// --- 配置 (从环境变量读取) ---
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10);
const MAX_RECURSION = parseInt(process.env.MAX_RECURSION || '5', 10);

// --- User Agent 处理 ---
let USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];
try {
    const agentsJsonString = process.env.USER_AGENTS_JSON;
    if (agentsJsonString) {
        const parsedAgents = JSON.parse(agentsJsonString);
        if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
            USER_AGENTS = parsedAgents;
            console.log(`[代理日志] 已从环境变量加载 ${USER_AGENTS.length} 个 User Agent。`);
        } else {
            console.warn("[代理日志] 环境变量 USER_AGENTS_JSON 不是有效的非空数组，使用默认值。");
        }
    } else {
        console.log("[代理日志] 未设置环境变量 USER_AGENTS_JSON，使用默认 User Agent。");
    }
} catch (e) {
    console.error(`[代理日志] 解析环境变量 USER_AGENTS_JSON 出错: ${e.message}。使用默认 User Agent。`);
}

const FILTER_DISCONTINUITY = false;

// --- 辅助函数 ---
function logDebug(message) {
    if (DEBUG_ENABLED) {
        console.log(`[代理日志] ${message}`);
    }
}

function getTargetUrlFromPath(encodedPath) {
    if (!encodedPath) {
        logDebug("getTargetUrlFromPath 收到空路径。");
        return null;
    }
    try {
        const decodedUrl = decodeURIComponent(encodedPath);
        if (decodedUrl.match(/^https?:\/\/.+/i)) {
            return decodedUrl;
        } else {
            logDebug(`无效的解码 URL 格式: ${decodedUrl}`);
            if (encodedPath.match(/^https?:\/\/.+/i)) {
                logDebug(`警告: 路径未编码但看起来像 URL: ${encodedPath}`);
                return encodedPath;
            }
            return null;
        }
    } catch (e) {
        logDebug(`解码目标 URL 出错: ${encodedPath} - ${e.message}`);
        return null;
    }
}

function getBaseUrl(urlStr) {
    if (!urlStr) return '';
    try {
        const parsedUrl = new URL(urlStr);
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
        if (pathSegments.length <= 1) {
            return `${parsedUrl.origin}/`;
        }
        pathSegments.pop();
        return `${parsedUrl.origin}/${pathSegments.join('/')}/`;
    } catch (e) {
        logDebug(`获取 BaseUrl 失败: "${urlStr}": ${e.message}`);
        const lastSlashIndex = urlStr.lastIndexOf('/');
        if (lastSlashIndex > urlStr.indexOf('://') + 2) {
            return urlStr.substring(0, lastSlashIndex + 1);
        }
        return urlStr + '/';
    }
}

function resolveUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return '';
    if (relativeUrl.match(/^https?:\/\/.+/i)) {
        return relativeUrl;
    }
    if (!baseUrl) return relativeUrl;
    try {
        return new URL(relativeUrl, baseUrl).toString();
    } catch (e) {
        logDebug(`URL 解析失败: base="${baseUrl}", relative="${relativeUrl}". 错误: ${e.message}`);
        if (relativeUrl.startsWith('/')) {
             try {
                const baseOrigin = new URL(baseUrl).origin;
                return `${baseOrigin}${relativeUrl}`;
             } catch { return relativeUrl; }
        } else {
            return `${baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)}${relativeUrl}`;
        }
    }
}

// 核心修复：和前端路径保持一致，用 /api/proxy/ 前缀
function rewriteUrlToProxy(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return '';
    return `/api/proxy/${encodeURIComponent(targetUrl)}`;
}

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchContentWithType(targetUrl, requestHeaders) {
    const headers = {
        'User-Agent': getRandomUserAgent(),
        'Accept': requestHeaders['accept'] || '*/*',
        'Accept-Language': requestHeaders['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    if (requestHeaders['referer']) {
        headers['Referer'] = requestHeaders['referer'];
    }
    Object.keys(headers).forEach(key => {
        if (headers[key] === undefined || headers[key] === null || headers[key] === '') {
            delete headers[key];
        }
    });

    logDebug(`准备请求目标: ${targetUrl}，请求头: ${JSON.stringify(headers)}`);

    try {
        const response = await fetch(targetUrl, { headers, redirect: 'follow' });
        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            logDebug(`请求失败: ${response.status} ${response.statusText} - ${targetUrl}`);
            const err = new Error(`HTTP 错误 ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 200)}`);
            err.status = response.status;
            throw err;
        }
        const content = await response.text();
        const contentType = response.headers.get('content-type') || '';
        logDebug(`请求成功: ${targetUrl}, Content-Type: ${contentType}, 内容长度: ${content.length}`);
        return { content, contentType, responseHeaders: response.headers };
    } catch (error) {
        logDebug(`请求异常 ${targetUrl}: ${error.message}`);
        throw new Error(`请求目标 URL 失败 ${targetUrl}: ${error.message}`);
    }
}

function isM3u8Content(content, contentType) {
    if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) {
        return true;
    }
    return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

function processKeyLine(line, baseUrl) {
    return line.replace(/URI="([^"]+)"/, (match, uri) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        logDebug(`处理 KEY URI: 原始='${uri}', 绝对='${absoluteUri}'`);
        return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
    });
}

function processMapLine(line, baseUrl) {
     return line.replace(/URI="([^"]+)"/, (match, uri) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        logDebug(`处理 MAP URI: 原始='${uri}', 绝对='${absoluteUri}'`);
        return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
     });
 }

function processMediaPlaylist(url, content) {
    const baseUrl = getBaseUrl(url);
    if (!baseUrl) {
        logDebug(`无法确定媒体列表的 Base URL: ${url}，相对路径可能无法处理。`);
    }
    const lines = content.split('\n');
    const output = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line && i === lines.length - 1) { output.push(line); continue; }
        if (!line) continue;
        if (line.startsWith('#EXT-X-KEY')) { output.push(processKeyLine(line, baseUrl)); continue; }
        if (line.startsWith('#EXT-X-MAP')) { output.push(processMapLine(line, baseUrl)); continue; }
        if (line.startsWith('#EXTINF')) { output.push(line); continue; }
        if (!line.startsWith('#')) {
            const absoluteUrl = resolveUrl(baseUrl, line);
            logDebug(`重写媒体片段: 原始='${line}', 解析后='${absoluteUrl}'`);
            output.push(rewriteUrlToProxy(absoluteUrl)); continue;
        }
        output.push(line);
    }
    return output.join('\n');
}

async function processM3u8Content(targetUrl, content, recursionDepth = 0) {
    if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
        logDebug(`检测到主播放列表: ${targetUrl} (深度: ${recursionDepth})`);
        return await processMasterPlaylist(targetUrl, content, recursionDepth);
    }
    logDebug(`检测到媒体播放列表: ${targetUrl} (深度: ${recursionDepth})`);
    return processMediaPlaylist(targetUrl, content);
}

async function processMasterPlaylist(url, content, recursionDepth) {
    if (recursionDepth > MAX_RECURSION) {
        throw new Error(`处理主播放列表时，递归深度超过最大限制 (${MAX_RECURSION}): ${url}`);
    }
    const baseUrl = getBaseUrl(url);
    const lines = content.split('\n');
    let highestBandwidth = -1;
    let bestVariantUrl = '';

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
            const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
            const currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;
            let variantUriLine = '';
            for (let j = i + 1; j < lines.length; j++) {
                const line = lines[j].trim();
                if (line && !line.startsWith('#')) { variantUriLine = line; i = j; break; }
            }
            if (variantUriLine && currentBandwidth >= highestBandwidth) {
                highestBandwidth = currentBandwidth;
                bestVariantUrl = resolveUrl(baseUrl, variantUriLine);
            }
        }
    }
    if (!bestVariantUrl) {
        logDebug(`主播放列表中未找到 BANDWIDTH 信息，尝试查找第一个 URI: ${url}`);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line && !line.startsWith('#') && line.match(/\.m3u8($|\?.*)/i)) {
                bestVariantUrl = resolveUrl(baseUrl, line);
                logDebug(`备选方案: 找到第一个子播放列表 URI: ${bestVariantUrl}`);
                break;
            }
        }
    }
    if (!bestVariantUrl) {
        logDebug(`在主播放列表 ${url} 中未找到有效的子列表 URI，将其作为媒体列表处理。`);
        return processMediaPlaylist(url, content);
    }

    logDebug(`选择的子播放列表 (带宽: ${highestBandwidth}): ${bestVariantUrl}`);
    const { content: variantContent, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl, {});

    if (!isM3u8Content(variantContent, variantContentType)) {
        logDebug(`获取的子播放列表 ${bestVariantUrl} 不是 M3U8 (类型: ${variantContentType})，将其作为媒体列表处理。`);
        return processMediaPlaylist(bestVariantUrl, variantContent);
    }

    return await processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1);
}

async function validateAuth(req) {
    const authHash = req.query.auth;
    const timestamp = req.query.t;
    const serverPassword = process.env.PASSWORD;
    if (!serverPassword) {
        console.error('服务器未设置 PASSWORD 环境变量，代理访问被拒绝');
        return false;
    }
    const serverPasswordHash = crypto.createHash('sha256').update(serverPassword).digest('hex');
    if (!authHash || authHash !== serverPasswordHash) {
        console.warn('代理请求鉴权失败：密码哈希不匹配');
        return false;
    }
    if (timestamp) {
        const now = Date.now();
        const maxAge = 10 * 60 * 1000;
        if (now - parseInt(timestamp) > maxAge) {
            console.warn('代理请求鉴权失败：时间戳过期');
            return false;
        }
    }
    return true;
}

export default async function handler(req, res) {
    console.info('--- Vercel 代理请求开始 ---');
    console.info('时间:', new Date().toISOString());
    console.info('方法:', req.method);
    console.info('URL:', req.url);
    console.info('查询参数:', JSON.stringify(req.query));

    // Cloudflare 兼容：提前设置跨域头，避免被 CF 改写
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (req.method === 'OPTIONS') {
        console.info("处理 OPTIONS 预检请求");
        res.status(204).setHeader('Access-Control-Max-Age', '86400').end();
        return;
    }

    let targetUrl = null;
    try {
        const isAuthorized = await validateAuth(req);
        if (!isAuthorized) {
            console.warn('代理请求鉴权失败');
            return res.status(401).json({ success: false, error: '代理访问未授权' });
        }

        const pathData = req.query["...path"];
        let encodedUrlPath = '';
        if (Array.isArray(pathData)) {
            encodedUrlPath = pathData.join('/');
            console.info(`从 req.query["...path"] (数组) 组合的编码路径: ${encodedUrlPath}`);
        } else if (typeof pathData === 'string') {
            encodedUrlPath = pathData;
            console.info(`从 req.query["...path"] (字符串) 获取的编码路径: ${encodedUrlPath}`);
        } else if (req.url && req.url.startsWith('/api/proxy/')) {
            encodedUrlPath = req.url.substring('/api/proxy/'.length);
            console.info(`使用备选方法从 req.url 提取的编码路径: ${encodedUrlPath}`);
        }

        if (!encodedUrlPath) {
            throw new Error("无法从请求中确定编码后的目标路径。");
        }

        targetUrl = getTargetUrlFromPath(encodedUrlPath);
        console.info(`解析出的目标 URL: ${targetUrl || 'null'}`);
        if (!targetUrl) {
            throw new Error(`无效的代理请求路径。无法从组合路径 "${encodedUrlPath}" 中提取有效的目标 URL。`);
        }

        console.info(`开始处理目标 URL 的代理请求: ${targetUrl}`);
        const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl, req.headers);

        if (isM3u8Content(content, contentType)) {
            console.info(`正在处理 M3U8 内容: ${targetUrl}`);
            const processedM3u8 = await processM3u8Content(targetUrl, content);
            console.info(`成功处理 M3U8: ${targetUrl}`);
            res.status(200)
                .setHeader('Content-Type', 'application/vnd.apple.mpegurl;charset=utf-8')
                .setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`)
                .removeHeader('content-encoding')
                .removeHeader('content-length')
                .send(processedM3u8);
        } else {
            console.info(`直接返回非 M3U8 内容: ${targetUrl}, 类型: ${contentType}`);
            responseHeaders.forEach((value, key) => {
                 const lowerKey = key.toLowerCase();
                 if (!lowerKey.startsWith('access-control-') &&
                     lowerKey !== 'content-encoding' &&
                     lowerKey !== 'content-length') {
                     res.setHeader(key, value);
                 }
             });
            res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);
            res.status(200).send(content);
        }
    } catch (error) {
        console.error(`[代理错误处理 V3] 捕获错误！目标: ${targetUrl || '解析失败'} | 错误类型: ${error.constructor.name} | 错误消息: ${error.message}`);
        console.error(`[代理错误堆栈 V3] ${error.stack}`);
        if (error instanceof TypeError && error.message.includes("Assignment to constant variable")) {
             console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
             console.error("捕获到 'Assignment to constant variable' 错误!");
             console.error("请再次检查函数代码及所有辅助函数中，是否有 const 声明的变量被重新赋值。");
             console.error("错误堆栈指向:", error.stack);
             console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        }
        const statusCode = error.status || 500;
        if (!res.headersSent) {
             res.setHeader('Content-Type', 'application/json');
             res.status(statusCode).json({
                success: false,
                error: `代理处理错误: ${error.message}`,
                targetUrl: targetUrl
            });
        } else if (!res.writableEnded) {
            res.end();
        }
    } finally {
         console.info('--- Vercel 代理请求结束 ---');
    }
}
