// src/metaApi.js
// Losse helper om Graph te bevragen (gebruikt in andere flows)
// Zorgt dat media_type en EU reach aanwezig zijn

import { isEUorUK } from "./eu.js";

export async function fetchMetaAds({ keyword, country, limit = 500, token, graphVer = "v23.0" }) {
  if (!keyword) throw new Error("keyword is required");
  if (!country) throw new Error("country is required");
  if (!token) throw new Error("META_ADS_TOKEN missing");

  const eu = isEUorUK(country);
  const base = `https://graph.facebook.com/${graphVer}/ads_archive`;

  const params = new URLSearchParams({
    search_terms: `'${keyword}'`,
    ad_reached_countries: JSON.stringify([country.toUpperCase()]),
    ad_type: "ALL",
    ad_active_status: "ACTIVE",
    limit: String(limit),
    access_token: token
  });

  params.set("fields", eu
    ? [
        "page_name","ad_snapshot_url","ad_creation_time",
        "publisher_platforms","link_url","media_type",
        "eu_total_reach","total_reach_by_location",
        "age_country_gender_reach_breakdown"
      ].join(",")
    : [
        "page_name","ad_snapshot_url","ad_creation_time",
        "publisher_platforms","link_url","media_type"
      ].join(",")
  );

  const res = await fetch(`${base}?${params.toString()}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meta API ${res.status}: ${text}`);
  }
  const json = await res.json();

  return (json.data || []).map(ad => ({
    page_name: ad.page_name ?? null,
    ad_snapshot_url: ad.ad_snapshot_url ?? null,
    product_url: ad.link_url ?? null,
    start_date: ad.ad_creation_time ? ad.ad_creation_time.slice(0,10) : null,
    media_type: ad.media_type ?? "UNKNOWN",
    platforms: (ad.publisher_platforms || []).join(","),
    eu_total_reach: eu ? (ad.eu_total_reach ?? null) : null,
    reach_by_location: eu && ad.total_reach_by_location ? JSON.stringify(ad.total_reach_by_location) : null,
    age_gender_breakdown: eu && ad.age_country_gender_reach_breakdown ? JSON.stringify(ad.age_country_gender_reach_breakdown) : null
  }));
}
