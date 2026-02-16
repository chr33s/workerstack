export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", timestamp: Date.now() });
    }

    return Response.json({ path: url.pathname, method: request.method });
  },
};
