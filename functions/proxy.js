export async function onRequest({ request }) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");

  // 只允许代理豆瓣图片域名，防止被滥用
  if (!target || !target.includes("doubanio.com")) {
    return new Response("400 Bad Request: Only douban images allowed", { status: 400 });
  }

  try {
    // 模拟浏览器请求，带合法 Referer 绕过防盗链
    const res = await fetch(target, {
      headers: {
        Referer: "https://www.douban.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    if (!res.ok) throw new Error("fetch fail");

    // 转发图片类型 + 跨域 + 缓存优化
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", "public, max-age=86400"); // 缓存1天，减少请求

    return new Response(res.body, { headers });
  } catch (e) {
    return new Response("403 Forbidden: Failed to fetch image", { status: 403 });
  }
}
