import { cookies } from "next/headers";
import { AUTH_COOKIE, deriveAuthToken } from "@/lib/auth";
import type { Asker } from "@/lib/christmas/helperStore";

// Who is on the Christmas pages. Two ways in (middleware.ts): the hub's own
// login, which only Keith has, or the family passcode, which is how Kim gets
// in. So a valid hub cookie means Keith — even if this device also has the
// passcode cookie — and anyone else past the middleware came by passcode and
// is Kim. With FEED_PASSWORD unset (local dev) there is no hub login to check,
// so everyone is the passcode visitor.
export async function askerFor(hubCookie: string | undefined, password: string | undefined): Promise<Asker> {
  if (!password || !hubCookie) return "Kim";
  return hubCookie === (await deriveAuthToken(password)) ? "Keith" : "Kim";
}

export function whoIsAsking(): Promise<Asker> {
  return askerFor(cookies().get(AUTH_COOKIE)?.value, process.env.FEED_PASSWORD);
}
