import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/session";

export default async function Home() {
  redirect((await getSession()) ? "/dashboard" : "/login");
}
