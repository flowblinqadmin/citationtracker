// Augments Vitest's `Assertion<T>` interface with jest-dom matchers
// (toBeInTheDocument, toHaveTextContent, toHaveAttribute, etc.) so that
// .test.tsx files under app/**/__tests__/ and other tsc-included locations
// typecheck without needing per-file triple-slash references.
//
// The matchers are registered at runtime by `vitest.setup.ts` which imports
// "@testing-library/jest-dom" — but vitest.setup.ts is excluded from
// tsconfig.json so tsc never sees the side-effect import's type augmentation.
// This file lives at the project root where `**/*.ts` includes it.
import "@testing-library/jest-dom/vitest";
