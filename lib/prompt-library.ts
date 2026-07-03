// Built-in prompt library — mirrors geo's tracker catalog (product content).
// Brand-agnostic templates with {brand} tokens the UI fills with the brand name.
import type { TrackerPromptCategory } from "@/lib/types/tracker";

export interface PromptTemplate {
  id: string;
  category: TrackerPromptCategory;
  name: string;
  template: string;
}

export const PROMPT_LIBRARY: PromptTemplate[] = [
  // ── Brand — directly about the brand ────────────────────────────────────────
  { id: "brand-what-is", category: "brand", name: "What is the company", template: "What is {brand} and what does the company do?" },
  { id: "brand-reputable", category: "brand", name: "Is it reputable", template: "Is {brand} a reputable and trustworthy company?" },
  { id: "brand-reviews", category: "brand", name: "Customer sentiment", template: "What do customers and users say about {brand}?" },
  { id: "brand-products", category: "brand", name: "Products & services", template: "What products and services does {brand} offer?" },
  { id: "brand-founders", category: "brand", name: "Founders & history", template: "Who founded {brand}, and what is the company's background?" },
  { id: "brand-news", category: "brand", name: "Recent news", template: "What recent news, funding, or announcements has {brand} made?" },
  { id: "brand-proscons", category: "brand", name: "Pros and cons", template: "What are the pros and cons of {brand}?" },

  // ── Category — the brand's market / space ───────────────────────────────────
  { id: "cat-leaders", category: "category", name: "Industry leaders", template: "Who are the leading companies in the same industry as {brand}?" },
  { id: "cat-top-players", category: "category", name: "Top players", template: "What are the top players in {brand}'s market today?" },
  { id: "cat-similar-tools", category: "category", name: "Similar tools", template: "What are the best tools and platforms similar to {brand}?" },
  { id: "cat-consider", category: "category", name: "Worth considering", template: "Which companies should I consider alongside {brand}?" },
  { id: "cat-innovative", category: "category", name: "Innovative startups", template: "What are the most innovative startups in {brand}'s space?" },
  { id: "cat-recommend", category: "category", name: "Recommendation", template: "Recommend the best companies for someone evaluating {brand}'s category." },

  // ── Competitor — comparisons & alternatives ─────────────────────────────────
  { id: "comp-alternatives", category: "competitor", name: "Best alternatives", template: "What are the best alternatives to {brand}?" },
  { id: "comp-compare", category: "competitor", name: "How it compares", template: "How does {brand} compare to its main competitors?" },
  { id: "comp-vs", category: "competitor", name: "Versus competitors", template: "{brand} vs its top competitors — which should I choose and why?" },
  { id: "comp-biggest", category: "competitor", name: "Biggest competitors", template: "Who are {brand}'s biggest competitors?" },
  { id: "comp-switch", category: "competitor", name: "Switching", template: "Should I switch from a competitor to {brand}, or the other way around?" },

  // ── Topic — thought leadership & domain trends ──────────────────────────────
  { id: "topic-innovation", category: "topic", name: "Innovation leaders", template: "Which companies are leading innovation in {brand}'s field?" },
  { id: "topic-thought", category: "topic", name: "Thought leadership", template: "Which brands are most cited for thought leadership in {brand}'s industry?" },
  { id: "topic-trends", category: "topic", name: "Market trends", template: "What are the key trends shaping {brand}'s market right now?" },
  { id: "topic-experts", category: "topic", name: "Experts to follow", template: "Who are the experts and companies to follow in {brand}'s space?" },
  { id: "topic-usecases", category: "topic", name: "Use cases", template: "What are the most important use cases in {brand}'s industry?" },

  // ── Claim — verifiable achievements & differentiation ───────────────────────
  { id: "claim-awards", category: "claim", name: "Awards & patents", template: "Which companies in {brand}'s industry have won notable awards or patents?" },
  { id: "claim-different", category: "claim", name: "Differentiation", template: "What makes {brand} different from other companies in its space?" },
  { id: "claim-leader", category: "claim", name: "Industry leader?", template: "Is {brand} considered an industry leader or innovator?" },
  { id: "claim-milestones", category: "claim", name: "Milestones", template: "What are {brand}'s most notable achievements and milestones?" },
  { id: "claim-recognition", category: "claim", name: "Recognition", template: "Has {brand} received any industry recognition, certifications, or press coverage?" },
];

export const PROMPT_CATEGORIES: TrackerPromptCategory[] = ["brand", "category", "competitor", "topic", "claim"];

export function fillTemplate(template: string, brandName: string): string {
  return template.split("{brand}").join(brandName);
}
