/**
 * Ground truth industry validation script.
 *
 * Pulls completed sites from the DB, applies the schema.org → industry mapping
 * to their crawl_data, and compares against what the LLM said in business.json.
 *
 * Deliberately surfaces:
 *   - Sites where ground truth and LLM agree (happy path)
 *   - Sites where they DISAGREE (the real test — catches hallucinations)
 *   - Sites with no schema types (LLM is flying blind)
 *   - Coverage stats (what % of sites have schema types at all)
 *
 * Run: node --env-file=.env.local scripts/test-ground-truth.mjs
 * Run against prod: node --env-file=.env.vercel-prod scripts/test-ground-truth.mjs
 */
import postgres from "postgres";

// ── Same mapping as lib/services/industry-classifier.ts ─────────────────────
// Kept inline so this script runs without TypeScript compilation.
const SCHEMA_TYPE_INDUSTRY = {
  Restaurant: "Restaurant / Food Service",
  FoodEstablishment: "Food & Beverage",
  Bakery: "Bakery",
  CafeOrCoffeeShop: "Café / Coffee Shop",
  FastFoodRestaurant: "Fast Food",
  Bar: "Bar / Nightlife",
  Brewery: "Brewery",
  Winery: "Winery",
  Distillery: "Distillery",
  FoodTruck: "Food & Beverage",
  IceCreamShop: "Food & Beverage",
  LegalService: "Legal Services",
  Attorney: "Legal Services",
  LawFirm: "Legal Services",
  Notary: "Notary Services",
  MedicalBusiness: "Healthcare",
  Physician: "Medical Practice",
  Dentist: "Dental Practice",
  Hospital: "Hospital",
  Pharmacy: "Pharmacy",
  VeterinaryCare: "Veterinary Services",
  Optician: "Eye Care",
  MedicalClinic: "Medical Clinic",
  CovidTestingFacility: "Healthcare",
  FinancialService: "Financial Services",
  AccountingService: "Accounting",
  InsuranceAgency: "Insurance",
  BankOrCreditUnion: "Banking",
  MortgageLender: "Mortgage / Lending",
  RealEstateAgent: "Real Estate",
  RealEstateAgency: "Real Estate",
  Store: "Retail",
  OnlineStore: "E-commerce",
  ClothingStore: "Apparel & Fashion",
  ElectronicsStore: "Electronics Retail",
  HomeGoodsStore: "Home & Furniture",
  FurnitureStore: "Home & Furniture",
  GroceryStore: "Grocery / Supermarket",
  AutoDealer: "Auto Dealership",
  ConvenienceStore: "Convenience Retail",
  BookStore: "Bookstore",
  PetStore: "Pet Store",
  ToyStore: "Toy Store",
  HardwareStore: "Hardware / Home Improvement",
  JewelryStore: "Jewelry",
  ShoeStore: "Footwear Retail",
  SportingGoodsStore: "Sporting Goods",
  FlowerShop: "Florist",
  // SoftwareApplication and WebApplication intentionally excluded — they're generic
  // for B2B SaaS (tell us it's an app, not the business vertical). LLM does better.
  EducationalOrganization: "Education",
  School: "School",
  CollegeOrUniversity: "Higher Education",
  HighSchool: "Secondary Education",
  ElementarySchool: "Primary Education",
  Preschool: "Early Childhood Education",
  EducationalOccupationalProgram: "Professional Training",
  DanceSchool: "Dance Studio",
  CookingSchool: "Culinary Education",
  DrivingSchool: "Driving School",
  LanguageSchool: "Language Education",
  MusicSchool: "Music Education",
  EntertainmentBusiness: "Entertainment",
  MovieTheater: "Cinema",
  AmusementPark: "Amusement / Theme Park",
  Casino: "Casino / Gaming",
  NightClub: "Nightclub / Entertainment",
  ComedyClub: "Entertainment",
  Hotel: "Hotel / Accommodation",
  LodgingBusiness: "Lodging",
  TravelAgency: "Travel Agency",
  BedAndBreakfast: "Bed & Breakfast",
  Hostel: "Hostel",
  Motel: "Motel",
  Resort: "Resort",
  Campground: "Campground / Outdoor Hospitality",
  SkiResort: "Ski Resort / Winter Sports",
  EmploymentAgency: "Staffing / Recruiting",
  MarketingAgency: "Marketing Agency",
  AdvertisingAgency: "Advertising Agency",
  AutoRepair: "Auto Repair",
  AutomotiveBusiness: "Automotive",
  GasStation: "Gas Station",
  CarRental: "Car Rental",
  HomeAndConstructionBusiness: "Home Services / Construction",
  Electrician: "Electrical Services",
  Plumber: "Plumbing Services",
  GeneralContractor: "General Contracting",
  Locksmith: "Locksmith Services",
  Painter: "Painting Services",
  Landscaper: "Landscaping",
  Roofer: "Roofing Services",
  MovingCompany: "Moving Services",
  HouseCleaning: "Cleaning Services",
  HVACBusiness: "HVAC Services",
  HairSalon: "Hair Salon",
  BeautySalon: "Beauty / Salon",
  NailSalon: "Nail Salon",
  SpaOrBeautyBusiness: "Spa / Wellness",
  Tattooist: "Tattoo Studio",
  HealthAndBeautyBusiness: "Health & Beauty",
  GymOrHealthClub: "Gym / Fitness",
  HealthClub: "Fitness Center",
  SportsActivityLocation: "Sports & Recreation",
  Yoga: "Yoga Studio",
  ArtGallery: "Art Gallery",
  Museum: "Museum",
  Library: "Library",
  PerformingArtsTheater: "Performing Arts",
  Church: "Religious Organization",
  Mosque: "Religious Organization",
  Synagogue: "Religious Organization",
  PlaceOfWorship: "Religious Organization",
  NGO: "Non-Profit / NGO",
  GovernmentOrganization: "Government",
  Charity: "Charity / Non-Profit",
  NewsMediaOrganization: "News & Media",
  RadioStation: "Radio / Broadcasting",
  TelevisionStation: "Television / Broadcasting",
  Book: "Publishing",
  Periodical: "Publishing",
  SportsTeam: "Sports Team",
  SportsOrganization: "Sports Organization",
  ChildCare: "Child Care",
  DayCare: "Day Care",
};

// Generic types that appear frequently but carry no industry signal
const GENERIC_TYPES = new Set([
  "Organization", "LocalBusiness", "Corporation", "Thing",
  "WebSite", "WebPage", "ItemList", "BreadcrumbList",
  "Product", "Offer", "AggregateRating", "Review",
  "FAQPage", "Question", "Answer",
  "Article", "BlogPosting", "NewsArticle",
  "Person", "PostalAddress", "ContactPage",
  "CollectionPage", "SearchResultsPage", "AboutPage",
  "ImageObject", "VideoObject",
]);

function classifyFromCrawlData(crawlData) {
  if (!crawlData?.pages) return { industry: null, schemaTypes: [], confidence: "low", source: "none" };

  const allTypes = [...new Set(
    crawlData.pages.flatMap((p) => p.existingSchema ?? [])
  )];

  if (allTypes.length === 0) {
    return { industry: null, schemaTypes: [], confidence: "low", source: "none" };
  }

  for (const type of allTypes) {
    const industry = SCHEMA_TYPE_INDUSTRY[type];
    if (industry) {
      return { industry, schemaTypes: allTypes, confidence: "high", source: "schema_org" };
    }
  }

  return { industry: null, schemaTypes: allTypes, confidence: "low", source: "none" };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!dbUrl) { console.error("DATABASE_URL not set"); process.exit(1); }

const sql = postgres(dbUrl, { max: 1, prepare: false });

console.log("Fetching completed sites from DB...\n");

const rows = await sql`
  SELECT
    domain,
    crawl_data,
    generated_business_json
  FROM geo_sites
  WHERE pipeline_status = 'complete'
    AND crawl_data IS NOT NULL
    AND generated_business_json IS NOT NULL
  ORDER BY last_crawl_at DESC
  LIMIT 50
`;

console.log(`Found ${rows.length} completed sites\n`);
console.log("═".repeat(80));

const stats = {
  total: rows.length,
  hasSchemaTypes: 0,
  hasSpecificType: 0,
  agree: 0,
  disagree: 0,
  llmOnlyNoGroundTruth: 0,
};

const disagreeList = [];

for (const row of rows) {
  const gt = classifyFromCrawlData(row.crawl_data);
  const llmIndustry = row.generated_business_json?.geo_profile?.industry ?? null;

  const genericOnly = gt.schemaTypes.length > 0 && !gt.industry;
  if (gt.schemaTypes.length > 0) stats.hasSchemaTypes++;
  if (gt.confidence === "high") stats.hasSpecificType++;

  let status = "";
  if (gt.confidence === "high") {
    // We have ground truth — compare
    const llmLower = (llmIndustry ?? "").toLowerCase();
    const gtLower = (gt.industry ?? "").toLowerCase();
    // Rough semantic match: check if either contains key words of the other
    const gtKeyword = gtLower.split(/[\/\s]/)[0];
    const matches = llmLower.includes(gtKeyword) || gtLower.includes(llmLower.split(/[\/\s,]/)[0]);

    if (matches) {
      stats.agree++;
      status = "✅ AGREE";
    } else {
      stats.disagree++;
      status = "❌ DISAGREE";
      disagreeList.push({ domain: row.domain, gt: gt.industry, llm: llmIndustry, schemaTypes: gt.schemaTypes });
    }
  } else if (gt.schemaTypes.length === 0) {
    stats.llmOnlyNoGroundTruth++;
    status = "⚪ NO SCHEMA (LLM only)";
  } else {
    // Generic types only
    status = "🟡 GENERIC SCHEMA ONLY";
  }

  console.log(`\n${row.domain}`);
  console.log(`  Schema @types : ${gt.schemaTypes.length > 0 ? gt.schemaTypes.join(", ") : "(none)"}`);
  console.log(`  Ground truth  : ${gt.industry ?? "(none — " + (genericOnly ? "generic types only" : "no schema") + ")"}`);
  console.log(`  LLM said      : ${llmIndustry ?? "(missing)"}`);
  console.log(`  Result        : ${status}`);
}

console.log("\n" + "═".repeat(80));
console.log("SUMMARY");
console.log("═".repeat(80));
console.log(`Total sites analyzed       : ${stats.total}`);
console.log(`Sites with any schema types: ${stats.hasSchemaTypes} (${pct(stats.hasSchemaTypes, stats.total)}%)`);
console.log(`Sites with specific type   : ${stats.hasSpecificType} (${pct(stats.hasSpecificType, stats.total)}%)`);
console.log(`LLM-only (no ground truth) : ${stats.llmOnlyNoGroundTruth} (${pct(stats.llmOnlyNoGroundTruth, stats.total)}%)`);
if (stats.hasSpecificType > 0) {
  console.log(`\nWhere ground truth exists:`);
  console.log(`  LLM agrees    : ${stats.agree} / ${stats.hasSpecificType} (${pct(stats.agree, stats.hasSpecificType)}%)`);
  console.log(`  LLM DISAGREES : ${stats.disagree} / ${stats.hasSpecificType} (${pct(stats.disagree, stats.hasSpecificType)}%)`);
}

if (disagreeList.length > 0) {
  console.log("\n⚠️  MISMATCHES — LLM got industry wrong vs schema.org ground truth:");
  for (const d of disagreeList) {
    console.log(`\n  ${d.domain}`);
    console.log(`    Schema types : ${d.schemaTypes.join(", ")}`);
    console.log(`    Ground truth : ${d.gt}`);
    console.log(`    LLM said     : ${d.llm}`);
  }
} else if (stats.hasSpecificType > 0) {
  console.log("\n✅ No mismatches found — LLM industry matches schema.org ground truth for all sites with specific types.");
}

if (stats.hasSpecificType === 0) {
  console.log("\n⚠️  No sites in this dataset have specific schema.org types — ground truth coverage is 0%.");
  console.log("   The classifier will work when sites have types like Restaurant, Dentist, LegalService, etc.");
  console.log("   Consider running against a broader dataset or adding sites with known schema types.");
}

await sql.end();

function pct(n, total) {
  if (total === 0) return "0";
  return Math.round((n / total) * 100);
}
