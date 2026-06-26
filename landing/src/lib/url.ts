import { headers } from "next/headers";

const PRODUCTION_URL = "https://openez.astalife.co";

const ALLOWED_HOSTS = new Set([
  "openez.astalife.co",
  "www.openez.astalife.co",
  "localhost:3000",
  "127.0.0.1:3000",
]);

export async function getBaseUrl(): Promise<string> {
  try {
    const h = await headers();
    const host = h.get("host");
    if (!host || !ALLOWED_HOSTS.has(host)) {
      return PRODUCTION_URL;
    }
    const proto = h.get("x-forwarded-proto") ?? "https";
    const protocol = proto.split(",")[0].trim();
    return `${protocol}://${host}`;
  } catch {
    return PRODUCTION_URL;
  }
}
