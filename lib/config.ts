// Service configuration — single source of truth for magic numbers.

/** Deployed geo origin — login, buy-credits, and the tracker worker live there. */
export const GEO_ORIGIN = process.env.GEO_ORIGIN ?? "https://geo.flowblinq.com";
