import type { CrawlData } from "./geo-crawler";

export interface GroundTruthIndustry {
  industry: string | null;
  source: "schema_org" | "none";
  schemaTypes: string[];    // all unique @type values found across all crawled pages
  confidence: "high" | "low";
}

/**
 * Schema.org @type → human-readable industry label.
 *
 * Only specific subtypes are mapped. Generic types (Organization, LocalBusiness,
 * Corporation, Thing) are intentionally excluded — they carry no industry signal
 * and would produce false confidence.
 *
 * Source of truth: https://schema.org/docs/full.html
 */
export const SCHEMA_TYPE_INDUSTRY: Record<string, string> = {
  // Food & Beverage
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

  // Legal
  LegalService: "Legal Services",
  Attorney: "Legal Services",
  LawFirm: "Legal Services",
  Notary: "Notary Services",

  // Medical / Health
  MedicalBusiness: "Healthcare",
  Physician: "Medical Practice",
  Dentist: "Dental Practice",
  Hospital: "Hospital",
  Pharmacy: "Pharmacy",
  VeterinaryCare: "Veterinary Services",
  Optician: "Eye Care",
  MedicalClinic: "Medical Clinic",
  CovidTestingFacility: "Healthcare",

  // Finance
  FinancialService: "Financial Services",
  AccountingService: "Accounting",
  InsuranceAgency: "Insurance",
  BankOrCreditUnion: "Banking",
  MortgageLender: "Mortgage / Lending",

  // Real Estate
  RealEstateAgent: "Real Estate",
  RealEstateAgency: "Real Estate",

  // Retail / E-commerce
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

  // Technology / SaaS
  // NOTE: SoftwareApplication and WebApplication are intentionally excluded.
  // They indicate the *type of asset* (it's an app) but not the business vertical.
  // A healthcare SaaS, fintech SaaS, and legal SaaS all use SoftwareApplication —
  // the LLM gets the vertical right; the schema type would just say "Software / SaaS".
  // MobileApplication is similarly excluded for the same reason.

  // Education
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

  // Entertainment
  EntertainmentBusiness: "Entertainment",
  MovieTheater: "Cinema",
  AmusementPark: "Amusement / Theme Park",
  Casino: "Casino / Gaming",
  NightClub: "Nightclub / Entertainment",
  ComedyClub: "Entertainment",

  // Travel / Hospitality
  Hotel: "Hotel / Accommodation",
  LodgingBusiness: "Lodging",
  TravelAgency: "Travel Agency",
  BedAndBreakfast: "Bed & Breakfast",
  Hostel: "Hostel",
  Motel: "Motel",
  Resort: "Resort",
  Campground: "Campground / Outdoor Hospitality",
  SkiResort: "Ski Resort / Winter Sports",

  // Professional Services
  EmploymentAgency: "Staffing / Recruiting",
  MarketingAgency: "Marketing Agency",
  AdvertisingAgency: "Advertising Agency",

  // Automotive
  AutoRepair: "Auto Repair",
  AutomotiveBusiness: "Automotive",
  GasStation: "Gas Station",
  CarRental: "Car Rental",

  // Home Services / Construction
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

  // Personal Care
  HairSalon: "Hair Salon",
  BeautySalon: "Beauty / Salon",
  NailSalon: "Nail Salon",
  SpaOrBeautyBusiness: "Spa / Wellness",
  Tattooist: "Tattoo Studio",
  HealthAndBeautyBusiness: "Health & Beauty",

  // Health & Fitness
  GymOrHealthClub: "Gym / Fitness",
  HealthClub: "Fitness Center",
  SportsActivityLocation: "Sports & Recreation",
  Yoga: "Yoga Studio",

  // Art / Culture
  ArtGallery: "Art Gallery",
  Museum: "Museum",
  Library: "Library",
  PerformingArtsTheater: "Performing Arts",

  // Religious
  Church: "Religious Organization",
  Mosque: "Religious Organization",
  Synagogue: "Religious Organization",
  PlaceOfWorship: "Religious Organization",

  // Non-profit / Government
  NGO: "Non-Profit / NGO",
  GovernmentOrganization: "Government",
  Charity: "Charity / Non-Profit",

  // Media / Publishing
  NewsMediaOrganization: "News & Media",
  RadioStation: "Radio / Broadcasting",
  TelevisionStation: "Television / Broadcasting",
  Book: "Publishing",
  Periodical: "Publishing",

  // Sports
  SportsTeam: "Sports Team",
  SportsOrganization: "Sports Organization",

  // Child Care
  ChildCare: "Child Care",
  DayCare: "Day Care",
};

/**
 * Derives ground-truth industry from the site's own Schema.org @type declarations.
 * No LLM involved — reads structured data the site owner explicitly published.
 *
 * Returns confidence="high" only when a specific, mappable type is found.
 * Generic types (Organization, LocalBusiness) yield confidence="low" and industry=null.
 */
export function classifyIndustry(crawlData: CrawlData): GroundTruthIndustry {
  const allTypes = Array.from(
    new Set(crawlData.pages.flatMap((p) => p.existingSchema ?? []))
  );

  if (allTypes.length === 0) {
    return { industry: null, source: "none", schemaTypes: [], confidence: "low" };
  }

  for (const type of allTypes) {
    const industry = SCHEMA_TYPE_INDUSTRY[type];
    if (industry) {
      console.warn(`[industry-classifier] Ground truth: schema.org @type "${type}" → "${industry}"`);
      return { industry, source: "schema_org", schemaTypes: allTypes, confidence: "high" };
    }
  }

  // Found schema types but none map to a specific industry (all generic)
  console.warn(`[industry-classifier] Schema types found [${allTypes.join(", ")}] — none specific enough for ground truth`);
  return { industry: null, source: "none", schemaTypes: allTypes, confidence: "low" };
}
