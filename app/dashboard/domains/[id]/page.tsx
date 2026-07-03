import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { geoSiteView, teamMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export default async function DomainPage({ params }: RouteContext) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/auth/login?redirectTo=/dashboard/domains/${id}`);
  }

  const [membership] = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.userId, user.id));

  if (!membership) {
    notFound();
  }

  const [site] = await db
    .select({ accessToken: geoSiteView.accessToken })
    .from(geoSiteView)
    .where(and(eq(geoSiteView.siteId, id), eq(geoSiteView.teamId, membership.teamId)));

  if (!site) {
    notFound();
  }

  redirect(`/sites/${id}?token=${site.accessToken}`);
}
